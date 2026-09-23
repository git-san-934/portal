# holdings(持ち株チェック)

持ち株を「保有継続・売却・買い増し」の観点で毎日チェックした結果を、1年チャートと
一緒に見るページです。サーバーは持たない静的サイトです。

## 公開URL

https://git-san-934.github.io/portal/holdings/

## 表示している内容

- まとめ: その日のチェックの結論と相場全体のメモ
- 一覧: 銘柄・終値・前日比・目安(保有継続 / 押し目買い候補 など)
- 銘柄ごとのカード: 終値・前日比・年初来高値比・1年騰落率、1年チャート、目安、材料メモ
  - チャートの赤い点線は、チェックで決めた見直しライン(例: 年初来安値)。下に現在値からの距離を表示
  - チャートに触れると、その日の終値と現在までの騰落率を表示
- 次に注目すること

## データについて

- `data/check.json` — その日のチェック結果(目安・材料メモ・見直しライン)。チェックのたびに上書きします。
  過去のチェックは git の履歴に残ります
  - `tone` は目安バッジの色: `hold`(保有継続) / `add`(買い増し寄り) / `trim`(一部利確寄り) / `sell`(売却)
  - `lines` は見直しライン。`price` を入れるとチャートに点線で描きます
- `data/prices.json` — 自動生成される1年分の日次終値(手で編集しない)
  - `.github/workflows/update-holdings.yml` が平日 17:00(JST)頃に `scripts/fetch_prices.py` を実行し、
    `check.json` に載っている銘柄の終値を Yahoo Finance(yfinance 経由)から取得してコミットし、GitHub Pages を再デプロイします
  - 手動で更新したいときは、GitHub の Actions タブ →「持ち株データ更新」→「Run workflow」
  - 取得に失敗した銘柄があるときは `prices.json` を上書きしません。`prices.json` がないときは、
    チャートなしで `check.json` の数値だけを表示します
- 銘柄を増やす・減らすときは、`data/check.json` の `stocks` を書き換えます(株価の取得対象も自動で変わります)
- **投資助言ではありません。** 「目安」は材料整理であり、売買判断はご自身の責任で行ってください

## ファイル構成

- `index.html` — ページ本体
- `assets/style.css` — スタイル(portal / sector-etf と同じデザイントークン)
- `assets/app.js` — データ読み込み・騰落率計算・チャート描画
- `scripts/fetch_prices.py` — yfinance から終値を取得して `data/prices.json` を作るスクリプト
