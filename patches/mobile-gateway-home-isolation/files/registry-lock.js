// Exclusive ownership of a persisted gateway data file.
//
// The device registry and the gateway identity are both loaded into memory once
// and written back whole. Two independent processes sharing one file therefore
// overwrite each other's snapshots: a revocation performed by one instance is
// invisible to the other, which keeps honouring the revoked credential, and a
// stale snapshot can resurrect a deleted device or roll back `lastSeenAt`.
//
// Rather than merge concurrent writers, this module makes the unsafe
// configuration impossible: one live owner per file. A second process is
// refused at startup (fail closed) instead of silently sharing credentials.
//
// Legitimate usage is preserved:
//   * distinct files never interfere (the supported multi-gateway layout);
//   * several components inside ONE process may open the same file - they are
//     reentrant and share a reference count, so sequential reuse keeps working;
//   * a lock left behind by a crashed process is reclaimed once its pid is gone.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const LOCK_SUFFIX = '.lock'
const LOCK_VERSION = 1

// canonical path -> { refs, token }
const held = new Map()
let exitHookInstalled = false

function canonicalKey(file) {
  const absolute = path.resolve(file)
  const directory = path.dirname(absolute)
  let realDirectory = directory
  try {
    realDirectory = fs.realpathSync(directory)
  } catch {
    // The data directory may not exist yet; the absolute spelling is the best
    // canonical form available and is stable for a given configuration.
  }
  return path.join(realDirectory, path.basename(absolute))
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive.
    return error && error.code === 'EPERM'
  }
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const [key, entry] of held) {
      try {
        const lockPath = key + LOCK_SUFFIX
        const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
        if (current && current.token === entry.token) fs.unlinkSync(lockPath)
      } catch {
        // Already removed or unreadable: nothing left to release.
      }
    }
    held.clear()
  })
}

function makeRelease(key, token) {
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = held.get(key)
    if (!entry || entry.token !== token) return
    entry.refs -= 1
    if (entry.refs > 0) return
    held.delete(key)
    const lockPath = key + LOCK_SUFFIX
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      if (current && current.token === token) fs.unlinkSync(lockPath)
    } catch {
      // The lock is already gone; releasing must not throw during shutdown.
    }
  }
}

function lockError(label, file, reason, cause) {
  return new Error(`failed to lock ${label} ${file}: ${reason}`, cause ? { cause } : undefined)
}

/**
 * Take exclusive ownership of `file`.
 * @param {string} file data file to own
 * @param {string} label human-readable kind used in error messages
 * @returns {() => void} release function; safe to call more than once
 */
function acquireRegistryLock(file, label) {
  if (typeof file !== 'string' || file === '') throw new Error('a data file path is required')
  const key = canonicalKey(file)
  const lockPath = key + LOCK_SUFFIX

  const existing = held.get(key)
  if (existing) {
    existing.refs += 1
    return makeRelease(key, existing.token)
  }

  installExitHook()
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  } catch (error) {
    throw lockError(label, file, `cannot create the data directory (${error.message})`, error)
  }

  const token = crypto.randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor
    try {
      descriptor = fs.openSync(lockPath, 'wx')
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw lockError(label, file, `cannot create the lock file (${error.message})`, error)
      }
      let owner
      try {
        owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      } catch (readError) {
        throw lockError(label, file, 'the lock file is unreadable; refusing to share the data file', readError)
      }
      if (!owner || owner.version !== LOCK_VERSION || !Number.isInteger(owner.pid) || typeof owner.token !== 'string') {
        throw lockError(label, file, 'the lock file is malformed; refusing to share the data file')
      }
      if (owner.pid === process.pid) {
        // Same process, but untracked (a previous owner never released). Adopt
        // it rather than deadlock: components in one process may share.
        held.set(key, { refs: 1, token: owner.token })
        return makeRelease(key, owner.token)
      }
      if (isAlive(owner.pid)) {
        throw lockError(
          label, file,
          `already owned by live process ${owner.pid}. Two independent instances must not share one `
          + 'device registry: they would overwrite each other\'s snapshots and keep honouring revoked '
          + 'credentials. Give each instance its own DSH_HOME or deviceFile. If that process is gone, '
          + `remove ${lockPath} and retry.`,
        )
      }
      try {
        fs.unlinkSync(lockPath)
      } catch (unlinkError) {
        if (!unlinkError || unlinkError.code !== 'ENOENT') {
          throw lockError(label, file, `cannot reclaim the stale lock (${unlinkError.message})`, unlinkError)
        }
      }
      continue
    }

    const record = {
      version: LOCK_VERSION,
      pid: process.pid,
      token,
      label,
      file: key,
      createdAt: new Date().toISOString(),
    }
    try {
      fs.writeSync(descriptor, `${JSON.stringify(record, null, 2)}\n`)
    } finally {
      fs.closeSync(descriptor)
    }
    try {
      fs.chmodSync(lockPath, 0o600)
    } catch {
      // Windows does not model POSIX mode bits; the lock carries no secret.
    }
    held.set(key, { refs: 1, token })
    return makeRelease(key, token)
  }

  throw lockError(label, file, 'could not acquire ownership after reclaiming a stale lock')
}

module.exports = { acquireRegistryLock, LOCK_SUFFIX }