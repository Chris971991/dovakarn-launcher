// Load .env before anything else - only in unpackaged (dev/local) builds.
// Packaged installers use real environment variables set by the OS / process manager.
if (!require('electron').app.isPackaged) {
  require('dotenv').config()
}

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron')
const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const http   = require('http')
const https  = require('https')
const { spawn, execFileSync } = require('child_process')
const Store  = require('electron-store')
const config = require('./config')
const localTest = require('./localTest')
// The local Skyrim/overlay graphics setup can leave Electron's accelerated
// renderer completely black. Use the working software renderer for this UI;
// this does not change Skyrim's graphics settings or its GPU acceleration.
if (localTest.combat) app.disableHardwareAcceleration()
const mo2    = require('./mo2')
const { REQUIRED_SKYRIM_VERSION, readSkyrimExeVersion, isExactVersionMatch } = require('./skyrimVersion')
const { launchDetached } = require('./launchProcess')
const { createLauncherLifecycle } = require('./launcherLifecycle')
const { checkBeforeLaunch, checkGameFiles, describeFileList, fetchFileList, readFileList, get } = require('./fileCheck')
const { validKey, gameKeySettings } = require('./modSettings')
const { createGameControls } = require('./gameControls')
const { isSkyrimRunning } = require('./skyrimProcess')
const { gameFolderFromPick, gameFolderProblem, sameFolder } = require('./gameFolder')
const { createDiscordLogin } = require('./discordLogin')
const { createGameLogin, restrictToUser } = require('./gameLogin')
const { installUpdate, downloadUpdate, triedOut, sameAttempt, MAX_ATTEMPTS } = require('./updateFile')
const gameCopy = require('./gameCopy')
const gameProfile = require('./gameProfile')
const { createGameSetup } = require('./gameSetup')
const { createNexusDownloads, createInstallTrigger } = require('./nexusDownloads')
const { createNexusAccount } = require('./nexusAccount')

const isDev = process.argv.includes('--dev')
// Double-clicking the local shortcut must not launch two Skyrim processes.
const hasLocalInstanceLock = !localTest.combat || app.requestSingleInstanceLock()
if (!hasLocalInstanceLock) app.quit()

// Dev logger
const LOG_FILE = isDev ? path.join(require('os').tmpdir(), 'dovakarn-launcher.log') : null

function log(...args) {
  const line = args.join(' ')
  console.log(line)
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line + '\n')
}

if (LOG_FILE) {
  fs.writeFileSync(LOG_FILE, `=== Dovakarn launcher log ${new Date().toISOString()} ===\n`)
  console.log('[dev] logging to', LOG_FILE)
}

// Route module debug output through the same logger
mo2.setLogger(log)

// Only user-specific preferences live in the store.
const store = new Store({
  defaults: {
    skyrimPath:        '',
    activeServerIndex: 0,
    cachedServers:     [],   // last-known server list fetched from /api/servers
    filesVersion:      '',   // version tag from last successful file download (legacy installs; reported to launch-check)
    verifiedFilesRevision: '', // published file-list revision this PC last verified; a newer one turns Play into Update
    discordAccount:    null,   // the logged-in Dovakarn account as the backend describes it (name, picture, number)
    discordAccountKey: null,   // its account key, sealed with Windows (discordLogin.js)
    mo2Enabled:        false,  // legacy; servers with a file list refuse MO2 launches, so it is forced off at start
    isolatedGame:      false, // legacy portable copy from older launchers; Dovakarn's own copy is installDir (gameSetup.js)
    installDir:        '',    // Dovakarn's folder (C:\Dovakarn): its own copy of Skyrim in Game, the mods' downloads in Downloads
    serverLoadOrder:   null,  // the server's plugins as last read, for which Creation Club files the copy keeps
    localGameDir:      '',    // test launcher: Skyrim folder to play from; empty means the server's own game copy
    gameDirPath:       '',     // legacy: pre-base-dir location of the game copy
    baseDirPath:       '',     // legacy base dir: MO2 root, with the game at <base>\skyrim
    updateAttempt: null, // the launcher update started last: { sha256, fromVersion, attempts } (updateFile.js)
    pendingLogouts: [],  // logouts the server did not receive yet, sealed with Windows (discordLogin.js)
    modKeys: {},         // keys bound in Settings, Controls: { key id: DirectX scan code } (modSettings.js)
    nexusUser: '',       // the Nexus name the launcher's Nexus window last saw (a plain name, never a cookie)
    nexusLogin: 'unknown', // whether that window was last seen logged in to Nexus: 'in', 'out' or 'unknown' (Settings, Mods)
    modsFolders: [],     // folders the player named as holding mod downloads (the mods window), only ever read (gameSetup.js)
    nexusAccount: null,  // the Nexus account the player logged in to with Log in to Nexus: { name, id, premium } (nexusAccount.js)
    nexusToken: null,    // its Nexus tokens, sealed with Windows; never sent to the Dovakarn server (nexusAccount.js)
  }
})

mo2.setRootProvider(() => store.get('baseDirPath') || DEFAULT_BASE_DIR)

// Discord login (discordLogin.js): Discord is how players sign up and log in, in both launchers. The test launcher logs
// in to the Dovakarn backend on this PC, so its login is kept apart from the real launcher's: neither key ever reaches
// the other's server.
const accountStore = localTest.enabled
  ? { get: key => store.get(`localTest.${key}`), set: (key, value) => store.set(`localTest.${key}`, value) }
  : store
const account = createDiscordLogin({
  apiUrl: () => localTest.combat ? localTest.apiUrl : config.apiUrl,
  store: accountStore, safeStorage, log,
  openExternal: url => shell.openExternal(url),
  hwid: () => cachedHwid(),
  unreachableMessage: () => localTest.combat
    ? 'The Dovakarn backend on this PC is not answering. Start the local server first. If it is already running, wait a few seconds for it to start the backend again, then try again.'
    : 'The Dovakarn server could not be reached. Check your internet connection, or try again in a minute.',
})
// Logins from the old SkyMP flow (plain-text sessions for another server) are dropped
for (const key of ['discordUser', 'gameSession', 'gameProfileId']) if (store.get(key)) store.set(key, null)
// The launcher no longer offers MO2 (Dovakarn's mods are installed into its own game copy, and servers with a file
// list refuse MO2 launches), so a setting left by an old install must not dead-end every Play with an MO2 refusal
if (store.get('mo2Enabled')) store.set('mo2Enabled', false)
// A logout the server did not receive last time is sent now (discordLogin.js)
account.finishLogouts().catch(() => {})

// Default install root for MO2 + the portable game copy when none is stored (legacy install root from older launchers)
const DEFAULT_BASE_DIR = 'C:\\SkyRP'

let win = null
let localPlayer = null
// The launcher is quitting: nothing new starts (the install after the Nexus window, nexusDownloads.js)
let quitting = false
// Dovakarn's folder is being removed, from the player's Remove press (its confirm dialog included) until the folder is
// gone: nothing starts meanwhile, no check or game (LocalPlay's held), no mods install, no Nexus window. removeAsking: only
// the confirm dialog is open so far (the page keeps its words; "Removing Dovakarn" once the player has confirmed)
let removing = false, removeAsking = false
const REMOVING = 'Wait until Dovakarn is removed.'
const REMOVE_STOPPED = 'Dovakarn could not be removed completely. Close any program that is using its folder, then press Remove again.'
const windowLoads = new WeakMap()

// The dependencies both modes share: the page, the game process, the Skyrim folder and the Discord login are the same.
function sharedPlayDeps() {
  return {
    account,
    running: async () => (await isSkyrimRunning()) || (await isProcessRunning('skse64_loader.exe')),
    gameFolder: gameFolderInfo,
    launcherVersion: app.getVersion(),
    openUrl: url => shell.openExternal(url),
    notify: value => send('local-play:progress', value),
    keyChoices: modKeyChoices,
    gameControls,
    // Play, Check and Set up refuse while Dovakarn's folder is being removed
    held: () => removing ? REMOVING : '',
  }
}

// The keys Skyrim's own controls use on this PC, for the Controls tab's clash notes (gameControls.js)
const gameControls = createGameControls(() => app.getPath('documents'))

// Keys the player bound in Settings, Controls ({ key id: DirectX scan code }). The file check writes them into the mods'
// settings files (modSettings.js); a key left at the server's value is not stored, so a new server default reaches it.
function modKeyChoices() {
  const value = store.get('modKeys')
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([id, key]) => id.length <= 400 && validKey('dx', key)))
}
ipcMain.handle('controls:set', (_event, change) => {
  const { id, key } = change || {}
  if (typeof id !== 'string' || !id || id.length > 400) return { success: false, error: 'Unknown key.' }
  const choices = modKeyChoices()
  if (key === null) delete choices[id]
  else if (validKey('dx', key)) choices[id] = Number(key)
  else return { success: false, error: 'That key cannot be used.' }
  store.set('modKeys', choices)
  return { success: true }
})
ipcMain.handle('controls:reset', () => { store.set('modKeys', {}); return { success: true } })

// The local test PC is also the server: it is started, restaged and read (log, published list) right here.
function localPlayDeps() {
  // The PC's folder and this checkout (localTest.js): a branch's launcher stages and reads the server with its own code.
  // These are the local test server's own tools, in the server checkout beside the launcher (local test mode only)
  const { root, repo } = localTest
  const adminConfig = require(path.join(repo, 'server-admin/config.cjs'))
  const { Runtime } = require(path.join(repo, 'server-admin/lib/runtime.cjs'))
  const { createLocalFileCheck } = require('./localFileCheck')
  const { createHostJobs } = require('./hostJobs')
  const { MANIFEST } = require(path.join(repo, 'server-admin/lib/client-manifest.cjs'))
  // Seconds of hashing and file work, kept off this thread so the window keeps responding.
  const jobs = createHostJobs({ root, repo, adminConfig, log })
  const checkFiles = createLocalFileCheck({ publish: () => jobs.run('publish'), fileList: localTest.fileList, gameDir: effectiveGamePath, cacheFile: fileHashCache, keyChoices: modKeyChoices, hostGameDir: () => localTest.gamePath })
  // The last published list can predate collection.json or this build; refresh it once so the page is current.
  checkFiles.publish().catch(error => log(`[local] player file list not rebuilt: ${error.message}`))
  return {
    ...sharedPlayDeps(),
    runtime: new Runtime(adminConfig, {}), launch: options => launchSkse(null, options),
    // Discord login applies when the local server runs with it (server-settings-login.json, written by the server window)
    loginMode: localTest.loginMode,
    refreshFiles: localTest.refreshManifest,
    checkFiles,
    prepareHost: onProgress => jobs.run('prepareHost', onProgress),
    fileList: publishedFileList(path.join(adminConfig.serverDir, 'data', MANIFEST)),
    serverLog: path.join(root, 'combat-test/server/combat.stdout.log'),   // the local test server's log
    profileId: localTest.profileId,
    maxPlayers: localTest.info.maxPlayers,
    serverAddress: `This PC · ${localTest.server.address}:${localTest.server.port}`,
  }
}

// A promise that gives up after ms, so a stalled request can never freeze the page's state refresh.
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The Dovakarn server took too long to answer.')), ms))])

// The Dovakarn server's host name, shown on the page as the world's address.
function apiHostname() { try { return new URL(config.apiUrl).hostname } catch { return '' } }

// The Dovakarn server's heartbeat, read from the backend and cached a few seconds: the page asks for state every
// two seconds, and the answer says whether the world is up (a fresh heartbeat) and how many players are in it.
const HEARTBEAT_FRESH_MS = 20000  // the game server heartbeats every 5 seconds; four missed beats reads as down
let onlineStatusCache = { at: 0, value: { online: false, players: [] } }
let lastAnswer = { at: 0, value: null }
async function onlineServerStatus() {
  if (Date.now() - onlineStatusCache.at < 5000) return onlineStatusCache.value
  let value = { online: false, players: [] }
  try {
    const servers = await withTimeout(fetchJSON(`${config.apiUrl}/api/servers`), 4000)
    // The launch pipeline reads the server address from this cache, so a state refresh keeps it current too.
    if (Array.isArray(servers) && servers.length > 0) store.set('cachedServers', servers)
    const server = Array.isArray(servers) ? servers[0] : null
    const fresh = !!server?.lastSeen && Date.now() - Date.parse(server.lastSeen) < HEARTBEAT_FRESH_MS
    value = {
      online: fresh, players: [], uptime: null,
      count: Number.isFinite(server?.online) ? server.online : 0,
      max: Number.isFinite(server?.maxPlayers) ? server.maxPlayers : undefined,
    }
    lastAnswer = { at: Date.now(), value }
  } catch {
    // One slow or lost answer (a connection busy with mod downloads) is not Dovakarn going down: the last answer
    // stands until it is as old as a missed heartbeat, then an unreachable backend reads as offline
    if (lastAnswer.value && Date.now() - lastAnswer.at < HEARTBEAT_FRESH_MS) value = lastAnswer.value
  }
  onlineStatusCache = { at: Date.now(), value }
  return value
}

// The server's published file list for the page (collection link, version), fetched in the background at
// most once a minute: LocalPlay reads it synchronously on every state refresh.
function onlineFileList() {
  let value = null, at = 0, fetching = false
  return () => {
    if (!fetching && Date.now() - at > 60000) {
      fetching = true
      fetchFileList(`${clientFilesUrl()}/manifest`)
        .then(list => { value = list ? describeFileList(list) : null })
        .catch(() => { /* kept until the next try; the check itself reports real errors */ })
        .finally(() => { at = Date.now(); fetching = false })
    }
    return value
  }
}

// Online play: the same page and coordinator as the local test, pointed at the Dovakarn server. Nothing is
// started on this PC: "starting the server" only confirms Dovakarn answers, the file check runs against the
// backend's published list, and the launch is the shared launchSkse pipeline (which fetches the play session's
// master details and writes the client settings).
function onlinePlayDeps() {
  return {
    ...sharedPlayDeps(),
    serverName: 'Dovakarn', serverAddress: apiHostname(), online: true,
    runtime: {
      status: onlineServerStatus,
      start: async () => {
        onlineStatusCache.at = 0
        if (!(await onlineServerStatus()).online) throw new Error('Dovakarn is not answering right now. Check your internet connection, or try again in a minute.')
      },
    },
    launch: options => launchSkse(null, options),
    // Discord is the only login online; the master address and key come from the server at launch time.
    loginMode: () => ({ discord: true, master: null, masterKey: null }),
    refreshFiles: () => {},
    // Dovakarn's own game copy: made at setup, repaired and given the server's mods before every check (gameSetup.js).
    // The basic test launcher (--local-test without combat) has none and plays from its own folder as before
    ...(gameSetup ? {
      prepareGame: options => gameSetup.prepare(options),
      buildGame: options => gameSetup.buildCopy(options),
      gameCopyState: () => gameSetup.info(),
    } : {}),
    // With the copy, the mods came from the install list, not Vortex: the Vortex collection check is skipped and the
    // install list's files are kept
    checkFiles: (onProgress, { signal } = {}) => checkGameFiles({ gameDir: effectiveGamePath(), manifestUrl: `${clientFilesUrl()}/manifest`, filesUrl: `${clientFilesUrl()}/files`, cacheFile: fileHashCache(), onProgress, signal, keyChoices: modKeyChoices(),
      ...(gameSetup ? { collection: false, keep: gameSetup.installedPaths() } : {}) }),
    fileList: onlineFileList(),
    serverLog: null,
    maxPlayers: 20,
    // The Update-before-Play gate: the published revision against the one this PC last verified.
    filesRevision: async () => {
      const answer = await withTimeout(fetchJSON(`${clientFilesUrl()}/manifest`), 8000)
      return typeof answer?.revision === 'string' && answer.revision ? answer.revision : null
    },
    verifiedRevision: () => store.get('verifiedFilesRevision') || '',
    rememberRevision: revision => store.set('verifiedFilesRevision', revision || ''),
  }
}

function getLocalPlayer() {
  if (!localPlayer) {
    const { LocalPlay } = require('./localPlay')
    localPlayer = new LocalPlay(localTest.combat ? localPlayDeps() : onlinePlayDeps())
    // Online, the server announces new releases and game files over a WebSocket the moment they land;
    // hearing one triggers the ordinary checks at once instead of waiting out the polling minute.
    if (!localTest.enabled && /^https?:\/\//.test(config.apiUrl || '')) {
      const { startAnnounce } = require('./announce')
      startAnnounce({
        url: config.apiUrl.replace(/^http/, 'ws') + '/ws/announce',
        log,
        onVersions: () => {
          try { localPlayer.pokeFilesProbe() } catch { /* Not yet ready. */ }
          send('update:signal')
        },
      })
    }
  }
  return localPlayer
}
ipcMain.handle('local-play:state', () => getLocalPlayer().state())
ipcMain.handle('local-play:play', (_event, options) => getLocalPlayer().play({ ignoreWarnings: options?.ignoreWarnings === true }))
ipcMain.handle('local-play:check', () => getLocalPlayer().check())
ipcMain.handle('local-play:cancel', () => getLocalPlayer().cancel())
ipcMain.handle('local-play:collection', () => getLocalPlayer().openCollection())
ipcMain.handle('local-play:mod', (_event, modId) => getLocalPlayer().openMod(modId))

// The Skyrim folder the test launcher plays from, chosen in Settings like any player would.
async function changeLocalFolder() {
  const player = getLocalPlayer()
  if (player.busy || await player.running()) return { success: false, error: 'Close Skyrim and wait for the current check to finish before changing the Skyrim folder.' }
  const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose your Skyrim Special Edition folder' })
  if (picked.canceled || !picked.filePaths[0]) return { success: false, cancelled: true }
  const dir = gameFolderFromPick(picked.filePaths[0])
  const problem = await gameFolderProblem(dir)
  if (problem) return { success: false, error: problem }
  // The test launcher keeps its folder apart from the player setting; online it is the player's Skyrim folder itself.
  if (localTest.combat) store.set('localGameDir', sameFolder(dir, localTest.gamePath) ? '' : dir)
  else store.set('skyrimPath', dir)
  gameFolderCache = null
  player.folderChanged()
  return { success: true }
}
ipcMain.handle('local-play:chooseFolder', () => changeLocalFolder())
ipcMain.handle('local-play:openGameFolder', () => { const dir = effectiveGamePath(); if (dir) shell.openPath(dir); return { success: !!dir } })

// Dovakarn's own game copy (gameSetup.js): the setup window and Settings, Game. Nothing here runs while Skyrim is open or
// a check works on the files.
async function gameIdle() {
  if (removing) return REMOVING
  const player = getLocalPlayer()
  if (player.busy || await player.running()) return 'Close Skyrim and wait for the current check to finish first.'
  return ''
}
// What stops a Remove, asked before its dialog and again after it (the dialog waits on the player): a check, a game or the
// mods' install the Nexus window asked for, waiting its turn or running
async function removeBlocked() {
  const player = getLocalPlayer()
  if (player.busy || await player.running()) return 'Close Skyrim and wait for the current check to finish first.'
  const install = installTrigger ? installTrigger.state() : null
  if (install && (install.queued || install.running)) return 'Wait until the mods are installed, then remove Dovakarn.'
  return ''
}
ipcMain.handle('game:chooseInstall', async () => {
  if (!gameSetup) return { success: false, error: 'This launcher plays from the server\'s game copy.' }
  const busy = await gameIdle()
  if (busy) return { success: false, error: busy }
  const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Choose where to put Dovakarn. It needs about 16 GB', defaultPath: path.dirname(gameSetup.installDir() || gameSetup.DEFAULT_INSTALL_DIR) })
  if (picked.canceled || !picked.filePaths[0]) return { success: false, cancelled: true }
  return gameSetup.chooseInstallDir(picked.filePaths[0])
})
ipcMain.handle('game:setup', async () => gameSetup ? withFileCheck(() => getLocalPlayer().setupGame()) : { success: false, error: 'This launcher plays from the server\'s game copy.' })
ipcMain.handle('game:openConsole', () => { shell.openExternal('steam://open/console'); return { success: true } })
ipcMain.handle('game:copyText', (_event, value) => {
  if (typeof value !== 'string' || value.length > 200) return { success: false }
  require('electron').clipboard.writeText(value)
  return { success: true }
})
ipcMain.handle('game:openInstall', () => { const dir = gameSetup?.installDir(); if (dir && fs.existsSync(dir)) shell.openPath(dir); return { success: !!dir } })
// The Nexus window and its state: only the launcher page may ask, for one needed download (its id) or the first one
// still to get; the page reads the state once at start and is pushed every change (nexus:state)
const fromLauncher = event => !!win && !win.isDestroyed() && event.sender === win.webContents
ipcMain.handle('nexus:open', async (event, request) => {
  if (!fromLauncher(event)) return { success: false, error: 'Unknown mod.' }
  if (!nexusDownloads) return { success: false, error: "This launcher plays from the server's game copy." }
  const archive = request && typeof request === 'object' ? request.archive : undefined
  if (archive !== null && (typeof archive !== 'string' || !/^\d{1,12}$/.test(archive))) return { success: false, error: 'Unknown mod.' }
  // window: the player asked for the Nexus window even with Premium (after an automatic download could not get a mod)
  return nexusDownloads.open(archive, { useWindow: request.window === true })
})
// The automatic download's Stop (the mods window)
ipcMain.handle('nexus:stop', event => fromLauncher(event) && nexusDownloads ? nexusDownloads.stopDirect() : { success: false })
// The player's Nexus account: Log in to Nexus (in the player's own browser), Cancel while it waits, Log out. Only the
// launcher page may ask; the tokens never reach it
// The server is asked first, then the login read, so a slow answer never brings back a login state that changed meanwhile.
// available: true, false, or null when the server could not be asked
const nexusAccountState = async () => { if (!nexusAccount) return null; const available = await nexusAccount.available(); return { ...nexusAccount.status(), available } }
ipcMain.handle('nexusAccount:state', event => fromLauncher(event) ? nexusAccountState() : null)
ipcMain.handle('nexusAccount:login', async event => {
  if (!fromLauncher(event) || !nexusAccount) return { success: false, error: "This launcher plays from the server's game copy." }
  try { return { success: true, state: await nexusAccount.login() } }
  catch (err) { return { success: false, error: err.message, code: err.code, state: nexusAccount.status() } }
})
ipcMain.handle('nexusAccount:cancel', event => fromLauncher(event) && nexusAccount ? nexusAccount.cancel() : null)
ipcMain.handle('nexusAccount:logout', async event => {
  if (!fromLauncher(event) || !nexusAccount) return { success: false }
  // The automatic download needs the login: it stops first, keeping what is already in (stopped: one was going)
  const stopped = nexusDownloads?.stopDirect()?.stopped === true
  return { success: true, stopped, state: await nexusAccount.logout() }
})
ipcMain.handle('nexus:snapshot', event => fromLauncher(event) && nexusDownloads ? nexusDownloads.snapshot() : null)
// Settings, Mods: Log out of Nexus, even when every mod is in and the window is long closed
ipcMain.handle('nexus:logout', async event => fromLauncher(event) && nexusDownloads ? nexusDownloads.logout() : { success: false })
// The strip page's buttons, its first painted frame and its height; nexusDownloads checks the sender is that page
ipcMain.handle('nexus:action', (event, action) => nexusDownloads ? nexusDownloads.action(event.sender, action) : { success: false })
ipcMain.on('nexus:strip-ready', event => nexusDownloads?.stripReady(event.sender))
ipcMain.on('nexus:strip-height', (event, px) => nexusDownloads?.stripHeight(event.sender, px))
// The browser route when the Nexus window could not open (another launcher holds Nexus, or it failed): one needed
// download's exact Nexus page in the player's own browser. Only an id the install list names opens anything
ipcMain.handle('nexus:browser', (event, request) => {
  if (!fromLauncher(event) || !gameSetup) return { success: false, error: 'Unknown mod.' }
  const archive = request && typeof request === 'object' ? request.archive : undefined
  if (typeof archive !== 'string' || !/^\d{1,12}$/.test(archive)) return { success: false, error: 'Unknown mod.' }
  return gameSetup.openMod(archive)
})
// The mods window's "My mods are in another folder": a folder of the player's own (another Vortex download folder, say),
// chosen in Windows' folder picker, where every later check also looks for the mods' downloads. Only ever read
ipcMain.handle('game:modsFolder', async event => {
  if (!fromLauncher(event) || !gameSetup) return { success: false, error: "This launcher plays from the server's game copy." }
  if (removing) return { success: false, error: REMOVING }
  const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose the folder your mod downloads are in' })
  if (picked.canceled || !picked.filePaths[0]) return { success: false, cancelled: true }
  return gameSetup.addModsFolder(picked.filePaths[0])
})
// Settings, Mods: Forget one of those folders (only one the launcher keeps; gameSetup checks it is in the list)
ipcMain.handle('game:forgetModsFolder', (event, dir) => {
  if (!fromLauncher(event) || !gameSetup) return { success: false, error: "This launcher plays from the server's game copy." }
  if (typeof dir !== 'string' || !dir || dir.length > 1024) return { success: false, error: 'That folder is not one the launcher looks in.' }
  return gameSetup.forgetModsFolder(dir)
})
ipcMain.handle('game:remove', async () => {
  if (!gameSetup?.installDir()) return { success: false, error: 'Dovakarn is not set up on this PC.' }
  if (removing) return { success: false, error: REMOVING }
  // From here until the folder is gone (or the player cancels) nothing starts: the install trigger waits, the Nexus window
  // asks for no install, Play and Check refuse, and the launcher page knows, so the Nexus window closing for this starts no
  // check. While only the dialog is open the page keeps its words
  removing = true; removeAsking = true; nexusDownloads?.pushMain()
  let removed = false
  try {
    const busy = await removeBlocked()
    if (busy) return { success: false, error: busy }
    const { response } = await dialog.showMessageBox(win, { type: 'warning', title: 'Remove Dovakarn', message: `Delete ${gameSetup.installDir()}?`,
      detail: "Dovakarn's copy of Skyrim and the mods' downloads go. Your own Skyrim stays, and so do your Dovakarn characters, which live on the server. You can set Dovakarn up again at any time.",
      buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true })
    if (response !== 0) return { success: false, cancelled: true }
    // Anything that started while the dialog waited on the player stops the Remove
    const since = await removeBlocked()
    if (since) return { success: false, error: since }
    // Confirmed: the page now says Dovakarn is being removed
    removeAsking = false; nexusDownloads?.pushMain()
    // A download from the Nexus window lives in the folder being removed: it is stopped and any check of a file
    // finished, and the window closed, before the folder goes (Cancel above leaves the window and its download alone)
    const removeCopy = async () => {
      const result = await gameSetup.remove()
      if (result.success) { gameFolderCache = null; getLocalPlayer().folderChanged() }
      return result
    }
    try {
      const result = await (nexusDownloads ? nexusDownloads.stopWhile(removeCopy) : removeCopy())
      removed = result?.success === true
      return result
    } catch (error) {
      // Stopped partway (a file in use): files may already be gone, so it counts as removed. The install the Nexus window
      // held back is dropped rather than run into what is left, the page reads the folder afresh, and the player gets
      // plain words (the error itself goes to the log)
      removed = true
      log(`[game] removing Dovakarn stopped partway: ${error?.message || error}`)
      gameFolderCache = null; getLocalPlayer().folderChanged()
      return { success: false, error: REMOVE_STOPPED }
    }
  } finally {
    // An install the Nexus window held back meanwhile is asked for now, unless the folder is gone
    removing = false; removeAsking = false
    if (nexusDownloads) nexusDownloads.removeEnded(removed)
  }
})
// Put my Skyrim back: what launchers before 3.0 did to the player's own Skyrim, undone (restoreSkyrim.js)
ipcMain.handle('game:restoreSkyrim', async () => {
  const dir = gameSetup?.steamDir()
  if (!dir || !fs.existsSync(path.join(dir, 'SkyrimSE.exe'))) return { success: false, error: 'Your Skyrim folder was not found. Choose it in Settings, Game.' }
  const busy = await gameIdle()
  if (busy) return { success: false, error: busy }
  const { response } = await dialog.showMessageBox(win, { type: 'question', title: 'Put my Skyrim back', message: `Put ${dir} back the way it was before Dovakarn?`,
    detail: "Dovakarn's own files leave it, and the files earlier launchers moved out come back. Your mods are not touched. Vortex puts back any mod file Dovakarn changed when it next deploys.",
    buttons: ['Put it back', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true })
  if (response !== 0) return { success: false, cancelled: true }
  let list
  try { list = await fetchFileList(`${clientFilesUrl()}/manifest`) } catch (error) { return { success: false, error: `The server's file list could not be read, so nothing was changed: ${error.message}` } }
  const { restoreSkyrim, describe } = require('./restoreSkyrim')
  const result = await restoreSkyrim({ skyrimDir: dir, manifest: list?.manifest })
  log(`[restore] ${dir}: ${JSON.stringify(result)}`)
  return { success: true, ...result, summary: describe(result) }
})

// The notice board's Updates for the main screen, the same entries the game's own Updates tab shows, newest first. The
// last good copy stands in when the server does not answer. fresh: entries posted since this launcher was last opened
// (the ids seen are read once per run, so what was new stays marked until the launcher closes); a first run marks none.
let updatesSeenAtStart = null
const updateText = (value, max) => typeof value === 'string' ? value.slice(0, max) : ''
ipcMain.handle('local-play:updates', async () => {
  if (localTest.enabled) return { entries: [], fresh: [], reached: true, local: true }
  let entries = null, reached = true
  try {
    const answer = await withTimeout(fetchJSON(`${config.apiUrl}/api/updates`), 8000)
    if (Array.isArray(answer)) entries = answer.filter(e => e && typeof e.id === 'string' && typeof e.title === 'string' && e.title).slice(0, 10)
      .map(e => ({ id: updateText(e.id, 80), version: updateText(e.version, 30), date: updateText(e.date, 30), title: updateText(e.title, 90), body: updateText(e.body, 700) }))
    else reached = false
  } catch { reached = false }
  if (entries) store.set('updatesCache', entries)
  else entries = Array.isArray(store.get('updatesCache')) ? store.get('updatesCache') : []
  if (!updatesSeenAtStart) { const stored = store.get('updatesSeen'); updatesSeenAtStart = { known: Array.isArray(stored), ids: new Set(Array.isArray(stored) ? stored : []) } }
  const fresh = updatesSeenAtStart.known ? entries.filter(e => !updatesSeenAtStart.ids.has(e.id)).map(e => e.id) : []
  const stored = store.get('updatesSeen')
  store.set('updatesSeen', [...new Set([...entries.map(e => e.id), ...(Array.isArray(stored) ? stored : [])])].slice(0, 100))
  return { entries, fresh, reached }
})

// What the Settings and Verify screens show about the Skyrim folder. Reading the exe version starts
// PowerShell, so it is cached until the folder or its SkyrimSE.exe changes; callers share one read.
let gameFolderCache = null
async function gameFolderInfo() {
  const dir = effectiveGamePath() || ''
  const exe = path.join(dir, 'SkyrimSE.exe')
  let stamp = ''
  try { const s = fs.statSync(exe); stamp = `${s.size}:${s.mtimeMs}` } catch { /* no exe */ }
  if (!gameFolderCache || gameFolderCache.dir !== dir || gameFolderCache.stamp !== stamp) {
    const info = (stamp ? readSkyrimExeVersion(dir) : Promise.resolve(null)).then(version =>
      ({ path: dir, exe: !!stamp, version: version || '', versionOk: isExactVersionMatch(version, REQUIRED_SKYRIM_VERSION), required: REQUIRED_SKYRIM_VERSION }))
    gameFolderCache = { dir, stamp, info }
  }
  // steam: only Steam's edition can be switched to 1.6.1170 from Steam's own downloads
  return { ...(await gameFolderCache.info), skse: fs.existsSync(path.join(dir, 'skse64_loader.exe')), steam: !!dir && mo2.detectEdition(dir) === 'Steam' }
}

// The list the local server last published, summarised for the page; re-read only when the file changes.
function publishedFileList(file) {
  let key = '', value = null
  return () => {
    let stat
    try { stat = fs.statSync(file) } catch { return null }
    const next = `${stat.size}:${stat.mtimeMs}`
    if (next !== key) { const list = readFileList(file); value = list && describeFileList(list); key = next }
    return value
  }
}

// One file check at a time: PLAY and Check mods both install and adapt game files.
let fileCheckRunning = false
async function withFileCheck(task) {
  if (fileCheckRunning) return { success: false, error: 'Your game files are already being checked. Wait for it to finish.' }
  fileCheckRunning = true
  try { return await task() } finally { fileCheckRunning = false }
}
const clientFilesUrl = () => `${config.apiUrl}/api/client-files`

// Hashes of the player's game files, reused while size and modified time are unchanged.
function fileHashCache() { return path.join(app.getPath('userData'), 'game-file-hashes.json') }

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Active server helper
// Returns the currently selected game server from the cached API list,
// or null if no servers have been fetched yet.
function activeServer() {
  if (localTest.enabled) return localTest.server
  const servers = store.get('cachedServers') || []
  if (servers.length === 0) return null
  const idx = Math.min(store.get('activeServerIndex') || 0, servers.length - 1)
  return servers[idx]
}

// Test launcher: the Skyrim folder chosen to play from, if it still has its SkyrimSE.exe.
function localGameDir() {
  const chosen = store.get('localGameDir')
  return typeof chosen === 'string' && chosen && fs.existsSync(path.join(chosen, 'SkyrimSE.exe')) ? chosen : ''
}

// Online, the game plays from Dovakarn's own copy (gameSetup.js) and only from it: until it is set up there is nothing to
// play from, and the player's own Skyrim (skyrimPath) is only the copy's source
function effectiveGamePath() {
  if (localTest.enabled) return (localTest.combat && localGameDir()) || localTest.gamePath || path.join(store.get('baseDirPath') || DEFAULT_BASE_DIR, 'skyrim')
  return gameCopy.isReady(gameSetup.gameDir()) ? gameSetup.gameDir() : ''
}
// The launcher's own 7-Zip (assets/7zip, shipped as extraResources), which also reads the .rar files some mods come as
function sevenZip() {
  return [process.resourcesPath && path.join(process.resourcesPath, '7zip', '7z.exe'), path.join(__dirname, '..', 'assets', '7zip', '7z.exe')].find(p => p && fs.existsSync(p)) || null
}
// Steam's own folders, where download_depot puts Skyrim 1.6.1170. The page asks every couple of seconds and reg.exe
// blocks this process, so the answer is kept for five minutes
const steamRootsKept = { at: 0, roots: [] }
function steamClientRoots() {
  if (Date.now() - steamRootsKept.at > 5 * 60 * 1000) {
    steamRootsKept.roots = [regQueryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'), regQueryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')].filter(Boolean)
    steamRootsKept.at = Date.now()
  }
  return steamRootsKept.roots
}
// Dovakarn's own game copy online; the test launcher plays from the server's copy instead
const gameSetup = localTest.enabled ? null : createGameSetup({
  store, steamClientRoots, tool: sevenZip(), log,
  myGamesDir: path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition'),
  windowsDownloads: app.getPath('downloads'), userDataDir: app.getPath('userData'),
  serverLoadOrder: async () => (await withTimeout(fetchJSON(`${config.apiUrl}/api/serverinfo`), 8000))?.loadOrder,
  installListUrl: `${config.apiUrl}/api/client-files/install`,
  openExternal: url => shell.openExternal(url),
  // The uninstaller (installer.nsh) reads it to offer deleting Dovakarn's game
  onInstallDir: dir => {
    const key = 'HKCU\\Software\\Dovakarn'
    try { execFileSync('reg', dir ? ['add', key, '/v', 'InstallDir', '/t', 'REG_SZ', '/d', dir, '/f'] : ['delete', key, '/v', 'InstallDir', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }) }
    catch (error) { log(`[game] the uninstaller was not told about ${dir || 'the removed folder'}: ${error.message}`) }
  },
  onNeededMods: list => nexusDownloads?.neededChanged(list),
})
// The player's Nexus account (nexusAccount.js): Log in to Nexus from a button, and for Premium members the mods download by
// themselves through Nexus's API. The Dovakarn server only says which Nexus application to use; the tokens stay on this PC
const nexusAccount = gameSetup ? createNexusAccount({
  apiUrl: () => config.apiUrl, store, safeStorage, log, appVersion: app.getVersion(),
  openExternal: url => shell.openExternal(url),
}) : null
// Mods from Nexus inside the launcher (nexusDownloads.js): a window opened only by the player's Download buttons, whose
// Nexus view runs in its own hardened session; each download is checked and kept in Dovakarn's Downloads folder. A logged-in
// Premium member's Download press downloads them through Nexus's API instead, with no window
const nexusDownloads = gameSetup ? createNexusDownloads({
  nexusAccount,
  electron: () => { const e = require('electron'); return { app: e.app, BrowserWindow: e.BrowserWindow, WebContentsView: e.WebContentsView, session: e.session, screen: e.screen } },
  parentWindow: () => win, setup: gameSetup, request: (url, options) => get(url, options),
  notifyMain: snapshot => send('nexus:state', snapshot),
  onAllDownloaded: () => installTrigger.request(),
  installState: () => installTrigger.state(),
  removing: () => removing, removeAsking: () => removeAsking,
  nexusUser: { get: () => { const v = store.get('nexusUser'); return typeof v === 'string' ? v.slice(0, 64) : '' }, set: value => store.set('nexusUser', value) },
  nexusLogin: { get: () => store.get('nexusLogin'), set: value => store.set('nexusLogin', value) },
  userDataDir: app.getPath('userData'),
  pagePath: path.join(__dirname, 'renderer', 'nexus-window.html'), preloadPath: path.join(__dirname, 'nexus-preload.js'),
  icon: path.join(__dirname, '..', 'assets', 'icon.ico'), dev: isDev, log,
}) : null
// Every mod downloaded: the usual check installs them, once the launcher is free (nothing running, Skyrim closed),
// and never while the launcher is closing (the next start's check installs them then)
const installTrigger = nexusDownloads ? createInstallTrigger({
  // Never while Dovakarn is being removed: its confirm dialog may be open, and the folder may be going
  idle: async () => { if (removing) return false; const p = getLocalPlayer(); return !p.busy && !fileCheckRunning && !(await p.running()) },
  needed: () => gameSetup.neededArchives(),
  alive: () => !!win && !win.isDestroyed() && !quitting,
  check: async () => {
    const player = getLocalPlayer(), result = await player.check()
    if (result.success && !player.phase.message) player.progress('ready', 'Every mod is installed. Press Play when you are ready.')
    return result
  },
  onChange: () => nexusDownloads.pushMain(), log,
}) : null
// The Nexus account changed (a login, a logout, Nexus ending it, Premium found): the page hears it, and the downloads'
// state says again whether a Download press downloads by itself
nexusAccount?.onChange(state => { send('nexusAccount:state', state); nexusDownloads?.accountChanged() })

// Skyrim path auto-detection
// Registry keys the store editions write at install time, probed in order.
const SKYRIM_REGISTRY_PROBES = [
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1801825368', value: 'path' },   // Skyrim AE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1711237643', value: 'path' },   // Skyrim SE GOG
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Steam App 489830', value: 'InstallLocation' },  // Steam
  { key: 'HKLM\\SOFTWARE\\WOW6432Node\\Bethesda Softworks\\Skyrim Special Edition', value: 'installed path' },
]

// Read a single registry value via reg.exe (argv array, same pattern as mo2.js).
function regQueryValue(key, value) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', value],
      { encoding: 'utf8', timeout: 5000, windowsHide: true })
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch { return null }   // key or value missing
}

function isValidSkyrimPath(p) {
  return !!p && fs.existsSync(path.join(p, 'SkyrimSE.exe'))
}

// Stable per-machine id (Windows MachineGuid) reported to the backend for the
// ban system; null when unavailable, the backend treats it as optional.
function getHwid() {
  if (process.platform !== 'win32') return null
  const guid = regQueryValue('HKLM\\SOFTWARE\\Microsoft\\Cryptography', 'MachineGuid')
  return guid && /^[0-9a-fA-F-]{10,64}$/.test(guid) ? guid : null
}

// The PC id goes with each Discord login and Play (ban checks); read once per launcher run
let hwidCache
function cachedHwid() {
  if (hwidCache === undefined) { try { hwidCache = getHwid() } catch { hwidCache = null } }
  return hwidCache
}

// First registry hit that exists on disk and contains SkyrimSE.exe, or null.
function detectSkyrimPath() {
  if (process.platform !== 'win32') return null
  for (const probe of SKYRIM_REGISTRY_PROBES) {
    const p = regQueryValue(probe.key, probe.value)
    if (isValidSkyrimPath(p)) return p
  }
  return null
}

// When the stored path is empty or invalid, auto-fill it from the registry and persist.
function ensureSkyrimPath() {
  const stored = store.get('skyrimPath')
  if (isValidSkyrimPath(stored)) return stored
  const detected = detectSkyrimPath()
  if (detected) {
    store.set('skyrimPath', detected)
    log(`[detect] Skyrim path auto-detected: ${detected}`)
  }
  return detected
}

// Window
function createWindow() {
  const createdWindow = new BrowserWindow({
    title:     localTest.combat ? localTest.server.name : 'Dovakarn Launcher',
    icon:      path.join(__dirname, '..', 'assets', 'icon.ico'),
    width:     1200,
    height:    760,
    minWidth:  760,
    minHeight: 600,
    frame:     false,
    resizable: true,
    webPreferences: {
      preload:          path.join(__dirname, 'local-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    // Matches the page's own background, so a resize never flashes another colour.
    backgroundColor: '#090e14',
    show: false,
  })
  win = createdWindow
  // The launcher page never leaves its own file and never opens windows (links go through shell.openExternal): a page
  // dropped or linked into it never gets the launcher's bridge, the Discord and Nexus logins included
  createdWindow.webContents.on('will-navigate', event => event.preventDefault())
  createdWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // A new window appears once a frame is painted with its fonts loaded, so text never pops in after it shows.
  const reveal = () => { if (!createdWindow.isDestroyed() && !createdWindow.isVisible()) { createdWindow.show(); createdWindow.focus() } }
  createdWindow.once('ready-to-show', () => createdWindow.webContents
    .executeJavaScript('document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))')
    .then(reveal, reveal))
  // A slow first frame never leaves the launcher invisible.
  setTimeout(reveal, 3000)
  windowLoads.set(createdWindow, createdWindow.loadFile(path.join(__dirname, 'renderer', 'local-play.html')))
  createdWindow.once('closed', () => { if (win === createdWindow) win = null; nexusDownloads?.close() })
  if (isDev) createdWindow.webContents.openDevTools({ mode: 'detach' })
  return createdWindow
}

const launcherLifecycle = createLauncherLifecycle({
  getWindow: () => win,
  createWindow,
  whenLoaded: window => windowLoads.get(window),
  // Both modes launch through the page's coordinator, which shows any refusal on the page itself.
  play: () => getLocalPlayer().play(),
  onError: error => dialog.showErrorBox(localTest.combat ? 'Dovakarn-Local-Test could not open' : 'The Dovakarn launcher could not open', error.message),
})

app.whenReady().then(() => {
  if (!hasLocalInstanceLock) return
  ensureSkyrimPath()
  // A session left from a launch this launcher no longer watches (it was closed or crashed) is cleared, unless the
  // game is still running with it
  gameRunning().then(running => { if (!running) clearGameLogin() }).catch(() => {})
  launcherLifecycle.open({ playRequested: localTest.enabled && process.argv.includes('--play-local') })
  app.on('activate', () => {
    launcherLifecycle.open()
  })
})

app.on('second-instance', (_event, argv) => {
  launcherLifecycle.open({ playRequested: localTest.enabled && argv.includes('--play-local') })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => { quitting = true })

// Window controls
ipcMain.on('window:minimize', () => win?.minimize())
ipcMain.on('window:close', () => win?.close())

// Discord login. The page's status line comes from LocalPlay, so login results are recorded there to survive its refresh.
const localNote = (stage, message) => { if (localPlayer && !localPlayer.busy) localPlayer.progress(stage, message) }
ipcMain.handle('account:state', () => account.status())
ipcMain.handle('account:login', async () => {
  try {
    const state = await account.login()
    localNote('ready', `Logged in as ${state.account.name}, Dovakarn account #${state.account.number}.`)
    return { success: true, state }
  } catch (err) {
    if (err.code !== 'cancelled') localNote('account', err.message)
    return { success: false, error: err.message, code: err.code, state: account.status() }
  }
})
ipcMain.handle('account:cancel', () => account.cancel())
ipcMain.handle('account:refresh', (_event, options) => account.refresh({ fresh: options?.fresh === true }))
// The server not reached: this PC is logged out all the same, and the launcher tells the server when it can; a game
// already running here plays on until it is closed or the logout reaches the server (which then removes it)
const LOGOUT_PENDING = 'Logged out on this PC. The Dovakarn server could not be reached, so a game already running here keeps playing until you close it, or until the launcher next reaches the server and finishes the logout. The game is logged out then too.'
ipcMain.handle('account:logout', async () => {
  const state = await account.logout()
  clearGameLogin()
  localNote('ready', state.logoutPending ? LOGOUT_PENDING : 'Logged out of Dovakarn on this PC.')
  return state
})
ipcMain.handle('account:openDiscord', async () => {
  try { await shell.openExternal(await account.inviteUrl()); return { success: true } }
  catch { return { success: false, error: 'The launcher could not open your web browser. Set a default browser in Windows settings, then try again.' } }
})

// The game's saved login (auth-data-no-load.js) goes with a logout, a failed launch, and the game closing (gameLogin.js)
const gameRunning = async () => process.platform === 'win32' && ((await isSkyrimRunning()) || (await isProcessRunning('skse64_loader.exe')))
// The game's login file is readable by this Windows user only (gameLogin.js)
const gameLogin = createGameLogin({ fs, gameDir: () => effectiveGamePath(), gameRunning: () => gameRunning(), restrict: file => restrictToUser(file, { log: message => log(message) }), log: message => log(message) })
const clearGameLogin = () => gameLogin.clear()
const clearLoginWhenGameCloses = () => gameLogin.clearWhenGameCloses()

// Game process detection
// Used by the renderer to switch the Play button into its "running" state.
function isProcessRunning(imageName) {
  return new Promise(resolve => {
    require('child_process').exec(
      `tasklist /FI "IMAGENAME eq ${imageName}" /NH`,
      { timeout: 5000, windowsHide: true },
      (err, stdout) => resolve(!err && stdout.toLowerCase().includes(imageName.toLowerCase()))
    )
  })
}

// Launcher update check. An update that was started but left this launcher the version it is (a failed install) is
// offered again, said as such (retry); the same file tried out from this version (updateFile.js triedOut) is not
// offered again, and the log says so once. A launcher whose version changed since forgets the attempt.
let saidTriedOut = ''
function updateAttempt(current) {
  const attempt = store.get('updateAttempt')
  if (attempt && attempt.fromVersion !== current) { store.set('updateAttempt', null); return null }
  return attempt || null
}
ipcMain.handle('app:checkUpdate', async () => {
  const current = app.getVersion()
  try {
    const data = await fetchJSON(`${config.apiUrl}/api/version`)
    const latest    = data.version
    const newer     = compareVersions(latest, current) > 0
    const attempt   = updateAttempt(current)
    const blocked   = newer && triedOut(data, attempt, current)
    // Said once per blocked file, so a second update blocked later in the same run is logged too
    if (blocked && saidTriedOut !== data.sha256) {
      saidTriedOut = data.sha256
      log(`[update] v${latest} was tried ${MAX_ATTEMPTS} times and left this launcher v${current}: not offered again`)
    }
    const hasUpdate = newer && !blocked
    // blocked: the player is told, once, in the launcher itself, not only in this log
    // reached: the server answered; latest null then means it has published no launcher release yet
    return { current, latest, hasUpdate, reached: true, retry: hasUpdate && sameAttempt(data, attempt, current), downloadUrl: data.downloadUrl || '',
      ...(blocked ? { blocked: true, blockedMessage: `The update to v${latest} was tried ${MAX_ATTEMPTS} times and the launcher is still v${current}. Download the launcher from the Dovakarn Discord instead, and tell the staff the update did not work.` } : {}) }
  } catch {
    return { current, latest: null, hasUpdate: false, reached: false, downloadUrl: '' }
  }
})

// Reject remote plain-HTTP downloads of payloads we run or extract: guards
// against MITM tampering and https->http redirect downgrades. Loopback stays
// allowed so the http://localhost dev backend still works.
function assertSecureDownloadUrl(url) {
  if (/^https:/i.test(url)) return
  let host = ''
  try { host = new URL(url).hostname } catch {}
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return
  throw new Error(`The launcher only downloads from secure https addresses, and this one is not: ${url}`)
}

// The launcher update running now, so Cancel on the page stops it at any step, even before its download has begun
let updateAbort = null
function withUpdateAbort(run) {
  const abort = updateAbort = new AbortController()
  return run(abort.signal).finally(() => { if (updateAbort === abort) updateAbort = null })
}
ipcMain.handle('app:cancelUpdate', () => { const running = updateAbort; if (running) running.abort(); return { ok: !!running } })

// Download a URL to a local file, following redirects (release URLs hit a CDN).
// Settles exactly once on every outcome (an aborted response used to hang forever). signal: stops it (Cancel).
function downloadToFile(url, dest, onProgress, { signal, redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    try { assertSecureDownloadUrl(url) } catch (err) { return reject(err) }
    let file = null
    let settled = false
    let req = null
    const stop = () => { if (req) req.destroy(); fail(Object.assign(new Error('Download stopped.'), { code: 'CANCELLED' })) }
    const done = () => { if (signal) signal.removeEventListener('abort', stop) }
    const finish = val => { if (!settled) { settled = true; done(); resolve(val) } }
    // Destroy the stream before unlinking: an open handle leaves the partial file delete-pending on Windows and blocks every retry this session.
    const fail = err => {
      if (settled) return
      settled = true
      done()
      if (file && !file.destroyed) {
        file.once('close', () => { try { fs.unlinkSync(dest) } catch {} reject(err) })
        file.destroy()
      } else {
        try { fs.unlinkSync(dest) } catch {}
        reject(err)
      }
    }
    if (signal) { if (signal.aborted) return stop(); signal.addEventListener('abort', stop, { once: true }) }
    const mod = url.startsWith('https') ? https : http
    req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) return fail(new Error('Too many redirects'))
        return finish(downloadToFile(res.headers.location, dest, onProgress, { signal, redirectsLeft: redirectsLeft - 1 }))
      }
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`HTTP ${res.statusCode}`)) }
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      file = fs.createWriteStream(dest)
      res.on('data', c => { received += c.length; if (onProgress) onProgress(received, total) })
      res.pipe(file)
      file.on('finish', () => file.close(() => finish(dest)))
      file.on('error', fail)
      res.on('error',  fail)
      res.on('aborted', () => fail(new Error('Download interrupted')))
    })
    req.on('error', fail)
    req.setTimeout(120_000, () => { req.destroy(); fail(new Error('Download timed out')) })
  })
}

// Download progress reaches the page a few times a second (a chunk arrives every few milliseconds), always with the
// first and the last step, so its bar and percent never lag or flood the page
function throttledProgress(channel) {
  let last = 0
  return p => {
    const now = Date.now()
    if (p.phase !== 'download' || !p.total || !p.received || p.received >= p.total || now - last >= 100) { last = now; send(channel, p) }
  }
}

// Fetch the update in the background so the install itself is one instant press on the main button.
ipcMain.handle('app:downloadUpdate', () => withUpdateAbort(signal => downloadUpdate({
  fetchVersion: () => fetchJSON(`${config.apiUrl}/api/version`),
  download: (url, dest, onProgress) => downloadToFile(url, dest, onProgress, { signal }),
  progress: throttledProgress('update:progress'),
  dest: path.join(os.tmpdir(), 'DovakarnLauncher-update.exe'),
  current: app.getVersion(),
  attempt: updateAttempt(app.getVersion()),
})))

// In-app launcher update: download the new installer, run it silently only if it is the very file the Dovakarn server
// names by its SHA-256, and let it relaunch us (updateFile.js)
ipcMain.handle('app:installUpdate', () => withUpdateAbort(signal => installUpdate({
  fetchVersion: () => fetchJSON(`${config.apiUrl}/api/version`),
  download: (url, dest, onProgress) => downloadToFile(url, dest, onProgress, { signal }),
  // /S silent + --force-run: NSIS replaces our files and relaunches the app
  run: file => spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref(),
  // Releases our files so the installer can overwrite them
  quit: () => setTimeout(() => app.quit(), 1200),
  progress: throttledProgress('update:progress'),
  dest: path.join(os.tmpdir(), 'DovakarnLauncher-update.exe'),
  current: app.getVersion(),
  attempt: updateAttempt(app.getVersion()),
  remember: attempt => store.set('updateAttempt', attempt),
})))

// Launch SKSE

// Files that must exist before we allow launching
const REQUIRED_FILES = [
  path.join('Data', 'Platform', 'Plugins', 'skymp5-client.js'),
  path.join('Data', 'SKSE', 'Plugins', 'SkyrimPlatform.dll'),
  path.join('Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll'),
]

// Dovakarn's own game without its script extender: said the same way at launch and in the readiness check
const SKSE_MISSING = "The script extender is missing from Dovakarn's game. It comes with the server's mods: press Verify to put it back."

// Engine fixes preloader
const PRELOADER_DLLS = ['d3dx9_42.dll', 'winhttp.dll']
const preloaderPresent = (gamePath) =>
  !!gamePath && PRELOADER_DLLS.some(f => fs.existsSync(path.join(gamePath, f)))

// options.login: the Discord play session the test launcher already fetched (LocalPlay)
async function launchSkse(_event, options = {}) {
  const skyrimPath = effectiveGamePath()
  const mo2Enabled = !localTest.enabled && store.get('mo2Enabled')

  if (!skyrimPath) {
    return { success: false, error: 'Skyrim path not configured.' }
  }

  if (mo2Enabled && !mo2.isInstalled()) {
    return { success: false, error: 'MO2 is not set up. Open Settings, Mod Manager, and run its setup.' }
  }

  // Shared pre-launch steps: client settings, load order, file validation.
  const prep = await prepareForLaunch(skyrimPath, mo2Enabled, options)
  // A launch that stops after the session was written leaves nothing for a later manual start
  if (!prep.success) { clearGameLogin(); return prep }

  try {
    if (mo2Enabled) {
      // MO2 manages plugins.txt itself via the profile; launch through its VFS.
      mo2.launchGame(skyrimPath)
    } else {
      // Direct launch (manual mod installs): run SKSE in active game dir
      const exe = path.join(skyrimPath, 'skse64_loader.exe')
      if (!fs.existsSync(exe)) {
        clearGameLogin()
        return { success: false, error: gameSetup ? SKSE_MISSING : `skse64_loader.exe was not found in ${skyrimPath}. SKSE comes with the Dovakarn collection, so install the collection with Vortex.` }
      }
      await launchDetached(exe, [], skyrimPath)
    }
    clearLoginWhenGameCloses()
    return { success: true, loadOrderFixed: prep.loadOrderFixed }
  } catch (err) {
    clearGameLogin()
    return { success: false, error: err.message }
  }
}
/**
 * Common pre-launch pipeline:
 *  1. Re-write skymp5-client-settings.txt so server-ip/port/gameData are current.
 *  2. Sync plugins.txt with the server's published load order (if available).
 *     Blocks the launch when required plugins are missing from Data/.
 *  3. Verify the SkyMP client files exist.
 */
 
// Adds two missing folders to prevent a code 2 crash
function ensureClientDirs(gamePath) {
  if (!gamePath) return
  for (const d of ['PluginsDev', 'PluginsNoLoad']) {
    try { fs.mkdirSync(path.join(gamePath, 'Data', 'Platform', d), { recursive: true }) } catch {}
  }
}

/** Read-only pre-launch staging check; resolves to a list of problems (empty = ready to launch). */
async function verifyLaunchReadiness(skyrimPath, viaMO2, serverInfo) {
  const problems = []

  if (mo2.detectEdition(skyrimPath) !== 'Steam') {
    problems.push('A working Steam copy of Skyrim Special Edition is required. The selected game folder is not detected as Steam.')
  }

  const detectedVersion = await readSkyrimExeVersion(skyrimPath)
  if (!detectedVersion) {
    problems.push(`Unable to read the installed Skyrim version from ${path.join(skyrimPath, 'SkyrimSE.exe')}. Install the exact downgraded game build required by this server.`)
  } else if (!isExactVersionMatch(detectedVersion, REQUIRED_SKYRIM_VERSION)) {
    problems.push(gameSetup ? `Dovakarn's copy of Skyrim is ${detectedVersion}, not ${REQUIRED_SKYRIM_VERSION}. Press Verify to repair it.`
      : `This Skyrim is ${detectedVersion}, and Dovakarn needs ${REQUIRED_SKYRIM_VERSION}. Switch it with the Skyrim Downgrader Tool on Nexus Mods, then play. The launcher's main screen links to it.`)
  }

  // SkyMP / Skyrim Platform client files. The launch gate installs them from the server's published list
  // just before this check, so a file still missing here is missing from that list too: one for the staff.
  const missingFiles = REQUIRED_FILES.filter(f => !fs.existsSync(path.join(skyrimPath, f)))
  if (missingFiles.length > 0) {
    const names = missingFiles.map(f => path.basename(f)).join(', ')
    problems.push(`Multiplayer client files are missing: ${names}. Press Verify. If that does not fix it, tell the Dovakarn staff.`)
  }

  // SKSE runtime.
  if (!fs.existsSync(path.join(skyrimPath, 'skse64_loader.exe'))) {
    problems.push(gameSetup ? SKSE_MISSING
      : 'SKSE is not installed: skse64_loader.exe is missing. It comes with the Dovakarn collection, so install the collection with Vortex.')
  }

  // Vanilla masters: without them the engine hard-crashes before the menu.
  if (!fs.existsSync(path.join(skyrimPath, 'Data', 'Skyrim.esm')) ||
      !fs.existsSync(path.join(skyrimPath, 'Data', 'Update.esm'))) {
    problems.push(gameSetup ? "Dovakarn's copy of Skyrim is missing Skyrim.esm or Update.esm. Press Verify to repair it."
      : "Skyrim's own game files are missing: Skyrim.esm or Update.esm. Verify your game files in Steam, then try again.")
  }

  // Server load order: every required plugin must be present.
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    const missingPlugins = viaMO2
      ? missingPluginsForMO2(skyrimPath, serverInfo.loadOrder)
      : serverInfo.loadOrder
          .map(f => path.basename(f))
          .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()) &&
                       !fs.existsSync(path.join(skyrimPath, 'Data', f)))
    if (missingPlugins.length > 0) {
      problems.push(gameSetup ? `Required plugins are missing: ${missingPlugins.join(', ')}. Press Verify to install the server's mods.`
        : `Required plugins are missing: ${missingPlugins.join(', ')}. Install the Dovakarn collection with Vortex first.`)
    }
  }

  // Fallback for engine fixes failure (like with AV software)
  if (!localTest.enabled && !preloaderPresent(skyrimPath)) {
    problems.push(gameSetup ? "The Engine Fixes preloader is missing: d3dx9_42.dll or winhttp.dll beside SkyrimSE.exe. Press Verify to install the server's mods. If your antivirus removed it, allow it there."
      : 'The Engine Fixes preloader is missing: winhttp.dll next to SkyrimSE.exe. Press Verify. If that does not fix it, reinstall Engine Fixes from the Dovakarn collection.')
  }

  // Dovakarn's own game copy keeps its load order and INIs in its profile only through Dovakarn Profile; without it the game
  // would read the player's own Plugins.txt
  if (gameSetup && !fs.existsSync(path.join(skyrimPath, 'Data', 'SKSE', 'Plugins', 'DovakarnProfile.dll'))) {
    problems.push("DovakarnProfile.dll is missing from Dovakarn's game. Press Verify. If that does not fix it, tell the Dovakarn staff.")
  }

  // Online servers: Discord is the login; the game gets its session from the launcher
  if (!localTest.enabled && serverInfo && serverInfo.offlineMode === false && !account.status().loggedIn) {
    problems.push('Log in with Discord first, with the button at the top right of the launcher.')
  }

  return problems
}

// Every launch path gets a plain answer, and its callers clear the game's saved login, even when a step throws (a
// read-only Plugins.txt, a folder Windows will not let us create)
async function prepareForLaunch(skyrimPath, viaMO2, options = {}) {
  try { return await prepareLaunchSteps(skyrimPath, viaMO2, options) }
  catch (err) {
    log(`[launch] could not prepare the launch: ${err.stack || err.message}`)
    const file = err.path ? path.basename(err.path) : null
    const error = ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)
      ? `Windows would not let the launcher change ${file || 'a game file'}. Close any program using it, check it is not set to read-only, then try again.`
      : err.code === 'ENOSPC' ? 'The disk is full, so the launcher could not prepare the game. Free some space, then try again.'
      : 'The launcher could not prepare the game. Press Play again. If it keeps happening, tell the Dovakarn staff.'
    return { success: false, error }
  }
}

async function prepareLaunchSteps(skyrimPath, viaMO2, options = {}) {
  // The revision of the published file list this launch was just verified against, reported to the backend's
  // launch check: matching it is what "your client files are current" means.
  let verifiedRevision = ''
  // The game client's own keys (Dodge, Sneak) from the file check this launch passed: the page's check for the local test
  let gameKeys = options.gameKeys || null
  if (localTest.enabled) {
    try { localTest.refreshManifest() } catch (error) { return { success: false, error: error.message } }
    const status = await localTest.status()
    if (status.status !== 'online') return { success: false, error: localTest.combat ? 'Dovakarn-Local-Test is not ready. Close and reopen its launcher to start the server, then try again.' : 'Basic test server is not ready. Start the local server first. Discord is not required.' }
    try { await localTest.verifyGameFiles(skyrimPath) } catch (error) { return { success: false, error: error.message } }
  } else {
    // Nobody plays on an outdated launcher; someone already in Skyrim is left alone. The server enforces this
    // through the launch check too, so an unreachable answer fails open here rather than blocking on a blip.
    try {
      const published = await withTimeout(fetchJSON(`${config.apiUrl}/api/version`), 8000)
      if (published?.version && compareVersions(published.version, app.getVersion()) > 0) {
        return { success: false, error: `Launcher ${published.version} is required before you can play. Press Update launcher on the main screen first.` }
      }
    } catch { /* The launch check below still enforces. */ }
    // The backend publishes the server's player file list over HTTPS; older backends answer 404.
    // Mods are checked in Data, where Vortex installs the Dovakarn collection; MO2 launches are refused.
    let gate
    try {
      gate = await withFileCheck(() => checkBeforeLaunch({ baseUrl: clientFilesUrl(), gameDir: skyrimPath, cacheFile: fileHashCache(), viaMO2, keyChoices: modKeyChoices(),
        accepted: store.get('acceptedFileWarnings'), accept: key => store.set('acceptedFileWarnings', key),
        // Dovakarn's own game copy: its mods came from the install list, not Vortex
        ...(gameSetup ? { collection: false, keep: gameSetup.installedPaths() } : {}) }))
    } catch (error) { return { success: false, error: error.message } }
    if (!gate.success) return gate
    verifiedRevision = gate.files?.revision || ''
    gameKeys = gate.files?.gameKeys || null
    if (verifiedRevision) store.set('verifiedFilesRevision', verifiedRevision)
    if (gate.files?.updated.length) log(`[launch] updated ${gate.files.updated.length} Dovakarn files from the server`)
    if (gate.files?.patched.length) log(`[launch] adapted ${gate.files.patched.length} mod files for the server`)
  }
  ensureClientDirs(skyrimPath)
  const srv = activeServer()
  let serverInfo = null
  if (srv) {
    try { serverInfo = await fetchJSON(`${config.apiUrl}/api/serverinfo`) } catch {}
  }

  // Non-portable installs play from the user's real Skyrim folder: quarantine
  // Creation Club content the server doesn't use into "disabled CC mods", or
  // the engine force-loads it via Skyrim.ccc and fights the server load order.
  // The isolated game copy never receives cc* files, so this is a no-op there.
  if (skyrimPath === store.get('skyrimPath')) {
    mo2.disableCcContent(skyrimPath, serverInfo?.loadOrder)
  }

  // Staging gate: surface everything missing before we write settings or launch
  const notReady = await verifyLaunchReadiness(skyrimPath, viaMO2, serverInfo)
  if (notReady.length > 0) {
    return { success: false, error: 'Not ready to launch:\n' + notReady.map(p => '• ' + p).join('\n') }
  }

  // Without the server's details the game would start with no login and only tell the player to use the launcher
  if (!localTest.enabled && srv && !serverInfo) {
    return { success: false, error: 'The Dovakarn server could not be reached. Check your internet connection, then press Play again.' }
  }
  // Offline servers let a player pick any account, so this launcher only joins servers with Discord login
  if (!localTest.enabled && serverInfo?.offlineMode === true) {
    return { success: false, error: 'This server has no Discord login because it runs offline, so this launcher cannot join it.' }
  }
  // A fresh play session for this launch: the game sends it to the game server, which checks it with the backend.
  // The page's coordinator (LocalPlay) fetches one itself before calling here; that one is used as it is, with the
  // master details this server just gave, instead of asking the backend for a second session.
  let login = options.login || null
  if (!localTest.enabled && srv && serverInfo?.offlineMode === false) {
    if (login) {
      login = { ...login, master: serverInfo.masterUrl, masterKey: serverInfo.masterKey }
    } else {
      try {
        const played = await account.play()
        login = { session: played.session, account: played.account, master: serverInfo.masterUrl, masterKey: serverInfo.masterKey, inviteUrl: await account.inviteUrl() }
      } catch (err) {
        return { success: false, error: err.message, account: err.code, inviteUrl: err.inviteUrl }
      }
    }
  }

  // Logged out while the game was being prepared: that session is not written for the game to use
  if (login && !account.status().loggedIn) {
    return { success: false, error: 'You logged out while the game was starting. Log in with Discord, then press Play again.', account: 'notLoggedIn' }
  }

  if (srv) {
    const settingsPath = path.join(skyrimPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt')
    // An earlier launch's watch must not clear the session written now
    gameLogin.stopWatch()
    try {
      writeClientSettings(settingsPath, srv, serverInfo, login, gameKeys)
      log('[launch] client settings written')
    } catch (err) {
      return { success: false, error: err.message }
    }
  }

  // Load order sync
  let loadOrderFixed = false
  // Heal the instance ini (paths + SKSE shortcut) before every MO2 launch, even when serverinfo is unavailable.
  if (viaMO2) mo2.ensureInstance(skyrimPath, serverInfo?.loadOrder)
  if (Array.isArray(serverInfo?.loadOrder) && serverInfo.loadOrder.length > 0) {
    if (viaMO2) {
      const missing = missingPluginsForMO2(skyrimPath, serverInfo.loadOrder)
      if (missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${missing.join(', ')}. ` +
                 `Run Install Modlist in Settings first.`,
        }
      }
      loadOrderFixed = true
    } else {
      const result = fixLoadOrder(skyrimPath, serverInfo.loadOrder)
      loadOrderFixed = result.changed
      if (result.missing.length > 0) {
        return {
          success: false,
          error: `Missing required plugins: ${result.missing.join(', ')}. ` +
                 (gameSetup ? "Press Verify to install the server's mods." : 'Install the Dovakarn collection with Vortex first.'),
        }
      }
      if (result.changed) log('[launch] plugins.txt updated to match server load order')
    }
  } else {
    log('[launch] server load order unavailable - leaving plugins.txt untouched')
  }

  // MO2 lockdown
  // Disables plugins or skse scripts not part of the server files
  if (viaMO2) {
    // Wipe stray plugins/BSAs from the overwrite folder first: they load at top
    // priority and would otherwise desync the client load order from the server.
    const wiped = mo2.cleanOverwrite()
    if (wiped.length > 0) log(`[launch] cleaned stray overwrite items: ${wiped.join(', ')}`)
    const removed = mo2.enforceModRules()
    if (removed.length > 0) log(`[launch] disabled unauthorised mods: ${removed.join(', ')}`)
  }

  // Launch sanity check: report our files version + plugin list so the backend
  // approves this session for the game server's session validation. Backend
  // unreachable = fail open (the server itself still enforces at connect).
  const session = login?.session
  if (!localTest.enabled && session && serverInfo && serverInfo.offlineMode === false) {
    try {
      const check = await postJSON(`${config.apiUrl}/api/launch-check`, {
        // The list revision just verified; the legacy zip version only for servers that publish no list
        filesVersion: verifiedRevision || store.get('filesVersion') || '',
        launcherVersion: app.getVersion(),
        plugins: Array.isArray(serverInfo.loadOrder)
          ? serverInfo.loadOrder.map(f => path.basename(f))
          : [],
      }, { 'x-session': session })
      if (!check.ok) {
        if (check.launcherOk === false) {
          return { success: false, error: 'A launcher update is required before you can play. Press Update launcher on the main screen, then Play.' }
        }
        if (check.filesOk === false) {
          return { success: false, error: 'Your client files are out of date. Press Play again to update them, then launch.' }
        }
        return { success: false, error: 'Your plugin load order does not match the server. Press Verify, then try again.' }
      }
      log('[launch] launch-check passed')
    } catch (err) {
      log(`[launch] launch-check unavailable (${err.message}) - continuing, server will enforce`)
    }
  }

  // SKSE, client files, plugins, and Discord auth were all confirmed by the staging gate above.
  return { success: true, loadOrderFixed }
}

const VANILLA_MASTERS = new Set([
  'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm', '_resourcepack.esl',
])

function pluginsTxtDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const variants = [
    'Skyrim Special Edition',
    'Skyrim Special Edition GOG',
    'Skyrim Special Edition EPIC',
    'Skyrim Special Edition MS',
  ]
  const existing = variants.map(v => path.join(local, v)).filter(p => fs.existsSync(p))
  return existing.length > 0 ? existing : [path.join(local, variants[0])]
}

// Plugin sync
function fixLoadOrder(skyrimPath, serverLoadOrder) {
  const dataDir = path.join(skyrimPath, 'Data')

  const serverPlugins = serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()))

  const missing = serverPlugins.filter(f => !fs.existsSync(path.join(dataDir, f)))
  if (missing.length > 0) return { changed: false, missing }
  // Dovakarn's own game copy has its own Plugins.txt (gameProfile.js); the player's, in AppData, is never written
  if (gameSetup) return { changed: gameProfile.writeLoadOrder(skyrimPath, serverLoadOrder), missing: [] }

  const next  = serverPlugins.map(f => `*${f}`).join('\r\n') + '\r\n'
  let changed = false

  for (const dir of pluginsTxtDirs()) {
    const pluginsPath = path.join(dir, 'Plugins.txt')

    let current = null
    try { current = fs.readFileSync(pluginsPath, 'utf8') } catch {}

    if (current !== next) {
      const dropped = (current || '')
        .split(/\r?\n/)
        .filter(l => l.startsWith('*'))
        .map(l => l.slice(1).trim())
        .filter(f => f && !serverPlugins.some(p => p.toLowerCase() === f.toLowerCase()) &&
                     !VANILLA_MASTERS.has(f.toLowerCase()))
      if (dropped.length > 0) {
        log(`[launch] disabling client-side plugins (not allowed on this server): ${dropped.join(', ')}`)
      }
      fs.mkdirSync(dir, { recursive: true })
      if (localTest.enabled && current !== null && !fs.existsSync(pluginsPath + '.before-local-test')) {
        fs.copyFileSync(pluginsPath, pluginsPath + '.before-local-test')
      }
      fs.writeFileSync(pluginsPath, next)
      changed = true
      log(`[launch] wrote ${pluginsPath} (exactly ${serverPlugins.length} server plugins)`)
    }
  }

  return { changed, missing: [] }
}

function missingPluginsForMO2(skyrimPath, serverLoadOrder) {
  const dataDir = path.join(skyrimPath, 'Data')
  const modsDir = mo2.getModsDir()

  let modDirs = []
  try {
    modDirs = fs.readdirSync(modsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => path.join(modsDir, e.name))
  } catch {}

  return serverLoadOrder
    .map(f => path.basename(f))
    .filter(f => !VANILLA_MASTERS.has(f.toLowerCase()))
    .filter(f =>
      !fs.existsSync(path.join(dataDir, f)) &&
      !modDirs.some(dir => fs.existsSync(path.join(dir, f))))
}

// Helpers

/**
 * Write the SkyMP client settings file (skymp5-client-settings.txt).
 *
 * Format per SkyMP docs:
 *
 *   Offline mode (server offlineMode: true):
 *     { "server-ip": "...", "server-port": N,
 *       "master": "", "server-master-key": null,
 *       "gameData": { "profileId": <integer> } }
 *
 *   Online mode (server offlineMode: false), the Dovakarn way:
 *     { "server-ip": "...", "server-port": N,
 *       "master": "<masterUrl>", "server-master-key": "<masterKey>", "discord-invite": "<invite>" }
 *     plus PluginsNoLoad/auth-data-no-load.js holding this launch's Discord play session, so the game
 *     logs in by itself. Game logins happen only through the launcher.
 *
 * @param {string} destPath   Absolute path to skymp5-client-settings.txt
 * @param {object} srv        Active server entry { address, port }
 * @param {object} serverInfo Cached serverinfo { offlineMode, masterKey, masterUrl }
 * @param {object} login      This launch's Discord login { session, account, master, masterKey, inviteUrl }, or null
 * @param {object} gameKeys   The game client's own keys from the file check ({ dodgeKeyCode: 29, ... }), or null
 */
function writeClientSettings(destPath, srv, serverInfo, login = null, gameKeys = null) {
  if (localTest.enabled) {
    const settings = { ...localTest.clientSettings(srv, login), ...gameKeySettings(gameKeys) }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    // Preserve the previous online configuration for inspection/recovery.
    if (fs.existsSync(destPath) && !fs.existsSync(destPath + '.before-local-test')) {
      fs.copyFileSync(destPath, destPath + '.before-local-test')
    }
    fs.writeFileSync(destPath, JSON.stringify(settings, null, 2) + '\n')
    writeGameLogin(destPath, login)
    return
  }
  // Start fresh every time - do not preserve stale keys from previous writes.
  const settings = {}

  settings['server-ip']   = srv.address
  settings['server-port'] = Number(srv.port)

  // Without a login (client file installs) the game gets no session and asks the player to use the launcher
  settings['master']            = serverInfo?.masterUrl || login?.master || ''
  settings['server-master-key'] = serverInfo?.masterKey || login?.masterKey || null
  settings['discord-invite']    = login?.inviteUrl || ''
  Object.assign(settings, gameKeySettings(gameKeys))

  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.writeFileSync(destPath, JSON.stringify(settings, null, 2) + '\n')
  writeGameLogin(destPath, login)
}

// The SkyMP client reads its login from PluginsNoLoad/auth-data-no-load.js ("//" + JSON). A launch without Discord
// (the local offline test) blanks it, so an older session never lies around for the game to reuse.
function writeGameLogin(settingsPath, login) {
  const authDataPath = path.join(path.dirname(settingsPath), '..', 'PluginsNoLoad', 'auth-data-no-load.js')
  const data = login ? {
    session:              login.session,
    masterApiId:          login.account.number,
    discordUsername:      login.account.name || null,
    discordDiscriminator: null,
    discordAvatar:        login.account.avatar || null,
  } : null
  gameLogin.write(authDataPath, data)
  if (login) log(`[launch] game login written for #${login.account.number}`)
}

function fetchJSON(url, headers = {}, redirectsLeft = 3) {
  if (localTest.enabled && url.startsWith(config.apiUrl + '/')) {
    // With no server address set (config.js), the address is the path alone
    const endpoint = new URL(url, 'http://local-test.invalid').pathname
    if (endpoint === '/api/servers') return Promise.resolve([localTest.server])
    if (endpoint === '/api/serverinfo') return Promise.resolve(localTest.info)
    return Promise.reject(new Error('Online services are disabled during local testing.'))
  }
  if (!/^https?:\/\//.test(url)) return Promise.reject(new Error('This launcher has no Dovakarn server address. The server owner sets it before building the launcher.'))
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const opts   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith('https') ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers,
    }
    const req = mod.request(opts, res => {
      // Follow same-host redirects (e.g. the reverse proxy upgrading http to
      // https). Cross-host hops and https->http downgrades stay errors so the
      // session header can never leak to another origin.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        let next = null
        try { next = new URL(res.headers.location, url) } catch { /* malformed location */ }
        const sameHost  = next && next.hostname === urlObj.hostname
        const downgrade = next && urlObj.protocol === 'https:' && next.protocol !== 'https:'
        if (next && sameHost && !downgrade && redirectsLeft > 0) {
          return resolve(fetchJSON(next.href, headers, redirectsLeft - 1))
        }
        const e = new Error(`HTTP ${res.statusCode} from ${url}, sending it on to ${res.headers.location}`)
        e.statusCode = res.statusCode
        reject(e)
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Read a little of the body: backend errors carry an explanatory
        // { error } that is far more useful than the bare status code.
        let body = ''
        res.on('data', c => { if (body.length < 4096) body += c })
        res.on('end', () => {
          let detail = ''
          try { detail = JSON.parse(body).error || '' } catch { /* not JSON */ }
          const e = new Error(`HTTP ${res.statusCode} from ${url}${detail ? `: ${detail}` : ''}`)
          e.statusCode   = res.statusCode
          e.serverError  = detail || undefined
          reject(e)
        })
        res.on('error', () => {
          const e = new Error(`HTTP ${res.statusCode} from ${url}`)
          e.statusCode = res.statusCode
          reject(e)
        })
        return
      }
      // Accumulate Buffers, not a growing string: the install manifest can be
      // hundreds of MB and string += chunk degrades quadratically there.
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy()
      reject(new Error(`Request timed out: ${url}`))
    })
    req.end()
  })
}

// POST JSON and parse the JSON reply. No redirect following: launch-check and
// friends are same-origin API calls where a redirect means misconfiguration.
function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod    = url.startsWith('https') ? https : http
    const urlObj = new URL(url)
    const payload = JSON.stringify(body || {})
    const req = mod.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || (url.startsWith('https') ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`HTTP ${res.statusCode} from ${url}`)
          e.statusCode = res.statusCode
          return reject(e)
        }
        try { resolve(JSON.parse(data)) }
        catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error(`Request timed out: ${url}`)) })
    req.write(payload)
    req.end()
  })
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}
