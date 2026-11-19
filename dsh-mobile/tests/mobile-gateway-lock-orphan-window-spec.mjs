// P4-0.3 锁竞态修复（05 发现）确定性失败测试。
//
// 强制 CI 暴露的三进程交错的两个洞，单进程可复现：
//  B：grave 里躺着活记录且无 marker 时，fresh-create 不得认领空占位（fail-closed）。
//  A：mis-take 归还 linkSync 失败（锁路径被空占位占据）时，throw 之余必须保留
//     活 pid marker 守卫窗口，grave 保留被顶替的活记录（finally 不得清 marker）。
//  契约：死 reclaimer 的活孤儿仍按既有规程恢复并拒启（回归 pin，修前亦绿）。
//
// A 用 fs.renameSync 边界注入强制「take 之后活记录出现在 lockPath」的罕见交错
// （与 RuntimeInstallerChecks 的 checkpoint 注入同一哲学：注入边界，不_mock 验收）。
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.join(__dirname, '..', '..', 'patches', 'mobile-gateway-home-isolation', 'files', 'registry-lock.js');
const { acquireRegistryLock, LOCK_SUFFIX } = require(modulePath);

const deadPid = () => spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid;
const rec = (pid, token) => ({ version: 1, pid, token, label: 'device registry', file: 'devices.json', createdAt: new Date().toISOString() });
const writeRec = (p, r) => fs.writeFileSync(p, JSON.stringify(r, null, 2) + '\n');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-orphan-window-'));
const sidecars = (lock, prefix) => fs.readdirSync(path.dirname(lock))
  .filter((n) => n.startsWith(path.basename(lock) + prefix))
  .map((n) => path.join(path.dirname(lock), n));

test('B: fresh create refuses while a grave holds a live record and no marker guards it', () => {
  const d = tmp();
  const file = path.join(d, 'devices.json');
  const lock = file + LOCK_SUFFIX;
  const grave = lock + '.reclaim.orphanlive';
  writeRec(grave, rec(process.pid, 'live-orphan-token'));
  assert.throws(() => acquireRegistryLock(file, 'device registry'), /refusing to start/);
  assert.ok(fs.existsSync(grave), 'grave preserved for manual recovery');
  assert.ok(!fs.existsSync(lock), 'must not claim over a displaced live owner');
});

test('A: mis-take restore failure preserves the live marker and the taken live record', () => {
  const d = tmp();
  const file = path.join(d, 'devices.json');
  const lock = file + LOCK_SUFFIX;
  writeRec(lock, rec(deadPid(), 'stale-token'));
  const realRename = fs.renameSync;
  let fired = false;
  fs.renameSync = (src, dst) => {
    realRename(src, dst);
    if (!fired && src === lock) {
      fired = true;
      // 强制罕见交错：take 走之后，活记录既在 grave 也被「新创建者」占位堵在 lockPath。
      writeRec(dst, rec(process.pid, 'displaced-live'));
      writeRec(lock, rec(process.pid, 'displaced-live'));
    }
  };
  try {
    assert.throws(() => acquireRegistryLock(file, 'device registry'), /concurrent reclaim changed the lock/);
  } finally {
    fs.renameSync = realRename;
  }
  const markers = sidecars(lock, '.reclaiming.');
  assert.equal(markers.length, 1, 'marker must survive a failed restore to guard the window');
  assert.equal(JSON.parse(fs.readFileSync(markers[0], 'utf8')).pid, process.pid);
  const graves = sidecars(lock, '.reclaim.');
  assert.equal(graves.length, 1, 'taken live record preserved');
  assert.equal(JSON.parse(fs.readFileSync(graves[0], 'utf8')).token, 'displaced-live');
  for (const p of [...markers, ...graves, lock]) { try { fs.unlinkSync(p); } catch { /* cleanup */ } }
});

test('contract: dead reclaimer orphaning a live record is restored and start refused', () => {
  const d = tmp();
  const file = path.join(d, 'devices.json');
  const lock = file + LOCK_SUFFIX;
  writeRec(lock + '.reclaiming.deadone', rec(deadPid(), 'mtoken'));
  writeRec(lock + '.reclaim.mtoken', rec(process.pid, 'live-owner'));
  assert.throws(() => acquireRegistryLock(file, 'device registry'), /refusing to start/);
  assert.ok(fs.existsSync(lock), 'orphan restored to the lock path');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live-owner');
  assert.equal(sidecars(lock, '.reclaim.').length, 0);
  assert.equal(sidecars(lock, '.reclaiming.').length, 0);
});
