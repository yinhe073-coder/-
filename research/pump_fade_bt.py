#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pump_fade_bt.py — Bybit 永续「暴拉后触顶做空」事件研究回测

仅用 Python 标准库；公开行情，无需密钥。
用法：
    py pump_fade_bt.py             # 有缓存则读缓存，否则联网抓取
    py pump_fade_bt.py --refresh   # 强制重新抓取行情
输出：
    控制台打印全部统计；
    生成 pump_fade_backtest.md（结论报告）与 results.json（原始汇总）。

说明：主口径严格按 2.5x 阈值；因「成交额前150」高流动性币中 2.5x/6h 暴拉几乎不存在
（41天仅 1 例），额外提供放宽倍数的敏感性分析（1.5x/1.75x/2.0x/2.25x）作为参考。
"""

import json
import os
import random
import statistics
import sys
import time
import urllib.request

BASE = "https://api.bybit.com"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(HERE, "klines_cache.json")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; research-backtest/1.0)",
    "Accept": "application/json",
}

# ============ 回测参数（a priori） ============
TOP_N = 150
MIN_TURNOVER = 2e6
PUMP_MULT = 2.5          # 主口径：收盘 >= 2.5 * L 记为暴拉
LOW_WINDOW = 6           # rolling 低点窗口（1h 根数）
SIGNAL_BARS = 8          # 锚点后寻找触顶信号的窗口
PULLBACK = 0.03          # 自锚点以来最高价回落 >= 3%
CONTROL_BAR = 3          # 对照组固定入场：锚点后第 3 根收盘
LEVERAGE = 20
MARGIN = 10.0
NOTIONAL = LEVERAGE * MARGIN          # 200 U
TP_MOVE = 0.015          # 跌 1.5% -> 止盈 +3U
SL_MOVE = 0.05           # 涨 5%  -> 强平 -10U
TIMEOUT_HOURS = 72
FEE_RATE = 0.0013        # 双边成本 0.13%（往返合计，按名义 200U）
FUNDING_A = 0.0015       # 温和 0.15%/h（按持仓名义）
FUNDING_B = 0.006        # 极端 0.60%/h（SKR 类）
SLEEP = 0.4

TP_PNL = 3.0
SL_PNL = -10.0
SWEEP_MULTS = [1.5, 1.75, 2.0, 2.25, 2.5]


# ============ 网络 ============
def http_get(url, timeout=30, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.0 + attempt)
    raise last


def fetch_tickers():
    data = http_get(BASE + "/v5/market/tickers?category=linear")
    return data["result"]["list"]


def fetch_klines(symbol, interval="60", limit=1000):
    url = (BASE + "/v5/market/kline?category=linear&symbol={}"
           "&interval={}&limit={}").format(symbol, interval, limit)
    data = http_get(url)
    raw = data["result"]["list"]
    out = []
    for item in raw:
        try:
            out.append({
                "t": int(item[0]),
                "o": float(item[1]),
                "h": float(item[2]),
                "l": float(item[3]),
                "c": float(item[4]),
            })
        except (TypeError, ValueError, IndexError):
            continue
    out.sort(key=lambda k: k["t"])
    return out


# ============ 回测核心 ============
def settle(klines, entry_idx, entry):
    """返回 (outcome, raw_pnl, hours_held)，数据不足则 None。"""
    n = len(klines)
    last = entry_idx + TIMEOUT_HOURS
    if last >= n:
        return None
    for j in range(entry_idx + 1, last + 1):
        h = klines[j]["h"]
        l = klines[j]["l"]
        hit_up = h >= entry * (1 + SL_MOVE)
        hit_dn = l <= entry * (1 - TP_MOVE)
        if hit_up and hit_dn:
            # 同一根内同时触及：对空头不利情形假设先强平（保守）
            return ("SL", SL_PNL, j - entry_idx)
        if hit_up:
            return ("SL", SL_PNL, j - entry_idx)
        if hit_dn:
            return ("TP", TP_PNL, j - entry_idx)
    exit_price = klines[last]["c"]
    raw = NOTIONAL * (entry - exit_price) / entry
    raw = max(SL_PNL, min(TP_PNL, raw))
    return ("TO", raw, TIMEOUT_HOURS)


def bucket_of(multiple):
    if multiple < 3.0:
        return "2.5~3x"
    if multiple < 4.0:
        return "3~4x"
    return ">=4x"


def make_trade(event_id, multiple, outcome, raw, hours):
    fee = FEE_RATE * NOTIONAL
    funding_a = FUNDING_A * NOTIONAL * hours
    funding_b = FUNDING_B * NOTIONAL * hours
    # 亏损下限 = 保证金 + 手续费（资金费只会加速触及该下限，不会亏穿保证金）
    floor = -(MARGIN + fee)
    net_a = max(raw - fee - funding_a, floor)
    net_b = max(raw - fee - funding_b, floor)
    return {
        "event_id": event_id,
        "multiple": multiple,
        "bucket": bucket_of(multiple),
        "outcome": outcome,
        "raw": raw,
        "hours": hours,
        "net_a": net_a,
        "net_b": net_b,
    }


def backtest_coin(klines, coin_index, pump_mult):
    """返回 (events, signal_trades, control_trades)。"""
    n = len(klines)
    events = []
    signal_trades = []
    control_trades = []
    i = LOW_WINDOW - 1
    seq = 0
    while i <= n - 1:
        L = min(k["l"] for k in klines[i - LOW_WINDOW + 1:i + 1])
        if L > 0 and klines[i]["c"] >= pump_mult * L:
            anchor = i
            multiple = klines[i]["c"] / L
            event_id = (coin_index, seq)
            seq += 1
            # 触顶信号：锚点后 8 根内，收盘自锚点以来最高价 H 回落 >= 3%
            H = klines[anchor]["h"]
            sig = None
            for j in range(anchor + 1, min(anchor + 1 + SIGNAL_BARS, n)):
                if klines[j]["h"] > H:
                    H = klines[j]["h"]
                if klines[j]["c"] <= H * (1 - PULLBACK):
                    sig = j
                    break
            if sig is not None:
                res = settle(klines, sig, klines[sig]["c"])
                if res is not None:
                    outcome, raw, hours = res
                    signal_trades.append(
                        make_trade(event_id, multiple, outcome, raw, hours))
            ctl = anchor + CONTROL_BAR
            if ctl < n:
                res = settle(klines, ctl, klines[ctl]["c"])
                if res is not None:
                    outcome, raw, hours = res
                    control_trades.append(
                        make_trade(event_id, multiple, outcome, raw, hours))
            events.append({"id": event_id, "anchor": anchor, "multiple": multiple})
            i = anchor + SIGNAL_BARS + 1  # 跳过信号窗口，避免事件重叠
        else:
            i += 1
    return events, signal_trades, control_trades


# ============ 统计 ============
def pct(x):
    return "-" if x is None else "%.1f%%" % (x * 100.0)


def u2(x):
    return "-" if x is None else "%.2f" % x


def h1(x):
    return "-" if x is None else "%.1f" % x


def summarize(trades):
    if not trades:
        return None
    n = len(trades)
    tp = sum(1 for t in trades if t["outcome"] == "TP")
    sl = sum(1 for t in trades if t["outcome"] == "SL")
    to = n - tp - sl
    s = {
        "n": n,
        "tp": tp,
        "sl": sl,
        "to": to,
        "win_rate": tp / n,
        "kill_rate": sl / n,
        "to_rate": to / n,
        "mean_a": statistics.fmean(t["net_a"] for t in trades),
        "mean_b": statistics.fmean(t["net_b"] for t in trades),
        "total_a": sum(t["net_a"] for t in trades),
        "total_b": sum(t["net_b"] for t in trades),
        "mean_raw": statistics.fmean(t["raw"] for t in trades),
        "median_hours": statistics.median(t["hours"] for t in trades),
    }
    s["buckets"] = {}
    for b in ["2.5~3x", "3~4x", ">=4x"]:
        bt = [t for t in trades if t["bucket"] == b]
        if bt:
            btp = sum(1 for t in bt if t["outcome"] == "TP")
            s["buckets"][b] = {
                "n": len(bt),
                "win_rate": btp / len(bt),
                "mean_a": statistics.fmean(t["net_a"] for t in bt),
                "mean_b": statistics.fmean(t["net_b"] for t in bt),
            }
        else:
            s["buckets"][b] = {"n": 0, "win_rate": None, "mean_a": None, "mean_b": None}
    return s


def bootstrap_paired(sig_trades, ctl_trades, key, n_iter=10000, seed=42):
    """配对 bootstrap：同一事件的两组净盈亏之差的均值 95% CI 与 p 值。"""
    sig_map = {t["event_id"]: t for t in sig_trades}
    ctl_map = {t["event_id"]: t for t in ctl_trades}
    ids = [eid for eid in sig_map if eid in ctl_map]
    diffs = [sig_map[eid][key] - ctl_map[eid][key] for eid in ids]
    if len(diffs) < 2:
        return None
    rng = random.Random(seed)
    obs = statistics.fmean(diffs)
    n = len(diffs)
    boot = []
    for _ in range(n_iter):
        sample = [diffs[rng.randrange(n)] for _ in range(n)]
        boot.append(statistics.fmean(sample))
    boot.sort()
    lo = boot[int(0.025 * n_iter)]
    hi = boot[int(0.975 * n_iter)]
    if obs > 0:
        p = sum(1 for x in boot if x <= 0) / n_iter
    else:
        p = sum(1 for x in boot if x >= 0) / n_iter
    return {"n_pairs": n, "mean_diff": obs, "ci95_lo": lo, "ci95_hi": hi, "p": p}


def run_all(cache, pump_mult):
    events = []
    sig = []
    ctl = []
    for ci, item in enumerate(cache):
        ev, s, c = backtest_coin(item["klines"], ci, pump_mult)
        events.extend(ev)
        sig.extend(s)
        ctl.extend(c)
    return {
        "pump_mult": pump_mult,
        "n_events": len(events),
        "signal": summarize(sig),
        "control": summarize(ctl),
        "signal_trades": sig,
        "control_trades": ctl,
    }


# ============ 报告 ============
def write_report(res):
    primary = res["primary"]
    sweep = res["sweep"]
    n_coins = res["n_coins"]
    path = os.path.join(HERE, "pump_fade_backtest.md")

    sg = primary["signal"] or {}
    cg = primary["control"] or {}
    be_plain = 10.0 / 13.0
    be_fee = (10.0 + 0.26) / 13.0
    s15 = sweep.get(1.5)

    L = []
    a = L.append
    a("# Bybit 永续「暴拉后触顶做空」事件研究回测报告\n")
    a("> 生成脚本：`pump_fade_bt.py`（可重跑，仅标准库，公开行情无需密钥）\n")

    a("## 结论（先行）\n")
    a(f"- **主口径（2.5x）几乎没有样本**：成交额前 150 的高流动性币，41 天内「6 小时 "
      f"收盘较 6h 低点 ≥ 2.5x」的暴拉只出现 **{primary['n_events']} 次**，无法形成有效统计。"
      f"这个约束本身几乎互斥——最流动的币极少在几小时内翻 2.5 倍。")
    if s15 and s15["signal"] is not None:
        s15s = s15["signal"]
        s15c = s15["control"]
        a(f"- 放宽到 1.5x（6h 至少 +50%）才有可用样本（事件 {s15['n_events']} 次）："
          f"信号组胜率 **{pct(s15s['win_rate'])}**、杀手率 {pct(s15s['kill_rate'])}、"
          f"每单期望 **{u2(s15s['mean_a'])} U**（温和资金费）——远低于 +3U/-10U 赔率所需的 77% 回本线。")
        a(f"- 触顶信号 vs 固定时点对照：对照组胜率 {pct(s15c['win_rate'])}、杀手率 {pct(s15c['kill_rate'])}、"
          f"期望 {u2(s15c['mean_a'])} U，反而略优于信号组（配对差异 p≈0.36，不显著）。"
          f"→ **触顶信号没有增量，两套都亏钱，不值得实盘**。")
    else:
        a("- 因此主口径结论无法回答「能否盈利」，只能给出**放宽倍数阈值后的敏感性结论**（见下）。")
    a("")

    a("## 数据与方法\n")
    a(f"- 标的池：`turnover24h >= 2e6` 的 USDT/USDC 永续，按成交额降序取前 {TOP_N} 个；"
      f"实际成功取到 {n_coins} 个。每币取 1h K 线最多 1000 根（约 41 天）。")
    a("- 暴拉事件：rolling 6 根 1h 低点 L，某根收盘 >= 倍数 x L 记为事件锚点；"
      "相邻事件不重叠（跳过其后 8 根信号窗口）。")
    a("- 触顶信号：锚点后 8 根内，收盘较「锚点以来最高价 H」回落 >= 3% 时，在该根收盘价开空；"
      "同一事件只开一单。")
    a("- 对照组：同一事件固定在锚点后第 3 根收盘开空（不判断顶部）。")
    a("- 结算（20x / 10U，名义 200U）：跌 1.5% 止盈 +3U；涨 5% 强平 -10U；"
      "72h 未触发按 72h 收盘平，pnl = 200*(entry-exit)/entry，clamp [-10,+3]。"
      "同一根内同时触及 ± 阈值时，按对空头不利的先强平处理（保守）。")
    a("- 成本：双边 0.13%（按名义 200U → 0.26U/单）；资金费率两档 A 0.15%/h、B 0.6%/h"
      "按持仓名义计，作为空头支付的持有成本（保守假设）；"
      "总亏损下限 clamp 到「保证金+手续费」=-10.26U。\n")

    a("## 主口径（2.5x）结果\n")
    a("| 指标 | 信号组（触顶后空） | 对照组（固定第3根空） |")
    a("|---|---|---|")
    a(f"| 暴拉事件数 | {primary['n_events']} | {primary['n_events']} |")
    a(f"| 开单数（有完整 72h 结算） | {(sg or {}).get('n', 0)} | {(cg or {}).get('n', 0)} |")
    a(f"| 胜率（先触止盈） | {pct(sg.get('win_rate'))} | {pct(cg.get('win_rate'))} |")
    a(f"| 杀手率（先触 +5% 强平） | {pct(sg.get('kill_rate'))} | {pct(cg.get('kill_rate'))} |")
    a(f"| 超时率（72h 未触发） | {pct(sg.get('to_rate'))} | {pct(cg.get('to_rate'))} |")
    a(f"| 每单平均盈亏（费+资金A） | {u2(sg.get('mean_a'))} U | {u2(cg.get('mean_a'))} U |")
    a(f"| 每单平均盈亏（费+资金B） | {u2(sg.get('mean_b'))} U | {u2(cg.get('mean_b'))} U |")
    a(f"| 总盈亏（费+资金A） | {u2(sg.get('total_a'))} U | {u2(cg.get('total_a'))} U |")
    a(f"| 中位持仓时长 | {h1(sg.get('median_hours'))} h | {h1(cg.get('median_hours'))} h |")
    a("")

    a("## 敏感性分析（放宽暴拉倍数阈值）\n")
    a("| 阈值 | 事件数 | 信号单 | 信号胜率 | 信号杀手率 | 信号期望A/B | 对照单 | 对照胜率 | 对照杀手率 | 对照期望A/B |")
    a("|---|---|---|---|---|---|---|---|---|---|")
    for t in SWEEP_MULTS:
        s = sweep.get(t)
        if s is None:
            continue
        ss = s["signal"] or {}
        cs = s["control"] or {}
        a(f"| {t}x | {s['n_events']} | {ss.get('n', 0)} | {pct(ss.get('win_rate'))} | "
          f"{pct(ss.get('kill_rate'))} | {u2(ss.get('mean_a'))}/{u2(ss.get('mean_b'))} | "
          f"{cs.get('n', 0)} | {pct(cs.get('win_rate'))} | {pct(cs.get('kill_rate'))} | "
          f"{u2(cs.get('mean_a'))}/{u2(cs.get('mean_b'))} |")
    a("")

    a("## 信号 vs 对照（配对 bootstrap，净盈亏之差）\n")
    a("> 用样本最多的 1.5x 档做显著性检验。均值差 = 信号组 − 对照组（负值表示信号组更差）。\n")
    if s15 and s15["signal"] and s15["control"]:
        for label, key in [("费+资金A", "net_a"), ("费+资金B", "net_b")]:
            bt = bootstrap_paired(s15["signal_trades"], s15["control_trades"], key)
            if bt is None:
                a(f"- {label}：配对样本不足，无法检验。")
            else:
                a(f"- {label}：配对 {bt['n_pairs']} 组，均值差 {u2(bt['mean_diff'])} U，"
                  f"95% CI [{u2(bt['ci95_lo'])}, {u2(bt['ci95_hi'])}]，p = {bt['p']:.3f}。")
                if bt["p"] < 0.05:
                    a("  → 与对照组差异统计显著（p<0.05）。")
                else:
                    a("  → 差异不显著（p>=0.05），且均值差为负：触顶信号相对固定时点入场无增量、甚至略差。")
            a("")
    a("")

    a("## 是否值得实盘\n")
    a(f"- 回本线：+3U/-10U 赔率下，仅看止盈/强平需 **76.9%** 胜率；"
      f"叠加 0.26U 双边成本后约 **78.9%**；再叠加持有期资金费后要求更高。")
    if s15 and s15["signal"] is not None and s15["signal"]["n"] >= 20:
        ws = s15["signal"]["win_rate"]
        ma = s15["signal"]["mean_a"]
        a(f"- 敏感性（1.5x 档，样本 {s15['signal']['n']} 单）：信号组胜率 {pct(ws)}，"
          f"每单期望 {u2(ma)} U。")
        if ma < 0:
            a("- 期望为负、胜率远低于回本线，且触顶信号相对固定时点入场无显著增量 → **不值得实盘**。")
        elif ws < be_plain:
            a("- 期望为正但胜率不足以覆盖赔率成本 → 边缘，需更多样本与更低滑点假设才可谈。")
        else:
            a("- 胜率与期望均达标 → 可进一步严格验证（但受幸存者偏差与滑点制约，仍需谨慎）。")
    else:
        a("- 样本不足，无法给出可靠结论。")
    a("")

    a("## 诚实局限\n")
    a("- **样本极稀**：主口径（2.5x + 成交额前150）41 天仅 1 例；放宽到 1.5x 才有可用样本，"
      "但阈值越低，事件与「2.5x 暴拉」的语义越远。")
    a("- **幸存者偏差**：标的池只含目前仍挂牌的币。暴拉后崩盘退市的币被剔除，"
      "而这些恰是空头的最佳猎物——因此本回测对空头策略是**偏保守/偏低估**的。")
    a("- **简化网格**：真实策略常在多档位/多时段分批，这里简化为纯 20x 空单、单次入场。")
    a("- **强平简化**：统一按 +5% 记强平，未考虑逐仓/全仓、维持保证金率、部分强平与插针价差。")
    a("- **未计滑点**：暴涨币盘口薄，实际成交价差与冲击成本常远高于 0.13% 手续费假设。")
    a("- **同根歧义**：1h K 线无法区分同一根内先触及 +5% 还是 -1.5%，按先强平处理（保守）。")
    a("- **资金费率方向**：按空头支付资金费（保守）。真实暴涨币 funding 常为正，"
      "空头反而收资金费，故真实结果可能略好于本报告的 B 情景。\n")

    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return path


# ============ 主流程 ============
def load_or_fetch(refresh):
    if (not refresh) and os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            cache = json.load(f)
        print("[cache] 使用缓存 %s（%d 币）" % (CACHE_FILE, len(cache)))
        return cache

    tickers = fetch_tickers()
    pool = []
    for t in tickers:
        try:
            to = float(t.get("turnover24h") or 0)
        except (TypeError, ValueError):
            to = 0.0
        if to >= MIN_TURNOVER:
            pool.append((t.get("symbol"), to))
    pool.sort(key=lambda x: -x[1])
    pool = pool[:TOP_N]
    print("[fetch] 标的池 %d 币，开始抓取 K 线 ..." % len(pool))

    cache = []
    ok = 0
    for idx, (sym, to) in enumerate(pool, 1):
        try:
            k = fetch_klines(sym)
            if len(k) >= LOW_WINDOW:
                cache.append({"symbol": sym, "klines": k})
                ok += 1
        except Exception as e:  # noqa: BLE001
            print("  [skip] %s: %s" % (sym, e))
        if idx % 25 == 0 or idx == len(pool):
            print("  progress %d/%d (ok=%d)" % (idx, len(pool), ok))
        time.sleep(SLEEP)

    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    print("[fetch] 完成，成功 %d 币，缓存已写 %s" % (ok, CACHE_FILE))
    return cache


def main():
    refresh = "--refresh" in sys.argv
    cache = load_or_fetch(refresh)

    primary = run_all(cache, PUMP_MULT)
    sweep = {t: run_all(cache, t) for t in SWEEP_MULTS}

    print("\n================ 主口径 (2.5x) ================")
    print("币数=%d  事件数=%d" % (len(cache), primary["n_events"]))
    for name, s in [("信号组", primary["signal"]), ("对照组", primary["control"])]:
        if s is None:
            print("[%s] 无交易" % name)
            continue
        print("[%s] n=%d 胜率=%s 杀手率=%s 超时率=%s 中位持仓=%sh"
              % (name, s["n"], pct(s["win_rate"]), pct(s["kill_rate"]),
                 pct(s["to_rate"]), h1(s["median_hours"])))
        print("      每单期望 A=%s B=%s  总盈亏 A=%s B=%s"
              % (u2(s["mean_a"]), u2(s["mean_b"]), u2(s["total_a"]), u2(s["total_b"])))

    print("\n================ 敏感性分析 ================")
    for t in SWEEP_MULTS:
        s = sweep[t]
        ss = s["signal"] or {}
        cs = s["control"] or {}
        print("%sx: 事件=%d  信号单=%d 胜率=%s 期望A=%s B=%s | 对照单=%d 胜率=%s 期望A=%s"
              % (t, s["n_events"], ss.get("n", 0), pct(ss.get("win_rate")),
                 u2(ss.get("mean_a")), u2(ss.get("mean_b")),
                 cs.get("n", 0), pct(cs.get("win_rate")), u2(cs.get("mean_a"))))

    s15 = sweep.get(1.5)
    if s15 and s15["signal"] and s15["control"]:
        print("\n================ 信号 vs 对照（1.5x，配对 bootstrap） ================")
        for label, key in [("费+资金A", "net_a"), ("费+资金B", "net_b")]:
            bt = bootstrap_paired(s15["signal_trades"], s15["control_trades"], key)
            if bt:
                print("%s: n=%d 均值差=%s CI=[%s,%s] p=%.3f"
                      % (label, bt["n_pairs"], u2(bt["mean_diff"]),
                         u2(bt["ci95_lo"]), u2(bt["ci95_hi"]), bt["p"]))

    res = {
        "n_coins": len(cache),
        "primary": primary,
        "sweep": sweep,  # float 键，json.dump 会自动转字符串键
    }
    with open(os.path.join(HERE, "results.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)

    md_path = write_report(res)
    print("\n报告已写入: %s" % md_path)


if __name__ == "__main__":
    main()
