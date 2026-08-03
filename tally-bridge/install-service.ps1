<#
  Registers the Tally Bridge Agent as a Scheduled Task so it starts at logon and restarts on failure.
  Run in PowerShell AS ADMINISTRATOR from the tally-bridge folder:
      .\install-service.ps1
      .\install-service.ps1 -Uninstall
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'EcomCentral-TallyBridge'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Agent    = Join-Path $Here 'agent.js'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task '$TaskName'."
    } else { Write-Output "Task '$TaskName' was not registered." }
    exit 0
}

if (-not (Test-Path $Agent)) { throw "agent.js not found next to this script ($Agent)" }
# Keep this file pure ASCII. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it has a BOM, so a
# UTF-8 em dash decodes as a smart closing quote and terminates the string early - which breaks the
# parse of the whole file, several lines away from the actual character.
if (-not (Test-Path (Join-Path $Here '.env'))) { throw "No .env in $Here - copy .env.example to .env and fill it in first." }

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'node is not on PATH. Install Node.js, or hard-code its full path below.' }

Write-Output "node  : $($node.Source)"
Write-Output "agent : $Agent"

$action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$Agent`"" -WorkingDirectory $Here
$trigger = New-ScheduledTaskTrigger -AtLogOn
# Keep it alive: retry every minute indefinitely, no execution time limit, and don't stop on battery.
$settings = New-ScheduledTaskSettingsSet -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 9999 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Replaced the existing task."
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output ""
Write-Output "Registered and started '$TaskName'."
Write-Output "  status : Get-ScheduledTask -TaskName $TaskName"
Write-Output "  logs   : $(Join-Path $Here 'agent.log')"
Write-Output "  stop   : Stop-ScheduledTask -TaskName $TaskName"
