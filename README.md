# portal

声で使えるアプリの入口ページ（まとめページ）。

## 公開URL

GitHub Pages を有効にすると、次のURLで見られます:

https://git-san-934.github.io/portal/

## 中身

- `index.html` — 入口ページ本体。1ファイルだけで動きます。

## 掲載しているアプリ

| アプリ | リンク先 |
|---|---|
| ユーチューブ要約 | https://git-san-934.github.io/youtube-yoyaku/ |
| 日経ヒートマップ | https://git-san-934.github.io/nikkei-heatmap/ |
| IR Watch | https://git-san-934.github.io/ir-watch-app/ |
| コエカレ | https://git-san-934.github.io/koekare/ |
| 外食履歴 | https://git-san-934.github.io/claude-code-book-template/ |

新しいアプリを増やすときは、`index.html` の `<main class="apps">` の中に
`<a class="app-card">` のかたまりをもう1つコピーして、リンク先・アイコン・
名前・説明を書き換えます。

## データの扱い

このページ自体にはデータを保存しません。各アプリの記録は、それぞれのアプリを
開いた端末のブラウザの中だけに保存されます。
