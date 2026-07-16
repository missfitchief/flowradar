param(
  [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$Supervisor = Join-Path $PSScriptRoot 'flowradar-component-supervisor.mjs'
$Startup = Join-Path $PSScriptRoot 'flowradar-startup.mjs'
$LauncherSource = Join-Path $PSScriptRoot 'FlowRadar.HiddenLauncher.cs'
$RuntimeBin = Join-Path $Repo '.runtime\bin'
$Launcher = Join-Path $RuntimeBin 'FlowRadar.HiddenLauncher.exe'
$LogDir = Join-Path $Repo '.runtime\logs'
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$TaskNames = [ordered]@{
  postgres = 'FlowRadar-PostgreSQL'
  receiver = 'FlowRadar-Receiver'
  tunnel = 'FlowRadar-Cloudflare-Tunnel'
  worker = 'FlowRadar-Worker'
  intelligence = 'FlowRadar-Intelligence'
  telegram = 'FlowRadar-Telegram'
}

if (-not (Test-Path (Join-Path $Repo 'apps\web\.next\BUILD_ID'))) {
  Push-Location $Repo
  try {
    & $Npm run build -w apps/web
    if ($LASTEXITCODE -ne 0) { throw "FlowRadar web build failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

New-Item -ItemType Directory -Path $RuntimeBin -Force | Out-Null
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
if ((-not (Test-Path $Launcher)) -or ((Get-Item $LauncherSource).LastWriteTimeUtc -gt (Get-Item $Launcher).LastWriteTimeUtc)) {
  Remove-Item -LiteralPath $Launcher -Force -ErrorAction SilentlyContinue
  Add-Type -Path $LauncherSource -OutputAssembly $Launcher -OutputType WindowsApplication
}

function Quote-TaskArgument([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function New-HiddenNodeAction([string]$Script, [string[]]$ScriptArguments, [string]$Role) {
  $stdout = Join-Path $LogDir ("task-{0}.stdout.log" -f $Role)
  $stderr = Join-Path $LogDir ("task-{0}.stderr.log" -f $Role)
  $launcherLog = Join-Path $LogDir 'hidden-launcher.log'
  $arguments = @('--cwd', $Repo, '--stdout', $stdout, '--stderr', $stderr, '--launcher-log', $launcherLog, '--', $Node, $Script) + $ScriptArguments
  $argumentLine = ($arguments | ForEach-Object { Quote-TaskArgument $_ }) -join ' '
  return New-ScheduledTaskAction -Execute $Launcher -Argument $argumentLine -WorkingDirectory $Repo
}

# Standard-user Windows cannot register S4U tasks without elevation. The
# Windows-subsystem launcher keeps the task in the user's normal security
# context but starts the existing node.exe directly with CreateNoWindow and
# UseShellExecute=false. It waits for Node, so Task Scheduler still owns the
# complete supervisor lifetime and its restart policy remains effective.
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -Hidden `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

foreach ($entry in $TaskNames.GetEnumerator()) {
  $action = New-HiddenNodeAction -Script $Supervisor -ScriptArguments @($entry.Key) -Role $entry.Key
  Register-ScheduledTask -TaskName $entry.Value -Action $action -Principal $Principal -Settings $Settings -Force | Out-Null
}

$StartupAction = New-HiddenNodeAction -Script $Startup -ScriptArguments @() -Role 'startup'
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$BootTrigger = New-ScheduledTaskTrigger -AtStartup
$WatchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$StartupTask = New-ScheduledTask -Action $StartupAction -Trigger @($BootTrigger, $LogonTrigger, $WatchdogTrigger) -Principal $Principal -Settings $Settings
$TriggerDescription = 'At startup and at logon'
try {
  Register-ScheduledTask -TaskName 'FlowRadar-Startup' -InputObject $StartupTask -Force | Out-Null
} catch [Microsoft.Management.Infrastructure.CimException] {
  # Standard users cannot register an AtStartup trigger. The current machine
  # automatically signs this user in after boot, so AtLogOn remains a fully
  # unattended startup path without storing another credential in Task Scheduler.
  $StartupTask = New-ScheduledTask -Action $StartupAction -Trigger @($LogonTrigger, $WatchdogTrigger) -Principal $Principal -Settings $Settings
  Register-ScheduledTask -TaskName 'FlowRadar-Startup' -InputObject $StartupTask -Force | Out-Null
  $TriggerDescription = 'At logon plus one-minute watchdog (standard-user fallback; StartWhenAvailable)'
}

# Remove only the known temporary supervisors that predate the scheduled tasks.
$LegacyMarkers = @('flowradar-web.production.log', 'flowradar-cloudflared-quick', 'flowradar-telegram.production.log')
$Legacy = Get-CimInstance Win32_Process | Where-Object {
  if ($_.Name -ne 'powershell.exe' -or $_.CommandLine -notmatch '(?i)-EncodedCommand\s+([A-Za-z0-9+/=]+)') { return $false }
  try { $decoded = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($matches[1])) }
  catch { return $false }
  foreach ($marker in $LegacyMarkers) { if ($decoded -like "*$marker*") { return $true } }
  return $false
}
foreach ($process in $Legacy) {
  $descendants = @()
  $all = Get-CimInstance Win32_Process
  $queue = New-Object System.Collections.Generic.Queue[int]
  $seen = @{}
  $seen[[int]$process.ProcessId] = $true
  $queue.Enqueue([int]$process.ProcessId)
  while ($queue.Count -gt 0) {
    $parent = $queue.Dequeue()
    foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $parent })) {
      if (-not $seen[[int]$child.ProcessId]) {
        $seen[[int]$child.ProcessId] = $true
        $descendants += $child
        $queue.Enqueue([int]$child.ProcessId)
      }
    }
  }
  foreach ($child in @($descendants | Sort-Object ProcessId -Descending)) { Stop-Process -Id $child.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

# Any remaining legacy listener/tunnel is scoped by executable and FlowRadar port.
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'cloudflared.exe' -and $_.CommandLine -like '*http://127.0.0.1:5188*') -or
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'next.+start -p 5188')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if ($StartNow) { Start-ScheduledTask -TaskName 'FlowRadar-Startup' }

[pscustomobject]@{
  StartupTask = 'FlowRadar-Startup'
  StartupCommand = ('"{0}" -- "{1}" "{2}"' -f $Launcher, $Node, $Startup)
  Principal = $User
  LogonType = 'Interactive token through Windows hidden launcher'
  Hidden = $true
  NodeExecutable = $Node
  Trigger = $TriggerDescription
  Components = @($TaskNames.Values)
} | ConvertTo-Json -Depth 4
