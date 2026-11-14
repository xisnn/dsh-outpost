// P4-0.1 P0-1 / P4-0.2 formal regression: registry-lock cross-process exclusivity.
//
// Covers the stale-reclaim TOCTOU fixed in P4-0.1, the reclaim-ticket TOCTOU
// fixed in P4-0.2 (atomic take-away + exclusive create replace the racy ticket),
// plus the ownership contract: crash recovery, normal-exit release, non-owner
// release refusal, an old holder never deleting a new holder's lock,
// corrupted/unreadable state failing closed, crashed-reclaim recovery, and
// single-owner revocation safety.
//
// The multi-process stress races are the independent reproductions of the P4-0
// and P4-0.1 defects: on the vulnerable modules they report double ownership
// (RED); on the fixed module exactly one racer wins every round (GREEN).
//
// Env:
//   P4_LOCK_MODULE        module under test (default: the controlled patch payload)
//   P4_LOCK_RACE_ROUNDS   stress rounds (default 12; use 25 for RED/GREEN capture)
//   P4_LOCK_TICKET_ROUNDS reclaim-ticket TOCTOU rounds (default 15)
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const modulePath = process.env.P4_LOCK_MODULE
  ? path.resolve(process.env.P4_LOCK_MODULE)
  : path.join(repoRoot, '..', 'patches', 'mobile-gateway-home-isolation', 'files', 'registry-lock.js');
const child = path.join(__dirname, 'helpers', 'lock-race-child.cjs');
const rounds = Number(process.env.P4_LOCK_RACE_ROUNDS ?? 12);
const racers = 4;

let passed = 0;
let failed = 0;
function ok(name) { passed += 1; console.log(`  OK    ${name}`); }
function bad(name, detail) { failed += 1; console.log(`  FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
function check(cond, name, detail) { cond ? ok(name) : bad(name, detail); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgw-lock-race-'));
function tempDir(prefix) {
  const d = path.join(root, prefix + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function sleep(ms) { spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${ms})`], { stdio: 'ignore' }); }
function deadPid() { return spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' }).pid; }
function readOut(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
function waitExit(kids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (kids.some((k) => k.exitCode === null) && Date.now() < deadline) sleep(40);
  for (const k of kids) if (k.exitCode === null) k.kill('SIGKILL');
}
function staleLock(lockFile, token) {
  fs.writeFileSync(lockFile + '.lock', JSON.stringify({
    version: 1, pid: deadPid(), token, label: 'device registry', file: lockFile,
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
}

console.log('mobile-gateway registry-lock concurrency regression (P4-0.1 P0-1 / P4-0.2)');
console.log(`module under test: ${modulePath}`);

// ── 1. crash recovery: SIGKILL leaves a dead-owner lock that is reclaimed ──
{
  const d = tempDir('crash-');
  const lockFile = path.join(d, 'devices.json');
  const out = path.join(d, 'out.txt');
  const kid = spawn(process.execPath, [child, modulePath, 'hold', lockFile, out], { stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (!/ACQUIRED/.test(readOut(out)) && Date.now() < deadline) sleep(40);
  check(/ACQUIRED/.test(readOut(out)), 'crash: child acquires before being killed');
  kid.kill('SIGKILL');
  waitExit([kid], 8000);
  check(fs.existsSync(lockFile + '.lock'), 'crash: SIGKILL leaves the lock behind');
  const owner = JSON.parse(fs.readFileSync(lockFile + '.lock', 'utf8'));
  check(owner.pid === kid.pid, 'crash: leftover lock names the dead child');
  const { acquireRegistryLock } = require(modulePath);
  let rel;
  try {
    rel = acquireRegistryLock(lockFile, 'device registry');
    ok('crash: dead-owner lock is reclaimed by the next start');
  } catch (e) { bad('crash: dead-owner lock is reclaimed by the next start', e.message); }
  if (rel) rel();
  check(!fs.existsSync(lockFile + '.lock'), 'crash: reclaiming owner releases cleanly');
}

// ── 2. normal exit releases the lock ──
{
  const d = tempDir('exit-');
  const lockFile = path.join(d, 'devices.json');
  const out = path.join(d, 'out.txt');
  const kid = spawn(process.execPath, [child, modulePath, 'exit', lockFile, out], { stdio: 'ignore' });
  waitExit([kid], 15000);
  check(/ACQUIRED/.test(readOut(out)), 'exit: child acquired');
  check(!fs.existsSync(lockFile + '.lock'), 'exit: normal exit removes the lock');
}

// ── 3. a live owner blocks a second process; the lock is untouched ──
{
  const d = tempDir('live-');
  const lockFile = path.join(d, 'devices.json');
  const outA = path.join(d, 'a.txt');
  const outB = path.join(d, 'b.txt');
  const a = spawn(process.execPath, [child, modulePath, 'hold', lockFile, outA], { stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (!/ACQUIRED/.test(readOut(outA)) && Date.now() < deadline) sleep(40);
  const before = fs.readFileSync(lockFile + '.lock', 'utf8');
  const b = spawn(process.execPath, [child, modulePath, 'probe', lockFile, outB], { stdio: 'ignore' });
  waitExit([b], 15000);
  check(/REFUSED/.test(readOut(outB)), 'live owner: second process is refused');
  check(fs.readFileSync(lockFile + '.lock', 'utf8') === before, 'live owner: refusal leaves the lock byte-identical');
  a.kill('SIGKILL');
  waitExit([a], 8000);
}

// ── 4. an old holder must never delete a new holder's lock ──
{
  const d = tempDir('oldnew-');
  const lockFile = path.join(d, 'devices.json');
  const out = path.join(d, 'out.txt');
  const signal = path.join(d, 'overwritten');
  const a = spawn(process.execPath, [child, modulePath, 'release-after-overwrite', lockFile, out, signal], { stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (!/ACQUIRED/.test(readOut(out)) && Date.now() < deadline) sleep(40);
  // simulate a new legitimate owner taking the file while the old closure lives
  fs.writeFileSync(lockFile + '.lock', JSON.stringify({
    version: 1, pid: process.pid, token: 'new-owner-token', label: 'device registry',
    file: lockFile, createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  fs.writeFileSync(signal, 'go');
  waitExit([a], 15000);
  check(/RELEASED/.test(readOut(out)), 'old holder: release() ran');
  const still = fs.existsSync(lockFile + '.lock');
  check(still, 'old holder: release() did NOT delete the new holder lock');
  if (still) {
    const rec = JSON.parse(fs.readFileSync(lockFile + '.lock', 'utf8'));
    check(rec.token === 'new-owner-token', 'old holder: new holder record intact');
  }
}

// ── 5. corrupted / unreadable lock fails closed and is not overwritten ──
{
  const d = tempDir('corrupt-');
  const lockFile = path.join(d, 'devices.json');
  fs.writeFileSync(lockFile + '.lock', '{ not json', 'utf8');
  const { acquireRegistryLock } = require(modulePath);
  let threw = false;
  try { acquireRegistryLock(lockFile, 'device registry'); } catch { threw = true; }
  check(threw, 'corrupt: malformed lock fails closed');
  check(fs.readFileSync(lockFile + '.lock', 'utf8') === '{ not json', 'corrupt: malformed lock not overwritten');
}
{
  const d = tempDir('isdir-');
  const lockFile = path.join(d, 'devices.json');
  fs.mkdirSync(lockFile + '.lock'); // a directory where the lock should be: unreadable as a record
  const { acquireRegistryLock } = require(modulePath);
  let threw = false;
  let msg = '';
  try { acquireRegistryLock(lockFile, 'device registry'); } catch (e) { threw = true; msg = e.message; }
  check(threw, 'unreadable: lock path occupied by a directory fails closed');
  check(/refusing|unreadable|cannot/i.test(msg), 'unreadable: error explains the refusal', msg);
  check(fs.statSync(lockFile + '.lock').isDirectory(), 'unreadable: foreign object left untouched');
}

// ── 6. reclaim handoff (P4-0.2): no racy ticket; atomic take-away + publish ──
// The P4-0.1 reclaim ticket was removed: ownership is now arbitrated solely by
// the atomic exclusive create, and a dead lock is taken away by atomic rename.
// These tests pin the new contract and old-user compatibility (an inert ticket
// left by a previous version must not block reclaim).
{
  const d = tempDir('ticket-inert-');
  const lockFile = path.join(d, 'devices.json');
  staleLock(lockFile, 'stale-ticket-inert');
  // A leftover OLD-format reclaim ticket from a previous version is inert: the
  // new module ignores it and still reclaims the dead owner.
  fs.writeFileSync(lockFile + '.lock.reclaim.stale-ticket-inert', JSON.stringify({
    kind: 'reclaim-ticket', version: 1, pid: deadPid(), token: 'dead-reclaimer',
    staleToken: 'stale-ticket-inert', createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  const { acquireRegistryLock } = require(modulePath);
  let rel;
  try { rel = acquireRegistryLock(lockFile, 'device registry'); ok('handoff: inert old-format ticket does not block reclaim'); }
  catch (e) { bad('handoff: inert old-format ticket does not block reclaim', e.message); }
  if (rel) rel();
}
{
  // A crashed reclaimer leaves a dead marker + a grave holding a dead record,
  // with the lock path absent. The next start recovers them and acquires.
  const d = tempDir('crashed-reclaim-');
  const lockFile = path.join(d, 'devices.json');
  const graveToken = 'crashed-reclaimer-token';
  fs.writeFileSync(lockFile + '.lock.reclaiming.' + graveToken, JSON.stringify({
    version: 1, pid: deadPid(), token: graveToken, staleToken: 'gone', createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  fs.writeFileSync(lockFile + '.lock.reclaim.' + graveToken, JSON.stringify({
    version: 1, pid: deadPid(), token: 'gone', label: 'device registry', file: lockFile,
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  const { acquireRegistryLock } = require(modulePath);
  let rel;
  try { rel = acquireRegistryLock(lockFile, 'device registry'); ok('handoff: crashed reclaimer marker/grave recovered'); }
  catch (e) { bad('handoff: crashed reclaimer marker/grave recovered', e.message); }
  if (rel) rel();
  check(!fs.existsSync(lockFile + '.lock.reclaiming.' + graveToken), 'handoff: dead reclaim marker cleaned up');
}
{
  // A crashed reclaimer that took a LIVE owner's record and died before
  // restoring it leaves an orphaned live record in a dead grave. The next start
  // must restore that live owner and refuse to displace it (fail closed).
  const d = tempDir('orphan-live-');
  const lockFile = path.join(d, 'devices.json');
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  const graveToken = 'crashed-orphan-token';
  fs.writeFileSync(lockFile + '.lock.reclaiming.' + graveToken, JSON.stringify({
    version: 1, pid: deadPid(), token: graveToken, staleToken: 'orphan', createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  fs.writeFileSync(lockFile + '.lock.reclaim.' + graveToken, JSON.stringify({
    version: 1, pid: live.pid, token: 'orphan', label: 'device registry', file: lockFile,
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  const { acquireRegistryLock } = require(modulePath);
  let threw = false;
  try { acquireRegistryLock(lockFile, 'device registry'); } catch { threw = true; }
  check(threw, 'handoff: orphaned live owner is restored, start refused');
  let restoredPid = null;
  try { restoredPid = JSON.parse(fs.readFileSync(lockFile + '.lock', 'utf8')).pid; } catch { /* absent */ }
  check(restoredPid === live.pid, 'handoff: orphaned live record put back at the lock path', `pid=${restoredPid}`);
  live.kill();
}

// ── 7. shared registry never yields two live owners (revocation safety) ──
{
  const d = tempDir('two-');
  const lockFile = path.join(d, 'devices.json');
  const outA = path.join(d, 'a.txt');
  const outB = path.join(d, 'b.txt');
  const a = spawn(process.execPath, [child, modulePath, 'hold', lockFile, outA], { stdio: 'ignore' });
  const b = spawn(process.execPath, [child, modulePath, 'hold', lockFile, outB], { stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while ((!/ACQUIRED|REFUSED/.test(readOut(outA)) || !/ACQUIRED|REFUSED/.test(readOut(outB))) && Date.now() < deadline) sleep(40);
  const acq = [readOut(outA), readOut(outB)].filter((t) => /ACQUIRED/.test(t)).length;
  check(acq === 1, 'two live processes on one registry: exactly one owner', `acquired=${acq}`);
  a.kill('SIGKILL'); b.kill('SIGKILL');
  waitExit([a, b], 8000);
}

// ── 8. independent stale-reclaim race reproduction (stress) ──
let violations = 0;
for (let round = 1; round <= rounds; round += 1) {
  const d = tempDir(`race${round}-`);
  const lockFile = path.join(d, 'devices.json');
  const barrier = path.join(d, 'go');
  const out = path.join(d, 'results.txt');
  staleLock(lockFile, `stale-${round}`);
  const kids = [];
  for (let i = 0; i < racers; i += 1) {
    kids.push(spawn(process.execPath, [child, modulePath, 'race', lockFile, out, barrier, '400'], { stdio: 'ignore' }));
  }
  // wait until every racer reports READY, then release them together
  const deadline = Date.now() + 20000;
  while ((readOut(out).match(/^READY /gm) || []).length < racers && Date.now() < deadline) sleep(30);
  fs.writeFileSync(barrier, 'go');
  waitExit(kids, 20000);
  const text = readOut(out);
  const acquired = (text.match(/^ACQUIRED /gm) || []).length;
  const lost = (text.match(/^STILLOWNS \d+ NO/gm) || []).length;
  if (acquired > 1 || lost > 0) {
    violations += 1;
    console.log(`  race round ${round}: VIOLATION acquired=${acquired} lost=${lost}`);
    console.log(text.split('\n').filter(Boolean).map((l) => '      ' + l).join('\n'));
  }
}
check(violations === 0, `stress race: ${rounds} rounds x ${racers} racers, no double ownership`, `violations=${violations}`);

// ── 9. P4-0.2 reclaim-ticket TOCTOU regression ──
// Plant a dead owner AND a dead reclaim ticket (the P4-0.1 trigger), then race.
// On the P4-0.1 module two racers both judge the ticket dead, one deletes the
// other's live ticket, and both publish (RED). On the P4-0.2 module there is no
// ticket: the atomic take-away + exclusive create yield exactly one owner.
{
  const ticketRounds = Number(process.env.P4_LOCK_TICKET_ROUNDS ?? 15);
  let ticketViolations = 0;
  for (let round = 1; round <= ticketRounds; round += 1) {
    const d = tempDir(`ticket-race${round}-`);
    const lockFile = path.join(d, 'devices.json');
    const barrier = path.join(d, 'go');
    const out = path.join(d, 'results.txt');
    const staleToken = `stale-ticket-${round}`;
    staleLock(lockFile, staleToken);
    fs.writeFileSync(lockFile + '.lock.reclaim.' + staleToken, JSON.stringify({
      kind: 'reclaim-ticket', version: 1, pid: deadPid(), token: `dead-reclaimer-${round}`,
      staleToken, createdAt: new Date().toISOString(),
    }, null, 2) + '\n');
    const kids = [];
    for (let i = 0; i < racers; i += 1) {
      kids.push(spawn(process.execPath, [child, modulePath, 'race', lockFile, out, barrier, '400'], { stdio: 'ignore' }));
    }
    const deadline = Date.now() + 20000;
    while ((readOut(out).match(/^READY /gm) || []).length < racers && Date.now() < deadline) sleep(30);
    fs.writeFileSync(barrier, 'go');
    waitExit(kids, 20000);
    const text = readOut(out);
    const acquired = (text.match(/^ACQUIRED /gm) || []).length;
    const lost = (text.match(/^STILLOWNS \d+ NO/gm) || []).length;
    if (acquired > 1 || lost > 0) {
      ticketViolations += 1;
      console.log(`  ticket-race round ${round}: VIOLATION acquired=${acquired} lost=${lost}`);
      console.log(text.split('\n').filter(Boolean).map((l) => '      ' + l).join('\n'));
    }
  }
  check(ticketViolations === 0, `reclaim-ticket TOCTOU: ${ticketRounds} rounds x ${racers} racers, exactly one owner`, `violations=${ticketViolations}`);
}

// ── 10. orphan-restore strict fail-closed (P4-0.2 supplemental) ──
// A crashed reclaimer's marker/grave must never let a new owner silently take
// the file when a live owner cannot be proven absent. Unreadable/corrupt marker
// or grave => refuse AND preserve the diagnostic. Inert debris => clean + allow.
{
  const { acquireRegistryLock } = require(modulePath);
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], { stdio: 'ignore' });
  const graveRec = (pid, token) => JSON.stringify({
    version: 1, pid, token, label: 'device registry', createdAt: new Date().toISOString(),
  }, null, 2) + '\n';

  // A: corrupt marker, grave holds a LIVE orphan -> refuse, preserve marker+grave.
  {
    const d = tempDir('orphan-corrupt-marker-');
    const lockFile = path.join(d, 'devices.json');
    const lp = lockFile + '.lock';
    const tok = 'orphan-A';
    fs.writeFileSync(lp + '.reclaiming.' + tok, '{ corrupt marker');
    fs.writeFileSync(lp + '.reclaim.' + tok, graveRec(live.pid, 'orphan-A'));
    let threw = false;
    try { acquireRegistryLock(lockFile, 'device registry'); } catch { threw = true; }
    check(threw, 'orphan: corrupt marker fails closed (live orphan unverifiable)');
    check(fs.existsSync(lp + '.reclaiming.' + tok), 'orphan: corrupt marker preserved for manual recovery');
    check(fs.existsSync(lp + '.reclaim.' + tok), 'orphan: live orphan grave preserved');
  }
  // B: dead marker, corrupt grave -> refuse (cannot prove inert), preserve grave.
  {
    const d = tempDir('orphan-corrupt-grave-');
    const lockFile = path.join(d, 'devices.json');
    const lp = lockFile + '.lock';
    const tok = 'orphan-B';
    fs.writeFileSync(lp + '.reclaiming.' + tok, graveRec(deadPid(), tok));
    fs.writeFileSync(lp + '.reclaim.' + tok, '{ corrupt grave');
    let threw = false;
    try { acquireRegistryLock(lockFile, 'device registry'); } catch { threw = true; }
    check(threw, 'orphan: corrupt grave fails closed (cannot prove inert)');
    check(fs.existsSync(lp + '.reclaim.' + tok), 'orphan: corrupt grave preserved for manual recovery');
  }
  // C: dead marker, grave holds a LIVE orphan -> refuse (detected orphan).
  {
    const d = tempDir('orphan-live-');
    const lockFile = path.join(d, 'devices.json');
    const lp = lockFile + '.lock';
    const tok = 'orphan-C';
    fs.writeFileSync(lp + '.reclaiming.' + tok, graveRec(deadPid(), tok));
    fs.writeFileSync(lp + '.reclaim.' + tok, graveRec(live.pid, 'orphan-C'));
    let threw = false;
    try { acquireRegistryLock(lockFile, 'device registry'); } catch { threw = true; }
    check(threw, 'orphan: detected live orphan fails closed');
  }
  // D: dead marker, grave holds a DEAD record -> inert, clean and allow.
  {
    const d = tempDir('orphan-inert-dead-');
    const lockFile = path.join(d, 'devices.json');
    const lp = lockFile + '.lock';
    const tok = 'orphan-D';
    fs.writeFileSync(lp + '.reclaiming.' + tok, graveRec(deadPid(), tok));
    fs.writeFileSync(lp + '.reclaim.' + tok, graveRec(deadPid(), 'orphan-D'));
    let rel;
    try { rel = acquireRegistryLock(lockFile, 'device registry'); ok('orphan: inert dead grave cleaned and acquisition allowed'); }
    catch (e) { bad('orphan: inert dead grave cleaned and acquisition allowed', e.message); }
    if (rel) rel();
    check(!fs.existsSync(lp + '.reclaiming.' + tok) && !fs.existsSync(lp + '.reclaim.' + tok), 'orphan: inert marker/grave removed');
  }
  // E: dead marker, no grave (crashed before take) -> inert marker, clean + allow.
  {
    const d = tempDir('orphan-inert-nograve-');
    const lockFile = path.join(d, 'devices.json');
    const lp = lockFile + '.lock';
    const tok = 'orphan-E';
    fs.writeFileSync(lp + '.reclaiming.' + tok, graveRec(deadPid(), tok));
    let rel;
    try { rel = acquireRegistryLock(lockFile, 'device registry'); ok('orphan: marker without grave cleaned and acquisition allowed'); }
    catch (e) { bad('orphan: marker without grave cleaned and acquisition allowed', e.message); }
    if (rel) rel();
    check(!fs.existsSync(lp + '.reclaiming.' + tok), 'orphan: inert marker removed');
  }
  live.kill();
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nmobile-gateway lock concurrency: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);