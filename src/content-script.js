const REQUEST_TYPE = "MS_GSM_GOOGLE_AUDIO_REQUEST";
const RESPONSE_TYPE = "MS_GSM_GOOGLE_AUDIO_RESPONSE";
const decodedCache = new Map();
const extensionApi = globalThis.browser ?? globalThis.chrome;
const lastProcessedUrlByElement = new WeakMap();
const bridgedObjectUrls = new WeakMap();
const attachmentLoadingState = new WeakMap();
const attachmentPlayerState = new WeakMap();

bootstrap();

function bootstrap() {
  injectPageProxy();
  installPageBridge();
  installAttachmentClickInterception();
  installMediaRecovery();
  scanMediaElements(document);
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
}

function normalizeUrl(url) {
  return new URL(url, window.location.href).href;
}

function installAttachmentClickInterception() {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const link = target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }

    if (isUpgradedAttachmentLink(link)) {
      event.preventDefault();
      event.stopPropagation();
      reopenUpgradedAttachmentLink(link);
      return;
    }

    if (!isGmailWavAttachmentLink(link)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void transcodeAttachmentLink(link);
  }, true);
}

async function transcodeAttachmentLink(link) {
  const originalUrl = normalizeUrl(link.href);
  const clearLoadingState = setAttachmentLoadingState(link, "Transcoding...");

  try {
    const buffer = await fetchAttachmentBuffer(originalUrl);
    const response = await sendRuntimeMessage({
      type: "START_ATTACHMENT_TRANSCODE",
      url: originalUrl,
      filename: deriveAttachmentFilename(link),
      buffer: Array.from(new Uint8Array(buffer))
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Attachment transcode failed.");
    }

    if (response.result?.kind !== "cached" || !response.result.cacheId) {
      openAttachmentTarget(link, originalUrl);
      return;
    }

    link.href = originalUrl;
    link.dataset.msGsmOriginalHref = originalUrl;
    link.dataset.msGsmCacheId = response.result.cacheId;
    await openInlinePlayerForLink(link);
  } catch (error) {
    console.warn("MS GSM WAV Support failed to transcode Gmail attachment link", error);
    openAttachmentTarget(link, originalUrl);
  } finally {
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
  const text = link.textContent?.match(/[\w(). -]+\.wav\b/i)?.[0];
  if (text) {
    return text.trim();
  }

  try {
    const url = new URL(link.href, window.location.href);
    const lastSegment = url.pathname.split("/").pop();
    if (lastSegment && lastSegment.toLowerCase().endsWith(".wav")) {
      return lastSegment;
    }
  } catch {
    // Fall through to default.
  }

  return "attachment.wav";
}

async function reopenUpgradedAttachmentLink(link) {
  try {
    await openInlinePlayerForLink(link);
  } catch (error) {
    console.warn("MS GSM WAV Support failed to reopen inline player", error);
    openAttachmentTarget(link, link.dataset.msGsmOriginalHref || link.href);
  }
}

async function openInlinePlayerForLink(link) {
  const playerData = await ensureAttachmentPlayerData(link);
  showInlinePlayer(link, playerData);
}

async function ensureAttachmentPlayerData(link) {
  const existing = attachmentPlayerState.get(link);
  if (existing?.objectUrl) {
    return existing;
  }

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

  void sendRuntimeMessage({
    type: "RELEASE_CACHED_PLAYABLE",
    cacheId
  }).catch(() => undefined);

  return state;
}

function showInlinePlayer(link, playerData) {
  dismissInlinePlayer();
  ensureInlinePlayerStyles();

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
  audio.style.width = "100%";

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
  document.documentElement.append(overlay);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      dismissInlinePlayer();
    }
  });

  document.addEventListener("keydown", handleInlinePlayerEscape);
  overlay.focus();
}

function dismissInlinePlayer() {
  const overlay = document.getElementById("ms-gsm-inline-player-overlay");
  if (overlay) {
    overlay.remove();
  }
  document.removeEventListener("keydown", handleInlinePlayerEscape);
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

function isUpgradedAttachmentLink(link) {
  return Boolean(link.dataset.msGsmOriginalHref && link.dataset.msGsmCacheId);
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
  badge.textContent = label;

  const spinner = document.createElement("span");
  spinner.style.width = "10px";
  spinner.style.height = "10px";
  spinner.style.border = "2px solid rgba(255, 255, 255, 0.45)";
  spinner.style.borderTopColor = "#fff";
  spinner.style.borderRadius = "50%";
  spinner.style.display = "inline-block";
  spinner.style.animation = "ms-gsm-spin 0.8s linear infinite";
  badge.prepend(spinner);

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

function ensureInlinePlayerStyles() {
  if (document.getElementById("ms-gsm-inline-player-style")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "ms-gsm-inline-player-style";
  style.textContent = `
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
      padding: 18px;
      display: grid;
      gap: 14px;
      font-family: Google Sans, Arial, sans-serif;
    }

    #ms-gsm-inline-player-title {
      font-size: 14px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    #ms-gsm-inline-player-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
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
  document.documentElement.append(style);
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
