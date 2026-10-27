#!/usr/bin/env python3
"""Fetch CBOE Equity Put/Call Ratio (daily) and append to pcc.json.

Source: https://www.cboe.com/us/options/market_statistics/daily/
The page shows the EQUITY / TOTAL / INDEX put-call ratios for a trade date and
accepts a ?dt=YYYY-MM-DD parameter for historical days. There is no CSV/API, so
we parse the HTML. We accumulate history (dedup by date) so the series grows one
trading day at a time; on the first run we backfill recent trading days.

Run daily from GitHub Actions; commit pcc.json only when it changes.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests

BASE = "https://www.cboe.com/us/options/market_statistics/daily/"
OUT = os.path.join(os.path.dirname(__file__), "..", "pcc.json")
KEEP = 400                 # trading days to retain (~18 months)
BACKFILL_DAYS = 160        # calendar days to backfill on first run
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
}
EQ_RE = re.compile(r"EQUITY\s*PUT/?CALL\s*RATIO[^0-9]{0,250}?([01]?\.\d{2,3})", re.I | re.S)
DATE_RE = re.compile(r'name=["\']dt["\'][^>]*value=["\'](\d{4}-\d{2}-\d{2})', re.I)


def et_today():
    # US market day in America/New_York without zoneinfo guarantees: approximate via UTC-4/5
    now = datetime.now(timezone.utc)
    return (now - timedelta(hours=4)).date()


def fetch_day(dt=None):
    """Return (date_str, ratio) for a requested date, or None."""
    url = BASE if dt is None else f"{BASE}?dt={dt}"
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
        if not r.ok:
            return None
        html = r.text
        m = EQ_RE.search(html)
        if not m:
            return None
        ratio = float(m.group(1))
        if not (0.1 <= ratio <= 3.0):
            return None
        # prefer the date the page reports; else the requested/today date
        dm = DATE_RE.search(html)
        date_str = dm.group(1) if dm else (dt or et_today().isoformat())
        return (date_str, round(ratio, 3))
    except Exception as e:
        print(f"[fetch_pcc] {dt or 'today'}: {e}", file=sys.stderr)
        return None


def load_existing():
    try:
        with open(OUT, encoding="utf-8") as f:
            j = json.load(f)
        return {r["date"]: float(r["pc"]) for r in j.get("data", []) if r.get("pc") is not None}
    except Exception:
        return {}


def main():
    hist = load_existing()
    got = {}

    if not hist:
        print(f"[fetch_pcc] first run; backfilling ~{BACKFILL_DAYS} days")
        today = et_today()
        miss = 0
        for i in range(BACKFILL_DAYS):
            d = today - timedelta(days=i)
            if d.weekday() >= 5:      # skip weekends
                continue
            res = fetch_day(d.isoformat())
            if res:
                got[res[0]] = res[1]
                miss = 0
            else:
                miss += 1
                if miss >= 15:        # long gap of failures -> stop
                    break
            time.sleep(0.25)
    else:
        # incremental: current day + fill any gap since last stored date
        res = fetch_day(None)
        if res:
            got[res[0]] = res[1]
        last = max(hist.keys())
        start = datetime.strptime(last, "%Y-%m-%d").date() + timedelta(days=1)
        d = start
        today = et_today()
        while d <= today:
            if d.weekday() < 5:
                r2 = fetch_day(d.isoformat())
                if r2:
                    got[r2[0]] = r2[1]
                time.sleep(0.2)
            d += timedelta(days=1)

    if not got and not hist:
        print("[fetch_pcc] no data parsed; leaving file untouched", file=sys.stderr)
        sys.exit(1)

    hist.update(got)
    rows = [{"date": k, "pc": hist[k]} for k in sorted(hist.keys())][-KEEP:]
    payload = {
        "source": "CBOE Equity Put/Call Ratio (https://www.cboe.com/us/options/market_statistics/daily/)",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "count": len(rows),
        "data": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"[fetch_pcc] total {len(rows)} days; +{len(got)} new; latest "
          f"{rows[-1]['date']} = {rows[-1]['pc']}")


if __name__ == "__main__":
    main()
