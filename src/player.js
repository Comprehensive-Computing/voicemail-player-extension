import { extensionApi, sendRuntimeMessage } from "./browser-api.js";

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
    const response = await sendRuntimeMessage({
      type: "GET_CACHED_PLAYABLE",
      cacheId: id
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? "Failed to load cached playable audio.");
    }

    const entry = response.result;
    title.textContent = entry.filename || "attachment.wav";
    objectUrl = URL.createObjectURL(new Blob([Uint8Array.from(entry.buffer)], { type: entry.mimeType || "audio/wav" }));
    audio.src = objectUrl;
    audio.style.display = "block";
    downloadLink.href = objectUrl;
    downloadLink.download = title.textContent;
    status.style.display = "none";

    await sendRuntimeMessage({
      type: "RELEASE_CACHED_PLAYABLE",
      cacheId: id
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function fail(message) {
  status.style.display = "none";
  errorNode.style.display = "block";
  errorNode.textContent = message;
}
