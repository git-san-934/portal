#!/usr/bin/env python3
"""蓄積した日銀統計から変化（急変・トレンド転換・高値/安値更新）を検知し、レポートを書く。

使い方:
  python3 analyze.py            # reports/YYYY-MM-DD.md と reports/latest.json を出力
  python3 analyze.py --days 5   # 直近5観測以内に起きた変化も拾う（週次でまとめて見るとき）

検知ルール（系列の kind と頻度で切替）:
  急変      : 前回比の変化が過去の変化の標準偏差の2.5倍超（zスコア）。金利系は変化幅(bp)で判定し、
              0.05%pt以上の動きも急変扱い（政策金利の変更を確実に拾うため）
  トレンド転換: 短期移動平均が長期移動平均を上抜け/下抜け（日次 20/60、月次 3/12）
  高値/安値更新: 過去1年（日次250観測、月次12観測）の最高値・最安値を更新
資産クラスとの関係は一般的な傾向の整理であり、個別の売買推奨ではない。
"""
import csv, datetime as dt, json, math, os, statistics, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
REPORTS = os.path.join(ROOT, "reports")

PARAMS = {
    "D": {"short": 20, "long": 60, "vol_win": 60, "year": 250},
    "M": {"short": 3, "long": 12, "vol_win": 24, "year": 12},
    "Q": {"short": 2, "long": 4, "vol_win": 12, "year": 4},
}
Z_THRESHOLD = 2.5
RATE_STEP = 0.05  # 日次の金利系で急変とみなす最小変化幅（%pt）

# 系列ごとの「上昇したとき」に一般に言われる資産クラスへの影響。下落時は逆方向。
IMPLICATIONS = {
    "STRDCLUCON": "短期金利の上昇は利上げ・引締め方向のシグナル。一般に債券（特に短中期）価格には下押し、円には上昇（円高）圧力、"
                  "銀行株には利ざや改善期待でプラス、REIT・不動産や高PERのグロース株には逆風とされる。",
    "MADR1Z@D":   "基準貸付利率は政策金利の変更に連動しやすい。上昇なら利上げ局面入り/継続を示し、影響はコールレート上昇時と同方向でより強い。",
    "STRDCLUCV":  "出来高の増加は短期金融市場の取引活発化（金利がつく環境への移行、市場機能の回復）を示すことが多い。直接の価格シグナルではなく、金利変化の裏付けとして見る。",
    "FXERD04":    "ドル円の上昇（円安）は一般に輸出関連株や外貨建て資産の円換算額にプラス、輸入物価経由で物価上昇圧力となり、日銀の引締め観測を強めることがある。",
    "FXERD31":    "ユーロドルの上昇はドル全面安を示す。ドル円と合わせて見ると、円安/円高がドル要因か円要因かの切り分けに使える。",
    "MABS1AN11":  "マネタリーベースの伸び鈍化・減少は量的引締め（QT）の進行を示し、長期金利の上昇圧力、債券には逆風、利ざや面で銀行株には相対的にプラスとされる。拡大はその逆。",
    "MABS1AN11@": "前年比の低下は資金供給の縮小ペース加速を示す（マネタリーベース残高と同じ解釈）。",
    "MABS1AN113": "日銀当座預金の減少は資金供給の縮小（国債買入減額や償還）を反映。長期金利上昇・円高方向の圧力とされる。",
    "MASDM@07":   "日銀当座預金の減少は資金供給の縮小を反映。長期金利上昇・円高方向の圧力とされる。",
    "MASDM58":    "国債買入の減少は日銀の国債需要の後退を意味し、長期金利の上昇（債券価格の下落）圧力となりやすい。",
    "JGB10Y":     "10年債利回りの上昇は債券価格の下落を意味し、住宅ローン固定金利や企業の借入コストの上昇、REIT・高PER株には逆風、利ざや面で銀行・保険株には追い風とされる。日米金利差が縮めば円高要因にもなりうる。",
    "JGB2Y":      "2年債利回りは今後1〜2年の政策金利予想をよく映す。上昇は追加利上げ観測の強まりを示す。",
    "JGB30Y":     "超長期金利の上昇は財政や物価への懸念（タームプレミアム）の高まりを映すことが多く、生保・年金の需要動向にも左右される。",
    "PRCG20_2200000000%": "企業物価の上昇率の高まりは、川下の消費者物価への転嫁を通じて日銀の利上げ観測を強めやすい。一般に債券には逆風、価格転嫁力のある企業には相対的にプラスとされる。",
    "PRCG20_2200000000": "企業物価指数の上昇は仕入れコストの上昇を示す（前年比の説明を参照）。",
    "PRCG20_2600000000%": "円ベースの輸入物価の上昇は、円安や資源高による輸入インフレを示す。数か月遅れで企業物価・消費者物価に波及しやすい。",
    "PRCS20_5200000000%": "企業向けサービス価格は人件費の比率が高く、賃金上昇の価格転嫁を映す。上昇が続けば物価の基調の強さを示し、利上げ観測につながりやすい。",
    "MAM1YAM2M2MO": "マネーストック（M2）の伸びは世の中に出回るお金の増え方。伸びの鈍化は金融引き締めや貸出の減速を映しやすい。",
    "MAM1YAM3M3MO": "M3の伸び鈍化は預金の増え方が弱まっていることを示し、金融環境の引き締まりの目安になる。",
    "FAAPOBAL1@": "銀行貸出の伸びは企業・家計の資金需要を映す。金利上昇局面でも伸びが続けば景気の底堅さ、急減速なら引き締め効果の表れとされる。",
    "DLLR2CIDBNL1": "新規貸出金利の上昇は政策金利の引き上げが企業・家計の借入コストに波及していることを示す。銀行の利ざや改善にはプラス、借り手には負担増。",
    "DLLR2CIDBST1": "貸出残高全体の平均金利。新規金利より遅れて動き、銀行収益の改善ペースの目安になる。",
    "STTACLUTS1": "無担保コールの残高増加は、金利のある世界への移行で短期市場の取引が戻っていることを示す。",
    "DLLSDLPB": "企業の資金需要DIの上昇は設備投資・運転資金の需要増を示し、景気の強さの目安。",
    "DLLSDLPH": "個人の資金需要DI（住宅ローン等）。金利上昇で低下しやすく、住宅関連の需要の目安。",
    "TK99F1000601GCQ01000": "短観の大企業製造業の業況判断DI。上昇は景況感の改善を示し、一般に株式にはプラス、日銀の利上げを後押しする材料とされる。",
    "TK99F2000601GCQ01000": "大企業非製造業の業況判断DI。内需・サービス業の景況感の目安。",
    "TK99F0000204HCQ00000": "企業が予想する1年後の物価上昇率。高止まりはインフレ期待の定着を示し、日銀の利上げ判断に影響しやすい。",
    "FOF_FFAS430A900": "家計の金融資産残高。株価や預金の動きで増減する。",
    "FOF_FFAS430A100": "家計の現金・預金。金利上昇で預金の魅力が増すかどうかの目安。",
    "FOF_FFAS430A334": "家計が持つ株式・投資信託。株価と家計の投資行動（貯蓄から投資へ）を映す。",
    "BPBP6JYNCB": "経常収支の黒字拡大は海外から稼ぐ力の強さを示し、中長期的には円高要因とされる。ただし黒字の中心が第一次所得（海外で再投資されやすい）だと円買いにつながりにくい。",
    "BPBP6JYNTB": "貿易収支の悪化（赤字拡大）は円を売ってドルを買う実需が増えることを意味し、円安要因とされる。資源価格や円安で輸入額が膨らむと悪化しやすい。",
    "BPBP6JYNSN": "サービス収支。旅行（インバウンド）の黒字とデジタル関連の赤字の差し引き。",
    "BPBP6JYNPIN": "第一次所得収支は海外投資からの利子・配当。日本の経常黒字の柱だが、多くは海外に再投資され円買いにつながりにくいとされる。",
    "BPBP6JYNFB": "金融収支のプラスは日本からの資金流出（対外資産の増加）を示す。",
    "BPBP6JYNFB1": "直接投資のプラスは日本企業の海外投資（M&A・工場など）が海外からの投資を上回っていることを示し、円売り要因になりやすい。",
    "BPBP6JYNFB2": "証券投資のプラスは日本からの外国証券購入（対外証券投資）が多いことを示す。国内金利の上昇で国内回帰が進むと縮小しやすい。",
    "BPBP6JYNSN2": "旅行収支の黒字はインバウンド消費。円安で拡大しやすく、観光・小売株の業績に関係する。",
    "BPBP6JYNSN906": "知的財産権等使用料。海外子会社からのロイヤルティ受取が中心で黒字になりやすい。",
    "BPBP6JYNSN907": "通信・コンピュータ・情報サービスの赤字は、クラウドなど海外デジタルサービスへの支払い（いわゆるデジタル赤字）を映す。",
    "CPI_ALL_YOY": "消費者物価の上昇率。2%を上回る状態が続くと日銀の利上げ継続の根拠になりやすく、債券には逆風、実質金利の低下を通じて円安要因にもなりうる。",
    "CPI_CORE_YOY": "日銀が物価目標で重視する「生鮮食品を除く総合（コアCPI）」。2%目標との距離が利上げ判断の中心になる。",
    "CPI_CORECORE_YOY": "エネルギーも除いた「コアコアCPI」は物価の基調（賃金・サービス価格の転嫁）を映す。これが2%を超えて続くかが利上げ継続の鍵とされる。",
    "CPI_TKY_CORE_YOY": "東京都区部のコアCPIは全国より約1か月早く公表され、全国の先行指標として市場が注目する。",
    "CPI_TKY_ALL_YOY": "東京都区部の総合。全国の先行指標。",
    "CPI_TKY_CORECORE_YOY": "東京都区部のコアコア。物価の基調を早めに確認できる。",
    "CTI_TOTAL_REAL_YOY": "総消費動向指数（実質）は家計消費全体の動き。伸びがプラスなら個人消費が物価上昇を上回って増えていることを示し、景気や利上げ継続の支えになる。",
    "CTI_TOTAL_REAL": "総消費動向指数（実質）の水準。",
    "LFS_UNEMP_RATE": "完全失業率の上昇は労働需給の緩みを示し、賃金上昇の勢いが弱まる要因。利上げ観測の後退につながりやすく、債券にはプラス、円安方向とされる。",
    "LFS_EMPLOYED": "就業者数の増加は雇用の底堅さを示し、個人消費や賃金の下支えになる。",
    "SVC_SALES_YOY": "サービス産業の売上高の伸び。個人・企業のサービス需要の強さを示し、物価（サービス価格）の上昇とあわせて見ると実質的な需要の強さがわかる。",
    "SVC_ICT_YOY": "情報通信業の売上高。IT・通信投資の強さの目安。",
    "SVC_HOTEL_FOOD_YOY": "宿泊・飲食の売上高。インバウンドや外食需要を映し、旅行・外食関連株に関係する。",
    "POP_TOTAL": "総人口の減少は長期的な内需の縮小要因。",
    "POP_NET_MIGRATION": "社会増減（入国−出国）のプラスは外国人の流入超を示し、人手不足の緩和や住宅需要の下支えになりうる。",
    "KAKEI_CONS_REAL_YOY": "家計の実質消費の伸び。マイナスが続くと物価上昇に消費が追いついていないことを示し、日銀の利上げ判断を慎重にさせやすい。月ごとの振れが大きい点に注意。",
    "KAKEI_GOODS_REAL_YOY": "モノへの実質支出。物価高の影響を受けやすく、小売関連の需要の目安。",
    "KAKEI_SVC_REAL_YOY": "サービスへの実質支出。外食・旅行・娯楽などの需要の強さの目安。",
    "KAKEI_CONS_AMOUNT": "1世帯当たりの名目の消費支出額。季節性が大きいので前年同月と比べて見る。",
    "KOURI_TKY_RICE": "コメ5kgの店頭価格。消費者物価の食料を左右し、家計の体感物価に影響する。",
    "KOURI_TKY_EGG": "鶏卵の店頭価格。鳥インフルエンザなど供給要因で動きやすい。",
    "KOURI_TKY_GASOLINE": "ガソリンの店頭価格。原油価格・為替・補助金の影響を受け、消費者物価のエネルギーを左右する。",
    "IDOU_TOKYO_AREA_NET": "東京圏への人口の流入超過。首都圏の住宅需要や不動産（REIT）の下支え要因。3〜4月の転勤・進学期に大きく膨らむ季節性がある。",
    "IDOU_TOKYO_NET": "東京都への流入超過。都心の住宅・オフィス需要の目安。3〜4月に大きい季節性がある。",
    "MASDM4":     "資金過不足は財政・銀行券要因による市場資金の過不足。大きな不足は短期金利の上振れ要因になりうる。",
}
DISCLAIMER = "※資産クラスとの関係は過去に一般的に観察されてきた傾向の整理で、将来の値動きや個別銘柄の売買を示すものではありません。"


def load(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                out.append((row["date"], float(row["value"])))
            except ValueError:
                pass
    return out


def sma(xs, n, end):
    if end + 1 < n:
        return None
    return sum(xs[end + 1 - n:end + 1]) / n


def changes(dates, xs, kind):
    """前回比の変化系列。金利系・比率系は差分、水準系は対数変化率(%)。"""
    ch = []
    for i in range(1, len(xs)):
        a, b = xs[i - 1], xs[i]
        if kind in ("rate", "flow") or a <= 0 or b <= 0:
            ch.append(b - a)
        else:
            ch.append(math.log(b / a) * 100)
    return ch


def detect(s, lookback):
    path = os.path.join(DATA, f"{s['db']}_{s['code'].replace('@', '_at_')}.csv")
    if not os.path.exists(path):
        return None, []
    obs = load(path)
    if len(obs) < 3:
        return None, []
    p = PARAMS.get(s["freq"], PARAMS["D"])
    dates = [d for d, _ in obs]
    xs = [v for _, v in obs]
    ch = changes(dates, xs, s["kind"])
    signals = []
    first = max(1, len(xs) - lookback)
    for i in range(first, len(xs)):
        c = ch[i - 1]
        hist = ch[max(0, i - 1 - p["vol_win"]):i - 1]
        # 急変
        z = None
        if len(hist) >= 10:
            sd = statistics.pstdev(hist)
            if sd > 0:
                z = c / sd
        big_rate = s["kind"] == "rate" and s["freq"] == "D" and abs(c) >= RATE_STEP - 1e-9  # 0.05%pt ルールは日次の金利だけ
        if (z is not None and abs(z) >= Z_THRESHOLD) or big_rate:
            signals.append({"type": "急変", "date": dates[i], "dir": "上昇" if c > 0 else "低下",
                            "detail": fmt_change(s, c) + (f"（z={z:+.1f}）" if z is not None else "")})
        # トレンド転換
        s0, l0 = sma(xs, p["short"], i - 1), sma(xs, p["long"], i - 1)
        s1, l1 = sma(xs, p["short"], i), sma(xs, p["long"], i)
        if None not in (s0, l0, s1, l1):
            if s0 <= l0 and s1 > l1:
                signals.append({"type": "トレンド転換", "date": dates[i], "dir": "上昇",
                                "detail": f"{p['short']}期移動平均が{p['long']}期移動平均を上抜け"})
            elif s0 >= l0 and s1 < l1:
                signals.append({"type": "トレンド転換", "date": dates[i], "dir": "低下",
                                "detail": f"{p['short']}期移動平均が{p['long']}期移動平均を下抜け"})
        # 1年高値/安値
        window = xs[max(0, i - p["year"]):i]
        if len(window) >= min(p["year"], 10):
            if xs[i] > max(window):
                signals.append({"type": "1年高値更新", "date": dates[i], "dir": "上昇", "detail": f"{num(xs[i])}{s['unit']}"})
            elif xs[i] < min(window):
                signals.append({"type": "1年安値更新", "date": dates[i], "dir": "低下", "detail": f"{num(xs[i])}{s['unit']}"})
    latest = {"date": dates[-1], "value": xs[-1], "prev": xs[-2], "change": fmt_change(s, ch[-1]), "n": len(xs)}
    return latest, signals


def num(x):
    """大きい値は桁区切りの整数、小さい値はそのまま（指数表記を避ける）。"""
    return f"{x:,.0f}" if abs(x) >= 1000 else f"{x:g}"


def fmt_change(s, c):
    if s["kind"] == "rate":
        return f"{c:+.3f}%pt"
    if s["kind"] == "flow":
        return f"{c:+,.0f}{s['unit']}"
    return f"{c:+.2f}%"


def main():
    lookback = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 1
    with open(os.path.join(ROOT, "series.json"), encoding="utf-8") as f:
        series = json.load(f)["series"]
    today = dt.date.today().isoformat()
    os.makedirs(REPORTS, exist_ok=True)

    rows, alerts, missing = [], [], []
    for s in series:
        latest, sig = detect(s, lookback)
        if latest is None:
            missing.append(s)
            continue
        rows.append((s, latest))
        for g in sig:
            alerts.append({**g, "db": s["db"], "code": s["code"], "name": s["name"],
                           "implication": IMPLICATIONS.get(s["code"], "")})

    md = [f"# 日銀統計 変化検知レポート {today}", ""]
    md.append(f"## 検知された変化（{len(alerts)}件）" if alerts else "## 検知された変化: なし")
    md.append("")
    by_series = {}
    for a in alerts:
        by_series.setdefault(a["code"], []).append(a)
    for group in by_series.values():
        md.append(f"- **{group[0]['name']}**")
        for a in group:
            md.append(f"  - {a['date']} {a['type']}・{a['dir']}: {a['detail']}")
        if group[0]["implication"]:
            down = group[-1]["dir"] == "低下"
            md.append(f"  - 一般的な関係: {group[0]['implication']}" + ("（上記は上昇時の説明。今回は低下なので逆方向）" if down else ""))
    if alerts:
        md += ["", DISCLAIMER]
    md += ["", "## 最新値", "", "| 系列 | 日付 | 値 | 前回比 | 蓄積数 |", "|---|---|---|---|---|"]
    for s, l in rows:
        md.append(f"| {s['name']} | {l['date']} | {num(l['value'])} {s['unit']} | {l['change']} | {l['n']} |")
    if missing:
        md += ["", "## データ未取得の系列", ""] + [f"- {s['name']}（{s['db']}/{s['code']}）" for s in missing]

    with open(os.path.join(REPORTS, f"{today}.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    with open(os.path.join(REPORTS, "latest.json"), "w", encoding="utf-8") as f:
        json.dump({"date": today, "alerts": alerts,
                   "latest": {s["code"]: l for s, l in rows},
                   "missing": [s["code"] for s in missing]}, f, ensure_ascii=False, indent=2)
    # 変化の履歴を追記（後でシグナルの当たり外れを検証できるように）
    log = os.path.join(REPORTS, "signals_log.csv")
    new = not os.path.exists(log)
    seen = set()
    if not new:
        with open(log, encoding="utf-8") as f:
            seen = {(r["obs_date"], r["db"], r["code"], r["type"]) for r in csv.DictReader(f)}
    fresh = [a for a in alerts if (a["date"], a["db"], a["code"], a["type"]) not in seen]
    with open(log, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["detected_on", "obs_date", "db", "code", "name", "type", "dir", "detail"])
        for a in fresh:  # 同じ観測日・系列・種類の検知は一度だけ記録する
            w.writerow([today, a["date"], a["db"], a["code"], a["name"], a["type"], a["dir"], a["detail"]])
    print(f"新規の検知: {len(fresh)}件")
    print("\n".join(md))


if __name__ == "__main__":
    main()
