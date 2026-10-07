// combat-test paths and --combat-test are the local test server's folder layout and launch flag.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const settle = () => new Promise(resolve => setImmediate(resolve))

// modules: stand-ins for the launcher's own modules; ipcMain: records the handlers main.js sets up
// localTest: the test launcher's mode (default: the combat one when combat, else none)
// dialog: a stand-in for Electron's dialog (default: any error box fails the test)
async function boot(combat, { modules = {}, ipcMain = { handle() {}, on() {} }, localTest = { combat, enabled: combat }, dialog = null } = {}) {
  const order = [], windows = [], timers = [], app = new EventEmitter()
  Object.assign(app, {
    isPackaged: true,
    disableHardwareAcceleration() { order.push('software-rendering') },
    requestSingleInstanceLock: () => true,
    getVersion: () => '2.1.2',
    getPath: name => `C:\\FakeUser\\${name}`,
    whenReady() { order.push('when-ready'); return Promise.resolve() },
    quit() { assert.fail('Primary instance should not quit') },
  })
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); order.push('window'); windows.push(this); this.options = options
      // The page answers once its fonts are loaded and a frame is painted with them.
      const painted = new Promise((resolve, reject) => { this.fontsPainted = resolve; this.pageGone = reject })
      this.webContents = Object.assign(new EventEmitter(), { send() {}, executeJavaScript: code => { this.revealScript = code; return painted }, setWindowOpenHandler: fn => { this.openHandler = fn } })
      this.visible = false; this.destroyed = false
    }
    loadFile(file) { this.file = file; return Promise.resolve() }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    isVisible() { return this.visible }
    show() { this.visible = true }
    focus() { this.focused = true }
  }
  const srcDir = path.resolve(__dirname, '../src')
  const source = fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8')
  const sandbox = { __dirname: srcDir, console, Buffer, URL, AbortController, setTimeout: (fn, ms) => timers.push({ fn, ms }),
    process: { argv: ['electron', '.', ...(combat ? ['--combat-test'] : [])], platform: 'win32', env: {} },
    require: name => {
      if (name in modules) return modules[name]
      if (name === 'electron') return { app, BrowserWindow, ipcMain,
        dialog: dialog || { showErrorBox: (...args) => assert.fail(args.join(' ')) }, shell: {}, safeStorage: { isEncryptionAvailable: () => false } }
      if (name === './discordLogin') return require('../src/discordLogin')
      if (name === './gameLogin') return require('../src/gameLogin')
      if (name === './updateFile') return require('../src/updateFile')
      if (name === 'electron-store') return class { get(key) { return key === 'skyrimPath' ? 'G:\\FakeSkyrim' : '' } }
      if (name === './config' || name === './ini' || name === './skyrimVersion') return {}
      if (name === './localTest') return { ...localTest, server: { name: 'Dovakarn-Local-Test' } }
      if (name === './mo2') return { setLogger() {}, setRootProvider() {} }
      if (name === './launcherLifecycle') return require('../src/launcherLifecycle')
      if (name === './fileCheck') return require('../src/fileCheck')
      if (name === './modSettings') return require('../src/modSettings')
      if (name === './gameControls') return require('../src/gameControls')
      if (name === './skyrimProcess') return require('../src/skyrimProcess')
      if (name === './gameFolder') return require('../src/gameFolder')
      // Dovakarn's own game copy: made only at load, nothing touches a disk until the page asks
      if (name === './gameCopy') return require('../src/gameCopy')
      if (name === './gameProfile') return require('../src/gameProfile')
      if (name === './gameSetup') return require('../src/gameSetup')
      // The Nexus window: Electron's session and views are reached only when the player opens it
      if (name === './nexusDownloads') return require('../src/nexusDownloads')
      // The player's Nexus account: nothing reaches the network until the page asks for its state or a login
      if (name === './nexusAccount') return require('../src/nexusAccount')
      if (name === './launchProcess') return { launchDetached: () => assert.fail('Bootstrap must not launch Skyrim') }
      if (name === 'fs') return { existsSync: () => true }
      if (name === 'child_process') return { spawn: () => assert.fail('No child process expected'), execFileSync: () => assert.fail('No registry query needed') }
      if (['path', 'os', 'crypto', 'http', 'https'].includes(name)) return require(name)
      throw Error('Unexpected bootstrap import ' + name)
    },
  }
  vm.runInNewContext(source, sandbox)
  await new Promise(resolve => setImmediate(resolve))
  return { order, windows, timers, app, sandbox }
}

test('real combat bootstrap selects software rendering before readiness and opens its visible UI', async () => {
  const h = await boot(true)
  assert.deepEqual(h.order, ['software-rendering', 'when-ready', 'window'])
  assert.match(h.windows[0].file, /local-play\.html$/)
  assert.equal(h.windows[0].options.backgroundColor, '#090e14', 'The window colour matches the page behind the video')
  assert.equal(h.windows[0].visible, false, 'Hidden until its first frame is painted, so it never shows a half-drawn page')
  h.windows[0].emit('ready-to-show')
  await settle()
  assert.equal(h.windows[0].visible, false, 'A first frame without its fonts is not shown either')
  assert.match(h.windows[0].revealScript, /document\.fonts\.ready/)
  h.windows[0].fontsPainted(true); await settle()
  assert.deepEqual([h.windows[0].visible, h.windows[0].focused], [true, true])
  h.windows[0].visible = false
  h.app.emit('second-instance', {}, ['electron', '.', '--combat-test'])
  assert.equal(h.windows[0].visible, true, 'A second shortcut shows the existing window at once')
  assert.equal(h.windows.length, 1)
})

test('a launcher whose first frame is slow still appears after three seconds', async () => {
  const h = await boot(true), fallback = h.timers.find(timer => timer.ms === 3000)
  assert.ok(fallback, 'A fallback timer is set')
  assert.equal(h.windows[0].visible, false)
  fallback.fn()
  assert.equal(h.windows[0].visible, true)
  const gone = await boot(true)
  gone.windows[0].emit('ready-to-show'); gone.windows[0].pageGone(Error('Render frame was disposed')); await settle()
  assert.equal(gone.windows[0].visible, true, 'A page that cannot answer still gets its window shown')
})

test('the online launcher opens the same Dovakarn page with hardware rendering kept', async () => {
  const h = await boot(false)
  assert.deepEqual(h.order, ['when-ready', 'window'], 'No software rendering outside the local test')
  assert.match(h.windows[0].file, /local-play\.html$/, 'One page for every mode')
  assert.equal(h.windows[0].options.backgroundColor, '#090e14')
  assert.match(h.windows[0].options.webPreferences.preload, /local-preload\.js$/)
  h.windows[0].emit('ready-to-show'); h.windows[0].fontsPainted(true); await settle()
  assert.equal(h.windows[0].visible, true)
})

test('the online launcher plays from Dovakarn\'s own game copy; the basic test launcher (no copy) keeps its old steps', async () => {
  const online = (await boot(false)).sandbox.onlinePlayDeps()
  assert.deepEqual(['prepareGame', 'buildGame', 'gameCopyState'].map(k => typeof online[k]), ['function', 'function', 'function'])
  // The basic local test (--local-test without the combat server) still uses the online steps, with no game copy
  const basic = (await boot(false, { localTest: { combat: false, enabled: true } })).sandbox.onlinePlayDeps()
  assert.deepEqual(['prepareGame', 'buildGame', 'gameCopyState'].map(k => basic[k]), [undefined, undefined, undefined])
  assert.equal(typeof basic.checkFiles, 'function')
})

test('the Nexus window is made only when the player asks, and only the launcher page may ask', async () => {
  const handlers = new Map(), listeners = new Map()
  const cwdIncoming = require('node:path').join(process.cwd(), '.incoming'), before = fs.existsSync(cwdIncoming)
  const h = await boot(false, { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) } })
  assert.deepEqual(['nexus:open', 'nexus:snapshot', 'nexus:logout', 'nexus:action'].map(n => typeof handlers.get(n)), ['function', 'function', 'function', 'function'])
  assert.deepEqual(['nexus:strip-ready', 'nexus:strip-height'].map(n => typeof listeners.get(n)), ['function', 'function'])
  assert.equal(h.app.listenerCount('before-quit'), 1, 'quitting is known, so no install starts then')
  assert.equal(handlers.has('game:openMod'), false, 'the old browser route is the strip\'s Open in my browser now')
  assert.equal(h.windows.length, 1, 'no Nexus window at start')
  const sent = []
  h.windows[0].webContents.send = (channel, value) => sent.push([channel, value])
  const ask = async (sender, request) => ({ ...await handlers.get('nexus:open')({ sender }, request) })
  assert.deepEqual(await ask({}, { archive: null }), { success: false, error: 'Unknown mod.' }, 'another page cannot ask')
  for (const bad of [{ archive: 5 }, { archive: '../1' }, '1', null, { archive: '1'.repeat(13) }, {}]) {
    assert.deepEqual(await ask(h.windows[0].webContents, bad), { success: false, error: 'Unknown mod.' }, JSON.stringify(bad))
  }
  assert.deepEqual(sent, [], 'a refused ask reaches nothing')
  // The fake store has no Dovakarn folder; the fake electron has no session, so touching it would throw
  assert.deepEqual(await ask(h.windows[0].webContents, { archive: null }), { success: false, error: 'Set up Dovakarn first.' })
  assert.equal(fs.existsSync(cwdIncoming), before, 'no .incoming where the tests run')
  assert.equal(h.windows.length, 1, 'still the launcher window only')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], 'nexus:state')
  assert.equal(sent[0][1].open, false)
  // The page reads the state at start; another page gets nothing, and only the launcher page may log out of Nexus
  assert.deepEqual(JSON.parse(JSON.stringify(await handlers.get('nexus:snapshot')({ sender: h.windows[0].webContents }))),
    { open: false, installQueued: false, installing: false, removing: false, removeAsking: false, current: null, account: { user: '', login: 'unknown', kept: false },
      direct: { running: false, problem: null }, premium: false, archives: {} })
  assert.equal(await handlers.get('nexus:snapshot')({ sender: {} }), null)
  assert.deepEqual({ ...await handlers.get('nexus:logout')({ sender: {} }) }, { success: false })
  // The Nexus account and the automatic download's Stop: only the launcher page may ask, and nothing reaches Nexus or the
  // Dovakarn server for another page
  assert.deepEqual(['nexus:stop', 'nexusAccount:state', 'nexusAccount:login', 'nexusAccount:cancel', 'nexusAccount:logout'].map(n => typeof handlers.get(n)), ['function', 'function', 'function', 'function', 'function'])
  assert.deepEqual({ ...await handlers.get('nexus:stop')({ sender: {} }) }, { success: false })
  assert.deepEqual({ ...await handlers.get('nexus:stop')({ sender: h.windows[0].webContents }) }, { success: true, stopped: false }, 'nothing running: Stop has nothing to do')
  assert.equal(await handlers.get('nexusAccount:state')({ sender: {} }), null)
  assert.deepEqual({ ...await handlers.get('nexusAccount:login')({ sender: {} }) }, { success: false, error: "This launcher plays from the server's game copy." })
  assert.equal(await handlers.get('nexusAccount:cancel')({ sender: {} }), null)
  assert.deepEqual({ ...await handlers.get('nexusAccount:logout')({ sender: {} }) }, { success: false })
  // The strip's calls from a page that is not the Nexus window change nothing
  assert.deepEqual({ ...await handlers.get('nexus:action')({ sender: h.windows[0].webContents }, 'close') }, { success: false })
  listeners.get('nexus:strip-ready')({ sender: h.windows[0].webContents })
  listeners.get('nexus:strip-height')({ sender: h.windows[0].webContents }, 300)
  assert.equal(h.windows.length, 1)
})

test('Remove Dovakarn: Cancel leaves the Nexus window and its download alone; Remove stops their work first, then deletes the folder', async () => {
  const handlers = new Map(), order = [], answers = [1, 0, 0]
  const realNexus = require('../src/nexusDownloads')
  let removeFails = null
  await boot(false, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    dialog: { showErrorBox: (...args) => assert.fail(args.join(' ')), showMessageBox: async () => { order.push('confirm'); return { response: answers.shift() } } },
    modules: {
      './gameSetup': { createGameSetup: () => ({ installDir: () => 'C:\\Dovakarn', DEFAULT_INSTALL_DIR: 'C:\\Dovakarn', neededArchives: () => null, downloadsDir: () => 'C:\\Dovakarn\\Downloads',
        remove: async () => { order.push('remove'); if (removeFails) throw removeFails; return { success: true } } }) },
      './localPlay': { LocalPlay: class { constructor() { this.busy = false } async running() { return false } folderChanged() { order.push('folderChanged') } } },
      './nexusDownloads': { ...realNexus, createNexusDownloads: options => { const n = realNexus.createNexusDownloads(options); return { ...n, close: () => order.push('close'), stopWhile: task => { order.push('stopWhile'); return n.stopWhile(task) },
        removeEnded: removed => { order.push(`removeEnded ${removed}`); return n.removeEnded(removed) } } } },
    },
  })
  assert.deepEqual({ ...await handlers.get('game:remove')() }, { success: false, cancelled: true })
  assert.deepEqual(order, ['confirm', 'removeEnded false'], 'Cancel: nothing of the Nexus window touched, and an install it held back is asked for now')
  assert.deepEqual({ ...await handlers.get('game:remove')() }, { success: true })
  assert.deepEqual(order, ['confirm', 'removeEnded false', 'confirm', 'stopWhile', 'remove', 'folderChanged', 'removeEnded true'], 'the window\'s work stops before the folder goes, and then nothing installs into it')
  // Stopped partway (a file in use): files may already be gone, so it counts as removed and nothing installs into what is
  // left; the page reads the folder afresh, and the player gets plain words, never the error's code
  order.length = 0
  removeFails = Object.assign(new Error("EBUSY: resource busy or locked, rmdir 'C:\\Dovakarn\\Game\\Data'"), { code: 'EBUSY' })
  assert.deepEqual({ ...await handlers.get('game:remove')() }, { success: false, error: 'Dovakarn could not be removed completely. Close any program that is using its folder, then press Remove again.' })
  assert.deepEqual(order, ['confirm', 'stopWhile', 'remove', 'folderChanged', 'removeEnded true'])
  // And a later Remove can still run
  removeFails = null; answers.push(0); order.length = 0
  assert.deepEqual({ ...await handlers.get('game:remove')() }, { success: true })
  assert.deepEqual(order, ['confirm', 'stopWhile', 'remove', 'folderChanged', 'removeEnded true'])
})

test('while Remove Dovakarn\'s dialog is open nothing starts (no check, no game, no mods install) and the page knows; what started meanwhile stops the Remove', async () => {
  const handlers = new Map(), order = [], sent = []
  let answer = null, playerDeps = null, trigger = null, install = { queued: false, running: false }, busy = false, removeGate = null
  const realNexus = require('../src/nexusDownloads')
  const h = await boot(false, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    dialog: { showErrorBox: (...args) => assert.fail(args.join(' ')), showMessageBox: () => new Promise(resolve => { answer = resolve }) },
    modules: {
      './gameSetup': { createGameSetup: () => ({ installDir: () => 'C:\\Dovakarn', DEFAULT_INSTALL_DIR: 'C:\\Dovakarn', neededArchives: () => null, downloadsDir: () => 'C:\\Dovakarn\\Downloads',
        remove: async () => { if (removeGate) await removeGate; order.push('remove'); return { success: true } } }) },
      './localPlay': { LocalPlay: class { constructor(deps) { playerDeps = deps } get busy() { return busy } async running() { return false } folderChanged() {} } },
      './nexusDownloads': { ...realNexus, createInstallTrigger: options => { trigger = options; return { request() {}, state: () => install } } },
    },
  })
  h.windows[0].webContents.send = (channel, value) => sent.push([channel, JSON.parse(JSON.stringify(value))])
  const page = { sender: h.windows[0].webContents }, said = () => sent.filter(([c]) => c === 'nexus:state').at(-1)?.[1]
  // The press, settled up to the dialog; its answer comes later ({ result }: never adopted while the dialog waits)
  const pressRemove = async () => { answer = null; const result = handlers.get('game:remove')(); await settle(); return { result } }
  // Remove pressed: its dialog waits on the player
  const { result: removing } = await pressRemove()
  assert.equal(typeof answer, 'function', 'the dialog is open')
  assert.equal(await trigger.idle(), false, 'the mods install waits')
  assert.equal(playerDeps.held(), 'Wait until Dovakarn is removed.', 'Play, Check and Set up refuse')
  // The page is told the dialog is open (so the Nexus window closing for it starts no check), and keeps its words until the
  // player confirms
  assert.deepEqual([said().removeAsking, said().removing], [true, false])
  assert.deepEqual([(await handlers.get('nexus:snapshot')(page)).removeAsking, (await handlers.get('nexus:snapshot')(page)).removing], [true, false])
  assert.deepEqual({ ...await handlers.get('nexus:open')(page, { archive: null }) }, { success: false, error: 'Wait until Dovakarn is removed.' }, 'no Nexus window')
  assert.deepEqual({ ...await handlers.get('game:remove')() }, { success: false, error: 'Wait until Dovakarn is removed.' }, 'no second Remove')
  // The mods install was asked for while the dialog was open: Remove, confirmed, is refused and the folder stays
  install = { queued: true, running: false }
  answer({ response: 0 })
  assert.deepEqual({ ...await removing }, { success: false, error: 'Wait until the mods are installed, then remove Dovakarn.' })
  assert.deepEqual([order, playerDeps.held(), await trigger.idle(), said().removing, said().removeAsking], [[], '', true, false, false], 'and everything can start again')
  // Queued before the press: refused at once, no dialog
  const { result: queued } = await pressRemove()
  assert.deepEqual([{ ...await queued }, answer], [{ success: false, error: 'Wait until the mods are installed, then remove Dovakarn.' }, null])
  install = { queued: false, running: true }
  const { result: running } = await pressRemove()
  assert.deepEqual([{ ...await running }, answer], [{ success: false, error: 'Wait until the mods are installed, then remove Dovakarn.' }, null], 'nor while it runs')
  // A check that started while the dialog was open stops the Remove too
  install = { queued: false, running: false }
  const { result: checking } = await pressRemove()
  busy = true; answer({ response: 0 })
  assert.deepEqual({ ...await checking }, { success: false, error: 'Close Skyrim and wait for the current check to finish first.' })
  busy = false
  // Nothing in the way: confirmed, the page says Dovakarn is being removed while the folder goes, then removed
  let gone
  removeGate = new Promise(resolve => { gone = resolve })
  const { result: last } = await pressRemove()
  answer({ response: 0 })
  await settle(); await settle()
  assert.deepEqual([said().removing, said().removeAsking, playerDeps.held(), await trigger.idle()], [true, false, 'Wait until Dovakarn is removed.', false])
  gone()
  assert.deepEqual({ ...await last }, { success: true })
  assert.deepEqual([order, said().removing, said().removeAsking], [['remove'], false, false])
})

test('the browser route and a mods folder of the player\'s own: only the launcher page asks, only for a needed download or a folder picked in Windows', async () => {
  const handlers = new Map(), opened = [], folders = [], pickers = [], forgotten = []
  let pick = { canceled: true, filePaths: [] }
  const h = await boot(false, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    dialog: { showErrorBox: (...args) => assert.fail(args.join(' ')), showOpenDialog: async (_win, options) => { pickers.push(JSON.parse(JSON.stringify(options))); return pick } },
    modules: {
      './gameSetup': { createGameSetup: () => ({ installDir: () => 'C:\\Dovakarn', DEFAULT_INSTALL_DIR: 'C:\\Dovakarn', neededArchives: () => null, downloadsDir: () => 'C:\\Dovakarn\\Downloads',
        openMod: id => { opened.push(id); return { success: true } }, addModsFolder: dir => { folders.push(dir); return { success: true, dir } },
        forgetModsFolder: dir => { forgotten.push(dir); return { success: true } } }) },
    },
  })
  const launcher = h.windows[0].webContents, ask = async (name, sender, ...args) => JSON.parse(JSON.stringify(await handlers.get(name)({ sender }, ...args)))
  assert.deepEqual(await ask('nexus:browser', {}, { archive: '454617' }), { success: false, error: 'Unknown mod.' }, 'another page cannot ask')
  for (const bad of [{ archive: null }, { archive: 5 }, { archive: '../1' }, { archive: '1'.repeat(13) }, '1', null, {}]) {
    assert.deepEqual(await ask('nexus:browser', launcher, bad), { success: false, error: 'Unknown mod.' }, JSON.stringify(bad))
  }
  assert.deepEqual(opened, [], 'nothing opened for a refused ask')
  assert.deepEqual(await ask('nexus:browser', launcher, { archive: '454617' }), { success: true })
  assert.deepEqual(opened, ['454617'], 'the exact download, through the install list (gameSetup.openMod)')
  // A folder: Windows' own folder picker, from the launcher page only
  assert.equal((await ask('game:modsFolder', {})).success, false)
  assert.deepEqual(pickers, [], 'another page opens no picker')
  assert.deepEqual(await ask('game:modsFolder', launcher), { success: false, cancelled: true })
  assert.deepEqual(pickers, [{ properties: ['openDirectory'], title: 'Choose the folder your mod downloads are in' }])
  pick = { canceled: false, filePaths: ['D:\\Vortex Downloads\\skyrimse'] }
  assert.deepEqual(await ask('game:modsFolder', launcher), { success: true, dir: 'D:\\Vortex Downloads\\skyrimse' })
  assert.deepEqual(folders, ['D:\\Vortex Downloads\\skyrimse'], 'kept by gameSetup, which checks it')
  // Settings, Mods: Forget one, from the launcher page only, as text (gameSetup checks it is one it keeps)
  assert.equal((await ask('game:forgetModsFolder', {}, 'D:\\Vortex Downloads\\skyrimse')).success, false)
  for (const bad of [5, null, '', 'x'.repeat(1025), { dir: 'D:\\x' }]) assert.equal((await ask('game:forgetModsFolder', launcher, bad)).success, false, JSON.stringify(bad))
  assert.deepEqual(forgotten, [], 'nothing forgotten for a refused ask')
  assert.deepEqual(await ask('game:forgetModsFolder', launcher, 'D:\\Vortex Downloads\\skyrimse'), { success: true })
  assert.deepEqual(forgotten, ['D:\\Vortex Downloads\\skyrimse'])
})

test('the update install and the game login file\'s limit are wired to their tested modules', async () => {
  const handlers = new Map(), calls = {}
  const realGameLogin = require('../src/gameLogin')
  const realDiscordLogin = require('../src/discordLogin')
  await boot(false, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    modules: {
      './updateFile': { ...require('../src/updateFile'), installUpdate: async options => { calls.installUpdate = options; return { ok: true } } },
      './gameLogin': { createGameLogin: options => { calls.gameLogin = options; return realGameLogin.createGameLogin(options) }, restrictToUser: (file, options) => { calls.restricted = [file, typeof options.log] } },
      './discordLogin': { ...realDiscordLogin, createDiscordLogin: options => { const real = realDiscordLogin.createDiscordLogin(options); return { ...real, finishLogouts: () => { calls.finishLogouts = true; return Promise.resolve(0) } } } },
    },
  })
  // A logout the server never received is sent again at start (discordLogin.finishLogouts)
  assert.equal(calls.finishLogouts, true, 'kept logouts are retried at start')
  // The update: the tested flow (updateFile.installUpdate), its installer kept in the temp folder
  assert.deepEqual(await handlers.get('app:installUpdate')(), { ok: true })
  assert.match(calls.installUpdate.dest, /DovakarnLauncher-update\.exe$/)
  for (const step of ['fetchVersion', 'download', 'run', 'quit', 'progress', 'remember']) assert.equal(typeof calls.installUpdate[step], 'function', step)
  // The game's login file is limited to this user by the tested helper (gameLogin.restrictToUser)
  calls.gameLogin.restrict('G:/FakeSkyrim/Data/Platform/PluginsNoLoad/auth-data-no-load.js')
  assert.deepEqual(calls.restricted, ['G:/FakeSkyrim/Data/Platform/PluginsNoLoad/auth-data-no-load.js', 'function'])
})

test('Settings, Controls keeps only keys Skyrim can read, and Reset puts the server keys back', async () => {
  const handlers = new Map(), stored = {}
  await boot(false, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    modules: { 'electron-store': class { get(key) { return key === 'skyrimPath' ? 'G:\\FakeSkyrim' : (stored[key] ?? '') } set(key, value) { stored[key] = value } } },
  })
  // Objects made inside main.js's sandbox are compared as plain data
  const plain = value => JSON.parse(JSON.stringify(value)), keys = () => plain(stored.modKeys)
  const set = async (id, key) => plain(await handlers.get('controls:set')(null, { id, key }))
  const TDM = 'Data/MCM/Settings/TrueDirectionalMovement.ini|Keys|uTargetLockKey', UI = 'Data/MCM/Settings/SkyUI_SE.ini|Controls|iSearchKey'
  assert.deepEqual(await set(TDM, 258), { success: true })
  assert.deepEqual(await set(UI, -1), { success: true }, 'No key is a choice too')
  assert.deepEqual(keys(), { [TDM]: 258, [UI]: -1 })
  for (const bad of [0, 282, 1.5, 'F1', undefined, {}]) assert.equal((await set(TDM, bad)).success, false, `refused: ${JSON.stringify(bad)}`)
  assert.equal((await set('', 30)).success, false, 'a key needs its id')
  assert.equal((await set('x'.repeat(401), 30)).success, false)
  assert.deepEqual(keys(), { [TDM]: 258, [UI]: -1 }, 'a refused key changes nothing')
  assert.deepEqual(await set(TDM, null), { success: true })
  assert.deepEqual(keys(), { [UI]: -1 }, 'null gives the key back to the server')
  // A store edited by hand keeps only what the launcher itself would have saved
  stored.modKeys = { [TDM]: 'rubbish', [UI]: 57 }
  await set('Data/MCM/Settings/TrueHUD.ini|Keys|uKey', 30)
  assert.deepEqual(keys(), { [UI]: 57, 'Data/MCM/Settings/TrueHUD.ini|Keys|uKey': 30 })
  assert.deepEqual(plain(await handlers.get('controls:reset')()), { success: true })
  assert.deepEqual(keys(), {})
})

test('the launcher update runs the installer silently and restarts; one that did not change the version is offered again, three times at most', async t => {
  const http = require('node:http'), handlers = new Map(), calls = {}, spawned = [], stored = {}
  const H = 'a'.repeat(64)
  let answer = { version: '2.1.3', downloadUrl: 'https://example.invalid/DovakarnLauncher.exe', sha256: H }
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(req.url === '/api/version' ? answer : {})) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const h = await boot(false, {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    modules: {
      './config': { apiUrl: `http://127.0.0.1:${server.address().port}` },
      './updateFile': { ...require('../src/updateFile'), installUpdate: async options => { calls.installUpdate = options; return { ok: true } } },
      'electron-store': class { get(key) { return key === 'skyrimPath' ? 'G:\\FakeSkyrim' : (stored[key] ?? '') } set(key, value) { stored[key] = value } },
      child_process: { spawn: (file, args, options) => { spawned.push([file, [...args], { ...options }]); return { unref() {} } }, execFileSync: () => assert.fail('No registry query needed') },
    },
  })
  let version = '2.1.2'
  h.app.getVersion = () => version
  const check = async () => ({ ...await handlers.get('app:checkUpdate')() })
  // Offered: a newer version, never tried here
  assert.deepEqual(await check(), { current: '2.1.2', latest: '2.1.3', hasUpdate: true, reached: true, retry: false, downloadUrl: answer.downloadUrl })
  // The installer runs silently (/S) and starts the launcher again (--force-run), on its own; the attempt is recorded
  await handlers.get('app:installUpdate')()
  assert.deepEqual([calls.installUpdate.current, calls.installUpdate.attempt], ['2.1.2', null])
  calls.installUpdate.run('C:\\Temp\\DovakarnLauncher-update.exe')
  assert.deepEqual(spawned, [['C:\\Temp\\DovakarnLauncher-update.exe', ['/S', '--force-run'], { detached: true, stdio: 'ignore' }]])
  calls.installUpdate.remember({ sha256: H, fromVersion: '2.1.2', attempts: 1 })
  // Still 2.1.2 afterwards (the admin prompt answered No): offered again, as a retry
  assert.deepEqual(await check(), { current: '2.1.2', latest: '2.1.3', hasUpdate: true, reached: true, retry: true, downloadUrl: answer.downloadUrl })
  await handlers.get('app:installUpdate')()
  assert.deepEqual({ ...calls.installUpdate.attempt }, { sha256: H, fromVersion: '2.1.2', attempts: 1 })
  // Three times from this version: not offered again, the log says so once, and the launcher can tell the player
  stored.updateAttempt = { sha256: H, fromVersion: '2.1.2', attempts: 3 }
  const said = [], log = console.log; console.log = (...args) => said.push(args.join(' '))
  let blockedCheck
  try {
    blockedCheck = await check()
    assert.equal(blockedCheck.hasUpdate, false)
    assert.equal((await check()).hasUpdate, false)
  } finally { console.log = log }
  assert.equal(said.filter(line => line.includes('not offered again')).length, 1, 'said once in the log')
  assert.equal(blockedCheck.blocked, true, 'the renderer is told, so the player is not left with silence')
  assert.match(blockedCheck.blockedMessage, /tried 3 times.*Dovakarn Discord/s)
  // A new file for that version is offered as usual
  answer = { ...answer, sha256: 'b'.repeat(64) }
  assert.equal((await check()).hasUpdate, true)
  // The launcher's version changed since (the update worked, or another launcher was installed): the attempt is forgotten
  answer = { ...answer, sha256: H }
  version = '2.1.1'
  assert.deepEqual(await check(), { current: '2.1.1', latest: '2.1.3', hasUpdate: true, reached: true, retry: false, downloadUrl: answer.downloadUrl })
  assert.equal(stored.updateAttempt, null)
})

test('the launch readiness lines are plain sentences: no brackets, no semicolons joining them', async () => {
  // Every file the readiness check looks for is missing, except Update.esm, MpClientPlugin.dll and SkyrimSE.exe
  const missing = /(?:skymp5-client\.js|SkyrimPlatform\.dll|skse64_loader\.exe|d3dx9_42\.dll|winhttp\.dll|DovakarnProfile\.dll|Skyrim\.esm|MyPlugin\.esp)$/
  const h = await boot(false, { modules: {
    fs: { existsSync: p => !missing.test(String(p)) },
    './mo2': { setLogger() {}, setRootProvider() {}, detectEdition: () => 'Steam' },
    './skyrimVersion': { REQUIRED_SKYRIM_VERSION: '1.6.1170.0', readSkyrimExeVersion: async () => '1.6.1170.0', isExactVersionMatch: () => true },
  } })
  const problems = [...await h.sandbox.verifyLaunchReadiness('C:\\Dovakarn\\Game', false, { loadOrder: ['MyPlugin.esp'], offlineMode: true })]
  assert.deepEqual(problems, [
    'Multiplayer client files are missing: skymp5-client.js, SkyrimPlatform.dll. Press Verify. If that does not fix it, tell the Dovakarn staff.',
    "The script extender is missing from Dovakarn's game. It comes with the server's mods: press Verify to put it back.",
    "Dovakarn's copy of Skyrim is missing Skyrim.esm or Update.esm. Press Verify to repair it.",
    "Required plugins are missing: MyPlugin.esp. Press Verify to install the server's mods.",
    "The Engine Fixes preloader is missing: d3dx9_42.dll or winhttp.dll beside SkyrimSE.exe. Press Verify to install the server's mods. If your antivirus removed it, allow it there.",
    "DovakarnProfile.dll is missing from Dovakarn's game. Press Verify. If that does not fix it, tell the Dovakarn staff.",
  ])
  for (const line of problems) assert.doesNotMatch(line, /[();]/, line)
})
