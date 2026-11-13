// Child worker for the registry-lock concurrency regression.
// Modes:
//   race   <module> <lockFile> <barrier> <out> <holdMs>  barrier-synchronized acquire
//   hold   <module> <lockFile> <out>                     acquire, report, stay alive until killed
//   exit   <module> <lockFile> <out>                     acquire then exit normally (release on exit)
//   release-after-overwrite <module> <lockFile> <out> <signalFile>
//          acquire, wait until the parent replaces the lock record, then release()
//   probe  <module> <lockFile> <out>                     try to acquire while another owner lives
'use strict';
const fs = require('node:fs');
const { acquireRegistryLock } = require(process.argv[2]);

const mode = process.argv[3];
const lockFile = process.argv[4];
const outFile = process.argv[5];

function report(line) { fs.appendFileSync(outFile, line + '\n'); }
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function waitForFile(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(p) && Date.now() < deadline) wait(10);
  return fs.existsSync(p);
}

if (mode === 'race') {
  const barrier = process.argv[6];
  const holdMs = Number(process.argv[7] ?? 400);
  // tell the parent we are ready, then wait for the shared start barrier
  fs.appendFileSync(outFile, `READY ${process.pid}\n`);
  waitForFile(barrier, 15000);
  let release;
  try {
    release = acquireRegistryLock(lockFile, 'race repro');
  } catch (error) {
    report(`REFUSED ${process.pid} ${String(error.message).split('\n')[0].slice(0, 160)}`);
    process.exit(0);
  }
  report(`ACQUIRED ${process.pid}`);
  wait(holdMs);
  try {
    const owner = JSON.parse(fs.readFileSync(lockFile + '.lock', 'utf8'));
    report(`STILLOWNS ${process.pid} ${owner.pid === process.pid ? 'yes' : 'NO token=' + owner.token}`);
  } catch {
    report(`STILLOWNS ${process.pid} NO unreadable`);
  }
  release();
  report(`RELEASED ${process.pid}`);
  process.exit(0);
}

if (mode === 'hold' || mode === 'exit') {
  let release;
  try {
    release = acquireRegistryLock(lockFile, 'hold');
  } catch (error) {
    report(`REFUSED ${process.pid} ${String(error.message).split('\n')[0].slice(0, 160)}`);
    process.exit(0);
  }
  report(`ACQUIRED ${process.pid}`);
  if (mode === 'exit') { release(); process.exit(0); }
  // stay alive until the parent kills us (crash simulation)
  waitForFile(lockFile + '.stop', 30000);
  process.exit(0);
}

if (mode === 'release-after-overwrite') {
  const signal = process.argv[6];
  let release;
  try {
    release = acquireRegistryLock(lockFile, 'old holder');
  } catch (error) {
    report(`REFUSED ${process.pid}`);
    process.exit(0);
  }
  report(`ACQUIRED ${process.pid}`);
  waitForFile(signal, 15000);
  release();
  report(`RELEASED ${process.pid}`);
  process.exit(0);
}

if (mode === 'probe') {
  try {
    const release = acquireRegistryLock(lockFile, 'probe');
    report(`ACQUIRED ${process.pid}`);
    release();
  } catch (error) {
    report(`REFUSED ${process.pid} ${String(error.message).split('\n')[0].slice(0, 160)}`);
  }
  process.exit(0);
}

report(`UNKNOWN_MODE ${mode}`);
process.exit(2);