import { Chunker, StreamResampler } from './pcm.js';
import { CLIENT_AUDIO_SAMPLE_RATE, CLIENT_CHUNK_MS } from '../../shared/voiceProtocol.js';

/**
 * Microphone capture. An AudioWorklet (loaded from a Blob URL, so no extra file or CSP rule is
 * needed) hands raw frames to the main thread, which downsamples to 16 kHz and groups the audio
 * into 100 ms chunks. Fewer, larger WebSocket messages keep the Cloudflare request count low.
 */

const WORKLET_NAME = 'dentdesk-capture';
const WORKLET_SOURCE = `
class DentdeskCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1024); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const count = Math.min(channel.length - offset, this.buffer.length - this.filled);
        this.buffer.set(channel.subarray(offset, offset + count), this.filled);
        this.filled += count;
        offset += count;
        if (this.filled === this.buffer.length) {
          const full = this.buffer;
          this.port.postMessage(full, [full.buffer]);
          this.buffer = new Float32Array(1024);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', DentdeskCapture);
`;

export interface Microphone {
  stop(): void;
}

export class MicrophoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrophoneError';
  }
}

export async function startMicrophone(context: AudioContext, onChunk: (chunk: ArrayBuffer) => void): Promise<Microphone> {
  if (!navigator.mediaDevices?.getUserMedia || !context.audioWorklet) {
    throw new MicrophoneError('This browser cannot capture microphone audio. Use a current version of Chrome, Edge, Firefox or Safari.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : '';
    throw new MicrophoneError(name === 'NotFoundError'
      ? 'No microphone was found. Connect one and try again.'
      : 'Microphone access was blocked. Allow the microphone for this site and try again.');
  }

  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    throw new MicrophoneError('The audio engine could not be started in this browser.');
  } finally {
    URL.revokeObjectURL(url);
  }

  const resampler = new StreamResampler(context.sampleRate, CLIENT_AUDIO_SAMPLE_RATE);
  const chunker = new Chunker((CLIENT_AUDIO_SAMPLE_RATE * CLIENT_CHUNK_MS) / 1000);
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    for (const chunk of chunker.push(resampler.push(event.data))) onChunk(chunk);
  };
  // Some browsers only run a node that reaches the destination, so route it through a muted gain.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(context.destination);

  return {
    stop() {
      node.port.onmessage = null;
      try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* Already disconnected. */ }
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}
