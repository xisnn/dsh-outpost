# 网关管理接口认证补丁 —— 启动期完整性门禁
#
# ══════════════════════════════════════════════════════════════════════
# 这个文件被 start-dsh-web.ps1 dot-source（`. "$PSScriptRoot\...\"`）。
#
# ## 为什么单独抽成一个文件
#
# 门禁逻辑原本内联在 start-dsh-web.ps1 里，位置在「定位 dsh 可执行文件」
# **之后**。这带来两个问题：
#
#   1. **测试无法单独验证门禁**
#      脚本一开头就要找 Windows 的 dsh.cmd；在 Linux CI 上必然找不到，
#      于是先 `exit 1`（报「找不到 dsh」），门禁根本执行不到。
#      结果：断言「以非 0 退出」通过了（假阳性），
#      但「输出认证补丁未生效」等断言全挂 —— 正是第二轮的 CI 失败原因。
#
#   2. **两件事混在一起**
#      「找 dsh」是环境准备，「查补丁」是安全门禁。混在一条直线流程里，
#      环境缺失会掩盖安全门禁的执行结果。
#
# ## 抽取后的契约
#
# `Test-GatewayPatchApplied` 只负责三件事：
#   · 判断该不该查（未跳过 / 插件已装 / 补丁脚本存在）
#   · 跑 `apply.mjs --check` 拿退出码
#   · 返回结构化结果（而不是自己 exit）
#
# 是否 `exit 1` 由调用方（start-dsh-web.ps1）决定 —— 生产行为**完全不变**。
# 测试可以直接调用这个函数，注入假的检查结果，验证三条提示的措辞。
# ══════════════════════════════════════════════════════════════════════

<#
.SYNOPSIS
    检查网关认证补丁是否已应用。

.DESCRIPTION
    返回一个对象：
      ShouldCheck      —— 是否需要做这次检查（false 表示不适用：跳过开关/未装插件/无补丁脚本）
      ExitCode         —— apply.mjs --check 的退出码（0 = 已应用；非 0 = 未应用或出错）
      Output           —— apply.mjs 的原始输出（给用户看的详情）
      Reason           —— 不检查的原因（ShouldCheck 为 false 时）
      ExitCodeProvided —— 检查器是否**真的**给出了一个可用的整数退出码

    ## 为什么要有 ExitCodeProvided

    `[int]$null` 在 PowerShell 里等于 **0**。所以检查器"什么都没说"
    （返回缺 ExitCode 的哈希表、返回 `$null`、返回一个字符串……）时，
    上面的 `ExitCode` 会是 0 —— 与"检查通过"**完全无法区分**。

    这个字段就是在转换发生**之前**把这件事记下来。它是**纯附加**的：
    `ExitCode` / `Output` 的算法逐字未改，局域网路径（start-dsh-web.ps1）
    不读它，所以局域网行为完全不变。只有公网侧的
    `Resolve-PublicTunnelGatewayGate` 会用它拒绝"未确认"的状态。

    实测过的折叠形态：缺 ExitCode 键、ExitCode=$null、ExitCode=''、
    返回字符串而非哈希表、什么都不返回、ExitCode=$false（`[int]$false` = 0，
    最危险的一条）—— 全部记为 ExitCodeProvided = $false。
    另一类（ExitCode='not-a-number'）会让 `[int]` 转换**抛异常**，
    这个行为**刻意保留**：改成"安全返回 0"反而会让局域网从
    "崩溃即拒绝"变成"放行"。

.PARAMETER PatchScript
    apply.mjs 的路径。

.PARAMETER PluginInstalled
    插件是否已安装（默认按 ~/.dsh 下的 package.json 判断）。

.PARAMETER Skip
    是否显式跳过检查（对应 -SkipGatewayPatchCheck）。

.PARAMETER CheckRunner
    可注入的检查器：接受 PatchScript，返回 @{ ExitCode; Output }。
    默认真的执行 `node <PatchScript> --check`。
    存在这个参数是为了让测试能构造「补丁未应用」和「node 不存在」等场景，
    而**不需要**在 CI 上真的装 node 插件或 Windows DSH。
#>
function Test-GatewayPatchApplied {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$PatchScript,

        [bool]$PluginInstalled = (Test-Path (Join-Path $env:USERPROFILE '.dsh\profiles\web\node_modules\dsh-plugin-mobile-gateway\package.json')),

        [switch]$Skip,

        [scriptblock]$CheckRunner
    )

    # 不适用的三种情况：明确返回 ShouldCheck=false，由调用方静默跳过。
    # 注意：这**不是**「把门禁关掉」——调用方仍然按 fail-closed 规则处理
    # 真正需要检查的场景。
    #
    # 三条都带 ExitCodeProvided = $false（没跑检查器，自然没有退出码），
    # 使 gate 对象的**形状统一**：调用方不必先判断字段是否存在。
    if ($Skip) {
        return [pscustomobject]@{
            ShouldCheck      = $false
            ExitCode         = 0
            Output           = ''
            Reason           = 'SkipGatewayPatchCheck'
            ExitCodeProvided = $false
        }
    }
    if (-not $PluginInstalled) {
        return [pscustomobject]@{
            ShouldCheck      = $false
            ExitCode         = 0
            Output           = ''
            Reason           = 'plugin-not-installed'
            ExitCodeProvided = $false
        }
    }
    if (-not (Test-Path -LiteralPath $PatchScript)) {
        return [pscustomobject]@{
            ShouldCheck      = $false
            ExitCode         = 0
            Output           = ''
            Reason           = 'patch-script-missing'
            ExitCodeProvided = $false
        }
    }

    if (-not $CheckRunner) {
        $CheckRunner = {
            param($script)
            # 两个坑必须一起避开：
            #   1. 调用方脚本可能设了 $ErrorActionPreference='Stop'，
            #      node 往 stderr 写东西时会被当成终止错误直接抛出，
            #      导致下面的逻辑根本执行不到。
            #   2. 因此必须临时改回 Continue，并用 $LASTEXITCODE 判断。
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try {
                $out = (& node $script --check 2>&1 | Out-String)
                $code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $prevEap
            }
            if ($null -eq $code) { $code = 1 }
            return @{ ExitCode = [int]$code; Output = [string]$out }
        }
    }

    $result = & $CheckRunner $PatchScript

    # `[int]$null` 在 PowerShell 里等于 0 —— 检查器"什么都没说"会被折叠成
    # "检查通过"，而这个信息一旦折叠就**再也拿不回来**。所以在转换之前先记下来。
    #
    # 这是**纯附加字段**：下面 ExitCode / Output 的算法逐字未改（包括
    # `[int]'not-a-number'` 会抛转换异常这一点 —— 那个异常在两条路径上都是
    # fail-closed 的，改成"安全返回 0"反而会让局域网从"崩溃即拒绝"变成"放行"）。
    # 局域网路径不读这个字段，因此其行为完全不变。
    $rawCode = $result.ExitCode
    $codeProvided = ($null -ne $rawCode) -and (
        ($rawCode -is [int]) -or ($rawCode -is [long]) -or
        (($rawCode -is [string]) -and ($rawCode -match '^-?\d+$'))
    )

    return [pscustomobject]@{
        ShouldCheck      = $true
        ExitCode         = [int]$result.ExitCode
        Output           = [string]$result.Output
        Reason           = ''
        ExitCodeProvided = [bool]$codeProvided
    }
}

<#
.SYNOPSIS
    把 Test-GatewayPatchApplied 的结果翻译成「公网隧道能不能启动」。

.DESCRIPTION
    ## 为什么需要这个函数（Test-GatewayPatchApplied 不够用）

    `Test-GatewayPatchApplied` 有**四条**返回路径，其中三条是 `ShouldCheck = $false`：

      · `SkipGatewayPatchCheck`  —— 调用方显式要求跳过
      · `plugin-not-installed`   —— 探测不到插件目录
      · `patch-script-missing`   —— 找不到 apply.mjs

    局域网路径（start-dsh-web.ps1）写的是 `if ($gate.ShouldCheck) { ... }`，
    所以这三条**静默放行** —— 对局域网是经过权衡的（暴露面限于同网段，
    而且插件没装就没有 /mgw/*，上游插件是唯一的路由提供者，见
    patches/mobile-gateway-mgmt-auth/patch.mjs:6）。

    但公网隧道不能照抄这个判定：它会把服务发布到 cloudflared 公网 URL，
    而「**无法确认**补丁是否生效」和「**确认**补丁已生效」是两回事。
    尤其是 `plugin-not-installed` 来自一次**路径探测**，而三处路径来源并不一致：

      · start-tunnel.ps1      → `$env:DSH_HOME`，否则 `%USERPROFILE%\.dsh`
      · setup-gateway.ps1:35,58 → 硬编码 `%USERPROFILE%\.dsh`
      · apply.mjs:57-67       → `os.homedir()`

    一旦 DSH_HOME 被设置成别处，探测就会**假阴性**：插件其实装着、/mgw/*
    其实开着且无认证，门禁却判定「不适用」而放行 —— 直接暴露到公网。

    ## 判定规则

    **只有一条放行路径**：`ShouldCheck` 严格为布尔 `$true`、`ExitCodeProvided`
    严格为布尔 `$true`、且 `ExitCode` 严格等于整数 `0`。
    其余一切状态（含无法判定、结果畸形、结果为空）全部拒绝。

    三处类型检查都是**刻意**的严格，因为 PowerShell 的隐式转换会把
    "未确认"变成"通过"：

      · `[int]$null` = 0 —— 检查器没给退出码 → 看起来像通过。
        靠 `ExitCodeProvided` 拦（`exit-code-not-provided`）。
      · `if ('false')` 为真 —— 非空字符串一律 truthy。
        所以 `ShouldCheck = 'false'` 会被当成"需要检查"，配上 ExitCode=0 就放行。
        靠 `-isnot [bool]` 拦（`shouldcheck-not-boolean`）。
      · `[int]$false` = 0 —— 同上，最隐蔽的一条。

    字段缺失（含缺 `ExitCodeProvided`）一律算 `gate-result-malformed` 并拒绝：
    旧形态的合成 gate 不该被默认放行。

    刻意**不**改 `Test-GatewayPatchApplied` 的语义 —— 局域网路径依赖它，
    收紧只发生在公网侧的这个翻译层。

.OUTPUTS
    PSCustomObject：Allow（bool）、Reason（机器可读的原因码）、Detail（给人看的说明）

.EXAMPLE
    $d = Resolve-PublicTunnelGatewayGate -Gate $gate
    if (-not $d.Allow) { Write-GatewayPatchRefusal -Public -Reason $d.Reason -Detail $d.Detail; exit 1 }
#>
function Resolve-PublicTunnelGatewayGate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [psobject]$Gate
    )

    # 检查过程抛异常时调用方会拿到 $null —— 这也是一种「无法确认」。
    if ($null -eq $Gate) {
        return [pscustomobject]@{
            Allow  = $false
            Reason = 'gate-result-missing'
            Detail = '门禁检查过程抛出异常，没有返回结果；无法确认补丁状态。'
        }
    }

    $names = @($Gate.PSObject.Properties.Name)
    foreach ($required in @('ShouldCheck', 'ExitCode', 'Reason', 'ExitCodeProvided')) {
        if ($names -notcontains $required) {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'gate-result-malformed'
                Detail = "门禁结果缺少 $required 字段，无法判定补丁状态。"
            }
        }
    }

    # ShouldCheck 必须是**严格的布尔**。PowerShell 里 if ('false') 为真
    # （非空字符串一律 truthy），所以不做类型检查的话，ShouldCheck = 'false'
    # 会被当成"需要检查"，再配上 ExitCode = 0 就**放行**了。
    if ($Gate.ShouldCheck -isnot [bool]) {
        return [pscustomobject]@{
            Allow  = $false
            Reason = 'shouldcheck-not-boolean'
            Detail = "门禁结果的 ShouldCheck 不是布尔值（实际类型：$(if ($null -eq $Gate.ShouldCheck) { 'null' } else { $Gate.ShouldCheck.GetType().Name })），无法判定。"
        }
    }

    if ($Gate.ShouldCheck) {
        # 检查器有没有**真的**给出退出码。没有 → 折叠出来的 0 不算通过。
        if ($Gate.ExitCodeProvided -isnot [bool]) {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'gate-result-malformed'
                Detail = '门禁结果的 ExitCodeProvided 不是布尔值，无法判定。'
            }
        }
        if (-not $Gate.ExitCodeProvided) {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'exit-code-not-provided'
                Detail = '检查器没有返回有效的退出码；ExitCode 里的 0 是 [int]$null 折叠出来的，不代表检查通过。'
            }
        }

        $raw = $Gate.ExitCode
        $code = $null
        if ($raw -is [int] -or $raw -is [long]) {
            $code = [int]$raw
        } elseif ($raw -is [string] -and $raw -match '^-?\d+$') {
            $code = [int]$raw
        }

        if ($null -eq $code) {
            # 注意 [int]$null 在 PowerShell 里等于 0 —— 所以这里必须**先**判类型，
            # 不能直接 [int]$raw，否则「检查器没给退出码」会被折叠成「检查通过」。
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'exit-code-unknown'
                Detail = "门禁返回的 ExitCode 不是整数（实际类型：$($raw.GetType().Name)），无法判定。"
            }
        }
        if ($code -eq 0) {
            return [pscustomobject]@{
                Allow  = $true
                Reason = 'patch-verified'
                Detail = 'apply.mjs --check 退出 0，补丁确认已生效。'
            }
        }
        return [pscustomobject]@{
            Allow  = $false
            Reason = 'patch-not-applied'
            Detail = [string]$Gate.Output
        }
    }

    switch ([string]$Gate.Reason) {
        'SkipGatewayPatchCheck' {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'skip-not-allowed-on-public'
                Detail = '公网隧道路径不接受跳过门禁（调用方本应显式传 -Skip:$false）。'
            }
        }
        'plugin-not-installed' {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'plugin-probe-inconclusive'
                Detail = '按探测路径找不到网关插件。探测路径与实际安装路径来源不一致，' +
                         '无法据此断定插件真的没装 —— 若插件其实装着，/mgw/* 就是无认证地对公网开放。'
            }
        }
        'patch-script-missing' {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'patch-script-missing'
                Detail = '找不到补丁检查脚本 patches\mobile-gateway-mgmt-auth\apply.mjs，无法校验补丁状态。'
            }
        }
        default {
            return [pscustomobject]@{
                Allow  = $false
                Reason = 'unknown-state'
                Detail = "门禁返回了未识别的状态（Reason='$([string]$Gate.Reason)'）；无法确认补丁是否生效。"
            }
        }
    }
}

<#
.SYNOPSIS
    门禁未通过时，向用户打印可操作的说明（并返回退出码 1）。

.DESCRIPTION
    把提示文案集中在一处，测试可以断言措辞而不必跑整个启动流程。

    文案分两种场景，因为「能不能跳过」在两种场景下答案不同：

      · 局域网（默认）—— 暴露面限于同网段，所以保留 -SkipGatewayPatchCheck
        这个经过权衡的 opt-out（不用手机审批的人可以强行启动）。
      · 公网隧道（-Public）—— 服务会被发布到公网 URL，此时 /mgw/* 无认证
        意味着配对码铸造对**整个互联网**可达。**不提供跳过开关**，也不在
        拒绝提示里提到它 —— 否则等于在最危险的入口教用户怎么关掉鉴权。

.PARAMETER Detail
    apply.mjs --check 的原始输出，附在提示里便于排查。

.PARAMETER Public
    当前启动路径会把服务暴露到公网（start-tunnel.ps1）。切换文案：
    说明公网可达、并且**不打印**跳过开关的提示。

.PARAMETER Reason
    Resolve-PublicTunnelGatewayGate 给出的原因码，仅对 -Public 生效。
    默认空 = 沿用既有文案（局域网调用方不传这个参数，输出逐字不变）。

    区分的意义在于：`patch-not-applied` 是**确认**补丁没生效，
    而 patch-script-missing / plugin-probe-inconclusive / unknown-state 等
    是**无法确认**。对后者说「补丁未生效」是错的（我们并不知道），
    建议 `apply.mjs --apply` 也是错的（那个脚本本身就不存在）。

.EXAMPLE
    Write-GatewayPatchRefusal -Detail $result.Output
    Write-GatewayPatchRefusal -Public -Detail $result.Output
    Write-GatewayPatchRefusal -Public -Reason $decision.Reason -Detail $decision.Detail
#>
function Write-GatewayPatchRefusal {
    [CmdletBinding()]
    param(
        [string]$Detail = '',
        [switch]$Public,
        [string]$Reason = ''
    )

    # 「无法确认」而不是「确认未生效」—— 只在公网路径且给了原因码时才切换文案，
    # 所以局域网（不传 -Public）的输出与改动前逐字相同。
    $unverifiable = $Public.IsPresent -and $Reason -ne '' -and $Reason -ne 'patch-not-applied'

    Write-Host ''
    if ($unverifiable) {
        Write-Host '[!] 无法确认网关管理接口认证补丁已生效 —— 拒绝启动。' -ForegroundColor Red
    } else {
        Write-Host '[!] 网关管理接口认证补丁未生效 —— 拒绝启动。' -ForegroundColor Red
    }
    if ($Detail) { Write-Host $Detail.Trim() -ForegroundColor DarkGray }
    Write-Host ''
    if ($unverifiable) {
        Write-Host '    原因：不是确认补丁失效，而是**无法验证**它的状态。' -ForegroundColor Yellow
        Write-Host '    公网路径按「无法确认即拒绝」处理 —— 宁可挡错，不可放过。' -ForegroundColor Yellow
    } else {
        Write-Host '    原因：插件可能刚被升级/重装，补丁被覆盖掉了。' -ForegroundColor Yellow
    }
    if ($Public) {
        Write-Host '    此时 /mgw/* 管理接口没有认证，而隧道会把服务发布到公网 ——' -ForegroundColor Yellow
        Write-Host '    配对码铸造对**整个互联网**可达，不只是同网段。' -ForegroundColor Yellow
    } else {
        Write-Host '    此时 /mgw/* 管理接口没有认证，配对码铸造对同网段可达。' -ForegroundColor Yellow
    }
    Write-Host ''
    if ($unverifiable -and $Reason -eq 'patch-script-missing') {
        # 这里不能建议 apply.mjs --apply：那个脚本正是缺失的东西。
        Write-Host '    修复：这是仓库自带文件，请重新拉取仓库；' -ForegroundColor Cyan
        Write-Host '    或重跑：.\setup-gateway.ps1' -ForegroundColor Cyan
    } elseif ($unverifiable -and $Reason -eq 'plugin-probe-inconclusive') {
        Write-Host '    修复：重跑 .\setup-gateway.ps1（会安装插件并打补丁）' -ForegroundColor Cyan
        Write-Host '    若确认插件已装：检查 DSH_HOME 是否把探测指到了别的目录' -ForegroundColor Cyan
    } else {
        Write-Host '    修复：node patches\mobile-gateway-mgmt-auth\apply.mjs --apply' -ForegroundColor Cyan
        Write-Host '    或重跑：.\setup-gateway.ps1' -ForegroundColor Cyan
    }
    Write-Host ''
    if ($Public) {
        # 刻意不提 -SkipGatewayPatchCheck：公网路径没有这个退出口。
        Write-Host '    公网隧道不提供跳过开关。请先修好补丁；' -ForegroundColor DarkGray
        Write-Host '    确实不需要手机审批时，改用局域网路径 .\start-dsh-web.ps1。' -ForegroundColor DarkGray
    } else {
        Write-Host '    确认不需要手机审批、想强行启动：加 -SkipGatewayPatchCheck' -ForegroundColor DarkGray
    }
}
