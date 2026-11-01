import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = os.tmpdir();
const stateDir = mkdtempSync(path.join(tempRoot, 'dsh-outpost-repair-'));
process.env.DSH_STATE_DIR = stateDir;
const { repairNetwork, runScript } = await import('../../dsh-plugin-connect/tunnel-service.mjs');
const healthy = { running: false, dshRunning: true, ipChanged: false };

after(() => {
  assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(tempRoot));
  assert.ok(path.basename(stateDir).startsWith('dsh-outpost-repair-'));
  rmSync(stateDir, { recursive: true, force: true });
});

test('repair restarts DSH and does not enable a tunnel that was off', async () => {
  const calls = [];
  const result = await repairNetwork(async () => healthy, async (script, args) => {
    calls.push({ script, args });
    return { ok: true, stdout: 'started' };
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('-Restart'));
});

test('failed DSH startup cannot report success or start the old tunnel', async () => {
  let runs = 0;
  const result = await repairNetwork(async () => ({ ...healthy, running: true }), async () => {
    runs++;
    return { ok: false, error: 'port occupied' };
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'port occupied');
  assert.equal(runs, 1);
});

test('listening on an obsolete address is not a successful repair', async () => {
  const result = await repairNetwork(async () => ({ ...healthy, ipChanged: true }),
    async () => ({ ok: true }));
  assert.equal(result.ok, false);
});

test('restore a previous tunnel only after DSH is healthy, and report tunnel errors', async () => {
  const sequence = [];
  const result = await repairNetwork(async () => {
    sequence.push('status');
    return { ...healthy, running: true };
  }, async (script) => {
    const isDsh = script.endsWith('start-dsh-web.ps1');
    sequence.push(isDsh ? 'dsh' : 'tunnel');
    return isDsh ? { ok: true } : { ok: false, error: 'tunnel failed' };
  });
  assert.deepEqual(sequence, ['status', 'dsh', 'status', 'tunnel', 'status']);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tunnel failed');
});

test('a stale restored tunnel cannot report success', async () => {
  const result = await repairNetwork(async () => ({ ...healthy, running: true, tunnelStale: true }),
    async () => ({ ok: true }));
  assert.equal(result.ok, false);
});

const windows = process.platform === 'win32';
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
function script(name, text) {
  const file = path.join(stateDir, name);
  writeFileSync(file, '\uFEFF' + text, 'utf8');
  return file;
}

test('PowerShell errors preserve Chinese text and redact pairing credentials', { skip: !windows }, async () => {
  const file = script('failure.ps1', "Write-Host '启动失败 http://127.0.0.1/?token=private-test-token'; exit 7");
  const result = await runScript(file, [], 10000);
  assert.equal(result.ok, false);
  assert.match(result.error, /启动失败/);
  assert.ok(!JSON.stringify(result).includes('private-test-token'));
});

test('PowerShell receives named parameters, switches, and literal argument values', { skip: !windows }, async () => {
  const file = script('parameters.ps1',
    'param([int]$Port, [string]$Bind, [switch]$Restart, [string]$Label)\n' +
    'Write-Host "$Port|$Bind|$Restart|$Label"');
  const result = await runScript(file, ['-Bind', 'lan', '-Port', '3095', '-Restart', '-Label', "it's $(literal)"], 10000);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stdout.trim(), "3095|lan|True|it's $(literal)");
});

test('script completion does not wait for a background child to close inherited pipes', { skip: !windows }, async () => {
  const pidFile = path.join(stateDir, 'child.pid');
  const childFile = path.join(stateDir, 'linger.cjs');
  writeFileSync(childFile, 'setTimeout(() => {}, 12000);');
  const file = script('background.ps1',
    `$p = Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ('"' + ${psQuote(childFile)} + '"') -WindowStyle Hidden -PassThru\n` +
    `$p.Id | Set-Content -LiteralPath ${psQuote(pidFile)}\nWrite-Host '启动完成'\n`);
  try {
    const start = Date.now();
    const result = await runScript(file, [], 10000);
    assert.equal(result.ok, true, result.error);
    assert.match(result.stdout, /启动完成/);
    assert.ok(Date.now() - start < 6000, 'must complete before the 12-second child exits');
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8').replace(/^\uFEFF/, '').trim())); } catch {}
  }
});

test('LAN selection ignores disconnected and tentative adapters and prefers active Wi-Fi', { skip: !windows }, async () => {
  const source = readFileSync(new URL('../../start-dsh-web.ps1', import.meta.url), 'utf8');
  const start = source.indexOf('function Get-LanIp {');
  const end = source.indexOf('\n$tailnetIp =', start);
  assert.ok(start > 0 && end > start);
  const file = script('lan-selection.ps1', `
function Get-NetAdapter { @(
  [pscustomobject]@{ ifIndex=12; Status='Disconnected' },
  [pscustomobject]@{ ifIndex=4; Status='Up' },
  [pscustomobject]@{ ifIndex=8; Status='Up' }
) }
function Get-NetIPAddress { @(
  [pscustomobject]@{ IPAddress='172.18.174.139'; InterfaceAlias='Ethernet'; InterfaceIndex=12; AddressState='Preferred'; SkipAsSource=$false },
  [pscustomobject]@{ IPAddress='10.99.0.2'; InterfaceAlias='Wi-Fi 2'; InterfaceIndex=8; AddressState='Tentative'; SkipAsSource=$false },
  [pscustomobject]@{ IPAddress='10.189.47.223'; InterfaceAlias='WLAN'; InterfaceIndex=4; AddressState='Preferred'; SkipAsSource=$false }
) }
${source.slice(start, end)}
Write-Host (Get-LanIp)
`);
  const result = await runScript(file, [], 10000);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.stdout.trim(), '10.189.47.223');
});
