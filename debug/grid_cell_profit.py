# -*- coding: utf-8 -*-
# grid_cell_profit.py — 每圈实际利润 vs 平台每圈估计 vs 持仓亏损分解
import grid_roll as g

print('%-9s %6s %7s %7s %8s %9s %9s %9s %9s' % (
    '币', '格数', '圈数', '网格利', '每圈实际', '平台每圈估', '总pnl', '已实现', '未实现'))
for bid in open('grid_bot_id.txt').read().split():
    d = g.grid_detail(bid)
    if not d or 'COMPLETED' in str(d.get('status') or ''):
        continue
    cells = int(float(d.get('cell_number') or 0) or 0)
    arb = int(float(d.get('arbitrage_num') or 0) or 0)
    gp = float(d.get('grid_profit') or 0)
    minp = float(d.get('min_profit') or 0)
    per_cycle = gp / arb if arb > 0 else 0.0
    per_sweep_est = minp  # 平台估计的"整段扫一遍"利润
    per_cell_est = per_sweep_est / cells if cells > 0 else 0.0
    print('%-9s %6d %7d %7.3f %8.5f %9.4f %9.2f %9.2f %9.2f' % (
        d.get('symbol'), cells, arb, gp, per_cycle, per_cell_est,
        float(d.get('pnl') or 0), float(d.get('realised_pnl') or 0), float(d.get('unrealised_pnl') or 0)))
print()
print('=== Configured example bot details ===')
d = g.grid_detail('YOUR_BOT_ID')
print('圈数=%s 网格利润=%s 总pnl=%s' % (d.get('arbitrage_num'), d.get('grid_profit'), d.get('pnl')))
arb = int(float(d.get('arbitrage_num') or 0) or 0)
gp = float(d.get('grid_profit') or 0)
if arb:
    print('每圈实际 = %.6fU, 平台每圈估(整扫/格数) = %.6fU' % (gp / arb, float(d.get('min_profit') or 0) / int(float(d.get('cell_number') or 0) or 1)))
print('== 结论: 网格每圈利润 vs 持仓方向损失 的占比 ==')
