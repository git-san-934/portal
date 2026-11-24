# e-Stat 新着の分析（日次チェックの手順）

新着ページ（boj-stats/index.html）の e-Stat の行には、取り込み済みの系列がある統計（build_site.py の ESTAT_LINKS）は数値が自動で付く。
それ以外の統計は、平日朝の日次チェック（Claude のルーチン、6:52〜9:52 JST）が公表された表を読んで分析を書き、
`reports/estat_analysis.json` に足してページに載せる（API 料金のかからない定額の範囲で動かすため）。

## 手順（毎回）

1. portal リポジトリ（git-san-934/portal）の main を最新にする（無ければ clone）。
2. `python3 boj-stats/pipeline/estat_pending.py /tmp/estat_pending.md`
   - 直近4日の新着のうち、まだ分析していないものと、その日に公表された表の中身（Excel・CSV は表、PDF は先頭4ページのテキスト）が出る。
   - 0件なら終わり。
3. `/tmp/estat_pending.md` を読み、新着ごとに分析を書く（形式は `estat_save.py` の先頭の説明）。
   - headline: 一番大事な結果を1文（120字まで）。対象期間・水準・前年比/前回比など、表から読んだ数値で書く。
   - points: 補足を3つまで（内訳・累計・前回との違い・注目点）。
   - 表に無い数値は書かない。PDF のテキストは段組みが崩れることがあるので、迷う数値は PDF をダウンロードして確かめる。
   - 表が見つからない（データベースだけの更新など）・名簿や制度の一覧で数値の分析が成り立たない統計は、
     headline に「何が公表されたか」を1文で書き、points は空でよい。
   - about: 「この統計とは」。何を数えていて何が分かるのかを、統計に詳しくない人向けに1〜2文。
   - charts: 分析ページ（estat.html）のグラフを2つまで。表から読んだ数値だけで作る
     （推移が表にあれば line、今回と前回・前年の比較や内訳・地域別なら bar。前年比などマイナスもそのまま）。
     数値の表が無い統計は charts を省く。
   - 投資判断は書かない（資産クラスとの関係は一般的な傾向まで。売買の推奨はしない）。
4. `python3 boj-stats/pipeline/estat_save.py 分析.json`（グラフの形がおかしいと止まるので、直して保存し直す）
5. `boj-stats/pipeline/reports/estat_analysis.json` だけをコミットして main に push（他のファイルは触らない。
   Actions のデータ更新と重なったら `git pull --rebase` してから push）。
6. ページを作り直すため、データ更新を起動する:
   `gh api -X POST repos/git-san-934/portal/actions/workflows/update-boj-stats.yml/dispatches -f ref=main -f 'inputs[scope]=all'`
   （起動できなければ次の定時実行で反映される）

## 表示

- 分析した新着は「要点の1文」を表示し、補足と読んだ表は「詳しく」に折りたたむ。
- 要点の横の「グラフで見る →」（グラフが無ければ「詳しく見る →」）で分析ページ estat.html?key=… を開く。
  要点・グラフ・ポイント・この統計とは・もとにした表・同じ統計の過去の分析を出す（estat.html だけなら一覧）。
- 公表の翌日以降に分析した分は、分析した日の新着にも「M/D 公表分の分析」として出る（新着は当日分だけ表示のため）。
- まだ分析していない新着は「まだ分析していない政府統計の新着 N件」に折りたたむ。
