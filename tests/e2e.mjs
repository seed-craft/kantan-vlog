// End-to-end check in desktop Chromium (Playwright): drives the real UI, exports,
// then inspects the output file with ffprobe/ffmpeg via tests/analyze.py.
// Usage: npm run build && npm run test:e2e
// This proves the pipeline in Chromium only; it does NOT prove iPhone Safari / Android Chrome.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fx = (n) => path.join(here, 'fixtures', n);
const outDir = path.join(here, 'output');
mkdirSync(outDir, { recursive: true });

const PORT = 4179;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: root, stdio: 'ignore' });
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function exportAndDownload(page, name) {
  await page.click('#exportBtn');
  await page.waitForSelector('#result:not([hidden])', { timeout: 120_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadLink')]);
  const file = path.join(outDir, name);
  await download.saveAs(file);
  return file;
}

function analyze(file, spec) {
  const out = execFileSync('python3', [path.join(here, 'analyze.py'), file, JSON.stringify(spec)], { encoding: 'utf8' });
  return JSON.parse(out);
}

try {
  await waitForServer();
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/`);

  // 1. pick (incl. a broken file)
  await page.setInputFiles('#pick', [fx('a_landscape.mp4'), fx('b_portrait.mp4'), fx('c_noaudio.mp4'), fx('broken.mp4')]);
  await page.waitForFunction(() => document.getElementById('loading').hidden);
  ok((await page.locator('#clips li').count()) === 3, '3 valid clips loaded');
  ok((await page.locator('#errors li').count()) === 1, 'broken file reported to the user');
  ok((await page.locator('#clips li').nth(2).innerText()).includes('音なし'), 'clip without audio is labelled');

  // bundled songs (public/bgm/tracks.json): all listed and all decodable
  const tracks = await (await fetch(`http://localhost:${PORT}/bgm/tracks.json`)).json();
  await page.waitForFunction((n) => document.querySelectorAll('#bgmChoices label').length === n + 2, tracks.length);
  ok(true, `${tracks.length} bundled songs listed with なし and 自分の曲`);
  const decoded = await page.evaluate(async (list) => {
    const ctx = new OfflineAudioContext(2, 1, 44100);
    const out = [];
    for (const t of list) {
      const buf = await ctx.decodeAudioData(await (await fetch(`./bgm/${t.file}`)).arrayBuffer());
      out.push(`${t.label}:${buf.duration.toFixed(0)}s`);
    }
    return out;
  }, tracks);
  console.log('      ', decoded.join(' '));
  ok(decoded.length === tracks.length, 'every bundled song decodes in the browser');
  await page.screenshot({ path: path.join(outDir, 'screen-list.png'), fullPage: true });

  // 2. trim clip 1 (a_landscape) to 1.0–3.0s via the sheet
  await page.locator('#clips li').nth(0).locator('[data-action=trim]').click();
  await page.waitForSelector('#trimDialog[open]');
  await page.$eval('#trimStart', (el) => { el.value = '1'; el.dispatchEvent(new Event('input')); });
  await page.$eval('#trimEnd', (el) => { el.value = '3'; el.dispatchEvent(new Event('input')); });
  await page.screenshot({ path: path.join(outDir, 'screen-trim.png') });
  await page.click('#trimOk');
  ok((await page.locator('#clips li').nth(0).innerText()).includes('2.0秒'), 'trim applied (2.0s)');

  // move portrait clip up -> order: b(4s, 880Hz) a(2s, 440Hz) c(3s, silent)
  await page.locator('#clips li').nth(1).locator('[data-action=up]').click();
  ok((await page.locator('#clips li').nth(0).innerText()).includes('b_portrait'), 'reorder with button');
  ok((await page.locator('#total').innerText()).includes('9.0'), 'total length 9.0s');

  // preview starts without errors
  await page.click('#previewBtn');
  await page.waitForTimeout(800);
  ok(!(await page.locator('#previewBox').isHidden()), 'preview shown');
  await page.click('#previewStop');

  // title
  await page.fill('#title', 'テストの思い出');

  // cancel mid-export keeps the edit
  await page.click('#exportBtn');
  await page.waitForFunction(() => Number(document.getElementById('progress').value) > 0.15, null, { timeout: 60_000 });
  await page.click('#cancelBtn');
  await page.waitForFunction(() => document.getElementById('progressBox').hidden);
  ok((await page.locator('#errors').innerText()).includes('やめました'), 'cancel reported');
  ok((await page.locator('#clips li').count()) === 3, 'edit kept after cancel');

  // 3. export #1: default = portrait, title, no music
  const t0 = Date.now();
  const f1 = await exportAndDownload(page, 'out-1.mp4');
  console.log(`      export took ${((Date.now() - t0) / 1000).toFixed(1)}s; info: ${await page.locator('#resultInfo').innerText()}`);
  await page.screenshot({ path: path.join(outDir, 'screen-result.png'), fullPage: true });
  const titleBand = [60, 570, 660, 710]; // vertical center of 720x1280
  const a1 = analyze(f1, {
    segments: [
      [0.5, 3.5, 880],
      [4.3, 5.7, 440],
      [6.3, 8.7, 0],
    ],
    frames: [
      { t: 1.0, regions: { top: [100, 40, 620, 200] }, title_band: titleBand, save: path.join(outDir, 'f1-title.npy') },
      { t: 4.8, regions: { top: [100, 40, 620, 300], center: [200, 500, 520, 780] } },
    ],
  });
  console.log('      ', JSON.stringify(a1));
  ok(a1.video_codec === 'h264' && a1.audio_codec === 'aac', 'MP4 with H.264 + AAC');
  ok(a1.width === 720 && a1.height === 1280, 'default output is portrait 720x1280');
  ok(Math.abs(a1.duration - 9) < 0.15, 'duration ≈ 9s');
  ok(a1.decode_ok, 'whole file decodes without errors');
  ok(a1.segments.every((s) => s.pass), 'audio order/cuts: 880Hz → 440Hz → silence');
  ok(a1.frames[0].top > 20, 'portrait clip fills the portrait frame');
  ok(a1.frames[1].top > 15 && a1.frames[1].center > 20, 'landscape clip in portrait: whole picture + blurred background (no black bars)');

  // export #2: portrait, no title, own music file, original sound off
  await page.fill('#title', '');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#bgmChoices span', { hasText: '自分の曲' }).click()]);
  await chooser.setFiles(fx('bgm.mp3'));
  await page.$eval('#videoVol', (el) => { el.value = '0'; el.dispatchEvent(new Event('input')); });
  await page.$eval('#bgmVol', (el) => { el.value = '80'; el.dispatchEvent(new Event('input')); });
  const f2 = await exportAndDownload(page, 'out-2.mp4');
  const a2 = analyze(f2, { segments: [[1, 3.5, 330], [4.3, 5.7, 330], [6.3, 7.5, 330]], frames: [{ t: 1.0, title_band: titleBand, save: path.join(outDir, 'f2-notitle.npy') }] });
  console.log('      ', JSON.stringify(a2));
  const titleDiff = Number(
    execFileSync('python3', ['-c', `import numpy as n;a=n.load('${path.join(outDir, 'f1-title.npy')}').astype(int);b=n.load('${path.join(outDir, 'f2-notitle.npy')}').astype(int);d=n.abs(a-b).sum(axis=2)>60;print(d[560:720,40:680].sum(), d[:400].sum())`], { encoding: 'utf8' }).split(' ')[0],
  );
  ok(titleDiff > 1500, `title drawn at the vertical center (${titleDiff} changed px in the center band)`);
  ok(a2.segments.every((s) => s.pass), 'own music file (330Hz) across the video, original sound muted');

  // export #3: landscape, built-in music, original sound back on
  await page.locator('.seg span', { hasText: '横長' }).click();
  await page.locator('#bgmChoices span', { hasText: 'ほのぼの' }).click();
  await page.$eval('#videoVol', (el) => { el.value = '100'; el.dispatchEvent(new Event('input')); });
  await page.$eval('#bgmVol', (el) => { el.value = '40'; el.dispatchEvent(new Event('input')); });
  const t3 = Date.now();
  const f3 = await exportAndDownload(page, 'out-3.mp4');
  console.log(`      export took ${((Date.now() - t3) / 1000).toFixed(1)}s; info: ${await page.locator('#resultInfo').innerText()}`);
  await page.screenshot({ path: path.join(outDir, 'screen-result-landscape.png'), fullPage: true });
  const a3 = analyze(f3, {
    segments: [[0.5, 3.5, 880], [4.3, 5.7, 440]],
    frames: [{ t: 1.0, regions: { side: [20, 100, 200, 620] } }],
  });
  const rms = (t0, t1) => analyze(f3, { segments: [[t0, t1, 0]], frames: [] }).segments[0].rms;
  const musicOnly = rms(6.3, 8.0);
  console.log('      ', JSON.stringify(a3), 'music-only rms', musicOnly);
  ok(a3.width === 1280 && a3.height === 720, 'landscape option gives 1280x720');
  ok(a3.segments.every((s) => s.pass), 'original sound still dominant with music at 40%');
  ok(musicOnly > 0.02, 'built-in music audible where the clip has no sound');
  ok(a3.frames[0].side > 15, 'portrait clip in landscape: blurred background instead of black bars');

  // bundled song: served from bgm/tracks.json (stubbed here with the 330Hz fixture)
  const page2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page2.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page2.route('**/bgm/tracks.json', (r) =>
    r.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 't1', label: 'テスト曲', desc: 'Gemini', file: 'test.mp3', credit: 'テスト用の曲です。' }]) }),
  );
  await page2.route('**/bgm/test.mp3', (r) => r.fulfill({ path: fx('bgm.mp3'), contentType: 'audio/mpeg' }));
  await page2.goto(`http://localhost:${PORT}/`);
  await page2.setInputFiles('#pick', [fx('c_noaudio.mp4')]);
  await page2.waitForSelector('#clips li');
  const chip = page2.locator('#bgmChoices span', { hasText: 'テスト曲' });
  await chip.waitFor();
  ok((await page2.locator('#bgmChoices label').nth(1).innerText()).includes('テスト曲'), 'bundled song listed right after なし');
  await chip.click();
  ok((await page2.locator('#bgmHint').innerText()).includes('テスト用の曲'), 'bundled song credit shown');
  ok((await page2.locator('#bgmChoices span', { hasText: 'ほのぼの' }).count()) === 0, 'synth songs hidden when real songs are bundled');
  await page2.$eval('#bgmVol', (el) => { el.value = '80'; el.dispatchEvent(new Event('input')); });
  const f4 = await exportAndDownload(page2, 'out-4.mp4');
  const a4 = analyze(f4, { segments: [[0.6, 2.2, 330]], frames: [] });
  ok(a4.segments.every((s) => s.pass), 'bundled song (330Hz) in the exported video');

  ok(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
  await browser.close();
} catch (e) {
  console.error(e);
  failures.push(String(e));
} finally {
  server.kill();
}
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
