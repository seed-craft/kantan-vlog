// Built-in BGM: short original loops synthesized with Web Audio at render time.
// Nothing is downloaded and there is no third-party music, so there are no rights to clear.

export type PresetId = 'honobono' | 'wakuwaku' | 'shittori' | 'kirakira';

export const PRESETS: { id: PresetId; label: string; desc: string }[] = [
  { id: 'honobono', label: 'ほのぼの', desc: '家族のおでかけに' },
  { id: 'wakuwaku', label: 'わくわく', desc: '旅行・イベントに' },
  { id: 'shittori', label: 'しっとり', desc: '成長記録・思い出に' },
  { id: 'kirakira', label: 'キラキラ', desc: 'お祝い・季節の行事に' },
];

/** Songs bundled as audio files, listed in public/bgm/tracks.json. */
export type Track = { id: string; label: string; desc?: string; file: string; credit?: string };

export async function loadTracks(): Promise<Track[]> {
  try {
    const res = await fetch('./bgm/tracks.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const list = (await res.json()) as Track[];
    return Array.isArray(list) ? list.filter((t) => t && t.id && t.label && t.file) : [];
  } catch {
    return [];
  }
}

const SR = 48000;

type Chord = { root: number; tones: number[] };
type Song = {
  bpm: number;
  chords: Chord[];
  seed: number;
  bar: (s: Synth, chord: Chord, t: number, barIndex: number, beat: number, rnd: () => number) => void;
};

const c = (root: number, ...tones: number[]): Chord => ({ root, tones });

const SONGS: Record<PresetId, Song> = {
  // C – G – Am – F, ukulele-like plucks, soft shaker, bell melody
  honobono: {
    bpm: 92,
    seed: 11,
    chords: [c(48, 60, 64, 67), c(43, 59, 62, 67), c(45, 60, 64, 69), c(41, 60, 65, 69)],
    bar(s, ch, t, i, b, rnd) {
      const arp = [0, 1, 2, 1, 0, 1, 2, 1];
      arp.forEach((k, j) => s.pluck(t + (j * b) / 2, ch.tones[k] + (j === 6 ? 12 : 0), b * 1.2, j % 2 ? 0.16 : 0.22));
      s.bass(t, ch.root, b * 1.8, 0.5);
      s.bass(t + 2 * b, ch.root + 7, b * 1.8, 0.4);
      if (i >= 2) {
        for (let j = 0; j < 8; j++) s.shaker(t + (j * b) / 2, j % 2 ? 0.05 : 0.09);
        s.kick(t, 0.35);
        s.kick(t + 2 * b, 0.25);
      }
      if (i % 8 >= 4) melody(s, ch, t, b, rnd, 0.12);
    },
  },
  // G – D – Em – C, four-on-the-floor, offbeat stabs, bouncing bass
  wakuwaku: {
    bpm: 118,
    seed: 23,
    chords: [c(43, 59, 62, 67), c(38, 57, 62, 66), c(40, 59, 64, 67), c(36, 60, 64, 67)],
    bar(s, ch, t, i, b, rnd) {
      for (let j = 0; j < 4; j++) {
        for (const n of ch.tones) s.pluck(t + j * b + b / 2, n, b * 0.35, 0.1);
      }
      for (let j = 0; j < 8; j++) s.bass(t + (j * b) / 2, ch.root + (j % 2 ? 12 : 0), b * 0.45, 0.42);
      if (i >= 1) {
        for (let j = 0; j < 4; j++) s.kick(t + j * b, 0.55);
        s.clap(t + b, 0.22);
        s.clap(t + 3 * b, 0.22);
        for (let j = 0; j < 4; j++) s.hat(t + j * b + b / 2, 0.09);
      }
      if (i % 8 >= 4) melody(s, ch, t, b, rnd, 0.13);
    },
  },
  // Am – F – C – G, pad + slow piano, no drums
  shittori: {
    bpm: 70,
    seed: 37,
    chords: [c(45, 57, 60, 64), c(41, 57, 60, 65), c(36, 55, 60, 64), c(43, 55, 59, 62)],
    bar(s, ch, t, i, b, rnd) {
      s.pad(t, ch.tones, b * 4, 0.07);
      const pat = [0, 2, 1, 2];
      pat.forEach((k, j) => s.keys(t + j * b, ch.tones[k] + 12, b * 2, 0.15));
      s.bass(t, ch.root, b * 3.8, 0.35);
      if (i % 4 === 3) s.bell(t + 2 * b, ch.tones[2] + 24, b * 3, 0.08);
      if (i % 8 >= 4 && rnd() < 0.8) s.keys(t + 2.5 * b, ch.tones[Math.floor(rnd() * 3)] + 24, b * 1.5, 0.08);
    },
  },
  // D – A – Bm – G, bell arpeggios, light beat
  kirakira: {
    bpm: 104,
    seed: 41,
    chords: [c(38, 62, 66, 69), c(45, 61, 64, 69), c(47, 62, 66, 71), c(43, 62, 67, 71)],
    bar(s, ch, t, i, b, rnd) {
      const arp = [0, 1, 2, 3, 2, 1, 2, 3];
      const notes = [...ch.tones, ch.tones[0] + 12];
      arp.forEach((k, j) => s.bell(t + (j * b) / 2, notes[k] + 12, b, j % 2 ? 0.07 : 0.1));
      s.pad(t, ch.tones, b * 4, 0.04);
      s.bass(t, ch.root, b * 1.5, 0.45);
      s.bass(t + 2.5 * b, ch.root, b * 1.2, 0.35);
      if (i >= 2) {
        s.kick(t, 0.45);
        s.kick(t + 2 * b, 0.4);
        s.clap(t + 3 * b, 0.15);
        for (let j = 0; j < 8; j++) s.hat(t + (j * b) / 2, j % 2 ? 0.05 : 0.08);
      }
      if (i % 8 >= 4) melody(s, ch, t, b, rnd, 0.1);
    },
  },
};

function melody(s: Synth, ch: Chord, t: number, b: number, rnd: () => number, vel: number) {
  const slots = [0, 1, 1.5, 2, 3, 3.5];
  for (const at of slots) {
    if (rnd() < 0.45) continue;
    const n = ch.tones[Math.floor(rnd() * ch.tones.length)] + 12;
    s.bell(t + at * b, n, b * 1.2, vel);
  }
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

class Synth {
  private noise: AudioBuffer;
  constructor(
    private ctx: BaseAudioContext,
    private out: AudioNode,
  ) {
    const n = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = n.getChannelData(0);
    const r = mulberry32(99);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
    this.noise = n;
  }

  private env(t: number, peak: number, attack: number, decay: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, len: number, dest: AudioNode) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(dest);
    o.start(t);
    o.stop(t + len + 0.05);
    return o;
  }

  private lowpass(freq: number) {
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    return f;
  }

  pluck(t: number, n: number, len: number, v: number) {
    const g = this.env(t, v, 0.004, len);
    const f = this.lowpass(2600);
    f.frequency.setValueAtTime(2600, t);
    f.frequency.exponentialRampToValueAtTime(700, t + len);
    f.connect(g).connect(this.out);
    this.osc('triangle', hz(n), t, len, f);
    this.osc('sine', hz(n + 12), t, len * 0.5, f);
  }

  keys(t: number, n: number, len: number, v: number) {
    const g = this.env(t, v, 0.006, len);
    const f = this.lowpass(1800);
    f.connect(g).connect(this.out);
    this.osc('sine', hz(n), t, len, f);
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.3;
    g2.connect(f);
    this.osc('triangle', hz(n + 12), t, len * 0.4, g2);
  }

  bell(t: number, n: number, len: number, v: number) {
    const g = this.env(t, v, 0.003, len);
    g.connect(this.out);
    this.osc('sine', hz(n), t, len, g);
    const g2 = this.env(t, v * 0.35, 0.002, len * 0.3);
    g2.connect(this.out);
    this.osc('sine', hz(n) * 4.0, t, len * 0.3, g2);
  }

  pad(t: number, tones: number[], len: number, v: number) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + Math.min(0.6, len / 3));
    g.gain.setValueAtTime(v, t + len - 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t + len + 0.3);
    const f = this.lowpass(900);
    f.connect(g).connect(this.out);
    for (const n of tones) {
      for (const det of [-7, 7]) {
        const o = this.osc('sawtooth', hz(n), t, len + 0.3, f);
        o.detune.value = det;
      }
    }
  }

  bass(t: number, n: number, len: number, v: number) {
    const g = this.env(t, v, 0.01, len);
    const f = this.lowpass(500);
    f.connect(g).connect(this.out);
    this.osc('triangle', hz(n - 12), t, len, f);
    this.osc('sine', hz(n - 12), t, len, f);
  }

  kick(t: number, v: number) {
    const g = this.env(t, v, 0.002, 0.28);
    g.connect(this.out);
    const o = this.osc('sine', 110, t, 0.3, g);
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  }

  private noiseHit(t: number, v: number, len: number, type: BiquadFilterType, freq: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.env(t, v, 0.001, len);
    src.connect(f).connect(g).connect(this.out);
    src.start(t, (t * 0.618) % 0.5);
    src.stop(t + len + 0.05);
  }

  hat(t: number, v: number) {
    this.noiseHit(t, v, 0.05, 'highpass', 7500);
  }
  shaker(t: number, v: number) {
    this.noiseHit(t, v, 0.07, 'highpass', 5000);
  }
  clap(t: number, v: number) {
    this.noiseHit(t, v, 0.16, 'bandpass', 1700);
  }
}

function makeReverb(ctx: BaseAudioContext) {
  const len = Math.floor(ctx.sampleRate * 1.8);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  const r = mulberry32(7);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  const conv = ctx.createConvolver();
  conv.buffer = ir;
  return conv;
}

/** Renders `seconds` of the preset as a stereo AudioBuffer, peak-normalized. */
export async function renderPreset(id: PresetId, seconds: number): Promise<AudioBuffer> {
  const song = SONGS[id];
  const len = Math.max(1, Math.ceil(seconds * SR));
  const ctx = new OfflineAudioContext(2, len, SR);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 3;
  comp.connect(ctx.destination);
  const dry = ctx.createGain();
  dry.gain.value = 0.8;
  dry.connect(comp);
  const verb = makeReverb(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.22;
  verb.connect(wet).connect(comp);
  const bus = ctx.createGain();
  bus.connect(dry);
  bus.connect(verb);

  const synth = new Synth(ctx, bus);
  const rnd = mulberry32(song.seed);
  const beat = 60 / song.bpm;
  const barLen = beat * 4;
  const bars = Math.ceil(seconds / barLen);
  for (let i = 0; i < bars; i++) {
    song.bar(synth, song.chords[i % song.chords.length], i * barLen, i, beat, rnd);
  }

  const out = await ctx.startRendering();
  // Normalize by average loudness (so all songs feel equally loud), without clipping.
  let peak = 0;
  let sum = 0;
  for (let ch = 0; ch < out.numberOfChannels; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      peak = Math.max(peak, Math.abs(d[i]));
      sum += d[i] * d[i];
    }
  }
  const rms = Math.sqrt(sum / (out.length * out.numberOfChannels));
  if (peak > 0 && rms > 0) {
    const k = Math.min(0.1 / rms, 0.9 / peak); // ≈ -20 dBFS RMS
    for (let ch = 0; ch < out.numberOfChannels; ch++) {
      const d = out.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return out;
}
