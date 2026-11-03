/** Pure audio helpers for the browser voice client. No DOM access, so they are unit tested in Node. */

/**
 * Streaming downsampler: Float32 frames at the capture rate in, 16-bit PCM at the target rate out.
 * Each output sample is the average of the input samples it spans (a box filter). That is a simple
 * anti-alias filter, which is plenty for speech, and it keeps the code free of dependencies.
 */
export class StreamResampler {
  private readonly ratio: number;
  private carry = new Float32Array(0);
  /** Position of the next output sample, in input samples, relative to the start of `carry`. */
  private position = 0;

  constructor(inputRate: number, readonly outputRate: number) {
    if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError('Sample rates must be positive.');
    this.ratio = inputRate / outputRate;
  }

  /** Feed one frame; returns the 16-bit samples that are complete so far (possibly none). */
  push(frame: Float32Array): Int16Array {
    const buffer = new Float32Array(this.carry.length + frame.length);
    buffer.set(this.carry, 0);
    buffer.set(frame, this.carry.length);

    const output: number[] = [];
    let start = this.position;
    while (start + this.ratio <= buffer.length + 1e-9) {
      const end = start + this.ratio;
      const first = Math.floor(start);
      const last = Math.min(buffer.length, Math.ceil(end));
      let sum = 0;
      let weight = 0;
      for (let index = first; index < last; index += 1) {
        const overlap = Math.min(index + 1, end) - Math.max(index, start);
        if (overlap <= 0) continue;
        sum += buffer[index]! * overlap;
        weight += overlap;
      }
      output.push(weight > 0 ? sum / weight : 0);
      start = end;
    }

    const keepFrom = Math.min(buffer.length, Math.floor(start));
    this.carry = buffer.slice(keepFrom);
    this.position = start - keepFrom;
    return floatToInt16(output);
  }
}

export function floatToInt16(samples: ArrayLike<number>): Int16Array {
  const result = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]!));
    result[index] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return result;
}

export function int16ToFloat(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes, 0, bytes.byteLength - (bytes.byteLength % 2));
  const result = new Float32Array(view.byteLength / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = view.getInt16(index * 2, true) / 0x8000;
  return result;
}

/** Collects 16-bit samples and releases them in fixed-size little-endian byte chunks. */
export class Chunker {
  private pending = new Int16Array(0);

  constructor(readonly samplesPerChunk: number) {
    if (!Number.isInteger(samplesPerChunk) || samplesPerChunk < 1) throw new RangeError('Chunk size must be a positive integer.');
  }

  push(samples: Int16Array): ArrayBuffer[] {
    if (samples.length > 0) {
      const merged = new Int16Array(this.pending.length + samples.length);
      merged.set(this.pending, 0);
      merged.set(samples, this.pending.length);
      this.pending = merged;
    }
    const chunks: ArrayBuffer[] = [];
    while (this.pending.length >= this.samplesPerChunk) {
      chunks.push(toLittleEndian(this.pending.subarray(0, this.samplesPerChunk)));
      this.pending = this.pending.slice(this.samplesPerChunk);
    }
    return chunks;
  }
}

function toLittleEndian(samples: Int16Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) view.setInt16(index * 2, samples[index]!, true);
  return buffer;
}
