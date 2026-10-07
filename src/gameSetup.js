// Dovakarn's own game copy as the online launcher runs it: where it lives, what making it needs, and the step before every
// check that repairs it and installs the server's mods into it. gameCopy.js (Skyrim 1.6.1170), modInstall.js (the mods)
// and gameProfile.js (the copy's load order and INIs) do the work; this joins them to the launcher's settings, Steam, the
// server's lists and the player's folders. The player's own Skyrim is only ever read.
const fs = require('fs')
const path = require('path')
const gameCopy = require('./gameCopy')
const modInstall = require('./modInstall')
const gameProfile = require('./gameProfile')
const { HashCache, get } = require('./fileCheck')

const DEFAULT_INSTALL_DIR = 'C:\\Dovakarn'
const FOLDER_NAME = 'Dovakarn'
const MODS_FOLDERS = 10                       // folders the player may name as holding mod downloads (the latest kept)
// A folder that names its drive or network share: never one that depends on where the launcher was started
const namedFolder = dir => typeof dir === 'string' && dir !== '' && dir.length <= 1024 &&
  (path.sep === '\\' ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(dir) : path.isAbsolute(dir))
const OUR_FOLDERS = new Set([gameCopy.GAME.toLowerCase(), gameCopy.DOWNLOADS.toLowerCase()])
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const gb = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`
const real = dir => { try { return fs.realpathSync.native(dir) } catch { return path.resolve(dir) } }
const hasContent = dir => { try { return fs.readdirSync(dir).length > 0 } catch { return false } }
const stopped = () => Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
const inside = (child, parent) => { const c = real(child).toLowerCase(), p = real(parent).toLowerCase().replace(/[\\/]+$/, ''); return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`) }

// <library> for a game at <library>\steamapps\common\<name>, or null
function steamLibraryOf(gameDir) {
  if (!gameDir) return null
  const common = path.dirname(path.resolve(gameDir)), steamapps = path.dirname(common)
  return path.basename(common).toLowerCase() === 'common' && path.basename(steamapps).toLowerCase() === 'steamapps' ? path.dirname(steamapps) : null
}

// What earlier launchers (2.x) left in the player's own Skyrim, which "Put my Skyrim back" undoes
function oldInstallIn(steamDir) {
  if (!steamDir) return false
  return ['Data/Platform/Plugins/skymp5-client.js', 'Dovakarn removed files', 'disabled CC mods'].some(rel => fs.existsSync(path.join(steamDir, ...rel.split('/'))))
}

/**
 * store: the launcher's settings (installDir: the Dovakarn folder; skyrimPath: the player's Skyrim, the copy's source).
 * steamClientRoots(): Steam's own folders (registry). myGamesDir: the player's "My Games\Skyrim Special Edition", which
 * seeds the copy's INIs once. windowsDownloads: where the browser saves Nexus downloads. serverLoadOrder(): the server's
 * plugins (serverinfo). installListUrl: the server's install list (404: it publishes none, and the mods step is skipped).
 */
// ref: the 1.6.1170 file list (the tests give a small one). onInstallDir(dir): told when the Dovakarn folder is set or
// cleared ('' when removed), so the uninstaller can offer to delete it. defaultInstallDir: the folder used when none was
// chosen (the tests give a scratch one, so a test can never reach a real C:\Dovakarn on the PC running it).
// onNeededMods(list): told the full archives the last check still needs (null: none), whenever that changes; the Nexus
// window follows it. appData: the Windows AppData\Roaming folder where Vortex keeps its default downloads (the tests give a
// scratch one, so they never read the PC's own Vortex). The store's modsFolders: folders the player named as holding mod
// downloads (addModsFolder, forgetModsFolder), looked in by every check and only ever read. listTimeout: how long a folder
// may take to list (modInstall.LIST_TIMEOUT unless a test passes a shorter one)
function createGameSetup({ store, steamClientRoots = () => [], myGamesDir = '', windowsDownloads = '', userDataDir, tool, serverLoadOrder = async () => null, installListUrl = '', openExternal = () => {}, log = () => {}, ref = gameCopy.REF, onInstallDir = () => {}, defaultInstallDir = DEFAULT_INSTALL_DIR, onNeededMods = () => {}, appData = process.env.APPDATA, listTimeout = 0 }) {
  let loadOrder = Array.isArray(store.get('serverLoadOrder')) ? store.get('serverLoadOrder') : null
  // The downloads the last check still needed, and the install list's files, for the page and the sweep
  let neededMods = null, installed = null, list = null
  const fullArchive = a => ({ id: a.id, modId: a.modId, fileId: a.fileId, name: a.name, version: typeof a.version === 'string' ? a.version : '',
    file: typeof a.file === 'string' ? a.file : '', size: a.size, md5: a.md5 })
  const neededArchives = () => neededMods ? neededMods.map(fullArchive) : null
  const setNeeded = value => { neededMods = value; try { onNeededMods(neededArchives()) } catch (error) { log(`[game] the Nexus window was not told about the mods: ${error.message}`) } }
  const downloadsDir = () => installDir() ? gameCopy.downloadsDirOf(installDir()) : ''
  // Sources a copy found with another hash (a file a mod changed in the player's Skyrim), left out until they change
  const refused = new Map()
  // The install list's paths (lower case): a vanilla file one of the server's mods replaces is the mods step's to keep
  let managed = null
  // Files the last copy found wrong with nothing to replace them (lower case), until a copy finishes
  const damaged = new Set()
  const installDir = () => { const d = store.get('installDir'); return typeof d === 'string' && d ? d : '' }
  const gameDir = () => installDir() ? gameCopy.gameDirOf(installDir()) : ''
  const steamDir = () => { const d = store.get('skyrimPath'); return typeof d === 'string' ? d : '' }
  const hashCache = () => new HashCache(path.join(userDataDir, 'game-copy-hashes.json'))
  const depotDirs = () => gameCopy.findDepots(gameCopy.steamRoots([...steamClientRoots(), steamLibraryOf(steamDir())].filter(Boolean)), ref)
  // The folders the player named, as kept: a store edited by hand gives only named folders, never more than the cap
  const modsFolders = () => { const v = store.get('modsFolders'); return Array.isArray(v) ? v.filter(namedFolder).slice(0, MODS_FOLDERS) : [] }
  // The MD5s every check remembers of the files it looked at (DownloadFinder)
  const md5Cache = () => path.join(userDataDir, 'download-md5s.json')
  // The player's own folders the last check skipped because they gave no answer in time (an offline network share)
  let skippedFolders = []
  // Every folder a check looks in for the mods' downloads, each once: the launcher's own Downloads, the player's Vortex,
  // their browser's and any folder they named
  function lookIn() {
    const seen = new Set()
    return [downloadsDir(), ...modInstall.vortexDownloadDirs({ appData, skyrimDir: steamDir() }), windowsDownloads, ...modsFolders()]
      .filter(d => d && !seen.has(modInstall.folderKey(d)) && seen.add(modInstall.folderKey(d)))
  }

  /**
   * The mods window's "My mods are in another folder": a folder the player chose (Windows' folder picker) is kept as a
   * place every check looks for the mods' downloads, newest first. It must name its drive and exist; it is only read.
   */
  function addModsFolder(picked) {
    if (!namedFolder(picked)) return { success: false, error: "Choose a folder on one of this PC's drives." }
    const dir = path.resolve(picked)
    let isDir = false
    try { isDir = fs.statSync(dir).isDirectory() } catch { /* gone */ }
    if (!isDir) return { success: false, error: 'That folder was not found. Choose another.' }
    store.set('modsFolders', [dir, ...modsFolders().filter(d => path.resolve(d).toLowerCase() !== dir.toLowerCase())].slice(0, MODS_FOLDERS))
    log(`[game] also looking for the mods' downloads in ${dir}`)
    return { success: true, dir }
  }
  /**
   * Settings, Mods: Forget one of those folders. Only a folder the launcher keeps is forgotten; nothing in it is touched,
   * and what the launcher remembered of its files (their MD5s) goes too.
   */
  function forgetModsFolder(dir) {
    const key = namedFolder(dir) ? path.resolve(dir).toLowerCase() : '', kept = modsFolders()
    if (!key || !kept.some(d => path.resolve(d).toLowerCase() === key)) return { success: false, error: 'That folder is not one the launcher looks in.' }
    store.set('modsFolders', kept.filter(d => path.resolve(d).toLowerCase() !== key))
    skippedFolders = skippedFolders.filter(d => modInstall.folderKey(d) !== key)
    log(`[game] no longer looking for the mods' downloads in ${dir}`)
    // Unless another of the check's folders is that same folder (the browser's Downloads, say), whose files stay worth it
    if (!lookIn().some(d => modInstall.folderKey(d) === key)) {
      try { modInstall.forgetFolderMd5s(md5Cache(), dir) } catch (error) { log(`[game] what was remembered of ${dir} stays until the next check: ${error.message}`) }
    }
    return { success: true }
  }

  async function currentLoadOrder() {
    try {
      const fresh = await serverLoadOrder()
      if (Array.isArray(fresh) && fresh.length) { loadOrder = fresh; store.set('serverLoadOrder', fresh) }
    } catch { /* the last one known stands */ }
    return loadOrder || []
  }

  /**
   * The folder a player picked as Dovakarn's: "Dovakarn" inside it unless it is one already. Refused inside the player's
   * own Skyrim or Steam's games, where a copy would be in Steam's way, and on a path the game cannot open (non-ANSI).
   */
  function installFolderFor(picked) {
    if (!picked) return { error: 'No folder was chosen.' }
    let dir = path.resolve(picked)
    const named = path.basename(dir).toLowerCase() === FOLDER_NAME.toLowerCase() || fs.existsSync(path.join(dir, gameCopy.GAME, gameCopy.MARKER))
    if (!named) dir = path.join(dir, FOLDER_NAME)
    if (steamDir() && (inside(dir, steamDir()) || inside(steamDir(), dir))) return { error: 'That is your own Skyrim folder. Choose somewhere else, such as C:\\, so your Skyrim stays as it is.' }
    if (/[\\/]steamapps[\\/]/i.test(`${dir}\\`)) return { error: 'Steam manages that folder. Choose somewhere outside Steam\'s library, such as C:\\.' }
    if (!/^[\x20-\x7e]+$/.test(dir)) return { error: 'Skyrim cannot open folders with letters outside plain English in their names. Choose a folder like C:\\Dovakarn.' }
    return { dir }
  }
  function chooseInstallDir(picked) {
    if (gameCopy.isReady(gameDir())) return { success: false, error: 'Dovakarn is already set up. Remove it in Settings first to set it up somewhere else.' }
    const { dir, error } = installFolderFor(picked)
    if (error) return { success: false, error }
    // A setup stopped partway keeps its files where it started: moving on would strand them (moved depot files among them)
    if (hasContent(gameDir()) && path.resolve(dir).toLowerCase() !== path.resolve(installDir()).toLowerCase()) {
      return { success: false, error: `Part of Dovakarn's game is already in ${installDir()}. To set it up somewhere else, remove that first in Settings, Game.` }
    }
    store.set('installDir', dir); onInstallDir(dir)
    return { success: true, dir }
  }

  // Each depot's download: waiting (not started), downloading (some files, with how many), or done (every file, full size)
  function depotStates(dirs) {
    return gameCopy.depotCommands(ref).map(({ id, command }) => {
      const files = ref.files.filter(f => f.depot === id), dir = dirs[id]
      const have = !dir ? 0 : files.filter(f => { try { return fs.statSync(path.join(dir, ...f.path.split('/'))).size === f.size } catch { return false } }).length
      return { id, command, state: !dir ? 'waiting' : have === files.length ? 'done' : 'downloading', files: have, total: files.length }
    })
  }

  /** Everything the page shows about the copy: set up or not, where from, the depot downloads, the mods still needed. */
  async function info() {
    const dir = installDir() || defaultInstallDir, game = gameCopy.gameDirOf(dir), dirs = depotDirs()
    const plan = gameCopy.assess({ gameDir: game, steamDir: steamDir(), depotDirs: dirs, loadOrder: loadOrder || [], ref, refused, managed, damaged })
    const ready = gameCopy.isReady(game)
    return {
      installDir: dir, chosen: !!installDir(), gameDir: game, ready, partial: !ready && !!installDir() && hasContent(game),
      steamDir: steamDir(), steamReady: plan.wanted.every(f => f.candidates.some(c => c.kind === 'steam')), steamChanged: plan.wanted.filter(f => f.refused.includes('steam')).map(f => f.path),
      // Steam's 1.6.1170 download is still on this PC (an earlier downgrade): the copy takes its files first
      fromDownload: plan.wanted.some(f => f.kind === 'depot'),
      depots: depotStates(dirs), missing: plan.missing.length, todo: plan.todo, bytes: plan.bytes, free: plan.free,
      mods: neededMods ? neededMods.map(a => ({ id: a.id, name: a.name, version: typeof a.version === 'string' ? a.version : '', size: a.size, files: a.files })) : null,
      oldInstall: oldInstallIn(steamDir()),
      // The folders the player named for their mods' downloads (Settings, Mods lists them, each with Forget), and those of
      // them the last check skipped because they gave no answer in time (the mods window says so)
      modsFolders: modsFolders(),
      modsFoldersSkipped: skippedFolders.filter(d => modsFolders().some(m => modInstall.folderKey(m) === modInstall.folderKey(d))),
    }
  }

  // Making or repairing the copy, with its bytes on the progress bar
  async function buildCopy({ progress, signal }) {
    if (!installDir()) { store.set('installDir', defaultInstallDir); onInstallDir(defaultInstallDir) }
    const game = gameDir(), order = await currentLoadOrder()
    let result
    try {
      result = await gameCopy.build({ gameDir: game, steamDir: steamDir(), depotDirs: depotDirs(), loadOrder: order, signal, hashCache: hashCache(), ref, refused, managed,
        onProgress: p => progress('copyingGame', `Copying Skyrim 1.6.1170, file ${p.done} of ${p.total}...`,
          { percent: Math.floor(p.received / Math.max(1, p.bytes) * 100), received: p.received, bytes: p.bytes, done: p.done, total: p.total }) })
    } catch (error) {
      if (error.code === 'NEEDS_DEPOTS' && error.file) damaged.add(error.file.toLowerCase())
      throw error
    }
    damaged.clear()
    gameProfile.seedInis(game, myGamesDir)
    if (result.copied) log(`[game] copy at ${game}: ${result.copied} file(s) copied, ${result.kept} already right`)
    return result
  }

  async function fetchInstallList(signal) {
    if (!installListUrl) return null
    try { return modInstall.validate(JSON.parse((await get(installListUrl, { signal, maxBytes: 64 * 1024 * 1024 })).body.toString('utf8'))) }
    catch (error) {
      if (error.code === 'NOT_FOUND') return null
      if (error.code === 'CANCELLED') throw error
      throw new Error(`Could not read the server's install list: ${error.message}`)
    }
  }

  /**
   * Before every check: the copy repaired if a file was damaged (nothing to do while every hash still matches), then the
   * server's mods installed into it from downloads found on this PC. Answers { blocked } when the player must act first.
   */
  async function prepare({ progress, signal }) {
    skippedFolders = []
    if (!gameCopy.isReady(gameDir())) return { blocked: 'setup', message: 'Set up Dovakarn to play: it gets its own copy of Skyrim, so yours stays as it is.' }
    // The install list first, so the repair leaves alone the vanilla files the server's mods replace
    progress('checking', 'Checking Dovakarn\'s game...')
    list = await fetchInstallList(signal)
    managed = list ? new Set(list.files.map(f => f.path.toLowerCase())) : null
    try { await buildCopy({ progress, signal }) }
    catch (error) {
      if (error.code === 'NEEDS_DEPOTS') return { blocked: 'setup', message: `A game file in your Dovakarn folder is damaged, and nothing on this PC can replace it. Press Set up Dovakarn to get it from Steam again. ${error.message}` }
      throw error
    }
    progress('checking', 'Checking the server\'s mods...')
    if (!list) { installed = null; setNeeded(null); return {} }
    installed = managed
    const cache = hashCache()
    const plan = await modInstall.plan({ gameDir: gameDir(), list, hashCache: cache, signal,
      onProgress: p => progress('checking', 'Checking the server\'s mods...', { percent: Math.floor(p.done / Math.max(1, p.total) * 100), done: p.done, total: p.total }) })
    if (!plan.archives.length) { setNeeded(null); return {} }
    // Downloads already on this PC: the launcher's own, the player's Vortex, their browser's and any folder they named
    const downloads = gameCopy.downloadsDirOf(installDir())
    // Each folder listed once for this check, off the main thread; one that gives no answer for 3 seconds (a network share
    // that went offline) is skipped, never waited on. What is remembered of the files is kept for the folders still looked
    // in when it is saved, so a folder forgotten meanwhile is not written back
    const finder = new modInstall.DownloadFinder({ dirs: lookIn(), cacheFile: md5Cache(), log, keepFolders: lookIn, ...(listTimeout ? { timeout: listTimeout } : {}) })
    const ready = [], missing = []
    try {
      for (const [i, archive] of plan.archives.entries()) {
        if (signal?.aborted) throw stopped()
        progress('checking', `Looking for the mods' downloads, ${i + 1} of ${plan.archives.length}...`, { percent: Math.floor(i / plan.archives.length * 100), done: i + 1, total: plan.archives.length })
        const found = await finder.find(archive, signal)
        if (found) ready.push({ archive, file: await modInstall.keepDownload(found, archive, downloads, signal) })
        else missing.push(archive)
      }
    } finally {
      finder.save()
      // The mods window names the player's own folders that were skipped, so a mod in one is not simply missing
      const own = new Set(modsFolders().map(modInstall.folderKey))
      skippedFolders = finder.skipped.filter(d => own.has(modInstall.folderKey(d)))
    }
    setNeeded(missing.length ? missing : null)
    if (missing.length) return { blocked: 'mods', message: `${plural(missing.length, 'mod')} to download from Nexus Mods.`, mods: missing }
    const files = ready.reduce((n, r) => n + plan.needed.get(r.archive.id).length, 0)
    let done = 0
    for (const [i, { archive, file }] of ready.entries()) {
      progress('installingMods', `Installing mods, ${i + 1} of ${ready.length}: ${archive.name}...`, { percent: Math.floor(done / Math.max(1, files) * 100), done: i + 1, total: ready.length })
      done += await modInstall.installArchive({ tool, archivePath: file, archive, files: plan.needed.get(archive.id), gameDir: gameDir(), workDir: path.join(downloads, '.unpack'), signal, log })
    }
    log(`[game] installed ${plural(done, 'file')} from ${plural(ready.length, 'download')}`)
    return { installed: done }
  }

  /** Nexus's page for one download the copy still needs. */
  function openMod(id) {
    const archive = (neededMods || []).find(a => a.id === id) || list?.archives.find(a => a.id === id)
    if (!archive) return { success: false, error: 'Unknown mod.' }
    openExternal(modInstall.nexusFileUrl(archive))
    return { success: true }
  }

  /** Removes the Dovakarn folder: only one this launcher made (its Game and Downloads folders, nothing else). */
  async function remove() {
    const dir = installDir()
    managed = null
    if (!dir || !fs.existsSync(dir)) { store.set('installDir', ''); onInstallDir(''); return { success: true } }
    const strangers = fs.readdirSync(dir).filter(n => !OUR_FOLDERS.has(n.toLowerCase()))
    if (strangers.length) return { success: false, error: `${dir} also holds ${strangers.slice(0, 3).join(', ')}${strangers.length > 3 ? ' and more' : ''}, so the launcher leaves it alone. Delete the folder yourself if you want it gone.` }
    await fs.promises.rm(dir, { recursive: true, force: true })
    store.set('installDir', ''); onInstallDir(''); setNeeded(null); installed = null; list = null; skippedFolders = []
    log(`[game] removed ${dir}`)
    return { success: true }
  }

  return { DEFAULT_INSTALL_DIR: defaultInstallDir, installDir, gameDir, steamDir, installFolderFor, chooseInstallDir, info, buildCopy, prepare, openMod, remove,
    installedPaths: () => installed, gb, neededArchives, downloadsDir, addModsFolder, forgetModsFolder, modsFolders }
}

module.exports = { createGameSetup, steamLibraryOf, oldInstallIn, DEFAULT_INSTALL_DIR }
