#!/usr/bin/env node
/**
 * Rurea B4 unified normal-process acceptance runner (isolated package only).
 *
 * Supports:
 *   --suite <b2|c1c2c4|c3>   Acceptance suite to build & execute (required)
 *   --serial <adb-serial>    Target adb device/emulator serial (auto if single)
 *   --abi <arm64-v8a|x86_64> Native ABI filter (auto-detected from device)
 *   --port <8787>            Host loopback stub server port
 *   --timeout-ms <180000>    Per-stage report timeout in milliseconds
 *   --skip-build             Reuse existing app-release.apk
 *   --keep-installed         Skip final adb uninstall
 *   --report-out <path>      Write normalized JSON report to path
 *   --dry-run                Print resolved config JSON and exit 0 (no gradle/adb)
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ISOLATED_APP_ID = 'com.dshoutpost.p1.p6next';
const A11Y_COMPONENT = `${ISOLATED_APP_ID}/com.dshpocket.agent.OutpostAccessibilityService`;

const SUITES = {
  b2: {
    name: 'b2',
    entryFile: '../../src/acceptance/entry.tsx',
    stubScript: 'tests/acceptance/stub-model-server.mjs',
    needsAccessibility: true,
    stages: 1,
    defaultTimeoutMs: 150000,
  },
  c1c2c4: {
    name: 'c1c2c4',
    entryFile: '../../src/acceptance/c1c2c4-entry.tsx',
    stubScript: 'tests/acceptance/c1c2c4-stub-server.mjs',
    needsAccessibility: true,
    stages: 1,
    defaultTimeoutMs: 180000,
  },
  c3: {
    name: 'c3',
    entryFile: '../../src/acceptance/c3-persistence-entry.tsx',
    stubScript: 'tests/acceptance/c3-stub-server.mjs',
    needsAccessibility: false,
    stages: 4,
    defaultTimeoutMs: 120000,
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');
const androidDir = path.join(mobileDir, 'android');
const apkPath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

function parseArgs(argv) {
  const opts = {
    suite: '',
    serial: null,
    abi: null,
    port: 8787,
    timeoutMs: null,
    skipBuild: false,
    keepInstalled: false,
    dryRun: false,
    reportOut: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '--suite') opts.suite = next();
    else if (arg === '--serial') opts.serial = next();
    else if (arg === '--abi') opts.abi = next();
    else if (arg === '--port') opts.port = Number(next());
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(next());
    else if (arg === '--skip-build') opts.skipBuild = true;
    else if (arg === '--keep-installed') opts.keepInstalled = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--report-out') opts.reportOut = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const suite = SUITES[opts.suite];
  if (!suite) {
    throw new Error(`Invalid --suite "${opts.suite}". Expected one of: ${Object.keys(SUITES).join(', ')}`);
  }
  if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  return {
    ...opts,
    suiteConfig: suite,
    timeoutMs: opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : suite.defaultTimeoutMs,
  };
}

function resolveJavaHome() {
  if (process.env.JAVA_HOME && existsSync(process.env.JAVA_HOME)) return process.env.JAVA_HOME;
  if (process.platform === 'win32' && existsSync('D:\\Jdk21\\bin\\java.exe')) {
    return 'D:\\Jdk21';
  }
  return process.env.JAVA_HOME || null;
}

function resolveAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [];
  if (process.env.ANDROID_HOME) candidates.push(path.join(process.env.ANDROID_HOME, 'platform-tools', exe));
  if (process.env.ANDROID_SDK_ROOT) candidates.push(path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe));
  const localProps = path.join(androidDir, 'local.properties');
  if (existsSync(localProps)) {
    const raw = readFileSync(localProps, 'utf8');
    const match = raw.match(/^sdk\.dir=(.+)$/m);
    if (match) {
      const sdkDir = match[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':');
      candidates.push(path.join(sdkDir, 'platform-tools', exe));
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return exe;
}

function runAdb(adbCmd, serial, args, opts = {}) {
  const full = serial ? ['-s', serial, ...args] : args;
  return execFileSync(adbCmd, full, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 60000,
    stdio: opts.stdio ?? 'pipe',
    windowsHide: true,
  }).trim();
}

function detectSingleSerial(adbCmd) {
  const out = execFileSync(adbCmd, ['devices'], { encoding: 'utf8', windowsHide: true });
  const online = out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device')
    .map((parts) => parts[0]);
  if (online.length === 0) throw new Error('No online adb device/emulator found');
  if (online.length > 1) {
    throw new Error(`Multiple adb devices found (${online.join(', ')}); pass --serial`);
  }
  return online[0];
}

function buildIsolatedApk(entryFile, abi, javaHome) {
  const isWin = process.platform === 'win32';
  const gradlew = path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew');
  if (!isWin) {
    try {
      execFileSync('chmod', ['+x', gradlew], { stdio: 'ignore' });
    } catch {}
  }
  const args = [
    '--no-daemon',
    '--console=plain',
    ':app:assembleRelease',
    `-PDSH_TEST_APPLICATION_ID=${ISOLATED_APP_ID}`,
    '-PDSH_ALLOW_DEBUG_RELEASE_SIGNING=true',
    `-PDSH_TEST_ENTRY_FILE=${entryFile}`,
    `-PreactNativeArchitectures=${abi}`,
  ];
  const env = javaHome ? { ...process.env, JAVA_HOME: javaHome } : process.env;
  const cmd = isWin ? 'cmd.exe' : gradlew;
  const argv = isWin ? ['/d', '/s', '/c', gradlew, ...args] : args;
  console.log(`[runner] building ${ISOLATED_APP_ID} (${abi}) entry=${entryFile}`);
  execFileSync(cmd, argv, {
    cwd: androidDir,
    env,
    stdio: 'inherit',
    timeout: 900000,
    windowsHide: true,
  });
  if (!existsSync(apkPath)) {
    throw new Error(`Expected built APK missing at ${apkPath}`);
  }
}

function startStubServer(stubRelPath, port) {
  const fullPath = path.join(mobileDir, stubRelPath);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fullPath, String(port)], {
      cwd: mobileDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(child);
    }, 1500);
    child.stdout.on('data', (buf) => {
      const line = buf.toString();
      process.stdout.write(line);
      if (!settled && (line.includes('listening=') || line.includes('stub model on') || line.includes('acceptance server on'))) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (buf) => process.stderr.write(buf));
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.once('exit', (code) => {
      if (!settled && code !== 0) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Stub server exited early with code ${code}`));
      }
    });
  });
}

function httpJson(method, url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollReports(port, expectedCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const data = await httpJson('GET', `http://127.0.0.1:${port}/report`);
      const list = Array.isArray(data) ? data : Array.isArray(data?.reports) ? data.reports : [];
      if (list.length >= expectedCount) return data;
    } catch {}
    await sleep(400);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for report #${expectedCount}`);
}

function appendService(existing, component) {
  const parts = String(existing ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'null');
  if (!parts.includes(component)) parts.push(component);
  return parts.join(':');
}

function evaluateResult(suiteName, data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.reports) ? data.reports : [];
  if (suiteName === 'b2') {
    const report = list[list.length - 1] ?? null;
    const allOk = Boolean(report && report.phase === 'completed' && report.text === 'ACCEPTANCE_DONE');
    return { suite: 'b2', allOk, report };
  }
  if (suiteName === 'c1c2c4') {
    const report = list[list.length - 1] ?? null;
    const allOk = Boolean(report && report.allOk === true && report.passed === report.total);
    return { suite: 'c1c2c4', allOk, report };
  }
  const stages = list.slice(0, 4);
  const passedStages = stages.filter((s) => s?.ok === true).length;
  const allOk = stages.length === 4 && passedStages === 4;
  return {
    suite: 'c3',
    generatedAt: new Date().toISOString(),
    passedStages,
    totalStages: 4,
    allOk,
    stages,
    trace: data?.trace ?? [],
  };
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const resolvedEntryPath = path.resolve(androidDir, 'app', cfg.suiteConfig.entryFile);
  const resolvedStubPath = path.resolve(mobileDir, cfg.suiteConfig.stubScript);

  if (!existsSync(resolvedEntryPath)) {
    throw new Error(`Missing acceptance entry file: ${resolvedEntryPath}`);
  }
  if (!existsSync(resolvedStubPath)) {
    throw new Error(`Missing acceptance stub script: ${resolvedStubPath}`);
  }

  const javaHome = resolveJavaHome();
  const drySummary = {
    suite: cfg.suite,
    applicationId: ISOLATED_APP_ID,
    entryFile: cfg.suiteConfig.entryFile,
    resolvedEntryExists: true,
    stubScript: cfg.suiteConfig.stubScript,
    resolvedStubExists: true,
    needsAccessibility: cfg.suiteConfig.needsAccessibility,
    stages: cfg.suiteConfig.stages,
    port: cfg.port,
    abi: cfg.abi ?? 'auto',
    skipBuild: cfg.skipBuild,
    keepInstalled: cfg.keepInstalled,
    reportOut: cfg.reportOut,
  };

  if (cfg.dryRun) {
    console.log(JSON.stringify(drySummary, null, 2));
    return;
  }

  const adb = resolveAdb();
  const serial = cfg.serial || detectSingleSerial(adb);
  const abi = cfg.abi || runAdb(adb, serial, ['shell', 'getprop', 'ro.product.cpu.abi']) || 'arm64-v8a';

  if (!cfg.skipBuild) {
    buildIsolatedApk(cfg.suiteConfig.entryFile, abi, javaHome);
  } else if (!existsSync(apkPath)) {
    throw new Error(`--skip-build specified, but APK not found: ${apkPath}`);
  }

  let priorServices = null;
  let priorEnabled = null;
  let stubChild = null;
  let finalResult = null;

  try {
    if (cfg.suiteConfig.needsAccessibility) {
      priorServices = runAdb(adb, serial, ['shell', 'settings', 'get', 'secure', 'enabled_accessibility_services']);
      priorEnabled = runAdb(adb, serial, ['shell', 'settings', 'get', 'secure', 'accessibility_enabled']);
      console.log(`[runner] saved prior a11y services="${priorServices}" enabled="${priorEnabled}"`);
    }

    // Uninstall first so isolated filesDir starts clean.
    try {
      runAdb(adb, serial, ['uninstall', ISOLATED_APP_ID], { timeout: 30000 });
    } catch {}
    console.log(`[runner] installing ${apkPath} on ${serial}`);
    runAdb(adb, serial, ['install', '-r', apkPath], { timeout: 120000 });

    stubChild = await startStubServer(cfg.suiteConfig.stubScript, cfg.port);
    try {
      await httpJson('POST', `http://127.0.0.1:${cfg.port}/reset`);
    } catch {}

    let latestData = null;
    for (let stage = 1; stage <= cfg.suiteConfig.stages; stage += 1) {
      if (stage > 1) {
        console.log(`[runner] cold restart -> stage ${stage}/${cfg.suiteConfig.stages}`);
        runAdb(adb, serial, ['shell', 'am', 'force-stop', ISOLATED_APP_ID]);
        await sleep(800);
      }
      runAdb(adb, serial, ['reverse', `tcp:${cfg.port}`, `tcp:${cfg.port}`]);
      runAdb(adb, serial, ['shell', 'monkey', '-p', ISOLATED_APP_ID, '-c', 'android.intent.category.LAUNCHER', '1']);

      if (cfg.suiteConfig.needsAccessibility && stage === 1) {
        await sleep(1500);
        const merged = appendService(priorServices, A11Y_COMPONENT);
        runAdb(adb, serial, ['shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', merged]);
        runAdb(adb, serial, ['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '0']);
        await sleep(300);
        runAdb(adb, serial, ['shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1']);
      }

      latestData = await pollReports(cfg.port, stage, cfg.timeoutMs);
    }

    finalResult = evaluateResult(cfg.suite, latestData);
    if (cfg.reportOut) {
      const targetOut = path.resolve(mobileDir, cfg.reportOut);
      mkdirSync(path.dirname(targetOut), { recursive: true });
      writeFileSync(targetOut, `${JSON.stringify(finalResult, null, 2)}\n`, 'utf8');
      console.log(`[runner] wrote report to ${targetOut}`);
    }
    console.log(JSON.stringify(finalResult, null, 2));
    if (!finalResult.allOk) {
      process.exitCode = 1;
    }
  } finally {
    if (cfg.suiteConfig.needsAccessibility && priorServices !== null) {
      try {
        if (!priorServices || priorServices === 'null') {
          runAdb(adb, serial, ['shell', 'settings', 'delete', 'secure', 'enabled_accessibility_services']);
        } else {
          runAdb(adb, serial, ['shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', priorServices]);
        }
        if (priorEnabled && priorEnabled !== 'null') {
          runAdb(adb, serial, ['shell', 'settings', 'put', 'secure', 'accessibility_enabled', priorEnabled]);
        }
      } catch (restoreErr) {
        console.error('[runner] warning: failed restoring accessibility settings:', restoreErr);
      }
    }
    try {
      runAdb(adb, serial, ['reverse', '--remove', `tcp:${cfg.port}`]);
    } catch {}
    try {
      runAdb(adb, serial, ['shell', 'am', 'force-stop', ISOLATED_APP_ID]);
    } catch {}
    if (!cfg.keepInstalled) {
      try {
        runAdb(adb, serial, ['uninstall', ISOLATED_APP_ID], { timeout: 30000 });
      } catch {}
    }
    if (stubChild && !stubChild.killed) {
      stubChild.kill();
    }
  }
}

main().catch((err) => {
  console.error('[runner] FAILED:', err?.stack || err);
  process.exit(1);
});
