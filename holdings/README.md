# holdings(持ち株チェック)

持ち株を「保有継続・売却・買い増し」のどれにするか、リスクとリターンで毎日チェックした結果を、
1年チャートと一緒に見るページです。サーバーは持たない静的サイトです。

## 公開URL

https://git-san-934.github.io/portal/holdings/

## 表示している内容

- まとめ: その日のチェックの結論、相場全体のメモ、判定基準
- 今日の判定(スコア順): 銘柄・期待リターン・リスク・R/Rスコア・判定(買い増し / 保有継続 / 売却検討(一部))
- 銘柄ごとのカード: 終値・前日比・年初来高値比・1年騰落率、期待リターン・リスク・スコア、1年チャート、判定の理由、材料メモ
  - チャートの赤い点線は下値目途(割ったら保有理由を点検するライン)。下に現在値からの距離を表示
  - チャートに触れると、その日の終値と現在までの騰落率を表示
  - 日本株のチャートの紫の点線は信用買いの平均買値(買残の金額 ÷ 買残の株数)。下に現在値との差・信用買い残・信用倍率を表示
- 次に注目すること

## データについて

- `data/check.json` — その日のチェック結果(判定・期待リターン・リスク・スコア・材料メモ・下値目途)。チェックのたびに上書きします。
  過去のチェックは git の履歴に残ります
  - `tone` は判定バッジの色: `hold`(保有継続) / `add`(買い増し) / `trim`(売却検討(一部)) / `sell`(売却)
  - `lines` は下値目途などのライン。`price` を入れるとチャートに点線で描きます
- `data/prices.json` — 自動生成される1年分の日次終値(手で編集しない)。取引時間中の更新では、当日分は途中の株価(Yahoo の約20分遅れ)で、カードには「株価(取得時刻)」と表示します
  - `.github/workflows/update-holdings.yml` が平日 9:30・10:30・11:45・13:00・14:00・15:00・16:00・17:00(JST)頃に `scripts/fetch_prices.py` を実行し、
    `holdings.json` に載っている銘柄の終値を Yahoo Finance(yfinance 経由)から取得してコミットし、GitHub Pages を再デプロイします
  - 手動で更新したいときは、GitHub の Actions タブ →「持ち株データ更新」→「Run workflow」
  - 取得に失敗した銘柄があるときは `prices.json` を上書きしません。`prices.json` がないときは、
    チャートなしで `check.json` の数値だけを表示します
- `data/holdings.json` — 銘柄リスト(コード・銘柄名、米国株などは `ticker` と `currency`)。株価の取得対象とページに出す銘柄はこのリストで決まります
  - ページの「銘柄リストの編集」で追加・修正・削除して「保存」を押すと、新しいリスト入りの Issue を作る GitHub の画面が開きます。
    リポジトリ所有者がその Issue を作ると `.github/workflows/apply-holdings-list.yml` が `scripts/apply_list.py` で
    形式を確かめてから `holdings.json` を書き換え、株価の取得と再デプロイを起動して Issue を閉じます(ページは GitHub のキーを持ちません)
  - ページ上部の「株価を今すぐ更新」を押すと、更新依頼の Issue を作る GitHub の画面が開きます。
    リポジトリ所有者がその Issue を作ると `.github/workflows/request-holdings-update.yml` が株価の取得(`update-holdings.yml`)を起動して
    Issue を閉じます(取得後の再デプロイは `update-holdings.yml` が行います)
  - リストにあって `check.json` にない銘柄は「未判定」として表示し、`check.json` にあってリストにない銘柄は表示しません
  - 新しく追加した銘柄の株価が1日分も取れないとき(コードの打ち間違いなど)は、その銘柄だけ外して `prices.json` の `missing` に書きます
  - 米国株などは `"ticker"`(yfinance のティッカー、例: `"ORCL"`)と `"currency"`(例: `"USD"`)を持ちます。
    株価・下値目途(`lines`)はその通貨建て。円以外の銘柄があると `prices.json` の `fx`(例: `USDJPY`)に直近の為替レートが入ります
- `data/margin.json` — 日本株の信用取引残高(自動生成。手で編集しない)。東証が 2026-09-28 から毎営業日公表している
  「銘柄別信用取引残高」(https://www.jpx.co.jp/markets/statistics-equities/margin/01.html 、翌営業日16時ごろ、PDF)から、
  持ち株の買残・売残の株数と金額を取り出して日付ごとにためます。金額は建てたときの代金の合計なので、金額 ÷ 株数が平均の買値です
  - `.github/workflows/update-holdings-margin.yml` が平日 17:15・19:15(JST)頃に `scripts/fetch_margin.py` を実行してコミットし、再デプロイします
  - PDF の読み取りでは、合計 = 一般信用 + 制度信用 になっているかを確かめ、合わない行は捨てます。読めないときは上書きしません
  - `margin.json` がないときや、その銘柄の残高がないときは、チャートに線を出しません
- 保有状況(取得単価・株数)はページで入力し、閲覧しているブラウザの localStorage にだけ保存します(リポジトリには載りません)。
  外国株の取得単価はその通貨で入力し、評価額と損益は今の為替レートで円換算して、保有比率と保有全体の計算に使います
- **投資助言ではありません。** 判定は材料整理であり、売買判断はご自身の責任で行ってください

## ファイル構成

- `index.html` — ページ本体
- `assets/style.css` — スタイル(portal / sector-etf と同じデザイントークン)
- `assets/app.js` — データ読み込み・騰落率計算・チャート描画
- `scripts/fetch_prices.py` — yfinance から終値を取得して `data/prices.json` を作るスクリプト
- `scripts/fetch_margin.py` — JPX の銘柄別信用取引残高(PDF)から持ち株の信用残を取り出して `data/margin.json` を作るスクリプト
- `scripts/apply_list.py` — ページから作られた Issue の銘柄リストを確かめて `data/holdings.json` に書くスクリプト
