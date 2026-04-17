import {
  FORMAT_MS_GSM610,
  FORMAT_PCM,
  RIFF_FOURCC,
  WAVE_FOURCC
} from "./constants.js";

function readFourCc(view, offset) {
  if (offset + 4 > view.byteLength) {
    throw new Error("Unexpected end of file while reading fourcc.");
  }

  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function writeFourCc(view, offset, value) {
  for (let index = 0; index < 4; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function decodeFmtChunk(view, offset, size) {
  if (size < 16) {
    throw new Error("Invalid fmt chunk.");
  }

  const formatTag = view.getUint16(offset, true);
  const channelCount = view.getUint16(offset + 2, true);
  const sampleRate = view.getUint32(offset + 4, true);
  const avgBytesPerSecond = view.getUint32(offset + 8, true);
  const blockAlign = view.getUint16(offset + 12, true);
  const bitsPerSample = view.getUint16(offset + 14, true);
  let samplesPerBlock = null;

  if (size >= 20) {
    const extraSize = view.getUint16(offset + 16, true);
    if (extraSize >= 2 && size >= 22) {
      samplesPerBlock = view.getUint16(offset + 18, true);
    }
  }

  return {
    formatTag,
    channelCount,
    sampleRate,
    avgBytesPerSecond,
    blockAlign,
    bitsPerSample,
    samplesPerBlock
  };
}

export function isProbablyWav(arrayBuffer) {
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 12) {
    return false;
  }

  const view = new DataView(arrayBuffer);
  return readFourCc(view, 0) === RIFF_FOURCC && readFourCc(view, 8) === WAVE_FOURCC;
}

export function parseWav(arrayBuffer) {
  if (!isProbablyWav(arrayBuffer)) {
    throw new Error("Not a RIFF/WAVE file.");
  }

  const view = new DataView(arrayBuffer);
  let offset = 12;
  let format = null;
  let dataOffset = null;
  let dataSize = null;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const paddedSize = chunkSize + (chunkSize % 2);

    if (payloadOffset + chunkSize > view.byteLength) {
      throw new Error(`Chunk ${chunkId} exceeds file bounds.`);
    }

    if (chunkId === "fmt ") {
      format = decodeFmtChunk(view, payloadOffset, chunkSize);
    } else if (chunkId === "data") {
      dataOffset = payloadOffset;
      dataSize = chunkSize;
    }

    offset = payloadOffset + paddedSize;
  }

  if (!format) {
    throw new Error("Missing fmt chunk.");
  }

  if (dataOffset === null || dataSize === null) {
    throw new Error("Missing data chunk.");
  }

  return {
    format,
    data: new Uint8Array(arrayBuffer, dataOffset, dataSize),
    isPcm: format.formatTag === FORMAT_PCM,
    isMsGsm610: format.formatTag === FORMAT_MS_GSM610
  };
}

export function encodePcmWav({ samples, sampleRate }) {
  if (!(samples instanceof Int16Array)) {
    throw new Error("Expected Int16Array PCM samples.");
  }

  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeFourCc(view, 0, RIFF_FOURCC);
  view.setUint32(4, 36 + dataSize, true);
  writeFourCc(view, 8, WAVE_FOURCC);
  writeFourCc(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeFourCc(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(44 + index * 2, samples[index], true);
  }

  return buffer;
}
