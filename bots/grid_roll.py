# -*- coding: utf-8 -*-
# Public example strategy; configure and validate independently.
# 每局10U/10x合约网格, 平台止盈+30%自动平, 止损-45%; 平局后滚利润开下一局;
# 阶梯: 权益>=100划50到主账户 / >=500划250 / >=1000全停报告
import hashlib, hmac, json, time, os, sys, datetime
import urllib.request, urllib.error

sys.stdout.reconfigure(encoding='utf-8')
BASE = 'https://api.bybit.com'
KEY = os.environ['GRID_API_KEY']
SECRET = os.environ['GRID_API_SECRET']

BUDGET = 10.0
LEV = '10'
CELLS = 35
ATR_K = 2.0
TP_PER = '0.30'
SL_PER = '0.45'
POLL_SEC = 300
LADDER_100, LADDER_500, LADDER_1000 = 100.0, 500.0, 1000.0
HARD_SKIP = {'XAUTUSDT', 'XAGUSDT', 'PAXGUSDT'}  # 代币化贵金属: 网格保证金规则异常, 排除
MAX_GRIDS = 10  # Public example configuration; not an account record.
ATH_NEAR = 0.02        # 距历史极值 2% 以内算"接近"
MIN_FUND = 15.0        # FUND 余额低于此值暂停开新局, 留弹药
COOL_SEC = 4 * 3600    # 输局币冷却 4 小时, 防止同币被平台止损后立刻重开(churn 烧钱)
AVOID_SKIP = set(filter(None, os.environ.get('GRID_AVOID_SYMBOLS', '').split(',')))  # Optional operator-configured exclusions; no personal position list.
SPECIAL_SKIP = {'SKRUSDT'}  # SKR 由克隆塔(skr_clone.py)专管, 主机器人不自动开

HERE = os.path.dirname(os.path.abspath(__file__))
LOGDIR = os.path.join(HERE, 'logs')
os.makedirs(LOGDIR, exist_ok=True)
LOG = os.path.join(LOGDIR, 'grid_roll.log')
REG = os.path.join(HERE, 'grid_registry.json')
REC = os.path.join(HERE, 'grid_recommend.json')
SNAP = os.path.join(HERE, 'grid_snapshot.json')
BIDF = os.path.join(HERE, 'grid_bot_id.txt')  # Public example configuration; not an account record.

def log(msg):
    line = '[%s] %s' % (datetime.datetime.utcfromtimestamp(time.time() + 8 * 3600).strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line, flush=True)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def api(method, path, qs='', body=None):
    time.sleep(0.45)  # 全局限速 ~2 req/s, 防公开端点 10006
    ts = str(int(time.time() * 1000))
    data = json.dumps(body) if body is not None else ''
    sign = hmac.new(SECRET.encode(), (ts + KEY + '5000' + qs + data).encode(), hashlib.sha256).hexdigest()
    headers = {'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': '5000', 'X-BAPI-SIGN': sign}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + path + ('?' + qs if qs else ''), data=data.encode() if data else None,
                                 headers=headers, method=method)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=25).read().decode())
    except urllib.error.HTTPError as e:
        return {'retCode': e.code, 'retMsg': str(e)[:80]}
    except Exception as e:
        return {'retCode': -1, 'retMsg': str(e)[:80]}

def load_reg():
    try:
        return json.load(open(REG, encoding='utf-8'))
    except Exception:
        return {'running': [], 'history': [], 'banked': 0.0}

def save_reg(r):
    with open(REG, 'w', encoding='utf-8') as f:
        json.dump(r, f, ensure_ascii=False, indent=1)

def ema(vals, n):
    k = 2.0 / (n + 1)
    out, e = [], None
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
        out.append(e)
    return out

def klines(sym, interval, limit):
    d = api('GET', '/v5/market/kline', 'category=linear&symbol=%s&interval=%s&limit=%d' % (sym, interval, limit))
    bars = sorted(d.get('result', {}).get('list', []), key=lambda x: int(x[0]))
    return bars

ATH_ATL_CACHE = {}

def ath_atl(sym):
    # 月线历史最高/最低(排除当月未走完), 进程内缓存
    if sym in ATH_ATL_CACHE:
        return ATH_ATL_CACHE[sym]
    bars = klines(sym, 'M', 200)
    cur = time.strftime('%Y-%m', time.gmtime(time.time() + 8 * 3600))
    hist = [b for b in bars if time.strftime('%Y-%m', time.gmtime(int(b[0]) / 1000 + 8 * 3600)) < cur]
    if not hist:
        return None
    res = {'ath': max(float(b[2]) for b in hist), 'atl': min(float(b[3]) for b in hist)}
    ATH_ATL_CACHE[sym] = res
    return res

def fund_wallet():
    # 网格开仓从 FUND 资金账户扣款
    r = api('GET', '/v5/asset/transfer/query-account-coins-balance', 'accountType=FUND')
    for c in ((r.get('result') or {}).get('balance') or []):
        if c.get('coin') == 'USDT':
            return float(c.get('walletBalance') or 0)
    return 0.0

def fmt_px(v):
    # 无科学计数法的价格字符串
    s = '%.10f' % v
    return s.rstrip('0').rstrip('.') if '.' in s else s

def num(v):
    try:
        return float(v or 0)
    except Exception:
        return 0.0

def rnd_tick(v, tick):
    if tick <= 0:
        return v
    steps = round(v / tick)
    return steps * tick

def pick_coin(skip=None):
    # 加密永续 Top 成交额 -> 过滤 -> 优先选"刚破/接近历史极值"币给方向网格, 否则常规 EMA 分类
    skip = set(skip or []) | HARD_SKIP | AVOID_SKIP | SPECIAL_SKIP
    d = api('GET', '/v5/market/tickers', 'category=linear')
    lst = d.get('result', {}).get('list', [])
    if not lst:
        return None
    trad = set()
    cursor = ''
    for _ in range(6):
        qs = 'category=linear&limit=1000' + ('&cursor=' + cursor if cursor else '')
        d2 = api('GET', '/v5/market/instruments-info', qs)
        res = d2.get('result', {})
        for it in res.get('list', []):
            st = it.get('symbolType') or ''
            if st in ('stock', 'xstocks', 'ETF', 'commodity'):
                trad.add(it['symbol'])
        cursor = res.get('nextPageCursor') or ''
        if not cursor:
            break
    lst = [t for t in lst if t['symbol'] not in trad]
    lst.sort(key=lambda x: float(x['turnover24h']), reverse=True)
    broke_ath, broke_atl, near_ath, near_atl = [], [], [], []
    fallback = None
    for t in lst[:80]:
        sym = t['symbol']
        if sym in skip:
            continue
        if float(t['turnover24h']) < 2e6:
            continue
        b4 = klines(sym, '240', 200)[:-1]
        b1 = klines(sym, '60', 200)[:-1]
        if len(b4) < 60 or len(b1) < 60:
            continue
        c4 = [float(b[4]) for b in b4]
        c1 = [float(b[4]) for b in b1]
        e4_20, e4_50 = ema(c4, 20), ema(c4, 50)
        e1_20 = ema(c1, 20)
        long_r = c4[-1] > e4_20[-1] > e4_50[-1] and c1[-1] > e1_20[-1]
        short_r = c4[-1] < e4_20[-1] < e4_50[-1] and c1[-1] < e1_20[-1]
        # Bybit grid_mode: 1=中性, 2=做多, 3=做空 (官方文档)
        mode = 2 if long_r else (3 if short_r else 1)
        hi20 = max(float(b[2]) for b in b4[-120:])
        lo20 = min(float(b[3]) for b in b4[-120:])
        amp = (hi20 - lo20) / lo20
        # 2026-08-30 行情: 92%币20日振幅>25%, 高波动期放宽到 6%~55% 且只选高流动币
        if amp < 0.06 or amp > 0.55:
            continue
        trs = []
        for i in range(1, len(b4)):
            trs.append(max(float(b4[i][2]) - float(b4[i][3]),
                           abs(float(b4[i][2]) - float(b4[i - 1][4])),
                           abs(float(b4[i][3]) - float(b4[i - 1][4]))))
        atr = sum(trs[-14:]) / 14
        px_raw = float(t['lastPrice'])
        # 最小单量 + tick: 格子数按 minOrderAmt 自适应, 价格按 tick 对齐
        moa = None
        tick = 0.0
        d3 = api('GET', '/v5/market/instruments-info', 'category=linear&symbol=%s' % sym)
        for it in (d3.get('result') or {}).get('list', []):
            f = it.get('lotSizeFilter') or {}
            moa = float(f.get('minOrderAmt') or 0)
            if moa <= 0:
                moa = float(f.get('minOrderQty') or 0) * px_raw
            pf = it.get('priceFilter') or {}
            tick = float(pf.get('tickSize') or 0)
        if not moa or moa <= 0:
            continue
        max_cells = int(9.0 * 10 / moa)  # 投资约9U×10x 名义 / 单格最小名义
        cells = max(10, min(CELLS, max_cells))
        if max_cells < 10:
            continue
        px = rnd_tick(px_raw, tick)
        base = {'sym': sym, 'px': px, 'atr': atr, 'cells': cells,
                'min_price': rnd_tick(px - ATR_K * atr, tick),
                'max_price': rnd_tick(px + ATR_K * atr, tick)}
        if fallback is None:
            fallback = dict(base, mode=mode, why='常规EMA')
        ex = ath_atl(sym)
        if not ex:
            continue
        if px_raw >= ex['ath'] * 1.0000005:
            broke_ath.append((px_raw / ex['ath'] - 1, dict(base, mode=3, why='刚破ATH做空')))
        elif px_raw <= ex['atl'] * 0.9999995:
            broke_atl.append((px_raw / ex['atl'] - 1, dict(base, mode=2, why='刚破ATL做多')))
        else:
            da = (ex['ath'] - px_raw) / ex['ath']
            dl = (px_raw - ex['atl']) / ex['atl']
            if da <= ATH_NEAR:
                near_ath.append((da, dict(base, mode=3, why='接近ATH做空')))
            elif dl <= ATH_NEAR:
                near_atl.append((dl, dict(base, mode=2, why='接近ATL做多')))
    # 优先级: 刚破ATH(做空) > 刚破ATL(做多) > 接近ATH(做空) > 接近ATL(做多) > 常规EMA
    if broke_ath:
        return max(broke_ath, key=lambda x: x[0])[1]
    if broke_atl:
        return min(broke_atl, key=lambda x: x[0])[1]
    if near_ath:
        return min(near_ath, key=lambda x: x[0])[1]
    if near_atl:
        return min(near_atl, key=lambda x: x[0])[1]
    return fallback

def wallet():
    r = api('GET', '/v5/account/wallet-balance', 'accountType=UNIFIED')
    for a in (r.get('result') or {}).get('list', []):
        for coin in a.get('coin', []):
            if coin.get('coin') == 'USDT':
                return float(coin.get('walletBalance') or 0)
    return 0.0

def create_grid(c, invest):
    # 不传 entry_price: 平台按市价立即入场, 避免 AWAIT_ACTIVATION 挂起
    # 不传平台 TP/SL: 止盈止损由软件巡逻按 pnl_per >= +0.30 / <= -0.45 强制执行
    # grid_type=1 算术格: 官方文档标注上移/下移仅算术格适用
    # move_up/move_down: 用验证接口拿该币允许的终止价区间再钳位(各币上限不同, 超限报 getGridLimit fail)
    base = {'symbol': c['sym'], 'grid_mode': c['mode'], 'grid_type': 1,
            'min_price': fmt_px(c['min_price']), 'max_price': fmt_px(c['max_price']),
            'cell_number': c['cells'], 'leverage': LEV, 'total_investment': fmt_px(invest)}
    try:
        v = api('POST', '/v5/fgridbot/validate', body=base)
        res = v.get('result') or {}
        mu = float((res.get('move_up_price') or {}).get('to') or 0)
        md = float((res.get('move_down_price') or {}).get('from') or 0)
        if mu > c['max_price'] and md >= 0:
            base['move_up_price'] = fmt_px(min(c['max_price'] * 1000, mu))
            base['move_down_price'] = fmt_px(max(c['min_price'] / 1000, md))
        else:
            log('警告: %s 上移下移终止价区间异常(%.4f~%.4f), 本局不开移动' % (c['sym'], md, mu))
    except Exception:
        pass
    return api('POST', '/v5/fgridbot/create', body=base)

def close_grid(bot_id):
    return api('POST', '/v5/fgridbot/close', body={'bot_id': str(bot_id)})

def grid_detail(bot_id):
    r = api('POST', '/v5/fgridbot/detail', body={'bot_id': str(bot_id)})
    return (r.get('result') or {}).get('detail') or {}

def main():
    reg = load_reg()
    reg.setdefault('skip_syms', [])
    log('=== grid_roll v3.13 start. 快照每轮必写/活格计数/BIDF唯一真相源, 长期观察格不关, 最多%d格 ===' % MAX_GRIDS)
    while True:
        try:
            reg = load_reg()
            # 阶梯检查
            eq = BUDGET + sum(g.get('pnl', 0) for g in reg['history']) + reg['banked']
            if eq >= LADDER_1000:
                log('=== 阶梯达标 %.0fU: 全停并报告操作者 ===' % eq)
                sys.exit(0)
            if eq >= LADDER_500 and not reg.get('l500'):
                reg['l500'] = True
                log('=== 阶梯 500U: 划 250U 到主账户(待操作者确认后执行) ===')
            if eq >= LADDER_100 and not reg.get('l100'):
                reg['l100'] = True
                log('=== 阶梯 100U: 划 50U 到主账户(待操作者确认后执行) ===')
            # 当前网格列表: bot_id 文件(每行一个) 是唯一真相源
            bids = []
            try:
                with open(BIDF) as f:
                    bids = [x.strip() for x in f.read().splitlines() if x.strip()]
            except Exception:
                pass
            reg['running'] = bids
            gds = []
            close_done = []
            noclose = set(reg.get('noclose') or [])  # Public example configuration; not an account record.
            for bid in bids:
                d = grid_detail(bid)
                if d:
                    gds.append(d)
                    pnl = float(d.get('pnl') or 0)
                    pnl_per = float(d.get('pnl_per') or 0)
                    st = str(d.get('status') or '')
                    if any(k in st for k in ('CLOSE', 'SETTLED', 'COMPLETE', 'LIQUIDAT', 'FAIL', 'STOP')):
                        g = {'bot_id': bid, 'sym': d.get('symbol'), 'pnl': pnl, 'pnl_per': pnl_per,
                             'result': 'closed', 'close_at': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + 8 * 3600))}
                        if not any(h.get('bot_id') == bid for h in reg['history']):
                            reg['history'].append(g)
                        close_done.append(bid)
                        if pnl < 0 and d.get('symbol'):
                            cool = reg.setdefault('cool', {})
                            cool[d['symbol']] = time.time() + COOL_SEC
                            log('本局结束: %s pnl=%+.2fU (%.1f%%), 该币冷却 4 小时' % (d.get('symbol'), pnl, pnl_per * 100))
                        else:
                            log('本局结束: %s pnl=%+.2fU (%.1f%%)' % (d.get('symbol'), pnl, pnl_per * 100))
                    elif bid in noclose:
                        log('长期观察: %s pnl=%+.2fU (%.1f%%) 现价%s 不关仓' % (d.get('symbol'), pnl, pnl_per * 100, d.get('last_price')))
                    elif pnl_per >= float(TP_PER):
                        r = close_grid(bid)
                        log('达标+%.1f%%, 平仓 ret=%s' % (pnl_per * 100, r.get('retCode')))
                    elif pnl_per <= -float(SL_PER):
                        r = close_grid(bid)
                        log('触及软件止损-%.0f%%(%.1f%%), 平仓 ret=%s' % (float(SL_PER) * 100, pnl_per * 100, r.get('retCode')))
                    else:
                        log('巡逻: %s pnl=%+.2fU (%.1f%%) 现价%s' % (d.get('symbol'), pnl, pnl_per * 100, d.get('last_price')))
            if close_done:
                keep = [b for b in bids if b not in close_done]
                bids = keep  # 开新局分支必须用清理后的列表, 否则已关网格又被写回 BIDF
                reg['running'] = keep
                try:
                    with open(BIDF, 'w') as f:
                        f.write('\n'.join(keep) + ('\n' if keep else ''))
                except Exception:
                    pass
            CLOSED_KW = ('CLOSE', 'SETTLED', 'COMPLETE', 'LIQUIDAT', 'FAIL', 'STOP')
            alive_gds = [d for d in gds if not any(k in str(d.get('status') or '') for k in CLOSED_KW)]
            # 快照(驾驶舱用) — 每轮必写, 资金暂停等分支不跳过
            try:
                focus = set(reg.get('focus') or [])
                noc = set(reg.get('noclose') or [])
                grids_out = []
                for g in alive_gds:
                    cells = int(num(g.get('cell_number')))
                    gp = num(g.get('grid_profit'))
                    gm = str(g.get('grid_mode') or '')
                    mode = '做多' if 'LONG' in gm else ('做空' if 'SHORT' in gm else '中性')
                    ctime = g.get('create_time') or ''
                    open_at = ''
                    if ctime:
                        try:
                            open_at = time.strftime('%m-%d %H:%M', time.gmtime(int(ctime) / 1000 + 8 * 3600))
                        except Exception:
                            pass
                    grids_out.append({
                        'bot_id': g.get('bot_id'), 'sym': g.get('symbol'),
                        'pnl': num(g.get('pnl')), 'pnl_per': num(g.get('pnl_per')),
                        'status': str(g.get('status')), 'last_price': g.get('last_price'),
                        'liq': g.get('liquidation_price'), 'invest': g.get('total_investment'),
                        'cell_number': cells, 'trades': int(num(g.get('arbitrage_num'))),
                        'grid_profit': gp, 'per_cell': (gp / cells) if cells > 0 else 0.0,
                        'apr': num(g.get('total_apr')),
                        'realised': num(g.get('realised_pnl')),
                        'unrealised': num(g.get('unrealised_pnl')),
                        'mode': mode, 'open_at': open_at,
                        'focus': g.get('bot_id') in focus,
                        'noclose': g.get('bot_id') in noc})
                eq = BUDGET + sum(num(x.get('pnl')) for x in (reg.get('history') or [])) + num(reg.get('banked'))
                snap = {'ts': int(time.time()), 'grids': grids_out,
                        'history': reg['history'][-5:], 'banked': reg['banked'],
                        'equity': round(eq, 4), 'goal': LADDER_1000,
                        'ladder': {'l100': bool(reg.get('l100')), 'l500': bool(reg.get('l500'))}}
                with open(SNAP, 'w', encoding='utf-8') as f:
                    json.dump(snap, f, ensure_ascii=False)
            except Exception:
                pass
            save_reg(reg)
            # 并行网格 < 上限 且 FUND 够 -> 自动开新局(优先刚破/接近历史极值的方向网格)
            active_syms = [str(g.get('symbol')) for g in alive_gds]
            cooling = [s for s, t in (reg.get('cool') or {}).items() if t > time.time()]
            reg['cool'] = {s: t for s, t in (reg.get('cool') or {}).items() if t > time.time()}
            if len(alive_gds) < MAX_GRIDS:
                if fund_wallet() < MIN_FUND:
                    log('FUND余额低于 %.0fU, 暂停开新局留弹药' % MIN_FUND)
                    time.sleep(600)
                    continue
                c = pick_coin(((reg.get('skip_syms') or [])[-20:]) + active_syms + cooling)
                if c is None:
                    log('无候选币, 60秒后再扫')
                    time.sleep(60)
                    continue
                r = create_grid(c, BUDGET)
                if r.get('retCode') == 0:
                    bid = str((r.get('result') or {}).get('bot_id') or '')
                    if bid and bid not in bids:
                        bids.append(bid)
                        reg['running'] = bids
                        with open(BIDF, 'w') as f:
                            f.write('\n'.join(bids) + '\n')
                    log('自动开新局: %s %s mode=%d 区间[%s, %s] 本金%.0fU tp+30%%' %
                        (c['sym'], c['why'], c['mode'], fmt_px(c['min_price']), fmt_px(c['max_price']), BUDGET))
                else:
                    msg = str(r.get('retMsg') or '')
                    if 'enough money' in msg or 'insufficient' in msg:
                        log('资金账户余额不足(%s), 停 10 分钟再试' % msg)
                        save_reg(reg)
                        time.sleep(600)
                        continue
                    reg['skip_syms'] = (reg.get('skip_syms') or []) + [c['sym']]
                    save_reg(reg)
                    log('开仓失败 %s ret=%s %s, 跳过' % (c['sym'], r.get('retCode'), msg))
                    time.sleep(60)
                    continue
        except Exception as e:
            log('轮询异常: %s' % str(e)[:150])
        time.sleep(POLL_SEC)

if __name__ == '__main__':
    main()
