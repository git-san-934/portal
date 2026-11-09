"""S&P 500 の日次終値・四半期の EPS(12か月合計)・1株純資産を取得して data/source.json に保存する。

取得元(どちらも作業環境からは届かず、GitHub Actions からは取れる):
- 日次終値: Cboe の遅延データ(https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_SPX.json、1975年〜)
- EPS・1株純資産: multpl.com の表(S&P の公表値をまとめたもの)
  - EPS は「月ごとの PER の表」と「月ごとの株価の表」から 株価 ÷ PER で出す(表の EPS は物価調整済みのため使わない)
  - 四半期末(3・6・9・12月)の値だけを使い、multpl の EPS の表に載っている四半期まで(まだ公表されていない四半期は使わない)
- 1株純資産: https://www.multpl.com/s-p-500-book-value/table/by-quarter(1999年末〜)

標準ライブラリのみ。--check は取れるかの確認だけで、ファイルを書かない。
"""
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "data", "source.json")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/charts/historical/_SPX.json"
MULTPL = "https://www.multpl.com/{}/table/{}"
# 四半期の値が公表されて使えるようになるまでの日数の目安(後から分かる値で判定しないため)。
# 実際に先に公表されたときは、初めて取れた日から使う
QE = ("03", "06", "09", "12")


def get(url):
    if os.environ.get("SP500_RAW_DIR"):  # 手元で試すとき: 保存しておいた生データを読む
        name = re.sub(r"[^A-Za-z0-9]+", "_", url)[-60:]
        with open(os.path.join(os.environ["SP500_RAW_DIR"], name), "rb") as f:
            return f.read()
    err = None
    for k in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(5 * (k + 1))
    raise RuntimeError(f"{url}: {err!r}")


def table(path, by):
    """multpl の表 → [(YYYY-MM-DD, 値)] 古い順"""
    h = get(MULTPL.format(path, by)).decode("utf-8")
    rows = re.findall(r"<tr[^>]*>\s*<td[^>]*>(.*?)</td>\s*<td[^>]*>(.*?)</td>", h, re.S)
    out = []
    for a, b in rows:
        a = re.sub(r"<.*?>", "", a).strip()
        b = re.sub(r"<.*?>|&#x2002;|\s|,|†", "", b).strip()
        try:
            out.append((dt.datetime.strptime(a, "%b %d, %Y").date().isoformat(), float(b)))
        except ValueError:
            continue
    if len(out) < 50:
        raise RuntimeError(f"{path}: 表が読めません({len(out)}行)")
    return sorted(out)


def plus3(m):
    """四半期末の月 YYYY-MM → 3か月後の月初(使えるようになる日の目安)"""
    y, mm = int(m[:4]), int(m[5:7])
    t = y * 12 + mm - 1 + 3
    return f"{t // 12:04d}-{t % 12 + 1:02d}-01"


def main():
    check = "--check" in sys.argv
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date().isoformat()

    raw = json.loads(get(CBOE))["data"]
    daily = [[r["date"], round(float(r["close"]), 2)] for r in raw if float(r["close"]) > 0]
    daily.sort()

    pe = {d[:7]: v for d, v in table("s-p-500-pe-ratio", "by-month")}
    price = {d[:7]: v for d, v in table("s-p-500-historical-prices", "by-month")}
    eps_last = table("s-p-500-earnings", "by-month")[-1][0][:7]  # 公表済みの最後の四半期
    eps = [[m, round(price[m] / pe[m], 2)] for m in sorted(pe) if m[5:] in QE and m in price and m <= eps_last and pe[m] > 0]
    bv = [[d[:7], v] for d, v in table("s-p-500-book-value", "by-quarter")]

    print(f"日次 {len(daily)}日 {daily[0][0]}〜{daily[-1][0]} 終値 {daily[-1][1]}")
    print(f"EPS {len(eps)}四半期 〜{eps[-1][0]} {eps[-1][1]}")
    print(f"1株純資産 {len(bv)}四半期 {bv[0][0]}〜{bv[-1][0]} {bv[-1][1]}")
    if check:
        return

    old = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            old = json.load(f)
    # 減っていたら取得の失敗とみなして上書きしない
    if old and (len(daily) < len(old["daily"]) * 0.99 or daily[-1][0] < old["daily"][-1][0]
                or len(eps) < len(old["eps"]) or len(bv) < len(old["bv"])):
        raise SystemExit("取得したデータが前より少ないので上書きしません")

    # 使えるようになった日: 前に記録した日 > 初めて取れた日(今日)と 3か月後の早いほう
    seen = {("e", r[0]): r[2] for r in old.get("eps", [])}
    seen.update({("b", r[0]): r[2] for r in old.get("bv", [])})
    def avail(kind, q):
        return seen.get((kind, q)) or min(plus3(q), today)
    eps = [[q, v, avail("e", q)] for q, v in eps]
    bv = [[q, v, avail("b", q)] for q, v in bv]

    data = {"fetched": today, "daily": daily, "eps": eps, "bv": bv}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")


if __name__ == "__main__":
    main()
