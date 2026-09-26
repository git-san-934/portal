# portal

声で使えるアプリの入口ページ（まとめページ）。

## 公開URL

GitHub Pages を有効にすると、次のURLで見られます:

https://git-san-934.github.io/portal/

## 中身

- `index.html` — 入口ページ本体。1ファイルだけで動きます。
- `tse-chart-scroll/` — 掲載アプリの1つ「東証チャートスクロール」の本体(このリポジトリ内に同梱)。詳細は `tse-chart-scroll/README.md` を参照。
- `sector-etf/` — 掲載アプリの1つ「業種別ETFチャート一覧」の本体(このリポジトリ内に同梱)。株価データは GitHub Actions が平日に自動更新します。詳細は `sector-etf/README.md` を参照。
- `foreign-flow/` — 掲載アプリの1つ「海外投資家の需給」の本体(このリポジトリ内に同梱)。空売り残高・投資部門別売買状況・株価を GitHub Actions が平日に自動取得します。詳細は `foreign-flow/README.md` を参照。
- `holdings/` — 掲載アプリの1つ「持ち株チェック」の本体(このリポジトリ内に同梱)。毎日のチェック結果は `holdings/data/check.json`、株価データは GitHub Actions が平日に自動更新します。詳細は `holdings/README.md` を参照。
- `ath-breakout/` — 掲載アプリの1つ「過去最高値ブレイクのその後」の本体(このリポジトリ内に同梱)。株価データの取得とブレイクの判定は GitHub Actions が平日に自動で行います。詳細は `ath-breakout/README.md` を参照。
- `scandal-watch/` — 掲載アプリの1つ「不祥事株のその後」の本体(このリポジトリ内に同梱)。不祥事の一覧は `scandal-watch/data/cases.json`、その後の株価は GitHub Actions が平日に自動で計算します。詳細は `scandal-watch/README.md` を参照。

## 掲載しているアプリ

| アプリ | リンク先 |
|---|---|
| ユーチューブ要約 | https://git-san-934.github.io/youtube-yoyaku/ |
| 持ち株チェック | https://git-san-934.github.io/portal/holdings/ |
| 海外投資家の需給 | https://git-san-934.github.io/portal/foreign-flow/ |
| 過去最高値ブレイクのその後 | https://git-san-934.github.io/portal/ath-breakout/ |
| 不祥事株のその後 | https://git-san-934.github.io/portal/scandal-watch/ |
| 日経ヒートマップ | https://git-san-934.github.io/nikkei-heatmap/ |
| 東証株価データベース | https://git-san-934.github.io/tse-price-db/ |
| 東証チャートスクロール | https://git-san-934.github.io/portal/tse-chart-scroll/ |
| 業種別ETFチャート一覧 | https://git-san-934.github.io/portal/sector-etf/ |
| 親子上場ウォッチリスト | https://git-san-934.github.io/tse-price-db/oyako.html |
| 自社株買情報 | https://git-san-934.github.io/ir-watch-app/ |
| Yukashoken Watch | https://git-san-934.github.io/yukashoken-watch/ |
| シクリカルバリュー・スクリーナー | https://git-san-934.github.io/stock-tachan-1/ |
| コエカレ | https://git-san-934.github.io/koekare/ |
| 外食履歴 | https://git-san-934.github.io/claude-code-book-template/ |

新しいアプリを増やすときは、`index.html` の `<main class="apps">` の中に
`<a class="app-card">` のかたまりをもう1つコピーして、リンク先・アイコン・
名前・説明を書き換えます。

## データの扱い

このページ自体にはデータを保存しません。各アプリの記録は、それぞれのアプリを
開いた端末のブラウザの中だけに保存されます。
