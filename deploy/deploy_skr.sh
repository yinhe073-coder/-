#!/bin/bash
# deploy_skr.sh — 部署 v3.12 + 收养主人 SKR + 启动克隆塔
pkill -f grid_roll.py
pkill -f skr_clone.py
sleep 1
cd /opt/quant
python3 -m py_compile grid_roll.py && echo GRID_COMPILE_OK
python3 -m py_compile skr_clone.py && echo CLONE_COMPILE_OK
set -a
. ./.env_grid
set +a
python3 adopt_skr.py
nohup python3 grid_roll.py >> grid_roll_stdout.log 2>&1 < /dev/null &
disown
nohup python3 skr_clone.py >> skr_clone.log 2>&1 < /dev/null &
disown
echo started
