import path from 'node:path';

const ALLOWED_TOOLS = new Set(['fs', 'goal', 'executor-native', 'call-timeout-policy'].map(name => '@deepseek-ai/dsh-tool-' + name));
const DISABLED_IDS = new Set([
  'session-title-llm', 'session-telemetry-otel', 'otel', 'deepseek-account',
  'plugin-manager', 'tool-plugin-manager', 'hmr', 'config-editor', 'settings',
  'bash-sandbox', 'pwsh-sandbox', 'shell-env', 'terminal-bash', 'subprocess',
  'tool-bash', 'tool-bash-persistent', 'tool-pwsh', 'tool-pwsh-persistent',
]);
const DISABLED_FAMILIES = /^@deepseek-ai\/dsh-(?:bash|pwsh|shell|terminal|subprocess|otel|session-telemetry|deepseek-account|plugin-manager|hmr|web|git|python|jobs|subagent|workflow|ptc|mcp)(?:-|\/|$)/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fileUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('file:///') || value.includes('\\') || /%(?:00|2f|5c)/i.test(value)) throw Error('LOCAL_PROFILE_URL');
  let url, decoded;
  try { url = new URL(value); decoded = decodeURIComponent(url.pathname); }
  catch { throw Error('LOCAL_PROFILE_URL'); }
  if (url.protocol !== 'file:' || url.host || url.search || url.hash || url.pathname.endsWith('/') || /[\u0000-\u001f\u007f]/.test(value + decoded)) throw Error('LOCAL_PROFILE_URL');
  return url.href;
}
function forbidden(row, name) {
  return DISABLED_IDS.has(row.id)
    || typeof name === 'string' && (
      name.startsWith('@deepseek-ai/dsh-tool-') && !ALLOWED_TOOLS.has(name)
      || name.startsWith('@deepseek-ai/dsh-llm-') && name !== '@deepseek-ai/dsh-llm-retry'
      || DISABLED_FAMILIES.test(name));
}

/** Compose trusted DSH base patches. Optional mockPlugins are explicit local-file
 * plugin rows ({id, name, config?}), intended for isolated deterministic harnesses.
 * This helper loads no code and never substitutes a fake credential service.
 */
export function buildLocalRuntimePatches(basePatches, {workspaceRoot, butlerUrl, filesystemUrl, credentialsUrl, mockPlugins = []}) {
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot) || workspaceRoot.includes('\0')) throw Error('LOCAL_PROFILE_WORKSPACE');
  butlerUrl = fileUrl(butlerUrl);
  filesystemUrl = fileUrl(filesystemUrl);
  if (credentialsUrl !== undefined) credentialsUrl = fileUrl(credentialsUrl);
  if (!Array.isArray(basePatches) || !Array.isArray(mockPlugins)) throw Error('LOCAL_PROFILE_PATCHES');

  const names = new Map(), inserted = new Set(), denied = new Set();
  function check(row) {
    if (!object(row) || typeof row.id !== 'string' || !row.id || row.name !== undefined && typeof row.name !== 'string') throw Error('LOCAL_PROFILE_PATCHES');
  }
  for (const patch of basePatches) {
    if (!object(patch) || patch.insert !== undefined && !Array.isArray(patch.insert)) throw Error('LOCAL_PROFILE_PATCHES');
    if (patch.id !== undefined) check(patch);
    for (const row of patch.insert ?? []) {
      check(row);
      if (inserted.has(row.id)) throw Error('LOCAL_PROFILE_PATCHES');
      inserted.add(row.id);
      if (row.name !== undefined) names.set(row.id, row.name);
      if (forbidden(row, row.name)) denied.add(row.id);
    }
    if (patch.name !== undefined) names.set(patch.id, patch.name);
    if (forbidden(patch, patch.name)) denied.add(patch.id);
  }
  // Record restrictions across all layers so a later disabled:false cannot undo them.
  for (const [id, name] of names) if (forbidden({id}, name)) denied.add(id);
  const pinned = new Map([
    ['fs-sandbox', {name: filesystemUrl, config: {cwd: workspaceRoot}}],
    ['sandbox-policy', {name: '@deepseek-ai/dsh-sandbox-policy', config: {mode: 'workspace-write', workspaceRoot}}],
    ['approval', {name: '@deepseek-ai/dsh-user-approval', config: {policy: 'ask'}}],
    ['outpost-butler', {name: butlerUrl, config: {localRuntime: true, workspaceRoot}}],
  ]);
  if (credentialsUrl !== undefined) pinned.set('credentials', {name: credentialsUrl, config: {}});
  function restrict(row) {
    const copy = {...row};
    if (denied.has(row.id)) copy.disabled = true;
    if (names.get(row.id) === '@deepseek-ai/dsh-tool-fs') copy.config = {...row.config, applyPatch: false};
    if (pinned.has(row.id)) Object.assign(copy, pinned.get(row.id), {disabled: false});
    return copy;
  }
  const patches = basePatches.map(patch => ({...restrict(patch), ...(patch.insert ? {insert: patch.insert.map(restrict)} : {})}));
  for (const [id, row] of pinned) {
    if (inserted.has(id)) patches.push({id, ...row, disabled: false});
    else { patches.push({insert: [{id, ...row, disabled: false}]}); inserted.add(id); }
  }
  const mocks = mockPlugins.map(row => {
    check(row);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(row.id) || inserted.has(row.id) || denied.has(row.id) || pinned.has(row.id)
      || DISABLED_IDS.has(row.id) || Object.keys(row).some(key => !['id', 'name', 'config'].includes(key))) throw Error('LOCAL_PROFILE_MOCK');
    inserted.add(row.id);
    return {id: row.id, name: fileUrl(row.name), ...(row.config === undefined ? {} : {config: row.config})};
  });
  if (mocks.length) patches.push({insert: mocks});
  return patches;
}
