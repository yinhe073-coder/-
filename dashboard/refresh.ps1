# 杯柄实盘驾驶舱数据刷新 (每30秒行情, 每3分钟持仓)
$ErrorActionPreference = "Continue"
$dash = "WORKSPACE\量化交易\工程\dashboard"
$py = "WORKSPACE\量化交易\工程\research\.venv\Scripts\python.exe"
$n = 0
while ($true) {
  $n++
  $tick = $null
  try {
    $t = Invoke-RestMethod -Uri "https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT" -TimeoutSec 10
    $tick = @{
      last = $t.result.list[0].lastPrice
      pct24 = [math]::Round([double]$t.result.list[0].price24hPcnt * 100, 2)
      high24 = $t.result.list[0].highPrice24h
      low24 = $t.result.list[0].lowPrice24h
      funding = $t.result.list[0].fundingRate
    }
  } catch { }

  $srvTime = $null
  try {
    $st = Invoke-RestMethod -Uri "https://api.bybit.com/v5/market/time" -TimeoutSec 8
    $srvTime = [long]$st.result.timeSecond
  } catch { }

  if (($n % 6) -eq 0) {
    try { & $py -B "WORKSPACE\量化交易\工程\scripts\vps_position_json.py" | Out-Null } catch { }
  }

  $pos = $null
  $posPath = "$dash\pos.json"
  if (Test-Path $posPath) {
    try { $pos = Get-Content $posPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
  }

  $bot = $null
  $botLog = "$dash\botlogs\bot.log"
  if (Test-Path $botLog) {
    try {
      $tail = Get-Content $botLog -Encoding utf8 -Tail 6
      $gamesPath = "$dash\botlogs\games.json"
      $games = @()
      if (Test-Path $gamesPath) { $games = Get-Content $gamesPath -Raw -Encoding utf8 | ConvertFrom-Json }
      $bot = @{ last_logs = @($tail); games_done = $games.Count; games = @($games | ForEach-Object { @{n=$_.n; sym=$_.sym; result=$_.result; net=$_.net; banked=$_.banked; busted=$_.busted; eq_start=$_.eq_start; start=$_.start} }) }
    } catch { }
  }

  $trend = $null
  $trendDir = "$dash\trendlogs"
  if (Test-Path "$trendDir\trend_state.json") {
    try {
      $tState = Get-Content "$trendDir\trend_state.json" -Raw -Encoding utf8 | ConvertFrom-Json
      $tLogs = @()
      if (Test-Path "$trendDir\trend.log") { $tLogs = @(Get-Content "$trendDir\trend.log" -Encoding utf8 -Tail 6) }
      $tGames = @()
      if (Test-Path "$trendDir\trend_games.json") { $tGames = @(Get-Content "$trendDir\trend_games.json" -Raw -Encoding utf8 | ConvertFrom-Json) }
      $trend = @{
        mode = $tState.mode; wallet = $tState.wallet; budget = $tState.budget
        day_pnl = $tState.day_pnl; consec = $tState.consec; stopped = $tState.stopped
        pos = $tState.pos; day = $tState.day
        logs = $tLogs
        games = @($tGames | ForEach-Object { @{n=$_.n; sym=$_.sym; side=$_.side; why=$_.why; net=$_.net; consec=$_.consec; at=$_.at} })
      }
    } catch { }
  }

  $grid = $null
  $gridDir = "$dash\gridlogs"
  if (Test-Path "$gridDir\grid_snapshot.json") {
    try {
      $gSnap = Get-Content "$gridDir\grid_snapshot.json" -Raw -Encoding utf8 | ConvertFrom-Json
      $gLogs = @()
      if (Test-Path "$gridDir\grid_roll_stdout.log") { $gLogs = @(Get-Content "$gridDir\grid_roll_stdout.log" -Encoding utf8 -Tail 5) }
      $gSkr = $null
      if (Test-Path "$gridDir\skr_clone_state.json") {
        try {
          $sSkr = Get-Content "$gridDir\skr_clone_state.json" -Raw -Encoding utf8 | ConvertFrom-Json
          $gSkr = @{ ath = $sSkr.ath; next = $sSkr.next; pending = $sSkr.pending; clones = @($sSkr.clones).Count; fund_low = (Test-Path "$gridDir\skr_fund_low.txt") }
        } catch { }
      }
      $grid = @{
        grids = @($gSnap.grids | ForEach-Object { @{sym=$_.sym; pnl=$_.pnl; pnl_per=$_.pnl_per; last_price=$_.last_price; liq=$_.liq; invest=$_.invest; cell_number=$_.cell_number; trades=$_.trades; grid_profit=$_.grid_profit; per_cell=$_.per_cell; apr=$_.apr; realised=$_.realised; unrealised=$_.unrealised; mode=$_.mode; open_at=$_.open_at; focus=$_.focus; noclose=$_.noclose} })
        history = @($gSnap.history | ForEach-Object { @{sym=$_.sym; pnl=$_.pnl; pnl_per=$_.pnl_per; close_at=$_.close_at} })
        banked = $gSnap.banked; ladder = $gSnap.ladder; logs = $gLogs
        equity = $gSnap.equity; goal = $gSnap.goal; skr = $gSkr
      }
    } catch { }
  }

  $data = @{
    btc = $tick
    pos = $pos.pos
    bal = $pos.bal
    trades = $pos.trades
    bot = $bot
    trend = $trend
    grid = $grid
    ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    server_time = $srvTime
    stop = $null  # No private trade plan is distributed.
    tp1 = $null  # No private trade plan is distributed.
    tp2 = $null  # No private trade plan is distributed.
    entry = $null  # No private trade plan is distributed.
    refresh_at = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
  } | ConvertTo-Json -Depth 6 -Compress
  Set-Content "$dash\data.json" -Value $data -Encoding utf8
  Start-Sleep -Seconds 30
}
