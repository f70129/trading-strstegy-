#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
台指期「機率優勢」引擎（Probability Edge Engine）

把 Polymarket「BTC 每小時漲跌」那套原理搬到台指期，並用回測檢驗它到底有沒有優勢：

  1. 回合（Round）    ：日盤 08:45–13:45 切成每 W 分鐘一回合（預設 60 分 → 一天 5 回合），
                         回合開盤價 = Price to Beat。
  2. 訊號節點（Nodes）：在回合內的決策點（預設第 15/30/45 分）計算多個多空訊號：
                         距回合開盤 z、5 分動能、距當日開盤 z、VWAP 乖離、區間位置、跳空、
                         大單 / 散戶流向（有逐筆資料時）。每個節點對機率的貢獻就是「多 / 空路徑」。
  3. 機率模型          ：(a) 邏輯迴歸  (b) 類比路徑（kNN：找歷史上最像的 K 個情境，數幾條往上、幾條往下）
                         兩者平均 = P(上漲)。
  4. 優勢 vs 成本      ：期貨沒有「盤口賣 53¢」，公平價就是 50%；|P − 0.5| ≥ 門檻才進場，
                         並扣掉手續費 + 期交稅 + 滑價（點數）。持有到回合結束。
  5. 大數法則檢驗      ：只看 walk-forward 樣本外結果：Brier 分數是否勝過 0.5 基準、交易 t 值、
                         機率校準格（Probability Lattice）、各門檻的淨損益。

用法：
  python edge_engine.py --selftest                                  # 單元測試 + 正 / 負對照組（免網路）
  python edge_engine.py --demo                                       # 合成資料示範完整回測 → edge.json
  python edge_engine.py --backtest-csv bars.csv                      # 用券商匯出的 1 分 K（datetime,open,high,low,close,volume）
  python edge_engine.py --backtest 2025-11-01 2026-11-10             # FinMind 逐筆（sponsor）→ 1 分 K + 大小單流向
  python edge_engine.py --live                                       # 盤中即時：每回合的 P(上漲)、建議、Telegram
  參數覆寫：--params '{"roundMin":30,"decisions":[10,20],"threshold":0.06}'

輸出：edge.json（回測結果，供 edge.html 顯示）、data/edge_model.json（即時用模型）、data/edge_live.json
依賴：requests（FinMind / Telegram）、numpy（kNN 類比路徑；沒有則只用邏輯迴歸）
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import sys
import time
from datetime import datetime
from typing import Dict, List, Optional, Tuple

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

import smartmoney_engine as sm

VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(HERE, "edge.json")
MODEL_JSON = os.path.join(HERE, "data", "edge_model.json")
LIVE_JSON = os.path.join(HERE, "data", "edge_live.json")
BAR_CACHE = os.path.join(HERE, "data", "edge_bars")

CONTRACTS = {  # 每點價值（新台幣）
    "TX": 200, "MTX": 50, "TMF": 10,
}

DEFAULT_PARAMS = {
    "sessionStart": "08:45", "sessionEnd": "13:45",
    "roundMin": 60,                 # 回合長度（分）
    "decisions": [15, 30, 45],      # 回合內的決策點（第幾分鐘）
    "threshold": 0.05,              # |P − 0.5| 至少多少才進場
    "contract": "MTX",
    "feeNtd": 25,                   # 單邊手續費（新台幣 / 口）
    "taxRate": 0.00002,             # 期交稅（單邊，契約價值 × 十萬分之二）
    "slipPts": 1.0,                 # 單邊滑價（點）
    "sigmaDays": 20,                # 估 1 分鐘波動的回看天數
    "minHistoryDays": 5,            # 少於此天數的歷史不產生樣本
    "minTrainDays": 60,             # walk-forward 最少訓練天數
    "refitDays": 20,                # 每幾天重新訓練
    "l2": 1.0,                      # 邏輯迴歸 L2 懲罰
    "knnK": 60,                     # 類比路徑數
    "knnWeight": 0.5,               # 集成中 kNN 權重（0 = 只用邏輯迴歸）
    "flowWin": 10,                  # 流向累計視窗（分）
}

BASE_FEATURES = ["zRef", "mom5", "zDay", "vwapDev", "rangePos", "gap"]
FLOW_FEATURES = ["flowBig", "flowRetail"]
FEATURE_LABEL = {
    "zRef": "距回合開盤 (z)", "mom5": "5 分動能 (z)", "zDay": "距當日開盤 (z)", "vwapDev": "VWAP 乖離 (z)",
    "rangePos": "日內區間位置", "gap": "開盤跳空 (z)", "flowBig": "大單淨流向 (z)", "flowRetail": "散戶淨流向 (z)",
}


def merge_params(p: Optional[dict]) -> dict:
    out = dict(DEFAULT_PARAMS)
    if p:
        out.update(p)
    return out


def hhmm(s: str) -> int:
    return sm.hhmm_to_min(s)


def clip(x: float, lo=-4.0, hi=4.0) -> float:
    return lo if x < lo else hi if x > hi else x


def cost_points(price: float, p: dict) -> float:
    """來回一趟的總成本（點）：手續費×2 + 期交稅×2 + 滑價×2"""
    pv = CONTRACTS.get(p["contract"], 50)
    fee = 2 * p["feeNtd"] / pv
    tax = 2 * price * p["taxRate"]  # price*pv*rate / pv
    return fee + tax + 2 * p["slipPts"]


# ================================================================ 資料：日 → 1 分 K
# day = {"date": "YYYY-MM-DD", "bars": [{minute, open, high, low, close, vol, bigNet?, retailNet?}], "hasFlow": bool}

def load_csv_days(path: str, p: dict) -> List[dict]:
    """券商 / 看盤軟體匯出的 1 分 K。欄位名稱不分大小寫：
       datetime 或 (date + time)、open、high、low、close、volume（可缺）。只取日盤。"""
    s0, s1 = hhmm(p["sessionStart"]), hhmm(p["sessionEnd"])
    by_day: Dict[str, List[dict]] = {}
    with open(path, encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        for raw in rd:
            r = {k.strip().lower(): (v or "").strip() for k, v in raw.items() if k}
            ts = r.get("datetime") or r.get("timestamp") or (r.get("date", "") + " " + r.get("time", ""))
            ts = ts.replace("/", "-").replace("T", " ").strip()
            parts = ts.split()
            if len(parts) < 2:
                continue
            d = parts[0]
            hm = parts[1].split(":")
            try:
                minute = int(hm[0]) * 60 + int(hm[1])
                o, h, l, c = (float(r[k]) for k in ("open", "high", "low", "close"))
            except (ValueError, KeyError, IndexError):
                continue
            if minute < s0 or minute > s1:
                continue
            vol = float(r.get("volume") or r.get("vol") or 0)
            by_day.setdefault(d, []).append({"minute": minute, "open": o, "high": h, "low": l, "close": c, "vol": vol})
    days = []
    for d in sorted(by_day):
        bars = sorted(by_day[d], key=lambda b: b["minute"])
        if len(bars) >= 30:
            days.append({"date": d, "bars": bars, "hasFlow": False})
    return days


def bars_from_trades(trades: List[dict]) -> List[dict]:
    bars = sm.build_bars(trades)
    out = []
    for b in bars:
        out.append({
            "minute": b["minute"], "open": b["open"], "high": b["high"], "low": b["low"], "close": b["close"],
            "vol": b["vol"], "bigNet": round(b["bigBuy"] - b["bigSell"], 3), "retailNet": round(b["smallBuy"] - b["smallSell"], 3),
        })
    return out


def load_finmind_days(start: str, end: str) -> List[dict]:
    """FinMind TaiwanFuturesTick（TX/MTX/TMF）→ 1 分 K + 大小單流向，壓縮快取在 data/edge_bars/"""
    os.makedirs(BAR_CACHE, exist_ok=True)
    days = []
    for ds in sm.trading_days(start, end):
        cache = os.path.join(BAR_CACHE, f"{ds}.json")
        if os.path.exists(cache):
            with open(cache, encoding="utf-8") as f:
                bars = json.load(f)
        else:
            try:
                rows = sm.fetch_day_ticks(ds)
            except Exception as e:  # noqa: BLE001
                print(f"  {ds} 下載失敗：{e}")
                continue
            trades = sm.rows_to_trades(rows)
            bars = bars_from_trades(trades) if len(trades) > 100 else []
            if bars:
                with open(cache, "w", encoding="utf-8") as f:
                    json.dump(bars, f, separators=(",", ":"))
        if len(bars) >= 30:
            days.append({"date": ds, "bars": bars, "hasFlow": True})
        else:
            print(f"  {ds} 無資料（假日或尚未更新）")
    return days


def synthetic_days(n_days=300, seed=7, edge=0.0, sigma=6.0, start_price=22000.0) -> List[dict]:
    """合成 1 分 K。edge=0 → 純隨機漫步（負對照組，不應找到優勢）；
       edge>0 → 加入「大單流向領先價格」的可預測成分（正對照組，應找到優勢）。"""
    rnd = random.Random(seed)
    s0, s1 = hhmm("08:45"), hhmm("13:45")
    px = start_price
    days = []
    for d in range(n_days):
        date = f"S{d:04d}"
        px += rnd.gauss(0, sigma * 8)  # 隔夜跳空
        bars = []
        flow_state = 0.0
        for m in range(s0, s1 + 1):
            flow_state = 0.9 * flow_state + rnd.gauss(0, 1)
            big = flow_state * 20 + rnd.gauss(0, 10)
            retail = -0.3 * big + rnd.gauss(0, 15)
            drift = edge * sigma * flow_state / 2.3
            o = px
            path = [o]
            for _ in range(4):
                px += rnd.gauss(drift / 4, sigma / 2)
                path.append(px)
            c = round(px)
            px = c
            bars.append({"minute": m, "open": round(o), "high": round(max(path)), "low": round(min(path)), "close": c,
                         "vol": 500 + rnd.random() * 500, "bigNet": round(big, 3), "retailNet": round(retail, 3)})
        days.append({"date": date, "bars": bars, "hasFlow": True})
    return days


# ================================================================ 特徵 / 樣本
def day_sigma(bars: List[dict]) -> Tuple[float, int]:
    """回傳 (Σ diff², n) 供跨日彙總"""
    s, n = 0.0, 0
    for i in range(1, len(bars)):
        d = bars[i]["close"] - bars[i - 1]["close"]
        s += d * d
        n += 1
    return s, n


def flow_sigma(bars: List[dict], key: str, win: int) -> Tuple[float, int]:
    s, n = 0.0, 0
    for b in bars:
        v = b.get(key)
        if v is None:
            continue
        s += v * v
        n += 1
    return s, n


class DayContext:
    """一天內逐分鐘累計的狀態：VWAP、高低點、流向累計（只用當下之前的資料，避免偷看未來）"""

    def __init__(self, bars: List[dict]):
        self.bars = bars
        self.cum_pv = []
        self.cum_v = []
        self.hi = []
        self.lo = []
        pv = v = 0.0
        hi, lo = -math.inf, math.inf
        for b in bars:
            w = b.get("vol") or 1.0
            tp = (b["high"] + b["low"] + b["close"]) / 3
            pv += tp * w
            v += w
            hi = max(hi, b["high"])
            lo = min(lo, b["low"])
            self.cum_pv.append(pv)
            self.cum_v.append(v)
            self.hi.append(hi)
            self.lo.append(lo)
        self.idx_by_min = {b["minute"]: i for i, b in enumerate(bars)}

    def last_index_before(self, minute: int) -> Optional[int]:
        """最後一根 minute < 給定分鐘 的 K 棒索引"""
        best = None
        for i, b in enumerate(self.bars):
            if b["minute"] < minute:
                best = i
            else:
                break
        return best


def compute_features(ctx: DayContext, i: int, ref: float, round_start: int, day_open: float, prev_close: Optional[float],
                     sig: float, fsig_big: float, fsig_ret: float, has_flow: bool, p: dict) -> Dict[str, float]:
    bars = ctx.bars
    b = bars[i]
    px = b["close"]
    s0 = hhmm(p["sessionStart"])
    elapsed_round = max(1, b["minute"] + 1 - round_start)
    elapsed_day = max(1, b["minute"] + 1 - s0)
    j = max(0, i - 5)
    vwap = ctx.cum_pv[i] / ctx.cum_v[i] if ctx.cum_v[i] > 0 else px
    rng = ctx.hi[i] - ctx.lo[i]
    f = {
        "zRef": clip((px - ref) / (sig * math.sqrt(elapsed_round))),
        "mom5": clip((px - bars[j]["close"]) / (sig * math.sqrt(max(1, i - j)))) if i > j else 0.0,
        "zDay": clip((px - day_open) / (sig * math.sqrt(elapsed_day))),
        "vwapDev": clip((px - vwap) / (sig * math.sqrt(10))),
        "rangePos": ((px - ctx.lo[i]) / rng - 0.5) * 2 if rng > 0 else 0.0,
        "gap": clip((day_open - prev_close) / (sig * math.sqrt(300))) if prev_close else 0.0,
    }
    if has_flow:
        W = p["flowWin"]
        lo = max(0, i - W + 1)
        wb = sum(bars[k].get("bigNet", 0.0) for k in range(lo, i + 1))
        wr = sum(bars[k].get("retailNet", 0.0) for k in range(lo, i + 1))
        n = i - lo + 1
        f["flowBig"] = clip(wb / (fsig_big * math.sqrt(n))) if fsig_big > 0 else 0.0
        f["flowRetail"] = clip(wr / (fsig_ret * math.sqrt(n))) if fsig_ret > 0 else 0.0
    return f


def rounds_of_day(p: dict) -> List[Tuple[int, int]]:
    s0, s1 = hhmm(p["sessionStart"]), hhmm(p["sessionEnd"])
    W = int(p["roundMin"])
    out = []
    s = s0
    while s < s1:
        e = min(s + W, s1)
        if e - s >= max(p["decisions"]) + 1:
            out.append((s, e))
        s += W
    return out


def build_samples(days: List[dict], p: dict) -> Tuple[List[dict], List[str]]:
    """每個 (日, 回合, 決策點) 一筆樣本。σ 用前 sigmaDays 天估計（不含當日）。"""
    has_flow = all(d.get("hasFlow") for d in days) and bool(days)
    feats = BASE_FEATURES + (FLOW_FEATURES if has_flow else [])
    s1 = hhmm(p["sessionEnd"])
    hist: List[Tuple[float, int, float, int, float, int]] = []
    samples = []
    prev_close = None
    for d in days:
        bars = d["bars"]
        if len(hist) >= p["minHistoryDays"]:
            recent = hist[-p["sigmaDays"]:]
            ss = sum(h[0] for h in recent); nn = sum(h[1] for h in recent)
            sig = math.sqrt(ss / nn) if nn else 0.0
            fb = math.sqrt(sum(h[2] for h in recent) / max(1, sum(h[3] for h in recent)))
            fr = math.sqrt(sum(h[4] for h in recent) / max(1, sum(h[5] for h in recent)))
            if sig > 0:
                ctx = DayContext(bars)
                day_open = bars[0]["open"]
                for (rs, re_) in rounds_of_day(p):
                    in_round = [k for k, b in enumerate(bars) if rs <= b["minute"] < re_ or (re_ == s1 and b["minute"] == s1)]
                    if len(in_round) < 5:
                        continue
                    ref = bars[in_round[0]]["open"]
                    exit_px = bars[in_round[-1]]["close"]
                    for dec in p["decisions"]:
                        i = ctx.last_index_before(rs + dec)
                        if i is None or i < in_round[0] or i >= in_round[-1]:
                            continue
                        px = bars[i]["close"]
                        f = compute_features(ctx, i, ref, rs, day_open, prev_close, sig, fb, fr, has_flow, p)
                        fwd = exit_px - px
                        samples.append({
                            "date": d["date"], "round": f"{sm.min_to_hhmm(rs)}-{sm.min_to_hhmm(re_)}", "dec": dec,
                            "time": sm.min_to_hhmm(bars[i]["minute"] + 1), "px": px, "ref": ref, "exit": exit_px,
                            "fwd": fwd, "y": 1 if fwd > 0 else 0 if fwd < 0 else None,
                            "x": [f[k] for k in feats],
                        })
        a, b_ = day_sigma(bars)
        fa, fb_ = flow_sigma(bars, "bigNet", 1)
        ra, rb = flow_sigma(bars, "retailNet", 1)
        hist.append((a, b_, fa, fb_, ra, rb))
        prev_close = bars[-1]["close"]
    return samples, feats


# ================================================================ 模型
def _solve(A: List[List[float]], b: List[float]) -> List[float]:
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-12:
            continue
        inv = 1.0 / M[c][c]
        for r in range(n):
            if r != c and M[r][c] != 0:
                fct = M[r][c] * inv
                for k in range(c, n + 1):
                    M[r][k] -= fct * M[c][k]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-12 else 0.0 for i in range(n)]


def sigmoid(z: float) -> float:
    if z >= 0:
        return 1 / (1 + math.exp(-z))
    e = math.exp(z)
    return e / (1 + e)


def fit_logistic(X: List[List[float]], y: List[int], l2=1.0, iters=30) -> dict:
    k = len(X[0])
    mu = [sum(r[j] for r in X) / len(X) for j in range(k)]
    sd = [math.sqrt(sum((r[j] - mu[j]) ** 2 for r in X) / max(1, len(X) - 1)) or 1.0 for j in range(k)]
    Z = [[1.0] + [(r[j] - mu[j]) / sd[j] for j in range(k)] for r in X]
    w = [0.0] * (k + 1)
    for _ in range(iters):
        g = [0.0] * (k + 1)
        H = [[0.0] * (k + 1) for _ in range(k + 1)]
        for zi, yi in zip(Z, y):
            pi = sigmoid(sum(a * b for a, b in zip(w, zi)))
            r = yi - pi
            wt = pi * (1 - pi)
            for a in range(k + 1):
                g[a] += r * zi[a]
                za = zi[a] * wt
                Ha = H[a]
                for b in range(a, k + 1):
                    Ha[b] += za * zi[b]
        for a in range(k + 1):
            for b in range(a):
                H[a][b] = H[b][a]
        for a in range(1, k + 1):
            g[a] -= l2 * w[a]
            H[a][a] += l2
        step = _solve(H, g)
        w = [a + b for a, b in zip(w, step)]
        if max(abs(s) for s in step) < 1e-7:
            break
    return {"w": w, "mu": mu, "sd": sd}


def predict_logistic(m: dict, x: List[float]) -> Tuple[float, List[float]]:
    z = [(x[j] - m["mu"][j]) / m["sd"][j] for j in range(len(x))]
    contrib = [m["w"][j + 1] * z[j] for j in range(len(z))]
    return sigmoid(m["w"][0] + sum(contrib)), contrib


class KnnPaths:
    """類比路徑：在標準化特徵空間找最像的 K 個歷史情境，數幾條往上（多頭路徑）幾條往下（空頭路徑）。"""

    def __init__(self, X: List[List[float]], y: List[int], mu, sd, k=60):
        self.ok = np is not None and len(X) >= k
        self.k = k
        if self.ok:
            self.mu = np.array(mu); self.sd = np.array(sd)
            self.X = (np.array(X) - self.mu) / self.sd
            self.y = np.array(y, dtype=float)

    def predict(self, x: List[float]) -> Tuple[Optional[float], int, int]:
        if not self.ok:
            return None, 0, 0
        z = (np.array(x) - self.mu) / self.sd
        d = ((self.X - z) ** 2).sum(axis=1)
        idx = np.argpartition(d, self.k)[: self.k]
        bull = int(self.y[idx].sum())
        bear = self.k - bull
        return (bull + 1) / (self.k + 2), bull, bear  # Laplace 平滑

    def predict_many(self, Xq: List[List[float]]) -> List[Tuple[Optional[float], int, int]]:
        if not self.ok:
            return [(None, 0, 0)] * len(Xq)
        Z = (np.array(Xq) - self.mu) / self.sd
        out = []
        for s in range(0, len(Z), 256):
            blk = Z[s:s + 256]
            d = (blk ** 2).sum(1)[:, None] - 2 * blk @ self.X.T + (self.X ** 2).sum(1)[None, :]
            idx = np.argpartition(d, self.k, axis=1)[:, : self.k]
            bull = self.y[idx].sum(1)
            for b in bull:
                out.append(((b + 1) / (self.k + 2), int(b), self.k - int(b)))
        return out


def ensemble(p_log: float, p_knn: Optional[float], wk: float) -> float:
    if p_knn is None:
        return p_log
    return (1 - wk) * p_log + wk * p_knn


# ================================================================ Walk-forward 回測
def walk_forward(samples: List[dict], p: dict) -> List[dict]:
    dates = sorted({s["date"] for s in samples})
    if len(dates) <= p["minTrainDays"]:
        raise RuntimeError(f"交易日太少：{len(dates)} 天（需 > minTrainDays={p['minTrainDays']}）")
    by_date: Dict[str, List[dict]] = {}
    for s in samples:
        by_date.setdefault(s["date"], []).append(s)
    out = []
    i = p["minTrainDays"]
    while i < len(dates):
        train_dates = dates[:i]
        test_dates = dates[i:i + p["refitDays"]]
        train = [s for d in train_dates for s in by_date[d] if s["y"] is not None]
        X = [s["x"] for s in train]
        y = [s["y"] for s in train]
        m = fit_logistic(X, y, p["l2"])
        knn = KnnPaths(X, y, m["mu"], m["sd"], p["knnK"])
        test = [s for d in test_dates for s in by_date[d]]
        kp = knn.predict_many([s["x"] for s in test])
        for s, (pk, bull, bear) in zip(test, kp):
            pl, _ = predict_logistic(m, s["x"])
            out.append(dict(s, pLog=pl, pKnn=pk, bull=bull, bear=bear, p=ensemble(pl, pk, p["knnWeight"])))
        i += p["refitDays"]
    return out


def simulate_trades(preds: List[dict], p: dict, threshold: Optional[float] = None) -> List[dict]:
    th = p["threshold"] if threshold is None else threshold
    pv = CONTRACTS.get(p["contract"], 50)
    trades = []
    taken = set()
    for s in preds:  # preds 依日期、回合、決策點排序
        key = (s["date"], s["round"])
        if key in taken:
            continue
        edge = s["p"] - 0.5
        if abs(edge) < th or (th == 0 and edge == 0):
            continue
        side = 1 if edge > 0 else -1
        cost = cost_points(s["px"], p)
        gross = side * s["fwd"]
        net = gross - cost
        taken.add(key)
        trades.append({"date": s["date"], "round": s["round"], "time": s["time"], "side": side, "p": round(s["p"], 4),
                       "entry": s["px"], "exit": s["exit"], "ref": s["ref"], "grossPts": round(gross, 2),
                       "netPts": round(net, 2), "netNtd": round(net * pv)})
    return trades


def trade_stats(trades: List[dict], p: dict) -> dict:
    n = len(trades)
    if n == 0:
        return {"n": 0}
    pv = CONTRACTS.get(p["contract"], 50)
    net = [t["netPts"] for t in trades]
    gross = [t["grossPts"] for t in trades]
    wins = [x for x in net if x > 0]
    losses = [x for x in net if x <= 0]
    mean = sum(net) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in net) / (n - 1)) if n > 1 else 0.0
    by_day: Dict[str, float] = {}
    for t in trades:
        by_day[t["date"]] = by_day.get(t["date"], 0.0) + t["netPts"]
    dvals = list(by_day.values())
    dm = sum(dvals) / len(dvals)
    dsd = math.sqrt(sum((x - dm) ** 2 for x in dvals) / (len(dvals) - 1)) if len(dvals) > 1 else 0.0
    eq = peak = mdd = 0.0
    for x in net:
        eq += x
        peak = max(peak, eq)
        mdd = max(mdd, peak - eq)
    return {
        "n": n, "winRate": round(len(wins) / n, 4),
        "grossWinRate": round(sum(1 for x in gross if x > 0) / n, 4),
        "avgGrossPts": round(sum(gross) / n, 3), "avgNetPts": round(mean, 3),
        "totalNetPts": round(sum(net), 1), "totalNetNtd": round(sum(net) * pv),
        "avgWinPts": round(sum(wins) / len(wins), 2) if wins else 0.0,
        "avgLossPts": round(sum(losses) / len(losses), 2) if losses else 0.0,
        "profitFactor": round(sum(wins) / -sum(losses), 3) if losses and sum(losses) < 0 else None,
        "tStat": round(mean / (sd / math.sqrt(n)), 3) if sd > 0 else None,
        "sharpeAnnual": round(dm / dsd * math.sqrt(250), 3) if dsd > 0 else None,
        "maxDrawdownPts": round(mdd, 1), "maxDrawdownNtd": round(mdd * pv),
        "tradingDays": len(by_day),
    }


def prob_metrics(preds: List[dict]) -> dict:
    lab = [s for s in preds if s["y"] is not None]
    n = len(lab)
    if n == 0:
        return {"n": 0}
    base_rate = sum(s["y"] for s in lab) / n

    def brier(key):
        return sum((s[key] - s["y"]) ** 2 for s in lab) / n

    def logloss(key):
        e = 1e-6
        return -sum(math.log(max(e, s[key])) if s["y"] else math.log(max(e, 1 - s[key])) for s in lab) / n
    out = {
        "n": n, "baseRateUp": round(base_rate, 4),
        "brierCoin": 0.25, "brierModel": round(brier("p"), 5), "brierLogit": round(brier("pLog"), 5),
        "logLossCoin": round(math.log(2), 5), "logLossModel": round(logloss("p"), 5),
        "hitRate": round(sum(1 for s in lab if (s["p"] > 0.5) == (s["y"] == 1)) / n, 4),
    }
    if all(s["pKnn"] is not None for s in lab):
        out["brierKnn"] = round(brier("pKnn"), 5)
    out["skill"] = round(1 - out["brierModel"] / 0.25, 5)  # Brier skill score vs 擲硬幣
    return out


def calibration(preds: List[dict], edges=(0, .35, .4, .45, .48, .5, .52, .55, .6, .65, 1.0001)) -> List[dict]:
    """機率校準格（Probability Lattice）：預測機率分箱 → 實際上漲比例、平均前瞻點數"""
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        grp = [s for s in preds if lo <= s["p"] < hi]
        lab = [s for s in grp if s["y"] is not None]
        if not grp:
            continue
        out.append({"lo": lo, "hi": min(hi, 1.0), "n": len(grp),
                    "predicted": round(sum(s["p"] for s in grp) / len(grp), 4),
                    "realized": round(sum(s["y"] for s in lab) / len(lab), 4) if lab else None,
                    "avgFwdPts": round(sum(s["fwd"] for s in grp) / len(grp), 2)})
    return out


def threshold_table(preds: List[dict], p: dict) -> List[dict]:
    rows = []
    for th in (0.0, 0.02, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20):
        st = trade_stats(simulate_trades(preds, p, th), p)
        rows.append({"threshold": th, **{k: st.get(k) for k in ("n", "winRate", "avgGrossPts", "avgNetPts", "totalNetNtd", "tStat", "profitFactor")}})
    return rows


def equity_curve(trades: List[dict]) -> List[dict]:
    out, eq = [], 0
    by_day: Dict[str, int] = {}
    for t in trades:
        by_day[t["date"]] = by_day.get(t["date"], 0) + t["netNtd"]
    for d in sorted(by_day):
        eq += by_day[d]
        out.append({"date": d, "equity": eq})
    return out


def kelly_fraction(st: dict) -> Optional[float]:
    if not st.get("n") or not st.get("avgLossPts"):
        return None
    pw = st["winRate"]
    b = st["avgWinPts"] / -st["avgLossPts"] if st["avgLossPts"] < 0 else None
    if not b:
        return None
    f = (pw * b - (1 - pw)) / b
    return round(max(0.0, f), 4)


def verdict(pm: dict, st: dict) -> dict:
    reasons = []
    good = True
    if pm.get("skill", 0) <= 0:
        good = False
        reasons.append(f"機率預測沒有勝過擲硬幣（Brier {pm.get('brierModel')} vs 0.25）")
    else:
        reasons.append(f"機率預測略勝擲硬幣（Brier skill {pm['skill']:.4f}）")
    if not st.get("n"):
        good = False
        reasons.append("門檻下沒有任何交易")
    else:
        if st["avgNetPts"] <= 0:
            good = False
            reasons.append(f"扣成本後平均每筆 {st['avgNetPts']} 點（≤ 0）")
        t = st.get("tStat") or 0
        if t < 2:
            good = False
            reasons.append(f"交易 t 值 {t}（< 2，無法排除運氣）")
        else:
            reasons.append(f"交易 t 值 {t}（≥ 2）")
        if st["n"] < 200:
            reasons.append(f"樣本只有 {st['n']} 筆，大數法則尚未發揮")
    return {"edgeFound": good, "label": "樣本外有統計顯著優勢（仍需紙上交易驗證）" if good else "未發現可交易的優勢", "reasons": reasons}


def run_backtest(days: List[dict], p: dict, source: str, model_path: str = MODEL_JSON) -> dict:
    t0 = time.time()
    samples, feats = build_samples(days, p)
    if not samples:
        raise RuntimeError("沒有樣本（資料天數不足或回合設定過長）")
    preds = walk_forward(samples, p)
    trades = simulate_trades(preds, p)
    st = trade_stats(trades, p)
    pm = prob_metrics(preds)
    # 最終模型（全部樣本）供即時使用
    lab = [s for s in samples if s["y"] is not None]
    final = fit_logistic([s["x"] for s in lab], [s["y"] for s in lab], p["l2"])
    weights = [{"feature": f, "label": FEATURE_LABEL.get(f, f), "coef": round(final["w"][j + 1], 4)} for j, f in enumerate(feats)]
    recent = days[-p["sigmaDays"]:]
    ss = nn = fa = fn = ra = rn = 0.0
    for d in recent:
        a, b = day_sigma(d["bars"]); ss += a; nn += b
        x, y_ = flow_sigma(d["bars"], "bigNet", 1); fa += x; fn += y_
        x, y_ = flow_sigma(d["bars"], "retailNet", 1); ra += x; rn += y_
    lib = lab[-6000:]
    model = {
        "version": VERSION, "trainedAt": datetime.now(sm.TZ_TAIPEI).isoformat(timespec="seconds"), "source": source,
        "params": p, "features": feats, "logit": final,
        "sigma1m": math.sqrt(ss / nn) if nn else None,
        "flowSigmaBig": math.sqrt(fa / fn) if fn else 0.0, "flowSigmaRetail": math.sqrt(ra / rn) if rn else 0.0,
        "prevClose": days[-1]["bars"][-1]["close"], "lastDate": days[-1]["date"],
        "knnX": [[round(v, 4) for v in s["x"]] for s in lib], "knnY": [s["y"] for s in lib],
        "kelly": kelly_fraction(st),
    }
    os.makedirs(os.path.dirname(model_path), exist_ok=True)
    with open(model_path, "w", encoding="utf-8") as f:
        json.dump(model, f, ensure_ascii=False, separators=(",", ":"))
    oos_dates = sorted({s["date"] for s in preds})
    res = {
        "version": VERSION, "updated": datetime.now(sm.TZ_TAIPEI).strftime("%Y-%m-%d %H:%M"), "source": source,
        "range": {"from": days[0]["date"], "to": days[-1]["date"], "days": len(days),
                  "oosFrom": oos_dates[0], "oosTo": oos_dates[-1], "oosDays": len(oos_dates)},
        "params": p, "costPtsRoundTrip": round(cost_points(days[-1]["bars"][-1]["close"], p), 2),
        "pointValue": CONTRACTS.get(p["contract"], 50),
        "samples": len(samples), "oosSamples": len(preds), "features": feats,
        "probability": pm, "trades": st, "verdict": verdict(pm, st), "kelly": kelly_fraction(st),
        "lattice": calibration(preds), "thresholds": threshold_table(preds, p),
        "weights": weights, "equity": equity_curve(trades), "recentTrades": trades[-40:],
        "elapsedSec": round(time.time() - t0, 1),
    }
    return res


def print_report(r: dict) -> None:
    pm, st, v = r["probability"], r["trades"], r["verdict"]
    print(f"\n=== 台指期機率優勢回測（{r['source']}）===")
    print(f"資料 {r['range']['from']} ~ {r['range']['to']}（{r['range']['days']} 天），樣本外 {r['range']['oosDays']} 天 / {r['oosSamples']} 個決策點")
    print(f"契約 {r['params']['contract']}（每點 {r['pointValue']} 元），來回成本 ≈ {r['costPtsRoundTrip']} 點，門檻 |P−0.5| ≥ {r['params']['threshold']}")
    print(f"機率：Brier 模型 {pm['brierModel']} vs 擲硬幣 0.25（skill {pm['skill']}），命中率 {pm['hitRate']:.1%}，實際上漲比例 {pm['baseRateUp']:.1%}")
    if st.get("n"):
        print(f"交易：{st['n']} 筆，淨勝率 {st['winRate']:.1%}，平均毛利 {st['avgGrossPts']} 點 / 淨利 {st['avgNetPts']} 點，"
              f"總淨損益 {st['totalNetNtd']:,} 元，t 值 {st['tStat']}，年化 Sharpe {st['sharpeAnnual']}，最大回落 {st['maxDrawdownNtd']:,} 元")
    print("門檻表（樣本外，挑最好的門檻本身就是過度擬合，僅供觀察趨勢）：")
    for row in r["thresholds"]:
        print(f"  ≥{row['threshold']:.2f}: {row['n']:>5} 筆  勝率 {row['winRate'] or 0:.1%}  淨 {row['avgNetPts'] or 0:>7} 點/筆  t {row['tStat']}")
    print("特徵權重（全樣本邏輯迴歸，標準化後）：" + "，".join(f"{w['label']} {w['coef']:+.3f}" for w in r["weights"]))
    print(f"結論：{v['label']}")
    for x in v["reasons"]:
        print("  - " + x)


# ================================================================ 即時
def load_model(path=MODEL_JSON) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def live_state(model: dict, bars: List[dict], now_minute: int, has_flow: bool) -> dict:
    """純函式：給今天到目前的 1 分 K → 當前回合狀態、P(上漲)、多空路徑、建議"""
    p = merge_params(model["params"])
    feats = model["features"]
    s1 = hhmm(p["sessionEnd"])
    rnd = [(a, b) for a, b in rounds_of_day(p) if a <= now_minute < b or (b == s1 and now_minute == s1)]
    if not bars or not rnd:
        return {"status": "closed", "message": "非日盤交易時段"}
    rs, re_ = rnd[0]
    ctx = DayContext(bars)
    in_round = [k for k, b in enumerate(bars) if rs <= b["minute"] < re_]
    i = ctx.last_index_before(now_minute)
    if not in_round or i is None or i < in_round[0]:
        return {"status": "waiting", "round": f"{sm.min_to_hhmm(rs)}-{sm.min_to_hhmm(re_)}", "message": "回合剛開始，等待第一根 K 棒"}
    sig = model.get("sigma1m") or 5.0
    ref = bars[in_round[0]]["open"]
    f = compute_features(ctx, i, ref, rs, bars[0]["open"], model.get("prevClose"), sig,
                         model.get("flowSigmaBig") or 0, model.get("flowSigmaRetail") or 0, has_flow, p)
    x = [f.get(k, 0.0) for k in feats]
    pl, contrib = predict_logistic(model["logit"], x)
    knn = KnnPaths(model["knnX"], model["knnY"], model["logit"]["mu"], model["logit"]["sd"], p["knnK"])
    pk, bull, bear = knn.predict(x)
    prob = ensemble(pl, pk, p["knnWeight"])
    px = bars[i]["close"]
    elapsed = bars[i]["minute"] + 1 - rs
    in_window = any(abs(elapsed - d) <= 2 for d in p["decisions"])
    edge = prob - 0.5
    cost = cost_points(px, p)
    if abs(edge) >= p["threshold"] and in_window:
        action = "做多" if edge > 0 else "做空"
    elif abs(edge) >= p["threshold"]:
        action = "觀望（不在決策點）"
    else:
        action = "觀望（優勢不足）"
    nodes = sorted([{"feature": k, "label": FEATURE_LABEL.get(k, k), "value": round(f.get(k, 0.0), 3),
                     "contrib": round(c, 4), "side": "bull" if c > 0 else "bear"} for k, c in zip(feats, contrib)],
                   key=lambda n: -abs(n["contrib"]))
    return {
        "status": "open", "round": f"{sm.min_to_hhmm(rs)}-{sm.min_to_hhmm(re_)}", "time": sm.min_to_hhmm(bars[i]["minute"] + 1),
        "minutesLeft": re_ - (bars[i]["minute"] + 1), "priceToBeat": ref, "price": px, "diff": round(px - ref, 1),
        "pUp": round(prob, 4), "pLogit": round(pl, 4), "pKnn": round(pk, 4) if pk is not None else None,
        "bullPaths": bull, "bearPaths": bear, "edge": round(edge, 4), "threshold": p["threshold"],
        "costPts": round(cost, 2), "action": action, "nodes": nodes, "kelly": model.get("kelly"),
    }


def fetch_today_bars(day: str) -> Tuple[List[dict], bool]:
    rows_by = {}
    for key in ("TX", "MTX", "TMF"):
        code = sm.near_month_contract(sm.TICK_PREFIX[key])
        try:
            rows = sm.finmind("data", {"dataset": "TaiwanFutOptTick", "data_id": code}, timeout=90, retries=1)
            if rows:
                trades = sm.parse_futopt_tick_rows(rows, key, None, day_session_only=True)["trades"]
                rows_by[key] = trades
                continue
            rows = sm.finmind("data", {"dataset": "TaiwanFuturesTick", "data_id": key, "start_date": day, "end_date": day}, timeout=180, retries=1)
            rows_by[key] = sm.rows_to_trades({key: rows})
        except Exception as e:  # noqa: BLE001
            print(f"  {key} 逐筆失敗：{e}")
    trades = sorted([t for v in rows_by.values() for t in v], key=lambda t: t["ms"])
    return bars_from_trades(trades), "TX" in rows_by and len(rows_by) == 3


def format_alert(s: dict) -> str:
    top = "、".join(f"{n['label']}{'↑' if n['side'] == 'bull' else '↓'}" for n in s["nodes"][:3])
    return (f"🎯 台指機率優勢 {s['round']} @ {s['time']}\n"
            f"建議：<b>{s['action']}</b>  P(上漲) {s['pUp']:.1%}（優勢 {s['edge']:+.1%}）\n"
            f"Price to Beat {s['priceToBeat']:.0f} · 現價 {s['price']:.0f}（{s['diff']:+.0f}）· 剩 {s['minutesLeft']} 分\n"
            f"類比路徑 多 {s['bullPaths']} / 空 {s['bearPaths']} · 成本 {s['costPts']} 點\n主因：{top}")


def cmd_live(args) -> None:
    model = load_model()
    print(f"載入模型（{model['source']}，訓練於 {model['trainedAt']}），每 {args.interval}s 更新")
    alerted = set()
    while True:
        now = datetime.now(sm.TZ_TAIPEI)
        day = now.strftime("%Y-%m-%d")
        bars, has_flow = fetch_today_bars(day)
        has_flow = has_flow and "flowBig" in model["features"]
        st = live_state(model, bars, now.hour * 60 + now.minute, has_flow)
        st["updated"] = now.isoformat(timespec="seconds")
        os.makedirs(os.path.dirname(LIVE_JSON), exist_ok=True)
        with open(LIVE_JSON, "w", encoding="utf-8") as f:
            json.dump(st, f, ensure_ascii=False, indent=1)
        if st["status"] == "open":
            print(f"[{now:%H:%M:%S}] {st['round']} 目標 {st['priceToBeat']:.0f} 現價 {st['price']:.0f} "
                  f"P(上) {st['pUp']:.1%} 多/空路徑 {st['bullPaths']}/{st['bearPaths']} → {st['action']}")
            key = (day, st["round"])
            if st["action"] in ("做多", "做空") and key not in alerted:
                alerted.add(key)
                sm.send_telegram(format_alert(st))
        else:
            print(f"[{now:%H:%M:%S}] {st.get('message')}")
        if args.once:
            break
        time.sleep(args.interval)


# ================================================================ 自我測試
def cmd_selftest() -> int:
    fails = 0

    def ok(name, cond, extra=""):
        nonlocal fails
        print(("✅" if cond else "❌"), name, extra)
        if not cond:
            fails += 1

    p = merge_params({"minTrainDays": 40, "refitDays": 20})
    import tempfile
    tmp_model = os.path.join(tempfile.mkdtemp(), "edge_model.json")
    ok("成本（MTX @ 22000）≈ 1 + 0.88 + 2 = 3.88 點", abs(cost_points(22000, p) - 3.88) < 0.01, f"{cost_points(22000, p):.3f}")
    ok("回合切分 60 分 → 5 回合", len(rounds_of_day(p)) == 5, str(rounds_of_day(p)))
    ok("回合切分 30 分 + 決策 [10,20] → 10 回合", len(rounds_of_day(merge_params({"roundMin": 30, "decisions": [10, 20]}))) == 10)
    # 邏輯迴歸可還原已知係數
    rnd = random.Random(1)
    X, y = [], []
    for _ in range(4000):
        a, b = rnd.gauss(0, 1), rnd.gauss(0, 1)
        X.append([a, b]); y.append(1 if rnd.random() < sigmoid(1.2 * a - 0.5 * b) else 0)
    m = fit_logistic(X, y, l2=0.1)
    ok("邏輯迴歸還原係數（1.2, −0.5）", abs(m["w"][1] - 1.2) < 0.15 and abs(m["w"][2] + 0.5) < 0.12, str([round(v, 3) for v in m["w"]]))
    # 無未來資訊：決策點的特徵只用 < 決策分鐘的 K 棒
    days = synthetic_days(12, seed=3)
    s, feats = build_samples(days, p)
    ok("樣本數 = (12−5 天) × 5 回合 × 3 決策點", len(s) == 7 * 5 * 3, str(len(s)))
    smp = s[0]
    ok("決策時間 = 回合開始 + 決策分鐘", smp["time"] == "09:00" and smp["round"] == "08:45-09:45", f"{smp['time']} {smp['round']}")
    # 負對照組：隨機漫步不應找到優勢
    neg = run_backtest(synthetic_days(260, seed=11, edge=0.0), p, "synthetic-random-walk", tmp_model)
    nv = neg["verdict"]["edgeFound"]
    ok("負對照（隨機漫步）→ 未發現優勢", not nv, f"skill {neg['probability']['skill']} t {neg['trades'].get('tStat')} 淨 {neg['trades'].get('avgNetPts')}")
    # 正對照組：大單流向領先價格 → 應找到優勢
    pos = run_backtest(synthetic_days(260, seed=12, edge=0.35), p, "synthetic-flow-edge", tmp_model)
    ok("正對照（流向領先）→ 找到優勢", pos["verdict"]["edgeFound"], f"skill {pos['probability']['skill']} t {pos['trades'].get('tStat')} 淨 {pos['trades'].get('avgNetPts')}")
    big_w = next(w["coef"] for w in pos["weights"] if w["feature"] == "flowBig")
    ok("正對照中大單流向權重最大且為正", big_w > 0 and big_w == max(w["coef"] for w in pos["weights"]), str(big_w))
    # 即時狀態函式
    model = load_model(tmp_model)
    bars = synthetic_days(1, seed=99, edge=0.35)[0]["bars"]
    st = live_state(model, [b for b in bars if b["minute"] < hhmm("10:15")], hhmm("10:15"), True)
    ok("即時：10:15 在 09:45-10:45 回合、剩 30 分", st["round"] == "09:45-10:45" and st["minutesLeft"] == 30, f"{st.get('round')} {st.get('minutesLeft')} {st.get('action')}")
    ok("即時：多空路徑合計 = K", st["bullPaths"] + st["bearPaths"] == (p["knnK"] if np is not None else 0))
    ok("收盤後狀態 = closed", live_state(model, bars, hhmm("14:30"), True)["status"] == "closed")
    print(f"\n{'全部通過' if fails == 0 else f'{fails} 項失敗'}")
    return 1 if fails else 0


# ================================================================ CLI
def main():
    ap = argparse.ArgumentParser(description="台指期機率優勢引擎")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--demo", action="store_true", help="合成資料示範（含可預測成分）")
    ap.add_argument("--demo-random", action="store_true", help="合成純隨機漫步示範（應找不到優勢）")
    ap.add_argument("--backtest", nargs=2, metavar=("START", "END"), help="FinMind 逐筆（需 FINMIND_TOKEN sponsor）")
    ap.add_argument("--backtest-csv", metavar="FILE", help="1 分 K CSV")
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=30)
    ap.add_argument("--params", help="JSON 覆寫參數")
    ap.add_argument("--out", default=OUT_JSON)
    a = ap.parse_args()
    p = merge_params(json.loads(a.params) if a.params else None)
    if a.selftest:
        sys.exit(cmd_selftest())
    if a.live:
        if not sm._token():
            print("請設定 FINMIND_TOKEN"); sys.exit(2)
        cmd_live(a); return
    if a.demo or a.demo_random:
        days, src = synthetic_days(300, seed=21, edge=0.0 if a.demo_random else 0.35), "合成資料（示範，非真實行情）"
    elif a.backtest_csv:
        days, src = load_csv_days(a.backtest_csv, p), f"CSV 1 分 K：{os.path.basename(a.backtest_csv)}"
    elif a.backtest:
        if not sm._token():
            print("請設定 FINMIND_TOKEN（sponsor）"); sys.exit(2)
        days, src = load_finmind_days(*a.backtest), "FinMind 台指期逐筆（TX/MTX/TMF）→ 1 分 K + 大小單流向"
    else:
        ap.print_help(); return
    print(f"載入 {len(days)} 個交易日")
    res = run_backtest(days, p, src)
    print_report(res)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    print(f"\n已寫入 {a.out}、{MODEL_JSON}")


if __name__ == "__main__":
    main()
