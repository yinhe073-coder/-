# -*- coding: utf-8 -*-
# probe_skr3.py — 目标: SKR 20x + 移动 可运行组合。不同移动值/格数组合 + 打印平台拒因
import grid_roll as g, sys, time, json

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
    ('F: 20x move(12.5/0.001) 10格', '20', 10, '12.5', '0.001'),
    ('A: 20x move(12.5/0.001) 40格', '20', 40, '12.5', '0.001'),
    ('B: 20x move(0.05/0.001) 40格', '20', 40, '0.05', '0.001'),
    ('G: 10x move(12.5/0.001) 10格', '10', 10, '12.5', '0.001'),
    ('H: 20x move(0.05/0.017328) 40格', '20', 40, '0.05', '0.017328'),
]
for tag, lev, cells, mu, md in combos:
    base = {'symbol': sym, 'grid_mode': 3, 'grid_type': 1,
            'min_price': g.fmt_px(mn), 'max_price': g.fmt_px(mx),
            'cell_number': cells, 'leverage': lev, 'total_investment': '10',
            'move_up_price': mu, 'move_down_price': md}
    r = g.api('POST', '/v5/fgridbot/create', body=base)
    if r.get('retCode') != 0:
        print('%s -> create rejected: ret=%s msg=%s' % (tag, r.get('retCode'), str(r.get('retMsg'))[:80]))
        time.sleep(2)
        continue
    res = r.get('result') or {}
    bid = str(res.get('bot_id') or '')
    print('%s -> created bid=%s check_code=%s ban=%s' % (tag, bid, res.get('check_code'), res.get('ban_reason_text')))
    time.sleep(20)
    d = g.grid_detail(bid)
    st = str(d.get('status') or '')
    ok = st and 'COMPLETED' not in st and 'FAIL' not in st
    print('   status=%s close=%s %s' % (st, d.get('close_reason'), d.get('bot_close_code')))
    if ok:
        print('VERIFIED-RUNNING:', tag)
        with open('grid_bot_id.txt', 'a') as f:
            f.write(bid + '\n')
        reg = g.load_reg()
        reg.setdefault('focus', [])
        if bid not in reg['focus']:
            reg['focus'].append(bid)
        g.save_reg(reg)
        print('BIDF+focus done')
        sys.exit(0)
    time.sleep(2)
print('ALL-FAILED')
sys.exit(1)
