# -*- coding: utf-8 -*-
# trend_bot v1 — BTC/ETH 趋势跟随+回踩 / 关键位突破, 逐仓隔离(主账户 10U 试水)
# 规则冻结: docs/建模/趋势跟随机器人规则书v1.md (主人钦定 2026-08-29)
# 保命纪律: 单日-10%熔断 / 连亏3单停机 / 结算点前15min不开仓 / 启动对账不一致FATAL
import hashlib, hmac, json, time, os, sys, datetime
import urllib.request, urllib.error

sys.stdout.reconfigure(encoding='utf-8')
BASE = 'https://api.bybit.com'
KEY = os.environ['TREND_API_KEY']
SECRET = os.environ['TREND_API_SECRET']

# ===== 参数冻结(规则书v1) =====
SYMBOLS = ['ETHUSDT', 'BTCUSDT']   # 只做BTC/ETH, ETH优先(最小单量适配10U)
LEV = 20                           # 逐仓20x
BUDGET = 10.0                      # 试水本金上限(主账户只投10U)
RISK_PCT = 0.03                    # 单笔风险3% = 0.30U
PLANNED_RISK = BUDGET * RISK_PCT   # 1R阈值用计划风险(规格), 不用实际风险
MAX_RISK_PCT = 0.05                # 风险上限5%
DAILY_LOSS_LIMIT = BUDGET * 0.10   # 当日熔断 1.0U
MAX_CONSEC_LOSS = 3                # 连亏3单停机
STOP_BUFFER = 0.0015               # 止损挂结构位外0.15%
BREAKOUT_LOOKBACK = 25             # 4H前25根前高/前低
BREAKOUT_VOL = 1.5                 # 突破量>=1.5x均量
COST_RATE = 0.0013                 # 名义0.13%计入净盈亏
POLL_SEC = 10
FUNDING_HOURS_UTC = [0, 8, 16]
QTY_STEP = {'ETHUSDT': 0.01, 'BTCUSDT': 0.001}

HERE = os.path.dirname(os.path.abspath(__file__))
LOGDIR = os.path.join(HERE, 'logs')
os.makedirs(LOGDIR, exist_ok=True)
LOG = os.path.join(LOGDIR, 'trend.log')
STATE_F = os.path.join(HERE, 'trend_state.json')
GAMES_F = os.path.join(HERE, 'trend_games.json')

def log(msg):
    line = '[%s] %s' % (datetime.datetime.utcfromtimestamp(time.time() + 8 * 3600).strftime('%Y-%m-%d %H:%M:%S'), msg)
    print(line, flush=True)
    try:
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def _sign(ts, payload):
    return hmac.new(SECRET.encode(), (ts + KEY + '5000' + payload).encode(), hashlib.sha256).hexdigest()

def api_get(path, qs=''):
    ts = str(int(time.time() * 1000))
    sign = _sign(ts, qs)
    req = urllib.request.Request(BASE + path + '?' + qs, headers={
        'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': '5000', 'X-BAPI-SIGN': sign})
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())

def api_post(path, body):
    ts = str(int(time.time() * 1000))
    data = json.dumps(body)
    sign = _sign(ts, data)
    req = urllib.request.Request(BASE + path, data=data.encode(), headers={
        'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-RECV-WINDOW': '5000',
        'X-BAPI-SIGN': sign, 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())

def klines(sym, interval, limit):
    r = api_get('/v5/market/kline', 'category=linear&symbol=%s&interval=%s&limit=%d' % (sym, interval, limit))
    bars = sorted(r['result']['list'], key=lambda x: int(x[0]))
    return bars

def ema(vals, n):
    k = 2.0 / (n + 1)
    out = []
    e = None
    for v in vals:
        e = v if e is None else v * k + e * (1 - k)
        out.append(e)
    return out

def ticker(sym):
    r = api_get('/v5/market/tickers', 'category=linear&symbol=%s' % sym)
    t = r['result']['list'][0]
    return {'price': float(t['lastPrice']), 'fr': float(t['fundingRate'])}

def pos_of(sym):
    r = api_get('/v5/position/list', 'category=linear&symbol=%s' % sym)
    for p in r.get('result', {}).get('list', []):
        if float(p.get('size') or 0) > 0:
            return p
    return None

def wallet():
    try:
        r = api_get('/v5/account/wallet-balance', 'accountType=UNIFIED')
        for a in r.get('result', {}).get('list', []):
            for coin in a.get('coin', []):
                if coin.get('coin') == 'USDT':
                    return float(coin.get('walletBalance') or 0)
    except Exception:
        pass
    return None

def set_lev(sym):
    try:
        r = api_post('/v5/position/set-leverage', {'category': 'linear', 'symbol': sym,
                                                   'buyLeverage': str(LEV), 'sellLeverage': str(LEV)})
        return r.get('retCode') in (0, 110043)
    except Exception as e:
        log('set_lev %s 失败 %s' % (sym, str(e)[:80]))
        return False

def market_order(sym, side, qty):
    step = QTY_STEP[sym]
    q = max(step, float(int(float(qty) / step) * step))
    body = {'category': 'linear', 'symbol': sym, 'side': side, 'orderType': 'Market',
            'qty': str(q), 'timeInForce': 'IOC', 'tradeMode': 1}
    try:
        r = api_post('/v5/order/create', body)
        return r, q
    except urllib.error.HTTPError as e:
        return {'retCode': e.code, 'retMsg': str(e)[:100]}, q
    except Exception as e:
        return {'retCode': -1, 'retMsg': str(e)[:100]}, q

def set_sl(sym, price):
    try:
        r = api_post('/v5/position/trading-stop', {'category': 'linear', 'symbol': sym, 'positionIdx': 0,
                                                   'tpslMode': 'Full', 'stopLoss': str(round(price, 2)),
                                                   'slTriggerBy': 'MarkPrice'})
        return r.get('retCode') in (0, 110026)
    except Exception as e:
        log('set_sl 失败 %s' % str(e)[:80])
        return False

def bj_day():
    return (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime('%Y-%m-%d')

def near_funding():
    now = datetime.datetime.utcnow()
    for h in FUNDING_HOURS_UTC:
        t = now.replace(hour=h, minute=0, second=0, microsecond=0)
        if 0 <= (t - now).total_seconds() <= 900:
            return True
    return False

def load_state():
    try:
        with open(STATE_F, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {'mode': 'IDLE', 'budget': BUDGET, 'day': bj_day(), 'day_pnl': 0.0,
                'consec': 0, 'stopped': False, 'pos': None, 'wallet': None, 'games': 0}

def save_state(st):
    with open(STATE_F, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False)

def save_games(games):
    with open(GAMES_F, 'w', encoding='utf-8') as f:
        json.dump(games, f, ensure_ascii=False)

def load_games():
    try:
        with open(GAMES_F, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return []

# ===== 信号 =====
def regime(sym):
    """4H+1H EMA20/50 同向 -> 'long'/'short'/None (只用已收盘根, S45修复①)"""
    try:
        b4 = klines(sym, '240', 200)[:-1]   # 剔除未收盘(forming)根
        b1 = klines(sym, '60', 200)[:-1]
        c4 = [float(b[4]) for b in b4]
        c1 = [float(b[4]) for b in b1]
        e4_20, e4_50 = ema(c4, 20), ema(c4, 50)
        e1_20 = ema(c1, 20)
        long4 = c4[-1] > e4_20[-1] > e4_50[-1]
        short4 = c4[-1] < e4_20[-1] < e4_50[-1]
        long1 = c1[-1] > e1_20[-1]
        short1 = c1[-1] < e1_20[-1]
        if long4 and long1:
            return 'long'
        if short4 and short1:
            return 'short'
        return None
    except Exception as e:
        log('regime %s 异常 %s' % (sym, str(e)[:80]))
        return None

def signal_pullback(sym, direction):
    """15m回踩EMA20(不破EMA50)+5m收复 -> (True, stop_price) (只用已收盘根, S45修复①)"""
    try:
        b15 = klines(sym, '15', 200)[:-1]
        b5 = klines(sym, '5', 60)[:-1]
        c15 = [float(b[4]) for b in b15]
        l15 = [float(b[3]) for b in b15]
        c5 = [float(b[4]) for b in b5]
        e15_20, e15_50 = ema(c15, 20), ema(c15, 50)
        e5_20 = ema(c5, 20)
        if direction == 'long':
            touch = l15[-1] <= e15_20[-1] * 1.001
            reclaim = c15[-1] > e15_20[-1] and c15[-1] > e15_50[-1] and c5[-1] > e5_20[-1]
            stop = min(l15[-13:-1]) * (1 - STOP_BUFFER)
            return (touch and reclaim), stop
        else:
            h15 = [float(b[2]) for b in b15]
            touch = h15[-1] >= e15_20[-1] * 0.999
            reclaim = c15[-1] < e15_20[-1] and c15[-1] < e15_50[-1] and c5[-1] < e5_20[-1]
            stop = max(h15[-13:-1]) * (1 + STOP_BUFFER)
            return (touch and reclaim), stop
    except Exception as e:
        log('signal_pullback %s 异常 %s' % (sym, str(e)[:80]))
        return False, None

def signal_breakout(sym, direction):
    """4H前25根前高/前低放量突破 -> 回踩不破 -> (True, stop_price) (只用已收盘根, S45修复①)"""
    try:
        b4 = klines(sym, '240', 60)[:-1]
        highs = [float(b[2]) for b in b4]
        lows = [float(b[3]) for b in b4]
        closes = [float(b[4]) for b in b4]
        vols = [float(b[5]) for b in b4]
        avg_vol = sum(vols[-21:-1]) / 20 if len(vols) >= 21 else 0
        if avg_vol <= 0:
            return False, None
        if direction == 'long':
            level = max(highs[-BREAKOUT_LOOKBACK - 1:-1])
            broke = closes[-1] > level and vols[-1] >= BREAKOUT_VOL * avg_vol
            if not broke:
                return False, None
            b15 = klines(sym, '15', 60)[:-1]
            l15 = [float(b[3]) for b in b15]
            c15 = [float(b[4]) for b in b15]
            retest = min(l15[-6:]) <= level * 1.002 and c15[-1] > level
            return retest, level * (1 - STOP_BUFFER)
        else:
            level = min(lows[-BREAKOUT_LOOKBACK - 1:-1])
            broke = closes[-1] < level and vols[-1] >= BREAKOUT_VOL * avg_vol
            if not broke:
                return False, None
            b15 = klines(sym, '15', 60)[:-1]
            h15 = [float(b[2]) for b in b15]
            c15 = [float(b[4]) for b in b15]
            retest = max(h15[-6:]) >= level * 0.998 and c15[-1] < level
            return retest, level * (1 + STOP_BUFFER)
    except Exception as e:
        log('signal_breakout %s 异常 %s' % (sym, str(e)[:80]))
        return False, None

_sig_cache = (0.0, (None, None, None, None))  # (评估时间, (sym, side, stop, why))

def pick_signal():
    """按 ETH 优先遍历两币, 返回 (sym, side, stop, why); 每15分钟只评估一次"""
    global _sig_cache
    now = time.time()
    if _sig_cache and now - _sig_cache[0] < 900:
        return _sig_cache[1]
    for sym in SYMBOLS:
        reg = regime(sym)
        if reg is None:
            continue
        side = 'Buy' if reg == 'long' else 'Sell'
        ok, stop = signal_pullback(sym, reg)
        if ok and stop:
            _sig_cache = (now, (sym, side, stop, '趋势回踩'))
            return _sig_cache[1]
        ok2, stop2 = signal_breakout(sym, reg)
        if ok2 and stop2:
            _sig_cache = (now, (sym, side, stop2, '关键位突破'))
            return _sig_cache[1]
    _sig_cache = (now, (None, None, None, None))
    return _sig_cache[1]

def try_open(st):
    if st.get('stopped'):
        return None
    if st.get('day') != bj_day():
        st['day'] = bj_day()
        st['day_pnl'] = 0.0
        log('新交易日, 当日盈亏清零')
    if st['day_pnl'] <= -DAILY_LOSS_LIMIT:
        log('熔断: 当日已亏 %.2fU >= %.2fU, 停机至次日' % (-st['day_pnl'], DAILY_LOSS_LIMIT))
        return None
    if st['consec'] >= MAX_CONSEC_LOSS:
        st['stopped'] = True
        log('FATAL: 连亏%d单, 按保命纪律停机, 请总管复盘后手动解禁(state.stopped=false)' % st['consec'])
        return None
    if near_funding():
        log('距资金费结算点<15分钟, 不开新仓')
        return None
    sym, side, stop, why = pick_signal()
    if not sym:
        return None
    if not set_lev(sym):
        return None
    px = ticker(sym)['price']
    stop_dist = abs(px - stop)
    if stop_dist <= 0:
        log('止损距离为0, 跳过 %s' % sym)
        return None
    step = QTY_STEP[sym]
    risk_usd = BUDGET * RISK_PCT
    qty = risk_usd / stop_dist
    max_qty = (BUDGET * 0.9 * LEV) / px
    qty = min(qty, max_qty)
    qty = float(int(qty / step) * step)   # 只向下取整
    if qty < step:
        log('qty<最小单量(%s), 按规格不开仓, 跳过 %s' % (step, sym))  # S45修复②: 禁止向上取整
        return None
    if qty * px < 10:
        log('名义过小(<10U), 跳过 %s' % sym)
        return None
    actual_risk = qty * stop_dist
    if actual_risk > BUDGET * MAX_RISK_PCT:
        log('实际风险 %.2fU > 5%%上限, 跳过 %s' % (actual_risk, sym))
        return None
    log('信号[%s] %s %s @%.4g 止损%.4g 数量%s 风险%.2fU' % (why, sym, '多' if side == 'Buy' else '空', px, stop, str(qty), actual_risk))
    r, q = market_order(sym, side, qty)
    if r.get('retCode') != 0:
        log('开仓失败 ret=%s %s' % (r.get('retCode'), r.get('retMsg')))
        return None
    time.sleep(2)
    p = pos_of(sym)
    if not p:
        log('开仓后未查到持仓(可能IOC未成交), 本轮跳过')
        return None
    entry = float(p.get('avgPrice') or px)
    if not set_sl(sym, stop):
        log('警告: 止损单挂载失败, 软件止损兜底')
    st['pos'] = {'sym': sym, 'side': side, 'qty': q, 'entry': entry, 'stop': stop,
                 'risk_usd': actual_risk, 'planned_risk': PLANNED_RISK, 'halved': False,
                 'realized': 0.0, 'fund': 0.0, 'why': why,
                 'opened_at': time.time(), 'last_settle': time.time(), 'fr': ticker(sym)['fr']}
    st['mode'] = 'OPEN'
    log('已开仓 %s %s %s @%.6g 止损%.6g (why=%s)' % (sym, side, q, entry, stop, why))
    return st

def settlement_epochs_between(a, b):
    """UTC 0/8/16 结算点中, a<结算点<=b 的时间戳列表"""
    out = []
    d = datetime.datetime.utcfromtimestamp(a).replace(minute=0, second=0, microsecond=0)
    while d.hour % 8 != 0:
        d -= datetime.timedelta(hours=1)
    s = d + datetime.timedelta(hours=8)
    while s.timestamp() <= b:
        if s.timestamp() > a:
            out.append(s.timestamp())
        s += datetime.timedelta(hours=8)
    return out

def manage_pos(st):
    pst = st['pos']
    sym, side = pst['sym'], pst['side']
    p = pos_of(sym)
    if not p:
        # 仓位已消失(止损单成交/强平), 结算(退出价按止损价估算)
        return settle(st, '已平(止损/强平)', exit_est=pst['stop'])
    mark = float(p.get('markPrice') or 0)
    if mark <= 0:
        return st
    qty_now = float(p.get('size') or 0)
    direction = 1 if side == 'Buy' else -1
    upnl = direction * (mark - pst['entry']) * qty_now
    # 资金费结算点计提(S45修复③): 跨 UTC 0/8/16 按当前持仓名义×开仓时费率
    fr = float(pst.get('fr') or 0.0)
    if fr:
        for se in settlement_epochs_between(pst.get('last_settle', pst['opened_at']), time.time()):
            pst['fund'] = round(pst.get('fund', 0.0)
                                + direction * fr * pst['entry'] * qty_now, 4)
            pst['last_settle'] = se
            log('资金费结算计提: %+.4fU (累计%+.4f, fr=%.5f%%)' %
                (direction * fr * pst['entry'] * qty_now, pst['fund'], fr * 100))
    # 1R 平半 + 保本 (S45修复④: 1R=计划风险0.30U, 不用actual_risk)
    if not pst['halved'] and upnl >= pst['planned_risk']:
        step = QTY_STEP[sym]
        if qty_now < step * 2:
            log('仓位不可拆半(最小单量), 1:1 直接全平')
            r, _ = market_order(sym, 'Sell' if side == 'Buy' else 'Buy', qty_now)
            log('1:1 全平 ret=%s' % r.get('retCode'))
            return settle(st, '1R全平(不可拆半)', exit_est=mark)
        half = qty_now / 2.0
        r, _ = market_order(sym, 'Sell' if side == 'Buy' else 'Buy', half)
        if r.get('retCode') == 0:
            time.sleep(2)
            p2 = pos_of(sym)
            rem = float((p2 or {}).get('size') or 0)
            closed_qty = qty_now - rem
            pst['realized'] = round(pst.get('realized', 0.0) + direction * (mark - pst['entry']) * closed_qty
                                    - pst['entry'] * closed_qty * COST_RATE, 4)
            pst['halved'] = True
            pst['qty'] = rem if rem > 0 else qty_now / 2.0
            pst['stop'] = pst['entry']  # 保本
            set_sl(sym, pst['stop'])
            log('1:1 平半 %s, 剩余 %s, 已实现 %+.4fU, 止损移至保本 %.6g' %
                (closed_qty, pst['qty'], pst['realized'], pst['entry']))
    # 15m EMA20 移动止损(只移向有利方向)
    if pst['halved']:
        try:
            b15 = klines(sym, '15', 60)[:-1]  # 移动止损也只用已收盘根
            c15 = [float(b[4]) for b in b15]
            e20 = ema(c15, 20)[-1]
            new_stop = e20 * (1 - STOP_BUFFER) if side == 'Buy' else e20 * (1 + STOP_BUFFER)
            if side == 'Buy' and new_stop > pst['stop']:
                pst['stop'] = new_stop
                set_sl(sym, pst['stop'])
            if side == 'Sell' and new_stop < pst['stop']:
                pst['stop'] = new_stop
                set_sl(sym, pst['stop'])
        except Exception:
            pass
    # 软件止损兜底
    hit = (side == 'Buy' and mark <= pst['stop']) or (side == 'Sell' and mark >= pst['stop'])
    if hit:
        log('软件止损触发 mark=%.6g stop=%.6g' % (mark, pst['stop']))
        r, _ = market_order(sym, 'Sell' if side == 'Buy' else 'Buy', qty_now)
        log('止损平仓 ret=%s' % r.get('retCode'))
        return settle(st, '止损平仓', exit_est=mark)
    return st

def settle(st, why, exit_est=None):
    pst = st['pos']
    direction = 1 if pst['side'] == 'Buy' else -1
    sym = pst['sym']
    px = exit_est if exit_est else ticker(sym)['price']
    gross = direction * (px - pst['entry']) * pst['qty']
    cost = pst['entry'] * pst['qty'] * COST_RATE
    fund = pst.get('fund', 0.0)   # S45修复③: 资金费计入净盈亏
    net = round(gross - cost + pst.get('realized', 0.0) - fund, 4)
    st['day_pnl'] = round(st['day_pnl'] + net, 4)
    if net < 0:
        st['consec'] += 1
    else:
        st['consec'] = 0
    games = load_games()
    g = {'n': len(games) + 1, 'sym': sym, 'side': pst['side'], 'why': pst['why'],
         'entry': pst['entry'], 'exit': round(px, 6), 'qty': pst['qty'], 'net': net,
         'realized_half': pst.get('realized', 0.0), 'fund': round(fund, 4),
         'day_pnl': st['day_pnl'], 'consec': st['consec'],
         'at': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + 8 * 3600))}
    games.append(g)
    save_games(games)
    log('平仓结算[%s]: %s %s net=%+.4fU (毛利%+.4f 费%.4f 资金费%+.4f) 当日=%+.2fU 连亏=%d' %
        (why, sym, pst['side'], net, gross, cost, fund, st['day_pnl'], st['consec']))
    st['pos'] = None
    st['mode'] = 'IDLE'
    st['games'] = len(games)
    return st

def main():
    st = load_state()
    log('=== trend_bot v1.2 start. symbols=%s lev=%d budget=%.1f (S45修复版+心跳) ===' % (SYMBOLS, LEV, BUDGET))
    # 启动对账(铁律): 本机器人标的若有持仓但state为IDLE -> FATAL
    if st['mode'] != 'OPEN':
        for sym in SYMBOLS:
            p = pos_of(sym)
            if p:
                log('FATAL: 检测到持仓 %s %s %s @%s, 与state不一致, 机器人不自动平仓, 请总管人工处理后重启' %
                    (sym, p.get('side'), p.get('size'), p.get('avgPrice')))
                save_state(st)
                sys.exit(1)
    if st['mode'] == 'OPEN':
        log('恢复持仓跟踪: %s %s qty=%s entry=%s' % (st['pos']['sym'], st['pos']['side'], st['pos']['qty'], st['pos']['entry']))
    start_ts = time.time()
    last_hb = 0.0
    while True:
        try:
            st = load_state()
            st['wallet'] = wallet()
            if st['mode'] == 'IDLE':
                st = try_open(st) or st
            else:
                st = manage_pos(st)
            save_state(st)
            # 心跳: 空仓时每15分钟报一次巡逻状态(驾驶舱可见机器人活着)
            if st['mode'] == 'IDLE' and time.time() - last_hb >= 900:
                last_hb = time.time()
                log('巡逻中: 空仓无信号 (已运行%.0f分钟, 日盈亏%+.2fU, 连亏%d)' %
                    ((time.time() - start_ts) / 60, st['day_pnl'], st['consec']))
        except Exception as e:
            log('轮询异常: %s' % str(e)[:120])
        time.sleep(POLL_SEC)

if __name__ == '__main__':
    main()
