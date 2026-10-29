/**
 * Raw PCM in and out of the browser.
 *
 * Everything else in Conduit records with `MediaRecorder` and gets webm/opus
 * blobs, which is right for "upload a clip and transcribe it" and useless here:
 * Nova wants a continuous stream of 16 kHz PCM16 and sends back 24 kHz PCM16.
 * There is no other way to get raw samples out of a microphone in a browser
 * than an AudioWorklet, and no other way to play a stream of them back without
 * gaps than to queue them into one.
 *
 * Both worklets are defined here as source strings and loaded from a blob URL,
 * because `addModule` needs a real URL and this keeps the pair next to each
 * other rather than in a stray file in `public/` that the bundler ignores.
 */

/**
 * Capture: downsample to 16 kHz, convert float to PCM16, post it out.
 *
 * The resampling is a plain decimating average rather than a proper filter.
 * That is a real trade: it aliases slightly above 8 kHz. Speech energy that
 * matters for recognition sits well below that, Nova transcribed test clips
 * perfectly through it, and a windowed-sinc would cost more CPU on the audio
 * thread — where an overrun is a dropout, not a slowdown.
 */
const CAPTURE_WORKLET = `
class ConduitCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.buffer = [];
    this.pos = 0;
    // 20ms at the target rate: small enough to feel instant, big enough that
    // we are not posting a message every render quantum.
    this.frame = Math.round(this.targetRate * 0.02);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const channel = input[0];

    // Walk the source at a fractional step, averaging the samples each output
    // sample spans. Keeps the phase across render quanta via this.pos.
    for (let i = 0; i < channel.length; i++) {
      this.buffer.push(channel[i]);
    }
    const out = [];
    while (this.pos + this.ratio < this.buffer.length) {
      const start = Math.floor(this.pos);
      const end = Math.floor(this.pos + this.ratio);
      let sum = 0;
      let n = 0;
      for (let j = start; j < end && j < this.buffer.length; j++) { sum += this.buffer[j]; n++; }
      out.push(n ? sum / n : 0);
      this.pos += this.ratio;
    }
    const consumed = Math.floor(this.pos);
    if (consumed > 0) {
      this.buffer.splice(0, consumed);
      this.pos -= consumed;
    }

    for (const sample of out) {
      this.pending = this.pending || [];
      this.pending.push(sample);
      if (this.pending.length >= this.frame) {
        const pcm = new Int16Array(this.pending.length);
        let peak = 0;
        for (let i = 0; i < this.pending.length; i++) {
          const v = Math.max(-1, Math.min(1, this.pending[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
        }
        // The level rides along so the main thread can gate on it without
        // opening a second analyser on the same stream.
        this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
        this.pending = [];
      }
    }
    return true;
  }
}
registerProcessor('conduit-capture', ConduitCapture);
`;

/**
 * Playback: a queue that plays PCM16 as it arrives, and can be emptied.
 *
 * Emptying is what makes barge-in feel instant. Nova stops generating the
 * moment it is interrupted, but whatever already crossed the wire is sitting
 * in this queue — without a flush the user keeps hearing a sentence the model
 * has already abandoned.
 */
const PLAYBACK_WORKLET = `
class ConduitPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.playing = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') { this.queue = []; this.offset = 0; return; }
      this.queue.push(new Int16Array(e.data));
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    let i = 0;
    while (i < out.length) {
      if (!this.queue.length) { out[i++] = 0; continue; }
      const chunk = this.queue[0];
      out[i++] = chunk[this.offset++] / 0x8000;
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; }
    }
    const busy = this.queue.length > 0;
    if (busy !== this.playing) {
      this.playing = busy;
      this.port.postMessage({ playing: busy });
    }
    return true;
  }
}
registerProcessor('conduit-playback', ConduitPlayback);
`;

function moduleUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
}

export interface PcmPipes {
  context: AudioContext;
  capture: AudioWorkletNode;
  playback: AudioWorkletNode;
  stream: MediaStream;
  close: () => void;
}

/**
 * Open the microphone and the speaker as raw PCM.
 *
 * `echoCancellation` is on: the microphone is open while Nova is talking, and
 * without it the model hears itself and answers its own voice. Noise
 * suppression and gain control stay off — they are tuned for phone calls and
 * strip exactly the low-energy consonants speech recognition needs, which is
 * the same reason the existing wake-word path turns them off.
 */
export async function openPcmPipes(inputRate = 16000, outputRate = 24000): Promise<PcmPipes> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });

  // The context runs at the output rate so playback is sample-accurate; the
  // capture worklet resamples down to whatever Nova wants.
  const context = new AudioContext({ sampleRate: outputRate });
  if (context.state === 'suspended') await context.resume();

  const captureUrl = moduleUrl(CAPTURE_WORKLET);
  const playbackUrl = moduleUrl(PLAYBACK_WORKLET);
  try {
    await context.audioWorklet.addModule(captureUrl);
    await context.audioWorklet.addModule(playbackUrl);
  } finally {
    URL.revokeObjectURL(captureUrl);
    URL.revokeObjectURL(playbackUrl);
  }

  const capture = new AudioWorkletNode(context, 'conduit-capture', {
    numberOfInputs: 1, numberOfOutputs: 0,
    processorOptions: { targetRate: inputRate },
  });
  context.createMediaStreamSource(stream).connect(capture);

  const playback = new AudioWorkletNode(context, 'conduit-playback', {
    numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
  });
  playback.connect(context.destination);

  return {
    context,
    capture,
    playback,
    stream,
    close: () => {
      try { capture.disconnect(); } catch { /* ignore */ }
      try { playback.disconnect(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      try { void context.close(); } catch { /* ignore */ }
    },
  };
}

/** Drop whatever is still queued to play. Used on barge-in. */
export function flushPlayback(playback: AudioWorkletNode): void {
  try { playback.port.postMessage('flush'); } catch { /* already gone */ }
}

/** Hand a chunk of Nova's PCM16 to the speaker. */
export function playPcm(playback: AudioWorkletNode, pcm: ArrayBuffer): void {
  try { playback.port.postMessage(pcm, [pcm]); } catch { /* already gone */ }
}
