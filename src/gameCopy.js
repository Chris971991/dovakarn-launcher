// Dovakarn's own game copy: Skyrim 1.6.1170 in <install folder>\Game, so the player's own Skyrim is never changed.
// It is made from the player's Steam Skyrim when that is already 1.6.1170, otherwise from Steam's own 1.6.1170 downloads
// (download_depot in Steam's console, signed in to the player's own account; the launcher never sees a Steam login).
// The player's Skyrim is only ever read. Every file is checked against vanilla-1.6.1170.json.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const REF = require('./vanilla-1.6.1170.json')

const GAME = 'Game'
const DOWNLOADS = 'Downloads'
const MARKER = 'Dovakarn game copy.json'
const PROFILE = 'Dovakarn Profile'
// Creation Club content every 1.6 install has; the copy only gets what the server's load order loads
const CC_FILE = /^Data\/(cc[a-z]{3}sse\d{3}-[^/]+|_resourcepack)\.(esm|esl|esp|bsa)$/i
const STANDALONE_BSA = /^Data\/marketplacetextures\.bsa$/i
// Written by the copy itself (the Creation Club plugins it keeps), so never one of the files copied and checked
const GENERATED = /^Skyrim\.ccc$/i

const stopped = () => Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
const checkStop = signal => { if (signal?.aborted) throw stopped() }
const fileSize = file => { try { const s = fs.statSync(file); return s.isFile() ? s.size : -1 } catch { return -1 } }

const gameDirOf = installDir => path.join(installDir, GAME)
const downloadsDirOf = installDir => path.join(installDir, DOWNLOADS)
const profileDirOf = gameDir => path.join(gameDir, PROFILE)

// The commands the player types in Steam's console, one per depot
const depotCommands = (ref = REF) => ref.depots.map(d => ({ id: d.id, command: `download_depot ${ref.app} ${d.id} ${d.manifest}` }))

// The vanilla files this server's game needs: the base game, and Creation Club content only if its plugin loads
function wantedFiles(loadOrder, ref = REF) {
  const loads = new Set((Array.isArray(loadOrder) ? loadOrder : []).map(p => path.basename(String(p)).toLowerCase()))
  return ref.files.filter(f => {
    if (STANDALONE_BSA.test(f.path) || GENERATED.test(f.path)) return false
    if (!CC_FILE.test(f.path)) return true
    const base = path.posix.basename(f.path).toLowerCase().replace(/\.[^.]+$/, '')
    return ['esm', 'esl', 'esp'].some(ext => loads.has(`${base}.${ext}`))
  })
}

// Steam's "path" lines in libraryfolders.vdf
function parseLibraryFolders(text) {
  return [...String(text).matchAll(/^\s*"path"\s+"(.+)"\s*$/gm)].map(m => m[1].replace(/\\\\/g, '\\'))
}

// Every folder Steam keeps games and downloads under: the client's own folder(s) and each library
function steamRoots(clientRoots = []) {
  const roots = []
  for (const root of clientRoots.filter(Boolean)) {
    roots.push(path.resolve(root))
    try { for (const lib of parseLibraryFolders(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'))) roots.push(path.resolve(lib)) } catch { /* no library list */ }
  }
  const seen = new Set()
  return roots.filter(r => !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()))
}

// Where each depot's download_depot output is, or null while it has not been downloaded
function findDepots(roots, ref = REF) {
  const out = {}
  for (const d of ref.depots) {
    out[d.id] = null
    for (const root of roots) {
      const dir = path.join(root, "steamapps", "content", `app_${ref.app}`, `depot_${d.id}`)
      try { if (fs.statSync(dir).isDirectory()) { out[d.id] = dir; break } } catch { /* not here */ }
    }
  }
  return out
}

// A file's size and change time: a source refused for its hash stays refused until this changes
const stampOf = file => { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}` } catch { return null } }

// Where each wanted file can come from, by size (the copy checks its SHA-256): a depot first, then the Steam folder.
// candidates: every source, tried in turn (a mod may have changed a file in the player's Skyrim and kept its size); from
// and kind: the first. refused (a Map the caller keeps, source path to stamp): sources an earlier build found with another
// hash, left out while unchanged and named in the entry's refused (their kinds)
function sources(wanted, { steamDir, depotDirs = {}, refused = null }) {
  return wanted.map(f => {
    const sized = [
      depotDirs[f.depot] && { from: path.join(depotDirs[f.depot], ...f.path.split('/')), kind: 'depot' },
      steamDir && { from: path.join(steamDir, ...f.path.split('/')), kind: 'steam' },
    ].filter(c => c && fileSize(c.from) === f.size)
    const isRefused = c => !!refused && refused.get(c.from.toLowerCase()) === stampOf(c.from)
    const candidates = sized.filter(c => !isRefused(c))
    return { ...f, from: candidates[0]?.from || null, kind: candidates[0]?.kind || null, candidates, refused: sized.filter(isRefused).map(c => c.kind) }
  })
}
// A source whose content is not the 1.6.1170 file: the next source is tried
const notReference = want => Object.assign(new Error(`${want.path} is not the 1.6.1170 file`), { code: 'NOT_REFERENCE' })
// No source left for a file: Steam's 1.6.1170 download is needed (or needs to finish)
function needsDepots(f) {
  const message = f.refused.includes('depot') ? `Steam's 1.6.1170 download of ${f.path} is not complete yet. Let Steam finish it, then press Install again.`
    : f.refused.includes('steam') ? `${f.path} in your Skyrim folder is not Skyrim 1.6.1170's own file. A mod may have changed it, so Dovakarn needs Steam's 1.6.1170 download.`
    : `${f.path} is not in your Skyrim folder or Steam's 1.6.1170 download.`
  return Object.assign(new Error(message), { code: 'NEEDS_DEPOTS', file: f.path })
}

const sha256Of = (file, signal, onBytes) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(stopped())
  const hash = crypto.createHash('sha256'), stream = fs.createReadStream(file)
  const onAbort = () => { stream.destroy(); reject(stopped()) }
  const off = () => { if (signal) signal.removeEventListener('abort', onAbort) }
  let read = 0
  stream.on('data', chunk => { hash.update(chunk); read += chunk.length; if (onBytes) onBytes(read) })
    .on('error', error => { off(); reject(error) }).on('end', () => { off(); resolve(hash.digest('hex')) })
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})

// Copies a file through a side file, hashing it on the way; only a file with the reference hash takes the real name
async function copyChecked(from, to, want, signal, onBytes) {
  const part = `${to}.dovakarn-part`
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    checkStop(signal)
    const sha256 = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256'), read = fs.createReadStream(from), write = fs.createWriteStream(part)
      let bytes = 0, done = false
      const onAbort = () => fail(stopped())
      const off = () => { if (signal) signal.removeEventListener('abort', onAbort) }
      // The side file is closed before the caller deletes it
      const fail = error => {
        if (done) return
        done = true; off(); read.destroy()
        if (write.closed) reject(error); else { write.once('close', () => reject(error)); write.destroy() }
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      read.on('data', chunk => { hash.update(chunk); bytes += chunk.length; if (onBytes) onBytes(bytes) }).on('error', fail)
      write.on('error', fail).on('close', () => { if (!done) { done = true; off(); resolve(hash.digest('hex')) } })
      read.pipe(write)
    })
    if (sha256 !== want.sha256) throw notReference(want)
    fs.renameSync(part, to)
  } catch (error) { fs.rmSync(part, { force: true }); throw error }
}

// A depot file is checked where Steam left it, then moves (a rename on the same drive: the player downloaded it for
// this). Nothing leaves the depot until it is known to be right, so a stop at any point loses nothing.
async function moveChecked(from, to, want, signal, onBytes) {
  if (await sha256Of(from, signal, onBytes) !== want.sha256) throw notReference(want)
  checkStop(signal)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.renameSync(from, to)
}

const sameDrive = (a, b) => path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase()

function freeBytes(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try { const s = fs.statfsSync(d); return s.bavail * s.bsize } catch { /* not made yet: ask its parent */ }
    if (path.dirname(d) === d) return null
  }
}

/**
 * What making (or repairing) the copy needs: each wanted file and where it comes from, those no source has (the depots
 * must be downloaded), and the space it takes on the copy's drive. Files already in the copy at the right size count as
 * there; build() still checks their hashes.
 */
// damaged: paths (lower case) a build found wrong with no source, which their size alone would pass
function assess({ gameDir, steamDir, depotDirs, loadOrder, ref = REF, refused = null, managed = null, damaged = null }) {
  const wanted = sources(wantedFiles(loadOrder, ref), { steamDir, depotDirs, refused })
  const present = f => {
    const lower = f.path.toLowerCase(), size = fileSize(path.join(gameDir, ...f.path.split('/')))
    return !damaged?.has(lower) && (size === f.size || (size >= 0 && !!managed?.has(lower)))
  }
  const todo = wanted.filter(f => !present(f))
  const missing = todo.filter(f => !f.from).map(f => f.path)
  const bytes = todo.filter(f => f.from && !(f.kind === 'depot' && sameDrive(f.from, gameDir))).reduce((n, f) => n + f.size, 0)
  return { wanted, todo: todo.length, missing, bytes, free: freeBytes(gameDir), ready: todo.length === 0 && fs.existsSync(path.join(gameDir, MARKER)) }
}

/**
 * Makes or repairs the copy. Each wanted file the copy lacks, or has with another hash, comes from its source and must
 * match the reference; Creation Club files the server does not load are removed from the copy, and Skyrim.ccc lists
 * exactly the ones it keeps. managed: paths (lower case) the server's mods replace, left as they are once there.
 * onProgress({ done, total, received, bytes, file }) follows the bytes. A copy with nothing to do is left untouched.
 */
async function build({ gameDir, steamDir, depotDirs, loadOrder, onProgress = () => {}, signal, hashCache = null, ref = REF, move = true, refused = new Map(), managed = null }) {
  const wanted = sources(wantedFiles(loadOrder, ref), { steamDir, depotDirs, refused })
  const hashOf = async file => hashCache ? (await hashCache.hash(file, null, signal))?.sha256 : await sha256Of(file, signal)
  const marker = path.join(gameDir, MARKER)
  // Files already right stay; the rest need a source. A copy missing one is not ready any more, so the player is asked
  // to set it up again (with Steam's download) instead of being sent back to Play
  const jobs = []
  for (const f of wanted) {
    checkStop(signal)
    const to = path.join(gameDir, ...f.path.split('/')), size = fileSize(to)
    if (size >= 0 && managed?.has(f.path.toLowerCase())) continue
    if (size === f.size && await hashOf(to) === f.sha256) continue
    if (!f.from) { fs.rmSync(marker, { force: true }); throw needsDepots(f) }
    jobs.push({ ...f, to })
  }
  // move: false copies depot files even on the same drive (the tests' stand-in for another drive)
  const moves = source => move && source.kind === 'depot' && sameDrive(source.from, gameDir)
  if (jobs.length) {
    const copyBytes = jobs.filter(j => !moves(j)).reduce((n, j) => n + j.size, 0)
    const free = freeBytes(gameDir)
    if (free !== null && free < copyBytes + 512 * 1024 ** 2) {
      throw Object.assign(new Error(`Not enough free space on ${path.parse(path.resolve(gameDir)).root}: ${(copyBytes / 1024 ** 3).toFixed(1)} GB needed, ${(free / 1024 ** 3).toFixed(1)} GB free.`), { code: 'NO_SPACE' })
    }
    // A copy being changed is not finished until this run ends
    fs.mkdirSync(gameDir, { recursive: true })
    fs.rmSync(marker, { force: true })
  }
  const total = jobs.reduce((n, j) => n + j.size, 0)
  let received = 0
  for (const [i, job] of jobs.entries()) {
    checkStop(signal)
    const tell = bytes => onProgress({ done: i + 1, total: jobs.length, received: received + bytes, bytes: total, file: job.path })
    let placed = false
    for (const source of job.candidates) {
      tell(0)
      try {
        if (moves(source)) await moveChecked(source.from, job.to, job, signal, tell)
        else await copyChecked(source.from, job.to, job, signal, tell)
        placed = true
        break
      } catch (error) {
        if (error.code !== 'NOT_REFERENCE') throw error
        refused.set(source.from.toLowerCase(), stampOf(source.from)); job.refused.push(source.kind)
      }
    }
    if (!placed) throw needsDepots(job)
    received += job.size
    if (hashCache) await hashCache.hash(job.to)
  }
  // Creation Club files the server does not load leave the copy; Skyrim.ccc names the ones it keeps
  const kept = new Set(wanted.map(f => f.path.toLowerCase()))
  for (const f of ref.files) {
    if ((CC_FILE.test(f.path) || STANDALONE_BSA.test(f.path)) && !kept.has(f.path.toLowerCase())) fs.rmSync(path.join(gameDir, ...f.path.split('/')), { force: true })
  }
  const ccPlugins = wanted.filter(f => CC_FILE.test(f.path) && !/\.bsa$/i.test(f.path)).map(f => path.posix.basename(f.path))
  const ccc = path.join(gameDir, 'Skyrim.ccc'), cccText = ccPlugins.map(p => `${p}\r\n`).join('')
  let current = null
  try { current = fs.readFileSync(ccc, 'utf8') } catch { /* not written yet */ }
  if (current !== cccText) fs.writeFileSync(ccc, cccText)
  fs.mkdirSync(profileDirOf(gameDir), { recursive: true })
  if (jobs.length || !fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ version: ref.exeVersion, files: wanted.length, at: new Date().toISOString() }, null, 2) + '\n')
  if (hashCache) hashCache.save()
  return { copied: jobs.length, kept: wanted.length - jobs.length, bytes: total }
}

// A copy this launcher finished (the marker is written last)
const isReady = gameDir => !!gameDir && fs.existsSync(path.join(gameDir, MARKER)) && fs.existsSync(path.join(gameDir, 'SkyrimSE.exe'))

module.exports = { REF, GAME, DOWNLOADS, MARKER, PROFILE, GENERATED, gameDirOf, downloadsDirOf, profileDirOf, depotCommands, wantedFiles, parseLibraryFolders, steamRoots, findDepots, sources, assess, build, isReady, sameDrive, freeBytes }
