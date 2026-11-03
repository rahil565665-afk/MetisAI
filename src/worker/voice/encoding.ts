/** Binary/text helpers shared by the voice session. Pure, so they run unchanged in tests. */

const CHUNK = 0x2000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export type FrameData = string | ArrayBuffer | ArrayBufferView;

/** True for binary WebSocket payloads (as opposed to text frames). */
export function isBinary(data: unknown): data is ArrayBuffer | ArrayBufferView {
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

export function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Gemini Live sends JSON in either text or binary frames; normalise both to a string. */
export function frameToText(data: FrameData): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(toBytes(data));
}
