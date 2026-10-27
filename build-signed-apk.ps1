<#
.SYNOPSIS
    一键构建 DSH Outpost 正式签名测试 APK（供 Android 真机验收用）。

.DESCRIPTION
    用你本地的私有 keystore 构建一个**带正式签名**的 release APK，
    并自动校验证书指纹是否与 GitHub CI 验证结果一致。

    ## 密码怎么传（安全性关键）

    **绝不出现在命令行参数里。** `-P` 参数会让密码出现在：
      · 进程列表（任务管理器 / `wmic process get commandline`）
      · PowerShell 历史（Get-History / PSReadLine 历史文件）
      · 任何记录命令行的地方

    本脚本的做法：
      1. 用 `Read-Host -AsSecureString` 让你输入 —— 输入时不回显、不进历史
      2. 转成普通字符串后**只放进当前进程的环境变量**
         `ORG_GRADLE_PROJECT_DSH_*`（Gradle 会把它们当成 project property）
      3. 构建结束（无论成败）立即在 finally 里清掉这些环境变量
      4. 脚本本身不写任何日志文件、不打印任何密码片段

    ## 产出的版本号

    默认用与 CI 验证时一致的合成版本（0.0.0-verify.N / 916204），
    这样真机验收包与 CI 验证对象是同一类构建。

    ⚠️ 这个包的 versionCode 高于正式版本，**验完必须卸载**，
       否则后续正式版装不上去（INSTALL_FAILED_VERSION_DOWNGRADE）。

.PARAMETER KeystorePath
    私有 keystore 的路径。默认会提示输入。

.PARAMETER KeyAlias
    key 别名。默认 dsh-release（与 CI 配置一致）。

.PARAMETER VersionName
    默认 0.0.0-verify.local

.PARAMETER VersionCode
    默认 916204（与 CI 验证时的合成版本一致，远高于正式序列）。

.PARAMETER OutDir
    产物复制到哪个目录。默认仓库根下的 `_acceptance-apk`。

.EXAMPLE
    .\build-signed-apk.ps1

.EXAMPLE
    .\build-signed-apk.ps1 -KeystorePath 'D:\keys\dsh-release.keystore' -KeyAlias dsh-release

.NOTES
    密码输入方式：
      · 默认 —— 交互式输入（Read-Host -AsSecureString，不回显、不进历史）
      · 非交互 —— 预先在你自己的 shell 里设置环境变量
        DSH_BUILD_STORE_PASSWORD / DSH_BUILD_KEY_PASSWORD，
        脚本会直接读取这几个环境变量，不再提示。
        环境变量只存在于你的进程内，脚本用完即清。
        适合脚本化/重复构建，或让自动化测试验证整条链路。
#>
[CmdletBinding()]
param(
    [string]$KeystorePath,
    [string]$KeyAlias = 'dsh-release',
    [string]$VersionName = '0.0.0-verify.local',
    [int]$VersionCode = 916204,
    [string]$OutDir = (Join-Path $PSScriptRoot '_acceptance-apk')
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

# ── CI 验证过的证书指纹（来自 run 40467239206）──────────────────────
#
# 这是**公钥**指纹，不是秘密。用它来自动核对本地构建出来的包
# 是否真的用了同一把私有证书。
$EXPECTED_CERT_SHA256 = '191b16cebd6f39f64f8cbbe3fcbdd90e2d845a9d7b1fbe19ccdcd819293a736a'

# 公开的 AOSP debug 证书指纹 —— 命中说明错误地用了 debug 签名
$DEBUG_CERT_SHA256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c'

function Write-Step($m) { Write-Host "`n>>> $m" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Write-Warn2($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host "  [X] $m" -ForegroundColor Red }

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host '  DSH Outpost —— 正式签名测试 APK 构建（真机验收用）' -ForegroundColor DarkCyan
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan

# ── 1. 定位工具链 ──
Write-Step '检查构建环境'

$repo = $PSScriptRoot
$androidDir = Join-Path $repo 'dsh-mobile\android'
$gradlew = Join-Path $androidDir 'gradlew.bat'

if (-not (Test-Path $gradlew)) {
    Write-Err2 "找不到 gradlew：$gradlew"
    exit 1
}
Write-Ok 'gradlew 就绪'

# 优先用环境变量 / 已知位置找 Android SDK 的 apksigner
function Find-ApkSigner {
    $roots = @()

    # 1. 环境变量
    foreach ($v in @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME)) {
        if ($v) { $roots += $v }
    }

    # 2. android/local.properties 里的 sdk.dir
    #
    # 这里容易踩坑：properties 文件里 Windows 路径常写成 D\:\\Android\\Sdk
    # （反斜杠与冒号被转义），也可能写成 D:\Android\Sdk。
    # 早先只做简单 Replace 处理，遇到转义写法就找不到 apksigner
    # —— 而它是证书指纹校验的唯一手段，静默缺失等于校验没做。
    $lp = Join-Path $androidDir 'local.properties'
    if (Test-Path $lp) {
        $line = Get-Content $lp | Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -First 1
        if ($line) {
            $raw = ($line -replace '^\s*sdk\.dir\s*=', '').Trim()
            $raw = $raw -replace '\\\\', '\'
            $raw = $raw -replace '\\:', ':'
            if ($raw) { $roots += $raw }
        }
    }

    # 3. 常见安装位置兜底
    $roots += @('D:\Android\Sdk', 'C:\Android\Sdk', (Join-Path $env:LOCALAPPDATA 'Android\Sdk'))

    $cands = @()
    foreach ($root in ($roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)) {
        $bt = Join-Path $root 'build-tools'
        if (-not (Test-Path -LiteralPath $bt)) { continue }
        Get-ChildItem -LiteralPath $bt -Directory |
            Sort-Object -Property @{ Expression = { try { [version]$_.Name } catch { [version]'0.0.0' } } } -Descending |
            ForEach-Object {
                $cands += (Join-Path $_.FullName 'apksigner.bat')
                $cands += (Join-Path $_.FullName 'apksigner')
            }
    }
    return ($cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

$apksigner = Find-ApkSigner
if ($apksigner) { Write-Ok "apksigner: $apksigner" }
else { Write-Warn2 '没找到 apksigner —— 构建后无法自动校验证书（不影响构建）' }

# ── 2. 定位 keystore ──
Write-Step '选择私有 keystore'

if (-not $KeystorePath) {
    Write-Host '  请输入私有 keystore 的完整路径（例如 D:\keys\dsh-release.keystore）' -ForegroundColor Gray
    Write-Host '  直接回车则由文件选择对话框选择。' -ForegroundColor Gray
    $typed = Read-Host '  路径'
    if ($typed) {
        $KeystorePath = $typed.Trim('"').Trim()
    } else {
        Add-Type -AssemblyName System.Windows.Forms | Out-Null
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = '选择私有 keystore'
        $dlg.Filter = 'Keystore (*.keystore;*.jks;*.p12)|*.keystore;*.jks;*.p12|所有文件 (*.*)|*.*'
        if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
            $KeystorePath = $dlg.FileName
        }
    }
}

if (-not $KeystorePath -or -not (Test-Path -LiteralPath $KeystorePath)) {
    Write-Err2 "keystore 不存在或未选择：$KeystorePath"
    exit 1
}
$KeystorePath = (Resolve-Path -LiteralPath $KeystorePath).Path
Write-Ok "keystore：$KeystorePath"
Write-Host '  （文件名之外的信息不会被读取或记录）' -ForegroundColor DarkGray

# ── 3. 输入密码（不回显、不进历史、不进命令行）──
Write-Step '输入签名密码'

function ConvertFrom-Secure([System.Security.SecureString]$s) {
    if ($null -eq $s) { return '' }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$storePass = ''
$keyPass = ''

# 优先用预置的环境变量（非交互模式）。
# 这两个变量由用户自己在 shell 里设置，脚本不负责创建；
# 用完（finally）会被清掉，不落盘、不进日志。
if ($env:DSH_BUILD_STORE_PASSWORD) {
    $storePass = $env:DSH_BUILD_STORE_PASSWORD
    $keyPass = if ($env:DSH_BUILD_KEY_PASSWORD) { $env:DSH_BUILD_KEY_PASSWORD } else { $storePass }
    Write-Ok '密码来自环境变量（非交互模式）'
} else {
    Write-Host '  说明：输入时不回显，不会出现在 PowerShell 历史里，' -ForegroundColor Gray
    Write-Host '        也不会作为命令行参数传给 gradle（只经环境变量）。' -ForegroundColor Gray

    $storeSec = Read-Host '  keystore 密码' -AsSecureString
    $keySec = Read-Host '  key 密码（若与 keystore 相同可直接回车）' -AsSecureString

    $storePass = ConvertFrom-Secure $storeSec
    $keyPass = ConvertFrom-Secure $keySec
    # key 密码留空 = 与 keystore 相同
    if ([string]::IsNullOrEmpty($keyPass)) { $keyPass = $storePass }
}

if ([string]::IsNullOrEmpty($storePass)) {
    Write-Err2 '密码为空，终止。'
    exit 1
}
Write-Ok '密码已读入内存（未记录）'

# ── 4. 构建 ──
Write-Step "构建 release APK（versionName=$VersionName  versionCode=$VersionCode）"

$built = $false
try {
    # ⚠️ 关键：密码只经环境变量传 gradle，绝不上命令行。
    # Gradle 把 ORG_GRADLE_PROJECT_<NAME> 映射成 project property <NAME>。
    $env:ORG_GRADLE_PROJECT_DSH_STORE_FILE = $KeystorePath
    $env:ORG_GRADLE_PROJECT_DSH_STORE_PASSWORD = $storePass
    $env:ORG_GRADLE_PROJECT_DSH_KEY_ALIAS = $KeyAlias
    $env:ORG_GRADLE_PROJECT_DSH_KEY_PASSWORD = $keyPass
    $env:ORG_GRADLE_PROJECT_DSH_VERSION_NAME = $VersionName
    $env:ORG_GRADLE_PROJECT_DSH_VERSION_CODE = [string]$VersionCode

    Push-Location $androidDir
    try {
        # 不传任何 -P 参数（那会泄露密码到进程列表）
        & cmd /c "gradlew.bat --no-daemon --console=plain :app:assembleRelease 2>&1" |
            ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        Write-Err2 "gradle 构建失败（exit=$code）"
        exit 1
    }
    $built = $true
}
finally {
    # ── 无论成败，立即清除环境变量里的凭据 ──
    foreach ($n in @(
            'ORG_GRADLE_PROJECT_DSH_STORE_FILE',
            'ORG_GRADLE_PROJECT_DSH_STORE_PASSWORD',
            'ORG_GRADLE_PROJECT_DSH_KEY_ALIAS',
            'ORG_GRADLE_PROJECT_DSH_KEY_PASSWORD',
            'ORG_GRADLE_PROJECT_DSH_VERSION_NAME',
            'ORG_GRADLE_PROJECT_DSH_VERSION_CODE')) {
        Remove-Item "Env:$n" -ErrorAction SilentlyContinue
    }
    $storePass = $null; $keyPass = $null
    $storeSec = $null; $keySec = $null
    [System.GC]::Collect()
}

if (-not $built) { exit 1 }
Write-Ok '构建完成'

# ── 5. 校验证书指纹 ──
Write-Step '校验 APK 签名证书'

$apk = Join-Path $androidDir 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) {
    Write-Err2 "找不到产物：$apk"
    exit 1
}
$apkSize = [math]::Round((Get-Item $apk).Length / 1MB, 1)
Write-Ok "APK：$apk（$apkSize MB）"

$certOk = $false
if ($apksigner) {
    $certOut = & $apksigner verify --print-certs $apk 2>&1 | Out-String
    $m = [regex]::Match($certOut, 'SHA-256 digest:\s*([0-9a-fA-F]+)')
    $dn = [regex]::Match($certOut, 'certificate DN:\s*(.+)')
    if ($m.Success) {
        $actual = $m.Groups[1].Value.ToLower()
        Write-Host ("  证书 DN      : " + $(if ($dn.Success) { $dn.Groups[1].Value.Trim() } else { '?' }))
        Write-Host ("  证书 SHA-256 : $actual")
        Write-Host ("  CI 验证值    : $EXPECTED_CERT_SHA256")

        if ($actual -eq $DEBUG_CERT_SHA256) {
            Write-Err2 '这是公开的 AOSP debug 证书 —— 绝不能用于发布！'
        } elseif ($actual -eq $EXPECTED_CERT_SHA256) {
            Write-Ok '证书指纹与 GitHub CI 验证结果完全一致 ✓'
            $certOk = $true
        } else {
            Write-Err2 '证书指纹与 CI 验证值不一致！'
            Write-Host '    可能原因：用错了 keystore，或别名指向另一把 key。' -ForegroundColor Yellow
        }
    } else {
        Write-Warn2 'apksigner 没输出 SHA-256，无法自动校验'
    }

    # 签名方案
    $vOut = & $apksigner verify --verbose $apk 2>&1 | Out-String
    $v2 = $vOut -match 'Verified using v2 scheme.*: true'
    Write-Host ("  签名方案 v2  : " + $(if ($v2) { 'true ✓（Android 7+ 必需）' } else { 'false ✗ 无法在 Android 7+ 安装' }))
} else {
    Write-Warn2 '没有 apksigner，跳过证书校验'
}

# ── 6. 复制到交付目录 ──
Write-Step '整理产物'

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $OutDir "DSH-Outpost-TEST-$VersionName-$stamp.apk"
Copy-Item $apk $dest -Force
$hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
Write-Ok "已复制到：$dest"

# 写配套校验文件（不含任何密码）
$sumFile = Join-Path $OutDir "SHA256SUMS-$stamp.txt"
"$hash  $(Split-Path $dest -Leaf)" | Set-Content $sumFile -Encoding ASCII
Write-Ok "哈希文件：$sumFile"

Write-Host ''
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
if ($certOk) {
    Write-Host '  完成 —— 证书已验证与 CI 一致' -ForegroundColor Green
} else {
    Write-Host '  完成 —— 但证书未能自动校验（见上方提示）' -ForegroundColor Yellow
}
Write-Host '════════════════════════════════════════════════════════════' -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  APK 位置:' -ForegroundColor Cyan
Write-Host "    $dest" -ForegroundColor White
Write-Host ''
Write-Host "  SHA-256: $hash"
Write-Host ''
Write-Host '  真机安装（USB 调试开启后）:' -ForegroundColor Cyan
Write-Host "    adb install -r `"$dest`""
Write-Host ''
Write-Host '  ⚠️ 验收完成后必须卸载（versionCode 高于正式版，否则正式版装不上）:' -ForegroundColor Yellow
Write-Host '    adb uninstall com.dshpocket'
Write-Host ''
