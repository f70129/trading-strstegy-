#!/usr/bin/env python3
"""Fetch AAII Investor Sentiment Survey weekly results and write data/aaii.json.

Primary source: the official historical spreadsheet
    https://www.aaii.com/files/surveys/sentiment.xls
Each row holds a week-ending date and the Bullish / Neutral / Bearish shares.
We keep the most recent ~104 weeks as percentages (0-100).

Run weekly from GitHub Actions; commit data/aaii.json only when it changes.
"""
import io
import json
import os
import sys
from datetime import datetime, timezone

import requests

XLS_URL = "https://www.aaii.com/files/surveys/sentiment.xls"
OUT = os.path.join(os.path.dirname(__file__), "..", "aaii.json")
KEEP_WEEKS = 104
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; trading-strstegy/1.0; +https://trading-strstegy.pages.dev)",
    "Accept": "*/*",
}


def _to_pct(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    if 0 <= v <= 1.5:  # stored as fraction
        v *= 100.0
    return round(v, 1)


def _to_date(x):
    if isinstance(x, datetime):
        return x.date()
    try:
        import pandas as pd  # noqa
        ts = pd.to_datetime(x, errors="coerce")
        if ts is not None and not pd.isna(ts):
            return ts.date()
    except Exception:
        pass
    return None


def parse_xls(content):
    import pandas as pd

    df = pd.read_excel(io.BytesIO(content), sheet_name=0, header=None)
    rows = []
    for _, r in df.iterrows():
        d = _to_date(r.iloc[0]) if len(r) > 0 else None
        if d is None:
            continue
        if len(r) < 4:
            continue
        bull, neu, bear = _to_pct(r.iloc[1]), _to_pct(r.iloc[2]), _to_pct(r.iloc[3])
        if None in (bull, neu, bear):
            continue
        total = bull + neu + bear
        if not (80 <= total <= 120):  # sanity: three shares sum ~100
            continue
        rows.append({"week": d.isoformat(), "bull": bull, "neutral": neu, "bear": bear})
    # de-dup by week, keep last occurrence, sort ascending
    uniq = {row["week"]: row for row in rows}
    out = sorted(uniq.values(), key=lambda x: x["week"])
    return out


def main():
    try:
        resp = requests.get(XLS_URL, headers=HEADERS, timeout=45)
        resp.raise_for_status()
        rows = parse_xls(resp.content)
    except Exception as e:  # noqa
        print(f"[fetch_aaii] FAILED to fetch/parse: {e}", file=sys.stderr)
        # keep existing file; do not overwrite with nothing
        sys.exit(1)

    if not rows:
        print("[fetch_aaii] parsed 0 rows; leaving existing data untouched", file=sys.stderr)
        sys.exit(1)

    rows = rows[-KEEP_WEEKS:]
    payload = {
        "source": "AAII Investor Sentiment Survey (https://www.aaii.com/sentimentsurvey)",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "count": len(rows),
        "data": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    latest = rows[-1]
    print(f"[fetch_aaii] wrote {len(rows)} weeks; latest {latest['week']} "
          f"bull {latest['bull']} / neu {latest['neutral']} / bear {latest['bear']}")


if __name__ == "__main__":
    main()
