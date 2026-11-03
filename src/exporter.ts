import {
  AudioBufferSink,
  AudioBufferSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type OutputFormat,
  type VideoCodec,
} from 'mediabunny';
import { UserFacingError, type Clip } from './media';
import { renderPreset, type PresetId } from './music';
import { canvasFont, ensureFont, type FontId } from './fonts';

export type Orientation = 'portrait' | 'landscape';
export const FPS = 30;
export const TITLE_SECONDS = 3;
export const TITLE_FADE = 0.5;
const SAMPLE_RATE = 48000;
const VIDEO_BITRATE = 4_000_000;
const AUDIO_BITRATE = 128_000;

export const outputSize = (o: Orientation) => (o === 'portrait' ? { w: 720, h: 1280 } : { w: 1280, h: 720 });

export type BgmChoice =
  | { kind: 'preset'; id: PresetId }
  | { kind: 'track'; id: string; url: string; label: string }
  | { kind: 'file'; file: File }
  | null;

export type ExportOptions = {
  clips: Clip[];
  orientation: Orientation;
  title: string;
  titleFont: FontId;
  bgm: BgmChoice;
  /** 0..1 */
  videoVolume: number;
  /** 0..1 */
  bgmVolume: number;
  signal: AbortSignal;
  onProgress: (fraction: number, label: string) => void;
};

export type ExportResult = {
  blob: Blob;
  extension: string;
  mimeType: string;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  usedWasmAac: boolean;
  seconds: number;
  width: number;
  height: number;
};

type Plan = {
  makeFormat: () => OutputFormat;
  video: VideoCodec;
  audio: AudioCodec;
  usedWasmAac: boolean;
};

let aacRegistered = false;

/** Picks MP4 (H.264 + AAC) when possible, otherwise WebM. */
export async function planFormat(): Promise<Plan> {
  if (typeof VideoEncoder === 'undefined') {
    throw new UserFacingError(
      'このブラウザは動画の書き出しに対応していません。iPhoneはSafari（iOS 16.4以降）、AndroidはChromeの最新版で開いてください。',
    );
  }
  const audioOpts = { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: AUDIO_BITRATE };
  const size = { width: 720, height: 1280, bitrate: VIDEO_BITRATE };
  const avc = (await canEncodeVideo('avc', size)) && (await canEncodeVideo('avc', { ...size, width: 1280, height: 720 }));
  let aac = await canEncodeAudio('aac', audioOpts);
  if (avc && !aac && !aacRegistered) {
    // Some browsers (e.g. Safari before iOS 26) can't encode AAC natively.
    // Load a small in-browser AAC encoder only in that case.
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
    aacRegistered = true;
    aac = await canEncodeAudio('aac', audioOpts);
  }
  if (avc && aac) {
    return {
      makeFormat: () => new Mp4OutputFormat({ fastStart: 'in-memory' }),
      video: 'avc',
      audio: 'aac',
      usedWasmAac: aacRegistered,
    };
  }
  const webmVideo = await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width: 1280, height: 720 });
  const opus = await canEncodeAudio('opus', audioOpts);
  if (webmVideo && opus) {
    return { makeFormat: () => new WebMOutputFormat(), video: webmVideo, audio: 'opus', usedWasmAac: false };
  }
  throw new UserFacingError('このブラウザでは音声付きの動画を書き出せません。別のブラウザで試してください。');
}

class Cancelled extends Error {}
export const isCancelled = (e: unknown) => e instanceof Cancelled;

export async function exportVlog(opts: ExportOptions): Promise<ExportResult> {
  const { clips, signal, onProgress } = opts;
  const { w: W, h: H } = outputSize(opts.orientation);
  const check = () => {
    if (signal.aborted) throw new Cancelled();
  };

  // Frame counts decide all timing, so audio and video lengths always match.
  const frames = clips.map((c) => Math.max(1, Math.round((c.end - c.start) * FPS)));
  const totalFrames = frames.reduce((a, b) => a + b, 0);
  const totalSeconds = totalFrames / FPS;

  onProgress(0, '準備しています');
  const plan = await planFormat();
  check();

  onProgress(0.02, '音をまとめています');
  const mixed = await renderAudio(opts, frames, totalSeconds, check);
  check();

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new UserFacingError('画面の描画機能が使えませんでした。');
  const backdrop = new Backdrop(W, H);
  if (opts.title.trim()) await ensureFont(opts.titleFont, opts.title.trim());

  const format = plan.makeFormat();
  const output = new Output({ format, target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, { codec: plan.video, bitrate: VIDEO_BITRATE, keyFrameInterval: 2 });
  const audioSource = new AudioBufferSource({ codec: plan.audio, bitrate: AUDIO_BITRATE });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  output.addAudioTrack(audioSource);

  let started = false;
  try {
    await output.start();
    started = true;

    // Audio is fed in 1-second chunks, staying slightly ahead of the video.
    let audioPos = 0;
    const feedAudioUntil = async (t: number) => {
      while (audioPos < mixed.length && audioPos / SAMPLE_RATE <= t) {
        const len = Math.min(SAMPLE_RATE, mixed.length - audioPos);
        const chunk = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
        for (let ch = 0; ch < 2; ch++) {
          chunk.copyToChannel(mixed.getChannelData(ch).subarray(audioPos, audioPos + len), ch);
        }
        await audioSource.add(chunk);
        audioPos += len;
      }
    };

    let frameIndex = 0;
    const emitFrame = async (i: number) => {
      const t = frameIndex / FPS;
      if (opts.title.trim() && t < TITLE_SECONDS) drawTitle(ctx, opts.title.trim(), t, opts.titleFont);
      await feedAudioUntil(t + 1);
      await videoSource.add(t, 1 / FPS);
      frameIndex++;
      if (frameIndex % 5 === 0) {
        onProgress(0.1 + 0.88 * (frameIndex / totalFrames), `動画を作っています（${i + 1}/${clips.length}）`);
      }
    };
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      // Fit the whole picture inside the frame (never crop). Empty space gets a blurred copy.
      const scale = Math.min(W / clip.width, H / clip.height);
      const fw = Math.min(W, 2 * Math.round((clip.width * scale) / 2));
      const fh = Math.min(H, 2 * Math.round((clip.height * scale) / 2));
      const fills = fw >= W - 4 && fh >= H - 4;
      if (clip.kind === 'photo') {
        // A photo is the same picture every frame: compose it once, then repeat it.
        const still = Object.assign(document.createElement('canvas'), { width: W, height: H });
        const sctx = still.getContext('2d', { alpha: false })!;
        if (fills) {
          sctx.drawImage(clip.image, 0, 0, W, H);
        } else {
          backdrop.draw(sctx, clip.image);
          sctx.imageSmoothingQuality = 'high';
          sctx.drawImage(clip.image, (W - fw) / 2, (H - fh) / 2, fw, fh);
        }
        for (let k = 0; k < frames[i]; k++) {
          check();
          ctx.drawImage(still, 0, 0);
          await emitFrame(i);
        }
        continue;
      }
      const sink = new CanvasSink(clip.video, { width: fills ? W : fw, height: fills ? H : fh, fit: 'cover', poolSize: 2 });
      const from = clip.base + clip.start;
      const times = Array.from({ length: frames[i] }, (_, k) => from + k / FPS);
      for await (const wrapped of sink.canvasesAtTimestamps(times)) {
        check();
        if (wrapped) {
          if (fills) {
            ctx.drawImage(wrapped.canvas, 0, 0, W, H);
          } else {
            backdrop.draw(ctx, wrapped.canvas);
            ctx.drawImage(wrapped.canvas, (W - fw) / 2, (H - fh) / 2, fw, fh);
          }
        } // else: keep the previous frame on screen
        await emitFrame(i);
      }
    }
    await feedAudioUntil(Infinity);
    videoSource.close();
    audioSource.close();
    onProgress(0.99, '仕上げています');
    await output.finalize();
  } catch (err) {
    if (started) await output.cancel().catch(() => {});
    throw err;
  }

  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new UserFacingError('書き出したデータが空でした。');
  onProgress(1, 'できました');
  return {
    blob: new Blob([buffer], { type: format.mimeType }),
    extension: format.fileExtension,
    mimeType: format.mimeType,
    videoCodec: plan.video,
    audioCodec: plan.audio,
    usedWasmAac: plan.usedWasmAac,
    seconds: totalSeconds,
    width: W,
    height: H,
  };
}

/**
 * Soft blurred background made by shrinking the frame twice and scaling it back up.
 * Works on every browser (no canvas `filter` needed) and is cheap per frame.
 */
class Backdrop {
  private mid: HTMLCanvasElement;
  private small: HTMLCanvasElement;
  constructor(
    private W: number,
    private H: number,
  ) {
    this.mid = Object.assign(document.createElement('canvas'), { width: Math.round(W / 6), height: Math.round(H / 6) });
    this.small = Object.assign(document.createElement('canvas'), { width: Math.round(W / 30), height: Math.round(H / 30) });
  }
  draw(ctx: CanvasRenderingContext2D, src: CanvasImageSource & { width: number; height: number }) {
    const m = this.mid.getContext('2d')!;
    const s = this.small.getContext('2d')!;
    // cover-fit the source into the mid canvas
    const mw = this.mid.width;
    const mh = this.mid.height;
    const k = Math.max(mw / src.width, mh / src.height);
    const dw = src.width * k;
    const dh = src.height * k;
    m.imageSmoothingQuality = 'high';
    m.drawImage(src, (mw - dw) / 2, (mh - dh) / 2, dw, dh);
    s.imageSmoothingQuality = 'high';
    s.drawImage(this.mid, 0, 0, this.small.width, this.small.height);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.small, 0, 0, this.W, this.H);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.restore();
  }
}

export async function loadBgm(bgm: NonNullable<BgmChoice>, seconds: number, ctx: BaseAudioContext): Promise<AudioBuffer> {
  if (bgm.kind === 'preset') return renderPreset(bgm.id, seconds);
  if (bgm.kind === 'track') {
    try {
      const res = await fetch(bgm.url);
      if (!res.ok) throw new Error(String(res.status));
      return await ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      throw new UserFacingError(`曲「${bgm.label}」を読み込めませんでした。通信状況を確かめて、もう一度試してください。`);
    }
  }
  try {
    return await ctx.decodeAudioData(await bgm.file.arrayBuffer());
  } catch {
    throw new UserFacingError(
      `音楽ファイル「${bgm.file.name}」を読み込めませんでした。MP3またはM4A（AAC）のファイルを選んでください。`,
    );
  }
}

/** Mixes clip audio (back to back) and the optional BGM into one stereo buffer. */
async function renderAudio(
  opts: ExportOptions,
  frames: number[],
  totalSeconds: number,
  check: () => void,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(totalSeconds * SAMPLE_RATE), SAMPLE_RATE);
  const FADE = 0.015; // tiny fades avoid clicks at the cuts

  let offset = 0;
  for (let i = 0; i < opts.clips.length; i++) {
    const clip = opts.clips[i];
    const len = frames[i] / FPS;
    if (clip.kind === 'video' && clip.audio && opts.videoVolume > 0) {
      const sr = clip.audio.sampleRate;
      const channels = Math.min(2, Math.max(1, clip.audio.numberOfChannels));
      const buf = ctx.createBuffer(channels, Math.max(1, Math.ceil(len * sr)), sr);
      const s0 = clip.base + clip.start;
      const sink = new AudioBufferSink(clip.audio);
      for await (const w of sink.buffers(s0, s0 + len)) {
        check();
        const ab = w.buffer;
        let dst = Math.round((w.timestamp - s0) * sr);
        let src = 0;
        if (dst < 0) {
          src = -dst;
          dst = 0;
        }
        const n = Math.min(ab.length - src, buf.length - dst);
        if (n <= 0) continue;
        for (let ch = 0; ch < channels; ch++) {
          const data = ab.getChannelData(Math.min(ch, ab.numberOfChannels - 1));
          buf.getChannelData(ch).set(data.subarray(src, src + n), dst);
        }
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const gain = ctx.createGain();
      const v = opts.videoVolume;
      gain.gain.setValueAtTime(0, offset);
      gain.gain.linearRampToValueAtTime(v, offset + FADE);
      gain.gain.setValueAtTime(v, Math.max(offset + FADE, offset + len - FADE));
      gain.gain.linearRampToValueAtTime(0, offset + len);
      node.connect(gain).connect(ctx.destination);
      node.start(offset);
      node.stop(offset + len);
    }
    offset += len;
    opts.onProgress(0.02 + 0.05 * ((i + 1) / opts.clips.length), '音をまとめています');
  }

  if (opts.bgm && opts.bgmVolume > 0) {
    opts.onProgress(0.07, '音楽を用意しています');
    const music = await loadBgm(opts.bgm, totalSeconds, ctx);
    check();
    scheduleBgm(ctx, music, opts.bgmVolume, totalSeconds);
  }

  const rendered = await ctx.startRendering();
  opts.onProgress(0.1, '動画を作っています');
  return rendered;
}

/** Plays `music` from 0 (looping if short) with a short fade-in and a 2s fade-out at the end. */
export function scheduleBgm(ctx: BaseAudioContext, music: AudioBuffer, volume: number, seconds: number, when = 0) {
  const node = ctx.createBufferSource();
  node.buffer = music;
  node.loop = true;
  const gain = ctx.createGain();
  const fadeOut = Math.min(2, seconds / 4);
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(volume, when + Math.min(0.5, seconds / 4));
  gain.gain.setValueAtTime(volume, when + seconds - fadeOut);
  gain.gain.linearRampToValueAtTime(0, when + seconds);
  node.connect(gain).connect(ctx.destination);
  node.start(when);
  node.stop(when + seconds);
  return { node, gain };
}

/** Splits a title into at most two balanced lines. */
function titleLines(ctx: CanvasRenderingContext2D, title: string, maxW: number): string[] {
  if (ctx.measureText(title).width <= maxW) return [title];
  const chars = Array.from(title);
  const space = title.lastIndexOf(' ', Math.ceil(title.length / 2) + 4);
  const cut = space > 2 ? space : Math.ceil(chars.length / 2);
  return [chars.slice(0, cut).join('').trim(), chars.slice(cut).join('').trim()];
}

/**
 * Title over the opening seconds: fades in, holds, fades out.
 * Plain text (no band, outline or shadow), centered in the frame.
 */
export function drawTitle(ctx: CanvasRenderingContext2D, title: string, t: number, font: FontId) {
  const a = Math.min(1, t / TITLE_FADE, (TITLE_SECONDS - t) / TITLE_FADE);
  if (a <= 0) return;
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const maxW = W * 0.86;
  ctx.save();
  ctx.globalAlpha = a;

  let size = Math.round(Math.min(W, H) * 0.09);
  ctx.font = canvasFont(font, size);
  let lines = titleLines(ctx, title, maxW);
  while (lines.some((l) => ctx.measureText(l).width > maxW) && size > 22) {
    size -= 2;
    ctx.font = canvasFont(font, size);
    lines = titleLines(ctx, title, maxW);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lh = size * 1.3;
  const ys = lines.map((_, k) => H / 2 + (k - (lines.length - 1) / 2) * lh);

  ctx.fillStyle = '#fffaf2';
  lines.forEach((l, k) => ctx.fillText(l, W / 2, ys[k]));
  ctx.restore();
}
