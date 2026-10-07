// Compares the game folder with the server's file list: installs Dovakarn's own files,
// adapts the player's own mod files where the server needs a patched copy, and reports
// mods that are missing or differ (Dovakarn's own game copy gets them from the install list; a
// player's own Skyrim from the Dovakarn collection).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const https = require('https')
const { REQUIRED_SKYRIM_VERSION } = require('./skyrimVersion')
const { validateSteps, applySteps } = require('./fileSteps')
const { checkCollection, parseCollectionUrl, NEXUS_API } = require('./collectionCheck')
const modSettings = require('./modSettings')
const ini = require('./ini')

// 'dovahzul' is the server's name for Dovakarn's own files in its player file list (a server contract)
const KINDS = new Set(['dovahzul', 'mod', 'patch', 'base'])
const COLLECTION = /^https:\/\/(www\.|next\.)?nexusmods\.com\//i
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])
// Per-player settings (profile, session, server address) are never replaced from a server list.
const PLAYER_SETTINGS = /(^|\/)Data\/Platform\/Plugins\/[^/]+-settings\.txt$/i
const PATCH_LIMIT = 64 * 1024 * 1024

// The player pressed Cancel: whatever was running stops, and nothing half-written is left behind (replaceFile).
const stopped = () => Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
const checkStop = signal => { if (signal?.aborted) throw stopped() }

// Plain HTTP is only trusted on this PC; any other server must use HTTPS.
// onData: told the bytes received so far, for a progress bar. signal: an AbortSignal that stops the download.
function get(url, { maxBytes = 32 * 1024 * 1024, timeout = 20000, toFile, method = 'GET', headers = {}, body, onData, signal } = {}) {
  return new Promise((settle, refuse) => {
    // One signal serves every file of a check: each request lets go of it when it ends
    const onAbort = () => { request.destroy(); fail(stopped()) }
    const resolve = value => { if (signal) signal.removeEventListener('abort', onAbort); settle(value) }
    const reject = error => { if (signal) signal.removeEventListener('abort', onAbort); refuse(error) }
    let target
    try { target = new URL(url) } catch { return reject(new Error(`Invalid address ${url}`)) }
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && LOOPBACK.has(target.hostname))) {
      return reject(new Error('The server file list must use HTTPS unless it is on this PC.'))
    }
    let out = null, failed = false
    // A half-written file is closed before rejecting so the caller can delete it.
    const fail = error => {
      if (failed) return
      failed = true
      if (out && !out.closed) { out.once('close', () => reject(error)); out.destroy() } else reject(error)
    }
    const request = (target.protocol === 'https:' ? https : http).request(target, { method, timeout, headers }, response => {
      if (response.statusCode === 404) { response.resume(); return fail(Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })) }
      if (response.statusCode !== 200) { response.resume(); return fail(new Error(`Server answered ${response.statusCode}`)) }
      const hash = crypto.createHash('sha256'), chunks = []
      let size = 0
      if (toFile) out = fs.createWriteStream(toFile)
      response.on('data', chunk => {
        if (failed) return
        size += chunk.length
        if (size > maxBytes) { request.destroy(); return fail(new Error('The download is larger than the server said.')) }
        hash.update(chunk)
        if (out) out.write(chunk); else chunks.push(chunk)
        if (onData) onData(size)
      })
      response.on('error', fail)
      response.on('end', () => {
        if (failed) return
        const done = () => resolve({ body: out ? null : Buffer.concat(chunks), size, sha256: hash.digest('hex') })
        if (out) out.end(done); else done()
      })
    })
    request.on('timeout', () => { request.destroy(); fail(new Error('The server did not answer in time.')) })
    request.on('error', fail)
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    request.end(body)
  })
}

// Every listed path must stay inside the game folder; ':' would also reach NTFS alternate streams.
function resolveInside(gameDir, rel) {
  const root = path.resolve(gameDir)
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /[:*?"<>|\x00-\x1f]/.test(rel) || rel.split(/[\\/]/).some(part => part === '..' || part === '')) {
    throw new Error(`Unsafe file path in the server list: ${rel}`)
  }
  const abs = path.resolve(root, rel)
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error(`Unsafe file path in the server list: ${rel}`)
  return abs
}

const validFile = f => f && typeof f.path === 'string' && Number.isSafeInteger(f.size) && f.size >= 0 && SHA256.test(f.sha256)

// A locked INI's settings: { section: { key: value } }, strings only.
const validSettings = s => s && typeof s === 'object' && !Array.isArray(s) &&
  Object.values(s).every(m => m && typeof m === 'object' && !Array.isArray(m) && Object.values(m).every(v => typeof v === 'string'))
const DATA_PATH = /^Data\/[^:*?"<>|\x00-\x1f]+$/i

function validate(manifest) {
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files)) throw new Error('The server file list is not in a supported format.')
  for (const f of manifest.files) {
    if (!validFile(f) || !KINDS.has(f.kind) || (f.kind === 'patch' && (!validFile(f.from) || !validateSteps(f.steps))) ||
      (f.ini !== undefined && !validSettings(f.ini))) {
      throw new Error('The server file list contains an invalid entry.')
    }
  }
  // Locked mod settings (modSettings.js): menu settings files, bindable keys and swept folders, all inside Data
  const bad = () => { throw new Error('The server file list contains an invalid mod settings entry.') }
  for (const m of manifest.mcm || []) if (!m || typeof m.path !== 'string' || !DATA_PATH.test(m.path)) bad()
  for (const k of manifest.keys || []) {
    if (!k || typeof k.id !== 'string' || typeof k.file !== 'string' || !DATA_PATH.test(k.file) || typeof k.section !== 'string' ||
      typeof k.key !== 'string' || typeof k.label !== 'string' || k.format !== 'dx' || !modSettings.validKey(k.format, k.default)) bad()
  }
  // Keys the game client applies itself: each one only a "...KeyCode" entry of the client settings file, never the server address or login
  if (manifest.gameKeys !== undefined && !Array.isArray(manifest.gameKeys)) bad()
  for (const k of manifest.gameKeys || []) {
    if (!k || typeof k.setting !== 'string' || !modSettings.GAME_KEY_SETTING.test(k.setting) || k.id !== `game|${k.setting}` || typeof k.label !== 'string' ||
      k.format !== 'dx' || !modSettings.validKey(k.format, k.default)) bad()
  }
  if (manifest.sweep !== undefined) {
    // Inside Data, ending in a real file type or name: never Data/**, Data/* or *.* (nothing that could sweep the game)
    const s = manifest.sweep, ok = p => typeof p === 'string' && /^Data\//i.test(p) && !/[:?"<>|\\\x00-\x1f]/.test(p) &&
      !p.split('/').includes('..') && /\.[a-z0-9]+$/i.test(p)
    if (!s || !Array.isArray(s.patterns) || !s.patterns.every(ok) || !(s.keep || []).every(ok)) bad()
  }
  const url = manifest.collection && typeof manifest.collection.url === 'string' ? manifest.collection.url : ''
  return { name: manifest.collection?.name || 'Dovakarn', url: COLLECTION.test(url) ? url : '' }
}

// Hashes are reused while a file's size and modified time are unchanged.
class HashCache {
  constructor(file) {
    this.file = file
    try { this.entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || {} } catch { this.entries = {} }
  }
  // onBytes: told the bytes read so far while a file is hashed (a large archive takes a while); signal stops it
  async hash(abs, onBytes, signal) {
    let stat
    try { stat = fs.statSync(abs) } catch { return null }
    if (!stat.isFile()) return null
    const key = abs.toLowerCase(), hit = this.entries[key]
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return { size: stat.size, sha256: hit.sha256 }
    const sha256 = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256'), stream = fs.createReadStream(abs)
      const onAbort = () => { stream.destroy(); reject(stopped()) }
      const off = () => { if (signal) signal.removeEventListener('abort', onAbort) }
      let read = 0
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }) }
      stream.on('data', chunk => { hash.update(chunk); read += chunk.length; if (onBytes) onBytes(read) })
        .on('error', error => { off(); reject(error) }).on('end', () => { off(); resolve(hash.digest('hex')) })
    })
    this.entries[key] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256 }
    return { size: stat.size, sha256 }
  }
  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ entries: this.entries }))
    } catch { /* A lost cache only makes the next check slower. */ }
  }
}

const matches = (actual, entry) => actual && actual.size === entry.size && actual.sha256 === entry.sha256

// New content lands in a side file first, so a failure never leaves a half-written game file.
// A read-only target (a mod menu's locked settings file) is made writable first, or Windows refuses the rename.
async function replaceFile(abs, write) {
  const part = abs + '.dovakarn-part'
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  try { await write(part); try { fs.chmodSync(abs, 0o666) } catch { /* new file */ } fs.renameSync(part, abs) }
  catch (error) { fs.rmSync(part, { force: true }); throw error }
}

async function install(entry, abs, filesUrl, onData, signal) {
  try {
    await replaceFile(abs, async part => {
      const result = await get(`${filesUrl.replace(/\/$/, '')}/${entry.sha256}`, { maxBytes: entry.size, timeout: 60000, toFile: part, onData, signal })
      if (!matches(result, entry)) throw new Error(`${entry.path} did not download correctly.`)
    })
  } catch (error) { if (error.code === 'CANCELLED') throw error; throw new Error(`Could not update ${entry.path}: ${error.message}`) }
}

// Rebuilds a patched file from the player's verified original; the result must match the server exactly.
async function patch(entry, source, abs) {
  try {
    await replaceFile(abs, part => {
      const out = applySteps(fs.readFileSync(source), entry.steps)
      if (!out || !matches({ size: out.length, sha256: crypto.createHash('sha256').update(out).digest('hex') }, entry)) {
        throw new Error('the adapted file does not match the server')
      }
      fs.writeFileSync(part, out)
    })
  } catch (error) { throw new Error(`Could not adapt ${entry.path}: ${error.message}`) }
}

const fileSha = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  fs.createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
})

// Vortex keeps every mod's own copy of its files in its staging folder, wherever the player put it.
function vortexStaging(gameDir) {
  let deployment
  try { deployment = JSON.parse(fs.readFileSync(path.join(gameDir, 'Data', 'vortex.deployment.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
  const staging = typeof deployment?.stagingPath === 'string' ? deployment.stagingPath : ''
  try { return { staging, mods: fs.readdirSync(staging, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) } } catch { return null }
}
// When a conflict put another mod's copy of a file in Data, the copy the server needs may still be in
// staging. Only an exact size and hash match is used.
async function stagedCopy(vortex, rel, want, cache) {
  if (!vortex) return null
  // Data mods keep their files under the mod folder; mods for the game's main folder keep them at its top.
  const inner = /^Data\//i.test(rel) ? rel.slice(5) : rel
  for (const mod of vortex.mods) {
    let abs
    try { abs = resolveInside(path.join(vortex.staging, mod), inner) } catch { return null }
    let stat
    try { stat = fs.statSync(abs) } catch { continue }
    if (stat.isFile() && stat.size === want.size && matches(await cache.hash(abs), want)) return abs
  }
  return null
}
// Swaps a mod's own copy from Vortex's staging in place of the one in Data; staging is only read. A locked INI may come
// from a copy with the server's settings in other bytes (settingsOnly), which is checked by its settings instead.
async function restore(entry, source, abs, settingsOnly = false) {
  try {
    await replaceFile(abs, async part => {
      fs.copyFileSync(source, part)
      const same = settingsOnly ? ini.sameSettings(modSettings.readSettings(part) || {}, entry.ini) : await fileSha(part) === entry.sha256
      if (!same) throw new Error('the copy does not match the server')
    })
  } catch (error) { throw new Error(`Could not replace ${entry.path}: ${error.message}`) }
}

// A locked mod INI with no clean copy anywhere keeps its own lines and takes the server's settings (ini.matchSettings).
async function resettle(entry, abs) {
  try {
    let text = ''
    try { text = fs.readFileSync(abs, 'utf8') } catch { /* missing: written from the settings alone */ }
    const out = ini.matchSettings(text, entry.ini)
    if (!ini.sameSettings(ini.settings(out), entry.ini)) throw new Error('its settings could not be matched')
    await replaceFile(abs, async part => fs.writeFileSync(part, out))
  } catch (error) { throw new Error(`Could not reset ${entry.path}: ${error.message}`) }
}

// The server's file list, or null when it publishes none (older servers).
async function fetchFileList(manifestUrl) {
  let manifest
  try { manifest = JSON.parse((await get(manifestUrl)).body.toString('utf8')) }
  catch (error) {
    if (error.code === 'NOT_FOUND') return null
    throw new Error(`Could not read the server's file list: ${error.message}`)
  }
  return { manifest, collection: validate(manifest) }
}

// The list the local server last wrote, or null when there is none yet.
function readFileList(file) {
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  return { manifest, collection: validate(manifest) }
}

const validDate = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : ''

// The release the server was set up from: "v1.2.0", "v1.2.0 +3" with 3 changes after it, or a development build.
function serverVersion(manifest) {
  const v = manifest.version
  if (!v || !COMMIT.test(v.commit) || !validDate(v.date)) return null
  const tag = typeof v.tag === 'string' && /^v\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(v.tag) && v.tag.length <= 40 ? v.tag : ''
  const ahead = Number.isSafeInteger(v.ahead) && v.ahead > 0 ? v.ahead : 0
  const label = tag ? (ahead ? `${tag} +${ahead}` : tag) : 'Development build'
  return { label, tag, ahead, commit: v.commit.slice(0, 8), date: v.date, modified: v.modified === true }
}

// One key row for Settings, Controls; inMenus: a key that only works inside the game's menus (SkyUI's), never in play
const controlKey = k => ({ id: k.id, mod: typeof k.mod === 'string' && k.mod ? k.mod : 'Other', label: k.label, default: Number(k.default), ...(k.inMenus === true ? { inMenus: true } : {}) })
// A key another mod uses that players cannot change, for the clash notes only: a bad entry is left out, never a reason to
// refuse the list
const fixedKey = k => k && typeof k.mod === 'string' && k.mod && typeof k.label === 'string' && k.label && modSettings.validKey('dx', k.code) && Number(k.code) !== -1
  ? [{ mod: k.mod, label: k.label, code: Number(k.code) }] : []

/** What a server asks players to have: its version and one row per mod, for launcher panels. */
function describeFileList({ manifest, collection }) {
  const mods = new Map()
  let served = 0, base = 0
  for (const f of manifest.files) {
    if (f.kind === 'dovahzul') { served++; continue }
    if (f.kind === 'base') { base++; continue }
    const name = typeof f.mod === 'string' && f.mod ? f.mod : 'Unlisted mod'
    const mod = mods.get(name) || { name, nexusId: null, url: '', critical: false, files: 0 }
    if (Number.isSafeInteger(f.nexusId) && f.nexusId > 0) mod.nexusId = f.nexusId
    if (typeof f.url === 'string' && /^https:\/\//i.test(f.url)) mod.url = f.url
    mod.critical = mod.critical || f.critical === true
    mod.files++
    mods.set(name, mod)
  }
  return {
    version: serverVersion(manifest),
    generatedAt: validDate(manifest.generatedAt),
    files: manifest.files.length, served, base,
    mods: [...mods.values()].sort((a, b) => Number(b.critical) - Number(a.critical) || a.name.localeCompare(b.name)),
    collection,
    // The keys players may bind in Settings, Controls, in the server's order (the game's own first); the rest of each file stays the server's
    keys: [...(manifest.gameKeys || []).map(k => ({ ...controlKey(k), game: true })), ...(manifest.keys || []).map(controlKey)],
    fixedKeys: Array.isArray(manifest.fixedKeys) ? manifest.fixedKeys.flatMap(fixedKey) : [],
  }
}

/**
 * Checks gameDir against the server list, installs outdated Dovakarn files and adapts mod files.
 * Returns null when the server publishes no list (older servers).
 */
// keyChoices: the keys the player bound in Settings, Controls ({ key id: DirectX scan code }); see modSettings.js.
// sweep: false for the server's own game copy (the local test), which the list is built from and must not lose files;
// a folder host staging marked as a server's game copy (modSettings.SERVER_GAME) is never swept either, online included.
// For Dovakarn's own game copy: collection false skips the Vortex collection check (the launcher installed the mods
// from its install list, which says what is missing instead), and keep names the install list's files (lower case) so
// the sweep never moves a file it would only put back.
async function checkGameFiles({ gameDir, manifestUrl, filesUrl, cacheFile, onProgress = () => {}, nexusApi = NEXUS_API, signal, keyChoices = {}, sweep = true, collection: checkCollectionToo = true, keep = null }) {
  checkStop(signal)
  const list = await fetchFileList(manifestUrl)
  if (!list) return null
  const { manifest, collection } = list
  const cache = new HashCache(cacheFile)
  const outdated = [], patches = [], swaps = [], rewrites = [], base = [], mods = new Map(), vortex = vortexStaging(gameDir)
  const keysByFile = modSettings.keyValuesByFile(manifest.keys, keyChoices)
  // A locked mod settings file that cannot be put back blocks Play: it must match the server, never be clicked past.
  const report = (entry, state) => {
    const name = typeof entry.mod === 'string' && entry.mod ? entry.mod : 'Unlisted mod'
    const mod = mods.get(name) || { name, nexusId: Number.isSafeInteger(entry.nexusId) ? entry.nexusId : null, missing: [], changed: [], critical: false }
    mod[state].push(entry.path)
    mod.critical = mod.critical || entry.critical === true || entry.config === true
    mods.set(name, mod)
  }
  // Progress for the launcher's bar, in bytes wherever there are bytes: a few updates a second at most, and every
  // file boundary (force) so the file count is always right
  let lastTold = 0
  const tell = (step, force = false) => {
    const now = Date.now()
    if (!force && now - lastTold < 120) return
    lastTold = now; onProgress(step)
  }
  const listed = manifest.files.filter(entry => !PLAYER_SETTINGS.test(entry.path))
  const listedBytes = listed.reduce((sum, entry) => sum + entry.size, 0)
  let checked = 0, checkedBytes = 0
  tell({ stage: 'checking', done: 0, total: listed.length, received: 0, bytes: listedBytes }, true)
  for (const entry of listed) {
    checkStop(signal)
    checked++
    const abs = resolveInside(gameDir, entry.path)
    const actual = await cache.hash(abs, read => tell({ stage: 'checking', done: checked - 1, total: listed.length, received: checkedBytes + Math.min(read, entry.size), bytes: listedBytes }), signal)
    checkedBytes += entry.size
    tell({ stage: 'checking', done: checked, total: listed.length, received: checkedBytes, bytes: listedBytes })
    // A locked settings file that matches is kept aside, so a later edit (even one Vortex's hard link carried into
    // its staging copy) can still be put back
    if (matches(actual, entry)) { if (entry.config) modSettings.remember(cacheFile, entry, abs); continue }
    // A locked INI with the server's settings in other bytes: a mod saved it again, or it holds the player's keys
    if (entry.config && entry.ini && actual && ini.sameSettings(modSettings.readSettings(abs) || {}, modSettings.expectedSettings(entry, keysByFile))) continue
    const state = actual ? 'changed' : 'missing'
    if (entry.kind === 'dovahzul') { outdated.push({ entry, abs }); continue }
    if (entry.kind === 'base') { base.push({ path: entry.path, state }); continue }
    if (entry.kind === 'patch') {
      // The original comes from the collection; only the adaptation happens here.
      const source = resolveInside(gameDir, entry.from.path), original = await cache.hash(source)
      if (entry.size <= PATCH_LIMIT) {
        if (matches(original, entry.from)) { patches.push({ entry, source, abs }); continue }
        const staged = await stagedCopy(vortex, entry.from.path, entry.from, cache)
        if (staged) { patches.push({ entry, source: staged, abs }); continue }
      }
      const kept = entry.config && modSettings.recall(cacheFile, entry.sha256)
      if (kept) { swaps.push({ entry, source: kept, abs }); continue }
      if (entry.config && entry.ini) { rewrites.push({ entry, abs }); continue }
      report(entry, original ? 'changed' : 'missing')
      continue
    }
    if (entry.kind === 'mod') {
      const staged = await stagedCopy(vortex, entry.path, entry, cache)
      if (staged) { swaps.push({ entry, source: staged, abs }); continue }
      if (entry.config) {
        const kept = modSettings.recall(cacheFile, entry.sha256)
        if (kept) { swaps.push({ entry, source: kept, abs }); continue }
        const same = entry.ini && modSettings.settingsCopy(vortex, entry, cacheFile)
        if (same) { swaps.push({ entry, source: same, abs, settingsOnly: true }); continue }
        // No clean copy anywhere: the player's own file is given the server's settings
        if (entry.ini) { rewrites.push({ entry, abs }); continue }
      }
    }
    report(entry, state)
  }
  try {
    // done: the file being fetched (1 of total); received and bytes: the whole update so far, for the bar
    const bytes = outdated.reduce((sum, o) => sum + o.entry.size, 0)
    let fetched = 0
    for (let i = 0; i < outdated.length; i++) {
      const step = received => ({ stage: 'updating', done: i + 1, total: outdated.length, received: fetched + Math.min(received, outdated[i].entry.size), bytes })
      checkStop(signal)
      tell(step(0), true)
      await install(outdated[i].entry, outdated[i].abs, filesUrl, received => tell(step(received)), signal)
      fetched += outdated[i].entry.size
      await cache.hash(outdated[i].abs)
    }
    if (outdated.length) tell({ stage: 'updating', done: outdated.length, total: outdated.length, received: bytes, bytes }, true)
    const total = patches.length + swaps.length + rewrites.length
    for (let i = 0; i < patches.length; i++) {
      checkStop(signal)
      tell({ stage: 'patching', done: i + 1, total }, true)
      await patch(patches[i].entry, patches[i].source, patches[i].abs)
      await cache.hash(patches[i].abs)
    }
    for (let i = 0; i < swaps.length; i++) {
      checkStop(signal)
      tell({ stage: 'patching', done: patches.length + i + 1, total }, true)
      await restore(swaps[i].entry, swaps[i].source, swaps[i].abs, swaps[i].settingsOnly)
      await cache.hash(swaps[i].abs)
      if (swaps[i].entry.config) modSettings.remember(cacheFile, swaps[i].entry, swaps[i].abs)
    }
    for (let i = 0; i < rewrites.length; i++) {
      checkStop(signal)
      tell({ stage: 'patching', done: patches.length + swaps.length + i + 1, total }, true)
      await resettle(rewrites[i].entry, rewrites[i].abs)
      await cache.hash(rewrites[i].abs)
    }
  } finally { cache.save() }
  // The player's keys, the mod menus' settings files (read-only), and files the server does not use moved out
  checkStop(signal)
  const menus = manifest.mcm || manifest.keys
    ? modSettings.applyKeysAndMenus({ gameDir, manifest, choices: keyChoices, resolveInside })
    : { written: [], menusLocked: 0 }
  const moved = sweep && manifest.sweep && !modSettings.isServerGame(gameDir) ? modSettings.sweepExtras({ gameDir, manifest, keep }) : []
  modSettings.pruneCopies(cacheFile, new Set(manifest.files.filter(f => f.config).map(f => f.sha256)))
  // The collection's latest revision on Nexus against what the player's Vortex installed; it warns, never blocks.
  let collectionCheck = null
  if (collection.url && checkCollectionToo) {
    checkStop(signal)
    tell({ stage: 'collection' }, true)
    collectionCheck = await checkCollection({ url: collection.url, gameDir, request: (url, options) => get(url, { ...options, signal }), endpoint: nexusApi })
    checkStop(signal)
  }
  const modList = [...mods.values()].sort((a, b) => Number(b.critical) - Number(a.critical) || a.name.localeCompare(b.name))
  const fromCollection = collectionEntries(collectionCheck, collection.name)
  return {
    revision: typeof manifest.revision === 'string' ? manifest.revision : '',
    collection,
    collectionCheck,
    checked,
    updated: outdated.map(o => o.entry.path),
    patched: [...patches, ...swaps, ...rewrites].map(p => p.entry.path),
    moved,
    keysWritten: menus.written,
    menusLocked: menus.menusLocked,
    // The game client's own keys, written to its settings file at Play ({ dodgeKeyCode: 29, ... })
    gameKeys: modSettings.gameKeyValues(manifest.gameKeys, keyChoices),
    base,
    mods: [...modList, ...fromCollection],
    blocked: base.length > 0 || modList.some(m => m.critical),
    warnings: [...modList.filter(m => !m.critical), ...fromCollection],
    // Dovakarn's own game copy (no collection check): its fixes go through Verify, never Vortex
    gameCopy: checkCollectionToo === false,
  }
}

// Collection problems as mod rows: one row when nothing is installed, otherwise one per missing or outdated mod.
function collectionEntries(check, name) {
  if (!check || check.error || !check.total) return []
  const row = (label, state, extra = {}) => ({ name: label, nexusId: null, missing: [], changed: [], critical: false, collection: state, ...extra })
  if (check.missing.length === check.total) return [row(`${name} collection, revision ${check.revision}`, 'notInstalled', { count: check.total })]
  return [
    ...check.missing.map(m => row(m.name, 'missing', { nexusId: m.modId })),
    ...check.outdated.map(m => row(m.name, 'outdated', { nexusId: m.modId })),
  ]
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// Plain-language summary for the launcher status line.
function describeFiles(result) {
  if (!result) return ''
  if (result.base.length) return result.gameCopy ? "Some of Skyrim's own files in Dovakarn's game do not match the server. Press Verify to repair Dovakarn's game."
    : `Your Skyrim base game files do not match the server. Use a clean Skyrim ${REQUIRED_SKYRIM_VERSION} copy, then check again.`
  const critical = result.mods.filter(m => m.critical)
  const ask = result.gameCopy ? 'Press Verify to put them back.' : result.collection.url ? 'Install or reinstall the Dovakarn collection with Vortex, then check again.' : 'Ask the server owner for the Dovakarn mod collection, then check again.'
  if (critical.length) return `${plural(critical.length, 'mod')} ${critical.length === 1 ? 'is' : 'are'} missing or out of date. ${ask}`
  const fromCollection = result.warnings.filter(m => m.collection), differing = result.warnings.filter(m => !m.collection), parts = []
  if (fromCollection.length) {
    const name = result.collection.name, revision = result.collectionCheck.revision
    parts.push(fromCollection[0].collection === 'notInstalled'
      ? `The ${name} collection, revision ${revision}, is not installed. Install it with Vortex, then check again.`
      : `${plural(fromCollection.length, 'mod')} from the ${name} collection, revision ${revision}, ${fromCollection.length === 1 ? 'is' : 'are'} missing or out of date. Update the collection in Vortex, then check again.`)
  }
  if (differing.length) parts.push(`${plural(differing.length, 'mod')} ${differing.length === 1 ? 'has' : 'have'} files that differ from the server.`)
  return parts.length ? `${parts.join(' ')} You can still play, but you may see problems.` : ''
}

// Names and counts for a launcher page; file paths stay in the main process.
function filesView(result) {
  // A file row keeps its Nexus id so the page can link to where the missing files come from.
  const mods = result.mods.map(m => ({ name: m.name, missing: m.missing.length, changed: m.changed.length, critical: m.critical,
    ...(m.collection ? { state: m.collection } : {}), ...(m.count ? { count: m.count } : {}), ...(!m.collection && Number.isSafeInteger(m.nexusId) && m.nexusId > 0 ? { nexusId: m.nexusId } : {}) }))
  if (result.base.length) mods.unshift({ name: 'Skyrim base game', missing: result.base.filter(b => b.state === 'missing').length, changed: result.base.filter(b => b.state === 'changed').length, critical: true })
  // Every missing or outdated collection mod by name, for the launcher's details window.
  const c = result.collectionCheck
  const collectionCheck = c && !c.error ? { revision: c.revision, total: c.total, missing: c.missing, outdated: c.outdated, domain: parseCollectionUrl(result.collection.url)?.domain || '' } : null
  return { blocked: result.blocked, mods, collection: !!result.collection.url, collectionName: result.collection.name, collectionCheck }
}

// The outcome of the last check, kept for the launcher's "Your game" and "Collection" lines.
function checkSummary(result, at) {
  if (!result) return { at, published: false }
  const c = result.collectionCheck
  return { at, published: true, checked: result.checked, updated: result.updated.length, patched: result.patched.length,
    moved: (result.moved || []).length, keysWritten: (result.keysWritten || []).length,
    problems: filesView(result).mods.filter(m => !m.state).length, blocked: result.blocked,
    collection: !c ? null : c.error ? { error: c.error } : { revision: c.revision, total: c.total, missing: c.missing.length, outdated: c.outdated.length } }
}

const MO2_REFUSED = 'This server checks your mods in the Skyrim Data folder, where Vortex installs the Dovakarn collection. Untick Mod Organizer 2 in Settings, then press PLAY.'

/**
 * Online launch gate. Returns { success: true, files } to continue, or { success: false, error }.
 * MO2 overlays its own folders on Data where this check cannot see, so a server that publishes
 * a file list only accepts the normal launch. A second PLAY press accepts the same mod warnings.
 */
async function checkBeforeLaunch({ baseUrl, gameDir, cacheFile, viaMO2, accepted, accept, onProgress, nexusApi, keyChoices, collection = true, keep = null }) {
  const urls = { manifestUrl: `${baseUrl}/manifest`, filesUrl: `${baseUrl}/files` }
  if (viaMO2) return (await fetchFileList(urls.manifestUrl)) ? { success: false, error: MO2_REFUSED } : { success: true, files: null }
  const files = await checkGameFiles({ gameDir, cacheFile, onProgress, nexusApi, keyChoices, collection, keep, ...urls })
  if (files?.blocked) return { success: false, error: describeFiles(files), collectionUrl: files.collection.url, view: filesView(files) }
  const warningKey = files?.warnings.length ? `${files.revision}:${files.warnings.map(m => m.name).join('|')}` : ''
  if (warningKey && accepted !== warningKey) {
    accept(warningKey)
    return { success: false, error: `${describeFiles(files)} Press PLAY again to play anyway.`, collectionUrl: files.collection.url, view: filesView(files) }
  }
  return { success: true, files }
}

module.exports = { checkGameFiles, checkBeforeLaunch, describeFiles, describeFileList, fetchFileList, readFileList, filesView, checkSummary, resolveInside, get, HashCache, COLLECTION, MO2_REFUSED }
