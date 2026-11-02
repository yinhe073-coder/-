# -*- coding: utf-8 -*-
# 同步 VPS 机器人日志到本地 + bot 进程存活探针 -> dashboard/bot_alive.json
import sys, os, json, time
sys.stdout.reconfigure(encoding='utf-8')
import paramiko

ENV = {}
for line in open(r'WORKSPACE\bybit-skill\.env', encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    k, v = line.split('=', 1)
    ENV[k.strip()] = v.strip()

DST = r'WORKSPACE\量化交易\工程\dashboard\botlogs'
DASH = r'WORKSPACE\量化交易\工程\dashboard'
os.makedirs(DST, exist_ok=True)

c = paramiko.SSHClient()
c.load_system_host_keys()
c.set_missing_host_key_policy(paramiko.RejectPolicy())
key = paramiko.RSAKey.from_private_key_file(r'WORKSPACE\bybit-skill\vps_id_rsa')
c.connect(ENV['VPS_HOST'], port=int(ENV['VPS_PORT']), username=ENV['VPS_USER'],
          pkey=key, timeout=25)
sftp = c.open_sftp()
for remote in ['/opt/quant/logs/bot.log', '/opt/quant/logs/games.json', '/opt/quant/bot_stdout.log']:
    base = os.path.basename(remote)
    try:
        sftp.get(remote, os.path.join(DST, base))
        print('synced', base)
    except Exception as e:
        print('skip', base, str(e)[:80])
# VPS 雷达/信号引擎结果 -> 驾驶舱根目录
for remote in ['/opt/quant/dashboard/radar.json', '/opt/quant/dashboard/signals.json']:
    base = os.path.basename(remote)
    try:
        sftp.get(remote, os.path.join(DASH, base))
        print('synced', base)
    except Exception as e:
        print('skip', base, str(e)[:80])
# 趋势机器人文件 -> dashboard/trendlogs/
TREND_DST = os.path.join(DASH, 'trendlogs')
os.makedirs(TREND_DST, exist_ok=True)
for remote in ['/opt/quant/logs/trend.log', '/opt/quant/trend_games.json', '/opt/quant/trend_state.json']:
    base = os.path.basename(remote)
    try:
        sftp.get(remote, os.path.join(TREND_DST, base))
        print('synced', base)
    except Exception as e:
        print('skip', base, str(e)[:80])
# 网格机器人文件 -> dashboard/gridlogs/
GRID_DST = os.path.join(DASH, 'gridlogs')
os.makedirs(GRID_DST, exist_ok=True)
for remote in ['/opt/quant/grid_snapshot.json', '/opt/quant/grid_recommend.json',
               '/opt/quant/grid_registry.json', '/opt/quant/grid_roll_stdout.log',
               '/opt/quant/skr_clone.log', '/opt/quant/skr_clone_state.json', '/opt/quant/skr_fund_low.txt',
               '/opt/quant/niulai_watch.log', '/opt/quant/niulai_trigger.txt', '/opt/quant/niulai_watch_state.json']:
    base = os.path.basename(remote)
    try:
        sftp.get(remote, os.path.join(GRID_DST, base))
        print('synced', base)
    except Exception as e:
        print('skip', base, str(e)[:80])
# bot 进程存活探针(滚仓 + 趋势 + 网格)
try:
    _, out, _ = c.exec_command("ps aux | grep -F 'bot_range.py' | grep -v grep | wc -l; ps aux | grep -F 'bot_trend.py' | grep -v grep | wc -l; ps aux | grep -F 'grid_roll.py' | grep -v grep | wc -l; ps aux | grep -F 'skr_clone.py' | grep -v grep | wc -l; date +%s", timeout=30)
    o = out.read().decode('utf-8', 'replace').strip().splitlines()
    alive = int(o[0].strip()) > 0 if o else False
    trend_alive = int(o[1].strip()) > 0 if len(o) > 1 else False
    grid_alive = int(o[2].strip()) > 0 if len(o) > 2 else False
    skr_alive = int(o[3].strip()) > 0 if len(o) > 3 else False
    check_at = int(o[4].strip()) if len(o) > 4 else int(time.time())
    with open(os.path.join(DASH, 'bot_alive.json'), 'w', encoding='utf-8') as f:
        json.dump({'alive': alive, 'trend_alive': trend_alive, 'grid_alive': grid_alive,
                   'skr_alive': skr_alive, 'check_at': check_at}, f)
    print('bot_alive:', alive, 'trend_alive:', trend_alive, 'grid_alive:', grid_alive, 'skr_alive:', skr_alive, 'check_at:', check_at)
except Exception as e:
    print('skip bot_alive', str(e)[:80])
c.close()
print('SYNC DONE')
