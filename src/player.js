import { extensionApi } from "./browser-api.js";
import { FFmpeg } from "./vendor/ffmpeg/index.js";

const audio = document.getElementById("audio");
const title = document.getElementById("title");
const status = document.getElementById("status");
const statusText = document.getElementById("status-text");
const errorNode = document.getElementById("error");
const downloadLink = document.getElementById("download");
const closeButton = document.getElementById("close");

let objectUrl = null;
closeButton.addEventListener("click", () => window.close());
window.addEventListener("beforeunload", () => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
void bootstrap();

async function bootstrap() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) return fail("Missing attachment identifier.");

  try {
    statusText.textContent = "Loading attachment...";
    const entry = await getStoredAttachment(id);
    title.textContent = entry.filename || "attachment.wav";

    statusText.textContent = "Transcoding...";
    const transcoded = await transcodeBufferToPcmWav(Uint8Array.from(entry.buffer).buffer);
    objectUrl = URL.createObjectURL(new Blob([transcoded], { type: "audio/wav" }));
    audio.src = objectUrl;
    audio.style.display = "block";
    downloadLink.href = objectUrl;
    downloadLink.download = title.textContent;
    status.style.display = "none";
    await removeStoredAttachment(id);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

async function transcodeBufferToPcmWav(arrayBuffer) {
  const ffmpeg = new FFmpeg();
  const inputName = `input-${crypto.randomUUID()}.wav`;
  const outputName = `output-${crypto.randomUUID()}.wav`;

  try {
    await ffmpeg.load({
      classWorkerURL: extensionApi.runtime.getURL("src/vendor/ffmpeg/worker.js"),
      coreURL: extensionApi.runtime.getURL("src/vendor/ffmpeg-core/ffmpeg-core.js"),
      wasmURL: extensionApi.runtime.getURL("src/vendor/ffmpeg-core/ffmpeg-core.wasm")
    });
    await ffmpeg.writeFile(inputName, new Uint8Array(arrayBuffer));
    await ffmpeg.exec(["-i", inputName, "-c:a", "pcm_s16le", outputName]);
    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array)) throw new Error("ffmpeg returned unexpected output data.");
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } finally {
    try { await ffmpeg.deleteFile(inputName); } catch {}
    try { await ffmpeg.deleteFile(outputName); } catch {}
    ffmpeg.terminate();
  }
}

async function getStoredAttachment(id) {
  const key = getAttachmentStorageKey(id);
  if (extensionApi.storage.local.get.length <= 1) {
    const result = await extensionApi.storage.local.get(key);
    const entry = result?.[key];
    if (!entry) throw new Error("Attachment data not found.");
    return entry;
  }
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.get(key, (result) => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) return reject(new Error(lastError.message));
      const entry = result?.[key];
      if (!entry) return reject(new Error("Attachment data not found."));
      resolve(entry);
    });
  });
}

async function removeStoredAttachment(id) {
  const key = getAttachmentStorageKey(id);
  if (extensionApi.storage.local.remove.length <= 1) return extensionApi.storage.local.remove(key);
  return new Promise((resolve, reject) => {
    extensionApi.storage.local.remove(key, () => {
      const lastError = globalThis.chrome?.runtime?.lastError;
      if (lastError) return reject(new Error(lastError.message));
      resolve();
    });
  });
}

function getAttachmentStorageKey(id) {
  return `attachment:${id}`;
}

function fail(message) {
  status.style.display = "none";
  errorNode.style.display = "block";
  errorNode.textContent = message;
}
