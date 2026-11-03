import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';

export type Clip = {
  id: string;
  file: File;
  name: string;
  input: Input;
  video: InputVideoTrack;
  audio: InputAudioTrack | null;
  /** Timestamp of the first video frame. All clip times are relative to it. */
  base: number;
  duration: number;
  width: number;
  height: number;
  /** Trim range in seconds, relative to `base`. */
  start: number;
  end: number;
  thumbUrl: string;
  objectUrl: string;
};

/** A message meant for the person using the app (Japanese, no jargon). */
export class UserFacingError extends Error {}

let nextId = 1;

export async function loadClip(file: File): Promise<Clip> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) {
      throw new UserFacingError(
        `「${file.name}」は読み込めない形式です。スマホのカメラで撮ったMP4・MOVの動画を選んでください。`,
      );
    }
    const video = await input.getPrimaryVideoTrack();
    if (!video) {
      throw new UserFacingError(`「${file.name}」には映像が入っていません。`);
    }
    if (!(await video.canDecode())) {
      const codec = video.codec ?? '不明';
      const hint =
        codec === 'hevc'
          ? 'この端末のブラウザはHEVC（高効率）形式を読めません。iPhoneなら「設定 → カメラ → フォーマット → 互換性優先」で撮った動画を使ってください。'
          : 'この端末のブラウザでは読めない動画形式です。';
      throw new UserFacingError(`「${file.name}」（形式：${codec}）${hint}`);
    }
    let audio = await input.getPrimaryAudioTrack();
    if (audio && !(await audio.canDecode())) {
      // Keep the clip usable; it will just be silent.
      audio = null;
    }
    const base = await video.getFirstTimestamp();
    const duration = (await video.computeDuration()) - base;
    if (!(duration > 0.2)) {
      throw new UserFacingError(`「${file.name}」は短すぎるか、壊れている可能性があります。`);
    }
    const thumbUrl = await makeThumb(video, base + Math.min(1, duration / 2));
    return {
      id: `clip${nextId++}`,
      file,
      name: file.name,
      input,
      video,
      audio,
      base,
      duration,
      width: video.displayWidth,
      height: video.displayHeight,
      start: 0,
      end: duration,
      thumbUrl,
      objectUrl: URL.createObjectURL(file),
    };
  } catch (err) {
    input.dispose();
    if (err instanceof UserFacingError) throw err;
    console.error(err);
    throw new UserFacingError(
      `「${file.name}」を読み込めませんでした。壊れているか、対応していない形式の可能性があります。`,
    );
  }
}

export function disposeClip(clip: Clip) {
  URL.revokeObjectURL(clip.thumbUrl);
  URL.revokeObjectURL(clip.objectUrl);
  clip.input.dispose();
}

async function makeThumb(track: InputVideoTrack, t: number): Promise<string> {
  const sink = new CanvasSink(track, { width: 320, height: 180, fit: 'contain' });
  const wrapped = (await sink.getCanvas(t)) ?? (await sink.getCanvas(0));
  if (!wrapped) return '';
  const c = wrapped.canvas;
  const blob =
    c instanceof OffscreenCanvas
      ? await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
      : await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.7));
  return blob ? URL.createObjectURL(blob) : '';
}

export function clipLength(c: Clip) {
  return Math.max(0, c.end - c.start);
}

export function formatTime(sec: number) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
