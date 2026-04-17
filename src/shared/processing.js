import { decodeMsGsmToPcm } from "./ms-gsm.js";
import { encodePcmWav, isProbablyWav, parseWav } from "./wav.js";

export async function processAudioBuffer(arrayBuffer) {
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

  if (!wav.isMsGsm610) {
    return {
      kind: "unsupported-wav",
      formatTag: wav.format.formatTag
    };
  }

  const samples = await decodeMsGsmToPcm(wav.data, wav.format);
  const buffer = encodePcmWav({
    samples,
    sampleRate: wav.format.sampleRate
  });

  return {
    kind: "decoded",
    mimeType: "audio/wav",
    sampleRate: wav.format.sampleRate,
    sampleCount: samples.length,
    buffer
  };
}
