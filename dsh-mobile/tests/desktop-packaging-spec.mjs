/**
 * Windows 桌面助手打包与退出清理回归测试（P1-11 / P1-12）。
 *
 * ## P1-11：打包版隧道按钮是死的
 *
 * electron-builder 的 extraResources 只拷了 `tunnel-service.mjs` 和
 * `start-dsh-web.ps1`，**没有 `start-tunnel.ps1`**。而 tunnel-service 用
 * `path.join(REPO_ROOT, 'start-tunnel.ps1')` 定位脚本 —— 打包后
 * REPO_ROOT 是安装根，拼出来的路径不存在。
 * 结果：面板上「启动隧道 / 停止隧道 / 一键修复」全是死按钮，
 * 而隧道是「在外面也能用」的唯一免装方案。
 *
 * ## P1-12：退出后 cloudflared 残留
 *
 * cloudflared 是 start-tunnel.ps1 拉起的**孙子进程**，不在同一 job object，
 * `serviceProc.kill()` 杀不到。用户点了「退出」，以为关干净了，
 * 实际公网域名仍指向这台机器 —— 机器继续暴露在公网。
 *
 * ## 测什么
 *
 * 静态断言（打包配置 + 脚本存在性 + 清理逻辑挂载），以及
 * **真实模拟打包目录布局**验证 findScript 能找到脚本。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass += 1;
  console.log('  OK    ' + n);
};
const bad = (n, d) => {
  fail += 1;
  console.log('  FAIL  ' + n + (d ? ' — ' + d : ''));
};
const check = (c, n, d) => (c ? ok(n) : bad(n, d));

const repo = path.resolve(import.meta.dirname, '..', '..');
const read = (p) => readFileSync(path.join(repo, p), 'utf8');

console.log('');
console.log('── P1-11：打包必须包含 start-tunnel.ps1 ──');

const builder = read('dsh-outpost-desktop/electron-builder.yml');
check(
  builder.includes('"../start-tunnel.ps1"'),
  'electron-builder.yml 的 extraResources 包含 start-tunnel.ps1',
);
check(
  builder.includes('"../start-dsh-web.ps1"'),
  'start-dsh-web.ps1 仍然被包含（没有回归）',
);
check(
  builder.includes('"../dsh-plugin-connect/tunnel-service.mjs"'),
  'tunnel-service.mjs 仍然被包含',
);

// 源文件本身必须存在，否则打包会静默跳过
check(existsSync(path.join(repo, 'start-tunnel.ps1')), '仓库里存在 start-tunnel.ps1');
check(existsSync(path.join(repo, 'start-dsh-web.ps1')), '仓库里存在 start-dsh-web.ps1');

console.log('');
console.log('── 打包必须带上 start-dsh-web.ps1 运行时依赖的目录 ──');

// ## 为什么这条必须测
//
// start-dsh-web.ps1 在 `$PSScriptRoot` 下找两样东西：
//   · scripts\gateway-patch-gate.ps1   （网关认证门禁，缺了会拒绝启动）
//   · patches\mobile-gateway-mgmt-auth\apply.mjs（门禁要调的检查脚本）
//
// 开发时它们在仓库根，路径拼得对；但 electron-builder 的 extraResources
// 是**白名单**——没列进去的文件不会进包。
//
// 真实踩到：把门禁抽成 scripts/gateway-patch-gate.ps1 后没同步更新
// extraResources，结果打包版 resources/ 里只有 4 个文件，没有 scripts/，
// 于是 start-dsh-web.ps1 一启动就报「缺少模块」并 exit 1 ——
// 打包版彻底无法启动。而且这个缺陷在源码测试里完全看不出来。
check(
  /"from":\s*"\.\.\/scripts"/.test(builder),
  'extraResources 包含 scripts/ 目录（网关门禁模块）',
);
check(
  /"from":\s*"\.\.\/patches"/.test(builder),
  'extraResources 包含 patches/ 目录（apply.mjs 检查脚本）',
);

// 目录确实存在且包含关键文件
{
  const scriptsDir = path.join(repo, 'scripts');
  const patchesDir = path.join(repo, 'patches');
  check(existsSync(scriptsDir), '仓库里存在 scripts/ 目录');
  check(existsSync(patchesDir), '仓库里存在 patches/ 目录');
  check(
    existsSync(path.join(scriptsDir, 'gateway-patch-gate.ps1')),
    'scripts/gateway-patch-gate.ps1 存在',
  );
  check(
    existsSync(path.join(patchesDir, 'mobile-gateway-mgmt-auth', 'apply.mjs')),
    'patches/mobile-gateway-mgmt-auth/apply.mjs 存在',
  );
}

// start-dsh-web.ps1 用到的每个 $PSScriptRoot 相对路径，都必须能在打包布局下命中
{
  const startSrc = read('start-dsh-web.ps1');
  const required = [...startSrc.matchAll(/Join-Path \$PSScriptRoot '([^']+)'/g)].map((m) => m[1]);
  // 归一化成相对仓库根的路径（替换反斜杠）
  const needDirs = required.map((r) => r.split('\\')[0]);
  const uniq = [...new Set(needDirs)];
  check(uniq.length > 0, `start-dsh-web.ps1 声明了 ${uniq.length} 个运行时依赖目录`, uniq.join(', '));
  // 每个依赖目录的第一级，要么是已经打包的单文件，要么必须是 extraResources 里的目录项
  for (const d of uniq) {
    const isBundledDir = new RegExp(`"from":\\s*"\\.\\.\\/${d}"`).test(builder);
    check(isBundledDir, `依赖目录 "${d}/" 已加入 extraResources`);
  }
}

const tunnelSvc = read('dsh-plugin-connect/tunnel-service.mjs');
check(/function findScript\(name\)/.test(tunnelSvc), 'tunnel-service 有 findScript 多路径探测');
check(
  /path\.join\(HERE, name\)/.test(tunnelSvc),
  'findScript 会尝试「与本文件同目录」（打包后的 resources/）',
);
check(
  /const TUNNEL_SCRIPT = findScript\('start-tunnel\.ps1'\)/.test(tunnelSvc),
  'TUNNEL_SCRIPT 用 findScript 解析',
);
check(
  /const DSH_SCRIPT = findScript\('start-dsh-web\.ps1'\)/.test(tunnelSvc),
  'DSH_SCRIPT 用 findScript 解析',
);

// 行为：模拟「打包后」的目录布局，验证 findScript 能命中
{
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pkg-layout-'));
  try {
    // 模拟 <install>/resources/{tunnel-service.mjs, start-tunnel.ps1, start-dsh-web.ps1}
    const resources = path.join(tmp, 'resources');
    mkdirSync(resources, { recursive: true });
    const svcCopy = path.join(resources, 'tunnel-service.mjs');
    copyFileSync(path.join(repo, 'dsh-plugin-connect', 'tunnel-service.mjs'), svcCopy);
    copyFileSync(path.join(repo, 'start-tunnel.ps1'), path.join(resources, 'start-tunnel.ps1'));
    copyFileSync(path.join(repo, 'start-dsh-web.ps1'), path.join(resources, 'start-dsh-web.ps1'));

    // 用同样的算法在测试里复算（避免真的启动服务）
    const HERE = resources;
    const REPO_ROOT = path.resolve(HERE, '..');
    const findScript = (name) => {
      const cands = [
        path.join(REPO_ROOT, name),
        path.join(HERE, name),
        path.resolve(HERE, '..', name),
        path.resolve(HERE, '..', '..', name),
      ];
      for (const p of cands) {
        try {
          if (existsSync(p)) return p;
        } catch {
          /* ignore */
        }
      }
      return cands[0];
    };

    // 旧算法（只拼 REPO_ROOT）会失败 —— 这就是 P1-11
    const oldPath = path.join(REPO_ROOT, 'start-tunnel.ps1');
    check(!existsSync(oldPath), '旧算法（只拼 REPO_ROOT）在打包布局下确实找不到脚本');

    const newPath = findScript('start-tunnel.ps1');
    check(existsSync(newPath), '新算法在打包布局下能找到 start-tunnel.ps1', newPath);
    check(newPath === path.join(HERE, 'start-tunnel.ps1'), '命中的是 resources/ 下的那份');

    const dshPath = findScript('start-dsh-web.ps1');
    check(existsSync(dshPath), '新算法也能找到 start-dsh-web.ps1');
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log('');
console.log('── P1-12：退出时必须停掉隧道 ──');

const mainJs = read('dsh-outpost-desktop/src/main/main.js');
check(/async function stopTunnelOnQuit/.test(mainJs), '存在 stopTunnelOnQuit');
check(
  /\['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Stop'\]/.test(mainJs),
  '退出时以 -Stop 调用 start-tunnel.ps1',
);
check(
  /findStartScript\('start-tunnel\.ps1'\)/.test(mainJs),
  '用 findStartScript 定位 start-tunnel.ps1（打包/开发都覆盖）',
);
check(
  /app\.on\('before-quit'[\s\S]{0,400}?event\.preventDefault\(\)/.test(mainJs),
  'before-quit 先拦截退出，等清理完成',
);
check(
  /await stopTunnelOnQuit\(\)/.test(mainJs),
  '退出流程里 await 了隧道清理',
);
check(
  /quitCleanupDone/.test(mainJs),
  '有一次性保护（避免 app.quit() 被再次拦下造成死循环）',
);
// 清理失败不能卡住退出
check(
  /setTimeout\([\s\S]{0,200}?8000/.test(mainJs),
  '隧道清理有 8 秒上限（失败不阻塞退出）',
);

// findStartScript 必须支持参数名
check(
  /function findStartScript\(name = 'start-dsh-web\.ps1'\)/.test(mainJs),
  'findStartScript 支持指定脚本名',
);

console.log('');
console.log(`结果：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
