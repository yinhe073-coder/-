# -*- coding: utf-8 -*-
# ath_atl_scan.py — 扫描近2日创历史新高/新低的加密永续 (Bybit 公开行情, 无需密钥)
# 方法: 月线(排除当月)求 ATH/ATL, 用最近两个完整日K + 今日24h高低判断是否突破
import json, time, urllib.request, urllib.error, sys, datetime
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding='utf-8')
BASE = 'https://api.bybit.com'
RATE = 1.4          # 每秒请求上限 (Bybit 公开端点 ~120/min/IP, 留余量)
lock_ts = [time.monotonic()]
TODAY = time.strftime('%Y-%m-%d', time.gmtime(time.time() + 8 * 3600))

def api(path, qs):
    while time.monotonic() - lock_ts[0] < 1.0 / RATE:
        time.sleep(0.05)
    lock_ts[0] = time.monotonic()
    for attempt in range(4):
        try:
            req = urllib.request.Request(BASE + path + '?' + qs, headers={'User-Agent': 'dsh-scan'})
            r = json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
            if r.get('retCode') == 10006:
                time.sleep(1.5 + attempt)
                continue
            return r.get('result') or {}
        except Exception:
            time.sleep(0.6)
    return {}

def klines(sym, interval, limit):
    d = api('/v5/market/kline', 'category=linear&symbol=%s&interval=%s&limit=%d' % (sym, interval, limit))
    return sorted(d.get('list', []), key=lambda x: int(x[0]))

def bar_date(ms):
    return datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m-%d')

def bar_month(ms):
    return datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y-%m')

def scan(sym):
    try:
        m = klines(sym, 'M', 200)
        if not m:
            return None
        # 排除当月(未走完)的历史
        hist = [b for b in m if bar_month(b[0]) < TODAY[:7]]
        if not hist:
            return None
        ath, atl = max(float(b[2]) for b in hist), min(float(b[3]) for b in hist)
        n_months = len(hist)
        # 最近两个完整日K
        d = klines(sym, 'D', 4)
        full = [b for b in d if bar_date(b[0]) < TODAY][-2:]
        if not full:
            return None
        events = []
        for b in full:
            hi, lo = float(b[2]), float(b[3])
            date = bar_date(b[0])[5:]
            if hi > ath * 1.0000005:
                events.append(('ATH', date, hi, (hi / ath - 1) * 100))
            if lo < atl * 0.9999995:
                events.append(('ATL', date, lo, (lo / atl - 1) * 100))
        # 今日(24h)高低
        tk = api('/v5/market/tickers', 'category=linear&symbol=%s' % sym)
        t = (tk.get('list') or [{}])[0]
        h24, l24 = float(t.get('highPrice24h') or 0), float(t.get('lowPrice24h') or 0)
        if h24 > ath * 1.0000005 and not any(e[0] == 'ATH' for e in events):
            events.append(('ATH', '今日', h24, (h24 / ath - 1) * 100))
        if l24 < atl * 0.9999995 and not any(e[0] == 'ATL' for e in events):
            events.append(('ATL', '今日', l24, (l24 / atl - 1) * 100))
        if not events:
            return None
        return {'sym': sym, 'months': n_months, 'events': events}
    except Exception as e:
        return {'sym': sym, 'error': str(e)[:60]}

def main():
    t0 = time.time()
    top = api('/v5/market/tickers', 'category=linear').get('list', [])
    cands = sorted([t for t in top if float(t.get('turnover24h') or 0) >= 5e5],
                   key=lambda x: -float(x['turnover24h']))[:120]
    print('扫描 %d 个标的 (成交额Top120)...' % len(cands))
    hits, errs = [], []
    with ThreadPoolExecutor(max_workers=4) as ex:
        for r in ex.map(scan, [t['symbol'] for t in cands]):
            if r is None:
                continue
            if 'error' in r:
                errs.append(r)
            else:
                hits.append(r)
    ath = sorted([h for h in hits if any(e[0] == 'ATH' for e in h['events'])],
                 key=lambda x: -max(e[3] for e in x['events'] if e[0] == 'ATH'))
    atl = sorted([h for h in hits if any(e[0] == 'ATL' for e in h['events'])],
                 key=lambda x: min(e[3] for e in x['events'] if e[0] == 'ATL'))
    out = {'scan_at': time.strftime('%Y-%m-%d %H:%M', time.gmtime(time.time() + 8 * 3600)),
           'ath': [{'sym': h['sym'], 'months': h['months'], 'events': [e for e in h['events'] if e[0] == 'ATH']} for h in ath],
           'atl': [{'sym': h['sym'], 'months': h['months'], 'events': [e for e in h['events'] if e[0] == 'ATL']} for h in atl],
           'errors': len(errs), 'elapsed_s': round(time.time() - t0, 1)}
    with open(r'WORKSPACE\量化交易\工程\scripts\ath_atl_result.json', 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print('=== 近2日创历史新高 (%d) ===' % len(ath))
    for h in ath:
        es = [e for e in h['events'] if e[0] == 'ATH']
        print('%-14s 上市%3d个月  %s' % (h['sym'], h['months'],
              '; '.join('%s +%.1f%%' % (e[1], e[3]) for e in es)))
    print('=== 近2日创历史新低 (%d) ===' % len(atl))
    for h in atl:
        es = [e for e in h['events'] if e[0] == 'ATL']
        print('%-14s 上市%3d个月  %s' % (h['sym'], h['months'],
              '; '.join('%s %.1f%%' % (e[1], e[3]) for e in es)))
    print('errors=%d elapsed=%.0fs' % (len(errs), time.time() - t0))

if __name__ == '__main__':
    main()
