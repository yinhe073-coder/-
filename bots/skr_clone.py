# -*- coding: utf-8 -*-
# skr_clone.py — SKR 克隆塔监控 (主人钦定 2026-08-31)
# 规则: 盯着 SKRUSDT 历史最高价(锚点 0.026222), 每上涨 0.003 就克隆主人的 SKR 机器人一单;
#       克隆参数完全复制主人的: 做空/20x/100格/等比格/移动(1, 0.000001)/10U, 区间按当前价等比缩放;
#       主人的机器人永不关闭(软件也不碰, 见 grid_roll noclose); 资金 < 12U 时停止并写告警文件
import grid_roll as g, json, time, sys

SYM = 'SKRUSDT'
ANCHOR = 0.026222
STEP = 0.003
MASTER_BOT = 'YOUR_BOT_ID'
FUND_MIN = 12.0
INVEST = '10'
CELLS = 100
LEV = '20'
RATIO_MIN = 0.9738   # 主人区间: min/entry
RATIO_MAX = 1.0995   # 主人区间: max/entry
TICK_SEC = 60
RETRY_SEC = 900
VERIFY_SEC = 75
STATE = 'skr_clone_state.json'
LOGF = 'skr_clone.log'
TICK = 0.000001

def log(m):
    line = '[%s] %s' % (time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + 8 * 3600)), m)
    print(line, flush=True)
    try:
        with open(LOGF, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def load_state():
    try:
        return json.load(open(STATE, encoding='utf-8'))
    except Exception:
        return {'ath': ANCHOR, 'next': round(ANCHOR + STEP, 6), 'pending': None,
                'clones': [], 'fund_low': False, 'last_try': 0.0}

def save_state(s):
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(s, f, ensure_ascii=False, indent=1)

def fund_low_marker(s):
    try:
        with open('skr_fund_low.txt', 'w', encoding='utf-8') as f:
            f.write('fund < %.0fU, pending=%.6f, 克隆暂停, 等主人补资金\n' % (FUND_MIN, s['pending'] or 0))
    except Exception:
        pass

log('=== SKR 克隆塔启动: 锚点 %.6f, 每 +%.3f 克隆一单, 主人机器人 %s 永不关闭 ===' % (ANCHOR, STEP, MASTER_BOT))
while True:
    try:
        s = load_state()
        tk = g.api('GET', '/v5/market/tickers', 'category=linear&symbol=%s' % SYM)
        px = float(((tk.get('result') or {}).get('list') or [{}])[0].get('lastPrice') or 0)
        if px <= 0:
            time.sleep(TICK_SEC)
            continue
        ath = max(s['ath'], px)
        s['ath'] = round(ath, 6)
        if s['pending'] is None and ath >= s['next']:
            s['pending'] = s['next']
            log('触发克隆: 记录高 %.6f >= 触发线 %.6f' % (ath, s['next']))
        if s['pending'] is not None:
            fund = g.fund_wallet()
            if fund < FUND_MIN:
                if not s['fund_low']:
                    s['fund_low'] = True
                    log('资金不足: fund=%.2f < %.0f, 克隆暂停, 请主人补资金' % (fund, FUND_MIN))
                    fund_low_marker(s)
                save_state(s)
                time.sleep(TICK_SEC)
                continue
            if s['fund_low']:
                s['fund_low'] = False
                log('资金恢复, 继续克隆')
                try:
                    import os
                    os.remove('skr_fund_low.txt')
                except Exception:
                    pass
            if time.time() - s['last_try'] < RETRY_SEC:
                save_state(s)
                time.sleep(TICK_SEC)
                continue
            s['last_try'] = time.time()
            mn = round(px * RATIO_MIN / TICK) * TICK
            mx = round(px * RATIO_MAX / TICK) * TICK
            body = {'symbol': SYM, 'grid_mode': 3, 'grid_type': 2,
                    'min_price': g.fmt_px(mn), 'max_price': g.fmt_px(mx),
                    'cell_number': CELLS, 'leverage': LEV, 'total_investment': INVEST,
                    'move_up_price': '1', 'move_down_price': '0.000001'}
            r = g.api('POST', '/v5/fgridbot/create', body=body)
            if r.get('retCode') != 0:
                log('克隆 create 拒绝: %s (15分钟后再试)' % str(r.get('retMsg'))[:70])
                save_state(s)
                time.sleep(TICK_SEC)
                continue
            bid = str((r.get('result') or {}).get('bot_id') or '')
            log('克隆已提交 bid=%s 区间[%s, %s], 等待 %.0fs 验证' % (bid, g.fmt_px(mn), g.fmt_px(mx), VERIFY_SEC))
            time.sleep(VERIFY_SEC)
            d = g.grid_detail(bid)
            st = str(d.get('status') or '')
            if st and 'COMPLETED' not in st and 'FAIL' not in st:
                log('克隆成功: %s status=%s' % (bid, st))
                with open('grid_bot_id.txt', 'a') as f:
                    f.write(bid + '\n')
                reg = g.load_reg()
                reg.setdefault('noclose', [])
                reg.setdefault('focus', [])
                if bid not in reg['noclose']:
                    reg['noclose'].append(bid)
                if bid not in reg['focus']:
                    reg['focus'].append(bid)
                g.save_reg(reg)
                s['clones'].append({'bid': bid, 'level': s['pending'],
                                    'at': time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(time.time() + 8 * 3600))})
                s['pending'] = None
                s['next'] = round(s['next'] + STEP, 6)
                log('下一触发线: %.6f' % s['next'])
            else:
                log('克隆初始化失败: %s %s (自动退款, %ds 后重试)' % (d.get('close_reason'), d.get('bot_close_code'), RETRY_SEC))
        save_state(s)
        time.sleep(TICK_SEC)
    except Exception as e:
        log('异常: %s' % str(e)[:120])
        time.sleep(TICK_SEC)
