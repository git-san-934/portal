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
- `news/` — 掲載アプリの1つ「持ち株の新着情報」の本体(このリポジトリ内に同梱)。持ち株の公式サイトのニュースと EDINET(米国株は SEC)の提出書類を GitHub Actions が毎日 1:00・5:41・6:41・7:41・8:23・12:45・15:45 に集めます。詳細は `news/README.md` を参照。
- `boj-stats/` — 掲載アプリの1つ「日銀統計の新着」の本体(このリポジトリ内に同梱)。日本銀行の統計APIと財務省・総務省統計局・e-Stat のデータを GitHub Actions が平日 10:15・18:30 に取得し、新しい公表と大きな変化を一覧にします。詳細は `boj-stats/README.md` を参照。
- `scandal-watch/` — 掲載アプリの1つ「不祥事株のその後」の本体(このリポジトリ内に同梱)。不祥事の一覧は `scandal-watch/data/cases.json`、その後の株価は GitHub Actions が平日に自動で計算します。詳細は `scandal-watch/README.md` を参照。
- `nikkei43/` — 掲載アプリの1つ「日経4.3ブル 暴落買いナビ」の本体(このリポジトリ内に同梱)。SBI日本株4.3ブルの基準価額を GitHub Actions が平日の夜と翌朝に自動取得します。詳細は `nikkei43/README.md` を参照。
- `float-screen/` — 掲載アプリの1つ「浮動株の少ない銘柄」の本体(このリポジトリ内に同梱)。データ(`float-screen/data/screen.json`)は stock-yukasyouken-jigyou リポジトリの有価証券報告書データから作っています。
- `ad-watch/` — 掲載アプリの1つ「広告費ウォッチ」の本体(このリポジトリ内に同梱)。広告宣伝費・売上高・営業利益は GitHub Actions が毎日 EDINET の有価証券報告書から自動で集めます。詳細は `ad-watch/README.md` を参照。

## 掲載しているアプリ

| アプリ | リンク先 |
|---|---|
| ユーチューブ要約 | https://git-san-934.github.io/youtube-yoyaku/ |
| 日経4.3ブル 暴落買いナビ | https://git-san-934.github.io/portal/nikkei43/ |
| 持ち株チェック | https://git-san-934.github.io/portal/holdings/ |
| 持ち株の新着情報 | https://git-san-934.github.io/portal/news/ |
| 日銀統計の新着 | https://git-san-934.github.io/portal/boj-stats/ |
| 海外投資家の需給 | https://git-san-934.github.io/portal/foreign-flow/ |
| 日経ヒートマップ | https://git-san-934.github.io/nikkei-heatmap/ |
| 浮動株の少ない銘柄 | https://git-san-934.github.io/portal/float-screen/ |
| 東証株価データベース | https://git-san-934.github.io/tse-price-db/ |
| 東証チャートスクロール | https://git-san-934.github.io/portal/tse-chart-scroll/ |
| 業種別ETFチャート一覧 | https://git-san-934.github.io/portal/sector-etf/ |
| 自社株買情報 | https://git-san-934.github.io/ir-watch-app/ |
| コエカレ | https://git-san-934.github.io/koekare/ |
| 外食履歴 | https://git-san-934.github.io/claude-code-book-template/ |

新しいアプリを増やすときは、`index.html` の `<main class="apps">` の中に
`<a class="app-card">` のかたまりをもう1つコピーして、リンク先・アイコン・
名前・説明を書き換えます。

## データの扱い

このページ自体にはデータを保存しません。各アプリの記録は、それぞれのアプリを
開いた端末のブラウザの中だけに保存されます。
