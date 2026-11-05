// Mock-only installer acceptance. Never invokes a real DSH CLI or starts a service.
// Set BUTLER_INSTALLER_TEST_ROOT to retain fixtures and logs as local evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findPowerShell, writePowerShellScript } from './support/powershell.mjs';

const repo = path.resolve(import.meta.dirname, '../..');
const ps = findPowerShell();
assert.ok(ps.ok, ps.reason);
const evidence = process.env.BUTLER_INSTALLER_TEST_ROOT;
if (evidence) fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(path.join(evidence || os.tmpdir(), 'butler-mock-'));
const fixture = path.join(root, 'checkout with spaces');
fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'dsh-outpost-butler'));
for (const file of ['setup-butler.ps1', 'start-dsh-web.ps1', 'scripts/butler-installer.ps1', 'scripts/gateway-patch-gate.ps1']) {
  fs.copyFileSync(path.join(repo, file), path.join(fixture, file));
}
const bundlePkg = path.join(fixture, 'dsh-outpost-butler/package.json');
const bundle = '@local/dsh-outpost-butler';
const setBundleVersion = (version) => fs.writeFileSync(bundlePkg, JSON.stringify({ name: bundle, version }));
setBundleVersion('1.0.0');
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const fakeJs = path.join(root, 'fake-cli.cjs');
fs.writeFileSync(fakeJs, `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
if (!profile || !process.env.DSH_HOME || !process.env.DSH_HOME.startsWith(${JSON.stringify(root)})) process.exit(90);
const dir = path.join(process.env.DSH_HOME, 'profiles', profile);
const manifest = path.join(dir, 'package.json');
fs.appendFileSync(process.env.MOCK_CALLS, JSON.stringify({args, home: process.env.DSH_HOME}) + '\\n');
if (args[0] === 'plugin' && args[3] === 'add') {
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\\uFEFF/, ''));
  if (!args[4].endsWith('.tgz')) throw new Error('Installer must use an archive, never a source-directory link');
  const local = JSON.parse(require('node:child_process').execFileSync('tar', ['-xOf', path.basename(args[4]), 'package/package.json'], {encoding: 'utf8', cwd: path.dirname(args[4])}));
  pkg.dependencies = {...pkg.dependencies, [local.name]: 'file:' + args[4]};
  fs.writeFileSync(manifest, JSON.stringify(pkg));
  for (const file of ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml']) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, 'mock changed ' + file);
  }
  const installed = path.join(dir, 'node_modules/@local/dsh-outpost-butler');
  fs.mkdirSync(installed, {recursive: true});
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({...local, name: process.env.MOCK_MODE === 'bad-package' ? 'wrong' : local.name}));
  fs.writeFileSync(path.join(dir, 'node_modules/dependency-mutated'), 'cannot roll back all dependencies');
  if (process.env.MOCK_MODE === 'add-fail') { console.error('mock add failed'); process.exit(7); }
  console.log('mock installed ' + local.version);
} else if (args[0] === 'plugin' && args[3] === 'remove') {
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  delete pkg.dependencies?.['@local/dsh-outpost-butler'];
  fs.writeFileSync(manifest, JSON.stringify(pkg));
  if (process.env.MOCK_MODE === 'remove-fail') process.exit(9);
  fs.rmSync(path.join(dir, 'node_modules/@local/dsh-outpost-butler'), {recursive: true, force: true});
} else if (args.includes('--dump-config')) {
  const mode = process.env.MOCK_MODE;
  const good = "- id: outpost-butler\\n  name: '@local/dsh-outpost-butler'\\n";
  if (mode === 'dump-fail') { console.log(good); console.error('compose failed'); process.exit(8); }
  if (mode === 'substring') console.log('# outpost-butler error: cannot resolve @local/dsh-outpost-butler');
  else if (mode === 'disabled') console.log(good + '  disabled: true');
  else if (mode === 'dynamic-disabled') console.log(good + "  disabled: !!js 'true'");
  else if (mode === 'wrong-name') console.log('- id: outpost-butler\\n  name: unrelated');
  else if (mode === 'duplicate') console.log(good + good);
  else if (mode === 'missing') console.log('- id: unrelated\\n  name: unrelated');
  else if (mode === 'json-format') console.log(JSON.stringify([{id: 'outpost-butler', name: '@local/dsh-outpost-butler'}]));
  else console.log(good + '  disabled: false');
} else process.exit(91);
`);
// A native shim exercises real LASTEXITCODE and stderr behavior, including PS 5.1.
const fakeCli = path.join(root, process.platform === 'win32' ? 'fake dsh.cmd' : 'fake-dsh');
fs.writeFileSync(fakeCli, process.platform === 'win32'
  ? `@"${process.execPath}" "${fakeJs}" %*\r\n@exit /b %errorlevel%\r\n`
  : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fakeJs.replaceAll("'", "'\\''")}' "$@"\n`);
if (process.platform !== 'win32') fs.chmodSync(fakeCli, 0o700);

const tracked = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml', 'node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml'];
let serial = 0;
function scenario(pkg = { name: 'mock-profile', keep: { value: 'preserve' } }, existingLocks = false) {
  const dir = path.join(root, `case-${++serial}`);
  const home = path.join(dir, 'isolated home');
  const profile = 'custom.mock-19';
  const profileDir = path.join(home, 'profiles', profile);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg));
  if (existingLocks) for (const file of tracked.slice(1)) {
    const target = path.join(profileDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from(`original ${file}\r\n`)]));
  }
  const before = new Map(tracked.map((file) => [file, fs.existsSync(path.join(profileDir, file)) ? fs.readFileSync(path.join(profileDir, file)) : null]));
  return { dir, home, profile, profileDir, before, calls: path.join(dir, 'cli.jsonl') };
}
const mockFunctions = `
$ErrorActionPreference = 'Stop'
function Get-NetTCPConnection {
  param([int]$LocalPort, [string]$State)
  if ($env:MOCK_LISTENER -eq 'query-fail') { throw 'Mock listener query failed' }
  if ($env:MOCK_LISTENER -eq 'occupied') { return [pscustomobject]@{ LocalPort = 43195; OwningProcess = 123456; LocalAddress = '127.0.0.1' } }
}
function Stop-Process { throw 'MOCK SAFETY: attempted Stop-Process' }
function Start-Process { throw 'MOCK SAFETY: unexpected Start-Process' }
function powershell.exe {
  param([Parameter(ValueFromRemainingArguments=$true)][object[]]$LaunchArgs)
  @{ Arguments = @($LaunchArgs); Home = $env:DSH_HOME } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:MOCK_LAUNCH -Encoding UTF8
  $global:LASTEXITCODE = [int]$env:MOCK_LAUNCH_CODE
  Write-Output 'Mock launcher completed; no service started'
}
`;
function run(s, { mode = 'success', restart = false, listener = '', launchCode = 0, lock = false, profile = s.profile } = {}) {
  const driver = path.join(s.dir, `driver-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`);
  writePowerShellScript(driver, mockFunctions + (lock ? `
$heldLock = [IO.File]::Open(${quote(path.join(s.profileDir, '.butler-install.lock'))}, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
` : '') + `\n& ${quote(path.join(fixture, 'setup-butler.ps1'))} -Profile ${quote(profile)} -Port 43195 ${restart ? '' : '-NoRestart'}\nexit $LASTEXITCODE\n`);
  const result = spawnSync(ps.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], {
    cwd: fixture, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, DSH_CLI: fakeCli, DSH_HOME: s.home, DSH_STATE_DIR: path.join(s.dir, 'state'), MOCK_CALLS: s.calls, MOCK_MODE: mode, MOCK_LISTENER: listener, MOCK_LAUNCH: path.join(s.dir, 'launch.json'), MOCK_LAUNCH_CODE: String(launchCode) },
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  fs.writeFileSync(path.join(s.dir, `run-${fs.readdirSync(s.dir).filter((f) => f.startsWith('run-')).length}.log`), output);
  return { code: result.status, output };
}
function assertRestored(s) {
  for (const [file, original] of s.before) {
    const target = path.join(s.profileDir, file);
    if (original) assert.deepEqual(fs.readFileSync(target), original, file);
    else assert.equal(fs.existsSync(target), false, `new ${file} removed`);
  }
}
function calls(s) { return fs.readFileSync(s.calls, 'utf8').trim().split('\n').map(JSON.parse); }
let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  try { fn(); passed++; results.push({ name, passed: true }); console.log(`OK ${name}`); }
  catch (error) { failed++; results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
}

try {
  test('success, repeated install and upgrade use the custom profile and retain one bundle', () => {
    const s = scenario({ name: 'mock-profile', keep: { value: 'preserve' }, dsh: { profile: { bundles: ['base', bundle, bundle] } } });
    for (const version of ['1.0.0', '1.0.0', '2.0.0']) {
      setBundleVersion(version);
      const r = run(s);
      assert.equal(r.code, 0, r.output);
      const pkg = JSON.parse(fs.readFileSync(path.join(s.profileDir, 'package.json'), 'utf8'));
      assert.deepEqual(pkg.dsh.profile.bundles, ['base', bundle]);
      assert.deepEqual(pkg.keep, { value: 'preserve' });
      assert.equal(JSON.parse(fs.readFileSync(path.join(s.profileDir, 'node_modules/@local/dsh-outpost-butler/package.json'), 'utf8')).version, version);
    }
    assert.equal(calls(s).length, 8);
    for (const call of calls(s)) { assert.equal(call.home, s.home); assert.equal(call.args[call.args.indexOf('--profile') + 1], s.profile); }
    assert.equal(fs.readdirSync(path.join(s.profileDir, '.butler-install-backups')).length, 3);
    assert.equal(fs.existsSync(path.join(s.profileDir, '.butler-install.lock')), false);
  });
  for (const [name, pkg] of [['dsh', { name: 'mock' }], ['profile', { dsh: {} }], ['bundles', { dsh: { profile: {} } }]]) {
    test(`missing ${name} property is created`, () => {
      const s = scenario(pkg); const r = run(s);
      assert.equal(r.code, 0, r.output);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.profileDir, 'package.json'), 'utf8')).dsh.profile.bundles, [bundle]);
    });
  }
  for (const mode of ['add-fail', 'dump-fail', 'substring', 'disabled', 'dynamic-disabled', 'wrong-name', 'duplicate', 'missing', 'json-format', 'bad-package']) {
    test(`${mode} fails closed and restores existing profile files`, () => {
      const s = scenario(undefined, true); const r = run(s, { mode, restart: true });
      assert.equal(r.code, 1, r.output);
      assertRestored(s);
      assert.match(r.output, /full dependency rollback is not available/);
      assert.equal(fs.existsSync(path.join(s.dir, 'launch.json')), false);
      assert.equal(fs.existsSync(path.join(s.profileDir, 'node_modules/dependency-mutated')), true);
      assert.equal(calls(s).length, ['add-fail', 'bad-package'].includes(mode) ? 1 : 2);
      const backups = fs.readdirSync(path.join(s.profileDir, '.butler-install-backups'));
      const records = JSON.parse(fs.readFileSync(path.join(s.profileDir, '.butler-install-backups', backups[0], 'snapshot.json'), 'utf8').replace(/^﻿/, ''));
      assert.equal(records.length, tracked.length);
    });
  }
  test('failed compose removes newly created lockfiles and configuration', () => {
    const s = scenario(); const r = run(s, { mode: 'dump-fail' });
    assert.equal(r.code, 1, r.output); assertRestored(s);
  });
  test('failed removal during upgrade restores the previous dependency manifest', () => {
    const s = scenario({ name: 'mock-profile', dependencies: { [bundle]: 'link:old-source' } }, true);
    const r = run(s, { mode: 'remove-fail' });
    assert.equal(r.code, 1, r.output);
    assertRestored(s);
    assert.equal(calls(s).length, 1);
    assert.equal(calls(s)[0].args[3], 'remove');
    assert.equal(fs.existsSync(path.join(s.dir, 'launch.json')), false);
  });
  test('exclusive profile lock prevents concurrent mutation', () => {
    const s = scenario(); const r = run(s, { lock: true });
    assert.equal(r.code, 1, r.output); assertRestored(s); assert.equal(fs.existsSync(s.calls), false);
  });
  test('occupied port is left running with manual restart instructions', () => {
    const s = scenario(); const r = run(s, { restart: true, listener: 'occupied' });
    assert.equal(r.code, 0, r.output); assert.match(r.output, /left its listener running/); assert.match(r.output, /Restart profile 'custom.mock-19' manually/);
    assert.equal(fs.existsSync(path.join(s.dir, 'launch.json')), false);
  });
  test('listener inspection failure never starts a service', () => {
    const s = scenario(); const r = run(s, { restart: true, listener: 'query-fail' });
    assert.equal(r.code, 0, r.output); assert.match(r.output, /Cannot inspect listeners/);
    assert.equal(fs.existsSync(path.join(s.dir, 'launch.json')), false);
  });
  test('installer forwards custom Profile, port, spaced path and DSH_HOME to launcher', () => {
    const s = scenario(); const r = run(s, { restart: true });
    assert.equal(r.code, 0, r.output);
    const launch = JSON.parse(fs.readFileSync(path.join(s.dir, 'launch.json'), 'utf8').replace(/^﻿/, ''));
    assert.equal(launch.Home, s.home);
    const args = launch.Arguments;
    assert.equal(args[args.indexOf('-Profile') + 1], s.profile);
    assert.equal(args[args.indexOf('-Port') + 1], '43195');
    assert.equal(args[args.indexOf('-File') + 1], path.join(fixture, 'start-dsh-web.ps1'));
    assert.ok(!args.includes('-Restart'));
  });
  test('launcher failure reports install retained', () => {
    const s = scenario(); const r = run(s, { restart: true, launchCode: 6 });
    assert.equal(r.code, 1, r.output); assert.match(r.output, /Installed, but DSH Web startup failed/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(s.profileDir, 'package.json'), 'utf8')).dsh.profile.bundles.includes(bundle));
  });
  test('actual launcher forwards Profile and DSH_HOME to its mocked DSH child', () => {
    const s = scenario();
    const driver = path.join(s.dir, 'launcher-driver.ps1');
    const gateway = path.join(s.profileDir, 'node_modules/dsh-plugin-mobile-gateway');
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'package.json'), '{}');
    const patch = path.join(fixture, 'patches/mobile-gateway-mgmt-auth/apply.mjs');
    fs.mkdirSync(path.dirname(patch), { recursive: true });
    fs.writeFileSync(patch, '// Mock file; never executed');
    writePowerShellScript(driver, `
$ErrorActionPreference = 'Stop'
function Test-Path {
    [CmdletBinding()]
    param([string]$Path, [string]$LiteralPath, [string]$PathType)
    $target = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($target -like '*Tailscale*') { return $false }
    $params = @{ LiteralPath = $target }
    if ($PathType) { $params.PathType = $PathType }
    Microsoft.PowerShell.Management\\Test-Path @params
}
function Get-Command {
    param([string]$Name)
    if ($Name -eq 'tailscale') { return $null }
    throw 'MOCK SAFETY: unexpected command lookup'
}
function Get-NetAdapter { return @() }
function Get-NetIPAddress { return @() }
function Get-NetTCPConnection {
    if ($env:MOCK_BUSY -eq 'true') { return [pscustomobject]@{ OwningProcess = 123456 } }
    return @()
}
function node {
    param($Script, $Mode, $Target)
    if ($Mode -ne '--check') { throw 'MOCK SAFETY: unexpected patch mode' }
    [IO.File]::WriteAllText($env:MOCK_GATE_PATH, $Target)
    $global:LASTEXITCODE = 0
    Write-Output 'Mock patch applied'
}
function Get-NetFirewallProfile { return @() }
function Set-Acl { }
function Stop-Process { throw 'MOCK SAFETY: attempted Stop-Process' }
function Start-Process {
    param($FilePath, $ArgumentList, $RedirectStandardOutput, $RedirectStandardError, $WindowStyle, [switch]$PassThru)
    @{ FilePath = $FilePath; Arguments = @($ArgumentList); Home = $env:DSH_HOME } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:MOCK_LAUNCH -Encoding UTF8
    [IO.File]::WriteAllText($RedirectStandardOutput, 'http://127.0.0.1:43195/?token=mock_only')
    $proc = [pscustomobject]@{ Id = 999999; HasExited = $false }
    $proc | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
    return $proc
}
$extra = @{}
if ($env:MOCK_BUSY -eq 'true') { $extra.Restart = $true }
& ${quote(path.join(fixture, 'start-dsh-web.ps1'))} -Profile ${quote(s.profile)} -Host_ 127.0.0.1 -Port 43195 -NoQr @extra
`);
    // The Windows launcher resolves these locations before using DSH_CLI.
    // Keep them inside the fixture on every platform, including Linux CI.
    const launchEnv = {
      ...process.env,
      LOCALAPPDATA: path.join(s.dir, 'mock-localappdata'),
      ProgramFiles: path.join(s.dir, 'mock-programfiles'),
      USERPROFILE: path.join(s.dir, 'mock-userprofile'),
      DSH_CLI: fakeCli, DSH_HOME: s.home, DSH_STATE_DIR: path.join(s.dir, 'state'),
      MOCK_LAUNCH: path.join(s.dir, 'child.json'), MOCK_GATE_PATH: path.join(s.dir, 'gate-path.txt'),
    };
    const result = spawnSync(ps.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], {
      cwd: fixture, encoding: 'utf8', timeout: 30000, env: launchEnv,
    });
    assert.ifError(result.error);
    fs.writeFileSync(path.join(s.dir, 'launcher.log'), result.stdout + result.stderr);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const launch = JSON.parse(fs.readFileSync(path.join(s.dir, 'child.json'), 'utf8').replace(/^﻿/, ''));
    assert.equal(launch.Home, s.home);
    assert.equal(launch.FilePath, fakeCli);
    assert.equal(launch.Arguments[launch.Arguments.indexOf('--profile') + 1], s.profile);
    assert.equal(fs.readFileSync(path.join(s.dir, 'gate-path.txt'), 'utf8'), `--path=${path.join(gateway, 'lib/index.mjs')}`);
    fs.rmSync(path.join(s.dir, 'child.json'));
    const busy = spawnSync(ps.exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], {
      cwd: fixture, encoding: 'utf8', timeout: 30000, env: { ...launchEnv, MOCK_BUSY: 'true' },
    });
    assert.ifError(busy.error);
    fs.writeFileSync(path.join(s.dir, 'launcher-busy.log'), busy.stdout + busy.stderr);
    assert.equal(busy.status, 1);
    assert.match(busy.stdout + busy.stderr, /No process was stopped/);
    assert.equal(fs.existsSync(path.join(s.dir, 'child.json')), false);
  });
  test('traversal profile is rejected before CLI invocation', () => {
    const s = scenario(); const r = run(s, { profile: '../web' });
    assert.notEqual(r.code, 0); assert.equal(fs.existsSync(s.calls), false); assertRestored(s);
  });
} finally {
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ mockOnly: true, passed, failed, results }, null, 2));
  console.log(`butler-installer-spec: ${passed} passed, ${failed} failed; evidence: ${root}`);
  if (!evidence) fs.rmSync(root, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
