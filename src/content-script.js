const REQUEST_TYPE = "MS_GSM_GOOGLE_AUDIO_REQUEST";
const RESPONSE_TYPE = "MS_GSM_GOOGLE_AUDIO_RESPONSE";
const META_TYPE = "MS_GSM_GMAIL_META";
const GMAIL_IK_STORAGE_KEY = "msGsmGmailIk";
const decodedCache = new Map();
const pendingPlayableResults = new Map();
const extensionApi = globalThis.browser ?? globalThis.chrome;
const lastProcessedUrlByElement = new WeakMap();
const bridgedObjectUrls = new WeakMap();
const attachmentLoadingState = new WeakMap();
const attachmentPlayerState = new WeakMap();
const pendingAttachmentPlayerData = new WeakMap();
const attachmentPlayerObjectUrls = new Set();
const ATTACHMENT_TRANSCODE_MAX_ATTEMPTS = 3;
const ATTACHMENT_TRANSCODE_RETRY_DELAYS_MS = [150, 500];
const pendingAttachmentTranscodes = new WeakSet();
let cachedGmailIk = sessionStorage.getItem(GMAIL_IK_STORAGE_KEY) || null;

bootstrap();

function bootstrap() {
  injectPageProxy();
  installPageBridge();
  installAttachmentClickInterception();
  installMediaRecovery();
  scanMediaElements(document);
  installCleanupHandlers();
}

function injectPageProxy() {
  const script = document.createElement("script");
  script.src = extensionApi.runtime.getURL("src/page-proxy.js");
  script.dataset.msGsmGoogleAudioProxy = "1";
  script.onload = () => script.remove();
  script.onerror = () => script.remove();
  (document.head || document.documentElement).append(script);
}

function installPageBridge() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (data?.type === META_TYPE && typeof data.ik === "string" && /^[0-9a-f]+$/i.test(data.ik)) {
      cachedGmailIk = data.ik;
      sessionStorage.setItem(GMAIL_IK_STORAGE_KEY, data.ik);
      return;
    }

    if (!data || data.type !== REQUEST_TYPE || typeof data.requestId !== "number" || typeof data.url !== "string") {
      return;
    }

    void respondToPageProbe(data.requestId, data.url, data.buffer ?? null);
  });
}

async function respondToPageProbe(requestId, url, buffer) {
  try {
    const playable = await getPlayableResult(url, buffer);
    window.postMessage({
      type: RESPONSE_TYPE,
      requestId,
      url: normalizeUrl(url),
      ok: true,
      result: playable
    }, "*");
  } catch (error) {
    window.postMessage({
      type: RESPONSE_TYPE,
      requestId,
      url: normalizeUrl(url),
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, "*");
  }
}

async function getPlayableResult(url, buffer = null) {
  const normalizedUrl = normalizeUrl(url);
  if (decodedCache.has(normalizedUrl)) {
    return decodedCache.get(normalizedUrl);
  }

  const pending = pendingPlayableResults.get(normalizedUrl);
  if (pending) {
    return pending;
  }

  const operation = (async () => {
    const normalizedBuffer = buffer !== null ? Array.from(new Uint8Array(buffer)) : null;
    const response = await sendRuntimeMessage({
      type: normalizedBuffer !== null ? "GOOGLE_AUDIO_PROBE_BUFFER" : "GOOGLE_AUDIO_PROBE",
      url: normalizedUrl,
      buffer: normalizedBuffer
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Unknown decode error.");
    }

    if (response.result.kind !== "decoded") {
      decodedCache.set(normalizedUrl, response.result);
      return response.result;
    }

    const bytes = new Uint8Array(response.result.buffer);
    const blob = new Blob([bytes], { type: response.result.mimeType });
    const playable = {
      ...response.result,
      blob,
      objectUrl: URL.createObjectURL(blob)
    };

    decodedCache.set(normalizedUrl, playable);
    return playable;
  })();

  pendingPlayableResults.set(normalizedUrl, operation);

  try {
    return await operation;
  } finally {
    pendingPlayableResults.delete(normalizedUrl);
  }
}

function normalizeUrl(url) {
  return new URL(url, window.location.href).href;
}

function installAttachmentClickInterception() {
  const suppressNativeInboxChipAction = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const chip = findGmailInboxAttachmentChip(target);
    if (!(chip instanceof HTMLElement)) {
      return;
    }

    if (!isGmailInboxWavAttachmentChip(chip) && !isUpgradedAttachmentTarget(chip)) {
      return;
    }

    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  document.addEventListener("pointerdown", suppressNativeInboxChipAction, true);
  document.addEventListener("mousedown", suppressNativeInboxChipAction, true);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const link = target.closest("a[href]");
    const chip = findGmailInboxAttachmentChip(target);

    if (!(link instanceof HTMLAnchorElement) && !(chip instanceof HTMLElement)) {
      return;
    }

    const upgradedTarget = link instanceof HTMLElement ? link : chip;
    if (upgradedTarget && isUpgradedAttachmentTarget(upgradedTarget)) {
      suppressAttachmentEvent(event);
      reopenUpgradedAttachmentTarget(upgradedTarget);
      return;
    }

    if (link instanceof HTMLAnchorElement && isGmailWavAttachmentLink(link)) {
      suppressAttachmentEvent(event);
      void transcodeResolvedAttachmentTarget(link, normalizeUrl(link.href));
      return;
    }

    if (chip instanceof HTMLElement && isGmailInboxWavAttachmentChip(chip)) {
      const resolvedUrl = resolveInboxChipAttachmentUrl(chip) || buildInboxChipAttachmentUrl(chip);
      suppressAttachmentEvent(event);
      if (resolvedUrl) {
        void transcodeResolvedAttachmentTarget(chip, resolvedUrl);
      } else {
        console.warn("MS GSM WAV Support could not build inbox attachment URL", getInboxChipAttachmentParts(chip));
      }
      return;
    }
  }, true);
}

function suppressAttachmentEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

async function transcodeAttachmentLink(link) {
  await transcodeResolvedAttachmentTarget(link, normalizeUrl(link.href));
}

async function transcodeResolvedAttachmentTarget(target, originalUrl) {
  if (pendingAttachmentTranscodes.has(target)) {
    return;
  }

  pendingAttachmentTranscodes.add(target);
  const attempt = getAttachmentRetryAttempt(target);
  const clearLoadingState = setAttachmentLoadingState(
    target,
    attempt > 0 ? `Retrying... (${attempt + 1}/${ATTACHMENT_TRANSCODE_MAX_ATTEMPTS})` : "Transcoding..."
  );

  try {
    const buffer = await fetchAttachmentBuffer(originalUrl);
    const response = await sendRuntimeMessage({
      type: "START_ATTACHMENT_TRANSCODE",
      url: originalUrl,
      filename: deriveAttachmentFilename(target),
      buffer: Array.from(new Uint8Array(buffer))
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Attachment transcode failed.");
    }

    if (response.result?.kind !== "cached" || !response.result.cacheId) {
      throw new Error("Attachment did not produce cached playable audio.");
    }

    target.dataset.msGsmOriginalHref = originalUrl;
    target.dataset.msGsmCacheId = response.result.cacheId;
    if (target instanceof HTMLAnchorElement) {
      target.href = originalUrl;
    }
    resetAttachmentRetryAttempt(target);
    await openInlinePlayerForTarget(target);
  } catch (error) {
    if (attempt + 1 < ATTACHMENT_TRANSCODE_MAX_ATTEMPTS) {
      setAttachmentRetryAttempt(target, attempt + 1);
      updateAttachmentLoadingState(target, `Retrying... (${attempt + 2}/${ATTACHMENT_TRANSCODE_MAX_ATTEMPTS})`);
      scheduleAttachmentRetryClick(target, ATTACHMENT_TRANSCODE_RETRY_DELAYS_MS[attempt] ?? 0);
    } else {
      resetAttachmentRetryAttempt(target);
      console.warn("MS GSM WAV Support failed to transcode Gmail attachment link", error);
    }
  } finally {
    pendingAttachmentTranscodes.delete(target);
    clearLoadingState();
  }
}

async function fetchAttachmentBuffer(url) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "default"
  });

  if (!response.ok) {
    throw new Error(`Attachment fetch failed with status ${response.status}.`);
  }

  return response.arrayBuffer();
}

function openAttachmentTarget(link, url) {
  if (link.target === "_blank") {
    window.open(url, "_blank", "noopener");
    return;
  }

  window.location.href = url;
}

function deriveAttachmentFilename(link) {
  const title = link.getAttribute?.("title");
  if (title && /\.wav\b/i.test(title)) {
    return title.trim();
  }

  const text = link.textContent?.match(/[\w(). -]+\.wav\b/i)?.[0];
  if (text) {
    return text.trim();
  }

  if ("href" in link && typeof link.href === "string") {
    try {
      const url = new URL(link.href, window.location.href);
      const lastSegment = url.pathname.split("/").pop();
      if (lastSegment && lastSegment.toLowerCase().endsWith(".wav")) {
        return lastSegment;
      }
    } catch {
      // Fall through to default.
    }
  }

  return "attachment.wav";
}

async function reopenUpgradedAttachmentLink(link) {
  await reopenUpgradedAttachmentTarget(link);
}

async function reopenUpgradedAttachmentTarget(target) {
  if (pendingAttachmentTranscodes.has(target)) {
    return;
  }

  try {
    await openInlinePlayerForTarget(target);
  } catch (error) {
    console.warn("MS GSM WAV Support failed to reopen inline player", error);
    if (target instanceof HTMLAnchorElement) {
      openAttachmentTarget(target, target.dataset.msGsmOriginalHref || target.href);
    }
  }
}

async function openInlinePlayerForLink(link) {
  await openInlinePlayerForTarget(link);
}

async function openInlinePlayerForTarget(target) {
  const playerData = await ensureAttachmentPlayerData(target);
  showInlinePlayer(playerData);
}

async function ensureAttachmentPlayerData(link) {
  const existing = attachmentPlayerState.get(link);
  if (existing?.objectUrl) {
    return existing;
  }

  const pending = pendingAttachmentPlayerData.get(link);
  if (pending) {
    return pending;
  }

  const operation = (async () => {
    const cacheId = link.dataset.msGsmCacheId;
    if (!cacheId) {
      throw new Error("Missing cached playable id.");
    }

    const response = await sendRuntimeMessage({
      type: "GET_CACHED_PLAYABLE",
      cacheId
    });

    if (!response?.ok || !response.result || !Array.isArray(response.result.buffer)) {
      throw new Error(response?.error ?? "Invalid cached playable payload.");
    }

    const bytes = new Uint8Array(response.result.buffer);
    const mimeType = response.result.mimeType || "audio/wav";
    const filename = response.result.filename || deriveAttachmentFilename(link);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const state = { cacheId, objectUrl, mimeType, filename };
    attachmentPlayerState.set(link, state);
    attachmentPlayerObjectUrls.add(objectUrl);

    void sendRuntimeMessage({
      type: "RELEASE_CACHED_PLAYABLE",
      cacheId
    }).catch(() => undefined);

    return state;
  })();

  pendingAttachmentPlayerData.set(link, operation);

  try {
    return await operation;
  } finally {
    pendingAttachmentPlayerData.delete(link);
  }
}

function showInlinePlayer(playerData) {
  dismissInlinePlayer();
  const host = document.createElement("div");
  host.id = "ms-gsm-inline-player-host";
  const shadowRoot = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = getInlinePlayerStyles();

  const overlay = document.createElement("div");
  overlay.id = "ms-gsm-inline-player-overlay";
  overlay.tabIndex = -1;

  const card = document.createElement("div");
  card.id = "ms-gsm-inline-player-card";

  const title = document.createElement("div");
  title.id = "ms-gsm-inline-player-title";
  title.textContent = playerData.filename;

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.autoplay = true;
  audio.src = playerData.objectUrl;

  const actions = document.createElement("div");
  actions.id = "ms-gsm-inline-player-actions";

  const download = document.createElement("a");
  download.href = playerData.objectUrl;
  download.download = playerData.filename;
  download.textContent = "Download";
  download.className = "ms-gsm-inline-player-button";

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.className = "ms-gsm-inline-player-button ms-gsm-inline-player-button-secondary";
  close.addEventListener("click", () => dismissInlinePlayer());

  actions.append(download, close);
  card.append(title, audio, actions);
  overlay.append(card);
  shadowRoot.append(style, overlay);
  document.documentElement.append(host);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      dismissInlinePlayer();
    }
  });

  document.addEventListener("keydown", handleInlinePlayerEscape);
  overlay.focus();
}

function dismissInlinePlayer() {
  const host = document.getElementById("ms-gsm-inline-player-host");
  if (host) {
    host.remove();
  }
  document.removeEventListener("keydown", handleInlinePlayerEscape);
}

function installCleanupHandlers() {
  window.addEventListener("pagehide", () => {
    dismissInlinePlayer();

    for (const playable of decodedCache.values()) {
      if (playable?.objectUrl) {
        URL.revokeObjectURL(playable.objectUrl);
      }
    }
    decodedCache.clear();
    pendingPlayableResults.clear();

    for (const objectUrl of attachmentPlayerObjectUrls) {
      URL.revokeObjectURL(objectUrl);
    }
    attachmentPlayerObjectUrls.clear();
  }, { once: true });
}

function handleInlinePlayerEscape(event) {
  if (event.key === "Escape") {
    dismissInlinePlayer();
  }
}

function installMediaRecovery() {
  document.addEventListener("error", (event) => {
    const media = findMediaElement(event.target);
    if (!media) {
      return;
    }

    const candidateUrl = getMediaCandidateUrl(media);
    if (!candidateUrl || !shouldHandleGoogleMediaUrl(candidateUrl)) {
      return;
    }

    void recoverMediaElement(media, candidateUrl, true);
  }, true);

  document.addEventListener("loadstart", (event) => {
    const media = findMediaElement(event.target);
    if (!media) {
      return;
    }

    const candidateUrl = getMediaCandidateUrl(media);
    if (!candidateUrl || !shouldHandleGoogleMediaUrl(candidateUrl)) {
      return;
    }

    void recoverMediaElement(media, candidateUrl, false);
  }, true);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLSourceElement) {
          const parentMedia = record.target.closest("audio,video");
          if (parentMedia instanceof HTMLMediaElement) {
            void maybeRecoverKnownMedia(parentMedia);
          }
        } else {
          const media = findMediaElement(record.target);
          if (media) {
            void maybeRecoverKnownMedia(media);
          }
        }
      }

      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          scanMediaElements(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"]
  });
}

function scanMediaElements(root) {
  const mediaElements = [];

  if (root instanceof HTMLMediaElement) {
    mediaElements.push(root);
  }

  if (root instanceof HTMLSourceElement) {
    const parentMedia = root.closest("audio,video");
    if (parentMedia instanceof HTMLMediaElement) {
      mediaElements.push(parentMedia);
    }
  }

  if (root instanceof Element) {
    mediaElements.push(...root.querySelectorAll("audio,video"));

    if (root.matches("source[src]")) {
      const parentMedia = root.closest("audio,video");
      if (parentMedia instanceof HTMLMediaElement) {
        mediaElements.push(parentMedia);
      }
    }

    for (const source of root.querySelectorAll("source[src]")) {
      const parentMedia = source.closest("audio,video");
      if (parentMedia instanceof HTMLMediaElement) {
        mediaElements.push(parentMedia);
      }
    }
  }

  for (const media of new Set(mediaElements)) {
    void maybeRecoverKnownMedia(media);
  }
}

async function maybeRecoverKnownMedia(media) {
  const candidateUrl = getMediaCandidateUrl(media);
  if (!candidateUrl || !shouldHandleGoogleMediaUrl(candidateUrl)) {
    return;
  }

  await recoverMediaElement(media, candidateUrl, false);
}

async function recoverMediaElement(media, candidateUrl, forceRetry) {
  const normalizedCandidateUrl = normalizeUrl(candidateUrl);

  if (!forceRetry && lastProcessedUrlByElement.get(media) === normalizedCandidateUrl) {
    return;
  }

  lastProcessedUrlByElement.set(media, normalizedCandidateUrl);

  try {
    const result = await getPlayableResult(normalizedCandidateUrl);
    if (result?.kind !== "decoded") {
      return;
    }

    applyDecodedSource(media, normalizedCandidateUrl, result.objectUrl);
  } catch (error) {
    console.warn("MS GSM WAV Support failed to recover Google media element", error);
  }
}

function applyDecodedSource(media, originalUrl, objectUrl) {
  const currentTime = safeReadCurrentTime(media);
  const wasPaused = media.paused;

  revokeExistingObjectUrl(media);

  if (media.src && sameUrl(media.src, originalUrl)) {
    media.src = objectUrl;
  }

  for (const source of media.querySelectorAll("source[src]")) {
    if (source.src && sameUrl(source.src, originalUrl)) {
      source.src = objectUrl;
    }
  }

  if (!media.src || sameUrl(media.currentSrc || media.src, originalUrl)) {
    media.src = objectUrl;
  }

  media.load();

  if (currentTime > 0) {
    const restoreTime = () => {
      media.removeEventListener("loadedmetadata", restoreTime);
      try {
        media.currentTime = currentTime;
      } catch {
        // Ignore delayed seekability failures.
      }
    };

    media.addEventListener("loadedmetadata", restoreTime, { once: true });
  }

  if (!wasPaused) {
    void media.play().catch(() => undefined);
  }

  bridgedObjectUrls.set(media, objectUrl);
}

function revokeExistingObjectUrl(target) {
  const existing = bridgedObjectUrls.get(target);
  if (existing) {
    URL.revokeObjectURL(existing);
    bridgedObjectUrls.delete(target);
  }
}

function findMediaElement(target) {
  if (target instanceof HTMLMediaElement) {
    return target;
  }

  if (target instanceof HTMLSourceElement) {
    const parent = target.parentElement;
    return parent instanceof HTMLMediaElement ? parent : null;
  }

  return null;
}

function getMediaCandidateUrl(media) {
  const typedSource = media.querySelector('source[type="audio/x-wav"][src]');
  if (typedSource?.src && shouldHandleGoogleMediaUrl(typedSource.src)) {
    return normalizeUrl(typedSource.src);
  }

  if (media.currentSrc && shouldHandleGoogleMediaUrl(media.currentSrc)) {
    return normalizeUrl(media.currentSrc);
  }

  if (media.src && shouldHandleGoogleMediaUrl(media.src)) {
    return normalizeUrl(media.src);
  }

  const nestedSource = media.querySelector("source[src]");
  if (nestedSource?.src && shouldHandleGoogleMediaUrl(nestedSource.src)) {
    return normalizeUrl(nestedSource.src);
  }

  return null;
}

function shouldHandleGoogleMediaUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    const path = parsed.pathname.toLowerCase();
    const query = parsed.searchParams.toString().toLowerCase();

    return (
      parsed.hostname === "mail.google.com" ||
      parsed.hostname === "drive.google.com" ||
      parsed.hostname.endsWith(".googleusercontent.com")
    ) && (
      path.includes("/mail/") ||
      path.includes("/uc") ||
      path.includes("/open") ||
      path.includes("/download") ||
      query.includes("attid=") ||
      query.includes("view=att") ||
      query.includes("mime=audio") ||
      query.includes("disp=safe") ||
      parsed.searchParams.get("view") === "att"
    );
  } catch {
    return false;
  }
}

function isGmailWavAttachmentLink(link) {
  try {
    const url = new URL(link.href, window.location.href);
    const filename = link.textContent?.toLowerCase() || "";
    const jslog = link.getAttribute("jslog")?.toLowerCase() || "";

    return url.hostname === "mail.google.com" &&
      url.searchParams.get("view") === "att" &&
      (
        filename.includes(".wav") ||
        jslog.includes("audio/x-wav") ||
        jslog.includes("audio/wav")
      );
  } catch {
    return false;
  }
}

function isGmailInboxWavAttachmentChip(chip) {
  return chip.getAttribute("jsname") === "DMMSG" && /\.wav\b/i.test(chip.getAttribute("title") || chip.textContent || "");
}

function findGmailInboxAttachmentChip(target) {
  return target.closest('div.brc[data-chipenabled="true"][jsname="DMMSG"]');
}

function resolveInboxChipAttachmentUrl(chip) {
  const filename = deriveAttachmentFilename(chip).toLowerCase();
  const threadToken = extractThreadTokenFromChip(chip);
  const candidates = document.querySelectorAll('a[href*="view=att"], source[type="audio/x-wav"][src], audio[src*="view=att"]');

  for (const candidate of candidates) {
    const candidateUrl = candidate instanceof HTMLAnchorElement ? candidate.href : candidate.src;
    if (!candidateUrl) {
      continue;
    }

    const candidateFilename = deriveAttachmentFilename(candidate).toLowerCase();
    if (candidateFilename && candidateFilename !== filename) {
      continue;
    }

    const normalizedUrl = normalizeUrl(candidateUrl);
    if (!threadToken || normalizedUrl.includes(threadToken)) {
      return normalizedUrl;
    }
  }

  if (threadToken) {
    for (const candidate of candidates) {
      const candidateUrl = candidate instanceof HTMLAnchorElement ? candidate.href : candidate.src;
      if (!candidateUrl) {
        continue;
      }

      const normalizedUrl = normalizeUrl(candidateUrl);
      if (normalizedUrl.includes(threadToken)) {
        return normalizedUrl;
      }
    }
  }

  return null;
}

function buildInboxChipAttachmentUrl(chip) {
  const { ik, ui, legacyThreadId, permmsgid, attid } = getInboxChipAttachmentParts(chip);

  if (!ik || !legacyThreadId || !permmsgid || !attid) {
    return null;
  }

  const url = new URL(`https://mail.google.com/mail/u/${ui}`);
  url.searchParams.set("ui", "2");
  url.searchParams.set("ik", ik);
  url.searchParams.set("attid", attid);
  url.searchParams.set("permmsgid", permmsgid);
  url.searchParams.set("th", legacyThreadId);
  url.searchParams.set("view", "att");
  url.searchParams.set("zw", "");
  url.searchParams.set("disp", "safe");
  return url.toString();
}

function getInboxChipAttachmentParts(chip) {
  return {
    ik: getGmailIk(),
    ui: getGmailAccountIndex(),
    legacyThreadId: extractLegacyThreadIdFromChip(chip),
    permmsgid: extractPermMessageIdFromChip(chip),
    attid: extractAttachmentIdFromChip(chip)
  };
}

function extractThreadTokenFromChip(chip) {
  const jslog = chip.getAttribute("jslog") || "";
  const threadMatch = jslog.match(/#thread-[^:"\]]+/i);
  return threadMatch?.[0] || null;
}

function extractLegacyThreadIdFromChip(chip) {
  const row = chip.closest("tr");
  if (!(row instanceof HTMLTableRowElement)) {
    return null;
  }

  const threadNode = row.querySelector("[data-legacy-thread-id]");
  return threadNode?.getAttribute("data-legacy-thread-id") || null;
}

function extractPermMessageIdFromChip(chip) {
  const row = chip.closest("tr");
  const rowThreadToken = row?.querySelector("[data-thread-id]")?.getAttribute("data-thread-id") || null;
  const threadToken = rowThreadToken || extractThreadTokenFromChip(chip);
  if (!threadToken) {
    return null;
  }

  return threadToken.replace(/^#?thread-f:/i, "msg-f:");
}

function extractAttachmentIdFromChip(chip) {
  const rawIndex = Number.parseInt(chip.getAttribute("data-index") || "0", 10);
  if (!Number.isFinite(rawIndex) || rawIndex < 0) {
    return null;
  }

  return `0.${rawIndex + 1}`;
}

function getGmailAccountIndex() {
  const pathnameMatch = window.location.pathname.match(/\/mail\/u\/(\d+)/i);
  return pathnameMatch?.[1] || "0";
}

function getGmailIk() {
  if (cachedGmailIk && /^[0-9a-f]+$/i.test(cachedGmailIk)) {
    return cachedGmailIk;
  }

  const globalIk = globalThis.GLOBALS?.[9];
  if (typeof globalIk === "string" && /^[0-9a-f]+$/i.test(globalIk)) {
    return globalIk;
  }

  const globalCandidate = findHexTokenInValue(globalThis.GLOBALS);
  if (globalCandidate) {
    return globalCandidate;
  }

  const wizCandidate = findHexTokenInValue(globalThis.WIZ_global_data);
  if (wizCandidate) {
    return wizCandidate;
  }

  const ijCandidate = findHexTokenInValue(globalThis.IJ_values);
  if (ijCandidate) {
    return ijCandidate;
  }

  const scriptIkMatch = findGmailIkInScripts();
  if (scriptIkMatch) {
    return scriptIkMatch;
  }

  const inlineIkMatch = document.documentElement.innerHTML.match(/[?&]ik=([0-9a-f]{8,})\b/i);
  if (inlineIkMatch?.[1]) {
    return inlineIkMatch[1];
  }

  return null;
}

function findGmailIkInScripts() {
  for (const script of document.scripts) {
    const text = script.textContent;
    if (!text) {
      continue;
    }

    const explicitMatch =
      text.match(/[?&]ik=([0-9a-f]{8,})\b/i) ||
      text.match(/\bik["']?\s*[:=]\s*["']([0-9a-f]{8,})["']/i);

    if (explicitMatch?.[1]) {
      return explicitMatch[1];
    }
  }

  return null;
}

function findHexTokenInValue(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    if (/^[0-9a-f]{8,}$/i.test(value)) {
      return value;
    }

    const embeddedMatch =
      value.match(/[?&]ik=([0-9a-f]{8,})\b/i) ||
      value.match(/\b([0-9a-f]{10,})\b/i);
    return embeddedMatch?.[1] || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = findHexTokenInValue(item, seen);
      if (candidate) {
        return candidate;
      }
    }
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (/ik/i.test(key) && typeof nestedValue === "string" && /^[0-9a-f]{8,}$/i.test(nestedValue)) {
      return nestedValue;
    }

    const candidate = findHexTokenInValue(nestedValue, seen);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function isUpgradedAttachmentLink(link) {
  return isUpgradedAttachmentTarget(link);
}

function isUpgradedAttachmentTarget(target) {
  return Boolean(target.dataset.msGsmOriginalHref && target.dataset.msGsmCacheId);
}

function setAttachmentLoadingState(link, label) {
  clearAttachmentLoadingState(link);

  const previousOpacity = link.style.opacity;
  const previousPosition = link.style.position;
  link.style.opacity = "0.72";
  if (getComputedStyle(link).position === "static") {
    link.style.position = "relative";
  }
  link.setAttribute("aria-busy", "true");

  const badge = document.createElement("div");
  badge.style.position = "absolute";
  badge.style.top = "8px";
  badge.style.right = "8px";
  badge.style.display = "inline-flex";
  badge.style.alignItems = "center";
  badge.style.gap = "6px";
  badge.style.padding = "4px 10px";
  badge.style.borderRadius = "999px";
  badge.style.background = "rgba(26, 115, 232, 0.96)";
  badge.style.color = "#fff";
  badge.style.fontSize = "11px";
  badge.style.fontWeight = "600";
  badge.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.24)";
  badge.style.pointerEvents = "none";
  badge.style.zIndex = "2";

  const spinner = document.createElement("span");
  spinner.style.width = "10px";
  spinner.style.height = "10px";
  spinner.style.border = "2px solid rgba(255, 255, 255, 0.45)";
  spinner.style.borderTopColor = "#fff";
  spinner.style.borderRadius = "50%";
  spinner.style.display = "inline-block";
  spinner.style.animation = "ms-gsm-spin 0.8s linear infinite";

  const labelNode = document.createElement("span");
  labelNode.dataset.msGsmLoadingLabel = "1";
  labelNode.textContent = label;

  badge.append(spinner, labelNode);

  ensureLoadingStyles();
  link.append(badge);
  attachmentLoadingState.set(link, { badge, previousOpacity, previousPosition });

  return () => clearAttachmentLoadingState(link);
}

function clearAttachmentLoadingState(link) {
  const state = attachmentLoadingState.get(link);
  if (!state) {
    return;
  }

  state.badge.remove();
  link.style.opacity = state.previousOpacity;
  link.style.position = state.previousPosition;
  link.removeAttribute("aria-busy");
  attachmentLoadingState.delete(link);
}

function updateAttachmentLoadingState(link, label) {
  const state = attachmentLoadingState.get(link);
  if (!state) {
    return;
  }

  const labelNode = state.badge.querySelector("[data-ms-gsm-loading-label]");
  if (labelNode) {
    labelNode.textContent = label;
  }
}

function ensureLoadingStyles() {
  if (document.getElementById("ms-gsm-loading-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "ms-gsm-loading-style";
  style.textContent = `
    @keyframes ms-gsm-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.documentElement.append(style);
}

function getInlinePlayerStyles() {
  return `
    #ms-gsm-inline-player-overlay {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(32, 33, 36, 0.56);
      z-index: 2147483647;
      padding: 24px;
      box-sizing: border-box;
    }

    #ms-gsm-inline-player-card {
      width: min(480px, calc(100vw - 48px));
      border-radius: 16px;
      background: #fff;
      color: #202124;
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
      padding: 12px 14px 14px;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      height: auto;
      min-height: 0;
      font-family: Google Sans, Arial, sans-serif;
    }

    @media (max-width: 640px) {
      #ms-gsm-inline-player-overlay {
        padding: 16px;
      }

      #ms-gsm-inline-player-card {
        width: 100%;
      }
    }

    #ms-gsm-inline-player-title {
      font-size: 13px;
      font-weight: 700;
      overflow-wrap: anywhere;
      line-height: 1.3;
      margin: 0;
    }

    #ms-gsm-inline-player-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    #ms-gsm-inline-player-card audio {
      display: block;
      width: 100%;
      margin: 0;
      flex: none;
      min-height: 0;
      max-height: 54px;
    }

    .ms-gsm-inline-player-button {
      border: 0;
      border-radius: 999px;
      padding: 8px 14px;
      background: #1a73e8;
      color: #fff;
      cursor: pointer;
      font: inherit;
      text-decoration: none;
    }

    .ms-gsm-inline-player-button-secondary {
      background: #e8eaed;
      color: #202124;
    }
  `;
}

function sameUrl(left, right) {
  try {
    return normalizeUrl(left) === normalizeUrl(right);
  } catch {
    return left === right;
  }
}

function safeReadCurrentTime(media) {
  try {
    return media.currentTime;
  } catch {
    return 0;
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function scheduleAttachmentRetryClick(link, delayMs) {
  void delay(delayMs).then(() => {
    if (!link.isConnected) {
      return;
    }

    link.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0
    }));
  });
}

function getAttachmentRetryAttempt(link) {
  return Number.parseInt(link.dataset.msGsmRetryAttempt || "0", 10) || 0;
}

function setAttachmentRetryAttempt(link, attempt) {
  link.dataset.msGsmRetryAttempt = String(attempt);
}

function resetAttachmentRetryAttempt(link) {
  delete link.dataset.msGsmRetryAttempt;
}

function sendRuntimeMessage(message) {
  if (!extensionApi?.runtime?.sendMessage) {
    return Promise.reject(new Error("Extension runtime API is unavailable."));
  }

  try {
    const maybePromise = extensionApi.runtime.sendMessage(message);

    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      const lastError = globalThis.chrome?.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(response);
    });
  });
}
