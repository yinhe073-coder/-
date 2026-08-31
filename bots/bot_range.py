# -*- coding: utf-8 -*-
# range_bot v4.9 — 滚仓模式: 不停(MAX_GAMES=9999), 权益动态放大(名义=权益x10), 止盈=净赚1U(触发线=1U+手续费缓冲+资金费缓冲)
# 阶梯: 权益>=100 划50到主账户; >=500 划250; >=1000 停并报告
import hashlib, hmac, json, time, uuid, os, sys
import urllib.request, urllib.error

BASE = 'https://api.bybit.com'
KEY = os.environ['BYBIT_API_KEY']
SECRET = os.environ['BYBIT_API_SECRET']
MASTER_KEY = os.environ.get('BYBIT_MASTER_KEY', '')
MASTER_SECRET = os.environ.get('BYBIT_MASTER_SECRET', '')

POOL = ['DOGEUSDT', 'ENAUSDT', 'SUIUSDT', 'TRUMPUSDT', '1000PEPEUSDT', 'SOLUSDT']
MAX_GAMES = 9999
GAME_MINUTES = 360   # v4.5: S43寻优最优=360min
NOTIONAL = 250.0          # 占位, 实际动态 = equity*LEV
TP_NET = 1.0              # v4.8/v4.9 主人钦定: 每单扣除所有成本后净赚1U
COST_RATE = 0.0013        # 0.13%/来回(taker0.055%x2+滑点0.01%x2), 按名义计
FUND_SETTLE_PER_GAME = 2  # 6小时局最多跨2个资金费结算点, 缓冲按此计
LEV = 10                 # v4.5: S43寻优最优=10x(爆仓率3.5% vs 20x 11.3%, 期望/名义+0.93% vs +0.30%)
# 2026-08-30 白露(试错期风控): 原实现把**全部权益**押进单局(名义=权益x10, 逐仓保证金≈权益x0.97),
# 意味着"一局爆仓 = 账户归零"。改为单局只投入权益的 30% 作为保证金:
# 单局最坏损失从 ~97% 降到 ~30%, 连爆三局仍留有约 34% 权益。
# 止盈目标按同比例缩放, 保证策略每局要求的**百分比波动**不变(净1U/满仓 ≈ 净0.3U/三成仓 ≈ 1.16% 波动)。
RISK_FRACTION = 0.30
POLL_SEC = 10
LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
os.makedirs(LOG_DIR, exist_ok=True)
GAMES_FILE = os.path.join(LOG_DIR, 'games.json')
KILL_FILE = '/opt/quant/killswitch'
# 2026-08-30 白露: 原为固定 15.0U(试点沿用, 当时账户 20U+)。当前账户仅 10U 时,
# 阈值高于本金 => 账户亏光也触发不了熔断, 形同虚设。改为「起始权益的 20%」动态计算。
LOSS_LIMIT_FRACTION = 0.20
LOSS_LIMIT_FLOOR = 2.0    # 下限 2U, 防止账户极小时阈值趋近 0 导致频繁误熔断
MARGIN_CHECK_SEC = 300
_margin_cache = {'ts': 0, 'ok': False}
TARGET_REPORT = 1000.0    # 达到即停并报告主人

def equity():
    """可用 USDT 余额(下单基数, 用钱包可用余额而非总权益)"""
    d = authed('GET', '/v5/account/wallet-balance', 'accountType=UNIFIED&category=linear')
    eq = 0.0
    for a in d.get('result', {}).get('list', []):
        for coin in a.get('coin', []):
            if coin.get('coin') == 'USDT':
                try:
                    eq = float(coin.get('walletBalance') or 0)
                except Exception:
                    eq = 0.0
    if eq <= 0:
        for a in d.get('result', {}).get('list', []):
            try:
                eq = float(a.get('totalEquity') or 0)
            except Exception:
                pass
    return eq

def transfer_to_master(amount):
    if not MASTER_KEY:
        log('no master key, transfer skipped')
        return False
    ts = str(int(time.time() * 1000))
    recv = '5000'
    body = json.dumps({'transferId': str(uuid.uuid4()), 'coin': 'USDT', 'amount': str(amount),
                       'fromMemberId': 'YOUR_SUB_UID', 'toMemberId': 'YOUR_MASTER_UID',
                       'fromAccountType': 'UNIFIED', 'toAccountType': 'UNIFIED'}, separators=(',', ':'))
    sign = hmac.new(MASTER_SECRET.encode(), (ts + MASTER_KEY + recv + body).encode(), hashlib.sha256).hexdigest()
    req = urllib.request.Request(BASE + '/v5/asset/transfer/universal-transfer', data=body.encode(),
                                 headers={'X-BAPI-API-KEY': MASTER_KEY, 'X-BAPI-TIMESTAMP': ts,
                                          'X-BAPI-RECV-WINDOW': recv, 'X-BAPI-SIGN': sign,
                                          'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            res = json.loads(r.read().decode())
        ok = res.get('retCode') == 0
        log('TRANSFER %.0fU to master: ret=%s %s' % (amount, res.get('retCode'), res.get('retMsg')))
        return ok
    except Exception as e:
        log('TRANSFER fail: %s' % str(e)[:100])
        return False

_roll_state = {'last_eq': 0.0, 'last_transfer_ts': 0.0, 'fail_count': 0}

def roll_check():
    """v4.2: 划转阶梯 + 防抖(滞回+30min最小间隔+指数退避) + 失败如实报"""
    eq = equity()
    if eq >= TARGET_REPORT:
        log('=== TARGET REACHED: equity %.2f >= %.0f, STOP AND REPORT ===' % (eq, TARGET_REPORT))
        return 'stop', eq
    # 滞回: 权益须比上次划转后高 10U 才考虑再次划转
    if _roll_state['last_eq'] > 0 and eq < _roll_state['last_eq'] + 10:
        return 'continue', eq
    # 最小间隔 30 分钟
    if time.time() - _roll_state['last_transfer_ts'] < 1800:
        return 'continue', eq
    # 失败退避: 指数, 封顶 3 小时
    backoff = min(10800, 900 * (2 ** min(_roll_state['fail_count'], 4)))
    if time.time() - _roll_state['last_transfer_ts'] < backoff:
        return 'continue', eq
    for threshold, amount, desc in [(500.0, 250.0, '500阶梯'), (100.0, 50.0, '100阶梯')]:
        if eq >= threshold and eq - amount > 20:  # 20U 余量=划转后保证金缓冲
            ok = transfer_to_master(amount)
            _roll_state['last_transfer_ts'] = time.time()
            if ok:
                _roll_state['fail_count'] = 0
                _roll_state['last_eq'] = equity()
                log('ROLL %s: OK (划转 %.0f, 划后权益 %.2f)' % (desc, amount, _roll_state['last_eq']))
                return 'transferred', _roll_state['last_eq']
            else:
                _roll_state['fail_count'] += 1
                log('ROLL %s: FAILED, 退避 %.0f 秒后重试 (fail#%d)' % (desc, backoff, _roll_state['fail_count']))
                return 'continue', eq
    return 'continue', eq

def kill_switched():
    return os.path.exists(KILL_FILE)

def margin_ok():
    now = time.time()
    if now - _margin_cache['ts'] > MARGIN_CHECK_SEC:
        d = authed('GET', '/v5/account/info')
        _margin_cache['ok'] = d.get('result', {}).get('marginMode') == 'ISOLATED_MARGIN'
        _margin_cache['ts'] = now
        if not _margin_cache['ok']:
            log('WARN: marginMode != ISOLATED_MARGIN')
    return _margin_cache['ok']

def log(msg):
    line = '[%s] %s' % (time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + 8 * 3600)), msg)
    print(line, flush=True)
    with open(os.path.join(LOG_DIR, 'bot.log'), 'a', encoding='utf-8') as f:
        f.write(line + '\n')

def public(path, qs=''):
    with urllib.request.urlopen(BASE + path + ('?' + qs if qs else ''), timeout=20) as r:
        return json.loads(r.read().decode())

def authed(method, path, qs='', body=None):
    ts = str(int(time.time() * 1000))
    recv = '5000'
    payload = qs if method == 'GET' else (body if body else '')
    sign = hmac.new(SECRET.encode(), (ts + KEY + recv + payload).encode(), hashlib.sha256).hexdigest()
    headers = {'X-BAPI-API-KEY': KEY, 'X-BAPI-TIMESTAMP': ts,
               'X-BAPI-RECV-WINDOW': recv, 'X-BAPI-SIGN': sign}
    req = urllib.request.Request(BASE + path + ('?' + qs if method == 'GET' else ''),
                                 data=payload.encode() if method == 'POST' else None,
                                 headers=headers, method=method)
    if method == 'POST':
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {'retCode': -1, 'retMsg': 'HTTP ' + str(e.code)}

def klines(sym, limit=120):
    try:
        d = public('/v5/market/kline', f'category=linear&symbol={sym}&interval=1&limit={limit}')
        lst = d.get('result', {}).get('list', [])
        lst.sort(key=lambda x: int(x[0]))
        return [[float(x[1]), float(x[2]), float(x[3]), float(x[4])] for x in lst]
    except Exception as e:
        log('kline fail %s %s' % (sym, e))
        return None

def funding_rate(sym):
    try:
        d = public('/v5/market/tickers', f'category=linear&symbol={sym}')
        return abs(float(d['result']['list'][0]['fundingRate']))
    except Exception:
        return 0.0001  # 默认按0.01%计提缓冲

_instr_cache = {}
def qty_step(sym):
    if sym not in _instr_cache:
        d = public('/v5/market/instruments-info', f'category=linear&symbol={sym}')
        it = d['result']['list'][0]['lotSizeFilter']
        _instr_cache[sym] = (float(it['qtyStep']), float(it['minOrderQty']))
    return _instr_cache[sym]

def position(sym=None):
    d = authed('GET', '/v5/position/list', 'category=linear&settleCoin=USDT')
    for p in d.get('result', {}).get('list', []):
        if float(p.get('size', 0)) > 0:
            if sym is None or p.get('symbol') == sym:
                return p
    return None

def ensure_isolated():
    d = authed('GET', '/v5/account/info')
    mm = d.get('result', {}).get('marginMode', '')
    if mm != 'ISOLATED_MARGIN':
        r = authed('POST', '/v5/account/set-margin-mode',
                   body=json.dumps({'setMarginMode': 'ISOLATED_MARGIN'}, separators=(',', ':')))
        log('set-margin-mode(ISOLATED): ret=%s %s' % (r.get('retCode'), r.get('retMsg')))
        time.sleep(2)
        d = authed('GET', '/v5/account/info')
        mm = d.get('result', {}).get('marginMode', '')
    if mm != 'ISOLATED_MARGIN':
        log('FATAL: marginMode=%s not ISOLATED, refuse to trade' % mm)
        return False
    return True

def set_lev(sym):
    r = authed('POST', '/v5/position/set-leverage',
               body=json.dumps({'category': 'linear', 'symbol': sym,
                                'buyLeverage': str(LEV), 'sellLeverage': str(LEV)}, separators=(',', ':')))
    log('set_lev %s -> ret=%s %s' % (sym, r.get('retCode'), r.get('retMsg')))
    return r.get('retCode') == 0 or r.get('retCode') == 110043  # 110043 = 已同值

def confirm_range(bars):
    if len(bars) < 61:
        return False
    lo = min(x[2] for x in bars[-60:])
    hi = max(x[1] for x in bars[-60:])
    amp = (hi - lo) / lo
    r60 = abs(bars[-1][3] / bars[-61][3] - 1)
    return amp < 0.03 and r60 < 0.015

def boll(bars):
    if len(bars) < 20:
        return None, None
    closes = [x[3] for x in bars[-20:]]
    ma = sum(closes) / 20
    var = sum((c - ma) ** 2 for c in closes) / 20
    sd = var ** 0.5
    return ma + 2 * sd, ma - 2 * sd

def place(sym, side, link_id, eq):
    step, minq = qty_step(sym)
    d = public('/v5/market/tickers', f'category=linear&symbol={sym}')
    px = float(d['result']['list'][0]['lastPrice'])
    notional = eq * LEV * 0.97 * RISK_FRACTION  # v4.4 留3%余量付手续费 + 白露: 单局只投三成权益
    qty = round(int(notional / px / step) * step, 8)
    if qty < minq:
        qty = minq
    body = json.dumps({'category': 'linear', 'symbol': sym, 'side': side,
                       'orderType': 'Market', 'qty': str(qty), 'timeInForce': 'IOC',
                       'positionIdx': 0, 'orderLinkId': link_id}, separators=(',', ':'))
    r = authed('POST', '/v5/order/create', body=body)
    return r, px, qty

def place_batch(sym, side, link_id, eq, fraction):
    """分批建仓: 每批 = 目标名义(权益×杠杆×0.97×RISK_FRACTION) × fraction"""
    step, minq = qty_step(sym)
    d = public('/v5/market/tickers', f'category=linear&symbol={sym}')
    px = float(d['result']['list'][0]['lastPrice'])
    notional = eq * LEV * 0.97 * RISK_FRACTION * fraction
    qty = round(int(notional / px / step) * step, 8)
    if qty < minq:
        qty = minq
    body = json.dumps({'category': 'linear', 'symbol': sym, 'side': side,
                       'orderType': 'Market', 'qty': str(qty), 'timeInForce': 'IOC',
                       'positionIdx': 0, 'orderLinkId': link_id}, separators=(',', ':'))
    r = authed('POST', '/v5/order/create', body=body)
    return r, px, qty

def close_all(sym):
    p = position(sym)
    if not p:
        return {'retCode': -2, 'retMsg': 'no-position'}
    size = float(p['size'])
    side = 'Sell' if p['side'] == 'Buy' else 'Buy'
    body = json.dumps({'category': 'linear', 'symbol': sym, 'side': side,
                       'orderType': 'Market', 'qty': str(size), 'timeInForce': 'IOC',
                       'positionIdx': 0, 'reduceOnly': True,
                       'orderLinkId': 'close-' + uuid.uuid4().hex[:8]}, separators=(',', ':'))
    return authed('POST', '/v5/order/create', body=body)

def recover_startup():
    # v3.3: 启动时存在任何持仓 -> FATAL 退出, 绝不自动平仓(人工决策), 防误平
    p = position()
    if p:
        log('FATAL: 检测到持仓 %s %s %s @ %s, 机器人不自动平仓, 请总管人工处理后再启动' %
            (p['symbol'], p['side'], p['size'], p.get('avgPrice')))
        sys.exit(1)
    done = 0
    if os.path.exists(GAMES_FILE):
        try:
            with open(GAMES_FILE, encoding='utf-8') as f:
                done = len(json.load(f))
        except Exception:
            done = 0
    return done

def main():
    log('=== range_bot v4.9 start. pool=%s max_games=%d ===' % (POOL, MAX_GAMES))
    if not ensure_isolated():
        log('FATAL: isolated margin not confirmable, exit')
        return
    games_done = recover_startup()
    log('games_done resumed = %d' % games_done)
    games = []
    skip_until = {}  # R3: set_lev 失败的币 10 分钟内不 pick
    while games_done < MAX_GAMES:
        picked = None
        bars_p = None
        best_amp = 9.9  # v4.7: 全池比选, 挑60分钟振幅最小的币(最安静), 不按顺序偏心
        now = time.time()
        for sym in POOL:
            if now < skip_until.get(sym, 0):
                continue
            bars = klines(sym, 120)
            if not bars or len(bars) < 61:
                continue
            if not confirm_range(bars):
                continue
            if position():
                continue
            lo = min(x[2] for x in bars[-60:])
            hi = max(x[1] for x in bars[-60:])
            amp = (hi - lo) / lo
            if amp < best_amp:
                best_amp = amp
                picked, bars_p = sym, bars
        if not picked:
            if kill_switched():
                log('KILL SWITCH triggered in idle loop, exit')
                return
            time.sleep(60)
            continue
        sym = picked
        log('全池比选: %s 振幅最小 %.2f%%, 选中' % (sym, best_amp * 100))
        if not set_lev(sym):
            log('set_lev failed for %s, skip 10min' % sym)
            skip_until[sym] = time.time() + 600
            time.sleep(60)
            continue
        log('GAME %d: range confirmed on %s' % (games_done + 1, sym))
        eq_start_now = round(equity(), 2)
        game = {'n': games_done + 1, 'sym': sym, 'trades': [], 'banked': 0.0, 'busted': False,
                'start': time.time(), 'result': None, 'last_close_pnl': 0.0, 'batches': 0,
                'eq_start': eq_start_now,  # v4.3: 局初权益, 爆仓记账=亏光局初权益
                'fund_cushion': round(funding_rate(sym) * eq_start_now * LEV * FUND_SETTLE_PER_GAME, 4)}  # v4.9: 资金费缓冲(最多2个结算点)
        deadline = time.time() + GAME_MINUTES * 60
        in_pos = False
        entry_px = None
        pos_side = None
        last_order_ts = 0
        no_pos_count = 0
        while time.time() < deadline:
            try:
                if kill_switched():
                    log('KILL SWITCH triggered: stop opening, close all and exit')
                    p = position(sym)
                    if p:
                        close_all(sym)
                    log('=== KILL SWITCH EXIT ===')
                    return
                bars = klines(sym, 40)
                p = position(sym)
                if p:
                    sz = float(p['size'])
                    if sz > 0 and not in_pos:
                        in_pos = True
                        entry_px = float(p['avgPrice'])
                        pos_side = p['side']
                        log('  opened %s %.6f @ %s' % (pos_side, sz, entry_px))
                    no_pos_count = 0
                else:
                    if in_pos:
                        no_pos_count += 1
                        if no_pos_count >= 3:  # 连续3次确认才判定
                            if game['trades'] and game['trades'][-1].get('tp'):
                                log('  closed by TP')
                            else:
                                game['busted'] = True
                                log('  *** BUSTED (position gone, no TP) ***')
                                game['result'] = 'busted'
                                break
                            in_pos = False
                            no_pos_count = 0
                        time.sleep(POLL_SEC)
                        continue
                    # p is None 且 in_pos False -> fall through 到布林开单判断
                if not in_pos:
                    up, lo = boll(bars)
                    if up is None or time.time() - last_order_ts < 60:
                        time.sleep(POLL_SEC)
                        continue
                    if not margin_ok():
                        log('ABORT trade: marginMode not ISOLATED (fail-closed)')
                        time.sleep(60)
                        continue
                    c = bars[-1][3]
                    r = None
                    eq = equity()
                    if c >= up:
                        r, px, qty = place_batch(sym, 'Sell', 'r%s-g%d-t%d-b1' % (games_done + 1, len(game['trades']) + 1, int(time.time())), eq, 1.0 / 3)
                        log('  SHORT 第1批 try @ %s qty=%s ret=%s' % (px, qty, r.get('retCode')))
                        side = 'Sell'
                    elif c <= lo:
                        r, px, qty = place_batch(sym, 'Buy', 'r%s-g%d-t%d-b1' % (games_done + 1, len(game['trades']) + 1, int(time.time())), eq, 1.0 / 3)
                        log('  LONG 第1批 try @ %s qty=%s ret=%s' % (px, qty, r.get('retCode')))
                        side = 'Buy'
                    if r is not None:
                        last_order_ts = time.time()
                        if r.get('retCode') == 0:
                            game['trades'].append({'side': side, 'link': len(game['trades']) + 1})
                            game['batches'] = 1
                            log('  order accepted, batch 1 recorded')
                            time.sleep(5)
                            p2 = position(sym)
                            log('  confirm check: %s' % ('position ok' if p2 else 'position not found (will re-check)'))
                        elif r.get('retCode') == 110007:
                            log('  余额不足(110007), 等 5 分钟结算后再试')
                            time.sleep(300)
                        else:
                            time.sleep(60)
                else:
                    upnl = float(p.get('unrealisedPnl', 0))
                    eq = equity()
                    # v4.9: 触发线 = 1U净利 + 手续费缓冲(0.13%x名义) + 资金费缓冲(最多2个结算点)
                    # 白露: 仓位按 RISK_FRACTION 缩小后, 手续费与止盈目标同步缩放, 保持每局要求的百分比波动不变
                    tp_nominal = (TP_NET * RISK_FRACTION + COST_RATE * eq * LEV * RISK_FRACTION
                                  + game.get('fund_cushion', 0) * RISK_FRACTION)
                    if upnl >= tp_nominal:
                        r = close_all(sym)
                        profit = TP_NET * RISK_FRACTION
                        game['banked'] += profit
                        if game['trades']:
                            game['trades'][-1]['tp'] = True
                        log('  TP! 净+%.2fU (触发线%.3f, 含手续费%.3f+资金费缓冲%.4f) ret=%s' %
                            (profit, tp_nominal, COST_RATE * eq * LEV, game.get('fund_cushion', 0), r.get('retCode')))
                        in_pos = False
                        no_pos_count = 0
                        game['batches'] = 0
                    else:
                        # v4.6 分批加仓: 浮亏达 0.5×ATR 且未满 3 批 -> 反向加一批(分时极端位分批介入)
                        if game.get('batches', 0) < 3 and bars and len(bars) >= 15:
                            trs = []
                            for i in range(1, len(bars)):
                                trs.append(max(bars[i][1] - bars[i][2],
                                               abs(bars[i][1] - bars[i - 1][3]),
                                               abs(bars[i][2] - bars[i - 1][3])))
                            atr = sum(trs[-14:]) / 14 if len(trs) >= 14 else 0.001
                            loss = -upnl
                            if loss >= 0.5 * atr * (game.get('batches', 0)) * float(p.get('size')) and time.time() - last_order_ts >= 120:
                                side2 = p['side']
                                bnum = game.get('batches', 0) + 1
                                r2, px2, qty2 = place_batch(sym, side2, 'r%s-g%d-t%d-b%d' % (games_done + 1, len(game['trades']) + 1, int(time.time()), bnum), eq, 1.0 / 3)
                                log('  加仓第%d批 try @ %s qty=%s ret=%s (浮亏 %.2f, ATR %.5f)' % (bnum, px2, qty2, r2.get('retCode'), loss, atr))
                                if r2.get('retCode') == 0:
                                    game['batches'] = bnum
                                    game['trades'].append({'side': side2, 'link': len(game['trades']) + 1})
                                    last_order_ts = time.time()
                                    log('  第%d批成交, 累计%d批' % (bnum, bnum))
                                else:
                                    last_order_ts = time.time()
            except Exception as e:
                log('  loop err: %s' % e)
            time.sleep(POLL_SEC)
        p = position(sym)
        if p:
            r = close_all(sym)
            log('  game timeout, force close ret=%s' % r.get('retCode'))
            game['last_close_pnl'] = float(p.get('unrealisedPnl', 0))
        if not game['busted'] and not game['result']:
            game['result'] = 'done'
        game['net'] = round(game['banked'] - game['eq_start'], 2) if game['busted'] else round(game['banked'], 2)  # v4.3: 爆仓=亏光局初权益
        games.append(game)
        games_done += 1
        log('GAME %d END: result=%s banked=%.2f net=%+.2f last_close_pnl=%+.2f trades=%d' %
            (game['n'], game['result'], game['banked'], game['net'], game['last_close_pnl'], len(game['trades'])))
        with open(GAMES_FILE, 'w', encoding='utf-8') as f:
            json.dump(games, f, indent=2)
        cum_net = sum(g['net'] for g in games)
        # 白露: 熔断阈值改为「起始权益的 20%」(原固定 15U 在小账户下永远触发不了)
        eq0 = (games[0].get('eq_start') or 0) if games else 0
        loss_limit = max(LOSS_LIMIT_FLOOR, eq0 * LOSS_LIMIT_FRACTION)
        if cum_net <= -loss_limit:
            log('FATAL: cumulative net %+.2f <= -%.2f limit (起始权益%.2f 的 %d%%), STOP ALL TRADING'
                % (cum_net, loss_limit, eq0, int(LOSS_LIMIT_FRACTION * 100)))
            open(KILL_FILE, 'a').close()
            break
        # v4: 滚仓阶梯检查
        state, eq_now = roll_check()
        if state == 'stop':
            log('=== TARGET %s REACHED (%.2fU), bot stopped, notify master ===' % (TARGET_REPORT, eq_now))
            break
    total = sum(g['net'] for g in games)
    busted = sum(1 for g in games if g['busted'])
    log('=== ALL DONE: %d games, busted %d, total net %+.2f U ===' % (len(games), busted, total))

if __name__ == '__main__':
    main()
