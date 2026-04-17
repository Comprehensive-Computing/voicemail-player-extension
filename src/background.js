import { extensionApi } from "./browser-api.js";
import { isProbablyWav, parseWav } from "./shared/wav.js";
import { FFmpeg } from "./vendor/ffmpeg/index.js";

const decodeCache = new Map();
let ffmpegInstancePromise = null;

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || (message.type !== "GOOGLE_AUDIO_PROBE" && message.type !== "GOOGLE_AUDIO_PROBE_BUFFER")) {
    return undefined;
  }

  handleProbe(message).then(sendResponse);
  return true;
});

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
      kind: "pcm"
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

async function safeDeleteFile(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    // Ignore cleanup failures.
  }
}
