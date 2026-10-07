const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const nx = require('../src/nexusDownloads')
const modInstall = require('../src/modInstall')
const { NEXUS_API } = require('../src/collectionCheck')

const { TIMES, LIMITS, STRIP, TEXT, SETTINGS_URL, FACTS_SCRIPT, VIEW_PREFS } = nx
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const scratch = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-nexus-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const settle = () => new Promise(resolve => setImmediate(resolve))
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await settle() }
const until = async (what, cond) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise(r => setTimeout(r, 5)); assert.ok(cond(), what) }
const ev = () => ({ prevented: false, preventDefault() { this.prevented = true } })
// A main-frame (or sub-frame) navigation; initiator: the frame that started it (PAGE: the Nexus step page's own main frame,
// AD: an ad's iframe on it)
const PAGE = { parent: null, url: 'https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=454617' }
const AD = { parent: { url: 'https://www.nexusmods.com/' }, url: 'https://ads.example/frame' }
const nav = (url, { isMainFrame = true, initiator } = {}) => ({ url, isMainFrame, initiator, prevented: false, preventDefault() { this.prevented = true } })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }

// Three needed downloads with real bytes, in the server's order (by name)
const mod = (id, modId, name, version, text) => { const bytes = Buffer.from(text); return { bytes, archive: { id, modId, fileId: Number(id), name, version, file: `${name}-${modId}.7z`, size: bytes.length, md5: md5(bytes) } } }
const SKYUI = mod('35407', 12604, 'SkyUI', '5.2', 'SkyUI archive '.repeat(30))
const TRUEHUD = mod('454617', 62775, 'TrueHUD', '1.1.9', 'TrueHUD archive '.repeat(20))
const XPMSSE = mod('469854', 1988, 'XP32 Maximum Skeleton Special Extended', '5.06', 'XPMSSE archive bytes '.repeat(30))
const ALL = [SKYUI, TRUEHUD, XPMSSE]
const stepOf = m => `https://www.nexusmods.com/skyrimspecialedition/mods/${m.archive.modId}?tab=files&file_id=${m.archive.fileId}`
const cdn = m => ({ url: `https://supporter-files.nexus-cdn.com/1704/${m.archive.modId}/${m.archive.name}.7z`, chain: [`https://supporter-files.nexus-cdn.com/1704/${m.archive.modId}/${m.archive.name}.7z`] })
const panel = (fileId, extra = {}) => ({ fileId: String(fileId), premium: 'false', loggedIn: 'false', nmm: 'false', ...extra })

let ids = 0
class FakeFrame {
  constructor(wc) { this.wc = wc; this.codes = [] }
  executeJavaScript(code) {
    this.codes.push(code)
    const f = typeof this.wc.facts === 'function' ? this.wc.facts() : this.wc.facts
    return f instanceof Error ? Promise.reject(f) : f && typeof f.then === 'function' ? f : Promise.resolve(f)
  }
  isDestroyed() { return this.wc.destroyed }
}
class FakeWebContents extends EventEmitter {
  constructor(session = null) { super(); Object.assign(this, { id: ++ids, loaded: [], sent: [], url: '', facts: null, destroyed: false, closed: 0, zoom: 1, session }); this.mainFrame = new FakeFrame(this) }
  loadURL(u) { this.loaded.push(u); this.url = u; return Promise.resolve() }
  loadFile(f) { this.file = f; return Promise.resolve() }
  getURL() { return this.url }
  isDestroyed() { return this.destroyed }
  close() { this.destroyed = true; this.closed++ }
  send(channel, value) { this.sent.push([channel, value]) }
  setWindowOpenHandler(fn) { this.openHandler = fn }
  getZoomFactor() { return this.zoom }
  openDevTools() {}
}
class FakeItem extends EventEmitter {
  constructor({ url, chain, filename = 'file.7z', total = 0 }) { super(); Object.assign(this, { url, chain: chain || [url], filename, total, received: 0, cancelled: 0, resumed: 0, resumable: false }) }
  getURL() { return this.url }
  getURLChain() { return this.chain }
  getFilename() { return this.filename }
  getTotalBytes() { return this.total }
  getReceivedBytes() { return this.received }
  setSavePath(p) { this.savePath = p }
  // Electron answers a cancel with 'done' cancelled, later
  cancel() { this.cancelled++; setImmediate(() => this.emit('done', {}, 'cancelled')) }
  canResume() { return this.resumable }
  resume() { this.resumed++ }
}

// removing: main's "Dovakarn is being removed" (its confirm dialog included), when a test plays it; removeAsking: only
// its confirm dialog is open so far
// realSleep: the module's own sleep, on the fake timers below, in place of the recorded one
function fixture(t, { archives = ALL, dev = false, request = async () => ({ body: Buffer.from(JSON.stringify({ data: { legacyModsByDomain: { nodes: [] } } })) }), downloads, removing, removeAsking, nexusAccount, realSleep = false } = {}) {
  const dir = scratch(t), f = { dir, downloads: downloads === undefined ? path.join(dir, 'Dovakarn', 'Downloads') : downloads }
  Object.assign(f, { windows: [], views: [], callOrder: [], partitions: [], electronCalls: 0, timers: [], mains: [], logs: [], opened: [], allDownloaded: 0,
    events: [], needed: archives.map(m => m.archive), clock: 1700000000000, lockAnswer: true, lockCalls: [], nexusName: '', nameSets: [],
    nexusLogin: 'unknown', loginSets: [], kept: false, hash: modInstall.hashFile, rename: fs.renameSync, renames: 0, sleeps: [], order: [], sleepImpl: null })
  class FakeSession extends EventEmitter {
    constructor() {
      super(); Object.assign(this, { uaCalls: 0, cleared: [], headerListeners: 0 })
      // Electron's ses.webRequest: the one onHeadersReceived listener this session gets, and its filter
      this.webRequest = { onHeadersReceived: (filter, listener) => { this.headersFilter = filter; this.onHeaders = listener; this.headerListeners++; f.callOrder.push('headers') } }
    }
    setUserAgent(ua, lang) { this.ua = ua; this.lang = lang; this.uaCalls++; f.callOrder.push('ua') }
    setPermissionRequestHandler(fn) { this.requestHandler = fn; f.callOrder.push('permissions') }
    setPermissionCheckHandler(fn) { this.checkHandler = fn }
    // Everything (Log out of Nexus), or one origin's storages (a page from outside Nexus that showed anyway)
    clearStorageData(options) { if (options) (this.origins ||= []).push(options); else this.cleared.push('storage'); return Promise.resolve() }
    clearCache() { this.cleared.push('cache'); return Promise.resolve() }
    clearAuthCache() { this.cleared.push('auth'); return Promise.resolve() }
  }
  f.ses = new FakeSession()
  f.defaultSession = new EventEmitter()            // the launcher's own session, which the strip page uses
  f.app = new EventEmitter()
  class FakeView {
    constructor(options) { this.options = options; this.webContents = new FakeWebContents(); f.views.push(this); f.callOrder.push('view') }
    setBounds(b) { this.bounds = b }
    setBackgroundColor(c) { this.color = c }
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.webContents = new FakeWebContents(f.defaultSession); this.contentView = { children: [], addChildView: v => this.contentView.children.push(v) }
      Object.assign(this, { size: [options.width, options.height], destroyed: false, visible: false, minimized: false, calls: [] })
      f.windows.push(this); f.callOrder.push('window')
    }
    loadFile(file) { this.file = file; return Promise.resolve() }
    getContentSize() { return this.size }
    getBounds() { return { x: this.options.x, y: this.options.y, width: this.size[0], height: this.size[1] } }
    isDestroyed() { return this.destroyed }
    isVisible() { return this.visible }
    isMinimized() { return this.minimized }
    show() { this.visible = true; this.calls.push('show') }
    focus() { this.calls.push('focus') }
    restore() { this.minimized = false; this.calls.push('restore') }
    minimize() { this.minimized = true; this.calls.push('minimize') }
    close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed') }
    destroy() { this.close() }
  }
  class FakeParent extends EventEmitter {
    constructor() { super(); Object.assign(this, { minimized: false, calls: [] }); this.webContents = new FakeWebContents(f.defaultSession) }
    getBounds() { return { x: 100, y: 50, width: 1200, height: 760 } }
    isDestroyed() { return false }
    isMinimized() { return this.minimized }
    restore() { this.minimized = false; this.calls.push('restore') }
    minimize() { this.minimized = true; this.calls.push('minimize') }
  }
  f.parent = new FakeParent()
  const session = { fromPartition: p => { f.partitions.push(p); f.callOrder.push('partition'); return f.ses } }
  // The screen the launcher is on: a test may give it another work area
  f.workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  const screen = { getDisplayMatching: () => ({ workArea: f.workArea }) }
  f.setup = { neededArchives: () => f.needed, downloadsDir: () => f.downloads, openMod: id => { f.opened.push(id); return { success: true } } }
  f.userData = path.join(dir, 'userData')
  f.nexus = nx.createNexusDownloads({
    electron: () => { f.electronCalls++; return { app: f.app, BrowserWindow: FakeWindow, WebContentsView: FakeView, session, screen } },
    parentWindow: () => f.parent, setup: f.setup, request,
    notifyMain: s => { f.mains.push(s); f.events.push(s.open ? 'open' : 'closed') }, onAllDownloaded: () => { f.allDownloaded++; f.events.push('install') },
    ...(removing ? { removing } : {}), ...(removeAsking ? { removeAsking } : {}), ...(nexusAccount ? { nexusAccount } : {}),
    nexusUser: { get: () => f.nexusName, set: v => { f.nexusName = v; f.nameSets.push(v) } }, userDataDir: f.userData,
    nexusLogin: { get: () => f.nexusLogin, set: v => { f.nexusLogin = v; f.loginSets.push(v) } }, sessionKept: () => f.kept,
    pagePath: 'C:\\launcher\\renderer\\nexus-window.html', preloadPath: 'C:\\launcher\\nexus-preload.js', icon: 'C:\\launcher\\icon.ico',
    dev, log: line => f.logs.push(line),
    lock: name => { f.lockCalls.push(name); return typeof f.lockAnswer === 'function' ? f.lockAnswer() : Promise.resolve(f.lockAnswer) },
    hash: (...args) => f.hash(...args), rename: (from, to) => { f.renames++; return f.rename(from, to) },
    setTimer: (fn, ms) => { const timer = { fn, ms, fired: false, cleared: false }; f.timers.push(timer); return timer },
    clearTimer: timer => { if (timer) timer.cleared = true },
    now: () => f.clock,
    ...(realSleep ? {} : { sleep: ms => { f.sleeps.push(ms); f.order.push(`sleep ${ms}`); return f.sleepImpl ? f.sleepImpl(ms) : Promise.resolve() } }),
  })
  // Fires every pending timer of exactly this length
  f.run = ms => { for (const timer of f.timers.filter(x => x.ms === ms && !x.fired && !x.cleared)) { timer.fired = true; timer.fn() } }
  f.pending = ms => f.timers.filter(x => x.ms === ms && !x.fired && !x.cleared).length
  // Opens the window as the player's button would, the strip page ready
  f.openAt = async id => {
    const answer = await f.nexus.open(id)
    f.win = f.windows.at(-1); f.view = f.views.at(-1); f.wc = f.view?.webContents
    if (answer.success && f.win && !f.win.destroyed) f.nexus.stripReady(f.win.webContents)
    return answer
  }
  f.strip = () => f.win.webContents.sent.filter(([c]) => c === 'nexus:strip').at(-1)?.[1]
  f.main = () => f.mains.at(-1)
  f.state = id => f.main().archives[id]?.state
  f.download = (options, contents = f.wc) => { const item = new FakeItem(options), e = ev(); f.ses.emit('will-download', e, item, contents); return { item, e } }
  f.files = () => fs.existsSync(f.downloads) ? fs.readdirSync(f.downloads, { recursive: true }).filter(n => fs.statSync(path.join(f.downloads, n)).isFile()) : []
  // A page committed in the view, then its document ready and read
  f.commit = (url, code = 200) => f.wc.emit('did-navigate', {}, url, code)
  f.load = async (facts, url) => { f.wc.facts = facts; f.commit(url); f.wc.emit('dom-ready'); await flush() }
  // A main-frame response's headers reaching the session (ses.webRequest.onHeadersReceived): what the launcher answered
  f.headers = (url, responseHeaders, { statusCode = 200, resourceType = 'mainFrame', webContentsId = f.wc?.id } = {}) => {
    let answer, calls = 0
    f.ses.onHeaders({ id: 1, url, method: 'GET', webContentsId, resourceType, referrer: '', timestamp: 0, statusLine: `HTTP/1.1 ${statusCode}`, statusCode, responseHeaders }, value => { answer = value; calls++ })
    assert.equal(calls, 1, 'the callback is called exactly once')
    return answer
  }
  // A main-frame load that failed (Chromium shows its own error page), as Electron reports it
  f.failed = (url, code = -105, description = 'ERR_NAME_NOT_RESOLVED') => f.wc.emit('did-fail-load', {}, code, description, url, true)
  return f
}
// A download through to its end: bytes written where the launcher said, then done
function deliver(f, item, bytes, state = 'completed') {
  fs.writeFileSync(item.savePath, bytes)
  item.received = bytes.length
  item.emit('done', {}, state)
}

test('navigation verdicts: Nexus over https only, nxm: is a mod manager, blob: and every other scheme are refused', () => {
  for (const url of ['https://www.nexusmods.com/skyrimspecialedition/mods/1', 'https://users.nexusmods.com/auth/sign_in', 'https://next.nexusmods.com/x', 'https://supporter-files.nexus-cdn.com/1/2/a.7z', 'https://nexusmods.com/']) {
    assert.equal(nx.navigationVerdict(url), 'allow', url)
  }
  for (const url of ['http://www.nexusmods.com/', 'https://www.nexusmods.com:8443/', 'https://www.nexusmods.com.evil.example/', 'https://evil.example/?u=nexusmods.com', 'javascript:alert(1)', 'file:///C:/x',
    'data:text/html,x', 'about:blank', 'not a url', 'https://fakenexusmods.com/', 'blob:https://www.nexusmods.com/5d0c3f0e-uuid', 'blob:null/uuid', undefined]) {
    assert.equal(nx.navigationVerdict(url), 'block', String(url))
  }
  assert.equal(nx.navigationVerdict('nxm://skyrimspecialedition/mods/62775/files/454617?key=x'), 'modManager')
})

test('the step page, sign-in and every kind of page are worked out from the exact file', () => {
  const a = TRUEHUD.archive
  assert.equal(nx.stepUrl(a), 'https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=454617')
  assert.equal(nx.signInUrl(a), 'https://users.nexusmods.com/auth/sign_in?redirect_url=https%3A%2F%2Fwww.nexusmods.com%2Fskyrimspecialedition%2Fmods%2F62775%3Ftab%3Dfiles%26file_id%3D454617')
  assert.equal(nx.isStepUrl(nx.stepUrl(a), a), true)
  assert.equal(nx.isStepUrl(`${nx.stepUrl(a)}&nmm=1`, a), true, 'the mod-manager variant is still the step page')
  assert.equal(nx.isStepUrl('https://www.nexusmods.com/skyrimspecialedition/mods/62775/?tab=files&file_id=454617', a), true)
  assert.equal(nx.isStepUrl('https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=1', a), false)
  assert.equal(nx.isStepUrl('https://next.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=454617', a), false)
  assert.equal(nx.isStepUrl('http://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=454617', a), false)
  assert.equal(nx.hasNmm(`${nx.stepUrl(a)}&nmm=1`), true)
  assert.equal(nx.hasNmm(nx.stepUrl(a)), false)
  const kinds = {
    'https://users.nexusmods.com/': 'signin', 'https://users.nexusmods.com?redirect_url=x': 'signin', 'https://users.nexusmods.com/auth/sign_in?x=1': 'signin',
    'https://users.nexusmods.com/auth/password/new': 'signin', 'https://users.nexusmods.com/auth/two_factor': 'signin',
    'https://users.nexusmods.com/register?redirect_url=x': 'register', 'https://users.nexusmods.com/account/billing/premium': 'premium',
    'https://users.nexusmods.com/account/settings': 'away', [SETTINGS_URL]: 'settings', 'https://next.nexusmods.com/settings/content-blocking': 'settings',
    'https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=798218': 'otherFile', 'https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files': 'otherFile',
    'https://www.nexusmods.com/skyrimspecialedition/mods/62775': 'otherFile', 'https://www.nexusmods.com/skyrimspecialedition/mods/1988': 'away', nonsense: 'away',
  }
  for (const [url, kind] of Object.entries(kinds)) assert.equal(nx.pageKind(url, a), kind, url)
  assert.equal(nx.pageKind('https://www.nexusmods.com/skyrimspecialedition/mods/62775'), 'away', 'no mod: never otherFile')
})

test('what a page shows is read as untrusted data, and the login follows it', () => {
  const facts = raw => nx.readFacts(raw)
  assert.deepEqual(nx.loginFrom(facts({ user: 'Guest', loginLink: true })), { login: 'out', user: '' })
  assert.deepEqual(nx.loginFrom(facts({ user: 'Dragonborn' })), { login: 'in', user: 'Dragonborn' })
  assert.deepEqual(nx.loginFrom(facts({ panel: { fileId: '1', loggedIn: 'true' } })), { login: 'in', user: '' })
  assert.deepEqual(nx.loginFrom(facts({ loginLink: true })), { login: 'out', user: '' })
  assert.equal(nx.loginFrom(facts({ href: 'https://users.nexusmods.com/' })), null, 'no marker: nothing known')
  const long = facts({ user: `A\u0001B\u0007\n${'n'.repeat(300)}` })
  assert.equal(long.user.length, 64)
  assert.doesNotMatch(long.user, /[\u0000-\u001f]/)
  assert.ok(long.user.startsWith('ABn'))
  const odd = facts({ href: {}, title: 5, user: 7, loginLink: 'true', panel: 'x', adultNotice: 'yes', picker: 'true' })
  assert.deepEqual(odd, { href: '', title: '', user: null, loginLink: false, panel: null, adultNotice: false, picker: false })
  assert.deepEqual(facts({ panel: { fileId: 454617, premium: true, loggedIn: 'true', nmm: 'false' } }).panel, { fileId: '', premium: false, loggedIn: true, nmm: false })
  assert.equal(facts({ picker: true }).picker, true)
  assert.deepEqual(facts(null), { href: '', title: '', user: null, loginLink: false, panel: null, adultNotice: false, picker: false })
})

test('nothing is made until the player asks', t => {
  const f = fixture(t)
  f.nexus.neededChanged(f.needed)
  f.nexus.neededChanged(null)
  f.nexus.neededChanged(f.needed)
  assert.equal(f.electronCalls, 0)
  assert.deepEqual(f.lockCalls, [], 'no lock taken')
  assert.equal(f.windows.length, 0)
  assert.equal(fs.existsSync(f.downloads), false, 'no folder made')
  assert.equal(f.nexus.isOpen(), false)
  assert.deepEqual(f.main(), { open: false, installQueued: false, installing: false, removing: false, removeAsking: false, current: null, account: { user: '', login: 'unknown', kept: false },
    direct: { running: false, problem: null }, premium: false,
    archives: { 35407: { state: 'waiting', percent: null }, 454617: { state: 'waiting', percent: null }, 469854: { state: 'waiting', percent: null } } })
})

test('open() refuses before touching Electron, a pipe or the disk; a relative folder is never used', async t => {
  const f = fixture(t, { downloads: '' })
  const cwdIncoming = path.join(process.cwd(), '.incoming'), before = fs.existsSync(cwdIncoming)
  assert.deepEqual(await f.nexus.open(null), { success: false, error: TEXT.setUpFirst })
  for (const relative of ['relative\\Downloads', 'Downloads', '\\Dovakarn\\Downloads', 'C:Dovakarn']) {
    f.downloads = relative
    assert.deepEqual(await f.nexus.open('454617'), { success: false, error: TEXT.setUpFirst }, relative)
  }
  assert.equal(fs.existsSync(cwdIncoming), before, 'nothing appeared where the tests run')
  f.downloads = path.join(f.dir, 'Dovakarn', 'Downloads')
  assert.deepEqual(await f.nexus.open('999'), { success: false, error: TEXT.notNeeded })
  assert.equal(TEXT.notNeeded, 'That mod is no longer needed. Press Check my downloads to refresh the list.')
  f.needed = null
  assert.deepEqual(await f.nexus.open(null), { success: false, error: TEXT.allDownloaded })
  assert.deepEqual(await f.nexus.open('454617'), { success: false, error: TEXT.allDownloaded })
  assert.equal(f.electronCalls, 0)
  assert.deepEqual(f.lockCalls, [])
  assert.equal(f.windows.length, 0)
  // The folder going away while the lock is asked for: still never the folder the launcher started in
  const g = fixture(t), gate = deferred()
  g.lockAnswer = () => gate.promise
  const asking = g.nexus.open('454617')
  g.downloads = ''; gate.resolve(true)
  assert.deepEqual(await asking, { success: false, error: TEXT.setUpFirst })
  assert.deepEqual([fs.existsSync(cwdIncoming), g.windows.length], [before, 0])
})

test('the window and the Nexus view are made as specified, with no File System Access in the view', async t => {
  const f = fixture(t)
  assert.deepEqual(await f.nexus.open('454617'), { success: true })
  const win = f.windows[0], view = f.views[0]
  assert.deepEqual(f.lockCalls, [nx.lockName(f.userData)])
  assert.match(f.lockCalls[0], /^\\\\\.\\pipe\\dovakarn-nexus-[0-9a-f]{16}$/)
  assert.deepEqual(f.partitions, ['persist:nexus'])
  // The Nexus session keeps Electron's default user agent
  assert.equal(f.ses.uaCalls, 0, 'the Nexus session keeps Electron\'s user agent')
  assert.equal(typeof f.ses.requestHandler, 'function')
  assert.equal(typeof f.ses.checkHandler, 'function')
  assert.equal(f.ses.listenerCount('will-download'), 1)
  assert.deepEqual(view.options.webPreferences, { session: f.ses, devTools: false, ...VIEW_PREFS })
  assert.equal(view.options.webPreferences.disableBlinkFeatures, 'FileSystemAccessLocal', 'no showSaveFilePicker: never a native Save dialog')
  assert.deepEqual([VIEW_PREFS.sandbox, VIEW_PREFS.contextIsolation, VIEW_PREFS.nodeIntegration, VIEW_PREFS.webviewTag, VIEW_PREFS.disableDialogs], [true, true, false, false, true])
  assert.equal('preload' in view.options.webPreferences, false, 'the Nexus page has no preload')
  assert.equal(view.color, '#090e14')
  assert.deepEqual(win.contentView.children, [view])
  const o = win.options
  // 1000 high, so Slow download is in view; centred on the launcher, kept inside the work area (the launcher is 760 high)
  assert.deepEqual([o.title, o.frame, o.parent, o.minWidth, o.minHeight, o.show, o.width, o.height, o.x, o.y], ['Nexus Mods for Dovakarn', false, f.parent, 900, 680, false, 1100, 1000, 150, 0])
  assert.deepEqual(o.webPreferences, { preload: 'C:\\launcher\\nexus-preload.js', contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false, spellcheck: false })
  assert.equal(win.file, 'C:\\launcher\\renderer\\nexus-window.html')
  assert.equal(o.icon, 'C:\\launcher\\icon.ico')
  assert.deepEqual(view.webContents.loaded, [stepOf(TRUEHUD)], 'the view\'s first page is the file\'s step page')
  assert.deepEqual(win.webContents.openHandler({ url: 'https://www.nexusmods.com/' }), { action: 'deny' }, 'the strip never opens windows')
  const e = ev(); win.webContents.emit('will-navigate', e); assert.equal(e.prevented, true, 'or leaves its page')
  assert.equal(win.visible, false, 'not shown before its strip is painted')
  win.emit('ready-to-show'); assert.equal(win.visible, false)
  f.nexus.stripReady(win.webContents); assert.equal(win.visible, true, 'shown once both are ready')
  const d = fixture(t, { dev: true })
  await d.nexus.open(null)
  assert.equal(d.views[0].options.webPreferences.devTools, true)
  assert.equal(d.windows[0].options.webPreferences.devTools, true)
  assert.deepEqual(d.views[0].webContents.loaded, [stepOf(SKYUI)], 'Download them all starts at the first needed')
})

test('the window is 1000 high only where the screen has room: never more than the work area less 32, never less than 680', async t => {
  for (const [workHeight, height] of [[1040, 1000], [1032, 1000], [900, 868], [700, 680]]) {
    const f = fixture(t)
    f.workArea = { x: 0, y: 0, width: 1920, height: workHeight }
    await f.nexus.open('454617')
    const o = f.windows[0].options
    assert.equal(o.height, height, `work area ${workHeight} high`)
    assert.ok(o.y >= 0 && o.y + o.height <= Math.max(workHeight, o.height), `inside the work area when it fits (${workHeight})`)
  }
})

test('another launcher using Nexus: the window does not open and says why; once taken the lock is never asked again', async t => {
  const f = fixture(t)
  f.lockAnswer = false
  // browser: the launcher page offers that mod in the player's own browser instead
  assert.deepEqual(await f.nexus.open('454617'), { success: false, error: TEXT.locked, browser: true })
  assert.equal(TEXT.locked, 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Download again.')
  assert.deepEqual([f.partitions.length, f.windows.length], [0, 0], 'no session, no window')
  f.lockAnswer = true
  assert.deepEqual(await f.nexus.open('454617'), { success: true }, 'asked again at the next press')
  f.win = f.windows[0]; f.win.close()
  assert.deepEqual(await f.nexus.open('454617'), { success: true })
  assert.equal(f.lockCalls.length, 2, 'kept for the rest of the run')
})

test('old part files go once, before this run\'s first download there; a file being checked survives a reopen', async t => {
  const f = fixture(t)
  const incoming = path.join(f.downloads, '.incoming')
  fs.mkdirSync(incoming, { recursive: true }); fs.writeFileSync(path.join(incoming, 'old.download'), 'left by a crash')
  await f.openAt('454617')
  assert.deepEqual(fs.existsSync(incoming) ? fs.readdirSync(incoming) : [], [])
  const hold = deferred(); f.hash = () => hold.promise
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, item, TRUEHUD.bytes); await flush()
  assert.equal(f.state('454617'), 'checking')
  f.win.close()
  await f.openAt('454617')
  assert.equal(fs.existsSync(item.savePath), true, 'nothing removed under a running check')
  hold.resolve(TRUEHUD.archive.md5); await flush()
  assert.equal(f.state('454617'), 'done')
  assert.ok(fs.existsSync(path.join(f.downloads, '62775-454617.7z')))
})

test('the Nexus view sits below the strip, keeps 320 of the window at least, and follows the strip\'s zoom', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const sw = f.win.webContents
  assert.deepEqual(f.view.bounds, { x: 0, y: 200, width: 1100, height: 800 })
  f.nexus.stripHeight(sw, 251.4)
  assert.deepEqual(f.view.bounds, { x: 0, y: 251, width: 1100, height: 749 })
  sw.zoom = 1.25; f.nexus.stripHeight(sw, 200)
  assert.equal(f.view.bounds.y, 250, 'CSS px times the zoom: DIPs')
  f.win.size = [900, 680]; f.win.emit('resize')                   // the smallest the window goes
  assert.deepEqual(f.view.bounds, { x: 0, y: 250, width: 900, height: 430 })
  assert.equal(f.strip().room, Math.floor(360 / 1.25), 'the strip is told its room in its own px')
  sw.zoom = 1
  f.nexus.stripHeight(sw, 5000); assert.deepEqual([f.view.bounds.y, f.view.bounds.height], [360, STRIP.nexusMin], 'never more than the room')
  f.win.size = [900, 500]; f.win.emit('resize')                   // smaller than Windows allows: the Nexus page still keeps 320
  assert.deepEqual([f.view.bounds.y, f.view.bounds.height], [180, 320])
  f.nexus.stripHeight(sw, -3); assert.equal(f.view.bounds.y, 96)
  for (const bad of [NaN, Infinity, '200', null, undefined]) { f.nexus.stripHeight(sw, bad); assert.equal(f.view.bounds.y, 96, String(bad)) }
  f.nexus.stripHeight(f.wc, 150); assert.equal(f.view.bounds.y, 96, 'only the strip page reports its height')
  f.nexus.stripHeight({}, 150); assert.equal(f.view.bounds.y, 96)
  f.win.size = [1600, 1000]; f.win.emit('maximize')
  assert.deepEqual(f.view.bounds, { x: 0, y: 96, width: 1600, height: 904 })
  assert.equal(f.strip().room, 680)
})

test('the session, the client-certificate answer and the strip\'s download refusal are set up once, across close and reopen', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.win.close()
  assert.equal(f.nexus.isOpen(), false)
  await f.openAt('454617')
  assert.equal(f.windows.length, 2)
  assert.deepEqual([f.ses.listenerCount('will-download'), f.app.listenerCount('select-client-certificate'), f.defaultSession.listenerCount('will-download'), f.ses.headerListeners], [1, 1, 1, 1])
})

test('a second open focuses the window and jumps to that mod; Download them all only brings it forward; two quick presses make one window', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.parent.minimized = true
  assert.deepEqual(await f.nexus.open('469854'), { success: true })
  assert.equal(f.windows.length, 1)
  assert.ok(f.win.calls.includes('focus'))
  assert.deepEqual(f.parent.calls, ['restore'], 'the launcher comes back with it')
  assert.equal(f.wc.loaded.at(-1), stepOf(XPMSSE))
  assert.equal(f.main().current, '469854')
  const loads = f.wc.loaded.length
  assert.deepEqual(await f.nexus.open(null), { success: true })
  assert.equal(f.wc.loaded.length, loads, 'a login page in progress is never lost')
  f.commit(stepOf(XPMSSE))
  await f.nexus.open('469854')
  assert.equal(f.wc.loaded.length, loads, 'already on that step page: no reload')
  const g = fixture(t), gate = deferred()
  g.lockAnswer = () => gate.promise
  const both = [g.nexus.open('454617'), g.nexus.open('469854')]
  gate.resolve(true)
  assert.deepEqual(await Promise.all(both), [{ success: true }, { success: true }])
  assert.equal(g.windows.length, 1, 'one window')
  assert.equal(g.views[0].webContents.loaded.at(-1), stepOf(XPMSSE), 'the second press jumps')
})

test('every permission is denied; a mod-manager link says so; a throw still answers no', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const answers = [], cb = v => answers.push(v)
  f.ses.requestHandler(f.wc, 'notifications', cb)
  f.ses.requestHandler(f.wc, 'media', cb, {})
  assert.equal(f.strip().problem, null)
  f.ses.requestHandler(f.wc, 'openExternal', cb, { externalURL: 'nxm://skyrimspecialedition/mods/62775/files/454617?key=x' })
  f.ses.requestHandler(f.wc, 'openExternal', cb, { get externalURL() { throw new Error('odd details') } })
  assert.deepEqual(answers, [false, false, false, false])
  assert.equal(f.strip().step, 'problem')
  assert.equal(f.strip().problem.kind, 'modManager')
  assert.equal(f.ses.checkHandler(f.wc, 'clipboard-read'), false)
  assert.equal(f.ses.checkHandler(f.wc, 'fileSystem'), false)
})

test('client certificates are never offered from the Nexus view', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const mine = ev(), calls = []
  f.app.emit('select-client-certificate', mine, f.wc, 'https://ads.example/', [{ subjectName: 'Work' }], (...args) => calls.push(args))
  assert.deepEqual([mine.prevented, calls], [true, [[]]], 'no certificate sent')
  const other = ev()
  f.app.emit('select-client-certificate', other, f.parent.webContents, 'https://x.example/', [{ subjectName: 'Work' }], (...args) => calls.push(args))
  assert.deepEqual([other.prevented, calls.length], [false, 1], 'another window is left to Electron')
})

test('the strip page never downloads anything (no Save dialog from the launcher\'s own session)', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const fromStrip = ev(), fromLauncher = ev()
  f.defaultSession.emit('will-download', fromStrip, new FakeItem({ url: 'https://x.example/a.exe' }), f.win.webContents)
  f.defaultSession.emit('will-download', fromLauncher, new FakeItem({ url: 'https://x.example/a.exe' }), f.parent.webContents)
  assert.deepEqual([fromStrip.prevented, fromLauncher.prevented], [true, false])
})

test('popups never open a window: a Nexus page opens in the view, anything else nowhere', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const loads = f.wc.loaded.length
  assert.deepEqual(f.wc.openHandler({ url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1988' }), { action: 'deny' })
  assert.equal(f.wc.loaded.at(-1), 'https://www.nexusmods.com/skyrimspecialedition/mods/1988')
  assert.deepEqual(f.wc.openHandler({ url: 'https://ads.example/' }), { action: 'deny' })
  assert.deepEqual(f.wc.openHandler({ url: 'javascript:alert(1)' }), { action: 'deny' })
  assert.deepEqual(f.wc.openHandler(undefined), { action: 'deny' })
  assert.deepEqual(f.wc.openHandler({ get url() { throw new Error('odd') } }), { action: 'deny' }, 'a throw still denies')
  assert.equal(f.wc.loaded.length, loads + 1)
  assert.deepEqual(f.wc.openHandler({ url: 'nxm://skyrimspecialedition/mods/62775/files/454617' }), { action: 'deny' })
  assert.equal(f.strip().problem.kind, 'modManager')
})

test('the navigation guard: the step page\'s own file link goes to any https host; ads, other schemes and unknown starters are stopped', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  // Slow download's file link to a host the launcher does not know: will-frame-navigate, then will-navigate, same URL. The
  // step page's own main frame started it, so it goes ahead (no file host is hard-coded), logged once
  const a = nav('https://files.example.net/x.7z', { initiator: PAGE }), b = nav('https://files.example.net/x.7z', { initiator: PAGE })
  f.wc.emit('will-frame-navigate', a); f.wc.emit('will-navigate', b)
  assert.deepEqual([a.prevented, b.prevented, f.strip().problem], [false, false, null])
  assert.equal(f.logs.filter(l => l.includes('files.example.net')).length, 1, 'said once')
  // ...and its redirect on to another host too, still started by the page
  const hop = nav('https://dl2.example.net/x.7z?token=1', { initiator: PAGE })
  f.wc.emit('will-redirect', hop)
  assert.equal(hop.prevented, false)
  // Only https on its own port, and only from the page itself: anything else is still stopped and told
  for (const url of ['http://files.example.net/x.7z', 'https://files.example.net:8443/x.7z', 'ftp://files.example.net/x.7z']) {
    const n = nav(url, { initiator: PAGE })
    f.wc.emit('will-navigate', n)
    assert.deepEqual([n.prevented, f.strip().problem?.kind], [true, 'elsewhere'], url)
    f.nexus.action(f.win.webContents, 'back'); f.commit(stepOf(TRUEHUD))
  }
  const strange = nav('https://files.example.net/y.7z', { initiator: { parent: null, url: 'https://ads.example/' } })
  f.wc.emit('will-navigate', strange)
  assert.equal(strange.prevented, true, 'a main frame that is not on Nexus does not count as the step page')
  const gone = nav('https://files.example.net/z.7z', { initiator: { get parent() { throw new Error('Render frame was disposed') } } })
  f.wc.emit('will-navigate', gone)
  assert.equal(gone.prevented, true, 'a starter that cannot be read is not let through')
  f.nexus.action(f.win.webContents, 'back'); f.commit(stepOf(TRUEHUD))
  // Off the step page the page's own link is not let through either
  f.commit('https://www.nexusmods.com/skyrimspecialedition/mods/1988')
  const offStep = nav('https://files.example.net/x.7z', { initiator: { parent: null, url: 'https://www.nexusmods.com/skyrimspecialedition/mods/1988' } })
  f.wc.emit('will-navigate', offStep)
  assert.equal(offStep.prevented, true)
  f.nexus.action(f.win.webContents, 'back'); f.commit(stepOf(TRUEHUD))
  const ad = nav('https://ads.example/click', { initiator: AD })
  f.wc.emit('will-frame-navigate', ad)
  assert.deepEqual([ad.prevented, f.strip().problem], [true, null], 'an ad iframe sending the page away: silent')
  assert.ok(f.logs.includes('[nexus] stopped a page outside Nexus: ads.example'))
  const unknown = nav('https://cdn.unknown.example/f.7z', { initiator: null })
  f.wc.emit('will-navigate', unknown)
  assert.deepEqual([unknown.prevented, f.strip().problem?.kind], [true, 'elsewhere'], 'no initiator on the step page: told')
  const redirect = nav('https://cdn.example/TrueHUD.7z')
  f.nexus.action(f.win.webContents, 'back'); f.commit(stepOf(TRUEHUD))
  f.wc.emit('will-redirect', redirect)
  assert.deepEqual([redirect.prevented, f.strip().problem?.kind], [true, 'elsewhere'])
  const sub = nav('https://ads.example/frame', { isMainFrame: false })
  f.wc.emit('will-frame-navigate', sub)
  assert.equal(sub.prevented, false, 'a subframe is left alone')
  // Off the step page: stopped, nothing said
  f.nexus.action(f.win.webContents, 'back'); f.commit('https://www.nexusmods.com/skyrimspecialedition/mods/1988')
  const away = nav('https://example.org/', { initiator: PAGE })
  f.wc.emit('will-navigate', away)
  assert.deepEqual([away.prevented, f.strip().problem], [true, null])
  // A mod manager link off the step page: told, and back to the step page so "the box below" is the right one
  const loads = f.wc.loaded.length
  const nxm = nav('nxm://skyrimspecialedition/mods/62775/files/454617', { initiator: PAGE })
  f.wc.emit('will-navigate', nxm)
  assert.deepEqual([nxm.prevented, f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().problem?.kind], [true, loads + 1, stepOf(TRUEHUD), 'modManager'])
  f.commit(stepOf(TRUEHUD))
  assert.equal(f.strip().problem?.kind, 'modManager', 'still said on the step page')
})

test('a file link the step page went to on an unknown host downloads, checked like any other; one that shows as a page is a failed link', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  const first = 'https://files.example.net/1704/62775/TrueHUD.7z', last = 'https://dl2.example.net/TrueHUD.7z?token=1'
  f.wc.emit('will-navigate', nav(first, { initiator: PAGE }))
  f.wc.emit('will-redirect', nav(last, { initiator: PAGE }))
  const { e, item } = f.download({ url: first, chain: [first, last], filename: 'TrueHUD-62775-1-1-9.7z', total: TRUEHUD.archive.size })
  assert.deepEqual([e.prevented, path.dirname(item.savePath)], [false, path.join(f.downloads, '.incoming')], 'taken, saved where the launcher says')
  assert.ok(f.logs.some(l => l.startsWith('[nexus] download started: TrueHUD-62775-1-1-9.7z') && l.includes('from files.example.net, then dl2.example.net')),
    'every accepted download names its hosts, so the log shows which hosts served each file')
  deliver(f, item, TRUEHUD.bytes)
  await until('done', () => f.state('454617') === 'done')
  assert.ok(fs.existsSync(path.join(f.downloads, '62775-454617.7z')), 'size and MD5 still decide')
  // A chain through a host nothing let through is still refused
  f.run(TIMES.moveOn); f.commit(stepOf(XPMSSE))
  const odd = f.download({ url: 'https://elsewhere.example/x.7z', chain: ['https://elsewhere.example/x.7z'], total: XPMSSE.archive.size })
  assert.deepEqual([odd.e.prevented, f.strip().problem?.kind], [true, 'elsewhere'])
  // A let-through address that turns out to be a page: back to the mod, said as a failed file link
  f.nexus.action(f.win.webContents, 'back'); f.commit(stepOf(XPMSSE))
  f.wc.emit('will-navigate', nav('https://files.example.net/1704/1988/XPMSSE.7z', { initiator: { parent: null, url: stepOf(XPMSSE) } }))
  const loads = f.wc.loaded.length
  f.commit('https://files.example.net/1704/1988/XPMSSE.7z')
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().problem?.kind], [loads + 1, stepOf(XPMSSE), 'linkFailed'])
  // A let-through address is only good for a minute
  f.clock += TIMES.stall + 1
  const late = f.download({ url: first, chain: [first], total: XPMSSE.archive.size })
  assert.equal(late.e.prevented, true)
})

test('what commits is checked: a page outside Nexus always goes back to the mod, Nexus\'s file server shown as a page is a failed link once per press, a 5xx is Nexus down', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  let loads = f.wc.loaded.length
  f.commit('https://cdn.example/')
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().problem?.kind], [loads + 1, stepOf(TRUEHUD), 'elsewhere'])
  // Again with no press of ours in between: a page from outside Nexus never stays on screen, however often it comes
  f.commit('https://cdn.example/again')
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().step, f.strip().problem?.kind], [loads + 2, stepOf(TRUEHUD), 'problem', 'elsewhere'])
  // Its address named an archive: a failed file link, not a site outside Nexus
  f.commit('https://files.example.net/1704/62775/TrueHUD.7z')
  assert.deepEqual([f.wc.loaded.length, f.strip().problem?.kind], [loads + 3, 'linkFailed'])
  // Whatever each one kept in the Nexus session (cookies, storage, a service worker) is cleared for its own origin
  await flush()
  const storages = ['serviceworkers', 'cachestorage', 'localstorage', 'indexdb', 'cookies']
  assert.deepEqual(f.ses.origins, [{ origin: 'https://cdn.example', storages }, { origin: 'https://cdn.example', storages }, { origin: 'https://files.example.net', storages }])
  assert.deepEqual(f.ses.cleared, [], 'never the whole session: the Nexus login stays')
  // Nexus's own file server shown as a page: back to the mod once per press of ours, so a link the player keeps pressing
  // never sends the view back and forth; the strip then calls it a file server page, never another Nexus page
  f.nexus.action(f.win.webContents, 'back')
  loads = f.wc.loaded.length
  f.commit('https://x.nexus-cdn.com/f.7z')
  assert.deepEqual([f.wc.loaded.length, f.strip().problem?.kind], [loads + 1, 'linkFailed'])
  f.commit(stepOf(TRUEHUD))
  assert.deepEqual([f.strip().problem?.kind, f.strip().site], ['linkFailed', 'nexus'], 'said on the step page')
  f.commit('https://x.nexus-cdn.com/f.7z')
  assert.deepEqual([f.wc.loaded.length, f.strip().site, f.strip().offStep], [loads + 1, 'files', true])
  await flush()
  assert.equal(f.ses.origins.length, 3, 'Nexus\'s own file server is Nexus: nothing of it cleared')
  f.nexus.action(f.win.webContents, 'retry'); f.commit(stepOf(TRUEHUD), 503)
  assert.equal(f.strip().step, 'down')
  // No mod left to go back to (every mod is in and the window is closing): a blank page, never the outside one
  const g = fixture(t)
  await g.openAt('454617')
  g.nexus.neededChanged(null)
  assert.deepEqual([g.main().current, g.strip().step], [null, 'allIn'])
  const before = g.wc.loaded.length
  g.commit('https://example.org/')
  assert.deepEqual([g.wc.loaded.length, g.wc.loaded.at(-1)], [before + 1, 'about:blank'])
  g.commit('about:blank')
  assert.equal(g.wc.loaded.length, before + 1, 'the blank page is the launcher\'s own: left as it is')
})

test('what counts as a file is an allow-list: one attachment, or only file types; anything else from outside Nexus is a page', () => {
  const kind = headers => nx.responseKind(headers)
  // Exactly one Content-Disposition that starts with attachment: a file, whatever its type says
  for (const headers of [{ 'Content-Disposition': ['attachment; filename="TrueHUD.7z"'], 'Content-Type': ['text/html'] }, { 'content-disposition': 'Attachment' },
    { 'Content-Disposition': ['attachment'] }, { 'CONTENT-DISPOSITION': ['  attachment;filename=x.7z'] }]) assert.equal(kind(headers), 'file', JSON.stringify(headers))
  // Every type it names is a file type (each header, split at commas, without parameters, in any case): a file
  assert.deepEqual([...nx.FILE_TYPES].sort(), ['application/force-download', 'application/octet-stream', 'application/vnd.rar', 'application/x-7z-compressed',
    'application/x-compressed', 'application/x-download', 'application/x-rar', 'application/x-rar-compressed', 'application/x-zip', 'application/x-zip-compressed',
    'application/zip', 'binary/octet-stream'])
  for (const type of nx.FILE_TYPES) assert.equal(kind({ 'Content-Type': [type] }), 'file', type)
  for (const headers of [{ 'content-type': 'Application/Octet-Stream; charset=binary' }, { 'Content-Type': ['application/octet-stream', 'application/octet-stream'] },
    { 'Content-Type': ['application/zip, application/x-7z-compressed'] }, { 'Content-Type': ['application/x-7z-compressed'], 'Content-Disposition': ['inline'] }]) {
    assert.equal(kind(headers), 'file', JSON.stringify(headers))
  }
  // Anything else is a page: a type a browser shows, one it guesses at, none at all, or a file type beside another type
  for (const headers of [
    { 'Content-Type': ['text/html; charset=utf-8'] }, { 'content-type': 'application/xhtml+xml' }, { 'Content-Type': ['image/svg+xml'] }, { 'Content-Type': ['text/plain'] },
    { 'Content-Type': ['application/xml'] }, { 'Content-Type': ['application/json'] }, { 'Content-Type': ['application/pdf'] }, { 'Content-Type': ['image/png'] }, { 'Content-Type': ['video/mp4'] },
    { 'Content-Type': ['unknown/unknown'] }, { 'Content-Type': ['application/unknown'] }, { 'Content-Type': ['*/*'] }, { 'Content-Type': ['html'] }, { 'Content-Type': ['application/x-msdownload'] },
    { 'Content-Type': ['application/octet-stream', 'text/html'] }, { 'Content-Type': ['application/octet-stream, text/html'] }, { 'Content-Type': ['text/html', 'application/zip'] },
    { 'Content-Type': ['application/octet-stream,'] }, { 'Content-Type': [''] }, { 'Content-Type': [] }, {}, undefined, null, 'text/html',
    { 'Content-Type': ['text/html'], 'Content-Disposition': ['inline; filename="TrueHUD.7z"'] },
    { 'Content-Type': ['text/html'], 'Content-Disposition': ['inline', 'attachment; filename=x.7z'] },
    { 'Content-Type': ['text/html'], 'Content-Disposition': ['attachment; filename=a.7z', 'attachment; filename=b.7z'] },
    { 'Content-Type': ['text/html'], 'Content-Disposition': ['attachments'] }, { 'Content-Type': ['text/html'], 'Content-Disposition': ['form-data; name=attachment'] },
  ]) assert.equal(kind(headers), 'page', JSON.stringify(headers))
  // Only 301, 302, 303, 307 and 308 that name where they go are redirects; 300, 305 and 306 render their own body
  const outside = (statusCode, responseHeaders) => nx.stopsAsPage({ resourceType: 'mainFrame', url: 'https://elsewhere.example/go', statusCode, responseHeaders })
  for (const status of [301, 302, 303, 307, 308]) {
    assert.equal(outside(status, { 'Content-Type': ['text/html'], Location: ['https://files.example.net/x.7z'] }), false, `${status} with a Location`)
    assert.equal(outside(status, { 'Content-Type': ['text/html'] }), true, `${status} without one`)
    assert.equal(outside(status, { 'Content-Type': ['text/html'], location: ['  '] }), true, `${status} with an empty one`)
  }
  for (const status of [300, 304, 305, 306, 200, 204, 205, 404, 500]) assert.equal(outside(status, { 'Content-Type': ['text/html'], Location: ['https://files.example.net/x.7z'] }), true, `${status}`)
  assert.equal(outside(200, { 'Content-Type': ['application/x-7z-compressed'] }), false, 'a file goes on')
  // Nexus's own pages and files, and frames inside a page, are never this check's
  assert.equal(nx.stopsAsPage({ resourceType: 'mainFrame', url: 'https://www.nexusmods.com/', statusCode: 200, responseHeaders: { 'Content-Type': ['text/html'] } }), false)
  assert.equal(nx.stopsAsPage({ resourceType: 'mainFrame', url: 'https://cf-files.nexus-cdn.com/a.7z', statusCode: 200, responseHeaders: {} }), false)
  assert.equal(nx.stopsAsPage({ resourceType: 'subFrame', url: 'https://ads.example/', statusCode: 200, responseHeaders: { 'Content-Type': ['text/html'] } }), false)
  assert.equal(nx.stopsAsPage({ resourceType: 'mainFrame', url: 'https://nexusmods.com.evil.example/', statusCode: 200, responseHeaders: { 'Content-Type': ['text/html'] } }), true)
  // The answer a stopped page gets: 204 No Content, its type kept (Electron's HeadersReceivedResponse), a fresh one each time
  assert.deepEqual(nx.stoppedAnswer(), { statusLine: 'HTTP/1.1 204 No Content', responseHeaders: { 'Content-Type': ['text/html'] } })
  assert.notEqual(nx.stoppedAnswer(), nx.stoppedAnswer())
  assert.deepEqual([...nx.REDIRECTS].sort(), [301, 302, 303, 307, 308])
})

test('a page from outside Nexus is stopped before it shows (onHeadersReceived, answered as 204 so nothing reloads); only a file goes on, to will-download, where size and MD5 decide', async t => {
  const f = fixture(t)
  const STOPPED = nx.stoppedAnswer()
  await f.openAt('454617')
  // Registered once, for main frames, on the Nexus session, before the view exists (Electron 41:
  // ses.webRequest.onHeadersReceived(filter, listener), the listener answering callback(HeadersReceivedResponse))
  assert.deepEqual([f.ses.headerListeners, f.ses.headersFilter], [1, { urls: ['<all_urls>'], types: ['mainFrame'] }])
  assert.ok(f.callOrder.indexOf('headers') < f.callOrder.indexOf('view'))
  f.commit(stepOf(TRUEHUD))
  // A link outside Nexus on the step page (a file description's link, the requirements popup, a script on the page): the
  // navigation guard lets it go in case it is the file...
  const link = 'https://skse.silverlock.org/'
  const n = nav(link, { initiator: PAGE })
  f.wc.emit('will-navigate', n)
  assert.equal(n.prevented, false)
  // ...but its answer is a page, so it is answered as 204 No Content before it shows, whatever kind of page, and the step
  // page stays where it is: nothing loads, nothing reloads
  const loads = f.wc.loaded.length
  const pages = [
    [{ 'Content-Type': ['text/html; charset=utf-8'] }, 'html'], [{ 'content-type': 'application/xhtml+xml' }, 'xhtml'], [{ 'Content-Type': ['image/svg+xml'] }, 'svg'],
    [{ 'Content-Type': ['text/plain'] }, 'text'], [{ 'Content-Type': ['application/xml'] }, 'xml'], [{ 'Content-Type': ['text/xml'] }, 'text xml'],
    [{ 'Content-Type': ['application/rss+xml'] }, 'any xml'], [{}, 'no type'], [undefined, 'no headers'], [{ 'Content-Type': [''] }, 'an empty type'],
    [{ 'Content-Type': ['application/json'] }, 'json'], [{ 'Content-Type': ['application/javascript'] }, 'script'], [{ 'Content-Type': ['image/png'] }, 'picture'],
    [{ 'Content-Type': ['video/mp4'] }, 'video'], [{ 'Content-Type': ['application/pdf'] }, 'pdf'],
    [{ 'Content-Type': ['unknown/unknown'] }, 'unknown/unknown'], [{ 'Content-Type': ['application/unknown'] }, 'application/unknown'], [{ 'Content-Type': ['*/*'] }, '*/*'],
    [{ 'Content-Type': ['html'] }, 'no slash'], [{ 'Content-Type': ['application/octet-stream', 'text/html'] }, 'a file type beside a page type, as two headers'],
    [{ 'Content-Type': ['application/octet-stream, text/html'] }, 'the same in one header'],
    [{ 'Content-Type': ['text/html'], 'Content-Disposition': ['inline; filename="TrueHUD.7z"'] }, 'inline is not an attachment'],
    [{ 'Content-Type': ['text/html'], 'Content-Disposition': ['inline', 'attachment; filename=x.7z'] }, 'two dispositions are not one attachment'],
  ]
  for (const [headers, label] of pages) assert.deepEqual(f.headers(link, headers), STOPPED, label)
  for (const status of [300, 305, 306]) assert.deepEqual(f.headers(link, { 'Content-Type': ['text/html'], Location: ['https://files.example.net/x.7z'] }, { statusCode: status }), STOPPED, `${status} renders its body`)
  assert.equal(f.wc.loaded.length, loads, 'the step page stays: nothing loads or reloads')
  assert.deepEqual([f.strip().step, f.strip().problem?.kind, f.strip().site], ['problem', 'elsewhere', 'nexus'])
  // Logged once, however often the step page is sent there (a script on it): never a log line per try
  assert.deepEqual(f.logs.filter(l => l.startsWith('[nexus] stopped skse.silverlock.org before it showed')), ['[nexus] stopped skse.silverlock.org before it showed: a page (text/html, 200), not a file'])
  f.clock += TIMES.stall + 1
  f.headers(link, { 'Content-Type': ['text/html'] })
  assert.equal(f.logs.filter(l => l.startsWith('[nexus] stopped skse.silverlock.org before it showed')).length, 2, 'again after a minute')
  // A link outside Nexus that did not load at all (its host out of reach, or an answer Chromium itself refuses, such as two
  // different attachment headers): Chromium's error page goes, the mod comes back, and it is never "Nexus could not be
  // reached"
  f.failed('https://files.example.net/1704/62775/TrueHUD.7z', -349, 'ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION')
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().step, f.strip().problem?.kind], [loads + 1, stepOf(TRUEHUD), 'problem', 'elsewhere'], 'the problem already said stays')
  f.commit(stepOf(TRUEHUD))
  f.nexus.action(f.win.webContents, 'retry'); f.commit(stepOf(TRUEHUD))
  f.failed('https://files.example.net/1704/62775/TrueHUD.7z')
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().step, f.strip().problem?.kind], [loads + 3, stepOf(TRUEHUD), 'problem', 'linkFailed'], 'an address naming an archive: a failed file link')
  f.commit(stepOf(TRUEHUD))
  assert.equal(f.strip().problem?.kind, 'linkFailed', 'said on the step page, under it the box to use')
  f.nexus.action(f.win.webContents, 'retry')
  f.failed(stepOf(TRUEHUD), -106, 'ERR_INTERNET_DISCONNECTED')
  assert.equal(f.strip().step, 'offline', 'a Nexus page that really failed to load is still Nexus out of reach')
  // Nexus's own pages and files, a redirect that names where it goes (its next stop is checked again) and frames inside a
  // page (ads) all go on untouched
  for (const [url, headers, options] of [
    [stepOf(XPMSSE), { 'Content-Type': ['text/html'] }, {}], ['https://users.nexusmods.com/auth/sign_in', { 'Content-Type': ['text/html'] }, {}],
    ['https://supporter-files.nexus-cdn.com/1/2/a.7z', { 'Content-Type': ['application/xml'] }, {}],
    ...[301, 302, 303, 307, 308].map(statusCode => ['https://elsewhere.example/go', { 'Content-Type': ['text/html'], Location: ['https://files.example.net/x.7z'] }, { statusCode }]),
    ['https://ads.example/frame', { 'Content-Type': ['text/html'] }, { resourceType: 'subFrame' }],
  ]) assert.deepEqual(f.headers(url, headers, options), {}, `${url} ${options.statusCode || ''}`)
  assert.deepEqual(f.headers('https://elsewhere.example/go', { 'Content-Type': ['text/html'] }, { statusCode: 302 }), STOPPED, 'a redirect that names nowhere to go is a page')
  assert.deepEqual(f.headers('https://elsewhere.example/stay', { 'Content-Type': ['text/html'] }, { statusCode: 204 }), STOPPED, 'a 204 from outside is answered as ours: the page stays either way')
  // Details that cannot be read are never shown
  let odd
  f.ses.onHeaders({ resourceType: 'mainFrame', get url() { throw new Error('Render frame was disposed') } }, value => { odd = value })
  assert.deepEqual(odd, STOPPED)
  // A file from outside Nexus: one attachment (whatever its type says) or only file types goes on and becomes a download
  // from the view; its size and MD5 still decide
  f.nexus.action(f.win.webContents, 'retry'); f.commit(stepOf(TRUEHUD))
  const file = 'https://files.example.net/1704/62775/TrueHUD.7z'
  f.wc.emit('will-navigate', nav(file, { initiator: PAGE }))
  for (const headers of [{ 'Content-Disposition': ['attachment; filename="TrueHUD.7z"'], 'Content-Type': ['text/html'] }, { 'content-disposition': 'Attachment' },
    { 'Content-Type': ['application/octet-stream'] }, { 'content-type': 'application/x-7z-compressed' }, { 'Content-Type': ['application/zip'] }, { 'Content-Type': ['application/x-rar-compressed'] },
    { 'Content-Type': ['binary/octet-stream'] }, { 'Content-Type': ['application/vnd.rar'] }, { 'Content-Type': ['application/force-download'] }]) {
    assert.deepEqual(f.headers(file, headers), {}, JSON.stringify(headers))
  }
  const { e, item } = f.download({ url: file, chain: [file], filename: 'TrueHUD-62775-1-1-9.7z', total: TRUEHUD.archive.size })
  assert.equal(e.prevented, false)
  deliver(f, item, TRUEHUD.bytes)
  await until('done', () => f.state('454617') === 'done')
  assert.ok(fs.existsSync(path.join(f.downloads, '62775-454617.7z')))
  // An address that names an archive answering with a page (a 404, say): a failed file link
  f.run(TIMES.moveOn); f.commit(stepOf(XPMSSE))
  const gone = 'https://files.example.net/1704/1988/XPMSSE.7z'
  f.wc.emit('will-navigate', nav(gone, { initiator: { parent: null, url: stepOf(XPMSSE) } }))
  assert.deepEqual(f.headers(gone, { 'Content-Type': ['text/html'] }, { statusCode: 404 }), STOPPED)
  assert.equal(f.strip().problem?.kind, 'linkFailed')
  // With the file of the right size but other bytes, the end is still refused
  const g = fixture(t)
  await g.openAt('454617')
  g.commit(stepOf(TRUEHUD))
  g.wc.emit('will-navigate', nav(file, { initiator: PAGE }))
  assert.deepEqual(g.headers(file, { 'Content-Type': ['application/octet-stream'] }), {})
  const other = g.download({ url: file, chain: [file], total: TRUEHUD.archive.size })
  deliver(g, other.item, Buffer.alloc(TRUEHUD.archive.size, 'x'))
  await until('failed', () => g.state('454617') === 'failed')
  assert.deepEqual([g.strip().problem?.kind, g.files()], ['damaged', []])
})

test('a script that keeps sending the step page outside never reloads it in a loop: stops reload nothing, and pages that show anyway count toward stuck', async t => {
  // Stopped every time (answered as 204): the step page is never reloaded, however often
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  const loads = f.wc.loaded.length
  for (let i = 0; i < 50; i++) {
    f.wc.emit('will-navigate', nav(`https://ads.example/landing?${i}`, { initiator: PAGE }))
    f.headers(`https://ads.example/landing?${i}`, { 'Content-Type': ['text/html'] })
  }
  assert.deepEqual([f.wc.loaded.length, f.strip().step, f.strip().problem?.kind], [loads, 'problem', 'elsewhere'])
  // Pages that show anyway (a service worker answers them, so no onHeadersReceived sees them): what each kept in the Nexus
  // session is cleared for its origin and the mod comes back, but those moves are not the player's, so the step page
  // loading again and again within a minute ends as stuck, and the view then shows a blank page, never the outside one
  const g = fixture(t)
  await g.openAt('454617')
  g.commit(stepOf(TRUEHUD))
  for (let i = 0; i < 5; i++) {
    const before = g.wc.loaded.length
    g.commit(`https://ads.example/landing?${i}`)
    assert.deepEqual([g.wc.loaded.length, g.wc.loaded.at(-1), g.strip().problem?.kind], [before + 1, stepOf(TRUEHUD), 'elsewhere'], `round ${i}`)
    g.clock += 1000
    g.commit(stepOf(TRUEHUD))
  }
  assert.equal(g.strip().step, 'stuck', 'six step pages within a minute: stuck')
  await flush()
  assert.deepEqual(g.ses.origins, Array.from({ length: 5 }, () => ({ origin: 'https://ads.example', storages: ['serviceworkers', 'cachestorage', 'localstorage', 'indexdb', 'cookies'] })))
  assert.ok(g.logs.includes('[nexus] cleared what ads.example kept in the Nexus window'))
  const stuckLoads = g.wc.loaded.length
  g.commit('https://ads.example/landing?again')
  assert.deepEqual([g.wc.loaded.length, g.wc.loaded.at(-1), g.strip().step, g.strip().problem], [stuckLoads + 1, 'about:blank', 'stuck', null], 'a blank page, not the outside one, and no reload')
  g.commit('about:blank')
  assert.deepEqual([g.wc.loaded.length, g.strip().step], [stuckLoads + 1, 'stuck'], 'the blank page is the launcher\'s own: left as it is')
  // A link that fails to load while stuck: the same blank page, no reload
  g.failed('https://ads.example/landing?failed')
  assert.deepEqual([g.wc.loaded.length, g.wc.loaded.at(-1), g.strip().step], [stuckLoads + 2, 'about:blank', 'stuck'])
  // Only the player's Try again loads the mod again
  await g.nexus.action(g.win.webContents, 'retry')
  assert.deepEqual([g.wc.loaded.at(-1), g.strip().step], [stepOf(TRUEHUD), 'opening'])
  // A clear that fails is only logged
  g.ses.clearStorageData = () => Promise.reject(new Error('the session is gone'))
  g.commit('https://ads.example/x')
  await flush()
  assert.ok(g.logs.includes('[nexus] could not clear what ads.example kept: the session is gone'))
  // A link failing again and again while the step page reloads counts toward stuck too
  const k = fixture(t)
  await k.openAt('454617')
  for (let i = 0; i < 6; i++) { k.commit(stepOf(TRUEHUD)); k.clock += 1000; k.failed(`https://files.example.net/${i}.7z`) }
  assert.equal(k.strip().step, 'stuck')
})

test('a session that cannot check its pages never opens the Nexus window', async t => {
  const f = fixture(t)
  delete f.ses.webRequest
  assert.deepEqual(await f.nexus.open('454617'), { success: false, error: TEXT.couldNotOpen, browser: true })
  assert.deepEqual([f.windows.length, f.views.length], [0, 0])
  assert.ok(f.logs.includes('[nexus] open: the Nexus session cannot check what its pages are'))
})

test('a link outside Nexus clicked twice with no press of ours in between: back to the mod both times, said as leading outside', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  const link = 'https://skse.silverlock.org/'
  const a = nav(link, { initiator: PAGE }), b = nav(link, { initiator: PAGE })
  f.wc.emit('will-frame-navigate', a); f.wc.emit('will-navigate', b)
  assert.deepEqual([a.prevented, b.prevented], [false, false], 'let go in case it is the file')
  // It got past the page check somehow (the second net): back to the mod, and not called a file link
  let loads = f.wc.loaded.length
  f.commit(link)
  assert.deepEqual([f.wc.loaded.length - loads, f.wc.loaded.at(-1), f.strip().problem?.kind], [1, stepOf(TRUEHUD), 'elsewhere'])
  f.commit(stepOf(TRUEHUD))
  const c = nav(`${link}faq`, { initiator: PAGE })
  f.wc.emit('will-navigate', c)
  loads = f.wc.loaded.length
  f.commit(`${link}faq`)
  assert.deepEqual([c.prevented, f.wc.loaded.length - loads, f.wc.loaded.at(-1), f.strip().step, f.strip().problem?.kind], [false, 1, stepOf(TRUEHUD), 'problem', 'elsewhere'], 'the second time too')
})

test('the strip is told where the page on screen is from, so a page outside Nexus is never called a Nexus page', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  assert.equal(f.strip().site, 'nexus')
  f.wc.emit('will-navigate', nav('https://example.org/a', { initiator: PAGE })); f.commit('https://example.org/a')
  assert.deepEqual([f.strip().site, f.strip().problem?.kind, f.wc.loaded.at(-1)], ['outside', 'elsewhere', stepOf(TRUEHUD)])
  // The player goes to another Nexus page and back by themselves; a second outside page is still never left on screen
  f.commit('https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=description')
  f.commit(`${stepOf(TRUEHUD)}&x=1`)
  f.wc.emit('will-navigate', nav('https://example.org/b', { initiator: PAGE })); f.commit('https://example.org/b')
  assert.deepEqual([f.strip().step, f.strip().problem?.kind, f.strip().site, f.wc.loaded.at(-1)], ['problem', 'elsewhere', 'outside', stepOf(TRUEHUD)])
  // Another Nexus page is one
  f.commit('https://www.nexusmods.com/skyrimspecialedition/mods/1988')
  assert.deepEqual([f.strip().step, f.strip().site], ['away', 'nexus'])
  assert.deepEqual(['https://users.nexusmods.com/', 'https://x.nexus-cdn.com/a.7z', 'https://nexusmods.com.evil.example/', 'nonsense'].map(nx.siteOf), ['nexus', 'files', 'outside', 'outside'])
})

test('downloads from anywhere but the Nexus view, or through another site, or a blob:, are refused', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const fromStrip = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size }, f.win.webContents)
  assert.equal(fromStrip.e.prevented, true)
  const stranger = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size }, new FakeWebContents())
  assert.equal(stranger.e.prevented, true)
  assert.equal(f.strip().problem, null)
  const through = f.download({ url: 'https://www.nexusmods.com/x', chain: ['https://www.nexusmods.com/x', 'https://cdn.example/TrueHUD.7z'], total: TRUEHUD.archive.size })
  assert.deepEqual([through.e.prevented, through.item.savePath, f.strip().problem.kind], [true, undefined, 'elsewhere'])
  assert.ok(f.logs.includes('[nexus] refused a download from cdn.example'))
  const blob = f.download({ url: 'blob:https://www.nexusmods.com/5d0c3f0e', total: TRUEHUD.archive.size })
  assert.deepEqual([blob.e.prevented, blob.item.savePath], [true, undefined])
  assert.equal(f.state('454617'), 'waiting')
})

test('a download of the wrong size is stopped at once; off the step page the view goes back to it; one matching only a file being checked waits', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  const { e, item } = f.download({ ...cdn(TRUEHUD), filename: 'Something Else-1-0.7z', total: 999 })
  assert.equal(e.prevented, true)
  assert.equal(item.savePath, undefined)
  assert.equal(f.state('454617'), 'wrong')
  assert.equal(f.strip().step, 'problem')
  assert.deepEqual(f.strip().problem, { kind: 'different', mod: { name: 'TrueHUD', version: '1.1.9', size: TRUEHUD.archive.size }, other: false })
  assert.deepEqual(f.files(), [])
  assert.ok(f.logs.some(l => l.includes('Something Else-1-0.7z (999 bytes)') && l.includes(String(TRUEHUD.archive.size))), 'the file Nexus sent and the needed sizes, in the log only')
  // On a newer file's own step page (the Manual button at the top sends the player there)
  f.commit('https://www.nexusmods.com/skyrimspecialedition/mods/62775?tab=files&file_id=798218')
  assert.equal(f.strip().step, 'otherFile')
  const loads = f.wc.loaded.length
  f.download({ ...cdn(TRUEHUD), total: 1234 })
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1), f.strip().problem?.kind], [loads + 1, stepOf(TRUEHUD), 'different'])
  f.commit(stepOf(TRUEHUD))
  assert.equal(f.strip().problem?.kind, 'different', '"the box below" is the right one now')
  // The same download pressed again while its first copy is being checked
  const hold = deferred(); f.hash = () => hold.promise
  const first = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, first.item, TRUEHUD.bytes); await flush()
  assert.equal(f.state('454617'), 'checking')
  const again = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  assert.equal(again.e.prevented, true)
  assert.notEqual(f.strip().problem?.kind, 'different')
  hold.resolve(TRUEHUD.archive.md5); await flush()
  assert.equal(f.state('454617'), 'done')
})

test('a download comes in, is checked, kept under its Nexus ids, and the window moves to the next mod', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { e, item } = f.download({ ...cdn(TRUEHUD), filename: 'TrueHUD-62775-1-1-9-1703382929.7z', total: TRUEHUD.archive.size })
  assert.equal(e.prevented, false)
  assert.equal(path.dirname(item.savePath), path.join(f.downloads, '.incoming'))
  assert.match(path.basename(item.savePath), /^\d+-\d+\.download$/)
  assert.equal(f.state('454617'), 'downloading')
  assert.equal(f.strip().step, 'downloading')
  assert.deepEqual(f.strip().progress, { percent: 0, received: 0, mod: { name: 'TrueHUD', version: '1.1.9', size: TRUEHUD.archive.size } })
  item.received = Math.ceil(TRUEHUD.archive.size * 0.63); item.emit('updated', {}, 'progressing')
  assert.equal(f.main().archives['454617'].percent, 63)
  assert.equal(f.strip().progress.percent, 63)
  // Byte progress is throttled: a second update inside 200 ms waits for the timer
  const pushes = f.mains.length
  item.received = Math.floor(TRUEHUD.archive.size * 0.8); item.emit('updated', {}, 'progressing')
  assert.equal(f.mains.length, pushes)
  f.run(TIMES.push)
  assert.equal(f.main().archives['454617'].percent, 80)
  deliver(f, item, TRUEHUD.bytes)
  assert.equal(f.state('454617'), 'checking')
  assert.equal(f.strip().step, 'checking')
  await until('done', () => f.state('454617') === 'done')
  const kept = path.join(f.downloads, '62775-454617.7z')
  assert.equal(fs.readFileSync(kept, 'utf8'), TRUEHUD.bytes.toString())
  assert.deepEqual(fs.readdirSync(path.join(f.downloads, '.incoming')), [])
  assert.equal(f.strip().step, 'moving')
  assert.equal(f.strip().justIn.name, 'TrueHUD')
  f.run(TIMES.moveOn)
  assert.equal(f.wc.loaded.at(-1), stepOf(XPMSSE))
  assert.equal(f.main().current, '469854')
  assert.equal(f.strip().justIn, null)
  assert.equal(f.state('454617'), 'done')
  assert.equal(f.strip().count.left, 2)
})

test('a finished download counts for whichever needed mod it is', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(XPMSSE), filename: 'XPMSSE 5.06.zip', total: 0 })
  assert.equal(f.state('454617'), 'downloading', 'size unknown: shown against the current mod')
  assert.equal(f.strip().progress.percent, null)
  deliver(f, item, XPMSSE.bytes)
  await until('XPMSSE done', () => f.state('469854') === 'done')
  assert.equal(f.state('454617'), 'waiting')
  assert.equal(f.main().current, '454617', 'still on TrueHUD')
  assert.ok(fs.existsSync(path.join(f.downloads, '1988-469854.zip')))
  assert.equal(f.strip().justIn.name, XPMSSE.archive.name)
  assert.equal(f.strip().step, 'opening')
  f.run(TIMES.justIn)
  assert.equal(f.strip().justIn, null)
  assert.equal(f.wc.loaded.length, 1, 'the page stays where the player is')
})

test('a file of no needed size is found out after the fact and deleted', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: 0 })
  deliver(f, item, Buffer.from('nothing Dovakarn needs'))
  await until('wrong', () => f.state('454617') === 'wrong')
  assert.equal(f.strip().problem.kind, 'different')
  assert.equal(fs.existsSync(item.savePath), false)
  assert.deepEqual(f.files(), [])
})

test('the right size with other bytes is damaged: deleted, and asked for again', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, item, Buffer.alloc(TRUEHUD.archive.size, 'x'))
  await until('failed', () => f.state('454617') === 'failed')
  assert.deepEqual(f.strip().problem, { kind: 'damaged', mod: { name: 'TrueHUD', version: '1.1.9', size: TRUEHUD.archive.size }, other: false })
  assert.deepEqual(f.files(), [])
})

test('a failing check never stays at checking', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.hash = () => Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }))
  const a = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, a.item, TRUEHUD.bytes); await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem?.kind, fs.existsSync(a.item.savePath)], ['failed', 'save', false])
  f.hash = modInstall.hashFile
  const b = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  b.item.received = TRUEHUD.archive.size
  b.item.emit('done', {}, 'completed')                       // nothing was ever written: the part file is not there
  await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem?.kind, f.strip().step], ['failed', 'save', 'problem'])
})

test('the move into Downloads: a held file is tried again, a copy already there is kept, a lasting refusal says so', async t => {
  const busy = code => Object.assign(new Error(`${code}: operation not permitted`), { code })
  {
    const f = fixture(t)
    await f.openAt('454617')
    let refusals = 2
    f.rename = (from, to) => { if (refusals-- > 0) throw busy('EPERM'); fs.renameSync(from, to) }
    const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
    deliver(f, item, TRUEHUD.bytes)
    await until('done after two refusals', () => f.state('454617') === 'done')
    assert.equal(f.renames, 3)
    assert.ok(fs.existsSync(path.join(f.downloads, '62775-454617.7z')))
  }
  {
    const f = fixture(t)
    await f.openAt('454617')
    f.rename = () => { throw busy('EBUSY') }
    const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
    deliver(f, item, TRUEHUD.bytes)
    await until('failed', () => f.state('454617') === 'failed')
    assert.deepEqual([f.renames, LIMITS.renameTries, f.strip().problem?.kind, fs.existsSync(item.savePath)], [20, 20, 'move', false])
  }
  {
    const f = fixture(t)
    await f.openAt('454617')
    fs.mkdirSync(f.downloads, { recursive: true }); fs.writeFileSync(path.join(f.downloads, '62775-454617.7z'), TRUEHUD.bytes)
    const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
    deliver(f, item, TRUEHUD.bytes)
    await until('done', () => f.state('454617') === 'done')
    assert.deepEqual([f.renames, fs.existsSync(item.savePath)], [0, false], 'the copy already there stays as it is')
  }
  {
    const f = fixture(t)
    await f.openAt('454617')
    f.rename = () => { throw busy('ENOSPC') }
    const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
    deliver(f, item, TRUEHUD.bytes)
    await until('failed', () => f.state('454617') === 'failed')
    assert.equal(f.renames, 1, 'any other error: no retry')
  }
})

test('an interruption ends: resumed once, then stopped; one that cannot resume stops at once', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  item.resumable = true
  item.emit('updated', {}, 'interrupted')
  assert.deepEqual([item.resumed, item.cancelled], [1, 0])
  item.emit('updated', {}, 'interrupted')
  item.emit('updated', {}, 'interrupted')
  assert.deepEqual([item.resumed, item.cancelled], [1, 1], 'the second drop ends it, once')
  await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem?.kind], ['failed', 'interrupted'])
  const again = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  assert.equal(again.e.prevented, false, 'the next press is taken')
  assert.equal(f.state('454617'), 'downloading')
  again.item.emit('updated', {}, 'interrupted')
  assert.deepEqual([again.item.resumed, again.item.cancelled], [0, 1], 'cannot resume: ended at once')
  await flush()
  assert.equal(f.state('454617'), 'failed')
  const third = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  fs.writeFileSync(third.item.savePath, 'half')
  third.item.emit('done', {}, 'interrupted')
  await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem?.kind, fs.existsSync(third.item.savePath)], ['failed', 'interrupted', false])
})

test('a download that gets no bytes for a minute is stopped; bytes keep it going', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  assert.equal(f.pending(TIMES.stall), 1)
  item.received = 10; item.emit('updated', {}, 'progressing')
  assert.equal(f.pending(TIMES.stall), 1, 'bytes start the minute again')
  assert.equal(item.cancelled, 0)
  f.run(TIMES.stall)
  assert.equal(item.cancelled, 1)
  await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem?.kind], ['failed', 'interrupted'])
})

test('a download of unknown size that passes every needed size is stopped as a different file', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: 0 })
  item.received = Math.max(...ALL.map(m => m.archive.size)) + 1; item.emit('updated', {}, 'progressing')
  assert.equal(item.cancelled, 1)
  await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem?.kind], ['wrong', 'different'])
})

test('one download at a time', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const first = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  const second = f.download({ ...cdn(XPMSSE), total: XPMSSE.archive.size })
  assert.equal(second.e.prevented, true)
  assert.equal(f.strip().step, 'downloading')
  assert.equal(f.strip().problem.kind, 'oneAtATime')
  assert.equal(f.state('469854'), 'waiting')
  deliver(f, first.item, TRUEHUD.bytes)
  await until('first done', () => f.state('454617') === 'done')
})

test('closing the window stops the download in flight and keeps finished files', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const done = f.download({ ...cdn(XPMSSE), total: XPMSSE.archive.size })
  deliver(f, done.item, XPMSSE.bytes)
  await until('XPMSSE done', () => f.state('469854') === 'done')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  fs.writeFileSync(item.savePath, 'part')
  await f.nexus.action(f.win.webContents, 'close')
  assert.equal(item.cancelled, 1)
  await flush()
  assert.equal(f.state('454617'), 'waiting')
  assert.equal(fs.existsSync(item.savePath), false)
  assert.ok(fs.existsSync(path.join(f.downloads, '1988-469854.7z')))
  assert.equal(f.wc.closed, 1)
  assert.equal(f.main().open, false)
  assert.equal(f.allDownloaded, 0)
  assert.equal(f.parent.listenerCount('closed'), 0, 'its listener on the launcher window is gone')
  assert.ok(f.timers.filter(x => !x.fired).every(x => x.cleared), 'no timer left running')
})

test('closing the launcher window closes the Nexus window', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.parent.emit('closed')
  assert.equal(f.win.destroyed, true)
  assert.equal(f.nexus.isOpen(), false)
})

test('closing the window while the last file is checked: it finishes safely, nothing touches the window, the install is asked for once', async t => {
  const f = fixture(t, { archives: [SKYUI, TRUEHUD] })
  await f.openAt('454617')
  const a = f.download({ ...cdn(SKYUI), total: SKYUI.archive.size })
  deliver(f, a.item, SKYUI.bytes)
  await until('SkyUI done', () => f.state('35407') === 'done')
  const hold = deferred(); f.hash = () => hold.promise
  const b = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, b.item, TRUEHUD.bytes); await flush()
  assert.equal(f.state('454617'), 'checking')
  f.win.close()
  const loads = f.wc.loaded.length, timers = f.timers.length
  hold.resolve(TRUEHUD.archive.md5); await flush()
  assert.equal(f.state('454617'), 'done')
  assert.ok(fs.existsSync(path.join(f.downloads, '62775-454617.7z')), 'moved whole, never half')
  assert.equal(f.wc.loaded.length, loads, 'no page loaded in a closed window')
  assert.equal(f.timers.length, timers, 'no timer started for it')
  assert.equal(f.allDownloaded, 1)
  // Not the last one: done, nothing else
  const g = fixture(t)
  await g.openAt('454617')
  const gate = deferred(); g.hash = () => gate.promise
  const c = g.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(g, c.item, TRUEHUD.bytes); await flush()
  g.win.close()
  gate.resolve(TRUEHUD.archive.md5); await flush()
  assert.deepEqual([g.state('454617'), g.allDownloaded, g.pending(TIMES.moveOn)], ['done', 0, 0])
})

test('the window that brings in the last mod says so, closes, and asks for the install before telling the page it closed', async t => {
  const f = fixture(t, { archives: [SKYUI, TRUEHUD] })
  await f.openAt('454617')
  const a = f.download({ ...cdn(SKYUI), total: SKYUI.archive.size })
  deliver(f, a.item, SKYUI.bytes)
  await until('SkyUI done', () => f.state('35407') === 'done')
  const b = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, b.item, TRUEHUD.bytes)
  await until('TrueHUD done', () => f.state('454617') === 'done')
  assert.equal(f.strip().step, 'allDone')
  assert.equal(f.allDownloaded, 0)
  assert.equal(f.nexus.isOpen(), true)
  f.events.length = 0
  f.run(TIMES.closeAfter)
  assert.equal(f.nexus.isOpen(), false)
  assert.equal(f.allDownloaded, 1)
  assert.deepEqual(f.events, ['install', 'closed'], 'the first push after closing already knows the install is asked for')
  assert.equal((await f.nexus.open(null)).error, TEXT.allDownloaded, 'nothing to reopen for')
  f.needed = [SKYUI.archive, TRUEHUD.archive]
  assert.equal((await f.nexus.open(null)).error, TEXT.allDownloaded, 'a check before the install still finds the kept files')
  assert.equal(f.allDownloaded, 1)
  // Closed by hand in the 1.5 seconds: the same single ask
  const g = fixture(t, { archives: [TRUEHUD] })
  await g.openAt('454617')
  const c = g.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(g, c.item, TRUEHUD.bytes)
  await until('done', () => g.state('454617') === 'done')
  await g.nexus.action(g.win.webContents, 'close')
  g.run(TIMES.closeAfter)
  assert.equal(g.allDownloaded, 1)
})

test('a check that finds every mod closes the window without asking for an install', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.nexus.neededChanged(null)
  assert.equal(f.strip().step, 'allIn')
  assert.deepEqual(Object.values(f.main().archives).map(a => a.state), ['done', 'done', 'done'])
  f.run(TIMES.closeAfter)
  assert.equal(f.nexus.isOpen(), false)
  assert.equal(f.allDownloaded, 0)
})

test('a check that finds some mods moves the window on, unless the player is logging in, signing up or on the settings page', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.commit(stepOf(TRUEHUD))
  f.needed = [SKYUI.archive, XPMSSE.archive]
  f.nexus.neededChanged(f.needed)
  assert.equal(f.state('454617'), 'done')
  assert.equal(f.main().current, '469854')
  assert.equal(f.wc.loaded.at(-1), stepOf(XPMSSE))
  assert.equal(f.nexus.isOpen(), true)
  assert.equal(f.pending(TIMES.closeAfter), 0)
  // On Nexus's login page: current moves, the page stays
  f.commit('https://users.nexusmods.com/auth/sign_in')
  const loads = f.wc.loaded.length
  f.needed = [SKYUI.archive]
  f.nexus.neededChanged(f.needed)
  assert.deepEqual([f.main().current, f.wc.loaded.length, f.strip().step, f.strip().mod.name], ['35407', loads, 'signin', 'SkyUI'])
})

test('a check that missed a fresh file keeps it done; a file gone since is wanted again', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, item, TRUEHUD.bytes)
  await until('done', () => f.state('454617') === 'done')
  f.nexus.neededChanged(f.needed)
  assert.equal(f.state('454617'), 'done')
  fs.rmSync(path.join(f.downloads, '62775-454617.7z'))
  f.nexus.neededChanged(f.needed)
  assert.equal(f.state('454617'), 'waiting')
})

test('a download a check found elsewhere meanwhile counts as done however it ends, so the window still closes and the install still comes', async t => {
  // Every mod found by a check while TrueHUD downloads; that download then stops: done, the window says so and closes,
  // and no install is asked for (the check that found them installs them)
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  f.nexus.neededChanged(null)
  assert.deepEqual([f.state('454617'), f.state('35407'), f.state('469854'), f.strip().step], ['downloading', 'done', 'done', 'downloading'], 'the download in flight still shows')
  item.received = 10; item.emit('updated', {}, 'interrupted')            // cannot resume: ended
  await flush()
  assert.deepEqual([f.state('454617'), f.strip().problem, f.strip().step], ['done', null, 'allIn'])
  assert.ok(f.logs.includes('[nexus] TrueHUD was found by a check while it downloaded: no longer needed'))
  f.run(TIMES.closeAfter)
  assert.deepEqual([f.nexus.isOpen(), f.allDownloaded], [false, 0])
  // Two found elsewhere while TrueHUD comes in wrong: not a problem, the page moves on, and the last one this window gets
  // asks for the install, once
  const g = fixture(t)
  await g.openAt('454617')
  const a = g.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  g.needed = [SKYUI.archive]; g.nexus.neededChanged(g.needed)
  a.item.received = Math.max(...ALL.map(m => m.archive.size)) + 1; a.item.emit('updated', {}, 'progressing')
  await flush()
  assert.deepEqual([g.state('454617'), g.strip().problem, g.main().current, g.wc.loaded.at(-1)], ['done', null, '35407', stepOf(SKYUI)])
  const b = g.download({ ...cdn(SKYUI), total: SKYUI.archive.size })
  deliver(g, b.item, SKYUI.bytes)
  await until('SkyUI done', () => g.state('35407') === 'done')
  assert.equal(g.strip().step, 'allDone')
  g.run(TIMES.closeAfter)
  assert.equal(g.allDownloaded, 1)
  // Found while it came in, and its copy turns out damaged: the same
  const k = fixture(t, { archives: [TRUEHUD, XPMSSE] })
  await k.openAt('454617')
  const c = k.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  k.nexus.neededChanged([XPMSSE.archive])
  deliver(k, c.item, Buffer.alloc(TRUEHUD.archive.size, 'x'))
  await until('settled', () => k.state('454617') === 'done')
  assert.deepEqual([k.strip().problem, k.files()], [null, []], 'nothing kept, nothing said')
  // Listed again by a later check before its download ends: wanted again, and a failure is a failure
  const h = fixture(t)
  await h.openAt('454617')
  const d = h.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  h.nexus.neededChanged([SKYUI.archive, XPMSSE.archive])
  h.nexus.neededChanged(h.needed)
  d.item.emit('updated', {}, 'interrupted'); await flush()
  assert.deepEqual([h.state('454617'), h.strip().problem?.kind], ['failed', 'interrupted'])
})

test('the window brings in the last needed mod while one a check found elsewhere still downloads and then fails: every mod is downloaded here, so the install is asked for', async t => {
  // TrueHUD in, being checked; XPMSSE downloading. The player's Check my downloads finds XPMSSE in the browser's folder but
  // not TrueHUD (still being checked here), so that check installs nothing. TrueHUD lands; XPMSSE's download then fails
  const play = async ({ closeFirst = false } = {}) => {
    const f = fixture(t, { archives: [TRUEHUD, XPMSSE] }), gate = deferred()
    let first = true
    f.hash = (...args) => { if (first) { first = false; return gate.promise.then(() => modInstall.hashFile(...args)) } return modInstall.hashFile(...args) }
    await f.openAt('454617')
    const a = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
    deliver(f, a.item, TRUEHUD.bytes)
    await until('TrueHUD being checked', () => f.state('454617') === 'checking')
    const b = f.download({ ...cdn(XPMSSE), total: XPMSSE.archive.size })
    assert.deepEqual([b.e.prevented, f.state('469854')], [false, 'downloading'])
    f.needed = [TRUEHUD.archive]; f.nexus.neededChanged(f.needed)
    gate.resolve()
    await until('TrueHUD done', () => f.state('454617') === 'done')
    assert.deepEqual([f.strip().step, f.allDownloaded], ['downloading', 0], 'XPMSSE still comes in: nothing yet')
    if (closeFirst) f.win.close()
    b.item.received = 10; b.item.emit('updated', {}, 'interrupted')        // cannot resume: ended
    await until('XPMSSE settled', () => f.state('469854') === 'done')
    return f
  }
  const f = await play()
  assert.equal(f.strip().step, 'allDone', 'every mod downloaded here, never "a check found them" (that check could not install)')
  f.run(TIMES.closeAfter)
  assert.deepEqual([f.nexus.isOpen(), f.allDownloaded, f.events.slice(-2)], [false, 1, ['install', 'closed']])
  // The window closed before the dropped download ended: the install is still asked for, once
  const g = await play({ closeFirst: true })
  assert.deepEqual([g.nexus.isOpen(), g.allDownloaded], [false, 1])
  // A check that ran after TrueHUD came in saw it: that check installs them, so the window asks for nothing
  const k = fixture(t, { archives: [TRUEHUD, XPMSSE] })
  await k.openAt('454617')
  const a = k.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(k, a.item, TRUEHUD.bytes)
  await until('TrueHUD done', () => k.state('454617') === 'done')
  const b = k.download({ ...cdn(XPMSSE), total: XPMSSE.archive.size })
  k.needed = null; k.nexus.neededChanged(null)
  b.item.received = 10; b.item.emit('updated', {}, 'interrupted')
  await until('XPMSSE settled', () => k.state('469854') === 'done')
  assert.equal(k.strip().step, 'allIn')
  k.run(TIMES.closeAfter)
  assert.deepEqual([k.nexus.isOpen(), k.allDownloaded], [false, 0])
})

test('a check that looked before a mod came in here still lists it: that check installs nothing, so the install is asked for once the last one is in', async t => {
  // TrueHUD comes in through the window. Then the answer of a check that looked before TrueHUD landed arrives: it still
  // lists TrueHUD (so it installed nothing) and found XPMSSE in the browser's folder while XPMSSE still downloads here;
  // XPMSSE's download then fails. Every mod is in, and only an install asked for now puts them in
  const f = fixture(t, { archives: [TRUEHUD, XPMSSE] })
  await f.openAt('454617')
  const a = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, a.item, TRUEHUD.bytes)
  await until('TrueHUD done', () => f.state('454617') === 'done')
  const b = f.download({ ...cdn(XPMSSE), total: XPMSSE.archive.size })
  f.needed = [TRUEHUD.archive]; f.nexus.neededChanged(f.needed)
  assert.deepEqual([f.state('454617'), f.state('469854'), f.allDownloaded], ['done', 'downloading', 0], 'TrueHUD\'s file is still there: it stays done')
  b.item.received = 10; b.item.emit('updated', {}, 'interrupted')            // cannot resume: ended
  await until('XPMSSE settled', () => f.state('469854') === 'done')
  assert.equal(f.strip().step, 'allDone', 'every mod downloaded here, never "a check found them" (that check missed TrueHUD)')
  f.run(TIMES.closeAfter)
  assert.deepEqual([f.nexus.isOpen(), f.allDownloaded, f.events.slice(-2)], [false, 1, ['install', 'closed']])
  // The same stale answer with nothing downloading: the last one counts as found, and the install is asked for at once
  const g = fixture(t, { archives: [TRUEHUD, XPMSSE] })
  await g.openAt('454617')
  const c = g.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(g, c.item, TRUEHUD.bytes)
  await until('TrueHUD done', () => g.state('454617') === 'done')
  g.needed = [TRUEHUD.archive]; g.nexus.neededChanged(g.needed)
  assert.deepEqual([g.state('469854'), g.strip().step], ['done', 'allDone'])
  g.run(TIMES.closeAfter)
  assert.deepEqual([g.nexus.isOpen(), g.allDownloaded], [false, 1])
  // A check that looked after TrueHUD came in does not list it: it saw it, installs them itself, and the window asks nothing
  const k = fixture(t, { archives: [TRUEHUD, XPMSSE] })
  await k.openAt('454617')
  const d = k.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(k, d.item, TRUEHUD.bytes)
  await until('TrueHUD done', () => k.state('454617') === 'done')
  k.needed = [XPMSSE.archive]; k.nexus.neededChanged(k.needed)
  k.needed = null; k.nexus.neededChanged(null)
  assert.equal(k.strip().step, 'allIn')
  k.run(TIMES.closeAfter)
  assert.deepEqual([k.nexus.isOpen(), k.allDownloaded], [false, 0])
  // A file of this window's that has gone since is wanted again, so it never counts as brought in
  const m = fixture(t, { archives: [TRUEHUD, XPMSSE] })
  await m.openAt('454617')
  const e = m.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(m, e.item, TRUEHUD.bytes)
  await until('TrueHUD done', () => m.state('454617') === 'done')
  fs.rmSync(path.join(m.downloads, '62775-454617.7z'))
  m.needed = [TRUEHUD.archive]; m.nexus.neededChanged(m.needed)
  assert.deepEqual([m.state('454617'), m.state('469854'), m.strip().step === 'allDone', m.allDownloaded], ['waiting', 'done', false, 0])
})

test('every mod in while Remove is being decided: no install into the folder being removed; asked once if the Remove does not happen', async t => {
  const play = async () => {
    const state = { removing: false }
    const f = fixture(t, { archives: [TRUEHUD], removing: () => state.removing })
    await f.openAt('454617')
    const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
    deliver(f, item, TRUEHUD.bytes)
    await until('done', () => f.state('454617') === 'done')
    assert.equal(f.strip().step, 'allDone')
    // Remove pressed: its confirm dialog is open when the window closes with every mod in
    state.removing = true
    f.run(TIMES.closeAfter)
    assert.deepEqual([f.nexus.isOpen(), f.allDownloaded], [false, 0], 'nothing installs into the folder being removed')
    assert.ok(f.logs.includes('[nexus] every mod is downloaded: the install waits until the Remove is decided'))
    state.removing = false
    return f
  }
  // Cancelled, refused or failed: asked now, once
  const f = await play()
  f.nexus.removeEnded(false)
  assert.equal(f.allDownloaded, 1)
  f.nexus.removeEnded(false)
  assert.equal(f.allDownloaded, 1, 'once')
  // Removed: the folder is gone, so nothing is asked, now or later
  const g = await play()
  g.nexus.removeEnded(true)
  g.nexus.removeEnded(false)
  assert.equal(g.allDownloaded, 0)
  // The last file finishes its check after the window closed, while the dialog is open: held back the same way
  const state = { removing: false }, hold = deferred()
  const k = fixture(t, { archives: [TRUEHUD], removing: () => state.removing })
  k.hash = () => hold.promise
  await k.openAt('454617')
  const c = k.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(k, c.item, TRUEHUD.bytes); await flush()
  k.win.close()
  state.removing = true
  hold.resolve(TRUEHUD.archive.md5)
  await until('done', () => k.state('454617') === 'done')
  assert.equal(k.allDownloaded, 0)
  state.removing = false
  k.nexus.removeEnded(false)
  assert.equal(k.allDownloaded, 1)
  // A check that found more to download meanwhile: nothing to install yet, so nothing is asked
  const m = await play()
  m.nexus.neededChanged([XPMSSE.archive])
  m.nexus.removeEnded(false)
  assert.equal(m.allDownloaded, 0)
})

test('Remove\'s confirm dialog open: nothing starts and the page keeps its words; confirmed: the page says Dovakarn is being removed', async t => {
  const state = { removing: false, asking: false }
  const f = fixture(t, { removing: () => state.removing, removeAsking: () => state.asking })
  f.nexus.pushMain()
  assert.deepEqual([f.main().removing, f.main().removeAsking], [false, false])
  state.removing = true; state.asking = true
  f.nexus.pushMain()
  assert.deepEqual([f.main().removing, f.main().removeAsking], [false, true], 'the dialog is open')
  assert.deepEqual(await f.nexus.open('454617'), { success: false, error: TEXT.removing }, 'no Nexus window meanwhile')
  state.asking = false
  f.nexus.pushMain()
  assert.deepEqual([f.main().removing, f.main().removeAsking], [true, false], 'confirmed')
  // Remove's own part counts as removing, never as asking
  state.removing = false; state.asking = true
  let during = null
  await f.nexus.stopWhile(async () => { during = f.nexus.snapshot() })
  assert.deepEqual([during.removing, during.removeAsking], [true, false])
  const g = fixture(t, { removeAsking: () => { throw new Error('gone') } })
  assert.equal(g.nexus.snapshot().removeAsking, false, 'a removeAsking() that throws holds nothing')
})

test('the Nexus login the launcher keeps: in with or without a name, out, or unknown while a login page is open; and whether the session keeps anything', async t => {
  const f = fixture(t)
  assert.deepEqual(f.nexus.snapshot().account, { user: '', login: 'unknown', kept: false })
  f.kept = true
  assert.deepEqual(f.nexus.snapshot().account, { user: '', login: 'unknown', kept: true })
  await f.openAt('454617')
  const step = stepOf(TRUEHUD)
  // Logged in, and Nexus shows no name (only the download box says so): logged in all the same
  await f.load({ href: step, title: 'TrueHUD', panel: panel(454617, { loggedIn: 'true' }) }, step)
  assert.deepEqual([f.nexusLogin, f.nexusName, f.main().account], ['in', '', { user: '', login: 'in', kept: true }])
  await f.load({ href: step, title: 'TrueHUD', user: 'Guest', loginLink: true, panel: panel(454617) }, step)
  assert.deepEqual([f.nexusLogin, f.main().account.login], ['out', 'out'])
  // Logged out, on Nexus's login page: the login may change there, so it is unknown until a Nexus page says
  f.commit(nx.signInUrl(TRUEHUD.archive))
  assert.deepEqual([f.nexusLogin, f.main().account.login], ['unknown', 'unknown'])
  await f.load({ href: step, title: 'TrueHUD', user: 'Dragonborn', panel: panel(454617, { loggedIn: 'true' }) }, step)
  assert.deepEqual(f.main().account, { user: 'Dragonborn', login: 'in', kept: true })
  f.commit('https://users.nexusmods.com/auth/sign_in')
  assert.equal(f.nexusLogin, 'in', 'logged in, a login page changes nothing kept')
  // A name kept by an earlier launcher run, from before the login was kept: logged in
  const g = fixture(t)
  g.nexusName = 'Dragonborn'
  assert.equal(g.nexus.snapshot().account.login, 'in')
  // What cannot be read holds nothing
  const h = nx.createNexusDownloads({ electron: () => assert.fail('no Electron'), parentWindow: () => null, setup: { neededArchives: () => null, downloadsDir: () => '' },
    nexusLogin: { get: () => { throw new Error('store gone') }, set: () => {} }, sessionKept: () => { throw new Error('disk gone') } })
  assert.deepEqual(h.snapshot().account, { user: '', login: 'unknown', kept: false })
  // The default: the partition's folder under the launcher's settings folder
  const dir = scratch(t)
  const k = nx.createNexusDownloads({ electron: () => assert.fail('no Electron'), parentWindow: () => null, setup: { neededArchives: () => null, downloadsDir: () => '' }, userDataDir: dir })
  assert.equal(k.snapshot().account.kept, false)
  fs.mkdirSync(path.join(dir, 'Partitions', 'nexus'), { recursive: true })
  assert.equal(k.snapshot().account.kept, true)
})

test('the cross-launcher lock is asked once for an open and a log out at the same time, and a win is never undone', async t => {
  // Our own pipe answers a second listen as taken (EADDRINUSE): a second ask would read as another launcher
  const f = fixture(t), gate = deferred()
  let asks = 0
  f.lockAnswer = () => (++asks === 1 ? gate.promise : Promise.resolve(false))
  const opening = f.nexus.open('454617'), loggingOut = f.nexus.logout()
  await flush()
  assert.equal(f.lockCalls.length, 1, 'one ask, shared')
  gate.resolve(true)
  assert.deepEqual(await opening, { success: true })
  assert.deepEqual(await loggingOut, { success: true })
  // Won: never asked again
  f.windows[0].close()
  assert.deepEqual(await f.nexus.open('454617'), { success: true })
  assert.deepEqual(await f.nexus.logout(), { success: true })
  assert.equal(f.lockCalls.length, 1)
  // Another launcher holds it: two log outs at once share one ask and are both told; the next press asks again
  const g = fixture(t), held = deferred()
  g.lockAnswer = () => held.promise
  const both = [g.nexus.logout(), g.nexus.logout()]
  held.resolve(false)
  assert.deepEqual(await Promise.all(both), [{ success: false, error: TEXT.logoutLocked }, { success: false, error: TEXT.logoutLocked }])
  assert.equal(g.lockCalls.length, 1)
  g.lockAnswer = true
  assert.deepEqual(await g.nexus.logout(), { success: true })
  assert.equal(g.lockCalls.length, 2)
})

test('while Dovakarn is being removed (its confirm dialog too) the window does not open, and the launcher page is told', async t => {
  let removing = false
  const f = fixture(t, { removing: () => removing })
  await f.openAt('454617')
  assert.equal(f.main().removing, false)
  removing = true
  f.nexus.pushMain()
  assert.equal(f.main().removing, true, 'the launcher page knows, so the window closing for it starts no check')
  f.win.close()
  assert.deepEqual([f.main().open, f.main().removing], [false, true], 'the push that says it closed says why too')
  assert.deepEqual(await f.nexus.open('454617'), { success: false, error: TEXT.removing })
  assert.equal(f.windows.length, 1, 'no new window')
  removing = false
  assert.deepEqual(await f.nexus.open('454617'), { success: true })
  // Remove's own part (stopWhile) counts too, even with nothing from main
  const g = fixture(t)
  await g.openAt('454617')
  let during = null
  await g.nexus.stopWhile(async () => { during = g.nexus.snapshot().removing })
  assert.deepEqual([during, g.nexus.snapshot().removing], [true, false])
  // A removing() that throws holds nothing
  const h = fixture(t, { removing: () => { throw new Error('gone') } })
  assert.deepEqual(await h.nexus.open('454617'), { success: true })
})

test('the step page is read through the main frame from dom-ready, and the login follows it', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const step = stepOf(TRUEHUD)
  await f.load({ href: step, title: 'TrueHUD', user: 'Guest', loginLink: true, panel: panel(454617) }, step)
  assert.deepEqual(f.wc.mainFrame.codes.at(-1), FACTS_SCRIPT)
  assert.deepEqual([f.strip().step, f.strip().login, f.strip().user], ['ready', 'out', ''])
  await f.load({ href: step, title: 'TrueHUD', user: 'Dragonborn', panel: panel(454617, { loggedIn: 'true' }) }, step)
  assert.deepEqual([f.strip().step, f.strip().login, f.strip().user, f.strip().premium], ['ready', 'in', 'Dragonborn', false])
  assert.deepEqual([f.nexusName, f.nexusLogin, f.main().account], ['Dragonborn', 'in', { user: 'Dragonborn', login: 'in', kept: false }], 'the name and the login are kept for Settings')
  await f.load({ href: step, title: 'TrueHUD', user: 'Dragonborn', panel: panel(454617, { loggedIn: 'true', premium: 'true' }) }, step)
  assert.equal(f.strip().premium, true)
  await f.load({ href: step, title: 'TrueHUD', user: 'Dragonborn', panel: panel(1) }, step)
  assert.equal(f.strip().step, 'nobox', 'another file\'s box')
  // No marker at all: the login stays as it was
  const g = fixture(t)
  await g.openAt('454617')
  await g.load({ href: step, title: 'TrueHUD', panel: panel(454617) }, step)
  assert.deepEqual([g.strip().step, g.strip().login], ['ready', 'unknown'])
  // Nexus's login pages say nothing about the login
  await f.load({ href: 'https://users.nexusmods.com/auth/sign_in', title: 'Log in' }, 'https://users.nexusmods.com/auth/sign_in')
  assert.deepEqual([f.strip().step, f.strip().login], ['signin', 'in'])
  // Any other www page: one read learns the login
  await f.load({ href: 'https://www.nexusmods.com/skyrimspecialedition/mods/1988', user: 'Guest' }, 'https://www.nexusmods.com/skyrimspecialedition/mods/1988')
  assert.deepEqual([f.strip().step, f.strip().login, f.nexusName, f.nexusLogin, f.main().account], ['away', 'out', '', 'out', { user: '', login: 'out', kept: false }])
})

test('a read that outlives its page or its mod is dropped', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const step = stepOf(TRUEHUD), late = deferred()
  f.wc.facts = () => late.promise
  f.commit(step); f.wc.emit('dom-ready')
  await f.nexus.action(f.win.webContents, 'skip')               // on to XPMSSE before the read answers
  late.resolve({ href: step, title: 'TrueHUD', user: 'Dragonborn', panel: panel(454617, { loggedIn: 'true' }) }); await flush()
  assert.deepEqual([f.strip().step, f.strip().login], ['opening', 'unknown'], 'XPMSSE never gets TrueHUD\'s facts')
  const other = deferred()
  f.wc.facts = () => other.promise
  f.commit(stepOf(XPMSSE)); f.wc.emit('dom-ready')
  other.resolve({ href: 'https://www.nexusmods.com/somewhere-else', panel: panel(469854) }); await flush()
  assert.equal(f.strip().step, 'opening', 'facts from another address are not this page\'s')
})

test('the mod-manager variant goes back to the plain step page once, and never in a loop', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const step = stepOf(TRUEHUD), loads = f.wc.loaded.length
  await f.load({ href: `${step}&nmm=1`, title: 'TrueHUD', user: 'Dragonborn', panel: panel(454617, { nmm: 'true' }) }, `${step}&nmm=1`)
  assert.deepEqual([f.wc.loaded.length, f.wc.loaded.at(-1)], [loads + 1, step], 'back to the plain step page')
  f.commit(step)
  assert.deepEqual([f.strip().step, f.strip().problem.kind], ['problem', 'modManager'], 'and the strip still says why')
  await f.load({ href: step, title: 'TrueHUD', user: 'Dragonborn', panel: panel(454617, { nmm: 'true' }) }, step)
  assert.equal(f.wc.loaded.length, loads + 1, 'Nexus shows it on the plain page too: no reload')
  await f.nexus.action(f.win.webContents, 'back'); f.commit(step); f.wc.facts = { href: step, panel: panel(454617, { nmm: 'true' }) }; f.wc.emit('dom-ready'); await flush()
  assert.equal(f.strip().step, 'nmm')
})

test('no download box: three answers without it and ten seconds; reads that never answer are never "no box"; no document at all is', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const step = stepOf(TRUEHUD)
  await f.load({ href: step, title: 'TrueHUD', user: 'Guest' }, step)
  for (let i = 0; i < 3; i++) { f.run(TIMES.poll); await flush() }
  assert.equal(f.strip().step, 'opening', 'answers, but not ten seconds yet')
  f.clock += TIMES.noBox
  f.run(TIMES.poll); await flush()
  assert.equal(f.strip().step, 'nobox')
  assert.equal(f.pending(TIMES.poll), 0, 'the poll stops')
  // The box turns up during the poll
  await f.nexus.action(f.win.webContents, 'retry')
  await f.load({ href: step, title: 'TrueHUD', user: 'Guest' }, step)
  f.wc.facts = { href: step, title: 'TrueHUD', user: 'Guest', panel: panel(454617) }
  f.run(TIMES.poll); await flush()
  assert.deepEqual([f.strip().step, f.pending(TIMES.poll)], ['ready', 0])
  // A page whose reads never answer
  await f.nexus.action(f.win.webContents, 'retry')
  f.wc.facts = () => new Promise(() => {})
  f.commit(step); f.wc.emit('dom-ready'); await flush()
  for (let i = 0; i < 12; i++) { f.run(TIMES.facts); await flush(); f.clock += 4000; f.run(TIMES.poll); await flush() }
  assert.equal(f.strip().step, 'opening', 'timeouts never count')
  // No document within half a minute
  await f.nexus.action(f.win.webContents, 'retry')
  f.commit(step)
  f.run(TIMES.noDom)
  assert.equal(f.strip().step, 'nobox')
})

test('Nexus\'s browser check: a check to tick, stuck after 45 seconds or a reload loop, and only the player\'s press reloads then', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const step = stepOf(TRUEHUD)
  await f.load({ href: step, title: 'Just a moment...' }, step)
  assert.equal(f.strip().step, 'challenge')
  for (let i = 0; i < 12; i++) { f.run(TIMES.poll); await flush() }
  assert.equal(f.strip().step, 'challenge', 'never "no box" while Cloudflare checks')
  f.run(TIMES.challenge)
  assert.equal(f.strip().step, 'stuck')
  // While stuck, a finished download does not reload the page
  const loads = f.wc.loaded.length
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(f, item, TRUEHUD.bytes)
  await until('done', () => f.state('454617') === 'done')
  f.run(TIMES.moveOn)
  assert.equal(f.wc.loaded.length, loads, 'no automatic reload while stuck')
  await f.nexus.action(f.win.webContents, 'retry')
  assert.equal(f.wc.loaded.length, loads + 1, 'the player\'s Try again does')
  assert.notEqual(f.strip().step, 'stuck')
  // Six commits of the step page within a minute
  const g = fixture(t)
  await g.openAt('454617')
  for (let i = 0; i < 6; i++) { g.commit(stepOf(TRUEHUD)); g.clock += 1000 }
  assert.equal(g.strip().step, 'stuck')
  g.wc.emit('page-title-updated', {}, 'Just a moment...')
  assert.equal(g.strip().step, 'stuck')
})

test('load errors: offline, crashed; an aborted or subframe load is nothing', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const step = stepOf(TRUEHUD)
  f.commit(step)
  f.wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', step, true)
  assert.equal(f.strip().step, 'opening')
  f.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example/', false)
  assert.equal(f.strip().step, 'opening')
  f.wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', step, true)
  assert.equal(f.strip().step, 'offline')
  f.wc.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(f.strip().step, 'crashed')
  assert.deepEqual(await f.nexus.action(f.win.webContents, 'retry'), { success: true })
  assert.equal(f.wc.loaded.at(-1), step)
  assert.equal(f.strip().step, 'opening')
})

test('nothing throws with nothing to show: every event, button and timer with no mod and with the view gone', async t => {
  const f = fixture(t, { archives: [TRUEHUD] })
  await f.openAt('454617')
  const fire = async () => {
    f.wc.emit('did-navigate', {}, stepOf(TRUEHUD), 200)
    f.wc.emit('did-navigate-in-page', {}, stepOf(TRUEHUD), true)
    f.wc.emit('dom-ready')
    f.wc.emit('page-title-updated', {}, 'Just a moment...')
    f.wc.emit('did-fail-load', {}, -105, 'x', stepOf(TRUEHUD), true)
    f.wc.emit('render-process-gone', {}, {})
    for (const name of ['will-frame-navigate', 'will-navigate', 'will-redirect']) f.wc.emit(name, nav('https://ads.example/', { initiator: PAGE }))
    f.wc.emit('will-frame-navigate', null)
    for (const name of nx.ACTIONS) if (name !== 'close') await f.nexus.action(f.win.webContents, name)
    for (const timer of f.timers.filter(x => !x.fired && !x.cleared)) { timer.fired = true; timer.fn() }
    await flush()
  }
  f.nexus.neededChanged(null)                                   // every mod found: current is null
  await fire()
  f.wc.destroyed = true                                          // and the view gone
  await fire()
  assert.ok(f.logs.every(l => l.startsWith('[nexus]')), 'only log lines')
})

test('a throw inside a listener or a button is logged and shown as a plain problem, never thrown into Electron', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  f.setup.openMod = () => { throw new Error('shell is gone') }
  assert.deepEqual(await f.nexus.action(f.win.webContents, 'browser'), { success: false })
  assert.equal(f.strip().problem?.kind, 'error')
  assert.ok(f.logs.some(l => l === '[nexus] button: shell is gone'))
  f.wc.loadURL = () => { throw new Error('view broke') }
  assert.doesNotThrow(() => f.commit('https://cdn.example/'))
  assert.ok(f.logs.some(l => l === '[nexus] did-navigate: view broke'))
  assert.equal(f.strip().problem?.kind, 'error')
})

test('the strip\'s buttons, and only from the strip', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const act = name => f.nexus.action(f.win.webContents, name), step = stepOf(TRUEHUD)
  assert.deepEqual(await act('login'), { success: true })
  assert.equal(f.wc.loaded.at(-1), nx.signInUrl(TRUEHUD.archive))
  await f.load({ href: step, user: 'Dragonborn', panel: panel(454617, { loggedIn: 'true' }) }, step)
  assert.equal(f.strip().login, 'in')
  assert.deepEqual(await act('logout'), { success: true })
  assert.deepEqual(f.ses.cleared, ['storage', 'cache', 'auth'])
  assert.equal(f.wc.loaded.at(-1), step)
  assert.deepEqual([f.strip().login, f.strip().user, f.nexusName], ['out', '', ''])
  assert.deepEqual(await act('skip'), { success: true })
  assert.equal(f.main().current, '469854')
  assert.equal(f.wc.loaded.at(-1), stepOf(XPMSSE))
  await act('skip')
  assert.equal(f.main().current, '35407', 'wraps round')
  f.needed = [TRUEHUD.archive, XPMSSE.archive]; f.nexus.neededChanged(f.needed)   // SkyUI found by a check
  assert.equal(f.main().current, '454617')
  await act('skip')
  assert.equal(f.main().current, '469854')
  await act('skip')
  assert.equal(f.main().current, '454617', 'done ones are skipped')
  assert.deepEqual(await act('browser'), { success: true })
  assert.deepEqual(f.opened, ['454617'])
  assert.equal(f.strip().problem.kind, 'inBrowser')
  assert.deepEqual(await act('settings'), { success: true })
  assert.equal(f.wc.loaded.at(-1), SETTINGS_URL)
  f.commit(SETTINGS_URL)
  assert.deepEqual([f.strip().step, f.strip().offStep], ['problem', true], 'the settings page the launcher opened keeps the strip\'s line, and Back')
  assert.deepEqual(await act('back'), { success: true })
  assert.equal(f.wc.loaded.at(-1), step)
  assert.equal(f.strip().problem, null)
  // Log out while a download is in flight: refused, nothing cleared
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  assert.deepEqual(await act('logout'), { success: false, error: TEXT.logoutBusy })
  assert.equal(f.ses.cleared.length, 3)
  item.cancel(); await flush()
  const loads = f.wc.loaded.length
  for (const [sender, name] of [[f.win.webContents, 'jump'], [f.win.webContents, 5], [f.win.webContents, undefined], [f.wc, 'close'], [f.wc, 'skip'], [{}, 'logout'], [null, 'minimize']]) {
    assert.deepEqual(await f.nexus.action(sender, name), { success: false }, String(name))
  }
  assert.equal(f.wc.loaded.length, loads)
  assert.equal(f.ses.cleared.length, 3)
  assert.equal(f.nexus.isOpen(), true)
  assert.deepEqual(await act('minimize'), { success: true })
  assert.deepEqual(f.parent.calls, ['minimize'], 'the launcher goes down, taking this window with it')
  assert.deepEqual(await act('close'), { success: true })
  assert.equal(f.nexus.isOpen(), false)
  assert.deepEqual(await f.nexus.action(f.win.webContents, 'skip'), { success: false }, 'a closed window has no buttons')
})

test('Log out of Nexus from Settings with no window: the lock, the session once, all three stores; refused while another launcher has it', async t => {
  const f = fixture(t)
  f.nexusName = 'Dragonborn'
  assert.deepEqual(await f.nexus.logout(), { success: true })
  assert.deepEqual([f.lockCalls.length, f.partitions, f.ses.cleared, f.windows.length, f.nexusName, f.ses.headerListeners], [1, ['persist:nexus'], ['storage', 'cache', 'auth'], 0, '', 1])
  assert.deepEqual([f.main().account, f.nexusLogin], [{ user: '', login: 'out', kept: false }, 'out'])
  await f.nexus.logout()
  assert.deepEqual([f.lockCalls.length, f.ses.headerListeners], [1, 1], 'once each')
  const g = fixture(t)
  g.lockAnswer = false
  // Its own words: the press to repeat is Log out of Nexus, not Download
  assert.deepEqual(await g.nexus.logout(), { success: false, error: TEXT.logoutLocked })
  assert.equal(TEXT.logoutLocked, 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Log out of the Nexus window again.')
  assert.deepEqual(g.ses.cleared, [])
})

test('Remove waits for the window\'s work: the download stopped, a file being checked finished, the window closed, then the folder', async t => {
  const f = fixture(t)
  await f.openAt('454617')
  const { item } = f.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  fs.writeFileSync(item.savePath, 'part')
  const order = []
  const removing = f.nexus.stopWhile(async () => { order.push(['task', item.cancelled, f.state('454617'), fs.existsSync(item.savePath), f.nexus.isOpen()]); order.push(['open', await f.nexus.open('454617')]); return { success: true } })
  assert.deepEqual(await removing, { success: true })
  assert.deepEqual(order, [['task', 1, 'waiting', false, false], ['open', { success: false, error: TEXT.removing }]])
  assert.deepEqual(await f.nexus.open('454617'), { success: true }, 'works again afterwards')
  // During a check: the folder goes only after the check settled and the part file is gone
  const g = fixture(t, { archives: [TRUEHUD] })
  await g.openAt('454617')
  const hold = deferred(); g.hash = () => hold.promise
  const c = g.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(g, c.item, TRUEHUD.bytes); await flush()
  let ran = false
  const removing2 = g.nexus.stopWhile(async () => { ran = true; return { success: true } })
  await flush()
  assert.equal(ran, false, 'not while the file is checked')
  const refused = g.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  assert.equal(refused.e.prevented, true, 'no download while Remove runs')
  hold.resolve(TRUEHUD.archive.md5)
  await removing2
  assert.equal(ran, true)
  assert.equal(fs.existsSync(c.item.savePath), false)
  assert.equal(g.allDownloaded, 0, 'no install asked for from inside Remove')
  assert.deepEqual([g.state('454617'), g.files()], ['waiting', []], 'nothing moved into a folder being removed')
  // A long check (a big file) is stopped at once rather than waited out: the hash is told to stop
  const k = fixture(t, { archives: [TRUEHUD] })
  await k.openAt('454617')
  let signal = null; k.hash = (_file, _algorithm, s) => { signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new Error('stopped')), { once: true })) }
  const d = k.download({ ...cdn(TRUEHUD), total: TRUEHUD.archive.size })
  deliver(k, d.item, TRUEHUD.bytes); await flush()
  assert.equal(k.state('454617'), 'checking')
  let folderGone = false
  await k.nexus.stopWhile(async () => { folderGone = true })
  assert.deepEqual([signal.aborted, folderGone, k.state('454617'), fs.existsSync(d.item.savePath), k.files()], [true, true, 'waiting', false, []])
  assert.ok(k.logs.some(l => l.includes('was stopped: Dovakarn is being removed')))
  // A task that throws: the same error, and the window can be opened again
  const h = fixture(t)
  await assert.rejects(h.nexus.stopWhile(async () => { throw new Error('EBUSY: folder in use') }), /folder in use/)
  assert.deepEqual(await h.nexus.open('454617'), { success: true })
})

test('adult flags come from Nexus in one keyless request, and only ever add a hint', async t => {
  const calls = [], said = []
  const answer = nodes => async (url, options) => { calls.push([url, options]); return { body: Buffer.from(JSON.stringify({ data: { legacyModsByDomain: { nodes } } })) } }
  const flags = await nx.fetchAdultFlags({ modIds: [62775, 1988, 12604, 1988, -1, 1.5], request: answer([{ modId: 1988, adultContent: true }, { modId: 62775, adultContent: false }, { modId: 777, adultContent: true }, null]), log: l => said.push(l) })
  assert.deepEqual([...flags], [1988])
  assert.equal(calls.length, 1)
  const [url, options] = calls[0], body = JSON.parse(options.body)
  assert.equal(url, NEXUS_API)
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Application-Name'], 'Dovakarn Launcher')
  assert.equal(body.query, nx.ADULT_QUERY)
  assert.deepEqual(body.variables, { ids: [62775, 1988, 12604].map(modId => ({ gameDomain: 'skyrimspecialedition', modId })), count: 3 })
  assert.deepEqual(said, [])
  for (const bad of [async () => ({ body: Buffer.from('{not json') }), async () => ({ body: Buffer.from(JSON.stringify({ errors: [{ message: 'x' }] })) }), async () => { throw new Error('offline') }]) {
    const lines = []
    assert.deepEqual([...await nx.fetchAdultFlags({ modIds: [1988], request: bad, log: l => lines.push(l) })], [])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\[nexus\] could not ask Nexus which mods are adult: /)
  }
  calls.length = 0
  await nx.fetchAdultFlags({ modIds: Array.from({ length: 150 }, (_, i) => i + 1), request: answer([]) })
  assert.deepEqual(calls.map(([, o]) => JSON.parse(o.body).variables.count), [100, 50])
  // In the window: the hint on XPMSSE only
  calls.length = 0
  const f = fixture(t, { request: answer([{ modId: 1988, adultContent: true }]) })
  await f.openAt('454617')
  await flush()
  assert.equal(f.strip().adult, false)
  await f.nexus.open('469854')
  assert.equal(f.strip().adult, true)
  f.win.close()
  await f.openAt('454617')
  await flush()
  assert.equal(calls.length, 1, 'asked once per launcher run')
  // Nexus not answering: the window opens all the same
  const g = fixture(t, { request: async () => { throw new Error('offline') } })
  assert.deepEqual(await g.openAt('469854'), { success: true })
  await flush()
  assert.equal(g.strip().adult, false)
  assert.equal(g.nexus.isOpen(), true)
})

test('the install waits for an idle launcher, runs the check once, retries a busy one, and never starts while the launcher closes', async () => {
  const settled = async () => { for (let i = 0; i < 5; i++) await settle() }
  let idle = false, left = [{ id: '1' }], answers = [], checks = 0, alive = true
  const waits = [], states = [], said = []
  const trigger = nx.createInstallTrigger({ idle: async () => idle, needed: () => left, check: async () => { checks++; return answers.shift() || { success: true } },
    alive: () => alive, onChange: () => states.push({ ...trigger.state() }), log: l => said.push(l), wait: () => new Promise(r => waits.push(r)) })
  assert.equal(trigger.request(), true)
  assert.equal(trigger.request(), false, 'one run at a time')
  await settled()
  assert.equal(checks, 0, 'not while the launcher is busy')
  assert.equal(waits.length, 1)
  waits.shift()(); await settled()
  assert.equal(checks, 0)
  idle = true; waits.shift()(); await settled()
  assert.equal(checks, 1)
  assert.deepEqual(states, [{ queued: true, running: false }, { queued: true, running: true }, { queued: true, running: false }, { queued: false, running: false }])
  assert.deepEqual(trigger.state(), { queued: false, running: false })
  // Busy each time: retried, five times at most
  answers = Array.from({ length: 9 }, () => ({ success: false, code: 'BUSY' })); checks = 0
  trigger.request()
  for (let i = 0; i < 20; i++) { await settled(); while (waits.length) waits.shift()() }
  assert.equal(checks, 5)
  assert.ok(said.some(l => l.includes('stayed busy')))
  // Busy once, then through
  answers = [{ success: false, code: 'BUSY' }]; checks = 0
  trigger.request()
  for (let i = 0; i < 5; i++) { await settled(); while (waits.length) waits.shift()() }
  assert.equal(checks, 2)
  // Another check installed them meanwhile: nothing to do
  left = null; checks = 0
  trigger.request(); await settled()
  assert.equal(checks, 0)
  assert.ok(said.includes('[nexus] the mods were already installed by another check'))
  assert.deepEqual(trigger.state(), { queued: false, running: false })
  // The launcher closing while it waits: no check, and the state is idle again
  left = [{ id: '1' }]; idle = false; checks = 0
  trigger.request(); await settled()
  alive = false; while (waits.length) waits.shift()(); await settled()
  assert.equal(checks, 0)
  assert.deepEqual(trigger.state(), { queued: false, running: false })
  assert.ok(said.includes('[nexus] the launcher is closing: the mods install at its next start'))
})

test('the cross-launcher lock: a second taker is refused while the first holds it', { skip: process.platform !== 'win32' && 'Windows named pipes only' }, async () => {
  const name = `\\\\.\\pipe\\dovakarn-nexus-test-${process.pid}-${Date.now()}`
  const servers = [], net = { createServer: fn => { const s = require('node:net').createServer(fn); servers.push(s); return s } }
  try {
    assert.equal(await nx.takeProcessLock(name, net), true)
    assert.equal(await nx.takeProcessLock(name, net), false)
  } finally { for (const s of servers) try { s.close() } catch { /* not listening */ } }
})

test("the cross-launcher lock's name: one per settings folder, whatever the case", () => {
  assert.equal(nx.lockName('C:\\Users\\A\\AppData\\Roaming\\Dovakarn Launcher'), nx.lockName('c:\\users\\a\\appdata\\roaming\\dovakarn launcher'), 'one name per settings folder, whatever the case')
  assert.notEqual(nx.lockName('C:\\Users\\A\\AppData\\Roaming\\Dovakarn Launcher'), nx.lockName('C:\\Users\\B\\AppData\\Roaming\\Dovakarn Launcher'))
})

// ---- The automatic download through Nexus's API (a logged-in Premium member) ----
// The player's Nexus account as nexusAccount.js answers: links and files come from here, keyed by the archive id in the
// link. bytes: what Nexus sends per archive id; fail: per archive id, { link } or { file: [errors, in order] }; gate: holds
// a file until released (or stopped)
function fakeAccount({ premium = true, loggedIn = true } = {}) {
  const a = { premium, loggedIn, links: [], files: [], bytes: {}, fail: {}, gate: null }
  const stopped = () => Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
  a.status = () => ({ loggedIn: a.loggedIn, account: a.loggedIn ? { name: 'Dragonborn', premium: a.premium } : null })
  a.downloadLink = async (archive, { signal } = {}) => {
    a.links.push(archive.id)
    if (signal?.aborted) throw stopped()
    const f = a.fail[archive.id]?.link
    if (f) throw Object.assign(new Error(f.message), { code: f.code })
    return `https://cf-files.nexusmods.com/cdn/1704/${archive.modId}/${archive.id}/${encodeURIComponent(archive.name)}.7z?md5=x&expires=1`
  }
  a.nexusFile = async (url, savePath, { limit, onProgress, signal }) => {
    const id = new URL(url).pathname.split('/')[4]
    a.files.push(id)
    const queued = a.fail[id]?.file
    if (queued && queued.length) { const e = queued.shift(); throw Object.assign(new Error(e.message), { code: e.code }) }
    if (a.gate) await a.gate(id, signal)
    if (signal?.aborted) throw stopped()
    const bytes = a.bytes[id] || ALL.find(m => m.archive.id === id).bytes
    if (bytes.length > limit) throw Object.assign(new Error('Nexus sent a different file from the one Dovakarn needs.'), { code: 'different' })
    onProgress({ received: Math.floor(bytes.length / 2), total: bytes.length })
    fs.writeFileSync(savePath, bytes)
    return { host: 'cf-files.nexusmods.com' }
  }
  return a
}
const named = m => `${m.archive.modId}-${m.archive.fileId}.7z`
const directIdle = f => !!f.main() && !f.main().direct.running

test("Premium: Download downloads every mod through Nexus's API, the pressed one first, with no window, and asks for the install once", async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  assert.equal(f.main().premium, true, 'the page knows a press downloads by itself')
  assert.deepEqual(await f.nexus.open('454617'), { success: true, direct: true })
  assert.equal(f.main().direct.running, true)
  await until('the run ends', () => directIdle(f))
  assert.deepEqual(acct.links, ['454617', '35407', '469854'], "the pressed one first, then the rest in the server's order")
  assert.deepEqual([f.electronCalls, f.lockCalls.length, f.windows.length], [0, 1, 0], 'no window and no Nexus session; the one-launcher lock is taken, as the window takes it')
  assert.deepEqual(f.files().sort(), ALL.map(named).sort(), 'each kept under its Nexus ids, as the window keeps them')
  for (const m of ALL) assert.equal(md5(fs.readFileSync(path.join(f.downloads, named(m)))), m.archive.md5)
  assert.deepEqual(Object.values(f.main().archives).map(a => a.state), ['done', 'done', 'done'])
  assert.equal(f.allDownloaded, 1, 'the install is asked for once')
  assert.deepEqual(f.main().direct, { running: false, problem: null })
  assert.ok(f.logs.some(l => /TrueHUD 1\.1\.9 downloaded through Nexus's API from cf-files\.nexusmods\.com and checked/.test(l)))
  assert.deepEqual(f.sleeps.filter(ms => ms === TIMES.linkPause), [1000, 1000], 'a pause before every download link request after the first')
})

test('a file Nexus sends wrong is said and the rest go on; Download tries it again', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  acct.bytes['35407'] = Buffer.alloc(SKYUI.bytes.length, 7)                    // the right size, the wrong MD5
  acct.bytes['469854'] = Buffer.concat([XPMSSE.bytes, Buffer.from('more')])    // bigger than the file needed
  await f.nexus.open(null)
  await until('the run ends', () => directIdle(f))
  assert.deepEqual([f.state('35407'), f.state('454617'), f.state('469854')], ['failed', 'done', 'wrong'])
  assert.deepEqual(f.files(), [named(TRUEHUD)], 'only the good one is kept, and no part file stays')
  assert.equal(f.allDownloaded, 0)
  assert.deepEqual(f.main().direct.problem, { kind: 'some', message: TEXT.someFailed(2, ['SkyUI', 'XP32 Maximum Skeleton Special Extended']) })
  assert.equal(TEXT.someFailed(2, []), '2 mods could not download by themselves. Press Download them all to try again, or use the Nexus window.')
  assert.equal(TEXT.someFailed(1, ['SkyUI']), 'SkyUI could not download by itself. Press Download them all to try again, or use the Nexus window.')
  delete acct.bytes['35407']; delete acct.bytes['469854']
  await f.nexus.open(null)
  assert.equal(f.main().direct.problem, null, 'a new run starts with nothing said')
  await until('the second run ends', () => directIdle(f))
  assert.deepEqual(acct.links.slice(3), ['35407', '469854'], 'only what is still needed is asked for again')
  assert.deepEqual(f.files().sort(), ALL.map(named).sort())
  assert.equal(f.allDownloaded, 1)
})

test("not Premium, logged out, Nexus's limit or Nexus out of reach ends the run with what to do; no file is blamed", async t => {
  for (const code of ['notPremium', 'nexusLoggedOut', 'rateLimited', 'nexusUnreachable', 'renewFailed', 'save']) {
    const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
    f.nexus.neededChanged(f.needed)
    acct.fail['35407'] = { link: { code, message: `said for ${code}` } }
    await f.nexus.open(null)
    await until('the run ends', () => directIdle(f))
    assert.deepEqual(acct.links, ['35407'], `${code}: the rest are not tried`)
    assert.deepEqual(Object.values(f.main().archives).map(a => a.state), ['waiting', 'waiting', 'waiting'], code)
    assert.deepEqual(f.main().direct.problem, { kind: code, message: `said for ${code}` })
  }
})

test('a dropped connection is tried once more; Nexus no longer having a file fails that file only', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  acct.fail['35407'] = { file: [{ code: 'interrupted', message: 'The download was cut off. Try again.' }] }
  acct.fail['454617'] = { file: [{ code: 'stalled', message: 'No bytes.' }, { code: 'stalled', message: 'No bytes.' }] }
  acct.fail['469854'] = { link: { code: 'gone', message: 'Nexus no longer has this file.' } }
  await f.nexus.open(null)
  await until('the run ends', () => directIdle(f))
  assert.deepEqual([f.state('35407'), f.state('454617'), f.state('469854')], ['done', 'failed', 'failed'])
  assert.deepEqual(acct.links, ['35407', '35407', '454617', '454617', '469854'], 'a fresh link for the second try; a gone file is not tried twice')
  assert.equal(f.sleeps.filter(ms => ms === TIMES.linkPause).length, 4, 'a retry waits its pause too: one before every link request after the first')
  assert.equal(f.main().direct.problem.kind, 'some')
})

test('Stop and Remove: the file in progress is dropped, the ones already in stay, and Remove waits for the run to end', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  let reached = deferred()
  acct.gate = (id, signal) => id === '35407' ? Promise.resolve() : new Promise((_resolve, reject) => {
    reached.resolve(id)
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })), { once: true })
  })
  await f.nexus.open(null)
  assert.equal(await reached.promise, '454617')
  assert.equal(f.state('454617'), 'downloading')
  assert.deepEqual(f.nexus.stopDirect(), { success: true, stopped: true })
  assert.deepEqual(f.nexus.stopDirect(), { success: true, stopped: false }, 'a second press stops nothing more')
  await until('the run ends', () => directIdle(f))
  assert.deepEqual([f.state('35407'), f.state('454617'), f.state('469854')], ['done', 'waiting', 'waiting'])
  assert.deepEqual(f.files(), [named(SKYUI)], 'the one already in stays; no part file is left')
  assert.equal(f.main().direct.problem, null, 'a Stop is not a problem')
  assert.equal(f.allDownloaded, 0)
  // Remove while it runs: the run stops, and the folder's task runs only after it has ended
  reached = deferred()
  await f.nexus.open(null)
  assert.equal(await reached.promise, '454617')
  const order = []
  await f.nexus.stopWhile(async () => { order.push(['task', f.main().direct.running, f.state('454617')]) })
  assert.deepEqual(order, [['task', false, 'waiting']])
  assert.equal(acct.links.filter(id => id === '469854').length, 0, 'nothing after the stopped file was started')
})

test('while it runs: Download again changes nothing, the window is refused; a free or logged-out account keeps the window', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  const hold = deferred()
  acct.gate = () => hold.promise
  await f.nexus.open(null)
  assert.deepEqual(await f.nexus.open('469854'), { success: true, direct: true })
  assert.deepEqual(await f.nexus.open(null, { useWindow: true }), { success: false, error: TEXT.windowWhileDirect })
  assert.equal(f.electronCalls, 0)
  hold.resolve()
  await until('the run ends', () => directIdle(f))
  assert.deepEqual(acct.links, ['35407', '454617', '469854'], 'the second press started nothing new')
  for (const account of [fakeAccount({ premium: false }), fakeAccount({ loggedIn: false })]) {
    const g = fixture(t, { nexusAccount: account })
    g.nexus.neededChanged(g.needed)
    assert.equal(g.main().premium, false)
    assert.deepEqual(await g.openAt(null), { success: true })
    assert.equal(g.windows.length, 1, 'the Nexus window, as without an account')
    assert.deepEqual(account.links, [])
  }
  // With Premium, the player can still ask for the window (after a run could not get a mod)
  const h = fixture(t, { nexusAccount: fakeAccount() })
  h.nexus.neededChanged(h.needed)
  const answer = await h.nexus.open(null, { useWindow: true })
  assert.deepEqual([answer, h.windows.length], [{ success: true }, 1])
})

test('a check that finds a mod while it downloads drops it: done, never blamed', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  const reached = deferred(), hold = deferred()
  acct.gate = id => id === '35407' ? (reached.resolve(), hold.promise) : Promise.resolve()
  acct.bytes['35407'] = Buffer.alloc(SKYUI.bytes.length, 1)                   // would fail its MD5
  await f.nexus.open(null)
  await reached.promise
  f.nexus.neededChanged([TRUEHUD.archive, XPMSSE.archive])                       // a check found SkyUI elsewhere
  hold.resolve()
  await until('the run ends', () => directIdle(f))
  assert.deepEqual([f.state('35407'), f.state('454617'), f.state('469854')], ['done', 'done', 'done'])
  assert.equal(f.main().direct.problem, null)
  assert.equal(f.allDownloaded, 1)
})

test('a late check that lists a mod the automatic download brought in still gets the install asked for', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  const reached = deferred(), hold = deferred()
  acct.gate = id => id === '454617' ? (reached.resolve(), hold.promise) : Promise.resolve()
  acct.bytes['454617'] = Buffer.alloc(TRUEHUD.bytes.length, 1)                // would fail its MD5
  await f.nexus.open(null)
  await reached.promise
  assert.equal(f.state('35407'), 'done')
  // A check that listed the folder before SkyUI landed: SkyUI still needed, the other two found elsewhere
  f.nexus.neededChanged([SKYUI.archive])
  hold.resolve()
  await until('the run ends', () => directIdle(f))
  assert.deepEqual([f.state('35407'), f.state('454617'), f.state('469854')], ['done', 'done', 'done'])
  assert.equal(f.allDownloaded, 1, 'that check could not install SkyUI, so the install is asked for')
})

test("Nexus failing stops the run in its own words; another launcher using Nexus stops it before anything is touched", async t => {
  for (const error of [{ code: 'http503', message: 'Nexus is having trouble right now. Try again in a minute.' }, { code: 'server_error', status: 500, message: 'Nexus is having trouble right now. Try again in a minute.' }]) {
    const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
    f.nexus.neededChanged(f.needed)
    acct.downloadLink = async archive => { acct.links.push(archive.id); throw Object.assign(new Error(error.message), error) }
    await f.nexus.open(null)
    await until('the run ends', () => directIdle(f))
    assert.deepEqual(acct.links, ['35407'], error.code)
    assert.deepEqual(f.main().direct.problem, { kind: error.code, message: error.message })
  }
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  f.lockAnswer = false
  await f.nexus.open(null)
  await until('the run ends', () => directIdle(f))
  assert.deepEqual([acct.links, f.main().direct.problem], [[], { kind: 'locked', message: TEXT.lockedDirect }])
  assert.equal(fs.existsSync(path.join(f.downloads, '.incoming')), false, "the other launcher's part files are never touched")
})

test('what the last run could not get follows the list, and a new Premium login clears a login problem', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  acct.bytes['35407'] = Buffer.alloc(SKYUI.bytes.length, 7)
  acct.bytes['469854'] = Buffer.alloc(XPMSSE.bytes.length, 7)
  await f.nexus.open(null)
  await until('the run ends', () => directIdle(f))
  assert.equal(f.main().direct.problem.message, TEXT.someFailed(2, ['SkyUI', 'XP32 Maximum Skeleton Special Extended']))
  // SkyUI found by a check since (the player got it in the Nexus window): only the other is named
  f.nexus.neededChanged([XPMSSE.archive])
  assert.equal(f.nexus.snapshot().direct.problem.message, TEXT.someFailed(1, ['XP32 Maximum Skeleton Special Extended']))
  f.nexus.neededChanged([])
  assert.equal(f.nexus.snapshot().direct.problem, null, 'none left: nothing to say')
  // Not Premium: said until the account can download again
  const account = fakeAccount()
  account.fail['35407'] = { link: { code: 'notPremium', message: 'Only Nexus Premium members get the mods downloaded by themselves. Use the Nexus window and its Slow download button.' } }
  const h = fixture(t, { nexusAccount: account })
  h.nexus.neededChanged(h.needed)
  await h.nexus.open(null)
  await until('the run ends', () => directIdle(h))
  assert.equal(h.main().direct.problem.kind, 'notPremium')
  account.premium = false
  h.nexus.accountChanged()
  assert.equal(h.main().direct.problem.kind, 'notPremium', 'still not able to download: still said')
  account.premium = true
  h.nexus.accountChanged()
  assert.equal(h.main().direct.problem, null, 'a Premium login again: the old line goes')
})

test('Download pressed while Stop winds the run down starts a fresh one; with only a finishing window download, it says to wait', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  let reached = deferred()
  acct.gate = (id, signal) => id === '35407' ? Promise.resolve() : new Promise((_resolve, reject) => {
    reached.resolve(id)
    signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })), 20), { once: true })
  })
  await f.nexus.open(null)
  await reached.promise
  f.nexus.stopDirect()
  reached = deferred()
  assert.deepEqual(await f.nexus.open(null), { success: true, direct: true })
  assert.equal(await reached.promise, '454617', 'a new run, asking again for the file that was stopped')
  f.nexus.stopDirect()
  await until('the run ends', () => directIdle(f))
  // The window's download still finishing after it closed: nothing for an automatic run to take yet
  const account = fakeAccount({ premium: false }), g = fixture(t, { nexusAccount: account, archives: [TRUEHUD] })
  g.nexus.neededChanged(g.needed)
  await g.openAt('454617')
  g.download({ ...cdn(TRUEHUD), filename: 'TrueHUD.7z', total: TRUEHUD.archive.size })
  assert.equal(g.state('454617'), 'downloading')
  account.premium = true
  g.win.close()
  assert.deepEqual(await g.nexus.open(null), { success: false, error: TEXT.stillFinishing })
  assert.deepEqual(account.links, [])
})

test('a new login clears "your Nexus login has ended" even with a free account; not Premium waits for Premium', async t => {
  const account = fakeAccount(), f = fixture(t, { nexusAccount: account })
  f.nexus.neededChanged(f.needed)
  account.fail['35407'] = { link: { code: 'nexusLoggedOut', message: 'Your Nexus login has ended. Log in to Nexus again.' } }
  await f.nexus.open(null)
  await until('the run ends', () => directIdle(f))
  account.loggedIn = false
  f.nexus.accountChanged()
  assert.equal(f.main().direct.problem.kind, 'nexusLoggedOut', 'still logged out: still said')
  Object.assign(account, { loggedIn: true, premium: false })
  f.nexus.accountChanged()
  assert.equal(f.main().direct.problem, null)
})

test('a new run gives every mod that failed before its turn again, so a row that failed during a run failed in it', async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  acct.bytes['35407'] = Buffer.alloc(SKYUI.bytes.length, 7)
  await f.nexus.open(null)
  await until('the first run ends', () => directIdle(f))
  assert.equal(f.state('35407'), 'failed')
  delete acct.bytes['35407']
  const pushed = f.mains.length
  await f.nexus.open(null)
  // The run's first word to the page: the mod that failed before is waiting its turn again, never shown as failed
  const first = f.mains.slice(pushed).find(s => s.direct.running)
  assert.equal(first.archives['35407'].state, 'waiting')
  await until('the second run ends', () => directIdle(f))
  assert.equal(f.state('35407'), 'done')
})

// The fake clock moves while Nexus answers: a link request takes 400 ms and a file that comes in takes 2000 ms
function timeAnswers(acct, f) {
  const link = acct.downloadLink, file = acct.nexusFile
  acct.downloadLink = async (archive, options) => { f.order.push(`link ${archive.id}`); f.clock += 400; return link(archive, options) }
  acct.nexusFile = async (...args) => { const answer = await file(...args); f.clock += 2000; return answer }
}
const linksAndSleeps = f => f.order.filter(e => e.startsWith('link') || e.startsWith('sleep'))

test('the pause between download link requests: before each request after the first, across runs too, and Stop ends it at once', async t => {
  // The order: each pause comes before the next link request, never after it
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
  f.nexus.neededChanged(f.needed)
  const link = acct.downloadLink
  acct.downloadLink = (archive, options) => { f.order.push(`link ${archive.id}`); return link(archive, options) }
  await f.nexus.open(null)
  await until('the run ends', () => directIdle(f))
  assert.deepEqual(f.order.filter(e => e.startsWith('link') || e === `sleep ${TIMES.linkPause}`),
    ['link 35407', 'sleep 1000', 'link 454617', 'sleep 1000', 'link 469854'])
  // With time passing as Nexus answers: a retry straight after a link that took 400 ms waits the other 600; a file that
  // took 2 seconds to come in already waited longer than the pause, so the next link goes at once
  const tacct = fakeAccount(), tf = fixture(t, { nexusAccount: tacct })
  timeAnswers(tacct, tf)
  tf.nexus.neededChanged(tf.needed)
  tacct.fail['35407'] = { file: [{ code: 'interrupted', message: 'The download was cut off. Try again.' }] }
  await tf.nexus.open(null)
  await until('the timed run ends', () => directIdle(tf))
  assert.deepEqual(linksAndSleeps(tf), ['link 35407', 'sleep 600', 'link 35407', 'link 454617', 'link 469854'],
    'the retry: link, a pause of the rest of the second, link; after each slow file, no pause')
  assert.deepEqual(tf.sleeps, [600])
  assert.deepEqual([tf.state('35407'), tf.state('454617'), tf.state('469854')], ['done', 'done', 'done'])
  // A new run soon after the last request waits only the rest of the second
  const g = fixture(t, { nexusAccount: fakeAccount(), archives: [SKYUI, TRUEHUD] })
  g.needed = [SKYUI.archive]
  await g.nexus.open(null)
  await until('the first run ends', () => directIdle(g))
  assert.deepEqual(g.sleeps, [], 'the first request of the launcher run has nothing to wait for')
  g.clock += 300
  g.needed = [TRUEHUD.archive]
  await g.nexus.open(null)
  await until('the second run ends', () => directIdle(g))
  assert.deepEqual(g.sleeps, [700], 'the rest of the second since the last request')
  g.clock += 5000
  g.needed = [XPMSSE.archive]
  await g.nexus.open(null)
  await until('the third run ends', () => directIdle(g))
  assert.deepEqual(g.sleeps, [700], 'long enough since the last request: no wait')
  assert.deepEqual([g.state('35407'), g.state('454617'), g.state('469854')], ['done', 'done', 'done'], 'all three runs downloaded their file')
  // Stop during the pause ends the run at once: nothing more is asked of Nexus
  const hacct = fakeAccount(), h = fixture(t, { nexusAccount: hacct })
  h.nexus.neededChanged(h.needed)
  const holding = deferred()
  // The pause never ends by itself here: only Stop can end it
  h.sleepImpl = ms => ms === TIMES.linkPause ? (holding.resolve(), new Promise(() => {})) : Promise.resolve()
  await h.nexus.open(null)
  await holding.promise
  assert.deepEqual(h.nexus.stopDirect(), { success: true, stopped: true })
  await until('the run ends', () => directIdle(h))
  assert.deepEqual([h.state('35407'), h.state('454617'), h.state('469854')], ['done', 'waiting', 'waiting'])
  assert.deepEqual(hacct.links, ['35407'], 'stopped in the pause: the next file was never asked for')
  assert.equal(h.main().direct.problem, null, 'Stop is not a problem to show')
})

test("the pause's own timer: Stop during the pause clears it at once", async t => {
  const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct, realSleep: true })
  f.nexus.neededChanged(f.needed)
  const before = f.timers.length
  await f.nexus.open(null)
  await until('the pause has started', () => f.timers.slice(before).some(x => x.ms === TIMES.linkPause))
  const pause = f.timers.slice(before).find(x => x.ms === TIMES.linkPause)
  assert.deepEqual([pause.fired, pause.cleared], [false, false])
  assert.deepEqual(f.nexus.stopDirect(), { success: true, stopped: true })
  await until('the run ends', () => directIdle(f))
  assert.equal(pause.cleared, true, 'no timer is left running after Stop')
  assert.deepEqual(acct.links, ['35407'])
  assert.equal(f.main().direct.problem, null)
})

test('a new run straight after one that ended on a limit, a Nexus failure or Stop still pauses before its first link', async t => {
  for (const ending of ['rateLimited', 'http503', 'stop']) {
    const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
    f.nexus.neededChanged(f.needed)
    const link = acct.downloadLink
    acct.downloadLink = (archive, options) => { f.order.push(`link ${archive.id}`); return link(archive, options) }
    if (ending === 'stop') {
      const holding = deferred()
      acct.gate = (_id, signal) => { holding.resolve(); return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) }
      await f.nexus.open(null)
      await holding.promise
      f.nexus.stopDirect()
      acct.gate = null
    } else {
      acct.fail['35407'] = { link: { code: ending, message: `said for ${ending}` } }
      await f.nexus.open(null)
    }
    await until('the first run ends', () => directIdle(f))
    assert.deepEqual(linksAndSleeps(f), ['link 35407'], ending)
    delete acct.fail['35407']
    f.clock += 200
    await f.nexus.open(null)
    await until('the second run ends', () => directIdle(f))
    assert.deepEqual(linksAndSleeps(f).slice(1, 3), ['sleep 800', 'link 35407'], `${ending}: the rest of the second before the new run's first link`)
  }
})

test("Nexus's limit on a later file: the files already in stay done, the rest wait, and the run says the limit", async t => {
  for (const where of ['link', 'file']) {
    const acct = fakeAccount(), f = fixture(t, { nexusAccount: acct })
    f.nexus.neededChanged(f.needed)
    const said = "Nexus's hourly limit on requests for your account is used up. Try again in 20 minutes, or use the Nexus window."
    acct.fail['454617'] = where === 'link' ? { link: { code: 'rateLimited', message: said } } : { file: [{ code: 'rateLimited', message: said }] }
    await f.nexus.open(null)
    await until('the run ends', () => directIdle(f))
    assert.deepEqual([f.state('35407'), f.state('454617'), f.state('469854')], ['done', 'waiting', 'waiting'], where)
    assert.deepEqual(acct.links, ['35407', '454617'], `${where}: nothing after the limit is asked for`)
    assert.deepEqual(f.main().direct.problem, { kind: 'rateLimited', message: said }, where)
    assert.deepEqual(f.files(), [named(SKYUI)], `${where}: the file already in is kept, and no part file stays`)
    assert.equal(f.allDownloaded, 0)
  }
})
