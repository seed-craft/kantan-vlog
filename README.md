# かんたんVlog

スマホで撮った数本の動画を「選ぶ → 並べる・切る → 保存する」だけで、1本の思い出動画にするWebアプリ（試作版）。

**使う：** https://seed-craft.github.io/kantan-vlog/

- 動画・音声は端末の中だけで処理し、どこにも送りません（ログイン・解析・広告なし）
- 縦長（スマホ・SNS向け、標準）と横長（テレビ・YouTube向け）を選べます
- 冒頭タイトル、BGM（内蔵8曲または自分の音楽ファイル）、音量調整
- ホーム画面に追加すると、アプリのように開けます

## 対応環境

- iPhone：Safari（iOS 16.4以降）
- Android：Chrome（最新版）
- 試作版のため、端末や動画の形式によっては動かないことがあります
  - iPhoneの「高効率（HEVC）」で撮った動画が読めない場合は、「設定 → カメラ → フォーマット → 互換性優先」で撮った動画を使ってください
- 合計3分・10本まで

## 内蔵BGMについて

内蔵の8曲は Google Gemini（Lyria 3）で生成した曲（AI生成）です。このアプリで作った動画のBGMとして使えます。

## 開発

```bash
npm install
npm run dev        # 開発サーバー（WebCodecsは HTTPS か localhost でのみ動作）
npm run build      # dist/ に静的ファイルを出力
npm run test:e2e   # build後に実行。Chromium（Playwright）で実際に書き出して中身を検査（ffmpeg・Python/numpyが必要）
```

- 動画の読み込み・書き出し：[Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0）＋ブラウザ標準のWebCodecs
- AACを書き出せないブラウザでは `@mediabunny/aac-encoder`（WASM）を自動で読み込みます
- 内蔵曲の追加方法は `public/bgm/README.md`
- `main` に push すると GitHub Actions がビルドして GitHub Pages に公開します
