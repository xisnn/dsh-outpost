param(
  [string]$Adb = 'E:\Android\Sdk\platform-tools\adb.exe',
  [string]$Serial = 'emulator-5584',
  [string]$WorkspaceName = 'dsBot',
  [string]$SessionId,
  [string]$InputText = 'navcheck'
)

$ErrorActionPreference = 'Stop'

if (-not $SessionId) { throw 'SessionId is required' }

function Invoke-Adb([string[]]$Args) {
  & $Adb -s $Serial @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

function Get-Ui([string]$Name) {
  Invoke-Adb @('shell', 'uiautomator', 'dump', "/sdcard/$Name")
  Invoke-Adb @('pull', "/sdcard/$Name", (Join-Path $PSScriptRoot "..\_$Name"))
  Get-Content (Join-Path $PSScriptRoot "..\_$Name") -Raw -Encoding UTF8
}

function Tap-Node([string]$Raw, [string]$Needle) {
  $escaped = [regex]::Escape($Needle)
  $m = [regex]::Match($Raw, '<node[^>]*content-desc="[^"]*' + $escaped + '[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>')
  if (-not $m.Success) { throw "UI node not found: $Needle" }
  $x = [int](([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2)
  $y = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
  Invoke-Adb @('shell', 'input', 'tap', "$x", "$y")
}

# The app requests POST_NOTIFICATIONS on first launch. If the dialog is left
# unhandled, subsequent taps can hit the permission activity and the app never
# reaches the workspace list. Granting it once removes that interference.
& $Adb -s $Serial shell pm grant com.dshpocket android.permission.POST_NOTIFICATIONS 2>$null
Invoke-Adb @('shell', 'am', 'force-stop', 'com.dshpocket')
Invoke-Adb @('shell', 'monkey', '-p', 'com.dshpocket', '-c', 'android.intent.category.LAUNCHER', '1')
Start-Sleep -Seconds 15

$home = Get-Ui 'p0-nav-home.xml'
Tap-Node $home $WorkspaceName
Start-Sleep -Seconds 5

$workspace = Get-Ui 'p0-nav-workspace.xml'
if ($workspace -notmatch [regex]::Escape($SessionId)) { throw 'target session not visible in workspace' }
Tap-Node $workspace $SessionId
Start-Sleep -Seconds 5

$chat = Get-Ui 'p0-nav-chat.xml'
if ($chat -notmatch 'text="发消息…"') { throw 'ChatScreen input not mounted' }
if ($chat -notmatch [regex]::Escape($SessionId)) { throw 'ChatScreen sessionId mismatch' }

$m = [regex]::Match($chat, '<node[^>]*class="android.widget.EditText"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>')
if (-not $m.Success) { throw 'chat input not found' }
$x = [int](([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2)
$y = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
Invoke-Adb @('shell', 'input', 'tap', "$x", "$y")
Invoke-Adb @('shell', 'input', 'text', $InputText)

Write-Output "NAV_OK workspace=$WorkspaceName session=$SessionId input=typed"
