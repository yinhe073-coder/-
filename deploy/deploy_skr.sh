#!/bin/bash
# deploy_skr.sh — 部署主机器人 + 启动 SKR 克隆塔
# 注意: 若要监控已有 App 手开的机器人, 把其 bot_id 追加到 grid_bot_id.txt 并写入
# registry 的 noclose 列表 (见 bots/grid_roll.py 内 noclose 逻辑)
pkill -f grid_roll.py
pkill -f skr_clone.py
sleep 1
cd /opt/quant
python3 -m py_compile grid_roll.py && echo GRID_COMPILE_OK
python3 -m py_compile skr_clone.py && echo CLONE_COMPILE_OK
set -a
. ./.env_grid
set +a
nohup python3 grid_roll.py >> grid_roll_stdout.log 2>&1 < /dev/null &
disown
nohup python3 skr_clone.py >> skr_clone.log 2>&1 < /dev/null &
disown
echo started
