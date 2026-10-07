'use strict'
// The launcher update runs only if it is the very file the Dovakarn server names by its SHA-256: a
// download host or a redirect could hand over anything.
const crypto = require('crypto')
const fs = require('fs')

// The SHA-256 the server names for the update, or null when it names none that can be checked
function namedHash(data) {
  const hash = String((data && data.sha256) || '').toLowerCase()
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null
}

// Whether the downloaded file is the one named; one that is not is deleted, and one that is missing simply is not it
function isNamedFile(file, hash) {
  let bytes
  try { bytes = fs.readFileSync(file) } catch { return false }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex')
  if (actual === hash) return true
  try { fs.unlinkSync(file) } catch { /* already gone */ }
  return false
}

// An update that did not change the launcher's version is tried again, since an install can fail (the Windows admin
// prompt answered No, antivirus, a locked file); the same file tried this many times from the same version is an older
// build the server names as a newer one, and is not offered again. attempt: { sha256, fromVersion, attempts }, what the
// launcher recorded when it last started an installer.
const MAX_ATTEMPTS = 3
function sameAttempt(data, attempt, current) {
  const hash = namedHash(data)
  return !!hash && !!attempt && attempt.sha256 === hash && attempt.fromVersion === current
}
function triedOut(data, attempt, current) {
  return sameAttempt(data, attempt, current) && Number(attempt.attempts) >= MAX_ATTEMPTS
}
// What to record as this file's installer starts
function nextAttempt(data, attempt, current) {
  return { sha256: namedHash(data), fromVersion: current, attempts: sameAttempt(data, attempt, current) ? Math.max(0, Number(attempt.attempts) || 0) + 1 : 1 }
}

// Cancel pressed on the page is said as stopped, so the page does not call it a failure
const failure = err => err.code === 'CANCELLED' ? { ok: false, error: err.message, cancelled: true } : { ok: false, error: err.message }

// The in-app update: the installer the server names is downloaded over HTTPS to dest, and run silently (it replaces the
// launcher and starts it again) only if it is that very file. fetchVersion: the server's /api/version answer;
// download(url, dest, onProgress); run(file); quit(): lets the installer replace the running launcher. current: this
// launcher's version; attempt and remember(attempt): the attempt record (nextAttempt), kept once the installer started.
async function installUpdate({ fetchVersion, download, run, quit, progress = () => {}, dest, current = '', attempt = null, remember = () => {} }) {
  try {
    const data = await fetchVersion()
    if (!data || !data.downloadUrl) return { ok: false, error: 'No download URL is configured on the server.' }
    // The installer runs with the user's rights: never fetched over anything but HTTPS
    if (!/^https:/i.test(data.downloadUrl)) return { ok: false, error: 'Refusing to install an update from a non-HTTPS URL.' }
    const expected = namedHash(data)
    if (!expected) return { ok: false, error: 'The server did not say which update file to trust, so none was installed.' }
    if (triedOut(data, attempt, current)) return { ok: false, error: `This update was tried ${MAX_ATTEMPTS} times and the launcher is still version ${current}. Download the launcher from the Dovakarn Discord instead, and tell the staff the update did not work.` }
    // A file downloadUpdate() already fetched and verified installs at once, with no second download.
    if (!isNamedFile(dest, expected)) {
      progress({ phase: 'download', received: 0, total: 0 })
      await download(data.downloadUrl, dest, (received, total) => progress({ phase: 'download', received, total }))
      if (!isNamedFile(dest, expected)) {
        return { ok: false, error: 'The downloaded update is not the file the Dovakarn server named, so it was not installed. Try again later.' }
      }
    }
    progress({ phase: 'install' })
    // Recorded only once the installer has started: one that could not start is simply tried again
    run(dest)
    remember(nextAttempt(data, attempt, current))
    quit()
    return { ok: true }
  } catch (err) {
    return failure(err)
  }
}

// Fetches and verifies the named installer without running it, so the install itself is one instant press.
async function downloadUpdate({ fetchVersion, download, dest, current = '', attempt = null, progress = () => {} }) {
  try {
    const data = await fetchVersion()
    if (!data || !data.downloadUrl) return { ok: false, error: 'No download URL is configured on the server.' }
    if (!/^https:/i.test(data.downloadUrl)) return { ok: false, error: 'Refusing to fetch an update from a non-HTTPS URL.' }
    const expected = namedHash(data)
    if (!expected) return { ok: false, error: 'The server did not say which update file to trust, so none was fetched.' }
    if (triedOut(data, attempt, current)) return { ok: false, error: `This update was tried ${MAX_ATTEMPTS} times and the launcher is still version ${current}.` }
    if (!isNamedFile(dest, expected)) {
      progress({ phase: 'download', received: 0, total: 0 })
      await download(data.downloadUrl, dest, (received, total) => progress({ phase: 'download', received, total }))
      if (!isNamedFile(dest, expected)) return { ok: false, error: 'The downloaded update is not the file the Dovakarn server named.' }
    }
    return { ok: true, version: data.version || '' }
  } catch (err) {
    return failure(err)
  }
}

module.exports = { namedHash, isNamedFile, MAX_ATTEMPTS, sameAttempt, triedOut, nextAttempt, installUpdate, downloadUpdate }
