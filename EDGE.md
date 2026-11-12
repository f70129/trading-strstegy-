# 台指期機率優勢引擎（edge_engine.py + edge.html）

把 Polymarket「BTC 每小時漲跌」看板的原理搬到台指期，並用 walk-forward 回測檢驗它是否真的有優勢。

## 原理對照

| Polymarket 看板 | 台指期版本 |
|---|---|
| 每小時一回合、Price to Beat | 日盤每 `roundMin` 分一回合（預設 60 → 5 回合），回合開盤價 = Price to Beat |
| Bull / Bear 訊號節點 | 距回合開盤 z、5 分動能、距當日開盤 z、VWAP 乖離、區間位置、跳空、**大單 / 散戶流向**（沿用 smartmoney 引擎） |
| MiroFish 模擬路徑數 → P(UP) | 邏輯迴歸 + **類比路徑**（kNN：歷史最像的 K 個情境，數幾條往上、幾條往下），兩者平均 |
| P(UP) vs 盤口 53¢ → edge | 期貨的公平價 = 50%：\|P − 0.5\| ≥ `threshold` 才下單，持有到回合結束 |
| 大數法則 / 36,402 筆 | 只看**樣本外**：Brier 是否 < 0.25、交易 t 值 ≥ 2、校準格、扣成本淨損益 |

> 差異：Polymarket 是二元合約，「價格 vs 你的機率」本身就是優勢；期貨損益是線性的，只有**從現在到回合結束的方向**可以賺錢，
> 而且每筆要先付約 4 點成本（小台：手續費 + 期交稅 + 滑價各兩邊）。若要做二元型態的報酬，對應的是 TXO 週選（價外買權≈二元機率），
> 那需要選擇權報價，目前不在本引擎內。

## 使用

```bash
pip install requests numpy
```

```bash
python edge_engine.py --selftest
```

```bash
FINMIND_TOKEN=xxx python edge_engine.py --backtest 2025-11-01 2026-11-10
```

```bash
python edge_engine.py --backtest-csv my_tx_1min.csv
```

```bash
FINMIND_TOKEN=xxx python edge_engine.py --live --interval 30
```

- `--selftest`：單元測試，加上**負對照**（純隨機漫步，必須回報「沒有優勢」）與**正對照**（大單流向領先價格，必須抓到優勢）。
- `--demo` / `--demo-random`：合成資料示範（不是真實行情）。
- CSV 欄位：`datetime,open,high,low,close,volume`（或 `date,time,...`），1 分 K，只取日盤 08:45–13:45；CSV 沒有流向特徵。
- FinMind 逐筆需要 sponsor 方案；下載的資料會壓縮成 1 分 K，快取在 `data/edge_bars/`。
- 參數：`--params '{"roundMin":30,"decisions":[10,20],"threshold":0.06,"contract":"TX","feeNtd":50}'`
- 輸出：`edge.json`（給 `edge.html` 顯示）、`data/edge_model.json`（即時模式用）、`data/edge_live.json`。
- 即時模式在決策點出現優勢時，每回合推一次 Telegram（`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`）。
- GitHub Actions `edge.yml`：每週六用 `FINMIND_TOKEN` secret 重跑近一年回測並更新 `edge.json`，也可以手動指定日期與參數。

## 防止自己騙自己

1. **沒有未來資料**：決策點只用該分鐘之前已收完的 K 棒；σ 用前 20 天估；模型每 20 天只用過去資料重訓。
2. **門檻表不能拿來挑**：在樣本外挑最好的門檻，等於又做了一次擬合。請先固定門檻，再用新的一段資料或紙上交易驗證。
3. **勝率不等於優勢**：要看扣成本後的每筆淨點數與 t 值。
4. **找不到優勢是常態**：小時級方向接近隨機，負對照組顯示，隨機訊號扣完成本後 t 值會是負的。
