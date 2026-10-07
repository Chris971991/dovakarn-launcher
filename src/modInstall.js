// Installs the server's mods into the Dovakarn game copy from its install list: every
// file the server's Vortex deployed, with the Nexus download it comes from and its path inside. The player downloads each
// file from Nexus with their own account (the server never shares mod files); the launcher finds the download by size and
// MD5 (its own Downloads folder, the player's Vortex downloads, Windows' Downloads), unpacks it with 7-Zip and puts in only
// the listed files, each checked against its size and SHA-256 (CRC-32 for an original the player file list then patches).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { execFile } = require('child_process')
const { Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { resolveInside } = require('./fileCheck')

const SCHEMA = 1
const SHA256 = /^[0-9a-f]{64}$/
const MD5 = /^[0-9a-f]{32}$/
const CRC = /^[0-9A-F]{8}$/
const ARCHIVE = /\.(7z|zip|rar)$/i
const PART = /\.(part|tmp|crdownload|download|partial|unfinished)$/i
const NEXUS_GAME = 'skyrimspecialedition'
// A download's version and Nexus file name are only shown or read for an extension: longer ones are trimmed, never a
// reason to refuse the whole list (the server keeps them within the same caps)
const CAPS = { version: 80, file: 260 }

const stopped = () => Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
const checkStop = signal => { if (signal?.aborted) throw stopped() }
const isFile = file => { try { return fs.statSync(file).isFile() } catch { return false } }

/**
 * The install list as the server sent it, checked; throws on anything a launcher must not act on. The display-only fields
 * are made safe instead: a version or file name that is not text is dropped, a long one trimmed (a file name keeps its end,
 * where its archive type is).
 */
function validate(list) {
  const bad = what => { throw new Error(`The server's install list ${what}.`) }
  if (!list || list.schema !== SCHEMA || !Array.isArray(list.archives) || !Array.isArray(list.files)) bad('is not in a supported format')
  const ids = new Set()
  for (const a of list.archives) {
    if (!a || typeof a.id !== 'string' || !/^\d{1,12}$/.test(a.id) || !Number.isSafeInteger(a.modId) || a.modId <= 0 || !Number.isSafeInteger(a.fileId) ||
      a.fileId <= 0 || !Number.isSafeInteger(a.size) || a.size <= 0 || !MD5.test(a.md5) || typeof a.name !== 'string') bad('has an invalid download')
    if (a.version !== undefined) { if (typeof a.version === 'string') a.version = a.version.slice(0, CAPS.version); else delete a.version }
    if (a.file !== undefined) { if (typeof a.file === 'string') a.file = a.file.slice(-CAPS.file); else delete a.file }
    ids.add(a.id)
  }
  for (const f of list.files) {
    if (!f || typeof f.path !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0 || !ids.has(f.archive) || typeof f.member !== 'string' ||
      !f.member || f.member.split(/[\\/]/).includes('..') || /^[\\/]|:/.test(f.member) ||
      (f.original === true ? !CRC.test(f.crc) : !SHA256.test(f.sha256))) bad('has an invalid file')
    resolveInside('C:\\x', f.path)
  }
  return list
}

// Nexus's page for one exact file: its Files tab opens on that file, with Manual and Mod Manager downloads
const nexusFileUrl = archive => `https://www.nexusmods.com/${NEXUS_GAME}/mods/${archive.modId}?tab=files&file_id=${archive.fileId}`
// The name a download keeps in Dovakarn's Downloads folder: the Nexus file's own ids, with the archive type of fromName
const downloadName = (archive, fromName) => `${archive.modId}-${archive.fileId}${(ARCHIVE.exec(fromName || '') || ['.7z'])[0].toLowerCase()}`

const hashFile = (file, algorithm, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(stopped())
  const hash = crypto.createHash(algorithm), stream = fs.createReadStream(file)
  const onAbort = () => { stream.destroy(); reject(stopped()) }
  const off = () => { if (signal) signal.removeEventListener('abort', onAbort) }
  stream.on('data', c => hash.update(c)).on('error', error => { off(); reject(error) }).on('end', () => { off(); resolve(hash.digest('hex')) })
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})
const crcOf = file => (zlib.crc32(fs.readFileSync(file)) >>> 0).toString(16).toUpperCase().padStart(8, '0')

/**
 * Which listed files the copy still needs, by download. A file is there when its size and SHA-256 match; an original is
 * there once the file exists at all (the player file list may already have patched it). hashCache: fileCheck's HashCache.
 */
async function plan({ gameDir, list, hashCache, signal, onProgress = () => {} }) {
  const needed = new Map()
  let done = 0, checked = 0
  for (const f of list.files) {
    checkStop(signal)
    const abs = resolveInside(gameDir, f.path)
    let ok = false
    if (f.original) ok = isFile(abs)
    else {
      const actual = isFile(abs) && fs.statSync(abs).size === f.size ? await hashCache.hash(abs, null, signal) : null
      ok = !!actual && actual.sha256 === f.sha256
    }
    if (ok) done++
    else (needed.get(f.archive) || needed.set(f.archive, []).get(f.archive)).push(f)
    if (++checked % 250 === 0) onProgress({ done: checked, total: list.files.length })
  }
  hashCache.save()
  const archives = list.archives.filter(a => needed.has(a.id)).map(a => ({ ...a, files: needed.get(a.id).length }))
  return { needed, archives, done, total: list.files.length }
}

// How long a folder may go without answering before a check goes on without it (a network share that went offline). The
// time starts again after each part of its listing, so a big folder that keeps answering is read to its end
const LIST_TIMEOUT = 3000
// Folders being read right now, by folder (lower case): one read per folder at a time, however many checks ask for it,
// so a folder that never answers never piles up reads that wait on it
const reads = new Map()
const folderKey = dir => path.resolve(String(dir)).toLowerCase()

/**
 * One folder's files as [{ file, size, mtimeMs }], read off the main thread so the launcher never freezes on it. A folder
 * that is missing or cannot be read has none ([]); one that gives no answer for the timeout (its listing, or the next 64
 * of its files) gives null and is skipped. A read that nobody waits for any more stops at its next step, and a read still
 * running when another check asks for the same folder is joined, never started twice. Partial downloads (.part,
 * .crdownload and the like) are left out. fsp: fs.promises unless a test passes a stand-in
 */
async function listFolder(dir, { timeout = LIST_TIMEOUT, fsp = fs.promises } = {}) {
  const key = folderKey(dir)
  let read = reads.get(key)
  if (!read) {
    const started = { waiting: 0, beats: new Set() }
    const beat = () => { for (const fn of started.beats) fn() }
    started.done = (async () => {
      try {
        let names
        try { names = await fsp.readdir(dir) } catch { return [] }
        beat()
        const files = []
        for (let i = 0; i < names.length; i += 64) {
          if (!started.waiting) return null                          // given up on by every check: stopped here
          const batch = names.slice(i, i + 64).filter(name => !PART.test(name))
          const stats = await Promise.all(batch.map(name => fsp.stat(path.join(dir, name)).then(stat => [name, stat], () => null)))
          for (const entry of stats) if (entry && entry[1].isFile()) files.push({ file: path.join(dir, entry[0]), size: entry[1].size, mtimeMs: entry[1].mtimeMs })
          beat()
        }
        return files
      } finally { if (reads.get(key) === started) reads.delete(key) }
    })()
    reads.set(key, started)
    read = started
  }
  read.waiting++
  let timer = null, rearm = null
  try {
    return await new Promise(resolve => {
      rearm = () => { clearTimeout(timer); timer = setTimeout(() => resolve(null), timeout) }
      read.beats.add(rearm)
      rearm()
      read.done.then(resolve, () => resolve([]))
    })
  } finally {
    clearTimeout(timer)
    read.beats.delete(rearm)
    read.waiting--
  }
}

/**
 * Finds downloads by size and MD5 in the given folders; MD5s are remembered while a file's size and time stay the same.
 * One finder serves one check: each folder is listed once, asynchronously, the first time a download is looked for, and a
 * folder that does not answer in time is skipped for the rest of that check (skipped lists them, in the order met).
 * keepFolders(): the folders whose files' MD5s are still worth remembering when they are saved, read at that moment (a
 * folder the player told the launcher to forget while the check ran is no longer among them); null keeps them all
 */
class DownloadFinder {
  constructor({ dirs, cacheFile, timeout = LIST_TIMEOUT, fsp = fs.promises, log = () => {}, keepFolders = null }) {
    this.dirs = dirs.filter(Boolean)
    this.cacheFile = cacheFile
    Object.assign(this, { timeout, fsp, log, keepFolders, listings: new Map(), skipped: [] })
    try { this.md5s = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { this.md5s = {} }
    if (!this.md5s || typeof this.md5s !== 'object' || Array.isArray(this.md5s)) this.md5s = {}
  }
  listing(dir) {
    if (!this.listings.has(dir)) {
      this.listings.set(dir, listFolder(dir, { timeout: this.timeout, fsp: this.fsp }).then(files => {
        if (!files) { this.skipped.push(dir); this.log(`[game] ${dir} gave no answer for ${this.timeout / 1000} seconds: not looked in for this check`) }
        return files
      }))
    }
    return this.listings.get(dir)
  }
  async md5(file, stat, signal) {
    const key = file.toLowerCase(), stamp = `${stat.size}:${stat.mtimeMs}`, hit = this.md5s[key]
    if (hit && hit.stamp === stamp) return hit.md5
    const md5 = await hashFile(file, 'md5', signal)
    this.md5s[key] = { stamp, md5 }
    return md5
  }
  // The first file with the download's size and MD5, or null. A file still being written fails its MD5: next time
  async find(archive, signal) {
    for (const dir of this.dirs) {
      checkStop(signal)
      const files = await this.listing(dir)
      if (!files) continue
      for (const entry of files) {
        if (entry.size !== archive.size) continue
        try { if (await this.md5(entry.file, entry, signal) === archive.md5) return entry.file } catch (error) { if (error.code === 'CANCELLED') throw error /* else locked while it is written: next time */ }
      }
    }
    return null
  }
  save() {
    if (!this.cacheFile) return
    let keep = this.md5s
    try {
      if (this.keepFolders) {
        const folders = new Set(this.keepFolders().map(folderKey))
        keep = Object.fromEntries(Object.entries(this.md5s).filter(([file]) => folders.has(folderKey(path.dirname(file)))))
      }
    } catch { /* kept whole */ }
    try { fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true }); fs.writeFileSync(this.cacheFile, JSON.stringify(keep)) } catch { /* only costs time */ }
  }
}
/**
 * Drops one folder's files from the remembered MD5s in cacheFile (the folder forgotten from Settings). Only its own files
 * (the finder reads a folder's top level, never below it). True when the file was rewritten.
 */
function forgetFolderMd5s(cacheFile, dir) {
  let md5s
  try { md5s = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } catch { return false }
  if (!md5s || typeof md5s !== 'object' || Array.isArray(md5s)) return false
  const key = folderKey(dir), kept = Object.fromEntries(Object.entries(md5s).filter(([file]) => folderKey(path.dirname(file)) !== key))
  if (Object.keys(kept).length === Object.keys(md5s).length) return false
  fs.writeFileSync(cacheFile, JSON.stringify(kept))
  return true
}

/**
 * Brings a found download into the launcher's own Downloads folder (copied: the player's Vortex and browser folders
 * are only read), named after the Nexus file, and returns its path there.
 */
async function keepDownload(file, archive, downloadsDir, signal) {
  const to = path.join(downloadsDir, downloadName(archive, file))
  if (path.resolve(file).toLowerCase() === path.resolve(to).toLowerCase()) return to
  fs.mkdirSync(downloadsDir, { recursive: true })
  const part = `${to}.dovakarn-part`
  // Copied and hashed in one pass, off the main thread, and Cancel stops it
  const hash = crypto.createHash('md5')
  try {
    checkStop(signal)
    await pipeline(fs.createReadStream(file), new Transform({ transform(chunk, _, done) { hash.update(chunk); done(null, chunk) } }), fs.createWriteStream(part), signal ? { signal } : {})
    if (hash.digest('hex') !== archive.md5) throw new Error(`${archive.name} changed while it was copied`)
    fs.renameSync(part, to)
  } catch (error) {
    fs.rmSync(part, { force: true })
    throw signal?.aborted ? stopped() : error
  }
  return to
}

// name: the mod, for the player's words; the 7-Zip error itself goes to the log
const run7z = (tool, args, signal, { name = 'it', log = () => {} } = {}) => new Promise((resolve, reject) => {
  const child = execFile(tool, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, error => {
    if (signal) signal.removeEventListener('abort', onAbort)
    if (signal?.aborted) return reject(stopped())
    if (error) { log(`[game] 7-Zip could not unpack ${name}: ${error.code ?? error.message}`); return reject(new Error(`7-Zip could not unpack ${name}. The download may be damaged.`)) }
    resolve()
  })
  const onAbort = () => child.kill()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
})

/**
 * Unpacks one download into a work folder beside the copy and moves its listed files into place, each checked first.
 * Returns how many files went in. A file that fails its check stops the install with the download named.
 */
async function installArchive({ tool, archivePath, archive, files, gameDir, workDir, signal, onFile = () => {}, log = () => {} }) {
  checkStop(signal)
  const dir = path.join(workDir, archive.id)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  try {
    await run7z(tool, ['x', archivePath, `-o${dir}`, '-y', '-bso0', '-bsp0'], signal, { name: archive.name, log })
    let n = 0
    for (const f of files) {
      checkStop(signal)
      const from = path.join(dir, ...f.member.split(/[\\/]/))
      if (!isFile(from)) throw new Error(`${archive.name} has no ${f.member}: is it the right download?`)
      const size = fs.statSync(from).size
      const ok = size === f.size && (f.original ? crcOf(from) === f.crc : await hashFile(from, 'sha256') === f.sha256)
      if (!ok) throw new Error(`${f.member} in ${archive.name} is not the server's file.`)
      const to = resolveInside(gameDir, f.path), part = `${to}.dovakarn-part`
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.renameSync(from, part)
      try { fs.chmodSync(to, 0o666) } catch { /* new file */ }
      try { fs.renameSync(part, to) } catch (error) { fs.rmSync(part, { force: true }); throw error }
      onFile(f.path, ++n)
    }
    return n
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

// Vortex's download folders for Skyrim SE that a player may already have: its default, and the one beside each staging
// folder a Vortex deployment in their own Skyrim names (only read)
function vortexDownloadDirs({ appData = process.env.APPDATA, skyrimDir } = {}) {
  const dirs = []
  if (appData) dirs.push(path.join(appData, 'Vortex', 'downloads', 'skyrimse'))
  try {
    const record = JSON.parse(fs.readFileSync(path.join(skyrimDir, 'Data', 'vortex.deployment.json'), 'utf8').replace(/^\uFEFF/, ''))
    if (typeof record.stagingPath === 'string') dirs.push(path.join(record.stagingPath, '..', '..', 'downloads', path.basename(path.dirname(record.stagingPath))))
  } catch { /* no Vortex there */ }
  const seen = new Set()
  return dirs.map(d => path.resolve(d)).filter(d => !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()))
}

module.exports = { SCHEMA, CAPS, LIST_TIMEOUT, validate, nexusFileUrl, plan, listFolder, folderKey, DownloadFinder, forgetFolderMd5s, keepDownload, installArchive, vortexDownloadDirs, hashFile, downloadName, ARCHIVE, NEXUS_GAME }
