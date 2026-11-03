import { int16ToFloat } from './pcm.js';
import { AGENT_AUDIO_SAMPLE_RATE } from '../../shared/voiceProtocol.js';

/** Gap-free playback of the assistant's 24 kHz PCM chunks, with an instant flush for interruptions. */
export class Player {
  private nextStart = 0;
  private readonly active = new Set<AudioBufferSourceNode>();
  private readonly output: GainNode;

  constructor(private readonly context: AudioContext) {
    this.output = context.createGain();
    this.output.connect(context.destination);
  }

  enqueue(pcm: ArrayBuffer): void {
    const samples = int16ToFloat(pcm);
    if (samples.length === 0) return;
    const buffer = this.context.createBuffer(1, samples.length, AGENT_AUDIO_SAMPLE_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    // A small lead absorbs network jitter; later chunks are scheduled back to back.
    const startAt = Math.max(this.nextStart, this.context.currentTime + 0.06);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.active.add(source);
    source.onended = () => { this.active.delete(source); };
  }

  /** Stop everything queued, right now. */
  flush(): void {
    for (const source of this.active) {
      source.onended = null;
      try { source.stop(); } catch { /* Not started yet or already stopped. */ }
      source.disconnect();
    }
    this.active.clear();
    this.nextStart = 0;
  }

  get speaking(): boolean {
    return this.active.size > 0 && this.nextStart > this.context.currentTime;
  }
}
