import { FFmpeg } from "./vendor/ffmpeg/index.js";
import { extensionApi } from "./browser-api.js";

let ffmpegPromise = null;

extensionApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "OFFSCREEN_TRANSCODE") {
    return undefined;
  }

  handleTranscode(message).then(sendResponse);
  return true;
});

async function handleTranscode(message) {
  try {
    const arrayBuffer = normalizeIncomingBuffer(message.buffer);
    const buffer = await transcodeWavToPcm(arrayBuffer);
    return {
      ok: true,
      buffer: Array.from(new Uint8Array(buffer))
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function transcodeWavToPcm(arrayBuffer) {
  const ffmpeg = await getFfmpeg();
  const inputName = `input-${crypto.randomUUID()}.wav`;
  const outputName = `output-${crypto.randomUUID()}.wav`;

  try {
    await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));
    await ffmpeg.exec(["-i", inputName, "-c:a", "pcm_s16le", outputName]);
    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array)) {
      throw new Error("ffmpeg returned unexpected output data.");
    }
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
  }
}

async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = loadFfmpeg();
  }
  return ffmpegPromise;
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
