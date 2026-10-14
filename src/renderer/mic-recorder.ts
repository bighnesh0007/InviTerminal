import { encodeWav } from '../shared/wav';

export interface Recording {
  wav: Uint8Array;
  seconds: number;
  samples: number;
}

export interface MicRecorder {
  start(): Promise<void>;
  /** Stops capture and returns the encoded 16 kHz mono WAV. */
  stopAndEncode(): Recording;
  dispose(): void;
}

/**
 * Captures microphone PCM and encodes it to a whisper-ready WAV. Shared by the
 * mic panel and interview practice so there is one capture implementation.
 * ScriptProcessor is deprecated but dependency-free and fine for short clips.
 */
export function createMicRecorder(onLevel: (level01: number) => void = () => {}): MicRecorder {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let proc: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let raf = 0;

  async function start(): Promise<void> {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    proc = ctx.createScriptProcessor(4096, 1, 1);
    chunks = [];
    proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(proc);
    proc.connect(ctx.destination);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const loop = () => {
      analyser!.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      onLevel(Math.min(1, peak / 128));
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function dispose(): void {
    cancelAnimationFrame(raf);
    proc?.disconnect();
    analyser?.disconnect();
    proc = null;
    analyser = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close();
    ctx = null;
    onLevel(0);
  }

  function stopAndEncode(): Recording {
    const rate = ctx?.sampleRate ?? 48000;
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    dispose();
    return { wav: encodeWav(pcm, rate), seconds: total / rate, samples: total };
  }

  return { start, stopAndEncode, dispose };
}
