# -*- coding: utf-8 -*-
# probe_skr2.py — SKR 初始化失败第二轮隔离: 10x短(带/不带移动), 不行再诊断多方向
import grid_roll as g, sys, time

sym = 'SKRUSDT'
bars = g.klines(sym, '240', 200)[:-1]
c = [float(b[4]) for b in bars]
px_raw = float(c[-1])
trs = [max(float(bars[i][2]) - float(bars[i][3]),
           abs(float(bars[i][2]) - float(bars[i - 1][4])),
           abs(float(bars[i][3]) - float(bars[i - 1][4]))) for i in range(1, len(bars))]
atr = sum(trs[-14:]) / 14
tick = 0.000001
px = g.rnd_tick(px_raw, tick)
mn = g.rnd_tick(px - 2 * atr, tick)
mx = g.rnd_tick(px + 2 * atr, tick)
print('px=%.6f range=[%s, %s]' % (px, g.fmt_px(mn), g.fmt_px(mx)))

combos = [
    ('E : 10x 做空 移动 40格', '10', 3, 40, True),
    ('E2: 10x 做空 无移动 40格', '10', 3, 40, False),
    ('E4: 20x 做多 无移动 10格(诊断)', '20', 2, 10, False),
    ('E5: 10x 做多 无移动 10格(诊断)', '10', 2, 10, False),
]
for tag, lev, mode, cells, use_move in combos:
    base = {'symbol': sym, 'grid_mode': mode, 'grid_type': 1,
            'min_price': g.fmt_px(mn), 'max_price': g.fmt_px(mx),
            'cell_number': cells, 'leverage': lev, 'total_investment': '10'}
    if use_move:
        base['move_up_price'] = g.fmt_px(min(mx * 1000, 12.5))
        base['move_down_price'] = g.fmt_px(max(mn / 1000, 0.000001))
    r = g.api('POST', '/v5/fgridbot/create', body=base)
    if r.get('retCode') != 0:
        print('%s -> create rejected: %s' % (tag, str(r.get('retMsg'))[:60]))
        time.sleep(2)
        continue
    bid = str((r.get('result') or {}).get('bot_id') or '')
    time.sleep(15)
    d = g.grid_detail(bid)
    st = str(d.get('status') or '')
    ok = st and 'COMPLETED' not in st and 'FAIL' not in st
    print('%s -> bid=%s status=%s close=%s %s' % (tag, bid, st, d.get('close_reason'), d.get('bot_close_code')))
    if ok:
        print('VERIFIED-RUNNING:', tag)
        if mode == 3:
            with open('grid_bot_id.txt', 'a') as f:
                f.write(bid + '\n')
            reg = g.load_reg()
            reg.setdefault('focus', [])
            if bid not in reg['focus']:
                reg['focus'].append(bid)
            g.save_reg(reg)
            print('BIDF+focus done')
            sys.exit(0)
        else:
            g.close_grid(bid)
            print('diagnostic long closed')
    time.sleep(2)
print('ALL-FAILED')
sys.exit(1)
