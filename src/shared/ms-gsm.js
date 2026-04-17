import {
  DEFAULT_DECODE_TIMEOUT_MS,
  GSM_MS_BLOCK_BYTES,
  GSM_SAMPLES_PER_FRAME
} from "./constants.js";
import { GSMDecoder } from "./gsm-decoder.js";

export async function decodeMsGsmToPcm(data, format) {
  return Promise.race([
    Promise.resolve().then(() => decodeSync(data, format)),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Decode exceeded ${DEFAULT_DECODE_TIMEOUT_MS} ms.`)), DEFAULT_DECODE_TIMEOUT_MS);
    })
  ]);
}

function decodeSync(data, format) {
  if (format.channelCount !== 1) {
    throw new Error(`Expected mono MS GSM WAV, received ${format.channelCount} channels.`);
  }

  if (format.blockAlign !== GSM_MS_BLOCK_BYTES) {
    throw new Error(`Unsupported MS GSM block alignment ${format.blockAlign}.`);
  }

  if (data.length === 0 || data.length % GSM_MS_BLOCK_BYTES !== 0) {
    throw new Error("MS GSM data is truncated or empty.");
  }

  const blockCount = data.length / GSM_MS_BLOCK_BYTES;
  const decoder = new GSMDecoder();
  decoder.decoderInit();
  const frameOutput = new Uint8Array(GSM_SAMPLES_PER_FRAME * 2);
  const samples = new Int16Array(blockCount * 320);
  let sampleOffset = 0;

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const block = data.subarray(blockIndex * GSM_MS_BLOCK_BYTES, (blockIndex + 1) * GSM_MS_BLOCK_BYTES);
    const [firstParameters, secondParameters] = extractWav49Parameters(block);

    if (!decoder.decodeParameters(firstParameters, frameOutput, 0)) {
      throw new Error(`Failed to decode first WAV49 frame in block ${blockIndex}.`);
    }

    sampleOffset = copyFrameSamples(frameOutput, samples, sampleOffset);

    if (!decoder.decodeParameters(secondParameters, frameOutput, 0)) {
      throw new Error(`Failed to decode second WAV49 frame in block ${blockIndex}.`);
    }

    sampleOffset = copyFrameSamples(frameOutput, samples, sampleOffset);
  }

  return samples;
}

function copyFrameSamples(frameOutput, samples, sampleOffset) {
  const frameView = new DataView(frameOutput.buffer, frameOutput.byteOffset, frameOutput.byteLength);

  for (let sampleIndex = 0; sampleIndex < GSM_SAMPLES_PER_FRAME; sampleIndex += 1) {
    samples[sampleOffset] = frameView.getInt16(sampleIndex * 2, true);
    sampleOffset += 1;
  }

  return sampleOffset;
}

function extractWav49Parameters(block) {
  if (block.length !== GSM_MS_BLOCK_BYTES) {
    throw new Error("Invalid WAV49 block size.");
  }

  const first = explodeFrameIndexOne(block.subarray(0, 33));
  const second = explodeFrameIndexZero(block.subarray(33), first.frameChain);
  return [first.parameters, second.parameters];
}

function explodeFrameIndexOne(bytes) {
  const parameters = new Array(76).fill(0);
  let offset = 0;
  let sr = bytes[offset++];

  parameters[0] = sr & 0x3f; sr >>= 6;
  sr |= bytes[offset++] << 2;
  parameters[1] = sr & 0x3f; sr >>= 6;
  sr |= bytes[offset++] << 4;
  parameters[2] = sr & 0x1f; sr >>= 5;
  parameters[3] = sr & 0x1f; sr >>= 5;
  sr |= bytes[offset++] << 2;
  parameters[4] = sr & 0x0f; sr >>= 4;
  parameters[5] = sr & 0x0f; sr >>= 4;
  sr |= bytes[offset++] << 2;
  parameters[6] = sr & 0x07; sr >>= 3;
  parameters[7] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 4;

  ({ offset, sr } = decodeSubframeIndexOne(parameters, 0, bytes, { offset, sr }));
  ({ offset, sr } = decodeSubframeIndexOne(parameters, 17, bytes, { offset, sr }));
  ({ offset, sr } = decodeSubframeIndexOne(parameters, 34, bytes, { offset, sr }));
  const finalState = decodeSubframeIndexOne(parameters, 51, bytes, { offset, sr });

  return {
    parameters,
    frameChain: finalState.sr & 0x0f
  };
}

function decodeSubframeIndexOne(parameters, base, bytes, state) {
  let { offset, sr } = state;

  parameters[base + 8] = sr & 0x7f; sr >>= 7;
  parameters[base + 9] = sr & 0x03; sr >>= 2;
  parameters[base + 10] = sr & 0x03; sr >>= 2;
  sr |= bytes[offset++] << 1;
  parameters[base + 11] = sr & 0x3f; sr >>= 6;
  parameters[base + 12] = sr & 0x07; sr >>= 3;

  sr = bytes[offset++];
  parameters[base + 13] = sr & 0x07; sr >>= 3;
  parameters[base + 14] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 2;
  parameters[base + 15] = sr & 0x07; sr >>= 3;
  parameters[base + 16] = sr & 0x07; sr >>= 3;
  parameters[base + 17] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 1;
  parameters[base + 18] = sr & 0x07; sr >>= 3;
  parameters[base + 19] = sr & 0x07; sr >>= 3;
  parameters[base + 20] = sr & 0x07; sr >>= 3;

  sr = bytes[offset++];
  parameters[base + 21] = sr & 0x07; sr >>= 3;
  parameters[base + 22] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 2;
  parameters[base + 23] = sr & 0x07; sr >>= 3;
  parameters[base + 24] = sr & 0x07; sr >>= 3;

  if (base < 51) {
    sr |= bytes[offset++] << 4;
  }

  return { offset, sr };
}

function explodeFrameIndexZero(bytes, frameChain) {
  const parameters = new Array(76).fill(0);
  let offset = 0;
  let sr = frameChain;
  sr |= bytes[offset++] << 4;

  parameters[0] = sr & 0x3f; sr >>= 6;
  parameters[1] = sr & 0x3f; sr >>= 6;
  sr = bytes[offset++];
  parameters[2] = sr & 0x1f; sr >>= 5;
  sr |= bytes[offset++] << 3;
  parameters[3] = sr & 0x1f; sr >>= 5;
  parameters[4] = sr & 0x0f; sr >>= 4;
  sr |= bytes[offset++] << 2;
  parameters[5] = sr & 0x0f; sr >>= 4;
  parameters[6] = sr & 0x07; sr >>= 3;
  parameters[7] = sr & 0x07; sr >>= 3;

  sr = bytes[offset++];
  ({ offset, sr } = decodeSubframeIndexZero(parameters, 0, bytes, { offset, sr }));
  ({ offset, sr } = decodeSubframeIndexZero(parameters, 17, bytes, { offset, sr }));
  ({ offset, sr } = decodeSubframeIndexZero(parameters, 34, bytes, { offset, sr }));
  decodeSubframeIndexZero(parameters, 51, bytes, { offset, sr });

  return { parameters };
}

function decodeSubframeIndexZero(parameters, base, bytes, state) {
  let { offset, sr } = state;

  parameters[base + 8] = sr & 0x7f; sr >>= 7;
  sr |= bytes[offset++] << 1;
  parameters[base + 9] = sr & 0x03; sr >>= 2;
  parameters[base + 10] = sr & 0x03; sr >>= 2;
  sr |= bytes[offset++] << 5;
  parameters[base + 11] = sr & 0x3f; sr >>= 6;
  parameters[base + 12] = sr & 0x07; sr >>= 3;
  parameters[base + 13] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 1;
  parameters[base + 14] = sr & 0x07; sr >>= 3;
  parameters[base + 15] = sr & 0x07; sr >>= 3;
  parameters[base + 16] = sr & 0x07; sr >>= 3;

  sr = bytes[offset++];
  parameters[base + 17] = sr & 0x07; sr >>= 3;
  parameters[base + 18] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 2;
  parameters[base + 19] = sr & 0x07; sr >>= 3;
  parameters[base + 20] = sr & 0x07; sr >>= 3;
  parameters[base + 21] = sr & 0x07; sr >>= 3;
  sr |= bytes[offset++] << 1;
  parameters[base + 22] = sr & 0x07; sr >>= 3;
  parameters[base + 23] = sr & 0x07; sr >>= 3;
  parameters[base + 24] = sr & 0x07; sr >>= 3;

  if (base < 51) {
    sr = bytes[offset++];
    sr |= bytes[offset++] << 1;
  } else {
    sr = bytes[offset++];
  }

  return { offset, sr };
}
