/**
 * D-3 网关注册表隔离补丁 —— 回归测试。
 *
 * ## 守什么
 *
 * 上游 dsh-plugin-mobile-gateway 0.10.3 只用 os.homedir() 解析设备注册表，
 * 完全忽略 DSH_HOME：隔离实例会读/写正式 ~/.dsh 设备凭据、共享 gatewayId。
 * 而且注册表是「启动读入内存 + 整表覆盖写回」，两个独立进程共用一个文件时
 * 互相覆盖快照：一边吊销，另一边仍接受旧 Token。
 *
 * 补丁做两件事：
 *   1. 路径解析优先级 显式 deviceFile > 非空 DSH_HOME > ~/.dsh（与 DSH 核心一致）
 *   2. 每个数据文件只允许一个存活进程持有；同进程组件可重入，陈旧锁可回收
 *
 * ## 测什么
 *
 * 1. 锚点完整性 / fail-closed（缺失、重复、已打补丁都必须抛错）
 * 2. 应用结果语法有效、标记只出现预期次数
 * 3. 解析器语义：显式优先、空白 env 视为未设、无 env 与旧默认逐字节相同
 * 4. 锁语义：同进程可重入、跨进程拒绝、陈旧回收、损坏锁失败关闭
 * 5. apply.mjs 门禁：白名单、指纹、幂等、精确回滚
 * 6. 与 mgmt-auth 补丁组合，且回滚本补丁不会破坏认证补丁
 *
 * 全部在 fixture 副本与虚构临时目录上做，不读取也不修改真实 ~/.dsh。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EDITS, EDITED_FILES, MARKER, NEW_FILES, patchFile, patchGateway,
} from '../../patches/mobile-gateway-home-isolation/patch.mjs';
import { patchManagementAuth } from '../../patches/mobile-gateway-mgmt-auth/patch.mjs';

let pass = 0;
let fail = 0;
function ok(n) { pass += 1; console.log('  OK    ' + n); }
function bad(n, d) { fail += 1; console.log('  FAIL  ' + n + (d ? ' — ' + d : '')); }
function check(cond, name, detail) { if (cond) ok(name); else bad(name, detail); }

const repo = path.resolve(import.meta.dirname, '..', '..');
const patchDir = path.join(repo, 'patches', 'mobile-gateway-home-isolation');
const applyScript = path.join(patchDir, 'apply.mjs');
const fixtureDir = path.join(repo, 'dsh-mobile', 'tests', 'fixtures');

const FIXTURES = {
  'lib/index.mjs': 'mobile-gateway-home-isolation-index-fixture.mjs',
  'lib/devices.js': 'mobile-gateway-home-isolation-devices-fixture.js',
  'lib/gateway-state.mjs': 'mobile-gateway-home-isolation-state-fixture.mjs',
};

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-mgw-home-iso-'));
const cleanup = [];
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(scratch, prefix));
  cleanup.push(dir);
  return dir;
}

console.log('mobile-gateway home-isolation patch regression');

// ---------------------------------------------------------------------------
// 1. anchor integrity
// ---------------------------------------------------------------------------
const sources = {};
for (const [relative, fixture] of Object.entries(FIXTURES)) {
  sources[relative] = readFileSync(path.join(fixtureDir, fixture), 'utf8');
}

for (const [file, anchor] of EDITS) {
  const hits = sources[file].split(anchor).length - 1;
  check(hits === 1, `anchor unique in ${file}: ${anchor.slice(0, 48).replace(/\n/g, '\\n')}`, `found ${hits}`);
}

// ---------------------------------------------------------------------------
// 2. application result is syntactically valid and marked once per edit
// ---------------------------------------------------------------------------
let patched = null;
try {
  patched = patchGateway(sources);
  ok('patchGateway applies to all pristine fixtures');
} catch (error) {
  bad('patchGateway applies to all pristine fixtures', error.message);
}

if (patched) {
  for (const relative of EDITED_FILES) {
    const out = path.join(tempDir('syntax-'), path.basename(relative));
    writeFileSync(out, patched[relative], 'utf8');
    const result = spawnSync(process.execPath, ['--check', out], { encoding: 'utf8' });
    check(result.status === 0, `patched ${relative} parses`, result.stderr);
    const expected = EDITS.filter(([f]) => f === relative)
      .reduce((total, [, , replacement]) => total + replacement.split(MARKER).length - 1, 0);
    const marks = patched[relative].split(MARKER).length - 1;
    check(marks === expected, `patched ${relative} carries ${expected} markers`, `found ${marks}`);
  }
}

// ---------------------------------------------------------------------------
// 3. fail-closed transformations
// ---------------------------------------------------------------------------
try {
  patchFile('lib/index.mjs', patched ? patched['lib/index.mjs'] : sources['lib/index.mjs'] + MARKER);
  bad('re-patching an already patched file throws');
} catch {
  ok('re-patching an already patched file throws');
}

try {
  const broken = sources['lib/index.mjs'].replace(
    "const deviceFile = options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')",
    'const deviceFile = somethingElse()',
  );
  patchFile('lib/index.mjs', broken);
  bad('missing anchor throws');
} catch {
  ok('missing anchor throws');
}

try {
  const anchor = "import { createGatewayState, GATEWAY_MODES } from './gateway-state.mjs'";
  const duplicated = sources['lib/index.mjs'].replace(anchor, `${anchor}\n${anchor}`);
  patchFile('lib/index.mjs', duplicated);
  bad('duplicated anchor throws');
} catch {
  ok('duplicated anchor throws');
}

// ---------------------------------------------------------------------------
// 4. resolver semantics (the real payload module, not a transcription)
// ---------------------------------------------------------------------------
const homePaths = await import(pathToFileURL(path.join(patchDir, 'files', 'home-paths.mjs')).href);
const { resolveDeviceFile, resolveDshHome } = homePaths;

const legacyDefault = path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json');
check(
  resolveDeviceFile({}, {}) === legacyDefault,
  'no DSH_HOME reproduces the legacy default byte-for-byte',
  `${resolveDeviceFile({}, {})} !== ${legacyDefault}`,
);
check(
  resolveDeviceFile({}, { DSH_HOME: '   ' }) === legacyDefault,
  'whitespace-only DSH_HOME is treated as unset',
);
check(
  resolveDeviceFile({}, { DSH_HOME: '' }) === legacyDefault,
  'empty DSH_HOME is treated as unset',
);
const isolatedRoot = path.join(scratch, 'isolated-home');
check(
  resolveDeviceFile({}, { DSH_HOME: isolatedRoot }) === path.join(isolatedRoot, 'mobile-gateway-devices.json'),
  'DSH_HOME redirects the registry into the isolated root',
);
check(
  resolveDeviceFile({ deviceFile: 'explicit.json' }, { DSH_HOME: isolatedRoot }) === 'explicit.json',
  'explicit deviceFile wins over DSH_HOME and stays verbatim',
);
check(
  resolveDeviceFile({ deviceFile: '' }, { DSH_HOME: isolatedRoot })
    === path.join(isolatedRoot, 'mobile-gateway-devices.json'),
  'empty explicit deviceFile falls through to DSH_HOME',
);
check(
  resolveDshHome({ DSH_HOME: '~/dsh-tilde' }) === path.join(os.homedir(), 'dsh-tilde'),
  'tilde in DSH_HOME expands against the OS home',
);
check(
  path.isAbsolute(resolveDeviceFile({}, { DSH_HOME: 'relative-root' })),
  'a relative DSH_HOME still resolves to an absolute registry path',
);

// ---------------------------------------------------------------------------
// 5. lock semantics (the real payload module)
// ---------------------------------------------------------------------------
const { acquireRegistryLock } = await import(
  pathToFileURL(path.join(patchDir, 'files', 'registry-lock.js')).href
).then((m) => m.default ?? m);

const lockDir = tempDir('lock-');
const dataFile = path.join(lockDir, 'devices.json');
const lockPath = `${dataFile}.lock`;

const release1 = acquireRegistryLock(dataFile, 'device registry');
check(existsSync(lockPath), 'acquiring creates the lock file');
const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
check(owner.pid === process.pid, 'lock records the owning pid');

const release2 = acquireRegistryLock(dataFile, 'device registry');
ok('same-process reacquire is reentrant (legitimate component sharing)');
release2();
check(existsSync(lockPath), 'inner release keeps the outer ownership');
release1();
check(!existsSync(lockPath), 'outer release removes the lock');

// A malformed lock must fail closed rather than be silently replaced.
writeFileSync(lockPath, '{ not json', 'utf8');
let malformedThrew = false;
try { acquireRegistryLock(dataFile, 'device registry'); } catch { malformedThrew = true; }
check(malformedThrew, 'malformed lock fails closed');
check(readFileSync(lockPath, 'utf8') === '{ not json', 'malformed lock is not overwritten');
rmSync(lockPath, { force: true });

// A lock whose owner pid is gone must be reclaimed.
writeFileSync(lockPath, `${JSON.stringify({
  version: 1, pid: 999999999, token: 'stale-token', label: 'device registry', file: dataFile,
})}\n`, 'utf8');
let staleRelease = null;
try {
  staleRelease = acquireRegistryLock(dataFile, 'device registry');
  ok('stale lock from a dead pid is reclaimed');
} catch (error) {
  bad('stale lock from a dead pid is reclaimed', error.message);
}
if (staleRelease) staleRelease();

// Cross-process: a live owner must refuse a second process.
const holderScript = path.join(tempDir('holder-'), 'holder.cjs');
writeFileSync(holderScript, `
  const { acquireRegistryLock } = require(${JSON.stringify(path.join(patchDir, 'files', 'registry-lock.js'))});
  const file = process.argv[2];
  const hold = Number(process.argv[3] || 0);
  try {
    acquireRegistryLock(file, 'device registry');
    process.stdout.write('ACQUIRED\\n');
    if (hold) setTimeout(() => process.exit(0), hold); else process.exit(0);
  } catch (e) {
    process.stdout.write('REFUSED ' + e.message + '\\n');
    process.exit(0);
  }
`, 'utf8');

const sharedFile = path.join(tempDir('cross-'), 'devices.json');
const holder = spawnSync(process.execPath, [holderScript, sharedFile, '0'], { encoding: 'utf8', timeout: 30000 });
check(/ACQUIRED/.test(holder.stdout), 'first process acquires', holder.stdout + holder.stderr);

// Hold the lock from THIS process, then probe from a child.
const heldRelease = acquireRegistryLock(sharedFile, 'device registry');
const probe = spawnSync(process.execPath, [holderScript, sharedFile, '0'], { encoding: 'utf8', timeout: 30000 });
check(
  /REFUSED/.test(probe.stdout) && /already owned by live process/.test(probe.stdout),
  'a second live process is refused on the same file',
  probe.stdout + probe.stderr,
);
const distinct = spawnSync(
  process.execPath,
  [holderScript, path.join(path.dirname(sharedFile), 'other-devices.json'), '0'],
  { encoding: 'utf8', timeout: 30000 },
);
check(/ACQUIRED/.test(distinct.stdout), 'a distinct file is never blocked', distinct.stdout + distinct.stderr);
heldRelease();
const afterRelease = spawnSync(process.execPath, [holderScript, sharedFile, '0'], { encoding: 'utf8', timeout: 30000 });
check(/ACQUIRED/.test(afterRelease.stdout), 'the file is reusable after release', afterRelease.stdout + afterRelease.stderr);

// ---------------------------------------------------------------------------
// 6. apply.mjs gates on a disposable fixture plugin
// ---------------------------------------------------------------------------
function buildPlugin(prefix, version = '0.10.3') {
  const root = path.join(tempDir(prefix), 'dsh-plugin-mobile-gateway');
  mkdirSync(path.join(root, 'lib'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'dsh-plugin-mobile-gateway', version,
  }, null, 2)}\n`, 'utf8');
  for (const [relative, fixture] of Object.entries(FIXTURES)) {
    copyFileSync(path.join(fixtureDir, fixture), path.join(root, relative));
  }
  return root;
}

function runApply(args, root) {
  return spawnSync(process.execPath, [applyScript, ...args, `--path=${root}`], {
    encoding: 'utf8', timeout: 60000,
  });
}

// The fixture digests are not the upstream ones, so register them for the gate
// test by pointing apply.mjs at a fixture-backed whitelist is not possible;
// instead assert the gate REFUSES unknown digests, then verify the real
// whitelist path using the pristine upstream files when they are available.
const gatePlugin = buildPlugin('gate-');
const unpatched = runApply(['--check'], gatePlugin);
check(unpatched.status === 1, '--check reports unpatched', unpatched.stdout + unpatched.stderr);

const refusedDigest = runApply(['--apply'], gatePlugin);
check(
  refusedDigest.status === 1 && /no reviewed source variant matches/.test(refusedDigest.stderr),
  '--apply refuses a fixture whose digest is not whitelisted',
  refusedDigest.stdout + refusedDigest.stderr,
);
check(
  !readFileSync(path.join(gatePlugin, 'lib', 'index.mjs'), 'utf8').includes(MARKER),
  'a refused apply writes nothing',
);

const unknownVersion = buildPlugin('unknown-', '9.9.9');
const refusedVersion = runApply(['--apply'], unknownVersion);
check(
  refusedVersion.status === 1 && /not in the reviewed whitelist/.test(refusedVersion.stderr),
  '--apply refuses an unreviewed plugin version',
  refusedVersion.stdout + refusedVersion.stderr,
);

// Real pristine upstream files: the repo's devDependency is pristine by design.
const installedLib = path.join(repo, 'dsh-mobile', 'node_modules', 'dsh-plugin-mobile-gateway', 'lib');
const pristineAvailable = EDITED_FILES.every((relative) => {
  const file = path.join(installedLib, path.basename(relative));
  return existsSync(file) && !readFileSync(file, 'utf8').includes(MARKER);
});

if (pristineAvailable) {
  const realPlugin = path.join(tempDir('real-'), 'dsh-plugin-mobile-gateway');
  mkdirSync(path.join(realPlugin, 'lib'), { recursive: true });
  copyFileSync(
    path.join(repo, 'dsh-mobile', 'node_modules', 'dsh-plugin-mobile-gateway', 'package.json'),
    path.join(realPlugin, 'package.json'),
  );
  for (const relative of EDITED_FILES) {
    copyFileSync(path.join(installedLib, path.basename(relative)), path.join(realPlugin, relative));
  }
  const before = Object.fromEntries(EDITED_FILES.map((r) => [r, sha256(readFileSync(path.join(realPlugin, r), 'utf8'))]));

  const applied = runApply(['--apply'], realPlugin);
  check(applied.status === 0, '--apply succeeds on the reviewed pristine source', applied.stdout + applied.stderr);
  const checked = runApply(['--check'], realPlugin);
  check(checked.status === 0, '--check reports applied', checked.stdout + checked.stderr);
  for (const relative of NEW_FILES) {
    check(existsSync(path.join(realPlugin, relative)), `new module installed: ${relative}`);
  }

  const hashesAfterFirst = Object.fromEntries(EDITED_FILES.map((r) => [r, sha256(readFileSync(path.join(realPlugin, r), 'utf8'))]));
  const again = runApply(['--apply'], realPlugin);
  const hashesAfterSecond = Object.fromEntries(EDITED_FILES.map((r) => [r, sha256(readFileSync(path.join(realPlugin, r), 'utf8'))]));
  check(
    again.status === 0 && EDITED_FILES.every((r) => hashesAfterFirst[r] === hashesAfterSecond[r]),
    '--apply is idempotent',
    again.stdout + again.stderr,
  );

  const reverted = runApply(['--revert'], realPlugin);
  check(
    reverted.status === 0 && EDITED_FILES.every((r) => sha256(readFileSync(path.join(realPlugin, r), 'utf8')) === before[r]),
    '--revert restores every edited file byte-identically',
    reverted.stdout + reverted.stderr,
  );
  check(
    NEW_FILES.every((r) => !existsSync(path.join(realPlugin, r))),
    '--revert removes the added modules',
  );
  check(runApply(['--check'], realPlugin).status === 1, '--check reports unpatched after revert');

  // Composition: management auth first, then home isolation, then revert only
  // home isolation. The authentication patch must survive untouched.
  const composePlugin = path.join(tempDir('compose-'), 'dsh-plugin-mobile-gateway');
  mkdirSync(path.join(composePlugin, 'lib'), { recursive: true });
  copyFileSync(path.join(realPlugin, 'package.json'), path.join(composePlugin, 'package.json'));
  for (const relative of EDITED_FILES) {
    copyFileSync(path.join(installedLib, path.basename(relative)), path.join(composePlugin, relative));
  }
  const indexPath = path.join(composePlugin, 'lib', 'index.mjs');
  writeFileSync(indexPath, patchManagementAuth(readFileSync(indexPath, 'utf8')), 'utf8');
  const mgmtHash = sha256(readFileSync(indexPath, 'utf8'));
  const composeApply = runApply(['--apply'], composePlugin);
  const composeText = readFileSync(indexPath, 'utf8');
  check(
    composeApply.status === 0
      && composeText.includes('DSH_OUTPOST_MGW_AUTH_PATCH')
      && composeText.includes(MARKER),
    'both patches compose on one installation',
    composeApply.stdout + composeApply.stderr,
  );
  runApply(['--revert'], composePlugin);
  const afterComposeRevert = readFileSync(indexPath, 'utf8');
  check(
    sha256(afterComposeRevert) === mgmtHash
      && afterComposeRevert.includes('DSH_OUTPOST_MGW_AUTH_PATCH')
      && !afterComposeRevert.includes(MARKER),
    'reverting home isolation leaves the management-auth patch byte-identical',
  );
} else {
  console.log('  SKIP  real-source apply/revert/composition gates (devDependency is not pristine)');
}

// ---------------------------------------------------------------------------
for (const dir of cleanup) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

console.log(`\nmobile-gateway home-isolation patch: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);