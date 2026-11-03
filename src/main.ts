import './style.css';
import {
  PHOTO_SECONDS_CHOICES,
  UserFacingError,
  clipLength,
  disposeClip,
  formatTime,
  loadMedia,
  type Clip,
  type VideoClip,
} from './media';
import {
  TITLE_FADE,
  TITLE_SECONDS,
  drawTitle,
  exportVlog,
  isCancelled,
  loadBgm,
  planFormat,
  type BgmChoice,
  type ExportResult,
  type Orientation,
} from './exporter';
import { DEFAULT_FONT, FONTS, fontFamily, fontWeight, ensureFont, loadFontCss, type FontId } from './fonts';
import { PRESETS, loadTracks, renderPreset, type PresetId, type Track } from './music';

// Limits are provisional: set conservatively for phone memory, to be revisited after real-device tests.
const MAX_CLIPS = 10;
const MAX_TOTAL_SECONDS = 180;
const MIN_CLIP_SECONDS = 0.5;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  clips: [] as Clip[],
  bgmFile: null as File | null,
  exporting: null as AbortController | null,
  result: null as (ExportResult & { url: string }) | null,
};

// ---------- 1. pick ----------

const pick = $<HTMLInputElement>('pick');
pick.addEventListener('change', async () => {
  const files = Array.from(pick.files ?? []);
  pick.value = '';
  if (!files.length) return;
  const errors = $('errors');
  errors.innerHTML = '';
  const loading = $('loading');
  loading.hidden = false;
  for (const [i, file] of files.entries()) {
    if (state.clips.length >= MAX_CLIPS) {
      addError(`一度に使えるのは動画・写真あわせて${MAX_CLIPS}個までです。残りは追加しませんでした。`);
      break;
    }
    loading.textContent = `読み込み中…（${i + 1}/${files.length}）`;
    try {
      state.clips.push(await loadMedia(file));
      render();
    } catch (err) {
      addError(err instanceof UserFacingError ? err.message : `「${file.name}」を読み込めませんでした。`);
      if (!(err instanceof UserFacingError)) console.error(err);
    }
  }
  loading.hidden = true;
  invalidateResult();
  render();
});

function addError(msg: string) {
  const li = document.createElement('li');
  li.textContent = msg;
  $('errors').append(li);
}

// ---------- 2. arrange ----------

function render() {
  const has = state.clips.length > 0;
  $('arrange').hidden = !has;
  $('save').hidden = !has;
  const list = $('clips');
  list.innerHTML = '';
  state.clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'clip';
    li.dataset.id = c.id;
    const img = document.createElement('img');
    img.src = c.thumbUrl;
    img.alt = '';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${i + 1}．${c.kind === 'photo' ? '写真' : '動画'}`;
    const range = document.createElement('div');
    range.className = 'range';
    if (c.kind === 'photo') {
      range.textContent = `${clipLength(c)}秒間うつします`;
    } else {
      const trimmed = c.start > 0.05 || c.end < c.duration - 0.05;
      range.textContent = `${formatTime(c.start)}〜${formatTime(c.end)}（${clipLength(c).toFixed(1)}秒）${trimmed ? '・切った' : ''}`;
    }
    const file = document.createElement('div');
    file.className = 'range';
    file.textContent = c.kind === 'photo' || c.audio ? c.name : `${c.name}（音なし）`;
    meta.append(name, range, file);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      actionBtn('↑', 'up', '前へ', i === 0),
      actionBtn('↓', 'down', '後ろへ', i === state.clips.length - 1),
      c.kind === 'photo' ? secondsSelect(clipLength(c)) : actionBtn('✂ 切る', 'trim', '切る'),
      actionBtn('消す', 'remove', '消す'),
    );
    li.append(img, meta, actions);
    list.append(li);
  });

  const total = state.clips.reduce((s, c) => s + clipLength(c), 0);
  $('total').textContent = `できあがりの長さ：約${total.toFixed(1)}秒`;
  const over = total > MAX_TOTAL_SECONDS;
  const limit = $('limitMsg');
  limit.hidden = !over;
  limit.textContent = over
    ? `合計${MAX_TOTAL_SECONDS / 60}分までにしてください（スマホの負担を抑えるため）。動画を切るか減らしてください。`
    : '';
  $<HTMLButtonElement>('exportBtn').disabled = over || !has || !!state.exporting;
}

function actionBtn(label: string, action: string, aria: string, disabled = false) {
  const b = document.createElement('button');
  b.className = 'btn small';
  b.textContent = label;
  b.dataset.action = action;
  b.setAttribute('aria-label', aria);
  b.disabled = disabled;
  return b;
}

function secondsSelect(current: number) {
  const sel = document.createElement('select');
  sel.className = 'btn small';
  sel.dataset.action = 'seconds';
  sel.setAttribute('aria-label', '写真を見せる秒数');
  for (const n of PHOTO_SECONDS_CHOICES) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = `${n}秒`;
    o.selected = n === current;
    sel.append(o);
  }
  return sel;
}

$('clips').addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  const li = sel.closest<HTMLElement>('li.clip');
  const c = state.clips.find((x) => x.id === li?.dataset.id);
  if (sel.dataset.action !== 'seconds' || !c || c.kind !== 'photo' || state.exporting) return;
  c.duration = c.end = Number(sel.value);
  stopPreview();
  invalidateResult();
  render();
});

$('clips').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  const li = btn?.closest<HTMLElement>('li.clip');
  if (!btn || !li || state.exporting) return;
  const i = state.clips.findIndex((c) => c.id === li.dataset.id);
  if (i < 0) return;
  const clips = state.clips;
  switch (btn.dataset.action) {
    case 'up':
      if (i > 0) [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]];
      break;
    case 'down':
      if (i < clips.length - 1) [clips[i + 1], clips[i]] = [clips[i], clips[i + 1]];
      break;
    case 'trim':
      if (clips[i].kind === 'video') openTrim(clips[i] as VideoClip, i);
      return;
    case 'remove':
      stopPreview();
      disposeClip(clips[i]);
      clips.splice(i, 1);
      break;
  }
  invalidateResult();
  render();
});

// ---------- trim sheet ----------

const dlg = $<HTMLDialogElement>('trimDialog');
const tv = $<HTMLVideoElement>('trimVideo');
const ts = $<HTMLInputElement>('trimStart');
const te = $<HTMLInputElement>('trimEnd');
let trimming: VideoClip | null = null;

function openTrim(clip: VideoClip, index: number) {
  stopPreview();
  trimming = clip;
  $('trimHeading').textContent = `${index + 1}．動画を切る`;
  tv.src = clip.objectUrl;
  const max = clip.duration.toFixed(1);
  ts.max = te.max = max;
  ts.value = clip.start.toFixed(1);
  te.value = Math.min(clip.end, clip.duration).toFixed(1);
  updateTrimLabels();
  dlg.showModal();
  tv.addEventListener('loadedmetadata', () => (tv.currentTime = clip.start), { once: true });
}

function updateTrimLabels() {
  const s = Number(ts.value);
  const e = Number(te.value);
  $('trimStartLabel').textContent = formatTime(s);
  $('trimEndLabel').textContent = formatTime(e);
  const len = e - s;
  const ok = len >= MIN_CLIP_SECONDS;
  $('trimLen').textContent = ok ? `使う長さ：${len.toFixed(1)}秒` : `短すぎます（${MIN_CLIP_SECONDS}秒以上にしてください）`;
  $<HTMLButtonElement>('trimOk').disabled = !ok;
}

ts.addEventListener('input', () => {
  tv.pause();
  tv.currentTime = Number(ts.value);
  updateTrimLabels();
});
te.addEventListener('input', () => {
  tv.pause();
  tv.currentTime = Number(te.value);
  updateTrimLabels();
});
$('setStart').addEventListener('click', () => {
  ts.value = tv.currentTime.toFixed(1);
  updateTrimLabels();
});
$('setEnd').addEventListener('click', () => {
  te.value = tv.currentTime.toFixed(1);
  updateTrimLabels();
});
$('trimPlay').addEventListener('click', () => {
  if (tv.paused) {
    const s = Number(ts.value);
    const e = Number(te.value);
    if (tv.currentTime < s || tv.currentTime >= e - 0.05) tv.currentTime = s;
    void tv.play();
  } else tv.pause();
});
tv.addEventListener('play', () => ($('trimPlay').textContent = '❚❚ 止める'));
tv.addEventListener('pause', () => ($('trimPlay').textContent = '▶ 再生'));
tv.addEventListener('timeupdate', () => {
  $('trimNow').textContent = `いま ${formatTime(tv.currentTime)}`;
  if (!tv.paused && tv.currentTime >= Number(te.value)) tv.pause();
});
$('trimCancel').addEventListener('click', () => dlg.close());
$('trimOk').addEventListener('click', () => {
  if (trimming) {
    const s = Math.max(0, Number(ts.value));
    const e = Math.min(trimming.duration, Number(te.value));
    if (e - s >= MIN_CLIP_SECONDS) {
      trimming.start = s;
      trimming.end = e;
      invalidateResult();
    }
  }
  dlg.close();
  render();
});
dlg.addEventListener('close', () => {
  tv.pause();
  tv.removeAttribute('src');
  tv.load();
  trimming = null;
  render();
});

// ---------- orientation ----------

const orientation = (): Orientation =>
  (document.querySelector<HTMLInputElement>('input[name=orient]:checked')?.value as Orientation) ?? 'portrait';
function syncOrientation() {
  document.body.classList.toggle('portrait', orientation() === 'portrait');
}
document.querySelectorAll<HTMLInputElement>('input[name=orient]').forEach((el) =>
  el.addEventListener('change', () => {
    syncOrientation();
    invalidateResult();
  }),
);
syncOrientation();

// ---------- music ----------

type BgmMode = string; // 'none' | PresetId | 'file' | `track:${id}`
const HINTS = {
  none: '音楽なし。元の動画の音だけになります。',
  preset: 'アプリが作るオリジナル曲です。家族や友だちに送る動画にもそのまま使えます。',
  file: 'スマホに保存した音楽ファイルを使います。使ってよい曲だけを選んでください（音楽配信アプリの曲は選べません）。',
};
const tracks = new Map<string, Track>();

const chipsBox = $('bgmChoices');
function addChip(mode: BgmMode, label: string, desc = '', before?: Element | null) {
  const el = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'bgm';
  input.value = mode;
  input.checked = mode === 'none';
  const span = document.createElement('span');
  span.textContent = label;
  if (desc) {
    const small = document.createElement('small');
    small.textContent = desc;
    span.append(small);
  }
  el.append(input, span);
  chipsBox.insertBefore(el, before ?? null);
}
addChip('none', 'なし');
for (const p of PRESETS) addChip(p.id, p.label, p.desc);
addChip('file', '自分の曲', 'ファイルから');
// Bundled songs (if any) go right after "なし".
// When real songs are bundled, they replace the synthesized ones to keep the choice short.
void loadTracks().then((list) => {
  if (list.length) {
    for (const p of PRESETS) chipsBox.querySelector(`input[value="${p.id}"]`)?.parentElement?.remove();
  }
  const anchor = chipsBox.children[1] ?? null;
  for (const t of list) {
    tracks.set(t.id, t);
    addChip(`track:${t.id}`, t.label, t.desc ?? '', anchor);
  }
});

const bgmMode = (): BgmMode => chipsBox.querySelector<HTMLInputElement>('input:checked')?.value ?? 'none';

function bgmChoice(): BgmChoice {
  const m = bgmMode();
  if (m === 'none') return null;
  if (m === 'file') return state.bgmFile ? { kind: 'file', file: state.bgmFile } : null;
  if (m.startsWith('track:')) {
    const t = tracks.get(m.slice(6));
    return t ? { kind: 'track', id: t.id, url: new URL(`./bgm/${t.file}`, location.href).href, label: t.label } : null;
  }
  return { kind: 'preset', id: m as PresetId };
}

function hintFor(m: BgmMode) {
  if (m === 'none' || m === 'file') return HINTS[m];
  if (m.startsWith('track:')) {
    const t = tracks.get(m.slice(6));
    return t?.credit ?? 'アプリに入っている曲です。家族や友だちに送る動画にもそのまま使えます。';
  }
  return HINTS.preset;
}

const bgmInput = $<HTMLInputElement>('bgm');
chipsBox.addEventListener('change', () => {
  stopPreview();
  stopBgm();
  const m = bgmMode();
  $('bgmFileRow').hidden = m !== 'file';
  $('bgmHint').textContent = hintFor(m);
  invalidateResult();
  if (m === 'file') {
    if (!state.bgmFile) bgmInput.click();
    else void playSample();
  } else if (m !== 'none') {
    void playSample();
  }
});
bgmInput.addEventListener('change', () => {
  const f = bgmInput.files?.[0];
  bgmInput.value = '';
  if (!f) return;
  state.bgmFile = f;
  $('bgmName').textContent = f.name;
  invalidateResult();
  void playSample();
});

// One AudioContext for listening in the app (Web Audio volume works on iPhone too).
let audioCtx: AudioContext | null = null;
function getAudioCtx() {
  audioCtx ??= new AudioContext();
  void audioCtx.resume();
  return audioCtx;
}
let playing: AudioBufferSourceNode | null = null;
let playToken = 0;
const musicCache = new Map<string, AudioBuffer>();

async function getMusic(choice: NonNullable<BgmChoice>, seconds: number): Promise<AudioBuffer> {
  const key =
    choice.kind === 'preset'
      ? `${choice.id}:${Math.ceil(seconds)}`
      : choice.kind === 'track'
        ? `track:${choice.id}`
        : `file:${choice.file.name}:${choice.file.size}`;
  let buf = musicCache.get(key);
  if (!buf) {
    if (choice.kind === 'preset') buf = await renderPreset(choice.id, Math.ceil(seconds));
    else buf = await loadBgm(choice, seconds, getAudioCtx());
    if (musicCache.size > 6) musicCache.clear();
    musicCache.set(key, buf);
  }
  return buf;
}

/** Plays `choice` through Web Audio, starting `offset` seconds in. Returns false if superseded. */
async function playMusic(choice: NonNullable<BgmChoice>, seconds: number, offset = 0, maxPlay?: number) {
  const ctx = getAudioCtx(); // created/resumed inside the tap
  const token = ++playToken;
  let buf: AudioBuffer;
  try {
    buf = await getMusic(choice, seconds);
  } catch {
    if (choice.kind === 'file') addError(`音楽ファイル「${choice.file.name}」を読み込めませんでした。MP3またはM4Aのファイルを選んでください。`);
    if (choice.kind === 'track') addError(`曲「${choice.label}」を読み込めませんでした。通信状況を確かめて、もう一度試してください。`);
    return false;
  }
  if (token !== playToken) return false;
  stopNode();
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = volume('bgmVol');
  node.connect(gain).connect(ctx.destination);
  node.start(ctx.currentTime, offset % buf.duration);
  if (maxPlay) {
    gain.gain.setValueAtTime(volume('bgmVol'), ctx.currentTime + maxPlay - 1);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + maxPlay);
    node.stop(ctx.currentTime + maxPlay);
  }
  playing = node;
  previewGain = gain;
  return true;
}
let previewGain: GainNode | null = null;

function stopNode() {
  try {
    playing?.stop();
  } catch {}
  playing = null;
  previewGain = null;
}
function stopBgm() {
  playToken++;
  stopNode();
  chipsBox.querySelectorAll('.playing').forEach((e) => e.classList.remove('playing'));
}

async function playSample() {
  const choice = bgmChoice();
  if (!choice) return;
  const label = chipsBox.querySelector('input:checked')?.parentElement;
  label?.classList.add('playing');
  const SAMPLE = 12;
  if (await playMusic(choice, SAMPLE, 0, SAMPLE)) {
    const node = playing;
    node?.addEventListener('ended', () => {
      if (playing === node) label?.classList.remove('playing');
    });
  } else label?.classList.remove('playing');
}

// ---------- title / font / volume ----------

$('title').addEventListener('input', invalidateResult);
const fontBox = $('fontChoices');
for (const f of FONTS) {
  const el = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = 'font';
  input.value = f.id;
  input.checked = f.id === DEFAULT_FONT;
  const span = document.createElement('span');
  const sample = document.createElement('b');
  sample.className = 'font-sample';
  sample.textContent = f.label;
  sample.style.fontFamily = fontFamily(f.id);
  sample.style.fontWeight = String(fontWeight(f.id));
  const small = document.createElement('small');
  small.textContent = f.desc;
  span.append(sample, small);
  el.append(input, span);
  fontBox.append(el);
}
const titleFont = (): FontId => (fontBox.querySelector<HTMLInputElement>('input:checked')?.value as FontId) ?? DEFAULT_FONT;
function applyTitleFont() {
  pTitle.style.fontFamily = fontFamily(titleFont());
  pTitle.style.fontWeight = String(fontWeight(titleFont()));
}
setTimeout(() => void loadFontCss(), 300);
fontBox.addEventListener('change', () => {
  invalidateResult();
  applyTitleFont();
});
for (const [id, label] of [
  ['videoVol', 'vvLabel'],
  ['bgmVol', 'bvLabel'],
] as const) {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('input', () => {
    $(label).textContent = `${el.value}%`;
    invalidateResult();
    syncPreviewVolume();
  });
}
const volume = (id: string) => Number($<HTMLInputElement>(id).value) / 100;

// ---------- preview (plays the clips back to back) ----------

const pv = $<HTMLVideoElement>('previewVideo');
const pTitle = $('previewTitle');
const pPhoto = $<HTMLImageElement>('previewPhoto');
let previewIndex = -1;
let previewTimer = 0;
let titleTimer = 0;
let previewStartedAt = 0;

$('previewBtn').addEventListener('click', () => {
  if (!state.clips.length) return;
  stopPreview();
  stopBgm();
  $('previewBox').hidden = false;
  previewStartedAt = performance.now();
  const title = $<HTMLInputElement>('title').value.trim();
  pTitle.textContent = title;
  applyTitleFont();
  pTitle.classList.remove('show');
  // next frames, so the fade-in transition actually runs
  if (title) {
    requestAnimationFrame(() => requestAnimationFrame(() => pTitle.classList.add('show')));
    titleTimer = window.setTimeout(() => pTitle.classList.remove('show'), (TITLE_SECONDS - TITLE_FADE) * 1000);
  }
  syncPreviewVolume();
  playPreviewClip(0);
  const choice = bgmChoice();
  if (choice) {
    const total = state.clips.reduce((s, c) => s + clipLength(c), 0);
    // Music may take a moment to prepare; start it where the video already is.
    void playMusic(choice, total + 1).then((ok) => {
      if (!ok || previewIndex < 0) return stopBgm();
      if (playing && audioCtx) {
        const node = playing;
        const offset = (performance.now() - previewStartedAt) / 1000;
        node.stop();
        const n2 = audioCtx.createBufferSource();
        n2.buffer = node.buffer;
        n2.loop = true;
        n2.connect(previewGain!);
        n2.start(audioCtx.currentTime, offset % (node.buffer?.duration ?? 1));
        playing = n2;
      }
    });
  }
  $('previewBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

function playPreviewClip(i: number) {
  if (i >= state.clips.length) {
    stopPreview(false);
    return;
  }
  previewIndex = i;
  const c = state.clips[i];
  clearTimeout(previewTimer);
  if (c.kind === 'photo') {
    pv.pause();
    pv.hidden = true;
    pPhoto.src = c.objectUrl;
    pPhoto.hidden = false;
    previewTimer = window.setTimeout(() => {
      if (previewIndex !== i) return;
      playPreviewClip(i + 1);
    }, clipLength(c) * 1000);
    return;
  }
  pPhoto.hidden = true;
  pPhoto.removeAttribute('src');
  pv.hidden = false;
  pv.src = c.objectUrl;
  pv.addEventListener(
    'loadedmetadata',
    () => {
      pv.currentTime = c.start;
      void pv.play().catch(() => {});
    },
    { once: true },
  );
}

pv.addEventListener('timeupdate', () => {
  if (previewIndex < 0) return;
  const c = state.clips[previewIndex];
  if (!c || c.kind !== 'video') return;
  if (pv.currentTime >= c.end - 0.03) {
    playPreviewClip(previewIndex + 1);
  }
});
pv.addEventListener('ended', () => {
  if (previewIndex < 0) return;
  const c = state.clips[previewIndex];
  if (c?.kind === 'photo') return;
  playPreviewClip(previewIndex + 1);
});

function syncPreviewVolume() {
  // iPhone ignores volume on <video>; the music volume (Web Audio) does work there.
  pv.volume = volume('videoVol');
  pv.muted = volume('videoVol') === 0;
  if (previewGain) {
    previewGain.gain.cancelScheduledValues(0);
    previewGain.gain.value = volume('bgmVol');
  }
}

function stopPreview(hide = true) {
  const wasPlaying = previewIndex >= 0;
  previewIndex = -1;
  clearTimeout(previewTimer);
  clearTimeout(titleTimer);
  pv.pause();
  pTitle.classList.remove('show');
  if (wasPlaying) stopBgm();
  if (hide) {
    pv.removeAttribute('src');
    pv.load();
    pv.hidden = false;
    pPhoto.hidden = true;
    pPhoto.removeAttribute('src');
    $('previewBox').hidden = true;
  }
}
$('previewStop').addEventListener('click', () => stopPreview());

// ---------- 3. export & save ----------

$('exportBtn').addEventListener('click', async () => {
  if (state.exporting || !state.clips.length) return;
  stopPreview();
  stopBgm();
  invalidateResult();
  const ctrl = new AbortController();
  state.exporting = ctrl;
  render();
  $('progressBox').hidden = false;
  $('errors').innerHTML = '';
  const label = $('progressLabel');
  const bar = $<HTMLProgressElement>('progress');
  const lock = await requestWakeLock();
  try {
    const result = await exportVlog({
      clips: [...state.clips],
      orientation: orientation(),
      title: $<HTMLInputElement>('title').value,
      titleFont: titleFont(),
      bgm: bgmChoice(),
      videoVolume: volume('videoVol'),
      bgmVolume: volume('bgmVol'),
      signal: ctrl.signal,
      onProgress: (f, l) => {
        bar.value = f;
        label.textContent = `${l}　${Math.floor(f * 100)}%`;
      },
    });
    showResult(result);
  } catch (err) {
    if (isCancelled(err)) {
      showSaveError('やめました。編集の内容はそのまま残っています。');
    } else if (err instanceof UserFacingError) {
      showSaveError(err.message);
    } else {
      console.error(err);
      showSaveError(
        '動画を作る途中で止まってしまいました。編集の内容は残っています。もう一度試すか、動画を短くしてみてください。' +
          (err instanceof Error && err.message ? `（${err.message}）` : ''),
      );
    }
  } finally {
    await lock?.release().catch(() => {});
    state.exporting = null;
    $('progressBox').hidden = true;
    render();
  }
});

$('cancelBtn').addEventListener('click', () => state.exporting?.abort());

function showSaveError(msg: string) {
  addError(msg);
  $('errors').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function fileName(ext: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `vlog-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${ext}`;
}

function showResult(r: ExportResult) {
  const url = URL.createObjectURL(r.blob);
  state.result = { ...r, url };
  const name = fileName(r.extension);
  $<HTMLVideoElement>('resultVideo').src = url;
  const a = $<HTMLAnchorElement>('downloadLink');
  a.href = url;
  a.download = name;
  const file = new File([r.blob], name, { type: r.mimeType });
  const share = $<HTMLButtonElement>('shareBtn');
  share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  share.onclick = () => {
    navigator.share({ files: [file] }).catch((e: unknown) => {
      if (e instanceof Error && e.name !== 'AbortError') addError('共有メニューを開けませんでした。「ファイルとして保存」を使ってください。');
    });
  };
  const mb = (r.blob.size / 1024 / 1024).toFixed(1);
  const fmt = r.extension === '.mp4' ? 'MP4' : 'WebM（このブラウザではMP4を作れなかったため）';
  const shape = r.height > r.width ? '縦長' : '横長';
  $('resultInfo').textContent = `${shape}・${r.seconds.toFixed(1)}秒・${mb}MB・${fmt}`;
  $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function invalidateResult() {
  if (!state.result) return;
  URL.revokeObjectURL(state.result.url);
  state.result = null;
  const v = $<HTMLVideoElement>('resultVideo');
  v.removeAttribute('src');
  v.load();
  $('result').hidden = true;
}

async function requestWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

window.addEventListener('beforeunload', (e) => {
  if (state.exporting) e.preventDefault();
});

declare const __BUILD__: string;
$('ver').textContent = __BUILD__;

// ---------- support check on load ----------

planFormat().catch((err) => {
  const box = $('support');
  box.hidden = false;
  box.textContent = err instanceof UserFacingError ? err.message : 'このブラウザでは動画を書き出せない可能性があります。';
});

// Exposed for automated tests only.
(window as unknown as { __vlog: unknown }).__vlog = { state, renderPreset, drawTitle, ensureFont };
