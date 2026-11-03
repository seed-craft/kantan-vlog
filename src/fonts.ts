// Title fonts. Bundled with the app (Fontsource, SIL OFL), split by character range,
// so only the characters actually used are downloaded and the output looks the same on every phone.
// The @font-face rules are large (long character-range lists), so they load after first paint.
let cssLoaded: Promise<unknown> | null = null;
export function loadFontCss() {
  cssLoaded ??= Promise.all([
    import('@fontsource/noto-sans-jp/800.css'),
    import('@fontsource/shippori-mincho/800.css'),
    import('@fontsource/zen-maru-gothic/700.css'),
    import('@fontsource/pacifico/400.css'),
  ]).catch(() => {});
  return cssLoaded;
}

export type FontId = 'maru' | 'gothic' | 'mincho' | 'script';

type FontDef = { id: FontId; label: string; desc: string; faces: { family: string; weight: number }[] };

export const FONTS: FontDef[] = [
  { id: 'maru', label: 'まるゴシック', desc: 'おすすめ・やさしい', faces: [{ family: 'Zen Maru Gothic', weight: 700 }] },
  { id: 'gothic', label: 'ゴシック', desc: 'くっきり', faces: [{ family: 'Noto Sans JP', weight: 800 }] },
  { id: 'mincho', label: '明朝', desc: '上品・しっとり', faces: [{ family: 'Shippori Mincho', weight: 800 }] },
  {
    id: 'script',
    label: 'Holiday',
    desc: '英語向けの筆記体',
    // Japanese characters fall back to the rounded gothic.
    faces: [
      { family: 'Pacifico', weight: 400 },
      { family: 'Zen Maru Gothic', weight: 700 },
    ],
  },
];

export const DEFAULT_FONT: FontId = 'maru';

const def = (id: FontId) => FONTS.find((f) => f.id === id) ?? FONTS[0];

/** CSS font-family list for the font. */
export function fontFamily(id: FontId) {
  return def(id)
    .faces.map((f) => `"${f.family}"`)
    .concat('sans-serif')
    .join(', ');
}

export function fontWeight(id: FontId) {
  return def(id).faces[0].weight;
}

/** Canvas font shorthand. */
export function canvasFont(id: FontId, size: number) {
  return `${fontWeight(id)} ${size}px ${fontFamily(id)}`;
}

/** Makes sure the glyphs for `text` are downloaded before drawing on a canvas. */
export async function ensureFont(id: FontId, text: string) {
  await loadFontCss();
  if (!('fonts' in document)) return;
  await Promise.all(
    def(id).faces.map((f) => document.fonts.load(`${f.weight} 48px "${f.family}"`, text || 'あA').catch(() => [])),
  );
}
