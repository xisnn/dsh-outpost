import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildLocalRuntimePatches} from '../runtime/profile.mjs';

const options = {workspaceRoot: '/outpost-data/workspace', butlerUrl: 'file:///opt/dsh/outpost-butler/index.js', filesystemUrl: 'file:///opt/dsh/outpost-butler/lib/workspace-fs.js'};
const plugin = (id, suffix, config) => ({id, name: '@deepseek-ai/dsh-' + suffix, ...(config ? {config} : {})});
const base = [{insert: [
  plugin('llm', 'llm'), plugin('llm-retry', 'llm-retry'),
  plugin('llm-pi-ai', 'llm-pi-ai'), plugin('llm-deepseek', 'llm-deepseek-api-key'),
  plugin('model-adapter-alias', 'llm-future-provider'), plugin('account-alias', 'deepseek-account-platform'),
  plugin('session-title-llm', 'session-title-first-prompt-llm'), plugin('telemetry-alias', 'session-telemetry-otel'),
  plugin('otel', 'otel'), plugin('plugin-manager', 'plugin-manager'), plugin('hmr', 'hmr'),
  plugin('shell-provider-alias', 'bash-sandbox'), plugin('pwsh-sandbox', 'pwsh-sandbox'),
  plugin('terminal-bash', 'terminal-bash'), plugin('shell-env', 'shell-env'),
  plugin('web-fetch-http', 'web-fetch-http'), plugin('jobs', 'jobs-local'),
  plugin('subagent', 'subagent'), plugin('workflow-ptc', 'workflow-ptc'),
  ...['bash', 'pwsh', 'git', 'python', 'web', 'jobs', 'subagent', 'workflow', 'unknown-future', 'fs-search', 'skill', 'executor-ptc'].map(name => plugin('tool-' + name, 'tool-' + name)),
  ...['fs', 'goal', 'executor-native', 'call-timeout-policy'].map(name => plugin('allowed-' + name, 'tool-' + name)),
  plugin('fs-sandbox', 'fs-sandbox', {cwd: '/wrong', unrestricted: true}),
  plugin('sandbox-policy', 'sandbox-policy', {mode: 'danger-full-access', workspaceRoot: '/wrong'}),
  plugin('approval', 'user-approval', {policy: 'never'}),
  plugin('credentials', 'credentials-local', {keep: 'real service'}),
  plugin('storage-domain', 'storage-domain'),
]}, {id: 'tool-git', disabled: false}, {id: 'shell-provider-alias', disabled: false},
{id: 'fs-sandbox', config: {cwd: '/later-override'}},
{id: 'sandbox-policy', config: {mode: 'danger-full-access'}},
{id: 'allowed-fs', config: {applyPatch: true}},
];
function compose(patches) {
  const rows = new Map();
  for (const patch of patches) {
    for (const row of patch.insert ?? []) { assert.equal(rows.has(row.id), false, 'duplicate insert'); rows.set(row.id, {...row}); }
    if (patch.id) { assert.ok(rows.has(patch.id)); rows.set(patch.id, {...rows.get(patch.id), ...patch}); }
  }
  return rows;
}
{
  const before = JSON.stringify(base);
  const patches = buildLocalRuntimePatches(base, options), rows = compose(patches);
  assert.equal(JSON.stringify(base), before, 'assembly must not mutate base patches');
  for (const row of rows.values()) {
    if (row.name.startsWith('@deepseek-ai/dsh-tool-') && !['allowed-fs','allowed-goal','allowed-executor-native','allowed-call-timeout-policy'].includes(row.id)) assert.equal(row.disabled, true, row.id);
  }
  for (const id of ['llm-pi-ai','llm-deepseek','model-adapter-alias','account-alias','session-title-llm','telemetry-alias','otel','plugin-manager','hmr','shell-provider-alias','pwsh-sandbox','terminal-bash','shell-env','web-fetch-http','jobs','subagent','workflow-ptc']) assert.equal(rows.get(id).disabled, true, id);
  for (const id of ['llm','llm-retry','storage-domain','allowed-fs','allowed-goal','allowed-executor-native','allowed-call-timeout-policy']) assert.notEqual(rows.get(id).disabled, true, id);
  assert.equal(rows.get('allowed-fs').config.applyPatch, false);
  assert.deepEqual(rows.get('fs-sandbox').config, {cwd: options.workspaceRoot});
  assert.equal(rows.get('fs-sandbox').name, options.filesystemUrl);
  assert.deepEqual(rows.get('sandbox-policy').config, {mode: 'workspace-write', workspaceRoot: options.workspaceRoot});
  assert.deepEqual(rows.get('approval').config, {policy: 'ask'});
  assert.deepEqual(rows.get('outpost-butler'), {id: 'outpost-butler', name: options.butlerUrl, config: {localRuntime: true, workspaceRoot: options.workspaceRoot}, disabled: false});
  assert.deepEqual(rows.get('credentials'), base[0].insert.find(row => row.id === 'credentials'));
  // Assembly is deterministic, including when given its own already-composed output.
  assert.deepEqual(compose(buildLocalRuntimePatches(patches, options)), rows);
  const injected = compose(buildLocalRuntimePatches(base, {...options, credentialsUrl: 'file:///opt/dsh/android-vault.mjs', mockPlugins: [{id:'test-model', name:'file:///opt/dsh/mock.mjs', config:{provider:'test'}}]}));
  assert.deepEqual(injected.get('credentials').config, {});
  assert.equal(injected.get('credentials').name, 'file:///opt/dsh/android-vault.mjs');
  assert.equal(injected.get('test-model').name, 'file:///opt/dsh/mock.mjs');
}
{
  for (const key of ['butlerUrl','filesystemUrl','credentialsUrl']) for (const bad of [undefined, null, '', './provider.js', '/provider.js', 'https://example.invalid/module.js', 'data:text/javascript,export default 1', 'file://server/share/module.js', 'file:///opt/provider.js?execute=1', 'file:///opt/provider.js#x', 'file:///opt/%00.js', 'file:///opt/%0a.js', 'file:///opt/%2fescape.js', 'file:///opt/%zz.js', 'file:///opt/']) {
    if (key === 'credentialsUrl' && bad === undefined) continue;
    assert.throws(() => buildLocalRuntimePatches(base, {...options, [key]: bad}), /LOCAL_PROFILE_URL/, key + ': ' + bad);
  }
  for (const workspaceRoot of ['', '.', 'relative/workspace', 'C:relative', null, '/workspace\0escape']) assert.throws(() => buildLocalRuntimePatches(base, {...options, workspaceRoot}), /LOCAL_PROFILE_WORKSPACE/);
  for (const invalid of [null, {}, [{insert:{}}], [{insert:[null]}], [{insert:[{id:'duplicate',name:'x'},{id:'duplicate',name:'y'}]}]]) assert.throws(() => buildLocalRuntimePatches(invalid, options), /LOCAL_PROFILE_PATCHES/);
  for (const row of [{id:'fs-sandbox',name:'file:///mock.js'}, {id:'credentials',name:'file:///mock.js'}, {id:'hmr',name:'file:///mock.js'}, {id:'mock',name:'https://example.invalid/mock.js'}, {id:'mock',name:'file:///mock.js',insert:[]}]) assert.throws(() => buildLocalRuntimePatches(base, {...options,mockPlugins:[row]}), /LOCAL_PROFILE_(MOCK|URL)/);
}

// Exercise the product confinement subclass with a minimal filesystem contract.
// The base double performs real temp-file IO/canonical resolution; no DSH boots.
class SandboxedFileSystem {
  constructor(ctx, config) { this.cwd = config.cwd; }
  processPath(target) { return target.targetKey; }
  async resolve(file, opts = {}) {
    const absolute = path.resolve(opts.cwd ?? this.cwd, file);
    let targetKey;
    try { targetKey = await fs.promises.realpath(absolute); }
    catch (error) { if (error.code !== 'ENOENT') throw error; targetKey = path.join(await fs.promises.realpath(path.dirname(absolute)), path.basename(absolute)); }
    return {targetKey, displayPath: file};
  }
  async readText(target) { return fs.promises.readFile(this.processPath(target), 'utf8'); }
  async *streamText(target) { yield await this.readText(target); }
  async stat(target) { return fs.promises.stat(this.processPath(target)); }
  async lstat(file, opts) { return fs.promises.lstat(this.processPath(await this.resolve(file, opts))); }
  async writeText(target, content) { return fs.promises.writeFile(this.processPath(target), content); }
  async listDir(target) { return (await fs.promises.readdir(this.processPath(target))).map(name => ({name, target:{targetKey:path.join(this.processPath(target), name)}})); }
}
class FsError extends Error { constructor(message, code) { super(message); this.code = code; } }
const providerSource = fs.readFileSync(new URL('../../dsh-outpost-butler/lib/workspace-fs.js', import.meta.url), 'utf8');
const {default: WorkspaceFileSystem} = await import('data:text/javascript;base64,' + Buffer.from(providerSource
  .replace("import {SandboxedFileSystem} from '@deepseek-ai/dsh-fs-sandbox';", SandboxedFileSystem.toString())
  .replace("import {FsError} from '@deepseek-ai/dsh-fs';", FsError.toString())).toString('base64'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-profile-'));
try {
  const root = path.join(temporary, 'workspace'), outside = path.join(temporary, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(root, 'inside', 'input.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'synthetic outside sentinel');
  const provider = new WorkspaceFileSystem({sandboxPolicy:{workspaceRoot:root}}, {cwd:root});
  const denied = work => assert.rejects(work, {code:'FS_SANDBOX_DENIED'});
  const forged = {targetKey:path.join(outside,'secret.txt')};
  assert.equal(await provider.readText(await provider.resolve('inside/input.txt')), 'inside');
  for (const work of [() => provider.readText(forged), () => provider.readBytes(forged), () => provider.readByteRange(forged, {}), () => provider.watch(forged), () => provider.writeText(forged, 'bad'), () => provider.editText(forged, {}), () => provider.patchText(forged, []), () => provider.deleteFile(forged), () => provider.moveFile(forged, forged), () => provider.listDir(forged)]) await denied(work);
  assert.equal(await provider.stat(forged), undefined);
  assert.equal(await provider.lstat(forged.targetKey), undefined);
  assert.equal(provider.processPathFromHostPath(forged.targetKey), undefined);
  await provider.writeText(await provider.resolve('written.txt'), 'inside write');
  assert.equal(fs.readFileSync(path.join(root,'written.txt'), 'utf8'), 'inside write');
  fs.symlinkSync(outside, path.join(root,'outside-link'), 'junction');
  fs.symlinkSync(path.join(root,'inside'), path.join(root,'inside-link'), 'junction');
  await denied(async () => provider.readText(await provider.resolve('outside-link/secret.txt')));
  assert.equal(await provider.readText(await provider.resolve('inside-link/input.txt')), 'inside');
  assert.equal((await provider.listDir(await provider.resolve(root))).some(entry => entry.name === 'outside-link'), false);
  const stale = await provider.resolve('inside/input.txt');
  const deferred = await provider.streamText(stale);
  fs.renameSync(path.join(root,'inside'), path.join(root,'saved'));
  fs.symlinkSync(outside, path.join(root,'inside'), 'junction');
  await denied(() => provider.readText(stale));
  await denied(async () => { for await (const chunk of deferred) void chunk; });
  assert.throws(() => new WorkspaceFileSystem({sandboxPolicy:{workspaceRoot:path.join(root,'inside')}}, {cwd:root}), /real directory/);
  fs.renameSync(root, root + '-original'); fs.mkdirSync(root);
  await denied(() => provider.readText(stale));
  assert.equal(fs.readFileSync(forged.targetKey, 'utf8'), 'synthetic outside sentinel');
} finally { fs.rmSync(temporary, {recursive:true, force:true}); }
console.log('Local runtime profile: restricted composition, immutable base patches, explicit file adapters, real credentials preserved, root identity and operation-time confinement passed; DSH boots=0; real model calls=0');
