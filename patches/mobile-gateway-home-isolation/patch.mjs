/**
 * D-3 fix as a replayable text transformation over dsh-plugin-mobile-gateway.
 *
 * Single source of truth: the upstream branch `fix/p4-0-device-file-isolation`
 * (commit 9d26cb9 on top of 0.10.3 / 9ce0b33). The two new modules are carried
 * verbatim in `files/`; the three existing modules are edited through unique
 * text anchors so no upstream code is copied or rewritten.
 *
 * Every anchor must match exactly once. Anything else throws, and apply.mjs
 * refuses to write: a half-applied security patch is worse than none.
 */

const MARKER = 'DSH_OUTPOST_HOME_ISOLATION_PATCH'

// [file, anchor, replacement]
const EDITS = [
  [
    'lib/index.mjs',
    "import { createGatewayState, GATEWAY_MODES } from './gateway-state.mjs'",
    "import { createGatewayState, GATEWAY_MODES } from './gateway-state.mjs'\n"
    + "import { resolveDeviceFile } from './home-paths.mjs' // DSH_OUTPOST_HOME_ISOLATION_PATCH",
  ],
  [
    'lib/index.mjs',
    "const deviceFile = options.deviceFile || path.join(os.homedir(), '.dsh', 'mobile-gateway-devices.json')",
    'const deviceFile = resolveDeviceFile(options) // DSH_OUTPOST_HOME_ISOLATION_PATCH',
  ],
  [
    'lib/index.mjs',
    "      wss.close()\n      log('plugin stopped, all sockets closed')",
    "      wss.close()\n"
    + '      registry.dispose() // DSH_OUTPOST_HOME_ISOLATION_PATCH\n'
    + '      gatewayState.dispose() // DSH_OUTPOST_HOME_ISOLATION_PATCH\n'
    + "      log('plugin stopped, all sockets closed')",
  ],
  [
    'lib/devices.js',
    "const path = require('node:path')",
    "const path = require('node:path')\n"
    + "const { acquireRegistryLock } = require('./registry-lock.js') // DSH_OUTPOST_HOME_ISOLATION_PATCH",
  ],
  [
    'lib/devices.js',
    'function createRegistry(file, options = {}) {\n  const pairingTtlMs',
    'function createRegistry(file, options = {}) {\n'
    + "  const releaseLock = acquireRegistryLock(file, 'device registry') // DSH_OUTPOST_HOME_ISOLATION_PATCH\n"
    + '  const pairingTtlMs',
  ],
  [
    'lib/devices.js',
    'const tmp = `${file}.${process.pid}.tmp`',
    'const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp` // DSH_OUTPOST_HOME_ISOLATION_PATCH',
  ],
  [
    'lib/devices.js',
    '  load()\n\n  return {\n    list() {',
    '  try { // DSH_OUTPOST_HOME_ISOLATION_PATCH\n'
    + '    load()\n'
    + '  } catch (error) {\n'
    + '    releaseLock()\n'
    + '    throw error\n'
    + '  }\n\n'
    + '  return {\n'
    + '    dispose() {\n'
    + '      releaseLock()\n'
    + '    },\n\n'
    + '    list() {',
  ],
  [
    'lib/gateway-state.mjs',
    "import crypto from 'node:crypto'",
    "import crypto from 'node:crypto'\n"
    + "import { acquireRegistryLock } from './registry-lock.js' // DSH_OUTPOST_HOME_ISOLATION_PATCH",
  ],
  [
    'lib/gateway-state.mjs',
    'export function createGatewayState(file) {\n  const validate',
    'export function createGatewayState(file) {\n'
    + "  const releaseLock = acquireRegistryLock(file, 'gateway identity') // DSH_OUTPOST_HOME_ISOLATION_PATCH\n"
    + '  const validate',
  ],
  [
    'lib/gateway-state.mjs',
    '  } catch (error) {\n    throw new Error(`failed to load gateway state',
    '  } catch (error) {\n'
    + '    releaseLock() // DSH_OUTPOST_HOME_ISOLATION_PATCH\n'
    + '    throw new Error(`failed to load gateway state',
  ],
  [
    'lib/gateway-state.mjs',
    '  return {\n    get gatewayId()',
    '  return {\n'
    + '    dispose() { releaseLock() }, // DSH_OUTPOST_HOME_ISOLATION_PATCH\n'
    + '    get gatewayId()',
  ],
]

const NEW_FILES = ['lib/home-paths.mjs', 'lib/registry-lock.js']
const EDITED_FILES = ['lib/index.mjs', 'lib/devices.js', 'lib/gateway-state.mjs']

/** Match the file's own line endings so the patch works on LF and CRLF installs. */
function alignEol(text, source) {
  return source.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text
}

function countOccurrences(source, needle) {
  return source.split(needle).length - 1
}

/**
 * Apply every edit to one file's text.
 * @param {string} relativePath e.g. 'lib/index.mjs'
 * @param {string} source current file contents
 * @returns {string} patched contents
 */
export function patchFile(relativePath, source) {
  const edits = EDITS.filter(([file]) => file === relativePath)
  if (edits.length === 0) throw new Error(`no edits defined for ${relativePath}`)
  if (source.includes(MARKER)) throw new Error(`${relativePath} already carries the patch marker`)
  let out = source
  for (const [, anchor, replacement] of edits) {
    const alignedAnchor = alignEol(anchor, source)
    const hits = countOccurrences(out, alignedAnchor)
    if (hits !== 1) {
      throw new Error(`anchor for ${relativePath} matched ${hits} times (expected 1): ${JSON.stringify(anchor.slice(0, 70))}`)
    }
    out = out.replace(alignedAnchor, alignEol(replacement, source))
  }
  return out
}

export function patchGateway(sources) {
  const out = {}
  for (const file of EDITED_FILES) {
    if (typeof sources[file] !== 'string') throw new Error(`missing source for ${file}`)
    out[file] = patchFile(file, sources[file])
  }
  return out
}

export { MARKER, EDITS, NEW_FILES, EDITED_FILES }