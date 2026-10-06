# 不動株の少ない銘柄

東証銘柄の不動株割合（大株主・役員・自己株式など動かない株の割合）を、各社の有価証券報告書から計算して一覧にするページ。粗利率・保有現金・配当利回り・自社株買の状況も並べ、見出しを押して並び替えられる。

- `data/screen.json` — 一覧のデータ（全銘柄）
- `data/stock_screen.xlsx` — 同じ内容のExcel（説明シートつき）

## データの作り方

[stock-yukasyouken-jigyou](https://github.com/git-san-934/stock-yukasyouken-jigyou) の `claude/stock-screen` ブランチで作る。

1. `screen/run.json` を `{"all": true, "prices": true, "jpx": true}` にしてプッシュすると、GitHub Actions（`screen.yml`）が EDINET から有報の数値、Yahoo Finance から株価、JPX から市場区分を取ってコミットする
2. `python scripts/build_screen.py` で `screen/metrics.csv` を作る
3. `python scripts/make_screen_json.py screen/metrics.csv screen/jpx_list.csv <このフォルダ>/data/screen.json <日付>` と `make_screen_xlsx.py` で一覧データとExcelを書き出し、ここにコピーする
