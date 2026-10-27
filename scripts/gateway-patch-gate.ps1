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
      ShouldCheck  —— 是否需要做这次检查（false 表示不适用：跳过开关/未装插件/无补丁脚本）
      ExitCode     —— apply.mjs --check 的退出码（0 = 已应用；非 0 = 未应用或出错）
      Output       —— apply.mjs 的原始输出（给用户看的详情）
      Reason       —— 不检查的原因（ShouldCheck 为 false 时）

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
    if ($Skip) {
        return [pscustomobject]@{
            ShouldCheck = $false
            ExitCode    = 0
            Output      = ''
            Reason      = 'SkipGatewayPatchCheck'
        }
    }
    if (-not $PluginInstalled) {
        return [pscustomobject]@{
            ShouldCheck = $false
            ExitCode    = 0
            Output      = ''
            Reason      = 'plugin-not-installed'
        }
    }
    if (-not (Test-Path -LiteralPath $PatchScript)) {
        return [pscustomobject]@{
            ShouldCheck = $false
            ExitCode    = 0
            Output      = ''
            Reason      = 'patch-script-missing'
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
    return [pscustomobject]@{
        ShouldCheck = $true
        ExitCode    = [int]$result.ExitCode
        Output      = [string]$result.Output
        Reason      = ''
    }
}

<#
.SYNOPSIS
    门禁未通过时，向用户打印可操作的说明（并返回退出码 1）。

.DESCRIPTION
    把提示文案集中在一处，测试可以断言措辞而不必跑整个启动流程。

.PARAMETER Detail
    apply.mjs --check 的原始输出，附在提示里便于排查。

.EXAMPLE
    Write-GatewayPatchRefusal -Detail $result.Output
#>
function Write-GatewayPatchRefusal {
    [CmdletBinding()]
    param([string]$Detail = '')

    Write-Host ''
    Write-Host '[!] 网关管理接口认证补丁未生效 —— 拒绝启动。' -ForegroundColor Red
    if ($Detail) { Write-Host $Detail.Trim() -ForegroundColor DarkGray }
    Write-Host ''
    Write-Host '    原因：插件可能刚被升级/重装，补丁被覆盖掉了。' -ForegroundColor Yellow
    Write-Host '    此时 /mgw/* 管理接口没有认证，配对码铸造对同网段可达。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    修复：node patches\mobile-gateway-mgmt-auth\apply.mjs --apply' -ForegroundColor Cyan
    Write-Host '    或重跑：.\setup-gateway.ps1' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '    确认不需要手机审批、想强行启动：加 -SkipGatewayPatchCheck' -ForegroundColor DarkGray
}
