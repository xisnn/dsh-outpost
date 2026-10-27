/**
 * 跨平台 PowerShell 运行器。
 *
 * ## 为什么需要这个模块
 *
 * 测试里需要真的执行 `.ps1`（语法解析 + 行为验证），但 PowerShell 的
 * 可执行文件名在不同平台不一样：
 *
 *   · Windows  → `powershell.exe`（Windows PowerShell 5.1）
 *                或 `pwsh.exe`（PowerShell 7+，可能没装）
 *   · Linux CI → `pwsh`（PowerShell 7+）
 *                **没有 `powershell`** —— 那是 Windows 专有的
 *   · macOS    → `pwsh`
 *
 * 原先测试里硬编码 `execFileSync('powershell', ...)`，在 GitHub Actions 的
 * `ubuntu-latest` 上会直接 `ENOENT: spawnSync powershell ENOENT`。
 * 更糟的是外层用了无差别 `catch`，把「可执行文件不存在」和「脚本真有语法错误」
 * 混成同一句「语法解析失败」—— 看起来像代码坏了，实际只是环境差异。
 *
 * ## 本模块做什么
 *
 * 1. 按平台+可用性挑一个可执行文件（存在且能跑 `$PSVersionTable`）
 * 2. 把失败原因分成三类，便于测试给出准确的失败信息：
 *      · `missing`  —— 找不到任何 PowerShell（**环境问题，不是代码问题**）
 *      · `parse`    —— PowerShell 跑起来了，但脚本解析/执行失败（**真问题**）
 *      · `error`    —— 其它异常（超时、权限等）
 * 3. 默认**不悄悄跳过**：找不到 PowerShell 时由调用方决定是 skip 还是 fail，
 *    并且必须显式声明（本仓库的选择是：CI 里必须有，本地可跳过但要标注）
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/** 已探测到的可执行文件缓存（避免每次测试都探测一遍） */
let cached = null;

/**
 * 候选可执行文件，按优先级排列。
 *
 * Windows 上优先 pwsh（PS7）还是 powershell（5.1）？
 * → 优先 **powershell.exe**：仓库的 .ps1 是给 PS 5.1 写的（还依赖 BOM），
 *   而 CI 的 ubuntu 只有 pwsh。两边都能跑同一份脚本，
 *   但本地要覆盖用户真实环境（多数 Windows 用户是 5.1），所以优先 5.1。
 */
function candidates() {
  if (process.platform === 'win32') {
    return ['powershell.exe', 'powershell', 'pwsh.exe', 'pwsh'];
  }
  return ['pwsh', 'powershell'];
}

/** 这个可执行文件真的能用吗（能打印版本） */
function probe(exe) {
  try {
    execFileSync(exe, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 找一个可用的 PowerShell。
 * @returns {{ ok: true, exe: string } | { ok: false, reason: string }}
 */
export function findPowerShell() {
  if (cached !== null) return cached;

  const tried = [];
  for (const exe of candidates()) {
    if (probe(exe)) {
      cached = { ok: true, exe };
      return cached;
    }
    tried.push(exe);
  }
  cached = {
    ok: false,
    reason:
      `找不到可用的 PowerShell（尝试过：${tried.join(', ')}）。` +
      (process.platform === 'linux'
        ? ' Ubuntu CI 上需要 `pwsh` —— 见 workflow 里的 setup step。'
        : ' 请安装 PowerShell。'),
  };
  return cached;
}

/** 仅供测试/重置用 */
export function resetPowerShellCache() {
  cached = null;
}

/**
 * 用 PowerShell 解析一个 .ps1 文件，判断语法是否有效。
 *
 * @param {string} filePath 绝对路径
 * @returns {{ status: 'ok'|'parse'|'missing'|'error', detail?: string }}
 */
export function parsePowerShellFile(filePath) {
  const ps = findPowerShell();
  if (!ps.ok) return { status: 'missing', detail: ps.reason };

  // 注意：路径用单引号包住并转义内部单引号，避免注入与空格问题
  const escaped = String(filePath).replace(/'/g, "''");
  const script = [
    '$err = $null',
    `$null = [System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$null, [ref]$err)`,
    'if ($err -and $err.Count -gt 0) {',
    '  $err | ForEach-Object { Write-Output ("ERR_LINE=" + $_.Extent.StartLineNumber + " " + $_.Message) }',
    "  Write-Output 'PARSE_FAIL'",
    '  exit 1',
    '} else {',
    "  Write-Output 'PARSE_OK'",
    '}',
  ].join('\n');

  try {
    const out = execFileSync(ps.exe, ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/PARSE_OK/.test(out)) return { status: 'ok' };
    // 打印了 PARSE_FAIL 但退出码被吞：仍按解析失败处理
    return { status: 'parse', detail: firstErrLine(out) || out.trim() };
  } catch (e) {
    const out = String(e.stdout || '') + String(e.stderr || '');
    // 区分「PowerShell 自己没跑起来」和「脚本解析失败」
    if (e.code === 'ENOENT') {
      return { status: 'missing', detail: `spawn ${ps.exe} ENOENT` };
    }
    if (/PARSE_FAIL/.test(out)) {
      return { status: 'parse', detail: firstErrLine(out) };
    }
    return {
      status: 'error',
      detail: `退出码 ${e.status ?? '?'}：${(firstErrLine(out) || e.message || '').slice(0, 300)}`,
    };
  }
}

/**
 * 执行一个 .ps1 并返回它的输出。
 *
 * 与 `parsePowerShellFile` 不同的是：**脚本返回非 0 退出码是正常的**
 * （例如 doctor.ps1 用退出码表达自检结论）。所以这里把 stdout/stderr
 * 都当成输出返回，只有「PowerShell 本身跑不起来」才报 missing。
 *
 * @param {string} filePath 绝对路径
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 * @returns {{ status: 'ok'|'missing'|'error', output: string, exitCode?: number, detail?: string }}
 */
export function runPowerShellFile(filePath, opts = {}) {
  const ps = findPowerShell();
  if (!ps.ok) return { status: 'missing', output: '', detail: ps.reason };

  try {
    const out = execFileSync(
      ps.exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filePath],
      {
        cwd: opts.cwd,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 120000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 'ok', output: out, exitCode: 0 };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { status: 'missing', output: '', detail: `spawn ${ps.exe} ENOENT` };
    }
    const out = String(e.stdout || '') + String(e.stderr || '');
    // 有输出就说明脚本确实跑起来了；非 0 退出码由调用方解读
    if (out.length > 0) {
      return { status: 'ok', output: out, exitCode: typeof e.status === 'number' ? e.status : -1 };
    }
    return {
      status: 'error',
      output: '',
      detail: (e.message || String(e)).slice(0, 300),
    };
  }
}

/** 从 PowerShell 报错里取第一行有用信息（不打印整段栈） */
function firstErrLine(text) {
  if (!text) return '';
  const line = String(text)
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.startsWith('ERR_LINE='));
  if (line) return line;
  return String(text)
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !/^(At line|CategoryInfo|FullyQualifiedErrorId|\+)/.test(s)) || '';
}

/**
 * 写一个临时 .ps1 文件，**带 UTF-8 BOM**。
 *
 * ## 为什么必须带 BOM
 *
 * Windows PowerShell 5.1 在没有 BOM 时按系统 ANSI 代码页解读 .ps1。
 * 如果脚本里有中文（注释或字符串），会被按 GBK/Latin-1 解码成乱码，
 * 乱码又可能吞掉后面的引号或换行，导致**语法解析失败或后续代码被静默丢弃**。
 *
 * 真实踩到的表现：测试动态生成的驱动脚本里有中文注释，
 * 结果前两个 `Emit` 调用的输出属性全为空（`CASE|skip|||`），
 * 而后几个正常 —— 排查了很久才定位到是 BOM 缺失。
 *
 * PowerShell 7（pwsh / Linux）默认按 UTF-8 读，加 BOM 也无害。
 *
 * @param {string} filePath
 * @param {string} content
 */
export function writePowerShellScript(filePath, content) {
  writeFileSync(filePath, '\uFEFF' + String(content), 'utf8');
}

