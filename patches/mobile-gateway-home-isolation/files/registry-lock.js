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
// Concurrency contract (P4-0.2, fixes the P4-0.1 reclaim-ticket TOCTOU):
//   * Ownership is established if and only if a process wins an atomic exclusive
//     create (`wx` -> CREATE_NEW on Windows, O_EXCL on POSIX) of the lock path.
//     That single primitive is the only ownership arbitration. The P4-0.1
//     reclaim ticket - a second mutable file whose deletion raced - is gone.
//   * Reclaiming a dead owner's lock is an atomic rename take-away: exactly one
//     racer can move the dead record to a private grave (the filesystem permits
//     one winner; losers see ENOENT and re-read). The winner verifies it took
//     precisely the dead record it judged, then publishes by exclusive create.
//     No shared state is ever unlinked on a stale judgment, so two processes can
//     no longer both judge a ticket dead and delete each other's live ticket.
//   * The take-away leaves the lock path briefly absent. A reclaim marker naming
//     the LIVE reclaiming pid guards that window: a fresh creator that lands in
//     it backs off, so no second owner slips in mid-reclaim. A marker left by a
//     crashed reclaimer names a dead pid and is inert: it is recovered, never
//     honoured, so crash recovery still works.
//   * If a take-away ever lands on a live record (a concurrent reclaimer
//     published in the read->take window), the record is atomically restored and
//     the process refuses to start. A live owner's record is never destroyed.
//   * Release takes the lock to a private grave and unlinks it only after
//     re-reading and confirming our own token. A process never deletes a lock
//     that names somebody else.
//   * Unreadable, malformed, permission-denied or live-foreign state fails
//     closed. There is no fallback to an unlocked mode.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const LOCK_SUFFIX = '.lock'
const LOCK_VERSION = 1
const MAX_ATTEMPTS = 6
const RECLAIM_PREFIX = '.reclaim.'
const RECLAIMING_PREFIX = '.reclaiming.'
const RELEASED_PREFIX = '.released.'

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
  } catch (error) {
    // EPERM means the process exists but belongs to another user: still alive.
    return error && error.code === 'EPERM'
  }
  // A SIGKILLed process stays a zombie until its parent reaps it, and
  // kill(pid,0) still succeeds for a zombie. A zombie cannot hold the lock or
  // run, so it must count as dead or crash recovery would refuse forever on
  // Linux. Windows has no zombies; /proc is absent there and on other platforms.
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
      if (state === 'Z' || state === 'X') return false
    } catch {
      // Unreadable /proc: fall through and treat as alive (fail closed).
    }
  }
  return true
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

function makeRecord(token, label, key) {
  return {
    version: LOCK_VERSION,
    pid: process.pid,
    token,
    label,
    file: key,
    createdAt: new Date().toISOString(),
  }
}

// Take a record to a private grave and unlink it only if it still names `token`.
// Used for release and for backing off a fresh create; never deletes a record
// that names somebody else. Returns true if our record was removed.
function takeAwayIfOurs(lockPath, token, gravePrefix) {
  const current = readRecord(lockPath)
  if (!current.ok || current.rec.token !== token) return false
  const grave = `${lockPath}${gravePrefix}${token}`
  try {
    fs.renameSync(lockPath, grave)
  } catch {
    return false
  }
  const moved = readRecord(grave)
  if (moved.ok && moved.rec.token === token) {
    try { fs.unlinkSync(grave) } catch { /* inert leftover */ }
    return true
  }
  // Not ours after the move (should not happen for a live owner): put it back.
  try { fs.renameSync(grave, lockPath) } catch { /* leave for manual recovery */ }
  return false
}

function releaseOnDisk(key, token) {
  takeAwayIfOurs(key + LOCK_SUFFIX, token, RELEASED_PREFIX)
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

// Reclaim markers and graves live beside the lock as `<lock>.reclaiming.<uuid>`
// (the live reclaimer's identity) and `<lock>.reclaim.<uuid>` (the taken record).
function sidecars(lockPath, prefix) {
  const dir = path.dirname(lockPath)
  const base = path.basename(lockPath) + prefix
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => n.startsWith(base)).map((n) => path.join(dir, n))
}

// A fresh create that landed in the lock-absent window must defer to any live
// reclaimer (its marker names a live pid). Returns true if a live reclaim is in
// progress, meaning the fresh creator must back off rather than become owner.
function liveReclaimInProgress(lockPath) {
  for (const marker of sidecars(lockPath, RECLAIMING_PREFIX)) {
    const rec = readRecord(marker)
    if (rec.ok && isAlive(rec.rec.pid)) return true
  }
  return false
}

// A crashed reclaimer may have taken a LIVE owner's record and died before
// restoring it, leaving that record in a grave while its marker names a dead
// pid and the lock path is absent. Restore such an orphaned live record so its
// owner is not displaced by a fresh create; clean inert dead graves. Returns
// true if an orphan was restored (caller must fail closed: that process owns).
function recoverCrashedReclaim(lockPath) {
  let restored = false
  for (const marker of sidecars(lockPath, RECLAIMING_PREFIX)) {
    const m = readRecord(marker)
    if (m.ok && isAlive(m.rec.pid)) continue // live reclaimer: not ours to touch
    // Dead reclaimer. Its grave (if any) holds the record it took.
    const grave = m.ok ? `${lockPath}${RECLAIM_PREFIX}${m.rec.token}` : null
    if (grave) {
      const taken = readRecord(grave)
      if (taken.ok && isAlive(taken.rec.pid)) {
        // Orphaned LIVE owner displaced by a crashed reclaim: put it back.
        try {
          fs.linkSync(grave, lockPath)
          try { fs.unlinkSync(grave) } catch { /* inert */ }
          restored = true
        } catch {
          // Lock path re-occupied by a legitimate owner; leave the grave.
        }
      } else {
        try { fs.unlinkSync(grave) } catch { /* inert dead record */ }
      }
    }
    try { fs.unlinkSync(marker) } catch { /* inert */ }
  }
  return restored
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

      // Dead owner: mark the reclaim window with our LIVE pid, take the dead
      // record atomically, verify, then publish by exclusive create.
      const staleToken = owner.rec.token
      const marker = `${lockPath}${RECLAIMING_PREFIX}${token}`
      let markerFd
      try {
        markerFd = fs.openSync(marker, 'wx')
        writeRecordFully(markerFd, { version: LOCK_VERSION, pid: process.pid, token, staleToken })
      } catch (markerError) {
        if (markerFd !== undefined) fs.closeSync(markerFd)
        if (markerError && markerError.code === 'EEXIST') {
          // Our per-attempt marker name collided (a leftover of our own earlier
          // attempt). Clear it and retry; markers never arbitrate ownership.
          try { fs.unlinkSync(marker) } catch { /* inert */ }
          sleepSync(20)
          continue
        }
        throw lockError(label, file, `cannot mark the reclaim (${markerError.message})`, markerError)
      }
      fs.closeSync(markerFd)

      const grave = `${lockPath}${RECLAIM_PREFIX}${token}`
      try {
        // Re-confirm dead immediately before the take; the post-take check is
        // the authoritative guard against a concurrent live publication.
        const confirm = readRecord(lockPath)
        if (!confirm.ok || confirm.rec.token !== staleToken || isAlive(confirm.rec.pid)) {
          sleepSync(20)
          continue
        }
        try {
          fs.renameSync(lockPath, grave)
        } catch (renameError) {
          if (renameError && renameError.code === 'ENOENT') {
            sleepSync(20)
            continue
          }
          throw lockError(label, file, `cannot take the stale lock (${renameError.message})`, renameError)
        }
        const taken = readRecord(grave)
        if (!taken.ok || taken.rec.token !== staleToken || isAlive(taken.rec.pid)) {
          // Took a live/foreign record: restore it atomically, never own over it.
          try {
            fs.linkSync(grave, lockPath)
            try { fs.unlinkSync(grave) } catch { /* inert */ }
          } catch {
            throw lockError(label, file, `a concurrent reclaim changed the lock; refusing to start (manual recovery: inspect ${grave})`)
          }
          sleepSync(20)
          continue
        }
        // We provably hold the dead record. Publish exclusively; a fresh owner
        // that created into the window legitimately owns and we defer.
        try {
          descriptor = fs.openSync(lockPath, 'wx')
        } catch (publishError) {
          try { fs.unlinkSync(grave) } catch { /* inert dead record */ }
          if (publishError && publishError.code === 'EEXIST') {
            sleepSync(20)
            continue
          }
          throw lockError(label, file, `cannot publish the replacement lock (${publishError.message})`, publishError)
        }
        try {
          writeRecordFully(descriptor, makeRecord(token, label, key))
        } finally {
          fs.closeSync(descriptor)
        }
        try { fs.unlinkSync(grave) } catch { /* inert dead record */ }
        try { fs.chmodSync(lockPath, 0o600) } catch { /* Windows has no POSIX bits */ }
        held.set(key, { refs: 1, token })
        return makeRelease(key, token)
      } finally {
        // Our marker guards only this attempt's window; always clear it.
        try { fs.unlinkSync(marker) } catch { /* inert */ }
      }
    }

    // Exclusive create succeeded: the lock path was absent and is now an empty
    // file exclusively ours. Defer to any live reclaimer mid-transition, and
    // recover a live record orphaned by a crashed reclaim, before claiming it.
    if (liveReclaimInProgress(lockPath)) {
      fs.closeSync(descriptor)
      try { fs.unlinkSync(lockPath) } catch { /* our empty fresh create */ }
      sleepSync(20)
      continue
    }
    // Drop our empty placeholder so an orphaned live record can be restored to
    // the path; if one is recovered its owner keeps the file and we fail closed.
    fs.closeSync(descriptor)
    try { fs.unlinkSync(lockPath) } catch { /* our empty fresh create */ }
    if (recoverCrashedReclaim(lockPath)) {
      throw lockError(label, file, 'recovered a live owner displaced by a crashed reclaim; refusing to start concurrently')
    }
    // Path is clear: claim it exclusively again and publish our record.
    try {
      descriptor = fs.openSync(lockPath, 'wx')
    } catch (recreateError) {
      if (recreateError && recreateError.code === 'EEXIST') {
        sleepSync(20)
        continue
      }
      throw lockError(label, file, `cannot create the lock file (${recreateError.message})`, recreateError)
    }
    try {
      writeRecordFully(descriptor, makeRecord(token, label, key))
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