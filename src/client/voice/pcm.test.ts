import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Chunker, StreamResampler, floatToInt16, int16ToFloat } from './pcm.js';

function sine(rate: number, hz: number, seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < out.length; index += 1) out[index] = amplitude * Math.sin((2 * Math.PI * hz * index) / rate);
  return out;
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const sample of samples) sum += (sample / 0x8000) ** 2;
  return Math.sqrt(sum / samples.length);
}

test('48 kHz to 16 kHz produces a third as many samples, regardless of frame size', () => {
  for (const frameSize of [128, 480, 1000, 4800]) {
    const resampler = new StreamResampler(48_000, 16_000);
    const input = sine(48_000, 440, 1);
    let total = 0;
    for (let offset = 0; offset < input.length; offset += frameSize) total += resampler.push(input.subarray(offset, offset + frameSize)).length;
    assert.ok(Math.abs(total - 16_000) <= 1, `frame ${frameSize}: got ${total}`);
  }
});

test('44.1 kHz input (non-integer ratio) still yields the right duration', () => {
  const resampler = new StreamResampler(44_100, 16_000);
  const input = sine(44_100, 300, 2);
  let total = 0;
  for (let offset = 0; offset < input.length; offset += 441) total += resampler.push(input.subarray(offset, offset + 441)).length;
  assert.ok(Math.abs(total - 32_000) <= 2, `got ${total}`);
});

test('a speech-band tone keeps its level and a tone above the new Nyquist is strongly attenuated', () => {
  const low = new StreamResampler(48_000, 16_000).push(sine(48_000, 440, 1));
  assert.ok(rms(low) > 0.3 && rms(low) < 0.4, `rms ${rms(low)}`);
  const high = new StreamResampler(48_000, 16_000).push(sine(48_000, 15_000, 1));
  assert.ok(rms(high) < 0.12, `rms ${rms(high)}`);
});

test('chunked and one-shot resampling give identical output', () => {
  const input = sine(48_000, 700, 0.5);
  const whole = new StreamResampler(48_000, 16_000).push(input);
  const parts: number[] = [];
  const streaming = new StreamResampler(48_000, 16_000);
  for (let offset = 0; offset < input.length; offset += 333) parts.push(...streaming.push(input.subarray(offset, offset + 333)));
  assert.deepEqual(Int16Array.from(parts), whole);
});

test('equal rates pass samples through unchanged', () => {
  const input = sine(16_000, 440, 0.1);
  const out = new StreamResampler(16_000, 16_000).push(input);
  assert.equal(out.length, input.length);
  assert.deepEqual(out, floatToInt16(input));
});

test('floatToInt16 clamps and int16ToFloat inverts it', () => {
  assert.deepEqual(floatToInt16([2, -2, 0, 1, -1]), Int16Array.from([32767, -32768, 0, 32767, -32768]));
  const round = int16ToFloat(Int16Array.from([0, 16384, -16384, 32767, -32768]).buffer);
  assert.ok(Math.abs(round[1]! - 0.5) < 1e-4 && Math.abs(round[2]! + 0.5) < 1e-4 && round[4] === -1);
});

test('int16ToFloat ignores a trailing odd byte', () => {
  assert.equal(int16ToFloat(new ArrayBuffer(5)).length, 2);
});

test('Chunker emits exact little-endian chunks and keeps the remainder', () => {
  const chunker = new Chunker(4);
  assert.equal(chunker.push(Int16Array.from([1, 2, 3])).length, 0);
  const chunks = chunker.push(Int16Array.from([4, 5, 6, 7, 8, 9]));
  assert.equal(chunks.length, 2);
  assert.deepEqual([...new Uint8Array(chunks[0]!)], [1, 0, 2, 0, 3, 0, 4, 0]);
  assert.deepEqual([...new Uint8Array(chunks[1]!)], [5, 0, 6, 0, 7, 0, 8, 0]);
  assert.equal(chunker.push(Int16Array.from([10, 11, 12])).length, 1);
});
