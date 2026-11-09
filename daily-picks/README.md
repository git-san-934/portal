# daily-picks(今日の3銘柄)

AI株式投資の本の12条件で、火〜土の未明に前日の終値で日本株を3銘柄選んだ記録を、新しい日が上に来るように並べるページです。サーバーは持たない静的サイトです。

## 公開URL

https://git-san-934.github.io/portal/daily-picks/

## データ

- `data/picks.json` — `days` に1日1件。新しい日を配列の先頭に足します(ページは日付の新しい順に並べ直して表示します)
  - 1日分: `date`(選んだ日)、`price_date`(終値の日付)、`summary`、`scope`(どこから絞り込んだか)、`picks`(3銘柄)
  - 1銘柄: `rank`、`code`(4桁などの証券コード)、`name`、`market`、`close`、`headline`、
    `conditions`(12件。`no`・`label`・`value`・`mark` は ◎ / ○ / △ / × / 不明)、`risks`、`sources`(`label`・`url`)
- 銘柄名は Yahoo!ファイナンス(`https://finance.yahoo.co.jp/quote/<code>.T`)にリンクします
- 分析は Claude の定期タスクが火〜土の 3:17(JST、深夜)に前日の終値で行い(土曜は金曜の終値)、`data/picks.json` に足して main に直接コミットします(『今日の3銘柄 (YYYY-MM-DD)』)
- ページの「分析をやり直す」は、タイトル『今日の3銘柄を再分析』の Issue を作る GitHub の画面を開きます。Claude の定期タスクが毎時その Issue を確かめ、あれば最新の終値で分析し直して `picks.json` を更新し、Issue を閉じます
- `results.html`(3銘柄のその後) — 選んだ銘柄が分析日の終値からどう動いたかの一覧。`data/performance.json` を表示します
  - `scripts/build_performance.py` が `picks.json` と株価から集計します。株価は `data/prices.json` に貯めます
  - GitHub Actions(`update-daily-picks-performance.yml`)が平日 16:30・20:00 JST と `picks.json` の更新時に yfinance で株価を取って更新します
  - ローカルでは `--tse-db <tse-price-db のパス>` や `--csv <code,date,open,high,low,close,volume>` で株価を足せます
  - 本のルールでの売買の仮定: 損切りは前20営業日の押し安値の1%下、利確はリスクリワード 1:3、基準より上で高値を付けたあと上昇の起点の安値を終値で割ったら売り
- **投資助言ではありません。** 売買の判断はご自身の責任で行ってください

## 12条件

1. 年次の増益 2. 四半期の増益 3. 通期予想に対する進捗 4. PERが割安(10倍以下◎、15倍以下○) 5. PEG < 1(PER ÷ 今期予想EPS成長率)
6. 200日線との位置(本のとおり下を◎、上を△) 7. 5日×25日のGC 8. 5日と25日の乖離 5%以内 9. 上ヒゲの短い陽線
10. 出来高の増加 11. すぐ上に抵抗線がない 12. RSI(14) ≦ 75
