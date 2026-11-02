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
- **投資助言ではありません。** 売買の判断はご自身の責任で行ってください

## 12条件

1. 年次の増益 2. 四半期の増益 3. 通期予想に対する進捗 4. PERが割安(10倍以下◎、15倍以下○) 5. PEG < 1(PER ÷ 今期予想EPS成長率)
6. 200日線との位置(本のとおり下を◎、上を△) 7. 5日×25日のGC 8. 5日と25日の乖離 5%以内 9. 上ヒゲの短い陽線
10. 出来高の増加 11. すぐ上に抵抗線がない 12. RSI(14) ≦ 75
