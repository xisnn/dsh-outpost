#!/usr/bin/env node
/**
 * Apply / verify / roll back the D-3 home-isolation + single-owner patch.
 *
 * Why a script instead of editing node_modules by hand: one `npm install` or
 * plugin upgrade silently restores the vulnerable code. This patch is a
 * replayable text transformation guarded by a version + SHA-256 whitelist, so
 * it either applies completely to a known file or refuses to write anything.
 *
 * Usage:
 *   node patches/mobile-gateway-home-isolation/apply.mjs --check
 *   node patches/mobile-gateway-home-isolation/apply.mjs --apply
 *   node patches/mobile-gateway-home-isolation/apply.mjs --revert
 *   node patches/mobile-gateway-home-isolation/apply.mjs --apply --path=<plugin root>
 *
 * <plugin root> is the directory containing package.json and lib/.
 * Exit code: 0 = desired state reached; 1 = needs attention / failed.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { EDITED_FILES, MARKER, NEW_FILES, patchGateway } from './patch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE = path.join(HERE, 'state.json')

/**
 * Reviewed source variants per plugin version -> SHA-256 of each file we edit.
 *
 * The management-auth patch (`patches/mobile-gateway-mgmt-auth`) is normally
 * applied first, so `lib/index.mjs` has two reviewed spellings. Both are listed
 * explicitly; anything else is refused. Anchors are text-based and forcing them
 * onto unknown code produces semantically wrong security code, which is worse
 * than no patch.
 */
const KNOWN_SOURCES = {
  '0.10.3': [
    {
      label: 'pristine',
      files: {
        'lib/index.mjs': '7f9f38f36183fa4621675d49de2f3c2456452c048bdc6a38412a7a2724cb7413',
        'lib/devices.js': '633957558c0fb05fced1b73cfa8b76f7fdfb9bad8cb09fbd9f1af5d82bae3503',
        'lib/gateway-state.mjs': '971fbc1052ee49a1585db7124c20f16b36dddfe4c49759e4a6c48ca13b553c75',
      },
    },
    {
      label: 'mgmt-auth-patched',
      files: {
        'lib/index.mjs': '602a3ed1f45e0f11cb28fc0b30900019cb7bddb9af6fbfb13b1f265f55cb9fcb',
        'lib/devices.js': '633957558c0fb05fced1b73cfa8b76f7fdfb9bad8cb09fbd9f1af5d82bae3503',
        'lib/gateway-state.mjs': '971fbc1052ee49a1585db7124c20f16b36dddfe4c49759e4a6c48ca13b553c75',
      },
    },
  ],
}

/**
 * Backups use a patch-specific suffix. Sharing `.orig` with the management-auth
 * patch would make `--revert` restore the pristine file and silently drop that
 * patch's authentication, so each patch owns its own backup name.
 */
const BACKUP_SUFFIX = '.pre-home-isolation.orig'

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function defaultPluginRoot() {
  return path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-plugin-mobile-gateway')
}

function readPluginVersion(root) {
  try {
    let text = readFileSync(path.join(root, 'package.json'), 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const pkg = JSON.parse(text)
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function parseArgs(argv) {
  const out = { mode: 'check', target: '' }
  for (const a of argv) {
    if (a === '--check') out.mode = 'check'
    else if (a === '--apply') out.mode = 'apply'
    else if (a === '--revert') out.mode = 'revert'
    else if (a.startsWith('--path=')) out.target = a.slice('--path='.length)
    else if (a === '--help' || a === '-h') out.mode = 'help'
  }
  return out
}

function fail(message) {
  console.error(`✗ ${message}`)
  process.exitCode = 1
}

function ok(message) {
  console.log(`✓ ${message}`)
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  try {
    if (!existsSync(HERE)) mkdirSync(HERE, { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // A missing state file does not undo the patch; --check still detects it.
  }
}

function readNewFileSources() {
  const out = {}
  for (const relative of NEW_FILES) {
    const payload = path.join(HERE, 'files', path.basename(relative))
    if (!existsSync(payload)) throw new Error(`patch payload is missing: ${payload}`)
    out[relative] = readFileSync(payload, 'utf8')
  }
  return out
}

function isPatched(root) {
  return EDITED_FILES.every((relative) => {
    const file = path.join(root, relative)
    return existsSync(file) && readFileSync(file, 'utf8').includes(MARKER)
  }) && NEW_FILES.every((relative) => existsSync(path.join(root, relative)))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'help') {
    console.log([
      'Usage: node apply.mjs [--check|--apply|--revert] [--path=<plugin root>]',
      '',
      '  --check   report whether the patch is applied (default)',
      '  --apply   apply the patch (idempotent, all-or-nothing)',
      '  --revert  restore the .orig backups and remove the added modules',
      '',
      'Default root: ~/.dsh/profiles/web/node_modules/dsh-plugin-mobile-gateway',
      'Pass --path to target an isolated profile instead of the formal one.',
    ].join('\n'))
    return
  }

  const root = args.target || defaultPluginRoot()
  if (!existsSync(path.join(root, 'package.json'))) {
    fail(`not a plugin directory: ${root}`)
    return
  }
  const version = readPluginVersion(root)

  if (args.mode === 'check') {
    if (!isPatched(root)) {
      fail(`patch is NOT applied (plugin ${version}) at ${root}`)
      console.error('  The gateway would resolve its device registry from os.homedir() only,')
      console.error('  ignoring DSH_HOME, and would allow two instances to share one registry.')
      console.error('  Run: node patches/mobile-gateway-home-isolation/apply.mjs --apply')
      return
    }
    ok(`patch is applied (plugin ${version}) at ${root}`)
    const state = readState()
    if (state && state.files) {
      for (const [relative, expected] of Object.entries(state.files)) {
        const file = path.join(root, relative)
        if (!existsSync(file)) {
          fail(`patched file is missing: ${relative}`)
          continue
        }
        const actual = sha256(readFileSync(file, 'utf8'))
        if (actual !== expected.patchedHash) fail(`${relative} changed after patching; re-apply`)
      }
    }
    return
  }

  if (args.mode === 'apply') {
    if (isPatched(root)) {
      ok(`patch already applied (plugin ${version}); nothing to do`)
      return
    }
    const variants = KNOWN_SOURCES[version]
    if (!variants) {
      fail(`plugin version ${version} is not in the reviewed whitelist`)
      console.error(`  known versions: ${Object.keys(KNOWN_SOURCES).join(', ')}`)
      console.error('  Review the anchors against the new source, then add its digests to KNOWN_SOURCES.')
      for (const relative of EDITED_FILES) {
        const file = path.join(root, relative)
        if (existsSync(file)) console.error(`  ${relative} SHA-256 = ${sha256(readFileSync(file, 'utf8'))}`)
      }
      return
    }

    const sources = {}
    const digests = {}
    for (const relative of EDITED_FILES) {
      const file = path.join(root, relative)
      if (!existsSync(file)) {
        fail(`missing plugin file: ${file}`)
        return
      }
      const text = readFileSync(file, 'utf8')
      if (text.includes(MARKER)) {
        fail(`${relative} is partially patched; revert before re-applying`)
        return
      }
      sources[relative] = text
      digests[relative] = sha256(text)
    }

    const variant = variants.find((candidate) => EDITED_FILES.every((relative) => candidate.files[relative] === digests[relative]))
    if (!variant) {
      fail(`no reviewed source variant matches this installation (plugin ${version})`)
      for (const relative of EDITED_FILES) {
        console.error(`  ${relative} actual ${digests[relative]}`)
        for (const candidate of variants) console.error(`    ${candidate.label}: ${candidate.files[relative]}`)
      }
      console.error('  Refusing to patch a file that is not a reviewed source.')
      return
    }

    // Compute everything before writing anything: a failure must leave the
    // installation untouched rather than half-patched.
    let patched
    let added
    try {
      patched = patchGateway(sources)
      added = readNewFileSources()
    } catch (error) {
      fail(`patch transformation failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const state = { version, variant: variant.label, files: {}, addedFiles: NEW_FILES, at: new Date().toISOString() }
    try {
      for (const relative of EDITED_FILES) {
        const file = path.join(root, relative)
        const backup = file + BACKUP_SUFFIX
        if (!existsSync(backup)) copyFileSync(file, backup)
        writeFileSync(file, patched[relative], 'utf8')
        state.files[relative] = { pristineHash: sha256(sources[relative]), patchedHash: sha256(patched[relative]) }
      }
      for (const relative of NEW_FILES) {
        const file = path.join(root, relative)
        if (existsSync(file)) {
          const current = readFileSync(file, 'utf8')
          if (current !== added[relative]) {
            throw new Error(`${relative} already exists with different content; refusing to overwrite`)
          }
        } else {
          writeFileSync(file, added[relative], 'utf8')
        }
        state.files[relative] = { pristineHash: null, patchedHash: sha256(added[relative]) }
      }
    } catch (error) {
      fail(`write failed: ${error instanceof Error ? error.message : String(error)}`)
      console.error('  Run --revert to restore the backups before retrying.')
      writeState(state)
      return
    }

    writeState(state)
    ok(`patch applied (plugin ${version}, source variant "${variant.label}") at ${root}`)
    console.log(`  Backups: lib/*${BACKUP_SUFFIX}`)
    console.log('  Restart the DSH instance for the change to take effect.')
    return
  }

  if (args.mode === 'revert') {
    let restored = 0
    for (const relative of EDITED_FILES) {
      const file = path.join(root, relative)
      const backup = file + BACKUP_SUFFIX
      if (!existsSync(backup)) {
        fail(`no backup for ${relative}; cannot restore`)
        continue
      }
      copyFileSync(backup, file)
      restored += 1
    }
    for (const relative of NEW_FILES) {
      const file = path.join(root, relative)
      if (existsSync(file)) rmSync(file, { force: true })
    }
    // Restoring our own backup leaves any earlier patch (e.g. management auth)
    // exactly as it was; only this patch's changes are undone.
    ok(`reverted ${restored} file(s) and removed the added modules at ${root}`)
    console.log('  The gateway returns to os.homedir()-only resolution and shared-registry behaviour.')
  }
}

main()