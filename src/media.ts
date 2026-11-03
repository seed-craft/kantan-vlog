import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';

type ClipBase = {
  id: string;
  file: File;
  name: string;
  duration: number;
  width: number;
  height: number;
  /** Trim range in seconds (for photos: 0..shown seconds). */
  start: number;
  end: number;
  thumbUrl: string;
  objectUrl: string;
};

export type VideoClip = ClipBase & {
  kind: 'video';
  input: Input;
  video: InputVideoTrack;
  audio: InputAudioTrack | null;
  /** Timestamp of the first video frame. All clip times are relative to it. */
  base: number;
};

/** A still photo shown for a few seconds. `image` is already shrunk to at most PHOTO_MAX_SIDE px. */
export type PhotoClip = ClipBase & {
  kind: 'photo';
  image: HTMLCanvasElement;
  audio: null;
};

export type Clip = VideoClip | PhotoClip;

export const PHOTO_SECONDS = 3;
export const PHOTO_SECONDS_CHOICES = [2, 3, 4, 5, 7, 10];
const PHOTO_MAX_SIDE = 1280;

/** A message meant for the person using the app (Japanese, no jargon). */
export class UserFacingError extends Error {}

let nextId = 1;

export function isPhotoFile(file: File) {
  return file.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(file.name);
}

/** Loads a picked file as a video clip or a photo. */
export function loadMedia(file: File): Promise<Clip> {
  return isPhotoFile(file) ? loadPhoto(file) : loadClip(file);
}

async function loadPhoto(file: File): Promise<PhotoClip> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = objectUrl;
    try {
      await img.decode();
    } catch {
      throw new UserFacingError(`「${file.name}」は読み込めない写真です。JPEG・PNG・HEICの写真を選んでください。`);
    }
    // Shrink right away so ten 12MP photos don't fill the phone's memory.
    const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const image = document.createElement('canvas');
    image.width = Math.max(2, Math.round(img.naturalWidth * k));
    image.height = Math.max(2, Math.round(img.naturalHeight * k));
    image.getContext('2d')!.drawImage(img, 0, 0, image.width, image.height);
    const tk = Math.min(1, 320 / image.width, 180 / image.height);
    const thumb = Object.assign(document.createElement('canvas'), {
      width: Math.max(2, Math.round(image.width * tk)),
      height: Math.max(2, Math.round(image.height * tk)),
    });
    thumb.getContext('2d')!.drawImage(image, 0, 0, thumb.width, thumb.height);
    const blob = await new Promise<Blob | null>((r) => thumb.toBlob(r, 'image/jpeg', 0.7));
    return {
      kind: 'photo',
      id: `clip${nextId++}`,
      file,
      name: file.name,
      image,
      audio: null,
      duration: PHOTO_SECONDS,
      width: image.width,
      height: image.height,
      start: 0,
      end: PHOTO_SECONDS,
      thumbUrl: blob ? URL.createObjectURL(blob) : '',
      objectUrl,
    };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    if (err instanceof UserFacingError) throw err;
    console.error(err);
    throw new UserFacingError(`「${file.name}」を読み込めませんでした。`);
  }
}

export async function loadClip(file: File): Promise<VideoClip> {
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
      kind: 'video',
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
  if (clip.kind === 'video') clip.input.dispose();
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
