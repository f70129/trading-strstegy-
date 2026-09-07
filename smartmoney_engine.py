#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
台指期「聰明錢」大單 / 小單流向引擎（Python 版，與 js/smartmoney-core.js 邏輯 1:1 對應）

功能：
  --selftest                     以合成資料跑單元測試，並輸出與 JS 版比對用的損益（跨語言一致性檢核）
  --backtest START END           下載 FinMind TaiwanFuturesTick（TX/MTX/TMF）逐筆回測，輸出 data/smartmoney_backtest.json
  --grid START END               網格搜尋最佳參數，輸出 data/smartmoney_grid.json
  --live                         盤中輪詢 FinMind taiwan_futures_snapshot（付費），產生訊號、推播 Telegram、
                                 寫 data/smartmoney_live.json（可供靜態網頁讀取）
  --telegram-test                送一則測試訊息

環境變數：FINMIND_TOKEN（必要，即時 / 逐筆需付費 sponsor）、TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID
依賴：僅 requests（pip install requests）

⚠️ 本檔案在開發環境無法連外測試 FinMind / Telegram，網路路徑以 FinMind 官方 python 套件 (FinMind 2.0.9)
   的端點與欄位定義為準；首次連線請先執行 `--live --once` 觀察原始欄位。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

VERSION = "1.0.0"
CONTRACT_WEIGHT = {"TX": 1.0, "MTX": 0.25, "TMF": 0.025}
PRODUCT_ALIAS = {"TXF": "TX", "MXF": "MTX", "TMF": "TMF", "TX": "TX", "MTX": "MTX"}
POINT_VALUE_NTD = 200
TZ_TAIPEI = timezone(timedelta(hours=8))
API = "https://api.finmindtrade.com/api/v4"

DEFAULT_PARAMS = {
    "bigLot": 10, "midLot": 3, "windowMin": 10, "zEntry": 1.5, "zExit": 0.0,
    "stopPts": 30, "targetPts": 60, "retailWeight": 0.5, "trendFilter": True,
    "costPts": 1.5, "cooldownMin": 5, "maxTradesPerDay": 6,
    "sessionStart": "08:45", "sessionEnd": "13:45", "entryCutoff": "13:00", "flatAt": "13:40",
    "minBarsForZ": 10,
}


# ---------------------------------------------------------------- 小工具
def js_round(x: float, d: int = 0) -> float:
    """與 JS Math.round(x*10^d)/10^d 一致（.5 向 +∞ 進位）"""
    m = 10 ** d
    v = x * m
    r = math.floor(v + 0.5)
    return r / m if d else float(r)


def hhmm_to_min(s: str) -> int:
    h, m = str(s).split(":")
    return int(h) * 60 + int(m)


def min_to_hhmm(m: int) -> str:
    return f"{m // 60:02d}:{m % 60:02d}"


def merge_params(p: Optional[dict]) -> dict:
    out = dict(DEFAULT_PARAMS)
    out.update(p or {})
    return out


def normalize_product(pid: str) -> str:
    s = str(pid or "").upper()
    if s in PRODUCT_ALIAS:
        return PRODUCT_ALIAS[s]
    return PRODUCT_ALIAS.get(s[:3], s)


def contract_weight(pid: str) -> float:
    return CONTRACT_WEIGHT.get(normalize_product(pid), 0.0)


_TIME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?")


def parse_tick_time(s: str, fallback_minute: int = 0) -> dict:
    s = str(s or "").strip()
    m = _TIME_RE.match(s)
    if not m:
        return {"date": s[:10], "minute": fallback_minute, "ms": fallback_minute * 60000}
    if m.group(2) is None:
        return {"date": m.group(1), "minute": fallback_minute, "ms": fallback_minute * 60000}
    h, mi, se = int(m.group(2)), int(m.group(3)), int(m.group(4) or 0)
    frac = float("0." + m.group(5)) if m.group(5) else 0.0
    return {"date": m.group(1), "minute": h * 60 + mi, "ms": ((h * 60 + mi) * 60 + se) * 1000 + int(math.floor(frac * 1000 + 0.5))}


def select_near_contract(rows: List[dict]) -> Optional[str]:
    vol: Dict[str, float] = {}
    for r in rows:
        c = str(r.get("contract_date") or "")
        if not c or "/" in c:
            continue
        vol[c] = vol.get(c, 0) + float(r.get("volume") or 0)
    if not vol:
        return None
    return sorted(vol.keys(), key=lambda k: (-vol[k], k))[0]


def tick_side(price: float, last_price: Optional[float], last_side: int) -> int:
    if last_price is None:
        return 0
    if price > last_price:
        return 1
    if price < last_price:
        return -1
    return last_side or 0


def classify(product: str, volume: float, params: Optional[dict] = None) -> str:
    p = params or DEFAULT_PARAMS
    if normalize_product(product) == "TX":
        v = float(volume or 0)
        if v >= p["bigLot"]:
            return "big"
        if v >= p["midLot"]:
            return "mid"
        return "small"
    return "small"


def rows_to_trades(rows_by_product: Dict[str, List[dict]], day_session_only=True, start="08:45", end="13:45") -> List[dict]:
    start_min, end_min = hhmm_to_min(start), hhmm_to_min(end)
    out: List[dict] = []
    for product_raw, rows in (rows_by_product or {}).items():
        if not rows:
            continue
        product = normalize_product(product_raw)
        near = select_near_contract(rows)
        seq = []
        idx = 0
        for r in rows:
            c = str(r.get("contract_date") or "")
            if near and c != near:
                continue
            t = parse_tick_time(r.get("date"), 0)
            seq.append((t["ms"], idx, t, r))
            idx += 1
        seq.sort(key=lambda x: (x[0], x[1]))
        last_price, last_side = None, 0
        for _, _, t, r in seq:
            if day_session_only and (t["minute"] < start_min or t["minute"] > end_min):
                continue
            try:
                price = float(r.get("price"))
            except (TypeError, ValueError):
                continue
            volume = float(r.get("volume") or 0)
            if not math.isfinite(price) or volume <= 0:
                continue
            side = tick_side(price, last_price, last_side)
            last_price, last_side = price, side
            out.append({"ms": t["ms"], "minute": t["minute"], "product": product, "price": price, "volume": volume, "side": side})
    out.sort(key=lambda x: x["ms"])  # Python sort 穩定，與 JS 相同輸入順序下結果一致
    return out


# ---------------------------------------------------------------- 1 分 K
def new_bar(minute: int) -> dict:
    return {
        "minute": minute, "time": min_to_hhmm(minute),
        "open": None, "high": -math.inf, "low": math.inf, "close": None,
        "vol": 0.0, "amt": 0.0,
        "bigBuy": 0.0, "bigSell": 0.0, "midBuy": 0.0, "midSell": 0.0, "smallBuy": 0.0, "smallSell": 0.0,
        "bigTrades": 0, "smallTrades": 0, "unkBuy": 0.0, "unkSell": 0.0, "unsBuy": 0.0, "unsSell": 0.0,
    }


class FlowBook:
    def __init__(self, params: Optional[dict] = None):
        self.params = merge_params(params)
        self.bars: List[dict] = []
        self._by_minute: Dict[int, dict] = {}
        self.totals = {"bigBuy": 0.0, "bigSell": 0.0, "midBuy": 0.0, "midSell": 0.0, "smallBuy": 0.0, "smallSell": 0.0,
                       "unsBuy": 0.0, "unsSell": 0.0, "bigTrades": 0, "smallTrades": 0, "trades": 0}
        self.last_price: Optional[float] = None

    def bar_for(self, minute: int) -> dict:
        b = self._by_minute.get(minute)
        if b is None:
            b = new_bar(minute)
            self._by_minute[minute] = b
            self.bars.append(b)
            if len(self.bars) > 1 and self.bars[-2]["minute"] > minute:
                self.bars.sort(key=lambda x: x["minute"])
        return b

    def add_trade(self, tr: dict) -> None:
        p = self.params
        b = self.bar_for(tr["minute"])
        product = normalize_product(tr["product"])
        w = contract_weight(product)
        if not w:
            return
        if product == "TX":
            if b["open"] is None:
                b["open"] = tr["price"]
            b["high"] = max(b["high"], tr["price"])
            b["low"] = min(b["low"], tr["price"])
            b["close"] = tr["price"]
            b["vol"] += tr["volume"]
            b["amt"] += tr["volume"] * tr["price"]
            self.last_price = tr["price"]
        eq = tr["volume"] * w
        side = tr["side"]
        t = self.totals
        if tr.get("forceSmall"):
            if side >= 0:
                b["unsBuy"] += eq; t["unsBuy"] += eq
            else:
                b["unsSell"] += eq; t["unsSell"] += eq
            return
        cls = classify(product, tr["volume"], p)
        t["trades"] += 1
        if cls == "big":
            b["bigTrades"] += 1; t["bigTrades"] += 1
            if side > 0:
                b["bigBuy"] += eq; t["bigBuy"] += eq
            elif side < 0:
                b["bigSell"] += eq; t["bigSell"] += eq
            else:
                b["unkBuy"] += eq / 2; b["unkSell"] += eq / 2
        elif cls == "mid":
            if side > 0:
                b["midBuy"] += eq; t["midBuy"] += eq
            elif side < 0:
                b["midSell"] += eq; t["midSell"] += eq
        else:
            b["smallTrades"] += 1; t["smallTrades"] += 1
            if side > 0:
                b["smallBuy"] += eq; t["smallBuy"] += eq
            elif side < 0:
                b["smallSell"] += eq; t["smallSell"] += eq

    def add_trades(self, trades: List[dict]) -> None:
        for tr in trades:
            self.add_trade(tr)


def build_bars(trades: List[dict], params: Optional[dict] = None) -> List[dict]:
    fb = FlowBook(params)
    fb.add_trades(trades)
    last = None
    for b in fb.bars:
        if b["close"] is None:
            b["open"] = b["high"] = b["low"] = b["close"] = last
        else:
            last = b["close"]
    return [b for b in fb.bars if b["close"] is not None]


# ---------------------------------------------------------------- 指標
def _mean(a: List[float]) -> float:
    return sum(a) / len(a) if a else 0.0


def _std(a: List[float]) -> float:
    if len(a) < 2:
        return 0.0
    m = _mean(a)
    return math.sqrt(sum((x - m) * (x - m) for x in a) / (len(a) - 1))


def compute_series(bars: List[dict], params: Optional[dict] = None) -> List[dict]:
    p = merge_params(params)
    W = max(1, int(p["windowMin"]))
    out = []
    big_arr: List[float] = []
    ret_arr: List[float] = []
    cum_big = cum_ret = cum_amt = cum_vol = 0.0
    for i, b in enumerate(bars):
        big_net = b["bigBuy"] - b["bigSell"]
        ret_net = b["smallBuy"] - b["smallSell"]
        big_arr.append(big_net); ret_arr.append(ret_net)
        cum_big += big_net; cum_ret += ret_net
        cum_amt += b["amt"]; cum_vol += b["vol"]
        lo = max(0, i - W + 1)
        win_big = sum(big_arr[lo:i + 1]); win_ret = sum(ret_arr[lo:i + 1])
        z_big = z_ret = 0.0
        if i + 1 >= p["minBarsForZ"]:
            s_b = _std(big_arr) * math.sqrt(W)
            s_r = _std(ret_arr) * math.sqrt(W)
            z_big = win_big / s_b if s_b > 1e-9 else 0.0
            z_ret = win_ret / s_r if s_r > 1e-9 else 0.0
        smi = z_big - p["retailWeight"] * z_ret
        out.append({
            "minute": b["minute"], "time": b["time"], "close": b["close"],
            "bigNet": js_round(big_net, 3), "retailNet": js_round(ret_net, 3),
            "winBig": js_round(win_big, 3), "winRetail": js_round(win_ret, 3),
            "zBig": js_round(z_big, 4), "zRetail": js_round(z_ret, 4), "smi": js_round(smi, 4),
            "cumBig": js_round(cum_big, 3), "cumRetail": js_round(cum_ret, 3),
            "vwap": js_round(cum_amt / cum_vol, 2) if cum_vol > 0 else b["close"],
        })
    return out


def sentiment(totals: dict) -> dict:
    t = totals or {}
    big_tot = t.get("bigBuy", 0) + t.get("bigSell", 0)
    sm_tot = t.get("smallBuy", 0) + t.get("smallSell", 0)
    big_ratio = (t.get("bigBuy", 0) - t.get("bigSell", 0)) / big_tot if big_tot > 0 else 0.0
    sm_ratio = (t.get("smallBuy", 0) - t.get("smallSell", 0)) / sm_tot if sm_tot > 0 else 0.0
    score = max(0.0, min(100.0, 50 + 60 * big_ratio - 20 * sm_ratio))
    if big_tot < 20:
        label, tone = "樣本不足", "neutral"
    elif score >= 70:
        label, tone = "大戶強烈偏多", "bull"
    elif score >= 58:
        label, tone = "大戶偏多", "bull"
    elif score <= 30:
        label, tone = "大戶強烈偏空", "bear"
    elif score <= 42:
        label, tone = "大戶偏空", "bear"
    else:
        label, tone = "大戶中性 / 觀望", "neutral"
    div = ""
    if big_tot >= 20 and sm_tot > 0:
        if big_ratio > 0.1 and sm_ratio < -0.1:
            div = "大戶買、散戶賣 → 聰明錢承接，偏多訊號"
        elif big_ratio < -0.1 and sm_ratio > 0.1:
            div = "大戶賣、散戶買 → 散戶接刀，偏空訊號"
        elif big_ratio > 0.1 and sm_ratio > 0.1:
            div = "大戶散戶同步買，追價需留意過熱"
        elif big_ratio < -0.1 and sm_ratio < -0.1:
            div = "大戶散戶同步賣，弱勢盤"
    return {"score": js_round(score, 1), "label": label, "tone": tone, "bigRatio": js_round(big_ratio, 4),
            "retailRatio": js_round(sm_ratio, 4), "bigTotal": js_round(big_tot, 2), "retailTotal": js_round(sm_tot, 2), "divergence": div}


# ---------------------------------------------------------------- 模擬盤
class PaperTrader:
    def __init__(self, params: Optional[dict] = None):
        self.p = merge_params(params)
        self.pos: Optional[dict] = None
        self.trades: List[dict] = []
        self.last_exit_minute = -10 ** 9
        self.day_trades = 0
        self.equity = 0.0
        self.peak = 0.0
        self.max_dd = 0.0
        self._entry_cut = hhmm_to_min(self.p["entryCutoff"])
        self._flat_at = hhmm_to_min(self.p["flatAt"])

    def _close(self, bar: dict, price: float, reason: str) -> dict:
        pos = self.pos
        gross = (price - pos["entry"]) * pos["side"]
        pnl = js_round(gross - self.p["costPts"], 2)
        tr = {"side": pos["side"], "entry": pos["entry"], "exit": price, "entryTime": pos["time"], "exitTime": bar["time"],
              "bars": pos["bars"], "pnl": pnl, "reason": reason}
        self.trades.append(tr)
        self.equity = js_round(self.equity + pnl, 2)
        self.peak = max(self.peak, self.equity)
        self.max_dd = max(self.max_dd, js_round(self.peak - self.equity, 2))
        self.pos = None
        self.last_exit_minute = bar["minute"]
        return {"type": "exit", "side": tr["side"], "price": price, "time": bar["time"], "reason": reason, "pnl": pnl, "trade": tr}

    def on_bar(self, bar: dict, ind: dict) -> List[dict]:
        p = self.p
        ev: List[dict] = []
        px = bar["close"]
        if px is None:
            return ev
        if self.pos:
            pos = self.pos
            pos["bars"] += 1
            stop_px = pos["entry"] - pos["side"] * p["stopPts"]
            tgt_px = pos["entry"] + pos["side"] * p["targetPts"]
            hit_stop = bar["low"] <= stop_px if pos["side"] > 0 else bar["high"] >= stop_px
            hit_tgt = bar["high"] >= tgt_px if pos["side"] > 0 else bar["low"] <= tgt_px
            if hit_stop:
                ev.append(self._close(bar, stop_px, "stop")); return ev
            if hit_tgt:
                ev.append(self._close(bar, tgt_px, "target")); return ev
            if bar["minute"] >= self._flat_at:
                ev.append(self._close(bar, px, "flat")); return ev
            flip = ind["smi"] <= -p["zExit"] if pos["side"] > 0 else ind["smi"] >= p["zExit"]
            if flip:
                ev.append(self._close(bar, px, "smi-flip")); return ev
            return ev
        if bar["minute"] >= self._entry_cut:
            return ev
        if bar["minute"] - self.last_exit_minute < p["cooldownMin"]:
            return ev
        if self.day_trades >= p["maxTradesPerDay"]:
            return ev
        side = 0
        if ind["smi"] >= p["zEntry"]:
            side = 1
        elif ind["smi"] <= -p["zEntry"]:
            side = -1
        if not side:
            return ev
        if p["trendFilter"] and ind.get("vwap") is not None:
            if side > 0 and px < ind["vwap"]:
                return ev
            if side < 0 and px > ind["vwap"]:
                return ev
        self.pos = {"side": side, "entry": px, "time": bar["time"], "minute": bar["minute"], "bars": 0}
        self.day_trades += 1
        ev.append({"type": "entry", "side": side, "price": px, "time": bar["time"],
                   "reason": "大戶淨買 SMI≥門檻" if side > 0 else "大戶淨賣 SMI≤-門檻", "smi": ind["smi"]})
        return ev

    def stats(self) -> dict:
        t = self.trades
        n = len(t)
        wins = [x for x in t if x["pnl"] > 0]
        losses = [x for x in t if x["pnl"] <= 0]
        gw = sum(x["pnl"] for x in wins)
        gl = -sum(x["pnl"] for x in losses)
        return {
            "trades": n, "pnlPts": js_round(self.equity, 2), "pnlNTD": int(js_round(self.equity * POINT_VALUE_NTD)),
            "winRate": js_round(len(wins) / n, 4) if n else 0, "avgPts": js_round(self.equity / n, 2) if n else 0,
            "profitFactor": js_round(gw / gl, 3) if gl > 0 else (99 if gw > 0 else 0), "maxDD": self.max_dd,
            "avgWin": js_round(gw / len(wins), 2) if wins else 0, "avgLoss": js_round(gl / len(losses), 2) if losses else 0,
        }


def backtest_bars(bars: List[dict], params: Optional[dict] = None) -> dict:
    p = merge_params(params)
    series = compute_series(bars, p)
    pt = PaperTrader(p)
    events: List[dict] = []
    for i, b in enumerate(bars):
        events.extend(pt.on_bar(b, series[i]))
    if pt.pos and bars:
        last = bars[-1]
        events.append(pt._close(last, last["close"], "eod"))
    return {"params": p, "bars": bars, "series": series, "events": events, "trades": pt.trades, "stats": pt.stats()}


def backtest_day(trades: List[dict], params: Optional[dict] = None) -> dict:
    p = merge_params(params)
    return backtest_bars(build_bars(trades, p), p)


def grid_search(days: List[dict], grid: Optional[dict] = None, base: Optional[dict] = None) -> List[dict]:
    g = {"bigLot": [5, 10, 20], "windowMin": [5, 10, 15], "zEntry": [1, 1.5, 2], "stopPts": [20, 30],
         "targetPts": [40, 60], "retailWeight": [0.5], "trendFilter": [True]}
    g.update(grid or {})
    keys = list(g.keys())
    combos: List[dict] = []

    def rec(i, cur):
        if i == len(keys):
            combos.append(dict(cur)); return
        for v in g[keys[i]]:
            cur[keys[i]] = v
            rec(i + 1, cur)
    rec(0, {})
    bar_cache: Dict[str, List[dict]] = {}

    def bars_for(day, big_lot):
        k = f"{day['date']}|{big_lot}"
        if k not in bar_cache:
            bp = merge_params(dict(base or {}, bigLot=big_lot))
            bar_cache[k] = build_bars(day["trades"], bp)
        return bar_cache[k]
    results = []
    for c in combos:
        p = merge_params(dict(base or {}, **c))
        pnl = 0.0; n = 0; wins = 0; gw = 0.0; gl = 0.0; dd = 0.0; eq = 0.0; peak = 0.0; pos_days = 0
        per_day = []
        for day in days:
            r = backtest_bars(bars_for(day, p["bigLot"]), p)
            pnl += r["stats"]["pnlPts"]; n += r["stats"]["trades"]
            for t in r["trades"]:
                if t["pnl"] > 0:
                    wins += 1; gw += t["pnl"]
                else:
                    gl -= t["pnl"]
                eq = js_round(eq + t["pnl"], 2); peak = max(peak, eq); dd = max(dd, js_round(peak - eq, 2))
            if r["stats"]["pnlPts"] > 0:
                pos_days += 1
            per_day.append({"date": day["date"], "pnl": r["stats"]["pnlPts"], "trades": r["stats"]["trades"]})
        results.append({
            "params": c, "pnlPts": js_round(pnl, 2), "pnlNTD": int(js_round(pnl * POINT_VALUE_NTD)), "trades": n,
            "winRate": js_round(wins / n, 4) if n else 0, "profitFactor": js_round(gw / gl, 3) if gl > 0 else (99 if gw > 0 else 0),
            "maxDD": js_round(dd, 2), "avgPts": js_round(pnl / n, 2) if n else 0, "posDays": pos_days, "days": len(days), "perDay": per_day,
        })
    results.sort(key=lambda r: (-r["pnlPts"], -r["profitFactor"], r["maxDD"]))
    return results


# ---------------------------------------------------------------- 快照 → 取樣成交
def interval_side(prev: dict, snap: dict, delta: float) -> int:
    try:
        a0, a1 = float(prev.get("total_amount")), float(snap.get("total_amount"))
    except (TypeError, ValueError):
        return 0
    if not (math.isfinite(a0) and math.isfinite(a1)) or not delta > 0:
        return 0
    d_amt = a1 - a0
    if not d_amt > 0:
        return 0
    try:
        tv, px = float(snap.get("total_volume")), float(snap.get("close"))
    except (TypeError, ValueError):
        return 0
    if not tv > 0 or not px > 0:
        return 0
    scale = (a1 / tv) / px
    scale = 200 if scale > 100 else 50 if scale > 25 else 5 if scale > 2.5 else 1
    avg = d_amt / delta / scale
    try:
        bp, sp = float(snap.get("buy_price")), float(snap.get("sell_price"))
    except (TypeError, ValueError):
        bp = sp = float("nan")
    mid = (bp + sp) / 2 if (math.isfinite(bp) and math.isfinite(sp) and bp > 0 and sp > 0) else float(prev.get("close") or 0)
    if not math.isfinite(mid) or not mid > 0:
        return 0
    if avg > mid + 0.05:
        return 1
    if avg < mid - 0.05:
        return -1
    return 0


def snapshot_to_trades(prev: Optional[dict], snap: dict, product: str, minute: Optional[int] = None, attribute_remainder=True) -> List[dict]:
    if not snap:
        return []
    try:
        price = float(snap.get("close")); tv = float(snap.get("total_volume"))
    except (TypeError, ValueError):
        return []
    last_vol = float(snap.get("volume") or 0)
    t = parse_tick_time(snap.get("date"), 0)
    minute = t["minute"] if minute is None else minute
    if not prev:
        return []
    try:
        prev_tv = float(prev.get("total_volume"))
    except (TypeError, ValueError):
        return []
    delta = tv - prev_tv
    if delta <= 0:
        return []
    tt = snap.get("TickType", snap.get("tick_type"))
    side = 1 if tt in (1, "1") else -1 if tt in (2, "2") else 0
    if not side:
        try:
            bp, sp = float(snap.get("buy_price")), float(snap.get("sell_price"))
            if bp > 0 and sp > 0:
                side = 1 if price >= sp else -1 if price <= bp else 0
        except (TypeError, ValueError):
            pass
    if not side:
        side = tick_side(price, float(prev.get("close")), prev.get("_side", 0))
    snap["_side"] = side
    out = []
    sampled = min(max(last_vol, 0.0), delta)
    prod = normalize_product(product)
    if sampled > 0:
        out.append({"ms": t["ms"], "minute": minute, "product": prod, "price": price, "volume": sampled, "side": side, "sampled": True})
    rest = delta - sampled
    if rest > 0 and attribute_remainder:
        rs = interval_side(prev, snap, delta) or side
        out.append({"ms": t["ms"], "minute": minute, "product": prod, "price": price, "volume": rest, "side": rs, "sampled": False, "forceSmall": True})
    return out


# ---------------------------------------------------------------- FinMind 盤中逐筆（dataset=TaiwanFutOptTick, data_id=TXFR1）
def to_list(v) -> list:
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        t = v.strip()
        if t.startswith("["):
            try:
                a = json.loads(t)
                if isinstance(a, list):
                    return a
            except Exception:  # noqa: BLE001
                pass
        if "," in t:
            return [float(x.strip()) for x in t.replace("[", "").replace("]", "").split(",") if x.strip()]
        return [float(t)] if t else []
    if v is None:
        return []
    return [float(v)]


def parse_futopt_time(date_str, time_str, fallback_minute=0) -> dict:
    d = str(date_str or "")[:10]
    t = str("" if time_str is None else time_str).strip()
    if not t and re.search(r"\d{2}:\d{2}", str(date_str)):
        return parse_tick_time(date_str, fallback_minute)
    if re.match(r"^\d{5,9}$", t):
        t = t.rjust(6 if len(t) <= 6 else 9, "0")
        t = f"{t[0:2]}:{t[2:4]}:{t[4:6]}" + (("." + t[6:]) if len(t) > 6 else "")
    return parse_tick_time(f"{d} {t}", fallback_minute)


def _row_key(r: dict, i: int) -> str:
    return f"{r.get('Time', r.get('time', ''))}|{i}"


def parse_futopt_tick_rows(rows: list, product: str, cursor: Optional[dict], day_session_only=False, start="08:45", end="13:45") -> dict:
    """每列 {date, Time, Close(list|值|字串), Volume(...), TickType} → trades；cursor 去重（累加式回傳）"""
    c = {"n": 0, "key": None, "lastPrice": None, "lastSide": 0}
    c.update(cursor or {})
    lst = rows if isinstance(rows, list) else []
    prod = normalize_product(product)
    start_min, end_min = hhmm_to_min(start), hhmm_to_min(end)
    frm = c["n"]
    if len(lst) < c["n"] or (c["n"] > 0 and c["key"] is not None and _row_key(lst[c["n"] - 1] if c["n"] - 1 < len(lst) else {}, c["n"] - 1) != c["key"]):
        frm = 0
    if frm == 0:
        c["lastPrice"], c["lastSide"] = None, 0
    trades = []
    for i in range(frm, len(lst)):
        r = lst[i]
        closes = to_list(r.get("Close", r.get("close", r.get("price", r.get("deal_price")))))
        vols = to_list(r.get("Volume", r.get("volume", r.get("qty", r.get("deal_volume")))))
        tts = to_list(r.get("TickType", r.get("tick_type", 0)))
        t = parse_futopt_time(r.get("date"), r.get("Time", r.get("time")), 0)
        if day_session_only and (t["minute"] < start_min or t["minute"] > end_min):
            continue
        n = max(len(closes), len(vols))
        for k in range(n):
            try:
                price = float(closes[min(k, len(closes) - 1)])
                volume = float(vols[min(k, len(vols) - 1)])
            except (TypeError, ValueError, IndexError):
                continue
            if not math.isfinite(price) or not volume > 0:
                continue
            tt = float(tts[min(k, len(tts) - 1)]) if tts else 0
            side = 1 if tt == 1 else -1 if tt == 2 else 0
            if not side:
                side = tick_side(price, c["lastPrice"], c["lastSide"])
            c["lastPrice"], c["lastSide"] = price, side
            trades.append({"ms": t["ms"], "minute": t["minute"], "product": prod, "price": price, "volume": volume, "side": side})
    c["n"] = len(lst)
    c["key"] = _row_key(lst[-1], len(lst) - 1) if lst else None
    return {"trades": trades, "cursor": c}


# ---------------------------------------------------------------- 合成資料（與 JS 完全一致）
def mulberry32(seed: int):
    a = seed & 0xFFFFFFFF

    def imul(x, y):
        return ((x & 0xFFFFFFFF) * (y & 0xFFFFFFFF)) & 0xFFFFFFFF

    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = imul(t ^ (t >> 15), t | 1)
        t = (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        t = (t ^ (t >> 14)) & 0xFFFFFFFF
        return t / 4294967296
    return rnd


def synthetic_day(seed: int, date="2026-09-07", base_price=24000, minutes=300, trades_per_min=40, drift=0.15, regime_len=45) -> dict:
    rnd = mulberry32(seed)
    rows = {"TX": [], "MTX": [], "TMF": []}
    px = base_price
    regime = 0
    regime_left = 0
    start_min = hhmm_to_min("08:45")
    regimes = []
    for m in range(minutes):
        if regime_left <= 0:
            regime = -1 if rnd() < 0.5 else 1
            if rnd() < 0.3:
                regime = 0
            regime_left = regime_len + int(math.floor(rnd() * 20))
        regime_left -= 1
        regimes.append(regime)
        minute = start_min + m
        hh, mm = f"{minute // 60:02d}", f"{minute % 60:02d}"
        n = trades_per_min + int(math.floor(rnd() * 10))
        for k in range(n):
            ss = f"{int(math.floor((k / n) * 60)):02d}"
            ts = f"{date} {hh}:{mm}:{ss}"
            prod_r = rnd()
            product = "TX" if prod_r < 0.5 else "MTX" if prod_r < 0.85 else "TMF"
            if product == "TX":
                r = rnd()
                if r < 0.75:
                    volume = 1 + int(math.floor(rnd() * 2))
                elif r < 0.93:
                    volume = 3 + int(math.floor(rnd() * 6))
                else:
                    volume = 10 + int(math.floor(rnd() * 30))
                bias = 0.7 if volume >= 10 else 0.55 if volume >= 3 else 0.42
                aggressor = 1 if rnd() < (bias if regime > 0 else 1 - bias if regime < 0 else 0.5) else -1
            else:
                volume = 1 + int(math.floor(rnd() * 4))
                bias = 0.42
                aggressor = 1 if rnd() < (bias if regime > 0 else 1 - bias if regime < 0 else 0.5) else -1
            w = 1 if product == "TX" else 0.25 if product == "MTX" else 0.025
            impact_p = min(0.85, 0.04 * volume * w)
            step = aggressor if rnd() < impact_p else 0
            if rnd() < drift * 0.2:
                step += regime
            if rnd() < 0.08:
                step += 1 if rnd() < 0.5 else -1
            px = px + step
            rows[product].append({"date": ts, "contract_date": "202609", "futures_id": product, "price": px, "volume": volume})
    return {"rows": rows, "regime": regimes}


# ---------------------------------------------------------------- 網路：FinMind / Telegram
def _token() -> str:
    return os.environ.get("FINMIND_TOKEN", "").strip()


def finmind(endpoint: str, params: dict, timeout=60, retries=3) -> list:
    if requests is None:
        raise RuntimeError("需要 requests：pip install requests")
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    tok = _token()
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    last = None
    for i in range(retries):
        try:
            r = requests.get(f"{API}/{endpoint}", params=params, headers=headers, timeout=timeout)
            j = r.json()
            if j.get("status") == 200 or isinstance(j.get("data"), list):
                return j.get("data") or []
            last = j.get("msg") or j.get("error") or f"HTTP {r.status_code}"
            if re.search(r"illegal|permission|sponsor|付費|權限", str(last), re.I):
                break
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"FinMind {endpoint} 失敗：{last}")


def send_telegram(text: str) -> bool:
    bot = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not bot or not chat:
        print("[telegram] 未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID，略過：", text.replace("\n", " | ")[:120])
        return False
    if requests is None:
        raise RuntimeError("需要 requests")
    r = requests.post(f"https://api.telegram.org/bot{bot}/sendMessage",
                      json={"chat_id": chat, "text": text[:4000], "parse_mode": "HTML", "disable_web_page_preview": True}, timeout=20)
    ok = r.ok and r.json().get("ok")
    if not ok:
        print("[telegram] 失敗：", r.text[:200])
    return bool(ok)


def fetch_day_ticks(date: str) -> Dict[str, List[dict]]:
    out = {}
    for pid in ("TX", "MTX", "TMF"):
        print(f"  下載 {date} {pid} 逐筆…", flush=True)
        out[pid] = finmind("data", {"dataset": "TaiwanFuturesTick", "data_id": pid, "start_date": date, "end_date": date}, timeout=300)
        print(f"    {len(out[pid]):,} 筆")
    return out


def trading_days(start: str, end: str) -> List[str]:
    try:
        rows = finmind("data", {"dataset": "TaiwanStockTradingDate", "start_date": start, "end_date": end})
        days = [r["date"] for r in rows]
        if days:
            return days
    except Exception as e:  # noqa: BLE001
        print("交易日曆取得失敗，改用平日：", e)
    d = datetime.strptime(start, "%Y-%m-%d")
    e = datetime.strptime(end, "%Y-%m-%d")
    out = []
    while d <= e:
        if d.weekday() < 5:
            out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return out


def collect_days(start: str, end: str, cache_dir="data/ticks") -> List[dict]:
    os.makedirs(cache_dir, exist_ok=True)
    days = []
    for ds in trading_days(start, end):
        cache = os.path.join(cache_dir, f"{ds}.json")
        if os.path.exists(cache):
            with open(cache, encoding="utf-8") as f:
                rows = json.load(f)
        else:
            rows = fetch_day_ticks(ds)
            if sum(len(v) for v in rows.values()) > 100:
                with open(cache, "w", encoding="utf-8") as f:
                    json.dump(rows, f, ensure_ascii=False)
        trades = rows_to_trades(rows)
        if len(trades) > 100:
            days.append({"date": ds, "trades": trades})
        else:
            print(f"  {ds} 無逐筆資料（假日或尚未更新）")
    if not days:
        raise RuntimeError("沒有可用的交易日資料")
    return days


# ---------------------------------------------------------------- 指令
def fmt_signed(x, d=1):
    return f"{x:+,.{d}f}"


def cmd_backtest(args, params):
    days = collect_days(args.start, args.end)
    all_trades = []
    eq = 0.0; curve = []
    per_day = []
    for day in days:
        r = backtest_day(day["trades"], params)
        for t in r["trades"]:
            eq = js_round(eq + t["pnl"], 2)
            all_trades.append(dict(t, date=day["date"]))
            curve.append({"t": f"{day['date']} {t['exitTime']}", "eq": eq})
        per_day.append({"date": day["date"], "stats": r["stats"], "sentiment": sentiment(FlowBookTotals(day["trades"], params))})
        print(f"{day['date']}: {r['stats']['trades']} 筆 {fmt_signed(r['stats']['pnlPts'])} 點 勝率 {r['stats']['winRate']:.0%}")
    n = len(all_trades)
    wins = [t for t in all_trades if t["pnl"] > 0]
    gw = sum(t["pnl"] for t in wins); gl = -sum(t["pnl"] for t in all_trades if t["pnl"] <= 0)
    summary = {"days": len(days), "trades": n, "pnlPts": eq, "pnlNTD": int(eq * POINT_VALUE_NTD),
               "winRate": js_round(len(wins) / n, 4) if n else 0, "profitFactor": js_round(gw / gl, 3) if gl > 0 else None,
               "posDays": sum(1 for d in per_day if d["stats"]["pnlPts"] > 0)}
    out = {"generated": datetime.now(TZ_TAIPEI).isoformat(), "params": params, "summary": summary, "perDay": per_day, "trades": all_trades, "curve": curve}
    os.makedirs("data", exist_ok=True)
    with open("data/smartmoney_backtest.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print("\n== 回測摘要 ==")
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    print("已輸出 data/smartmoney_backtest.json")


def FlowBookTotals(trades, params):
    fb = FlowBook(params)
    fb.add_trades(trades)
    return fb.totals


def cmd_grid(args, params):
    days = collect_days(args.start, args.end)
    res = grid_search(days, None, params)
    os.makedirs("data", exist_ok=True)
    with open("data/smartmoney_grid.json", "w", encoding="utf-8") as f:
        json.dump({"generated": datetime.now(TZ_TAIPEI).isoformat(), "days": [d["date"] for d in days], "results": res[:50]}, f, ensure_ascii=False, indent=1)
    print(f"\n== 網格搜尋（{len(days)} 日 × {len(res)} 組）前 15 名 ==")
    print(f"{'#':>2} {'大單':>4} {'窗':>3} {'SMI':>4} {'停損':>4} {'停利':>4} {'損益':>8} {'次數':>4} {'勝率':>5} {'PF':>6} {'回撤':>6} 正報酬日")
    for i, r in enumerate(res[:15]):
        p = r["params"]
        print(f"{i+1:>2} {p['bigLot']:>4} {p['windowMin']:>3} {p['zEntry']:>4} {p['stopPts']:>4} {p['targetPts']:>4} {r['pnlPts']:>8.1f} {r['trades']:>4} {r['winRate']:>5.0%} {r['profitFactor']:>6} {r['maxDD']:>6.1f} {r['posDays']}/{r['days']}")
    print("已輸出 data/smartmoney_grid.json（⚠️ 注意過度配適：選穩定區間而非單一最佳值）")


def pick_near(rows: List[dict], prefix) -> Optional[dict]:
    prefixes = list(prefix) if isinstance(prefix, (list, tuple)) else [prefix]
    if "MXF" in prefixes or "MTX" in prefixes:
        prefixes = sorted(set(prefixes) | {"MXF", "MTX"})
    lst = [r for r in rows or [] if any(str(r.get("futures_id", "")).upper().startswith(p) for p in prefixes) and "/" not in str(r.get("futures_id", ""))]
    if not lst:
        return None
    lst.sort(key=lambda r: -float(r.get("total_volume") or 0))
    return lst[0]


TICK_CODES = {"TX": "TXFR1", "MTX": "MXFR1", "TMF": "TMFR1"}


def cmd_live(args, params):
    products = [("TX", ["TXF"]), ("MTX", ["MXF", "MTX"]), ("TMF", ["TMF"])]
    book = FlowBook(params)
    trader = PaperTrader(params)
    snaps: Dict[str, dict] = {}
    tick_cursor: Dict[str, dict] = {}
    tick_ok: Dict[str, bool] = {}
    tick_logged: Dict[str, bool] = {}
    use_ticks = not args.snapshot_only
    processed = -1
    last_mood = None
    signals: List[dict] = []
    day = datetime.now(TZ_TAIPEI).strftime("%Y-%m-%d")
    os.makedirs("data", exist_ok=True)
    print(f"即時模式啟動（每 {args.interval}s），日期 {day}，參數 {json.dumps(params, ensure_ascii=False)}")
    first_dump = True
    while True:
        now = datetime.now(TZ_TAIPEI)
        cur_min = now.hour * 60 + now.minute
        if now.strftime("%Y-%m-%d") != day:
            day = now.strftime("%Y-%m-%d"); book = FlowBook(params); trader = PaperTrader(params); snaps = {}; processed = -1; signals = []
            tick_cursor = {}; tick_ok = {}
        quotes = {}
        any_ok = False
        # 1) 盤中逐筆（完整成交 + TickType）
        if use_ticks:
            for key, _ in products:
                code = TICK_CODES[key]
                try:
                    rows = finmind("data", {"dataset": "TaiwanFutOptTick", "data_id": code, "start_date": day}, timeout=90, retries=1)
                    if rows and not tick_logged.get(key):
                        tick_logged[key] = True
                        print(f"{key} 逐筆 {code} 首列原始：{json.dumps(rows[0], ensure_ascii=False)[:300]}；共 {len(rows)} 列")
                    res = parse_futopt_tick_rows(rows, key, tick_cursor.get(key))
                    tick_cursor[key] = res["cursor"]
                    if res["trades"]:
                        book.add_trades(res["trades"])
                        if key == "TX":
                            cur_min = max(cur_min, res["trades"][-1]["minute"]) if res["trades"][-1]["minute"] <= cur_min else cur_min
                        any_ok = True
                    tick_ok[key] = bool(rows)
                except Exception as e:  # noqa: BLE001
                    if not tick_logged.get(key + ":err"):
                        tick_logged[key + ":err"] = True
                        print(f"[{now:%H:%M:%S}] {key} 逐筆 {code} 失敗：{e}（改用快照取樣）")
        # 2) 報價快照（逐筆正常時只更新報價，不重複累計流量）
        for key, snap_ids in products:
            try:
                row = None
                for snap_id in snap_ids:
                    rows = finmind("taiwan_futures_snapshot", {"data_id": snap_id}, timeout=15, retries=1)
                    row = pick_near(rows, snap_ids)
                    if row is not None:
                        break
                if row is None:
                    continue
                if first_dump:
                    print("首筆快照原始欄位：", json.dumps(row, ensure_ascii=False)[:600]); first_dump = False
                any_ok = True
                t = parse_tick_time(row.get("date"), cur_min)
                if key == "TX" and t["minute"] and not tick_ok.get("TX"):
                    cur_min = t["minute"]
                if not tick_ok.get(key):
                    trades = snapshot_to_trades(snaps.get(key), row, key, minute=t["minute"] or cur_min)
                    book.add_trades(trades)
                snaps[key] = row
                quotes[key] = {"price": row.get("close"), "chg": row.get("change_price"), "tv": row.get("total_volume"), "lastVol": row.get("volume"), "tick": row.get("TickType", row.get("tick_type")), "time": row.get("date"), "id": row.get("futures_id")}
            except Exception as e:  # noqa: BLE001
                print(f"[{now:%H:%M:%S}] {key} 快照失敗：{e}")
        if any_ok and book.bars:
            series = compute_series(book.bars, params)
            in_day = hhmm_to_min(params["sessionStart"]) <= cur_min <= hhmm_to_min(params["sessionEnd"])
            if in_day:
                for i, b in enumerate(book.bars):
                    if b["minute"] <= processed or b["minute"] >= cur_min or b["close"] is None:
                        continue
                    for e in trader.on_bar(b, series[i]):
                        ind = series[i]
                        e = dict(e, smi=ind["smi"], winBig=ind["winBig"], winRetail=ind["winRetail"], date=day)
                        e.pop("trade", None)
                        signals.append(e)
                        mood = sentiment(book.totals)
                        side_txt = "多" if e["side"] > 0 else "空"
                        if e["type"] == "entry":
                            stop = e["price"] - e["side"] * params["stopPts"]; tgt = e["price"] + e["side"] * params["targetPts"]
                            msg = (f"🔔 <b>台指期聰明錢訊號</b>\n{day} {e['time']}  <b>{side_txt}單進場 @ {e['price']:,.0f}</b>\n"
                                   f"SMI {ind['smi']:+.2f}（大單淨流 {ind['winBig']:+.1f} 口 / 散戶淨流 {ind['winRetail']:+.1f} 口）\n"
                                   f"大戶心態 {mood['score']} 分（{mood['label']}）\n停損 {stop:,.0f} / 停利 {tgt:,.0f}\n{e['reason']}")
                        else:
                            msg = (f"✅ <b>台指期模擬出場</b>\n{day} {e['time']}  {side_txt}單出場 @ {e['price']:,.0f}\n"
                                   f"損益 <b>{e['pnl']:+.1f} 點</b>（{e['pnl'] * POINT_VALUE_NTD:+,.0f} 元）· 原因：{e['reason']}\n"
                                   f"今日累計 {trader.equity:+.1f} 點 / {len(trader.trades)} 筆")
                        print(f"[{now:%H:%M:%S}] {msg.splitlines()[1]}")
                        send_telegram(msg)
                    processed = b["minute"]
            mood = sentiment(book.totals)
            if mood["label"] != "樣本不足" and last_mood and last_mood["tone"] != mood["tone"]:
                send_telegram(f"🧭 <b>大戶心態轉變</b>\n{day} {series[-1]['time']}  {last_mood['label']} → <b>{mood['label']}</b>（{mood['score']} 分）\n"
                              f"大單淨買比 {mood['bigRatio'] * 100:+.1f}% / 散戶淨買比 {mood['retailRatio'] * 100:+.1f}%\n{mood['divergence']}")
            if mood["label"] != "樣本不足":
                last_mood = mood
            state = {"updated": now.isoformat(), "date": day, "quotes": quotes, "totals": book.totals, "sentiment": mood,
                     "series": series[-400:], "signals": signals[-100:], "position": trader.pos, "trades": trader.trades, "stats": trader.stats(), "params": params}
            with open("data/smartmoney_live.json", "w", encoding="utf-8") as f:
                json.dump(state, f, ensure_ascii=False)
            ind = series[-1]
            src = "逐筆" if tick_ok.get("TX") else "快照取樣"
            print(f"[{now:%H:%M:%S}] [{src}] TX {quotes.get('TX', {}).get('price')} SMI {ind['smi']:+.2f} 大單淨 {book.totals['bigBuy'] - book.totals['bigSell']:+.0f} "
                  f"散戶淨 {book.totals['smallBuy'] - book.totals['smallSell']:+.1f} 心態 {mood['score']} {mood['label']} 模擬 {trader.equity:+.1f}")
        if args.once:
            break
        time.sleep(args.interval)


def cmd_selftest(_args, _params) -> int:
    fails = 0

    def ok(name, cond, extra=""):
        nonlocal fails
        print(("✅" if cond else "❌"), name, extra)
        if not cond:
            fails += 1
    ok("分類：TX 10 口 = big", classify("TX", 10) == "big")
    ok("分類：TX 9 口 = mid / TX 1 口 = small / MTX = small", classify("TX", 9) == "mid" and classify("TX", 1) == "small" and classify("MXF", 99) == "small")
    ok("契約權重", contract_weight("MXF") == 0.25 and contract_weight("TMFI6") == 0.025 and contract_weight("TXF") == 1)
    ok("Tick Rule", tick_side(101, 100, 0) == 1 and tick_side(99, 100, 0) == -1 and tick_side(100, 100, -1) == -1 and tick_side(100, None, 0) == 0)
    t = parse_tick_time("2026-09-07 08:45:30.500")
    ok("時間解析", t["minute"] == 525 and t["ms"] == 31530500, str(t))
    ok("近月契約排除價差", select_near_contract([{"contract_date": "202609/202610", "volume": 999}, {"contract_date": "202609", "volume": 10}, {"contract_date": "202610", "volume": 5}]) == "202609")
    prev = {"close": 24000, "total_volume": 1000, "total_amount": 1000 * 24000 * 200}
    cur = {"close": 24001, "total_volume": 1100, "volume": 5, "TickType": 0, "buy_price": 24000, "sell_price": 24001,
           "total_amount": prev["total_amount"] + 100 * 24000.9 * 200, "date": "2026-09-07 09:00:10"}
    st = snapshot_to_trades(prev, cur, "TXF")
    ok("快照差量：取樣 5 口 + 未取樣 95 口(區間均價偏買)", len(st) == 2 and st[0]["volume"] == 5 and st[0]["side"] == 1 and st[1]["volume"] == 95 and st[1]["side"] == 1 and st[1]["forceSmall"])
    cur2 = dict(cur, total_amount=prev["total_amount"] + 100 * 24000.1 * 200)
    ok("未取樣量區間均價偏賣 → -1", snapshot_to_trades(prev, cur2, "TXF")[1]["side"] == -1)
    fo_rows = [
        {"date": "2026-09-07", "Time": "08:45:00.123", "Close": [47300, 47301], "Volume": [3, 12], "TickType": 1},
        {"date": "2026-09-07", "Time": "08:45:01.500", "Close": "[47299]", "Volume": "[2]", "TickType": 2},
        {"date": "2026-09-07", "Time": "084502", "Close": 47299, "Volume": 1, "TickType": 0},
    ]
    r1 = parse_futopt_tick_rows(fo_rows, "TXFR1", None)
    ok("逐筆解析：三種格式共 4 筆", len(r1["trades"]) == 4 and r1["trades"][1]["volume"] == 12 and r1["trades"][1]["side"] == 1 and r1["trades"][3]["side"] == -1)
    r2 = parse_futopt_tick_rows(fo_rows + [{"date": "2026-09-07", "Time": "08:45:03", "Close": [47305], "Volume": [20], "TickType": 1}], "TXFR1", r1["cursor"])
    ok("逐筆解析：累加式只處理新增列", len(r2["trades"]) == 1 and r2["trades"][0]["volume"] == 20 and r2["cursor"]["n"] == 4)
    ok("逐筆解析：列數變少重置", len(parse_futopt_tick_rows(fo_rows[:1], "TXFR1", r2["cursor"])["trades"]) == 2)
    ok("時間格式 HHMMSSmmm", parse_futopt_time("2026-09-07", "110759569")["ms"] == ((11 * 60 + 7) * 60 + 59) * 1000 + 569)
    # 合成資料
    syn = synthetic_day(7)
    trades = rows_to_trades(syn["rows"])
    ok("合成逐筆數量與排序", len(trades) > 5000 and all(trades[i]["ms"] >= trades[i - 1]["ms"] for i in range(1, len(trades))), f"{len(trades)} 筆")
    r = backtest_day(trades, {})
    ok("回測 bars/series", len(r["bars"]) >= 290 and len(r["series"]) == len(r["bars"]))
    agree = n = 0
    for i, s in enumerate(r["series"]):
        if syn["regime"][i] and abs(s["winBig"]) > 5:
            n += 1
            if (s["winBig"] > 0) - (s["winBig"] < 0) == syn["regime"][i]:
                agree += 1
    ok(f"大單淨流與隱含趨勢一致率 {agree / n:.0%} (> 58%)", agree / n > 0.58)
    ok("損益恆等式", abs(sum(t["pnl"] for t in r["trades"]) - r["stats"]["pnlPts"]) < 1e-6 and all(abs(((t["exit"] - t["entry"]) * t["side"] - 1.5) - t["pnl"]) < 1e-6 for t in r["trades"]))
    ok("停損虧損上限", all(t["pnl"] >= -(30 + 1.5) - 1e-6 for t in r["trades"] if t["reason"] == "stop"))
    g = grid_search([{"date": "a", "trades": trades}], {"bigLot": [10], "windowMin": [10], "zEntry": [1.5], "stopPts": [30], "targetPts": [60]}, {})
    ok("網格單組 = 單日回測", len(g) == 1 and g[0]["pnlPts"] == r["stats"]["pnlPts"])
    m = sentiment(FlowBookTotals(trades, {}))
    ok("大戶心態評分", 0 <= m["score"] <= 100 and m["label"] != "樣本不足", json.dumps(m, ensure_ascii=False))
    # 跨語言比對輸出
    parity = {}
    for seed in (1, 2, 3, 7, 42, 99):
        tr = rows_to_trades(synthetic_day(seed)["rows"])
        rr = backtest_day(tr, {})
        parity[str(seed)] = {"trades": rr["stats"]["trades"], "pnlPts": rr["stats"]["pnlPts"], "nTrades": len(tr),
                             "lastSmi": rr["series"][-1]["smi"], "totals": {k: js_round(v, 3) for k, v in FlowBookTotals(tr, {}).items()}}
    days = [{"date": f"d{s}", "trades": rows_to_trades(synthetic_day(s)["rows"])} for s in (1, 2, 3)]
    gg = grid_search(days, {"bigLot": [5, 10], "windowMin": [5, 10], "zEntry": [1, 1.5], "stopPts": [30], "targetPts": [60]}, {})
    parity["futopt"] = parse_futopt_tick_rows([
        {"date": "2026-09-07", "Time": "08:45:00.123", "Close": [47300, 47301], "Volume": [3, 12], "TickType": 1},
        {"date": "2026-09-07", "Time": "08:45:01.500", "Close": "[47299]", "Volume": "[2]", "TickType": 2},
        {"date": "2026-09-07", "Time": "084502", "Close": 47299, "Volume": 1, "TickType": 0},
    ], "TXFR1", None)["trades"]
    parity["grid"] = [{"params": x["params"], "pnlPts": x["pnlPts"], "trades": x["trades"], "maxDD": x["maxDD"]} for x in gg]
    os.makedirs("data", exist_ok=True)
    with open(os.environ.get("SM_PARITY_OUT", "data/parity_py.json"), "w", encoding="utf-8") as f:
        json.dump(parity, f, ensure_ascii=False, indent=1)
    print(f"\n自測完成，失敗 {fails} 項；跨語言比對輸出 {os.environ.get('SM_PARITY_OUT', 'data/parity_py.json')}")
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser(description="台指期聰明錢引擎")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--backtest", nargs=2, metavar=("START", "END"))
    ap.add_argument("--grid", nargs=2, metavar=("START", "END"))
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--once", action="store_true", help="live 只跑一輪（觀察原始欄位）")
    ap.add_argument("--interval", type=int, default=10)
    ap.add_argument("--snapshot-only", action="store_true", help="live 不用逐筆 TaiwanFutOptTick，只用快照取樣（不建議）")
    ap.add_argument("--telegram-test", action="store_true")
    ap.add_argument("--params", help="JSON 字串覆寫參數，例 '{\"bigLot\":20,\"zEntry\":2}'")
    ap.add_argument("--params-file", help="從 JSON 檔（例 data/smartmoney_grid.json 的 results[0].params）讀參數")
    a = ap.parse_args()
    params = merge_params(None)
    if a.params_file:
        with open(a.params_file, encoding="utf-8") as f:
            j = json.load(f)
        params = merge_params(j.get("results", [{}])[0].get("params") if "results" in j else j)
    if a.params:
        params = merge_params(dict(params, **json.loads(a.params)))
    if a.selftest:
        sys.exit(cmd_selftest(a, params))
    if a.telegram_test:
        sys.exit(0 if send_telegram(f"🧪 聰明錢引擎測試 {datetime.now(TZ_TAIPEI):%Y-%m-%d %H:%M:%S}") else 1)
    if not _token() and (a.backtest or a.grid or a.live):
        print("請設定環境變數 FINMIND_TOKEN（付費 / sponsor 方案）"); sys.exit(2)
    if a.backtest:
        a.start, a.end = a.backtest; cmd_backtest(a, params)
    elif a.grid:
        a.start, a.end = a.grid; cmd_grid(a, params)
    elif a.live:
        cmd_live(a, params)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
