# 日銀統計の蓄積と変化検知

日本銀行「時系列統計データ検索サイト」のAPI（2026年2月公開, https://www.stat-search.boj.or.jp/info/api_manual.pdf）から統計を取り、
このフォルダに蓄積して、急変・トレンド転換・1年高値/安値更新を検知する。標準ライブラリのPythonのみで動く。

| ファイル | 役割 |
|---|---|
| series.json | 取得する系列の一覧（DB・系列コード・頻度・種類）。ここに追記すれば対象が増える |
| fetch.py | APIから取得して data/<DB>_<CODE>.csv に追記・改定反映。`python3 fetch.py discover FM08 D` で日次系列の候補一覧 |
| analyze.py | 変化検知。reports/YYYY-MM-DD.md, reports/latest.json, reports/signals_log.csv（検知履歴） |
| status.py | 取り込みの成功・失敗を系列ごとに記録。reports/status.json（系列ごとの状態）, reports/fetch_history.csv（実行ごとの記録） |
| fetch_boj_news.py | 日本銀行ホームページ「新着情報（総合）」のRSSを reports/boj_news.csv に蓄積（RSSは約1か月分なので毎回足していく）。為替相場のお知らせは除く。ページの新着に「日銀」として載る |
| run_daily.sh | 取得→取り込み状況の記録→分析をまとめて実行（日次ルーチン用） |
| raw/ | APIの生レスポンス（日付ごと） |

## 現在の対象
- 日次: 無担保コールO/N物レート・出来高（FM01）、ドル円17時・ユーロドル（FM08）、基準貸付利率（IR01）
- 月次: マネタリーベース・日銀当座預金（MD01）、当座預金増減要因と金融調節（MD06）

## 追加の対象（2026-09-28）
- 国債利回り 2年・10年・30年（財務省CSV、fetch_mof.py）
- 物価: 企業物価（PR01）、企業向けサービス価格（PR02）
- 金融: マネーストック（MD02）、銀行貸出（MD13）、貸出約定平均金利（IR04）、コール残高（FM04）
- 四半期: 主要銀行貸出動向アンケート（LA05）、短観（CO）、資金循環の家計（FF）。日付は 2026Q2 形式
- 新着情報との対応は reports/whatsnew_coverage.md

## 追加の対象（2026-09-30）
- 財務省 貿易統計（通関ベース、月次原数値）: 輸出額・輸入額・差引（億円）と輸出入の前年同月比。
  e-Stat の「貿易概況 州別輸出入時系列表」CSV から fetch_estat.py の trade() で取る。2007-12〜
- 2026-10-01: 貿易統計を細分化。地域(国)別（米国・中国・EU・ASEAN・台湾の輸出入）と、品別国別表（HS 9桁×国）から台湾向けの
  NAND（854232921）・DRAM（854232911）・未組立メモリ（854232100）・MLCC（853224）・集積回路計（8542）・半導体製造装置（8486）。
  品目・国を足すときは series.json に "trade" 付きの系列を1件足す（書き方は fetch_estat.py の trade() を参照）。
- 2026-10-01: 半導体関連の国別推移。series.json の trade_by_country（品目ごとの HS 接頭辞）について、品別国別表から全輸出先の月次輸出額を
  data/trade_by_country.json に蓄積（2016年〜、億円）。portal の boj-stats/trade.html が国別の輸出額・前年同月比を表示する。
- 2026-10-01: 同じ JSON に数量（qty、単位 qty_unit。千個は個に換算）を追加。品目の HS コードの単位が揃うときだけ入れ、
  揃わない品目（集積回路計）は qty_unit が null。数量の無い古い JSON なら2016年から取り直す。trade.html で数量と単価（金額÷数量）も表示する。

- 2026-10-01: 国別の輸出系列ページ（米国・中国・台湾）に主な品目の内訳。国別概況品別表から series.json の trade_goods_countries の国について
  主な品目（fetch_estat.py GOODS_JA、概況品コード）の月次輸出額を data/trade_goods_by_country.json に蓄積。ページ側は assets/goods.js。
日次の当座預金残高速報やオペ結果は日銀本体サイト（www.boj.or.jp）の個別ページ公表で、APIには月次しか無いため未対応。
長期金利（財務省の国債金利CSV）や株価は日銀統計外なので、必要なら別ソースとして追加する。

## 取り込みの成功・失敗
- 取得元（日銀API・財務省・統計局・e-Stat の各統計）ごとに独立して動き、1つが失敗しても残りは取り込む。
  一時的な接続エラーは日銀APIと e-Stat で自動で取り直す
- 失敗は last_fetch.json の errors に「DB: 内容」「DB/系列コード: 内容」「ESTAT 統計名: 内容」の形で残る。スクリプトが想定外のエラーで落ちても「DB: 想定外のエラー …」として残る
- status.py が系列ごとに状態を判定して reports/status.json に書く: new（新しい値あり）/ unchanged（公表待ち）/ error（今回失敗）/
  stale（新しい値が日次8日・月次50日・四半期110日を超えて入っていない。取得元の形式変更などで黙って止まっている疑い）。
  最後に成功した日（last_ok）、連続失敗回数（fail_streak）、最後に新しい値が入った日（last_new）も持つ
- reports/fetch_history.csv に実行ごとの件数とエラーを1行ずつ追記する
- error か stale があれば run_daily.sh は終了コード 1。共有フォルダの日次ルーチンはその日にスレッドで知らせ、
  portal の GitHub Actions はジョブを失敗にせず（メールは送らない）、注釈と実行の要約に残す。
  portal のページにも「前回の取得」として失敗した系列が出る。ページの「今すぐ更新」から GitHub の Run workflow で手動実行もできる

## 検知ルール
- 急変: 前回比が過去の変化の標準偏差の2.5倍超。金利系は0.05%pt以上の動きも急変扱い
- トレンド転換: 短期/長期移動平均のクロス（日次20/60、月次3/12）
- 1年高値/安値更新
資産クラスとの関係（analyze.py の IMPLICATIONS）は一般的な傾向の整理で、売買推奨ではない。
