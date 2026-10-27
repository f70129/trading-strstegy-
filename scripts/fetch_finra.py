#!/usr/bin/env python3
"""Fetch FINRA monthly Margin Statistics and write finra.json.

Source: https://www.finra.org/investors/margin-statistics
FINRA publishes only an Excel file (no CSV/API). We discover the .xlsx link on
the page, download and parse it; if that fails we fall back to parsing the HTML
table on the page. Figures are in $ millions.

Columns captured per month:
  debit    - Debit Balances in Customers' Securities Margin Accounts (margin debt)
  fc_cash  - Free Credit Balances in Customers' Cash Accounts
  fc_margin- Free Credit Balances in Customers' Securities Margin Accounts

Runs monthly from GitHub Actions; commits finra.json only when it changes.
"""
import io
import json
import os
import re
import sys
from datetime import datetime, timezone

import requests

PAGE = "https://www.finra.org/investors/margin-statistics"
OUT = os.path.join(os.path.dirname(__file__), "..", "finra.json")
KEEP = 120
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; trading-strstegy/1.0)"}


def _num(x):
    if x is None:
        return None
    s = re.sub(r"[,$\s]", "", str(x))
    if s in ("", "-", "nan", "NaN", "None"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _month(x):
    """Normalise many month spellings to 'YYYY-MM'."""
    if x is None:
        return None
    if isinstance(x, datetime):
        return x.strftime("%Y-%m")
    s = str(x).strip()
    if not s or s.lower() in ("nan", "none"):
        return None
    try:
        import pandas as pd
        ts = pd.to_datetime(s, errors="coerce")
        if ts is not None and not pd.isna(ts):
            return ts.strftime("%Y-%m")
    except Exception:
        pass
    m = re.match(r"([A-Za-z]{3,9})[-/ ]?(\d{2,4})", s)
    if m:
        months = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
                  "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
        mo = months.get(m.group(1)[:3].lower())
        yr = int(m.group(2))
        if mo:
            if yr < 100:
                yr += 2000 if yr < 70 else 1900
            return f"{yr:04d}-{mo:02d}"
    return None


def _pick(cols, *needles):
    for i, c in enumerate(cols):
        cl = str(c).lower()
        if all(n in cl for n in needles):
            return i
    return None


def rows_from_frame(df):
    cols = list(df.columns)
    i_deb = _pick(cols, "debit")
    i_cash = _pick(cols, "free credit", "cash")
    i_marg = _pick(cols, "free credit", "margin")
    # month column: first col, or one containing 'month'/'year'/'period'
    i_mon = _pick(cols, "month")
    if i_mon is None:
        i_mon = _pick(cols, "period")
    if i_mon is None:
        i_mon = 0
    if i_deb is None:
        return []
    out = []
    for _, r in df.iterrows():
        mon = _month(r.iloc[i_mon])
        deb = _num(r.iloc[i_deb])
        if not mon or deb is None:
            continue
        out.append({
            "month": mon,
            "debit": round(deb, 1),
            "fc_cash": round(_num(r.iloc[i_cash]), 1) if i_cash is not None and _num(r.iloc[i_cash]) is not None else None,
            "fc_margin": round(_num(r.iloc[i_marg]), 1) if i_marg is not None and _num(r.iloc[i_marg]) is not None else None,
        })
    return out


def from_xlsx(page_html, base):
    import pandas as pd
    m = re.search(r'href="([^"]+\.xlsx[^"]*)"', page_html, re.I)
    if not m:
        return []
    url = m.group(1)
    if url.startswith("/"):
        url = "https://www.finra.org" + url
    print(f"[fetch_finra] xlsx: {url}")
    xl = requests.get(url, headers=HEADERS, timeout=60)
    xl.raise_for_status()
    best = []
    sheets = pd.read_excel(io.BytesIO(xl.content), sheet_name=None, header=None)
    for name, raw in sheets.items():
        # find header row (the one mentioning 'Debit')
        hdr = None
        for idx in range(min(12, len(raw))):
            joined = " ".join(str(v).lower() for v in raw.iloc[idx].tolist())
            if "debit" in joined:
                hdr = idx
                break
        if hdr is None:
            continue
        df = raw.iloc[hdr + 1:].copy()
        df.columns = [str(v) for v in raw.iloc[hdr].tolist()]
        got = rows_from_frame(df)
        if len(got) > len(best):
            best = got
    return best


def from_html(page_html):
    import pandas as pd
    best = []
    try:
        for df in pd.read_html(io.StringIO(page_html)):
            got = rows_from_frame(df)
            if len(got) > len(best):
                best = got
    except Exception as e:
        print(f"[fetch_finra] read_html failed: {e}", file=sys.stderr)
    return best


def main():
    try:
        page = requests.get(PAGE, headers=HEADERS, timeout=45)
        page.raise_for_status()
        html = page.text
    except Exception as e:
        print(f"[fetch_finra] page fetch failed: {e}", file=sys.stderr)
        sys.exit(1)

    rows = []
    try:
        rows = from_xlsx(html, PAGE)
    except Exception as e:
        print(f"[fetch_finra] xlsx path failed: {e}", file=sys.stderr)
    if not rows:
        rows = from_html(html)

    if not rows:
        print("[fetch_finra] no rows parsed; leaving existing data untouched", file=sys.stderr)
        sys.exit(1)

    uniq = {r["month"]: r for r in rows}
    rows = sorted(uniq.values(), key=lambda x: x["month"])[-KEEP:]
    payload = {
        "source": "FINRA Margin Statistics (https://www.finra.org/investors/margin-statistics)",
        "unit": "USD millions",
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "count": len(rows),
        "data": rows,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")
    last = rows[-1]
    print(f"[fetch_finra] wrote {len(rows)} months; latest {last['month']} "
          f"debit {last['debit']} fc_cash {last['fc_cash']} fc_margin {last['fc_margin']}")


if __name__ == "__main__":
    main()
