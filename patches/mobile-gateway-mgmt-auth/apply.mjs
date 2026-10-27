#!/usr/bin/env node
/**
 * 应用 / 校验 / 回滚 DSH Mobile Gateway 管理接口认证补丁。
 *
 * ## 为什么需要这个脚本（而不是「改一下 node_modules 就算了」）
 *
 * `node_modules` 不是版本控制的对象：一次 `npm install`、`npx dsh plugin add`、
 * 或插件升级，都会把补丁无声地抹掉。如果只在本地手改一次，下次重装就回到
 * 未打补丁（= 管理接口无认证）的状态，而用户不会察觉。
 *
 * 所以补丁做成「可重放的文本变换 + 指纹校验」：
 *
 *   · 补丁内容在版本控制里（`patch.mjs`）
 *   · 应用前校验插件文件的 SHA-256 是否在白名单里（防止在未知版本上乱打）
 *   · 应用后把结果指纹写进 `state.json`，`--check` 能判定「是否已打、是否被回退」
 *   · 幂等：重复 apply 不会叠加
 *
 * ## 用法
 *
 *   node patches/mobile-gateway-mgmt-auth/apply.mjs --check     # 只检查
 *   node patches/mobile-gateway-mgmt-auth/apply.mjs --apply     # 打补丁
 *   node patches/mobile-gateway-mgmt-auth/apply.mjs --revert    # 还原（从备份）
 *   node patches/mobile-gateway-mgmt-auth/apply.mjs --apply --path <custom index.mjs>
 *
 * 退出码：0 = 已处于期望状态；1 = 需要处理 / 失败。
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { patchManagementAuth } from './patch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(HERE, 'state.json');

/**
 * 已知可打补丁的插件版本 → 该版本 `lib/index.mjs` 的 SHA-256。
 *
 * 只允许在**精确匹配**的文件上打补丁：补丁靠文本锚点定位，锚点消失时
 * 强行打会产出语义错误的代码——那比不打补丁更危险。
 * 遇到新版本时，先人工核对锚点仍然成立，再把新哈希加进来。
 */
const KNOWN_SOURCES = {
  '0.10.3': '7f9f38f36183fa4621675d49de2f3c2456452c048bdc6a38412a7a2724cb7413',
};

const MARKER = 'DSH_OUTPOST_MGW_AUTH_PATCH';

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 默认插件路径（Windows 下 DSH profile 的 node_modules） */
function defaultPluginPath() {
  return path.join(
    os.homedir(),
    '.dsh',
    'profiles',
    'web',
    'node_modules',
    'dsh-plugin-mobile-gateway',
    'lib',
    'index.mjs',
  );
}

function readPluginVersion(indexPath) {
  try {
    const pkgPath = path.join(path.dirname(indexPath), '..', 'package.json');
    let text = readFileSync(pkgPath, 'utf8');
    // PowerShell 的 Set-Content -Encoding UTF8 会写 BOM；
    // JSON.parse 遇到 \uFEFF 会直接抛错，导致版本被误判成 unknown。
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const pkg = JSON.parse(text);
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const out = { mode: 'check', target: '' };
  for (const a of argv) {
    if (a === '--check') out.mode = 'check';
    else if (a === '--apply') out.mode = 'apply';
    else if (a === '--revert') out.mode = 'revert';
    else if (a.startsWith('--path=')) out.target = a.slice('--path='.length);
    else if (a === '--help' || a === '-h') out.mode = 'help';
  }
  return out;
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'help') {
    console.log(
      [
        'Usage: node apply.mjs [--check|--apply|--revert] [--path=<lib/index.mjs>]',
        '',
        '  --check   报告补丁是否已应用（默认）',
        '  --apply   应用补丁（幂等）',
        '  --revert  从 .orig 备份还原',
      ].join('\n'),
    );
    return;
  }

  const target = args.target || defaultPluginPath();
  if (!existsSync(target)) {
    fail(`找不到插件文件：${target}`);
    console.error('  插件未安装时无需打补丁；装好后重跑本脚本。');
    return;
  }

  const version = readPluginVersion(target);
  const pristine = readFileSync(target, 'utf8');
  const pristineHash = sha256(pristine);
  const alreadyPatched = pristine.includes(MARKER);

  if (args.mode === 'check') {
    if (alreadyPatched) {
      ok(`补丁已应用（插件 ${version}）`);
      const st = readState();
      if (st && st.patchedHash && st.patchedHash !== pristineHash) {
        console.error('  ⚠ 文件在打补丁后被改动过，建议重新 apply');
        process.exitCode = 1;
      }
    } else {
      console.error(`✗ 补丁**未**应用（插件 ${version}）`);
      console.error('  管理接口当前依赖 adminLoopbackOnly / Origin 这两道不足的防线。');
      console.error('  运行：node patches/mobile-gateway-mgmt-auth/apply.mjs --apply');
      process.exitCode = 1;
    }
    return;
  }

  if (args.mode === 'apply') {
    if (alreadyPatched) {
      ok(`补丁已经应用过（插件 ${version}），无需重复`);
      return;
    }

    const expected = KNOWN_SOURCES[version];
    if (!expected) {
      fail(`插件版本 ${version} 不在已核对白名单里`);
      console.error('  已知版本：' + Object.keys(KNOWN_SOURCES).join(', '));
      console.error('  请人工确认补丁锚点仍成立后，把该版本的 SHA-256 加入 KNOWN_SOURCES：');
      console.error('  当前文件 SHA-256 = ' + pristineHash);
      return;
    }
    if (pristineHash !== expected) {
      fail(`插件文件指纹与白名单不符（版本 ${version}）`);
      console.error(`  期望 ${expected}`);
      console.error(`  实际 ${pristineHash}`);
      console.error('  文件可能被改过或版本号不实 —— 拒绝打补丁。');
      return;
    }

    let patched;
    try {
      patched = patchManagementAuth(pristine);
    } catch (e) {
      fail('打补丁失败：' + (e instanceof Error ? e.message : String(e)));
      return;
    }

    // 备份一次即可（不要用 patched 覆盖备份）
    const backup = target + '.orig';
    if (!existsSync(backup)) copyFileSync(target, backup);

    writeFileSync(target, patched, 'utf8');
    const patchedHash = sha256(patched);
    writeState({ version, pristineHash, patchedHash, at: new Date().toISOString() });

    ok(`补丁已应用（插件 ${version}）`);
    console.log('  原始备份：' + path.basename(backup));
    console.log('  重启 DSH Web 后生效。');
    return;
  }

  if (args.mode === 'revert') {
    const backup = target + '.orig';
    if (!existsSync(backup)) {
      fail('没有找到备份文件（' + path.basename(backup) + '），无法还原');
      return;
    }
    copyFileSync(backup, target);
    ok('已从备份还原（管理接口将回到无认证状态）');
    return;
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(obj) {
  try {
    if (!existsSync(HERE)) mkdirSync(HERE, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch {
    /* 状态文件写不了不影响补丁本身 */
  }
}

main();
