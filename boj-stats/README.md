# 日銀統計の新着

https://git-san-934.github.io/portal/boj-stats/

日本銀行の統計(金利・為替・資金供給・物価・貸出・短観・資金循環・国際収支)と、財務省の国債利回り、総務省統計局・e-Stat の消費者物価・家計調査・雇用などを平日に集め、

- 新しく公表された値(月次・四半期の最新の期が変わったもの)
- 大きな変化(急変・移動平均のクロス・1年高値/安値の更新)

を日付ごとの箇条書きで表示します。各項目から系列ページ(`series.html?id=...`)に移り、チャート・検知の履歴・最近の値・出典を見られます。

## 構成

| パス | 役割 |
|---|---|
| `index.html`, `series.html`, `assets/` | ページ本体 |
| `data/feed.json` | ページが読むデータ(`pipeline/build_site.py` が作る) |
| `pipeline/` | 取得と変化検知(標準ライブラリの Python のみ)。中身は `pipeline/README.md` |
| `pipeline/data/*.csv` | 系列ごとの蓄積データ(系列ページのチャートもここを読む) |
| `pipeline/reports/signals_log.csv` | 検知の履歴 |
| `pipeline/reports/releases_log.csv` | 公表を見つけた日の記録 |

## 更新

`.github/workflows/update-boj-stats.yml` が平日 10:15 と 18:30(日本時間)に
`pipeline/run_daily.sh`(取得→検知)と `pipeline/build_site.py` を実行し、変わったデータをコミットしてページを再デプロイします。
GitHub の Actions 画面から「Run workflow」で手動でも動かせます。

集める系列は `pipeline/series.json` に追記すると増えます。
