import { extensionApi } from "./browser-api.js";
import { normalizeIncomingBuffer, transcodeWavToPcm } from "./shared/ffmpeg-transcode.js";

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
