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
//
// Concurrency contract (P4-0.1, fixes the P4-0 stale-reclaim TOCTOU):
//   * Every creation is an atomic exclusive create (`wx` -> CREATE_NEW on
//     Windows, O_EXCL on POSIX). It is the only arbitration primitive.
//   * Reclaiming a dead owner's lock never unlinks the live lock path. It runs
//     under a per-stale-token reclaim ticket (itself an atomic `wx` create) and
//     finishes with an atomic rename-replace of a fully written temp record.
//     Rename-replace leaves no window in which the lock path is absent, so no
//     third process can slip in an exclusive create mid-reclaim.
//   * A reclaim ticket is only ever removed after its recorded owner pid is
//     proven dead. While a ticket exists no other ticket can be created at that
//     name, so removing a dead ticket cannot destroy a live one.
//   * Release renames the lock to a private graveyard name and unlinks that,
//     and only after re-reading the record and confirming our own token. A
//     process never deletes a lock that names somebody else.
//   * Unreadable, malformed, permission-denied or live-foreign state fails
//     closed. There is no fallback to an unlocked mode.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const LOCK_SUFFIX = '.lock'
const LOCK_VERSION = 1
const TICKET_KIND = 'reclaim-ticket'
const MAX_ATTEMPTS = 6

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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isRecord(rec) {
  return !!rec && rec.version === LOCK_VERSION
    && Number.isInteger(rec.pid) && typeof rec.token === 'string' && rec.token !== ''
}

// A lock is briefly empty between its exclusive create and its first write.
// Retry reads a few times so a concurrent writer does not cause a spurious
// fail-closed startup; a persistently unreadable lock still fails closed.
function readRecord(lockPath) {
  for (let i = 0; i < 3; i += 1) {
    let text
    try {
      text = fs.readFileSync(lockPath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: false, code: 'missing' }
      return { ok: false, code: 'unreadable', error }
    }
    try {
      const rec = JSON.parse(text)
      if (isRecord(rec)) return { ok: true, rec }
      return { ok: false, code: 'malformed' }
    } catch {
      if (i === 2) return { ok: false, code: 'unreadable' }
      sleepSync(20)
    }
  }
  return { ok: false, code: 'unreadable' }
}

function writeRecordFully(fd, rec) {
  fs.writeSync(fd, `${JSON.stringify(rec, null, 2)}\n`)
  try {
    fs.fsyncSync(fd)
  } catch {
    // Some filesystems reject fsync on a fresh file; the close below still
    // publishes the record. Never treat this as ownership.
  }
}

// Remove the on-disk lock only if it still names `token`. Renaming to a private
// graveyard first means we never unlink a path that a new owner may have
// created: the graveyard name carries our own token.
function releaseOnDisk(key, token) {
  const lockPath = key + LOCK_SUFFIX
  const current = readRecord(lockPath)
  if (!current.ok || current.rec.token !== token) return
  const grave = `${lockPath}.released.${token}`
  try {
    fs.renameSync(lockPath, grave)
  } catch {
    // Already gone or not ours to move: nothing left to release.
    return
  }
  const moved = readRecord(grave)
  if (moved.ok && moved.rec.token === token) {
    try {
      fs.unlinkSync(grave)
    } catch {
      // Leftover graveyard file is inert; never delete anything else.
    }
  }
}

function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const [key, entry] of held) {
      releaseOnDisk(key, entry.token)
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
    releaseOnDisk(key, token)
  }
}

function lockError(label, file, reason, cause) {
  return new Error(`failed to lock ${label} ${file}: ${reason}`, cause ? { cause } : undefined)
}

function ownerMessage(label, file, lockPath, pid) {
  return lockError(
    label, file,
    `already owned by live process ${pid}. Two independent instances must not share one `
    + 'device registry: they would overwrite each other\'s snapshots and keep honouring revoked '
    + 'credentials. Give each instance its own DSH_HOME or deviceFile. If that process is gone, '
    + `remove ${lockPath} and retry.`,
  )
}

// Try to become the sole reclaimer of the stale lock named `staleToken`.
// Returns 'created' | 'stale-ticket' | 'held-by-live' | 'bad'.
function claimReclaimTicket(ticketPath, staleToken, myToken, label, file) {
  let fd
  try {
    fd = fs.openSync(ticketPath, 'wx')
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw lockError(label, file, `cannot create the reclaim ticket (${error.message})`, error)
    }
    const t = readRecord(ticketPath)
    if (!t.ok || t.rec.kind !== TICKET_KIND || t.rec.staleToken !== staleToken) {
      return 'bad'
    }
    if (t.rec.pid === process.pid) {
      // Our own earlier attempt died inside this process; the ticket is inert.
      try { fs.unlinkSync(ticketPath) } catch { /* raced away */ }
      return 'stale-ticket'
    }
    if (isAlive(t.rec.pid)) return 'held-by-live'
    // Dead ticket owner. While this ticket exists nobody else can create one at
    // this name, so unlinking it cannot destroy a live reclaimer's ticket.
    try { fs.unlinkSync(ticketPath) } catch { /* raced away */ }
    return 'stale-ticket'
  }
  try {
    writeRecordFully(fd, {
      kind: TICKET_KIND,
      version: LOCK_VERSION,
      pid: process.pid,
      token: myToken,
      staleToken,
      createdAt: new Date().toISOString(),
    })
  } finally {
    fs.closeSync(fd)
  }
  return 'created'
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
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let descriptor
    try {
      descriptor = fs.openSync(lockPath, 'wx')
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw lockError(label, file, `cannot create the lock file (${error.message})`, error)
      }
      const owner = readRecord(lockPath)
      if (!owner.ok) {
        throw lockError(
          label, file,
          owner.code === 'missing'
            ? 'the lock file disappeared while reading it; refusing to guess ownership'
            : `the lock file is ${owner.code}; refusing to share the data file (manual recovery: inspect ${lockPath})`,
          owner.error,
        )
      }
      if (owner.rec.pid === process.pid) {
        // Same process, but untracked (a previous owner never released). Adopt
        // it rather than deadlock: components in one process may share.
        held.set(key, { refs: 1, token: owner.rec.token })
        return makeRelease(key, owner.rec.token)
      }
      if (isAlive(owner.rec.pid)) throw ownerMessage(label, file, lockPath, owner.rec.pid)

      // Dead owner: reclaim under an atomic ticket, then publish by atomic
      // rename-replace so the lock path is never absent mid-reclaim.
      const staleToken = owner.rec.token
      const ticketPath = `${lockPath}.reclaim.${staleToken}`
      const ticket = claimReclaimTicket(ticketPath, staleToken, token, label, file)
      if (ticket === 'bad') {
        throw lockError(label, file, `the reclaim ticket is malformed; refusing to share the data file (manual recovery: inspect ${ticketPath})`)
      }
      if (ticket === 'held-by-live') {
        throw lockError(label, file, `another live process is reclaiming the stale lock (${ticketPath}); refusing to start concurrently`)
      }
      if (ticket === 'stale-ticket') {
        sleepSync(20)
        continue
      }

      // We hold the ticket. Re-verify the lock is still exactly the stale
      // record we saw; only then may we replace it.
      const underTicket = readRecord(lockPath)
      if (!underTicket.ok || underTicket.rec.token !== staleToken || isAlive(underTicket.rec.pid)) {
        try { fs.unlinkSync(ticketPath) } catch { /* inert */ }
        sleepSync(20)
        continue
      }

      const tmp = `${lockPath}.tmp.${token}`
      let tmpFd
      try {
        tmpFd = fs.openSync(tmp, 'wx')
        writeRecordFully(tmpFd, {
          version: LOCK_VERSION,
          pid: process.pid,
          token,
          label,
          file: key,
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        if (tmpFd !== undefined) fs.closeSync(tmpFd)
        try { fs.unlinkSync(tmp) } catch { /* inert */ }
        try { fs.unlinkSync(ticketPath) } catch { /* inert */ }
        throw lockError(label, file, `cannot prepare the replacement lock (${error.message})`, error)
      }
      fs.closeSync(tmpFd)
      try {
        // Atomic replace on POSIX and Windows; no absence window.
        fs.renameSync(tmp, lockPath)
      } catch (error) {
        try { fs.unlinkSync(tmp) } catch { /* inert */ }
        try { fs.unlinkSync(ticketPath) } catch { /* inert */ }
        throw lockError(label, file, `cannot publish the replacement lock (${error.message})`, error)
      }
      try { fs.unlinkSync(ticketPath) } catch { /* inert leftover */ }
      try { fs.chmodSync(lockPath, 0o600) } catch { /* Windows has no POSIX bits */ }
      held.set(key, { refs: 1, token })
      return makeRelease(key, token)
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
      writeRecordFully(descriptor, record)
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

  throw lockError(label, file, 'could not acquire ownership after bounded reclaim attempts; refusing to start')
}

module.exports = { acquireRegistryLock, LOCK_SUFFIX }