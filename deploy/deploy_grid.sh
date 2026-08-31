#!/bin/bash
# deploy_grid.sh — 重启网格机器人 (由总管 scp 后调用: bash deploy_grid.sh < /dev/null)
pkill -f grid_roll.py
sleep 1
cd /opt/quant
python3 -m py_compile grid_roll.py && echo COMPILE_OK
set -a
. ./.env_grid
set +a
nohup python3 grid_roll.py >> grid_roll_stdout.log 2>&1 < /dev/null &
disown
echo restarted
