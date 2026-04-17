import { extensionApi } from "./browser-api.js";
import { isProbablyWav, parseWav } from "./shared/wav.js";
import { FFmpeg } from "./vendor/ffmpeg/index.js";

const decodeCache = new Map();
let ffmpegInstancePromise = null;
let offscreenCreationPromise = null;

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return undefined;
  }

  if (
    message.type !== "GOOGLE_AUDIO_PROBE" &&
    message.type !== "GOOGLE_AUDIO_PROBE_BUFFER" &&
    message.type !== "START_ATTACHMENT_TRANSCODE" &&
    message.type !== "GET_CACHED_PLAYABLE" &&
    message.type !== "RELEASE_CACHED_PLAYABLE"
  ) {
    return undefined;
  }

  handleMessage(message).then(sendResponse);
  return true;
});

async function handleMessage(message) {
  if (message.type === "START_ATTACHMENT_TRANSCODE") {
    return handleAttachmentTranscode(message);
  }

  if (message.type === "GET_CACHED_PLAYABLE") {
    return handleGetCachedPlayable(message);
  }

  if (message.type === "RELEASE_CACHED_PLAYABLE") {
    return handleReleaseCachedPlayable(message);
  }

  return handleProbe(message);
}

async function handleProbe(message) {
  try {
    const normalizedUrl = normalizeUrl(message.url);
    if (decodeCache.has(normalizedUrl)) {
      return {
        ok: true,
        result: decodeCache.get(normalizedUrl)
      };
    }

    const arrayBuffer = message.type === "GOOGLE_AUDIO_PROBE_BUFFER"
      ? normalizeIncomingBuffer(message.buffer)
      : await fetchAudioBuffer(normalizedUrl);
    const processed = await processAudioBuffer(arrayBuffer);

    let result;
    if (processed.kind === "decoded") {
      result = {
        ...processed,
        buffer: Array.from(new Uint8Array(processed.buffer))
      };
    } else {
      result = processed;
    }

    decodeCache.set(normalizedUrl, result);
    return {
      ok: true,
      result
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleAttachmentTranscode(message) {
  try {
    const arrayBuffer = normalizeIncomingBuffer(message.buffer);
    const processed = await processAudioBuffer(arrayBuffer);

    if (processed.kind !== "decoded" && processed.kind !== "pcm") {
      return {
        ok: true,
        result: processed
      };
    }

    const cacheId = crypto.randomUUID();
    const playableBuffer = processed.kind === "decoded" ? processed.buffer : arrayBuffer;
    await setStorageValue(getPlayableStorageKey(cacheId), {
      filename: message.filename || "attachment.wav",
      mimeType: "audio/wav",
      buffer: Array.from(new Uint8Array(playableBuffer)),
      createdAt: Date.now()
    });

    return {
      ok: true,
      result: {
        kind: "cached",
        cacheId
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleGetCachedPlayable(message) {
  try {
    const entry = await getStorageValue(getPlayableStorageKey(message.cacheId));
    if (!entry) {
      return {
        ok: false,
        error: "Cached playable data not found."
      };
    }

    return {
      ok: true,
      result: entry
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function handleReleaseCachedPlayable(message) {
  try {
    await removeStorageValue(getPlayableStorageKey(message.cacheId));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeUrl(url) {
  return new URL(url).href;
}

async function fetchAudioBuffer(url) {
  const response = await fetch(url, {
    credentials: "include",
    cache: "default"
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}.`);
  }

  return response.arrayBuffer();
}

function normalizeIncomingBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }

  if (ArrayBuffer.isView(buffer)) {
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  if (Array.isArray(buffer)) {
    return Uint8Array.from(buffer).buffer;
  }

  throw new Error("Invalid audio buffer payload.");
}

async function processAudioBuffer(arrayBuffer) {
  if (!isProbablyWav(arrayBuffer)) {
    return {
      kind: "not-wav"
    };
  }

  const wav = parseWav(arrayBuffer);
  if (wav.isPcm) {
    return {
      kind: "pcm",
      mimeType: "audio/wav",
      buffer: arrayBuffer
    };
  }

  const transcoded = await transcodeWavToPcm(arrayBuffer);
  return {
    kind: "decoded",
    mimeType: "audio/wav",
    buffer: transcoded
  };
}

async function transcodeWavToPcm(arrayBuffer) {
  if (typeof Worker !== "function") {
    return transcodeWithOffscreen(arrayBuffer);
  }

  const ffmpeg = await getFfmpeg();
  const inputName = `input-${crypto.randomUUID()}.wav`;
  const outputName = `output-${crypto.randomUUID()}.wav`;

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));
    await ffmpeg.exec([
      "-i", inputName,
      "-c:a", "pcm_s16le",
      outputName
    ]);

    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array)) {
      throw new Error("ffmpeg returned unexpected output data.");
    }

    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } finally {
    await safeDeleteFile(ffmpeg, inputName);
    await safeDeleteFile(ffmpeg, outputName);
  }
}

async function transcodeWithOffscreen(arrayBuffer) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage({
      type: "OFFSCREEN_TRANSCODE",
      buffer: Array.from(new Uint8Array(arrayBuffer))
    }, (response) => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error ?? "Offscreen transcode failed."));
        return;
      }

      resolve(Uint8Array.from(response.buffer).buffer);
    });
  });
}

async function getFfmpeg() {
  if (!ffmpegInstancePromise) {
    ffmpegInstancePromise = loadFfmpeg();
  }

  return ffmpegInstancePromise;
}

async function loadFfmpeg() {
  const ffmpeg = new FFmpeg();

  await ffmpeg.load({
    classWorkerURL: extensionApi.runtime.getURL("src/vendor/ffmpeg/worker.js"),
    coreURL: extensionApi.runtime.getURL("src/vendor/ffmpeg-core/ffmpeg-core.js"),
    wasmURL: extensionApi.runtime.getURL("src/vendor/ffmpeg-core/ffmpeg-core.wasm")
  });

  return ffmpeg;
}

async function ensureOffscreenDocument() {
  const chromeApi = globalThis.chrome;
  if (!chromeApi?.offscreen) {
    throw new Error("Offscreen document API is unavailable.");
  }

  if (offscreenCreationPromise) {
    return offscreenCreationPromise;
  }

  offscreenCreationPromise = (async () => {
    if (typeof chromeApi.offscreen.hasDocument === "function") {
      const hasDocument = await chromeApi.offscreen.hasDocument();
      if (hasDocument) {
        return;
      }
    }

    await chromeApi.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Transcode MS GSM WAV attachments with ffmpeg.wasm"
    });
  })();

  try {
    await offscreenCreationPromise;
  } finally {
    offscreenCreationPromise = null;
  }
}

async function safeDeleteFile(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    // Ignore cleanup failures.
  }
}

async function setStorageValue(key, value) {
  if (extensionApi.storage.local.set.length <= 1) {
    await extensionApi.storage.local.set({ [key]: value });
    return;
  }

  await new Promise((resolve, reject) => {
    extensionApi.storage.local.set({ [key]: value }, () => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve();
    });
  });
}

async function getStorageValue(key) {
  if (extensionApi.storage.local.get.length <= 1) {
    const result = await extensionApi.storage.local.get(key);
    return result?.[key];
  }

  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(key, (result) => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(result?.[key]);
    });
  });
}

async function removeStorageValue(key) {
  if (extensionApi.storage.local.remove.length <= 1) {
    await extensionApi.storage.local.remove(key);
    return;
  }

  await new Promise((resolve, reject) => {
    extensionApi.storage.local.remove(key, () => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve();
    });
  });
}

function getPlayableStorageKey(cacheId) {
  return `playable:${cacheId}`;
}
