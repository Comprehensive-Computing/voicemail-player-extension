import { extensionApi } from "../browser-api.js";
import { FFmpeg } from "../vendor/ffmpeg/index.js";

let ffmpegPromise = null;

export function normalizeIncomingBuffer(buffer) {
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

export async function transcodeWavToPcm(arrayBuffer) {
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

async function safeDeleteFile(ffmpeg, path) {
  try {
    await ffmpeg.deleteFile(path);
  } catch {
    // Ignore cleanup failures.
  }
}
