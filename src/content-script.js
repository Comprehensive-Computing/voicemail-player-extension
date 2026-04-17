const REQUEST_TYPE = "MS_GSM_GOOGLE_AUDIO_REQUEST";
const RESPONSE_TYPE = "MS_GSM_GOOGLE_AUDIO_RESPONSE";
const decodedCache = new Map();
const extensionApi = globalThis.browser ?? globalThis.chrome;
const lastProcessedUrlByElement = new WeakMap();
const bridgedObjectUrls = new WeakMap();
let activePlayerOverlay = null;
const attachmentLoadingState = new WeakMap();

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

  const response = await sendRuntimeMessage({
    type: buffer !== null ? "GOOGLE_AUDIO_PROBE_BUFFER" : "GOOGLE_AUDIO_PROBE",
    url: normalizedUrl,
    buffer
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
    const result = await getPlayableResult(originalUrl, buffer);

    if (result?.kind !== "decoded") {
      openAttachmentTarget(link, originalUrl);
      return;
    }

    revokeExistingObjectUrl(link);
    link.href = result.objectUrl;
    link.dataset.msGsmOriginalHref = originalUrl;
    link.dataset.msGsmObjectUrl = result.objectUrl;
    bridgedObjectUrls.set(link, result.objectUrl);
    showPlayerPopup(result.objectUrl, deriveAttachmentFilename(link));
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

function reopenUpgradedAttachmentLink(link) {
  const objectUrl = link.dataset.msGsmObjectUrl || link.href;
  showPlayerPopup(objectUrl, deriveAttachmentFilename(link));
}

function showPlayerPopup(objectUrl, filename) {
  closePlayerPopup();

  const overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.background = "rgba(32, 33, 36, 0.55)";
  overlay.style.zIndex = "2147483647";
  overlay.style.display = "flex";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";

  const panel = document.createElement("div");
  panel.style.width = "min(420px, calc(100vw - 24px))";
  panel.style.background = "#fff";
  panel.style.color = "#202124";
  panel.style.borderRadius = "12px";
  panel.style.boxShadow = "0 16px 40px rgba(0, 0, 0, 0.25)";
  panel.style.padding = "16px";
  panel.style.fontFamily = "Arial, sans-serif";

  const title = document.createElement("div");
  title.textContent = filename;
  title.style.fontSize = "14px";
  title.style.fontWeight = "600";
  title.style.marginBottom = "12px";
  title.style.wordBreak = "break-word";

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.autoplay = true;
  audio.src = objectUrl;
  audio.style.width = "100%";
  audio.style.display = "block";

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.justifyContent = "flex-end";
  actions.style.gap = "8px";
  actions.style.marginTop = "12px";

  const downloadButton = document.createElement("a");
  downloadButton.href = objectUrl;
  downloadButton.download = filename;
  downloadButton.textContent = "Download";
  styleButton(downloadButton);

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.textContent = "Close";
  styleButton(closeButton);
  closeButton.addEventListener("click", () => closePlayerPopup());

  actions.append(downloadButton, closeButton);
  panel.append(title, audio, actions);
  overlay.append(panel);

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closePlayerPopup();
    }
  });

  document.addEventListener("keydown", handlePlayerEscape, true);
  document.body.append(overlay);
  activePlayerOverlay = overlay;
}

function closePlayerPopup() {
  if (!activePlayerOverlay) {
    return;
  }

  activePlayerOverlay.remove();
  activePlayerOverlay = null;
  document.removeEventListener("keydown", handlePlayerEscape, true);
}

function handlePlayerEscape(event) {
  if (event.key === "Escape") {
    closePlayerPopup();
  }
}

function styleButton(element) {
  element.style.border = "1px solid #dadce0";
  element.style.background = "#fff";
  element.style.color = "#202124";
  element.style.borderRadius = "8px";
  element.style.padding = "8px 12px";
  element.style.fontSize = "13px";
  element.style.fontWeight = "500";
  element.style.cursor = "pointer";
  element.style.textDecoration = "none";
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
  return Boolean(link.dataset.msGsmOriginalHref && link.dataset.msGsmObjectUrl);
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
