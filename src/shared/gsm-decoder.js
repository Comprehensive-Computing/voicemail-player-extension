/*
 * Vendored from https://github.com/QianNangong/gsm-decoder-js and adapted to ESM.
 */

export class GSMDecoder {
  static QLB = null;
  static larInterpStart = null;
  static InterpLarCoef = null;
  static xmaxTable = null;
  static larTable = null;
  static __static_initialized = false;

  constructor() {
    this.outsig = new Array(160).fill(0);
    this.prevLARpp = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.rp = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.u = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    this.lastSID = new Array(76).fill(0);
    this.prevNc = 0;
    this.prevOut = 0;
    this.quantRes = new Array(280).fill(0);
    this.seed = 0;
    this.parameters = new Array(76).fill(0);
    this.LARpp = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  }

  static __static_initialize() {
    if (!GSMDecoder.__static_initialized) {
      GSMDecoder.__static_initialized = true;
      GSMDecoder.__static_initializer_0();
    }
  }

  static QLB_$LI$() {
    GSMDecoder.__static_initialize();
    if (GSMDecoder.QLB == null) {
      GSMDecoder.QLB = [0.1, 0.35, 0.65, 1.0];
    }

    return GSMDecoder.QLB;
  }

  static larInterpStart_$LI$() {
    GSMDecoder.__static_initialize();
    if (GSMDecoder.larInterpStart == null) {
      GSMDecoder.larInterpStart = [0, 13, 27, 40, 160];
    }

    return GSMDecoder.larInterpStart;
  }

  static InterpLarCoef_$LI$() {
    GSMDecoder.__static_initialize();
    if (GSMDecoder.InterpLarCoef == null) {
      GSMDecoder.InterpLarCoef = [
        [0.75, 0.25],
        [0.5, 0.5],
        [0.25, 0.75],
        [0.0, 1.0]
      ];
    }

    return GSMDecoder.InterpLarCoef;
  }

  static xmaxTable_$LI$() {
    GSMDecoder.__static_initialize();
    return GSMDecoder.xmaxTable;
  }

  static larTable_$LI$() {
    GSMDecoder.__static_initialize();
    return GSMDecoder.larTable;
  }

  static __static_initializer_0() {
    const B = [0, 0, 2048, -2560, 94, -1792, -341, -1144];
    const MIC = [-32, -32, -16, -16, -8, -8, -4, -4];
    const INVA = [13107, 13107, 13107, 13107, 19223, 17476, 31454, 29708];

    GSMDecoder.xmaxTable = new Array(64).fill(0);

    for (let xmaxc = 0; xmaxc < 64; xmaxc += 1) {
      let xmaxp;
      if (xmaxc < 16) {
        xmaxp = 31 + (xmaxc << 5);
      } else {
        const exp = (xmaxc - 16) >> 3;
        xmaxp = ((576 << exp) - 1) + (xmaxc - 16 - 8 * exp) * (64 << exp);
      }

      GSMDecoder.xmaxTable[xmaxc] = xmaxp / 32768.0;
    }

    GSMDecoder.larTable = [null, null, null, null, null, null, null, null];

    for (let larNum = 0; larNum < 8; larNum += 1) {
      GSMDecoder.larTable[larNum] = new Array(-MIC[larNum] * 2).fill(0);

      for (let larQuant = 0; larQuant < -MIC[larNum] * 2; larQuant += 1) {
        let temp = ((larQuant + MIC[larNum]) << 10) - (B[larNum] * 2);
        temp = ((Math.trunc(temp * INVA[larNum]) + 16384) >> 15);
        GSMDecoder.larTable[larNum][larQuant] = (temp * 2) / 16384.0;
      }
    }
  }

  GSMrand() {
    this.seed = this.seed * 1103515245 + 12345;
    return this.seed & 32767;
  }

  decoderInit() {
    this.prevNc = 40;
    this.prevOut = 0.0;

    for (let index = 0; index < 9; index += 1) {
      this.prevLARpp[index] = 0.0;
      this.rp[index] = 0.0;
      this.u[index] = 0.0;
    }

    this.lastSID.fill(0);
    this.lastSID[0] = 2;
    this.lastSID[1] = 28;
    this.lastSID[2] = 18;
    this.lastSID[3] = 12;
    this.lastSID[4] = 7;
    this.lastSID[5] = 5;
    this.lastSID[6] = 3;
    this.lastSID[7] = 2;
    this.quantRes.fill(0.0);
    this.seed = 1;
  }

  decodeFrame(src, srcOffset, dst, dstOffset) {
    const parameters = this.parameters;
    if (!this.UnpackBitStream(src, srcOffset, parameters)) {
      return false;
    }

    return this.decodeParameters(parameters, dst, dstOffset);
  }

  decodeParameters(parameters, dst, dstOffset) {
    const lastSID = this.lastSID;
    const LARpp = this.LARpp;
    const u = this.u;
    const rp = this.rp;
    const prevLARpp = this.prevLARpp;
    const quantRes = this.quantRes;

    arrayCopy(quantRes, 160, quantRes, 0, 120);

    let frameType = 0;
    for (let index = 0; index < 76; index += 1) {
      if (parameters[index] !== 0) {
        frameType = 2;
        break;
      }
    }

    if (frameType === 0) {
      arrayCopy(lastSID, 0, parameters, 0, 76);
      frameType = 2;
    } else {
      for (let subFrameNumber = 0; subFrameNumber < 4; subFrameNumber += 1) {
        const subFramePulseBase = subFrameNumber * 17 + 12;
        for (let pulseIndex = 0; pulseIndex < 13; pulseIndex += 1) {
          if (parameters[subFramePulseBase + pulseIndex] !== 0) {
            frameType = 1;
            subFrameNumber = 4;
            break;
          }
        }
      }

      if (frameType === 2) {
        arrayCopy(parameters, 0, lastSID, 0, 76);
      }
    }

    if (frameType === 2) {
      for (let subFrameNumber = 0; subFrameNumber < 4; subFrameNumber += 1) {
        const subFrameParamBase = subFrameNumber * 17 + 8;
        for (let index = 0; index < 13; index += 1) {
          parameters[subFrameParamBase + 4 + index] = Math.trunc(this.GSMrand() / 5461) + 1;
        }

        parameters[subFrameParamBase + 2] = Math.trunc(this.GSMrand() / 10923);
        parameters[subFrameParamBase + 1] = 0;
        parameters[subFrameParamBase] = (subFrameNumber === 0 || subFrameNumber === 2) ? 40 : 120;
      }
    }

    for (let subFrameNumber = 0; subFrameNumber < 4; subFrameNumber += 1) {
      const subFrameParamBase = subFrameNumber * 17 + 8;
      const tempLtpLag = parameters[subFrameParamBase];

      if (tempLtpLag >= 40 && tempLtpLag <= 120) {
        this.prevNc = tempLtpLag;
      }

      const ltpGain = GSMDecoder.QLB_$LI$()[parameters[subFrameParamBase + 1]];
      const rpeGridPos = parameters[subFrameParamBase + 2];
      const xmaxp = GSMDecoder.xmaxTable_$LI$()[parameters[subFrameParamBase + 3]];
      const subFrameResidualBase = subFrameNumber * 40 + 120;

      for (let index = 0; index < 40; index += 1) {
        quantRes[subFrameResidualBase + index] =
          ltpGain * quantRes[subFrameResidualBase + index - this.prevNc];
      }

      for (let index = 0; index < 13; index += 1) {
        quantRes[subFrameResidualBase + rpeGridPos + 3 * index] +=
          (0.25 * parameters[subFrameParamBase + 4 + index] - 0.875) * xmaxp;
      }
    }

    for (let larNum = 0; larNum < 8; larNum += 1) {
      LARpp[larNum + 1] = GSMDecoder.larTable_$LI$()[larNum][parameters[larNum]];
    }

    let prevOut = this.prevOut;

    for (let larInterpNumber = 0; larInterpNumber < 4; larInterpNumber += 1) {
      for (let index = 1; index <= 8; index += 1) {
        const interpolated =
          prevLARpp[index] * GSMDecoder.InterpLarCoef_$LI$()[larInterpNumber][0] +
          LARpp[index] * GSMDecoder.InterpLarCoef_$LI$()[larInterpNumber][1];

        if (Math.abs(interpolated) < 0.675) {
          rp[index] = interpolated;
        } else if (Math.abs(interpolated) < 1.225) {
          rp[index] = Math.sign(interpolated) * (0.5 * Math.abs(interpolated) + 0.3375);
        } else {
          rp[index] = Math.sign(interpolated) * (0.125 * Math.abs(interpolated) + 0.796875);
        }
      }

      for (
        let outCount = GSMDecoder.larInterpStart_$LI$()[larInterpNumber];
        outCount < GSMDecoder.larInterpStart_$LI$()[larInterpNumber + 1];
        outCount += 1
      ) {
        let temp = quantRes[120 + outCount];

        temp -= rp[8] * u[7];
        u[8] = u[7] + rp[8] * temp;
        temp -= rp[7] * u[6];
        u[7] = u[6] + rp[7] * temp;
        temp -= rp[6] * u[5];
        u[6] = u[5] + rp[6] * temp;
        temp -= rp[5] * u[4];
        u[5] = u[4] + rp[5] * temp;
        temp -= rp[4] * u[3];
        u[4] = u[3] + rp[4] * temp;
        temp -= rp[3] * u[2];
        u[3] = u[2] + rp[3] * temp;
        temp -= rp[2] * u[1];
        u[2] = u[1] + rp[2] * temp;
        temp -= rp[1] * u[0];
        u[1] = u[0] + rp[1] * temp;

        prevOut = temp + prevOut * 0.8599854;
        u[0] = temp;
        temp = 65532.0 * prevOut;
        temp = Math.max(-32766.0, Math.min(32766.0, temp));
        this.outsig[outCount] = temp | 0;
      }
    }

    for (let index = 1; index <= 8; index += 1) {
      prevLARpp[index] = LARpp[index];
    }

    this.prevOut = prevOut;

    let dstIndex = dstOffset;
    for (let index = 0; index < 160; index += 1) {
      const tempInt = this.outsig[index];
      dst[dstIndex] = tempInt & 0xff;
      dst[dstIndex + 1] = (tempInt >> 8) & 0xff;
      dstIndex += 2;
    }

    return true;
  }

  UnpackBitStream(input, inputIndex, parameters) {
    let paramIndex = 0;

    if (((input[inputIndex] >> 4) & 0x0f) !== 13) {
      return false;
    }

    parameters[paramIndex++] = ((input[inputIndex] & 0x0f) << 2) | ((input[++inputIndex] >> 6) & 0x03);
    parameters[paramIndex++] = input[inputIndex] & 0x3f;
    parameters[paramIndex++] = (input[++inputIndex] >> 3) & 0x1f;
    parameters[paramIndex++] = ((input[inputIndex] & 0x07) << 2) | ((input[++inputIndex] >> 6) & 0x03);
    parameters[paramIndex++] = (input[inputIndex] >> 2) & 0x0f;
    parameters[paramIndex++] = ((input[inputIndex] & 0x03) << 2) | ((input[++inputIndex] >> 6) & 0x03);
    parameters[paramIndex++] = (input[inputIndex] >> 3) & 0x07;
    parameters[paramIndex++] = input[inputIndex] & 0x07;
    inputIndex += 1;

    for (let block = 0; block < 4; block += 1) {
      parameters[paramIndex++] = (input[inputIndex] >> 1) & 0x7f;
      parameters[paramIndex++] = ((input[inputIndex] & 0x01) << 1) | ((input[++inputIndex] >> 7) & 0x01);
      parameters[paramIndex++] = (input[inputIndex] >> 5) & 0x03;
      parameters[paramIndex++] = ((input[inputIndex] & 0x1f) << 1) | ((input[++inputIndex] >> 7) & 0x01);
      parameters[paramIndex++] = (input[inputIndex] >> 4) & 0x07;
      parameters[paramIndex++] = (input[inputIndex] >> 1) & 0x07;
      parameters[paramIndex++] = ((input[inputIndex] & 0x01) << 2) | ((input[++inputIndex] >> 6) & 0x03);
      parameters[paramIndex++] = (input[inputIndex] >> 3) & 0x07;
      parameters[paramIndex++] = input[inputIndex] & 0x07;
      parameters[paramIndex++] = (input[++inputIndex] >> 5) & 0x07;
      parameters[paramIndex++] = (input[inputIndex] >> 2) & 0x07;
      parameters[paramIndex++] = ((input[inputIndex] & 0x03) << 1) | ((input[++inputIndex] >> 7) & 0x01);
      parameters[paramIndex++] = (input[inputIndex] >> 4) & 0x07;
      parameters[paramIndex++] = (input[inputIndex] >> 1) & 0x07;
      parameters[paramIndex++] = ((input[inputIndex] & 0x01) << 2) | ((input[++inputIndex] >> 6) & 0x03);
      parameters[paramIndex++] = (input[inputIndex] >> 3) & 0x07;
      parameters[paramIndex++] = input[inputIndex] & 0x07;
      inputIndex += 1;
    }

    return true;
  }
}

function arrayCopy(source, sourceOffset, destination, destinationOffset, size) {
  if (source !== destination || destinationOffset >= sourceOffset + size) {
    for (let index = 0; index < size; index += 1) {
      destination[destinationOffset + index] = source[sourceOffset + index];
    }
    return;
  }

  const temp = source.slice(sourceOffset, sourceOffset + size);
  for (let index = 0; index < size; index += 1) {
    destination[destinationOffset + index] = temp[index];
  }
}

GSMDecoder.__static_initialize();
