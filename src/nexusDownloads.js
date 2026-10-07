// The launcher's Nexus window: the server's mods downloaded from Nexus Mods with the player's own account, inside the
// launcher. Our strip page sits above the real Nexus page (a WebContentsView in its own hardened session); the player
// presses Nexus's own download button, the launcher takes the file, checks its size and MD5 against every download the
// copy still needs and keeps it in Dovakarn's Downloads folder under keepDownload's name, then moves on to the next.
// Nothing here scripts Nexus: the page is only ever read. Electron, the cross-launcher lock and the disk are reached only
// when the player opens the window or logs out of Nexus, so requiring this module or creating it touches nothing.
// Every Electron listener, timer and entry point runs through guarded(): a throw is logged and shown as a plain problem,
// never left to Electron's error box (main.js has no uncaughtException handler). A file being checked when the window
// closes is finished without touching the window; nothing the closed window started reloads or moves anything.
const fs = require('fs')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const modInstall = require('./modInstall')
const { nexusHeaders } = require('./nexusApp')
const { NEXUS_API } = require('./collectionCheck')

// userData\Partitions\nexus: never inside the Dovakarn folder. The packaged launcher encrypts its cookies on disk
// (package.json build.electronFuses.enableCookieEncryption); that fuse must never be switched off again
const PARTITION = 'persist:nexus'
const INCOMING = '.incoming'                  // <Downloads>\.incoming: DownloadFinder only reads the top level
const SETTINGS_URL = 'https://www.nexusmods.com/settings/content-blocking'
const TIMES = { noBox: 10000, noDom: 30000, poll: 1000, moveOn: 1200, closeAfter: 1500, justIn: 4000, push: 200, showFallback: 3000,
  facts: 3000, installPoll: 2000, stall: 60000, challenge: 45000, commits: 60000, renameRetry: 250, stopCap: 10000, linkPause: 1000 }
const LIMITS = { noBoxReads: 3, stepCommits: 5, renameTries: 20 }
const STRIP = { min: 96, start: 200, nexusMin: 320 }    // DIPs; the Nexus page always keeps at least nexusMin
// 1000 high where the screen has room (never more than its work area less 32): Nexus's download box sits below the
// file's details, and at 800 Slow download was under the window's bottom edge. The strip needs about 214-246 px at 900
// wide, so at 680 high the Nexus page keeps 434 px or more and the tallest strip fits without scrolling; 680 still fits a
// 1280x720 screen's work area
const WINDOW = { width: 1100, height: 1000, minWidth: 900, minHeight: 680 }
const ACTIONS = new Set(['login', 'logout', 'skip', 'browser', 'settings', 'back', 'retry', 'minimize', 'close'])
// The Nexus view: sandboxed, no Node, no preload, no native dialogs, and no File System Access pickers (FileSystemAccessLocal
// off removes showSaveFilePicker, showOpenFilePicker and showDirectoryPicker), so Nexus's large-file path never opens a
// native Save dialog
const VIEW_PREFS = { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: false,
  disableDialogs: true, backgroundThrottling: false, autoplayPolicy: 'document-user-activation-required', disableBlinkFeatures: 'FileSystemAccessLocal' }
const ADULT_QUERY = 'query($ids: [CompositeDomainWithIdInput!]!, $count: Int) { legacyModsByDomain(ids: $ids, count: $count) { nodes { modId adultContent } } }'
const TEXT = {
  setUpFirst: 'Set up Dovakarn first.',
  allDownloaded: 'Every mod is downloaded.',
  notNeeded: 'That mod is no longer needed. Press Check my downloads to refresh the list.',
  locked: 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Download again.',
  removing: 'Wait until Dovakarn is removed.',
  couldNotOpen: 'The Nexus window could not open. Press Download again. If it still does not open, tell the Dovakarn staff.',
  logoutBusy: 'Wait until the current download finishes, then press Log out of the Nexus window.',
  logoutFailed: 'The launcher could not log the Nexus window out. Try again.',
  logoutLocked: 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Log out of the Nexus window again.',
  directFailed: 'The automatic download stopped. Press Download them all to try again, or use the Nexus window.',
  windowWhileDirect: 'The mods are downloading by themselves. Wait for them to finish, or press Stop first.',
  stillFinishing: 'A download is still finishing. Press Download them all again in a moment.',
  lockedDirect: 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Download them all again.',
  directWhileWindow: 'The Nexus window is open. Close it, then press Download them all to download the mods by themselves.',
  someFailed: (n, names) => `${n === 1 ? `${names[0]} could not download by itself` : `${n} mods could not download by themselves`}. Press Download them all to try again, or use the Nexus window.`,
}
// What stops a whole automatic run (the rest would fail the same way), as against one file failing
const DIRECT_STOPS = new Set(['notPremium', 'nexusLoggedOut', 'nexusNotConfigured', 'rateLimited', 'nexusUnreachable', 'unreachable', 'noServer', 'insecureServer', 'locked',
  'renewFailed', 'save'])
// So does Nexus itself failing (any 5xx from its API or its login service): every other file would fail the same way
const stopsTheRun = error => DIRECT_STOPS.has(error?.code) || Number(error?.status) >= 500 || /^http5\d\d$/.test(String(error?.code || ''))
// What the last run said that a new Nexus login can make untrue: cleared when the account changes and can download again
const ACCOUNT_PROBLEMS = new Set(['notPremium', 'nexusLoggedOut', 'nexusNotConfigured'])
// One file failing in a way that may pass on a second try
const DIRECT_RETRY = new Set(['stalled', 'interrupted', 'fileFailed', 'noLink'])
const BACKGROUND = '#090e14'

const hostOf = url => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } }
const nexusHost = host => host === 'nexusmods.com' || host.endsWith('.nexusmods.com') || host.endsWith('.nexus-cdn.com')
// An https address on the default port: the only kind a page the step page itself starts may go to outside Nexus
const webAddress = url => { try { const u = new URL(url); return u.protocol === 'https:' && u.port === '' && !!u.hostname } catch { return false } }
const withoutHash = url => String(url || '').split('#')[0]
const hasNmm = url => { try { return new URL(url).searchParams.has('nmm') } catch { return false } }
// Whether an address names an archive (.7z, .zip, .rar): a file link, rather than a page someone linked to
const looksLikeFile = url => { try { return modInstall.ARCHIVE.test(new URL(url).pathname) } catch { return false } }
// Where the view's page is from, for the strip's words: Nexus's own site, Nexus's file server, or anywhere else
const siteOf = url => { const h = hostOf(url); return h.endsWith('.nexus-cdn.com') ? 'files' : nexusHost(h) ? 'nexus' : 'outside' }

// Every value a response header has, whatever the case of its name: [] when it has none. Electron gives a header sent
// twice as two values
function headerValues(headers, name) {
  if (!headers || typeof headers !== 'object') return []
  const values = []
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === name) for (const v of Array.isArray(value) ? value : [value]) values.push(String(v ?? ''))
  }
  return values
}
// The types a file download comes as. Only these count: a browser shows, or guesses at, anything else (unknown/unknown,
// application/unknown, */*, a bare "html", or an octet-stream sent beside text/html)
const FILE_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-7z-compressed', 'application/zip', 'application/x-zip-compressed',
  'application/x-zip', 'application/vnd.rar', 'application/x-rar-compressed', 'application/x-rar', 'application/x-compressed', 'application/x-download',
  'application/force-download'])
// The only answers that send the browser on to another address (300, 305 and 306 render their own body)
const REDIRECTS = new Set([301, 302, 303, 307, 308])
// What a browser makes of a response, by an allow-list: 'file' only when it is sent as exactly one attachment, or when
// every type it names (every Content-Type header, each split at commas, without its parameters) is a file type. Anything
// else is a 'page': no type, an empty one, one the list does not know, or a file type sent beside another type
function responseKind(headers) {
  const disposition = headerValues(headers, 'content-disposition')
  if (disposition.length === 1 && /^\s*attachment\b/i.test(disposition[0])) return 'file'
  const types = headerValues(headers, 'content-type').flatMap(value => value.split(',')).map(type => type.split(';')[0].trim().toLowerCase())
  return types.length && types.every(type => FILE_TYPES.has(type)) ? 'file' : 'page'
}
// Whether a main-frame response the Nexus view is about to show must be stopped first (ses.webRequest.onHeadersReceived):
// a page from anywhere but Nexus never shows, so a link the step page was let go to (guard) can only ever become a
// download. Nexus's own pages and files go on, and so does a redirect that names where it goes (its next stop is checked
// again). Details that cannot be read are from outside Nexus unless proven otherwise
function stopsAsPage(details) {
  try {
    if (!details || details.resourceType !== 'mainFrame') return false
    if (nexusHost(hostOf(details.url))) return false
    if (REDIRECTS.has(Number(details.statusCode)) && headerValues(details.responseHeaders, 'location').some(v => v.trim())) return false
    return responseKind(details.responseHeaders) === 'page'
  } catch {
    try { return details.resourceType === 'mainFrame' && !nexusHost(hostOf(details.url)) } catch { return true }
  }
}
// How a stopped page is answered: as if its server had sent 204 No Content, so the step page stays as it is, with no
// error page and no reload. The type stays: without it, a body that looked like a
// file became a download. Electron's HeadersReceivedResponse: { statusLine, responseHeaders }
const stoppedAnswer = () => ({ statusLine: 'HTTP/1.1 204 No Content', responseHeaders: { 'Content-Type': ['text/html'] } })
// What a page from outside Nexus that showed anyway may have left in the Nexus session: cleared for its own origin
const OUTSIDE_STORAGES = ['serviceworkers', 'cachestorage', 'localstorage', 'indexdb', 'cookies']
// A folder that names its drive or network share: never one that depends on where the launcher was started
const absolute = dir => typeof dir === 'string' && dir !== '' && (path.sep === '\\' ? /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(dir) : path.isAbsolute(dir))

// 'allow' | 'modManager' | 'block' for a main-frame navigation of the Nexus view and for every URL of a download's chain.
// blob:, data:, file:, http:, non-default ports: block (Nexus's blob: path is off: no File System Access in the view)
function navigationVerdict(url) {
  let u; try { u = new URL(url) } catch { return 'block' }
  if (u.protocol === 'nxm:') return 'modManager'
  if (u.protocol !== 'https:' || u.port !== '') return 'block'
  return nexusHost(u.hostname.toLowerCase()) ? 'allow' : 'block'
}
const stepUrl = archive => modInstall.nexusFileUrl(archive)   // .../skyrimspecialedition/mods/<modId>?tab=files&file_id=<fileId>
const signInUrl = archive => `https://users.nexusmods.com/auth/sign_in?redirect_url=${encodeURIComponent(stepUrl(archive))}`
const modPath = archive => `/${modInstall.NEXUS_GAME}/mods/${archive.modId}`
// Whether url is this archive's step page (any extra query such as nmm=1 still counts as the step page)
function isStepUrl(url, archive) {
  let u; try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && u.hostname === 'www.nexusmods.com' && u.pathname.replace(/\/+$/, '').toLowerCase() === modPath(archive)
    && u.searchParams.get('file_id') === String(archive.fileId)
}
// Off the step page: what kind of page the player is on
//   'signin'    users.nexusmods.com '/', '/auth/...' (log in, password, and any later login step such as 2FA)
//   'register'  users.nexusmods.com '/register...'
//   'premium'   users.nexusmods.com '/account/billing...' (the purple Fast download for a free account)
//   'settings'  www or next.nexusmods.com '/settings/content-blocking...'
//   'otherFile' this archive's mod on www, but not its step page (another file_id, the Files tab, the description)
//   'away'      anything else
function pageKind(url, archive = null) {
  let u; try { u = new URL(url) } catch { return 'away' }
  const h = u.hostname.toLowerCase(), p = u.pathname.toLowerCase().replace(/\/+$/, '')
  if (h === 'users.nexusmods.com') return p === '' || p === '/auth' || p.startsWith('/auth/') ? 'signin' : p.startsWith('/register') ? 'register' : p.startsWith('/account/billing') ? 'premium' : 'away'
  if ((h === 'www.nexusmods.com' || h === 'next.nexusmods.com') && p.startsWith('/settings/content-blocking')) return 'settings'
  if (h === 'www.nexusmods.com' && archive && p === modPath(archive)) return 'otherFile'
  return 'away'
}
// The pipe that makes one launcher at a time the user of the Nexus partition (one per launcher settings folder)
const lockName = userDataDir => `\\\\.\\pipe\\dovakarn-nexus-${crypto.createHash('sha1').update(path.resolve(String(userDataDir)).toLowerCase()).digest('hex').slice(0, 16)}`
// Takes the lock for the rest of this launcher's run: Chromium keeps the partition's cookie and storage files locked by
// the process that opened them, so a second launcher would get no lasting login. Windows frees the pipe when the process
// ends, even after a crash. Anyone connecting is hung up on at once. True when taken
function takeProcessLock(name, netModule = net) {
  if (process.platform !== 'win32') return Promise.resolve(true)
  return new Promise(resolve => {
    const server = netModule.createServer(socket => socket.destroy())
    server.once('error', () => resolve(false))
    server.listen(name, () => { server.unref(); resolve(true) })
  })
}

// The read-only page reader. It runs in the page's main world through view.webContents.mainFrame.executeJavaScript: the
// isolated world and webContents.executeJavaScript wait for the page to stop loading, which a Nexus page often never does
// while its third-party content loads. It reads, it never writes, it carries nothing secret, and its answer is untrusted data (readFacts)
const FACTS_SCRIPT = `(() => {
  const q = s => document.querySelector(s)
  const name = q('.user-profile-menu-username'), panel = q('mod-file-download')
  const notice = Array.prototype.map.call(document.querySelectorAll('div.info.warning.site-notice'), e => e.textContent || '').join(' ')
  return {
    href: String(location.href), title: String(document.title),
    user: name ? String(name.getAttribute('title') || name.textContent || '') : null,
    loginLink: !!q('a#login'),
    panel: panel ? { fileId: panel.getAttribute('file-id'), premium: panel.getAttribute('user-is-premium'),
      loggedIn: panel.getAttribute('user-is-logged-in'), nmm: panel.getAttribute('is-nmm-download') } : null,
    adultNotice: /adult content/i.test(notice),
    picker: typeof window.showSaveFilePicker !== 'undefined',
  }
})()`

// The page's answer is data, never trusted: strings capped and stripped of control characters
function readFacts(raw) {
  const str = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : null
  const r = raw && typeof raw === 'object' ? raw : {}, p = r.panel && typeof r.panel === 'object' ? r.panel : null
  return { href: str(r.href, 2048) || '', title: str(r.title, 300) || '', user: str(r.user, 64), loginLink: r.loginLink === true,
    panel: p ? { fileId: str(p.fileId, 20) || '', premium: p.premium === 'true', loggedIn: p.loggedIn === 'true', nmm: p.nmm === 'true' } : null,
    adultNotice: r.adultNotice === true, picker: r.picker === true }
}
// { login: 'in' | 'out', user } from what a page shows, or null when it says nothing (the Next.js pages, users.nexusmods.com)
function loginFrom(facts) {
  const user = facts.user
  if (user && user.toLowerCase() !== 'guest') return { login: 'in', user }
  if (facts.panel?.loggedIn) return { login: 'in', user: '' }
  if ((user && user.toLowerCase() === 'guest') || facts.loginLink) return { login: 'out', user: '' }
  return null
}

/**
 * Which of these Nexus mods Nexus marks as adult (keyless GraphQL, the endpoint collectionCheck.js uses). Never rejects:
 * a failure only means no adult hint. legacyModsByDomain answers 20 mods unless count is passed.
 */
async function fetchAdultFlags({ modIds, request, endpoint = NEXUS_API, log = () => {} }) {
  const ids = [...new Set((Array.isArray(modIds) ? modIds : []).filter(id => Number.isSafeInteger(id) && id > 0))], adult = new Set()
  for (let i = 0; i < ids.length; i += 100) {                          // up to 100 mods per request
    const chunk = ids.slice(i, i + 100)
    try {
      const body = JSON.stringify({ query: ADULT_QUERY, variables: { ids: chunk.map(modId => ({ gameDomain: modInstall.NEXUS_GAME, modId })), count: chunk.length } })
      const response = await request(endpoint, { method: 'POST', body, maxBytes: 1024 * 1024, timeout: 15000,
        headers: nexusHeaders({ 'Content-Type': 'application/json' }) })
      const nodes = JSON.parse(response.body.toString('utf8'))?.data?.legacyModsByDomain?.nodes
      if (!Array.isArray(nodes)) throw new Error('Nexus answered in an unexpected format')
      for (const n of nodes) if (n && n.adultContent === true && chunk.includes(n.modId)) adult.add(n.modId)
    } catch (error) { log(`[nexus] could not ask Nexus which mods are adult: ${error.message}`) }
  }
  return adult
}

/**
 * Every mod downloaded: the usual check installs them once the launcher is idle. A check that answers BUSY (one started
 * between idle() and check()) is retried, a few times at most; a check that ran meanwhile and installed them ends it.
 * alive(): false once the launcher window is gone or the launcher is quitting: no 7-Zip work starts then.
 */
function createInstallTrigger({ idle, needed, check, alive = () => true, onChange = () => {}, log = () => {}, wait = ms => new Promise(r => setTimeout(r, ms)), pollMs = TIMES.installPoll, tries = 5 }) {
  let queued = false, running = false
  async function run() {
    try {
      for (let attempt = 0; attempt < tries; attempt++) {
        for (;;) {
          if (!alive()) { log('[nexus] the launcher is closing: the mods install at its next start'); return }
          if (await idle()) break
          await wait(pollMs)
        }
        // A check that ran meanwhile (Verify, the startup check) already installed them
        const left = needed()
        if (!left || !left.length) { log('[nexus] the mods were already installed by another check'); return }
        running = true; onChange()
        const result = await check()
        running = false; onChange()
        if (result?.code !== 'BUSY') return
        await wait(pollMs)
      }
      log('[nexus] the launcher stayed busy, so the mods were not installed now; Install the mods or the next check installs them')
    } finally { queued = false; running = false; onChange() }
  }
  return {
    request() { if (queued) return false; queued = true; onChange(); run().catch(error => log(`[nexus] installing the mods failed: ${error.message}`)); return true },
    state: () => ({ queued, running }),
  }
}

/**
 * electron(): { app, BrowserWindow, WebContentsView, session, screen }, called only inside create() and logout(). setup:
 * gameSetup (neededArchives, downloadsDir, openMod). request: fileCheck.get-like, for the adult flags. notifyMain(snapshot):
 * the launcher page's view of each download. onAllDownloaded(): this window brought in the last one (once per set).
 * nexusUser: { get, set } of the Nexus name the window last saw, kept in the launcher's store ('' = none). nexusLogin:
 * { get, set } of whether the window was last seen logged in to Nexus ('in', 'out', or 'unknown' while the player may be
 * logging in or out), kept beside the name, since Nexus does not always show a name. sessionKept(): whether the Nexus
 * partition has anything kept on this PC (its folder under userData). userDataDir names the cross-launcher lock.
 * removing(): Dovakarn's folder is being removed (main.js, from the player's Remove press to the folder gone, its confirm
 * dialog included): the window does not open, no install is asked for, and the launcher page is told, so the window
 * closing for it starts no check. removeAsking(): only the confirm dialog is open so far (the page keeps its words then).
 * lock, hash, rename and sleep are the real ones unless a test passes stand-ins. nexusAccount (nexusAccount.js): the
 * player's Nexus account; while it is logged in with Nexus Premium, a Download press downloads the mods through Nexus's
 * API by themselves (direct), with the same list, checks, Downloads folder and install as the window, and no window.
 */
function createNexusDownloads({
  electron, parentWindow, setup, request, notifyMain = () => {}, onAllDownloaded = () => {}, nexusAccount = null,
  installState = () => ({ queued: false, running: false }), removing = () => false, removeAsking = () => false,
  nexusUser = { get: () => '', set: () => {} }, nexusLogin = { get: () => 'unknown', set: () => {} }, userDataDir = '',
  sessionKept = () => !!userDataDir && fs.existsSync(path.join(userDataDir, 'Partitions', String(PARTITION).replace(/^persist:/, ''))),
  pagePath, preloadPath, icon, dev = false, log = () => {},
  partition = PARTITION,
  lock = takeProcessLock, hash = modInstall.hashFile, rename = fs.renameSync,
  setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  // A wait; a signal that aborts ends it at once and clears its timer
  sleep = (ms, signal) => new Promise(resolve => {
    if (signal?.aborted) return resolve()
    let timer = null
    const end = () => { clearTimer(timer); signal?.removeEventListener('abort', end); resolve() }
    timer = setTimer(end, ms)
    signal?.addEventListener('abort', end, { once: true })
  }),
}) {
  // One entry per needed archive this launcher run has seen, in the server's order (sorted by name)
  // Entry = { archive, state: 'waiting'|'downloading'|'checking'|'done'|'wrong'|'failed', percent, received, total, file, via,
  //   dropped: a check found it elsewhere while this window was getting it (neededChanged) }
  const entries = new Map(), order = []
  let current = null                       // archive id the view shows
  let win = null, view = null, ses = null
  let locked = false                       // this launcher holds the partition lock (kept until it exits)
  let locking = null                       // the lock being asked for: open() and logout() share one ask
  let sessionReady = false, appReady = false, stripSessionReady = false   // handlers registered once per process
  const cleanedDirs = new Set()            // Downloads folders whose .incoming was emptied this run (once, before first use)
  let opening = null                       // the create() in progress, so two quick presses make one window
  let holding = false                      // Remove is running: nothing starts
  let gen = 0                              // the window's generation: a timer from a window that has closed never runs
  let stripIsReady = false, readyToShow = false
  let reportedDip = STRIP.start, stripDip = STRIP.start, room = 480, zoom = 1
  let viewUrl = '', onStep = false, expectedUrl = '', navSerial = 0, nmmRetried = false, bounced = false
  // 'opening'|'challenge'|'stuck'|'ready'|'nobox'|'nmm'|'offline'|'down'|'crashed'|'signin'|'register'|'premium'|
  // 'settings'|'otherFile'|'away'
  let pageStep = 'opening'
  let noBoxSince = 0, emptyReads = 0, domReady = false, stepCommits = []
  let login = 'unknown', user = '', premium = false
  // { kind, id } kinds: 'different'|'damaged'|'interrupted'|'save'|'move'|'oneAtATime'|'modManager'|'elsewhere'|
  // 'linkFailed'|'inBrowser'|'error'
  let problem = null
  let flight = null                        // the download in progress: its record (onWillDownload)
  const pending = new Set()                // records whose finish() has not settled yet (stopWhile waits for them)
  let justIn = null, moving = false        // id of the archive that just finished; moving: showing it before the next page
  let allDone = false, allIn = false       // allDone: this window got the last one; allIn: a check found them all
  let installAsked = false                 // onAllDownloaded was called for the current set (once)
  // This window brought a mod in since the last check: that check could not install it, so when the last one is in
  // (however that happens) the install is asked for
  let brought = false
  let installDeferred = false              // the install was due while Dovakarn was being removed: asked if it is not
  // The last page from outside Nexus stopped before it showed, and when: a script that keeps sending the step page there
  // is logged once a minute, not every time
  let lastStoppedLog = { url: '', at: 0 }
  const adultIds = new Set(), askedAdult = new Set()
  const timers = { poll: null, noDom: null, moveOn: null, justIn: null, close: null, show: null, push: null, stall: null, challenge: null }
  let serial = 0, pushWaiting = false, lastStopped = { url: '', serial: -1, at: 0 }
  let parentClosed = null                  // the listener on the launcher window, removed when this window closes
  // Addresses outside Nexus the step page itself was let go to (Slow download's file link: it may point at a file host
  // outside nexusmods.com, so none is hard-coded here), each with when: they may download, and one that shows as a page instead is a
  // failed file link. Kept a minute, 50 at most
  const letThrough = new Map()
  // The automatic download through Nexus's API (Premium): { abort, done } while it runs. directProblem: what the last run
  // could not do, for the launcher page ({ kind, message }), until the next run starts
  let direct = null, directProblem = null
  // When the last download link was asked of Nexus's API (this launcher run): every request, in a run or the next one,
  // comes at least TIMES.linkPause after the one before
  let lastLinkAt = -Infinity
  // A wait that Stop (the run's signal) ends at once
  const pauseFor = (ms, signal) => new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => { signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
    Promise.resolve(sleep(ms, signal)).then(done, done)
  })
  const premiumReady = () => { try { const s = nexusAccount?.status(); return !!(s && s.loggedIn && s.account && s.account.premium) } catch { return false } }

  const isOpen = () => !!win && !win.isDestroyed()
  const viewAlive = () => isOpen() && !!view && !view.webContents.isDestroyed()
  const currentEntry = () => (current && entries.get(current)) || null
  const openEntries = () => order.map(id => entries.get(id)).filter(e => e.state !== 'done')
  const anyChecking = () => order.some(id => entries.get(id).state === 'checking')
  const sizeOf = f => { try { return fs.statSync(f).size } catch { return -1 } }
  const isStripSender = sender => isOpen() && sender === win.webContents
  const pick = a => ({ name: a.name, version: a.version, size: a.size })
  const knownUser = () => { try { const v = nexusUser.get(); return typeof v === 'string' ? v.slice(0, 64) : '' } catch { return '' } }
  // Logged in as the launcher last saw it: 'in', 'out' or 'unknown'. A name kept from before the flag existed means in
  const knownLogin = () => {
    let v = 'unknown'
    try { v = nexusLogin.get() } catch { /* unreadable: unknown */ }
    return v === 'in' || v === 'out' ? v : knownUser() ? 'in' : 'unknown'
  }
  const isKept = () => { try { return sessionKept() === true } catch { return false } }
  // What the launcher keeps about the Nexus login: the name and whether logged in, the page told when either changes
  function remember(name, state) {
    const was = [knownUser(), knownLogin()]
    try { if (name !== was[0]) nexusUser.set(name) } catch (error) { log(`[nexus] the Nexus name was not kept: ${error.message}`) }
    try { if (state !== was[1]) nexusLogin.set(state) } catch (error) { log(`[nexus] the Nexus login was not kept: ${error.message}`) }
    if (name !== was[0] || state !== was[1]) pushMain()
  }
  // Never pulls the player off a login, sign-up or settings page they are working on
  const mayMove = () => onStep || !['signin', 'register', 'settings'].includes(pageStep)
  // Dovakarn's folder is being removed: main's whole Remove, or this module's part of it (stopWhile)
  const isRemoving = () => { if (holding) return true; try { return removing() === true } catch { return false } }
  // Only Remove's confirm dialog is open so far: nothing starts, but the page keeps its words until the player confirms
  const isAsking = () => { if (holding) return false; try { return removeAsking() === true } catch { return false } }
  function letGo(url) {
    const at = now()
    for (const [u, when] of letThrough) if (at - when > TIMES.stall) letThrough.delete(u)
    letThrough.delete(url); letThrough.set(url, at)
    while (letThrough.size > 50) letThrough.delete(letThrough.keys().next().value)
  }
  const wasLetGo = url => letThrough.has(url) && now() - letThrough.get(url) <= TIMES.stall
  // A page from outside Nexus stopped before it showed (answered as 204 No Content, so the step page stays and nothing
  // reloads): said, and logged once a minute however often a script on the page sends it there
  function stoppedPage(details) {
    const url = withoutHash(details.url), at = now()
    if (url !== lastStoppedLog.url || at - lastStoppedLog.at > TIMES.stall) {
      lastStoppedLog = { url, at }
      const type = headerValues(details.responseHeaders, 'content-type').flatMap(v => v.split(',')).map(v => v.split(';')[0].trim()).filter(Boolean).join(', ') || 'no type'
      log(`[nexus] stopped ${hostOf(url) || 'a page'} before it showed: a page (${type}, ${Number(details.statusCode) || 'no status'}), not a file`)
    }
    const fromView = viewAlive() && (details.webContentsId === undefined || details.webContentsId === view.webContents.id)
    if (fromView && current) setProblem(looksLikeFile(url) ? 'linkFailed' : 'elsewhere', current)
  }
  // A page from outside Nexus showed anyway (a service worker it registered can answer without the network, so no
  // onHeadersReceived sees it): whatever it kept in the Nexus session is cleared for its origin
  function forgetOrigin(url) {
    let origin = 'null'
    try { origin = new URL(url).origin } catch { /* not an address */ }
    if (origin === 'null' || !ses) return
    Promise.resolve().then(() => ses.clearStorageData({ origin, storages: OUTSIDE_STORAGES }))
      .then(() => log(`[nexus] cleared what ${hostOf(url)} kept in the Nexus window`), error => log(`[nexus] could not clear what ${hostOf(url)} kept: ${error?.message || error}`))
  }
  // A main-frame navigation the Nexus page itself started (its own main frame, on a Nexus address), not an ad's frame
  function fromNexusPage(details) {
    try { const i = details.initiator; return !!i && i.parent === null && typeof i.url === 'string' && navigationVerdict(i.url) === 'allow' } catch { return false }
  }

  // Every Electron listener, IPC action and timer goes through it: an error is logged, shown as a plain problem while the
  // window is open, and the fallback answered; never thrown into Electron
  function guarded(name, fn, fallback) {
    return (...args) => {
      const failed = error => {
        log(`[nexus] ${name}: ${error?.message || error}`)
        try { if (isOpen() && current && entries.has(current)) { problem = { kind: 'error', id: current }; pushAll() } } catch { /* nothing more to say */ }
        return typeof fallback === 'function' ? fallback(...args) : fallback
      }
      try { const r = fn(...args); return r && typeof r.then === 'function' ? r.catch(failed) : r } catch (error) { return failed(error) }
    }
  }
  // A window timer: replaces the one of that name, and never runs for a window that has closed since
  function startTimer(key, fn, ms) {
    stopTimer(key)
    const g = gen
    timers[key] = setTimer(guarded(`timer ${key}`, () => { timers[key] = null; if (g === gen) return fn() }), ms)
  }
  function stopTimer(key) { if (timers[key]) clearTimer(timers[key]); timers[key] = null }
  const stopAllTimers = () => Object.keys(timers).forEach(stopTimer)
  function setProblem(kind, id) { if (!id || !entries.has(id)) return; problem = { kind, id }; pushAll() }

  // The first open archive after fromId (from the start when null), wrapping round; null when none
  function nextOpen(fromId) {
    const start = fromId === null ? -1 : order.indexOf(fromId)
    for (let i = 1; i <= order.length; i++) { const id = order[(start + i + order.length) % order.length]; if (entries.get(id).state !== 'done') return id }
    return null
  }

  // What the strip's instruction line follows, first match wins
  function step() {
    if (allDone) return 'allDone'
    if (allIn) return 'allIn'
    if (flight) return 'downloading'
    if (anyChecking()) return 'checking'
    if (moving) return 'moving'
    if (problem && problem.kind !== 'oneAtATime') return 'problem'
    return pageStep
  }
  function stripState() {
    const cur = currentEntry(), p = flight ? entries.get(flight.id) : order.map(id => entries.get(id)).find(x => x.state === 'checking')
    return {
      count: cur ? { position: order.indexOf(current) + 1, total: order.length, left: openEntries().length } : null,
      mod: cur ? pick(cur.archive) : null,
      login, user: login === 'in' ? user : '', premium,
      step: step(),
      offStep: !onStep && pageStep !== 'opening',                     // the player is on another page: Back to the mod
      // Where the page on screen is from, so the strip never calls a page outside Nexus a Nexus page
      site: siteOf(viewUrl),
      busy: !!flight || anyChecking(),                                // hides Log out of Nexus
      // other: the problem is with a mod that is not the one on screen (the window comes back to it after the others)
      problem: problem ? { kind: problem.kind, mod: pick((entries.get(problem.id) || cur).archive), other: !!cur && problem.id !== current && entries.has(problem.id) } : null,
      progress: p ? { percent: p.percent, received: p.received, mod: pick(p.archive) } : null,
      adult: !!cur && adultIds.has(cur.archive.modId),
      justIn: justIn && entries.has(justIn) ? pick(entries.get(justIn).archive) : null,
      room: Math.floor(room / zoom),                                  // CSS px the strip may use
    }
  }
  function snapshot() {
    const install = installState() || {}, asking = isAsking()
    // removeAsking: Remove's confirm dialog is open (nothing starts, the page keeps its words); removing: confirmed, the
    // folder is going. account: the Nexus login the launcher keeps (login 'in' with or without a name, 'out' or
    // 'unknown'; kept: the Nexus partition has something on this PC, so Log out of Nexus has something to forget)
    // direct: the automatic download through Nexus's API is running, and what its last run could not do; premium: a Download
    // press downloads by itself (the player's Nexus account is logged in with Premium)
    return { open: isOpen(), installQueued: install.queued === true, installing: install.running === true, removing: isRemoving() && !asking, removeAsking: asking, current,
      account: { user: knownUser(), login: knownLogin(), kept: isKept() },
      direct: { running: !!direct, problem: problemNow() }, premium: premiumReady(),
      archives: Object.fromEntries(order.map(id => [id, { state: entries.get(id).state, percent: entries.get(id).percent }])) }
  }
  function pushStrip() { if (stripIsReady && isOpen()) { try { win.webContents.send('nexus:strip', stripState()) } catch (error) { log(`[nexus] the strip was not told: ${error.message}`) } } }
  function pushMain() { try { notifyMain(snapshot()) } catch (error) { log(`[nexus] the launcher page was not told: ${error.message}`) } }
  function pushAll() { pushStrip(); pushMain() }
  // Only byte progress is throttled; state changes push at once
  function pushThrottled() {
    if (timers.push) { pushWaiting = true; return }
    pushAll()
    startTimer('push', () => { if (pushWaiting) { pushWaiting = false; pushAll() } }, TIMES.push)
  }

  // The queue from gameSetup's last check (onNeededMods), with what this window already finished kept. A download the
  // check found elsewhere while this window was still getting it is "dropped": it counts as done once that download
  // ends, however it ends (finish), so a failed or wrong copy of a mod nobody needs any more never holds the window open
  function neededChanged(list) {
    const needed = Array.isArray(list) ? list : [], ids = new Set(needed.map(a => a.id))
    for (const a of needed) {
      const e = entries.get(a.id)
      if (!e) { entries.set(a.id, { archive: a, state: 'waiting', percent: null, received: 0, total: 0, file: null, via: null, dropped: false }); order.push(a.id); continue }
      e.archive = a; e.dropped = false
      // a file this window kept is still there (a check that ran while it was moved missed it): it stays done
      if (e.state === 'done' && !(e.file && sizeOf(e.file) === a.size)) Object.assign(e, { state: 'waiting', file: null, via: null })
    }
    // A check ran, and installs the mods itself when nothing is missing. A file this window kept that the check still
    // lists as needed (it looked before the file came in) was missed by it: that check installs nothing, so this window
    // still counts as having brought a mod in, and asks for the install once the last one is in
    brought = needed.some(a => { const e = entries.get(a.id); return e?.state === 'done' && (e.via === 'window' || e.via === 'nexusApi') })
    for (const [id, e] of entries) {
      if (ids.has(id) || e.state === 'done') continue
      if (e.state === 'downloading' || e.state === 'checking') e.dropped = true
      else Object.assign(e, { state: 'done', via: 'found', percent: null })
    }
    if (openEntries().length) installAsked = false
    followFound()
    pushAll()
  }
  // After downloads were found elsewhere: the page moves on from a mod no longer needed (when the page may not follow,
  // current still moves: the strip names the new mod and Back to the mod goes to it), and with none left the window says
  // so and closes. The check that found them installs them, unless this window brought one in after that check ran: then
  // that check could not, so this counts as every mod downloaded here and the install is asked for
  function followFound() {
    const cur = currentEntry()
    if (cur && cur.state === 'done') { const n = nextOpen(current); if (n !== current) { current = n; if (n && viewAlive() && mayMove()) navigate({ auto: true }) } }
    if (allDone || allIn || openEntries().length) return
    if (brought) return everyModIn()
    if (isOpen()) { allIn = true; startTimer('close', () => close(), TIMES.closeAfter) }
  }

  // The strip reports its height in CSS px; the view takes DIPs and always keeps STRIP.nexusMin of the window. The strip
  // gets room back and scrolls inside it rather than going under the Nexus page
  function layout() {
    if (!isOpen() || !view) return
    const [w, h] = win.getContentSize()
    const nextRoom = Math.max(STRIP.min, h - STRIP.nexusMin), next = Math.min(nextRoom, Math.max(STRIP.min, reportedDip))
    view.setBounds({ x: 0, y: next, width: Math.max(0, w), height: Math.max(0, h - next) })
    if (next !== stripDip || nextRoom !== room) { stripDip = next; room = nextRoom; pushStrip() }
  }
  function maybeShow() {
    if (isOpen() && readyToShow && stripIsReady && !win.isVisible()) { win.show(); win.focus() }
  }

  // The only way the launcher points the view at a mod. auto: a move the player did not press (a finished download, a
  // check, the mod-manager page, a problem off the step page), never made while Cloudflare keeps the window stuck
  function navigate({ keepProblem = false, auto = false } = {}) {
    if (!keepProblem) problem = null
    const cur = currentEntry()
    if (!viewAlive() || !cur) return pushAll()
    if (auto && pageStep === 'stuck') return pushAll()
    if (!auto) { stopTimer('challenge'); stepCommits = [] }
    stopTimer('poll'); stopTimer('noDom'); stopTimer('moveOn')
    const url = stepUrl(cur.archive)
    if (url !== expectedUrl) stepCommits = []
    expectedUrl = url; pageStep = 'opening'; onStep = false; navSerial++
    view.webContents.loadURL(url).catch(() => {})
    pushAll()
  }
  // The player's own press: a page outside Nexus may be left again
  function pressNavigate() { bounced = false; navigate() }

  // The launcher's own blank page, shown instead of a page from outside Nexus when there is no mod to go back to
  function blank() { if (viewAlive()) view.webContents.loadURL('about:blank').catch(() => {}) }
  // A committed main-frame page (did-navigate). Nothing outside Nexus may stay on screen: onHeadersReceived stops such a
  // page before it shows, and anything that still commits (a service worker's answer, history steps) lands here: what it
  // kept in the Nexus session is cleared and the view goes back to the mod. That move is not the player's press, so a
  // script that keeps sending the step page outside counts toward the reload limit (stuck); once stuck, the view shows a
  // blank page rather than the outside one. Said as a failed file link when its address named an archive, else as a link
  // that leads outside Nexus. Nexus's own file server shown as a page is a failed file link too; that one goes back once
  // per press of ours, so a link the player keeps pressing never sends the view back and forth
  function committed(url, httpCode) {
    navSerial++; viewUrl = String(url || ''); domReady = false; nmmRetried = nmmRetried && hasNmm(viewUrl)
    stopTimer('poll'); stopTimer('noDom'); emptyReads = 0
    const cur = currentEntry(), host = hostOf(viewUrl)
    if (viewUrl === 'about:blank') { onStep = false; if (pageStep !== 'stuck') pageStep = 'away'; return pushAll() }   // our own
    if (navigationVerdict(viewUrl) !== 'allow') {
      log(`[nexus] a page from ${host || 'outside Nexus'} showed: back to the mod`)
      onStep = false
      forgetOrigin(viewUrl)
      // No mod to go back to (the window is closing with every mod in): a blank page instead, never the outside one
      if (!cur) { blank(); pageStep = 'away'; return pushAll() }
      if (pageStep === 'stuck') { problem = null; blank(); return pushAll() }
      problem = { kind: looksLikeFile(viewUrl) ? 'linkFailed' : 'elsewhere', id: current }
      return navigate({ keepProblem: true, auto: true })
    }
    if (host.endsWith('.nexus-cdn.com')) {
      log(`[nexus] Nexus's file server ${host} showed a page: back to the mod`)
      onStep = false
      if (bounced) { pageStep = 'away'; return pushAll() }
      bounced = true
      if (cur) setProblem('linkFailed', current)
      return navigate({ keepProblem: true })
    }
    onStep = !!cur && isStepUrl(viewUrl, cur.archive)
    if (withoutHash(viewUrl) !== withoutHash(expectedUrl)) problem = null    // the player went somewhere themselves
    // A login or sign-up page: what the launcher kept about the login may change there, so until a Nexus page says,
    // Settings keeps Log out of Nexus within reach (logged in and closed before Nexus brought the player back)
    if (!onStep && ['signin', 'register'].includes(pageKind(viewUrl, cur?.archive)) && knownLogin() === 'out') remember('', 'unknown')
    if (onStep) {
      stepCommits = stepCommits.filter(at => now() - at < TIMES.commits).concat(now())
      // Loaded again and again within a minute (Cloudflare, or a script that keeps sending it away): nothing reloads it by
      // itself any more, and the strip says so rather than an older problem
      if (stepCommits.length > LIMITS.stepCommits) { pageStep = 'stuck'; problem = null; log('[nexus] the step page keeps reloading'); return pushAll() }
      pageStep = Number(httpCode) >= 500 ? 'down' : ['challenge', 'stuck'].includes(pageStep) ? pageStep : 'opening'
      if (pageStep === 'down') log(`[nexus] Nexus answered the step page with ${Number(httpCode)}`)
      if (pageStep === 'opening') startTimer('noDom', () => { if (onStep && !domReady) { pageStep = 'nobox'; log('[nexus] the step page never got its document'); pushAll() } }, TIMES.noDom)
    } else pageStep = pageKind(viewUrl, cur?.archive)
    pushAll()
  }

  // undefined: stale (the page or the mod changed meanwhile), drop it; null: no answer (slow, gone), try again; else facts
  async function readPage() {
    if (!viewAlive()) return undefined
    const serial = navSerial, id = current
    let raw, slow = null
    try {
      raw = await Promise.race([view.webContents.mainFrame.executeJavaScript(FACTS_SCRIPT),
        new Promise((_r, reject) => { slow = setTimer(() => reject(new Error('slow')), TIMES.facts) })])
    } catch { return viewAlive() && serial === navSerial && id === current ? null : undefined } finally { if (slow) clearTimer(slow) }
    if (!viewAlive() || serial !== navSerial || id !== current) return undefined
    const facts = readFacts(raw)
    if (!facts.href) return null
    if (withoutHash(facts.href) !== withoutHash(viewUrl)) return undefined
    if (facts.picker) log('[nexus] this page could open a Save dialog: File System Access is on')   // never expected
    const who = loginFrom(facts)
    if (who) {
      login = who.login; user = who.login === 'in' ? (who.user || user) : ''
      if (who.login === 'out') premium = false
      // Logged in with or without a name: Settings offers Log out of Nexus either way
      remember(who.login === 'in' ? (who.user || knownUser()) : '', who.login)
    }
    return facts
  }
  // The step page, read from dom-ready, then every second until the box is there. A read with no answer never counts
  // toward "no box": that needs three answers without it and ten seconds
  async function readStep() {
    if (!onStep) return
    const facts = await readPage()
    if (facts === undefined || !onStep) return
    if (facts === null) { startTimer('poll', readStep, TIMES.poll); return }
    if (applyStep(facts) === 'wait') {
      emptyReads++
      if (emptyReads >= LIMITS.noBoxReads && now() - noBoxSince >= TIMES.noBox) { pageStep = 'nobox'; log('[nexus] no download box on the step page after ten seconds') }
      else startTimer('poll', readStep, TIMES.poll)
    }
    pushAll()
  }
  // The step page as read: a Cloudflare check, the download box for this file, another file's box, or none yet
  function applyStep(facts) {
    if (/^just a moment/i.test(facts.title)) { enterChallenge(); return 'done' }
    stopTimer('challenge')
    if (pageStep === 'challenge') pageStep = 'opening'                // passed: the real page is loading
    const p = facts.panel, cur = currentEntry()
    if (!p || !cur) return 'wait'
    if (p.nmm) {
      // The mod-manager variant (a Files tab "Mod manager download" lands here with nmm=1): back to the plain step page
      // once, saying why. If Nexus shows it on the plain page too, say so instead of reloading in a loop
      if (hasNmm(viewUrl) && !nmmRetried) { nmmRetried = true; setProblem('modManager', current); navigate({ keepProblem: true, auto: true }); return 'done' }
      pageStep = 'nmm'; return 'done'
    }
    if (p.fileId !== String(cur.archive.fileId)) { pageStep = 'nobox'; return 'done' }
    premium = p.premium
    pageStep = 'ready'                     // the strip words it by login: in, out or unknown
    return 'done'
  }
  function enterChallenge() {
    if (pageStep !== 'stuck') pageStep = 'challenge'
    stopTimer('poll')
    if (!timers.challenge && pageStep === 'challenge') startTimer('challenge', () => { if (pageStep === 'challenge') { pageStep = 'stuck'; log('[nexus] the Cloudflare check did not pass'); pushAll() } }, TIMES.challenge)
    pushAll()
  }

  // Main-frame navigations stay on Nexus; nxm: links are for mod managers. Slow download sends the page itself to the
  // file's address, on a file host: a navigation the step page's own main frame starts
  // goes ahead to any https address, so the download can begin (the item must still come from this view, and its size
  // and MD5 still decide). It can only ever become a download: if its answer is a page, onHeadersReceived stops it
  // before it shows (and committed() sends back anything that still commits). Ads start theirs from their own frames
  // (initiator.parent is not null): those are stopped, and stay silent
  function guard(details, kind) {
    if (!details || !details.isMainFrame) return                     // subframes (ads) are not ours to police
    const verdict = navigationVerdict(details.url)
    if (verdict === 'allow') return
    if (verdict === 'block' && onStep && webAddress(details.url) && fromNexusPage(details)) {
      if (!wasLetGo(details.url)) log(`[nexus] the step page went to ${hostOf(details.url)} (${kind}): let through, in case it is the file`)
      letGo(details.url)
      return
    }
    details.preventDefault()
    // will-frame-navigate and will-navigate both fire for one main-frame navigation: say it once
    if (lastStopped.url === details.url && lastStopped.serial === navSerial && now() - lastStopped.at < 1000) return
    lastStopped = { url: details.url, serial: navSerial, at: now() }
    if (verdict === 'modManager') { setProblem('modManager', current); if (!onStep) navigate({ keepProblem: true, auto: true }); return }
    const host = hostOf(details.url) || 'a link that is not a web page'
    let fromPage = true
    try { const i = details.initiator; fromPage = !i || i.parent === null } catch { fromPage = true }
    if (onStep && fromPage) { setProblem('elsewhere', current); log(`[nexus] stopped ${host} from the step page (${kind})`) }
    else log(`[nexus] stopped a page outside Nexus: ${host}`)
  }

  function onWillDownload(event, item, contents) {
    const refuse = (note, kind) => { event.preventDefault(); if (kind) setProblem(kind, current); if (note) log(`[nexus] ${note}`); pushAll() }
    try {
      if (!viewAlive() || contents !== view.webContents) return refuse('refused a download from outside the Nexus window')
      // Remove confirmed (stopWhile): nothing new lands in the folder about to go. While its dialog is still open a
      // download goes on as usual: stopWhile stops it if the player confirms
      if (holding) return refuse('refused a download while Dovakarn is being removed')
      const chain = item.getURLChain(), url = chain.at(-1) || item.getURL()
      // Every address on the way is Nexus's, or one the step page itself was let go to (guard)
      const known = u => navigationVerdict(u) === 'allow' || (webAddress(u) && wasLetGo(u))
      if (![item.getURL(), ...chain].every(known)) return refuse(`refused a download from ${hostOf(url) || 'a non-web link'}`, 'elsewhere')
      const hosts = [...new Set([item.getURL(), ...chain].map(hostOf).filter(Boolean))].join(', then ')
      const filename = String(item.getFilename() || '').replace(/[\u0000-\u001f]/g, '').slice(0, 200), total = item.getTotalBytes()
      if (flight) return refuse(null, 'oneAtATime')
      const dir = setup.downloadsDir()
      if (!absolute(dir)) return refuse('no Downloads folder', 'save')
      const wanted = openEntries(), free = wanted.filter(e => e.state !== 'checking')
      let target
      if (total > 0) {
        if (!wanted.some(e => e.archive.size === total)) {
          const c = currentEntry(); if (c && c.state !== 'done' && c.state !== 'checking') c.state = 'wrong'
          log(`[nexus] stopped ${filename} (${total} bytes): needed sizes are ${wanted.map(e => e.archive.size).join(', ')}`)
          refuse(null, 'different')
          if (!onStep) navigate({ keepProblem: true, auto: true })        // "the box below" must be the right one
          return
        }
        target = free.find(e => e.archive.size === total && e.archive.id === current) || free.find(e => e.archive.size === total)
        if (!target) return refuse(null, 'oneAtATime')                    // the same file is still being checked
      } else target = free.find(e => e.archive.id === current) || free[0]   // size unknown: shown against the current mod
      if (!target) return refuse('nothing left to get')
      const incoming = path.join(dir, INCOMING)
      fs.mkdirSync(incoming, { recursive: true })
      const savePath = path.join(incoming, `${now()}-${++serial}.download`)
      item.setSavePath(savePath)                                   // never a Save dialog
      const f = { item, id: target.archive.id, savePath, dir: path.resolve(dir), filename, resumed: false, endAs: null,
        limit: total > 0 ? total : Math.max(...wanted.map(e => e.archive.size)) }
      f.settled = new Promise(resolve => { f.resolveSettled = resolve })
      flight = f; pending.add(f)
      Object.assign(target, { state: 'downloading', percent: total > 0 ? 0 : null, received: 0, total })
      problem = null
      item.on('updated', guarded('download progress', (_e, state) => onUpdated(f, state)))
      item.once('done', guarded('download end', (_e, state) => finish(f, state)))
      startTimer('stall', () => endFlight(f, 'interrupted', 'no bytes for a minute'), TIMES.stall)
      // Every accepted download names its hosts, so the log shows which hosts served each file
      log(`[nexus] download started: ${filename} (${total || 'unknown'} bytes) from ${hosts}`)
      pushAll()
    } catch (error) { try { event.preventDefault() } catch { /* gone */ } setProblem('save', current); log(`[nexus] a download was stopped: ${error.message}`); pushAll() }
  }
  function onUpdated(f, state) {
    const e = entries.get(f.id)
    if (!e || e.state !== 'downloading' || flight !== f) return
    const received = f.item.getReceivedBytes(), total = f.item.getTotalBytes()
    if (received > e.received) startTimer('stall', () => endFlight(f, 'interrupted', 'no bytes for a minute'), TIMES.stall)
    Object.assign(e, { received, total, percent: total > 0 ? Math.min(100, Math.floor(received / total * 100)) : null })
    // More than any download still needed: whatever it is, it is not one of them, and it never fills the drive
    if (received > f.limit) return endFlight(f, 'different', `${received} bytes, more than any needed download`)
    if (state === 'interrupted') {
      // 'updated' interrupted can be resumed, and 'done' never comes until it ends: resumed once, a second drop ends it
      if (!f.resumed && f.item.canResume()) { f.resumed = true; log(`[nexus] ${f.filename} was interrupted: resuming`); f.item.resume() }
      else return endFlight(f, 'interrupted', 'interrupted again')
    }
    pushThrottled()
  }
  // Ends a download for a reason: its 'done' (cancelled) then reads endAs
  function endFlight(f, reason, note) {
    if (f.endAs || f.cancelling || flight !== f) return
    f.endAs = reason; f.cancelling = true; log(`[nexus] stopped ${f.filename}: ${note}`)
    try { f.item.cancel() } catch (error) { log(`[nexus] could not stop ${f.filename}: ${error.message}`) }
  }
  // The download in flight stopped with no reason to tell (the window closed, Remove): back to waiting. Once only
  function cancelFlight() {
    const f = flight
    if (!f || f.endAs || f.cancelling) return
    f.cancelling = true
    try { f.item.cancel() } catch (error) { log(`[nexus] the download could not be stopped: ${error.message}`) }
  }

  // A finished download: its size, then its MD5, against every download still needed; kept under its Nexus ids. It runs
  // to its end even when the window has closed meanwhile; it then never touches the window
  async function finish(f, state) {
    if (flight === f) flight = null
    stopTimer('stall')
    const e = entries.get(f.id)
    try {
      if (!e) return
      if (state === 'cancelled' && !f.endAs) { if (e.state === 'downloading') Object.assign(e, { state: 'waiting', percent: null }); return }
      if (state !== 'completed') {
        Object.assign(e, { state: f.endAs === 'different' ? 'wrong' : 'failed', percent: null })
        return setProblem(f.endAs === 'different' ? 'different' : 'interrupted', f.id)
      }
      // Dovakarn's folder is being removed: nothing is checked into it now
      if (holding) { Object.assign(e, { state: 'waiting', percent: null }); return }
      Object.assign(e, { state: 'checking', percent: null }); pushAll()
      f.abort = new AbortController()                                  // stopWhile stops a check at once
      const size = fs.statSync(f.savePath).size
      const sameSize = () => order.map(id => entries.get(id)).filter(x => x.archive.size === size)
      if (!sameSize().some(x => x.state !== 'done')) { e.state = 'wrong'; return setProblem('different', f.id) }
      const md5 = await hash(f.savePath, 'md5', f.abort.signal)       // streamed, never read whole
      if (f.abort.signal.aborted) { e.state = 'waiting'; return }
      const match = sameSize().find(x => x.archive.md5 === md5)      // states read again after the await
      if (!match) { e.state = 'failed'; return setProblem('damaged', f.id) }
      if (match !== e) e.state = 'waiting'
      if (match.state === 'done') return                               // a check brought it in meanwhile: this copy is spare
      const to = path.join(f.dir, modInstall.downloadName(match.archive, modInstall.ARCHIVE.test(f.filename) ? f.filename : match.archive.file))
      if (path.dirname(path.resolve(to)) !== f.dir) throw new Error('the file name left the Downloads folder')
      if (!(await moveInto(f.savePath, to, match.archive, f.abort.signal))) {
        if (f.abort.signal.aborted) { if (e.state === 'checking') e.state = 'waiting'; return }
        match.state = 'failed'; return setProblem('move', match.archive.id)
      }
      Object.assign(match, { state: 'done', file: to, via: 'window', percent: null })
      afterDone(match)
    } catch (error) {
      // Stopped by Remove: the folder goes, the download is simply wanted again
      if (f.abort?.signal.aborted) { if (e?.state === 'checking') e.state = 'waiting'; log(`[nexus] the check of ${f.filename} was stopped: Dovakarn is being removed`); return }
      log(`[nexus] checking ${f.filename} failed: ${error.message}`)
      if (e?.state === 'checking') { e.state = 'failed'; setProblem('save', f.id) }
    } finally {
      if (e?.state === 'checking') { e.state = 'failed'; setProblem('save', f.id) }   // never left checking
      // A check found this mod elsewhere while it came in: not needed any more, however this download ended (stopped,
      // wrong, damaged), so it counts as done and the window can still close with every mod in
      if (e && e.dropped && e.state !== 'done') {
        Object.assign(e, { state: 'done', via: 'found', percent: null }); e.dropped = false
        if (problem?.id === e.archive.id) problem = null
        log(`[nexus] ${e.archive.name} was found by a check while it downloaded: no longer needed`)
        followFound()
      }
      try { fs.rmSync(f.savePath, { force: true }) } catch (error) { log(`[nexus] a part file stays in ${INCOMING}: ${error.message}`) }
      pending.delete(f); f.resolveSettled()
      pushAll()
    }
  }
  // The checked file into Dovakarn's Downloads folder under its own name. A copy already there with the same size and MD5
  // is kept (a check may have it open); a file a virus scanner still holds is tried again for 5 seconds
  async function moveInto(from, to, archive, signal) {
    if (sizeOf(to) === archive.size) {
      try { if (await hash(to, 'md5', signal) === archive.md5) return true } catch { /* unreadable: replaced below */ }
    }
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted) return false
      try { rename(from, to); return true } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= LIMITS.renameTries) { log(`[nexus] could not move ${archive.name} into Downloads after ${attempt} ${attempt === 1 ? 'try' : 'tries'}: ${error.message}`); return false }
        if (attempt === 1) log(`[nexus] ${archive.name} is held by another program (${error.code}): trying again`)
        await sleep(TIMES.renameRetry)
      }
    }
  }
  function afterDone(match) {
    problem = null
    brought = true
    log(`[nexus] ${match.archive.name} ${match.archive.version} downloaded and checked`)
    if (!openEntries().length) return everyModIn()
    if (!isOpen()) return                                            // closed meanwhile: no page to move, nothing to show
    justIn = match.archive.id
    if (match.archive.id === current) {
      moving = true
      startTimer('moveOn', () => {
        moving = false; justIn = null
        if (entries.get(current)?.state === 'done') { current = nextOpen(current); if (current && mayMove()) navigate({ auto: true }) }
        pushAll()
      }, TIMES.moveOn)
    } else startTimer('justIn', () => { justIn = null; pushAll() }, TIMES.justIn)
  }
  function everyModIn() {
    if (!isOpen()) return askInstall()                               // the last one landed after the window closed
    allDone = true
    startTimer('close', () => close(), TIMES.closeAfter)
  }
  // Never while Dovakarn is being removed, its confirm dialog included: the install would go into the folder being removed.
  // It is asked again if the Remove does not happen (removeEnded)
  function askInstall() {
    if (installAsked) return
    if (isRemoving()) { if (!installDeferred) log('[nexus] every mod is downloaded: the install waits until the Remove is decided'); installDeferred = true; return }
    installAsked = true; installDeferred = false
    try { onAllDownloaded() } catch (error) { log(`[nexus] the install was not asked for: ${error.message}`) }
  }
  // Part files a crashed or closed launcher left: removed the first time this run uses that Downloads folder (the window
  // or the automatic download, whichever comes first, so neither ever removes the other's file in progress)
  function cleanIncoming(dir) {
    if (cleanedDirs.has(dir.toLowerCase())) return
    cleanedDirs.add(dir.toLowerCase())
    try { fs.rmSync(path.join(dir, INCOMING), { recursive: true, force: true }) } catch (error) { log(`[nexus] old part files stay in ${INCOMING}: ${error.message}`) }
  }

  // ---- The automatic download through Nexus's API (a logged-in Premium member) ----
  // One run downloads every mod still needed, the one pressed first, one file at a time, each checked by size and MD5 and
  // kept under the same name as the window keeps it; with every mod in, the install is asked for as after the window. A
  // file that fails is said and the rest go on; a reason that would fail them all (logged out, not Premium, Nexus's limit,
  // Nexus out of reach) ends the run. Never while the Nexus window is open, and never while Dovakarn is being removed.
  function startDirect(first) {
    if (direct) return { success: true, direct: true }
    if (isOpen() || opening) return { success: false, error: TEXT.directWhileWindow }
    // Only downloads still finishing from the window that just closed (its cancel, or a file being checked): nothing to start
    if (!openEntries().some(e => e.state !== 'downloading' && e.state !== 'checking')) return { success: false, error: TEXT.stillFinishing }
    const run = { abort: new AbortController(), failed: [] }
    direct = run; directProblem = null
    // This run tries every mod not yet in, those that failed before included: they wait their turn again, so a row that
    // says it failed during a run failed in this one
    for (const e of openEntries()) if (e.state === 'failed' || e.state === 'wrong') Object.assign(e, { state: 'waiting', percent: null })
    run.done = runDirect(run, first)
      .catch(error => { log(`[nexus] the automatic download stopped: ${error?.message || error}`); directProblem = { kind: 'error', message: TEXT.directFailed } })
      .finally(() => {
        if (direct === run) direct = null
        if (!directProblem && run.failed.length) directProblem = { kind: 'some', ids: [...run.failed] }
        pushMain()
      })
    pushMain()
    return { success: true, direct: true }
  }
  // What the last run could not do, as it is now: the files it could not get that are still not in (one brought in since by
  // the window, or found by a check, is no longer named)
  function problemNow() {
    if (!directProblem) return null
    if (directProblem.kind !== 'some') return { kind: directProblem.kind, message: directProblem.message }
    const left = directProblem.ids.map(id => entries.get(id)).filter(e => e && e.state !== 'done')
    return left.length ? { kind: 'some', message: TEXT.someFailed(left.length, left.map(e => e.archive.name)) } : null
  }
  /**
   * The Nexus account changed: what the last run said about the login no longer stands once it is untrue. A login ended or
   * not switched on goes with any new login; not Premium goes once the account is Premium.
   */
  function accountChanged() {
    let loggedIn = false
    try { loggedIn = nexusAccount?.status()?.loggedIn === true } catch { /* unreadable: as logged out */ }
    const kind = directProblem?.kind
    if ((kind === 'notPremium' && premiumReady()) || (ACCOUNT_PROBLEMS.has(kind) && kind !== 'notPremium' && loggedIn)) directProblem = null
    pushMain()
  }
  async function runDirect(run, first) {
    const named = setup.downloadsDir()
    if (!absolute(named)) { directProblem = { kind: 'save', message: TEXT.setUpFirst }; return }
    const dir = path.resolve(named)
    // One launcher at a time uses Nexus and its part-file folder (the same lock as the window): a second launcher on this PC
    // would otherwise clear this one's file in progress
    if (!(await takeLock())) { directProblem = { kind: 'locked', message: TEXT.lockedDirect }; return }
    if (run.abort.signal.aborted || holding) return
    cleanIncoming(dir)
    const incoming = path.join(dir, INCOMING)
    fs.mkdirSync(incoming, { recursive: true })
    const tried = new Set()
    const next = () => {
      const free = openEntries().filter(e => e.state !== 'downloading' && e.state !== 'checking' && !tried.has(e.archive.id))
      return free.find(e => e.archive.id === first) || free[0] || null
    }
    log(`[nexus] downloading ${openEntries().length} mods through Nexus's API`)
    for (let e = next(); e; e = next()) {
      if (run.abort.signal.aborted || holding) return
      tried.add(e.archive.id)
      if ((await directOne(run, e, dir, incoming)) === 'stop') return
    }
    if (run.abort.signal.aborted || holding) return
    // Every mod is in, by this run or meanwhile: installed as after the window (asked once; held while a Remove is decided)
    if (!openEntries().length && brought) everyModIn()
  }
  // One file: 'ok', 'next' (this one failed, the rest go on) or 'stop' (stopped, or every other file would fail the same)
  async function directOne(run, e, dir, incoming) {
    const a = e.archive, signal = run.abort.signal
    const f = { id: a.id, savePath: '', abort: run.abort }
    f.settled = new Promise(resolve => { f.resolveSettled = resolve })
    pending.add(f)
    try {
      for (let attempt = 1; ; attempt++) {
        f.savePath = path.join(incoming, `${now()}-${++serial}.download`)
        Object.assign(e, { state: 'downloading', percent: 0, received: 0, total: a.size }); pushMain()
        try {
          // One file at a time, and at least TIMES.linkPause between Nexus API calls for download links, across runs too
          const wait = lastLinkAt + TIMES.linkPause - now()
          if (wait > 0) await pauseFor(wait, signal)
          if (signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
          lastLinkAt = now()
          const url = await nexusAccount.downloadLink(a, { signal })
          let fromName = ''
          try { fromName = decodeURIComponent(path.posix.basename(new URL(url).pathname)) } catch { /* the name only gives the extension */ }
          const { host } = await nexusAccount.nexusFile(url, f.savePath, { limit: a.size, signal, onProgress: ({ received }) => {
            if (e.state !== 'downloading') return
            Object.assign(e, { received, percent: Math.min(100, Math.floor(received / a.size * 100)) }); pushThrottled()
          } })
          if (signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
          Object.assign(e, { state: 'checking', percent: null }); pushMain()
          if (sizeOf(f.savePath) !== a.size) { e.state = 'wrong'; log(`[nexus] ${a.name} from Nexus's API is ${sizeOf(f.savePath)} bytes, not ${a.size}`); run.failed.push(a.id); return 'next' }
          const md5 = await hash(f.savePath, 'md5', signal)
          if (signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
          if (md5 !== a.md5) { e.state = 'failed'; log(`[nexus] ${a.name} from Nexus's API has the wrong MD5`); run.failed.push(a.id); return 'next' }
          const to = path.join(dir, modInstall.downloadName(a, modInstall.ARCHIVE.test(fromName) ? fromName : a.file))
          if (path.dirname(path.resolve(to)) !== dir) throw new Error('the file name left the Downloads folder')
          if (!(await moveInto(f.savePath, to, a, signal))) {
            if (signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
            e.state = 'failed'; run.failed.push(a.id); return 'next'
          }
          Object.assign(e, { state: 'done', file: to, via: 'nexusApi', percent: null })
          brought = true
          log(`[nexus] ${a.name} ${a.version || ''} downloaded through Nexus's API from ${host} and checked`)
          return 'ok'
        } catch (error) {
          try { fs.rmSync(f.savePath, { force: true }) } catch { /* removed below */ }
          if (signal.aborted || error?.code === 'CANCELLED') { if (e.state === 'downloading' || e.state === 'checking') Object.assign(e, { state: 'waiting', percent: null }); return 'stop' }
          if (stopsTheRun(error)) {
            if (e.state === 'downloading' || e.state === 'checking') Object.assign(e, { state: 'waiting', percent: null })
            directProblem = { kind: String(error.code || 'error'), message: error.message }
            log(`[nexus] the automatic download stopped: ${error.message}`)
            return 'stop'
          }
          if (DIRECT_RETRY.has(error?.code) && attempt < 2) { log(`[nexus] ${a.name}: ${error.message} Trying once more`); continue }
          Object.assign(e, { state: error?.code === 'different' ? 'wrong' : 'failed', percent: null })
          log(`[nexus] ${a.name} did not download through Nexus's API: ${error?.message || error}`)
          run.failed.push(a.id)
          return 'next'
        }
      }
    } finally {
      if (e.state === 'downloading' || e.state === 'checking') Object.assign(e, { state: 'failed', percent: null })   // never left half-way
      // A check found this mod elsewhere while it came in: not needed any more, however this download ended
      if (e.dropped && e.state !== 'done') {
        Object.assign(e, { state: 'done', via: 'found', percent: null }); e.dropped = false
        const at = run.failed.indexOf(a.id); if (at >= 0) run.failed.splice(at, 1)
      }
      try { if (f.savePath) fs.rmSync(f.savePath, { force: true }) } catch (error) { log(`[nexus] a part file stays in ${INCOMING}: ${error.message}`) }
      pending.delete(f); f.resolveSettled()
      pushMain()
    }
  }
  /** The automatic download's Stop: the file in progress is dropped, the ones already in stay. stopped: a run was going. */
  function stopDirect() {
    if (!direct || direct.abort.signal.aborted) return { success: true, stopped: false }
    direct.abort.abort()
    log('[nexus] the automatic download was stopped')
    return { success: true, stopped: true }
  }

  /** main's Remove ended. removed: the folder is gone, so an install it held back is dropped; else it is asked now. */
  function removeEnded(removed) {
    const again = installDeferred
    installDeferred = false
    if (!removed && again && !openEntries().length) askInstall()
    pushMain()
  }

  function onClosed() {
    gen++
    const finished = allDone
    cancelFlight()                      // 'done' cancelled: waiting; finished files stay, one being checked finishes
    stopAllTimers()
    try { if (view && !view.webContents.isDestroyed()) view.webContents.close() } catch { /* gone */ }
    try { const parent = parentWindow(); if (parent && parentClosed) parent.removeListener('closed', parentClosed) } catch { /* gone */ }
    win = null; view = null; stripIsReady = false; readyToShow = false; parentClosed = null
    allDone = false; allIn = false; moving = false; justIn = null; problem = null; pageStep = 'opening'; onStep = false; navSerial++
    if (finished) askInstall()          // first, so the 'closed' push already says the install is queued
    pushMain()
  }

  function askAdult() {
    const ask = [...new Set(order.map(id => entries.get(id).archive.modId))].filter(m => !askedAdult.has(m))
    if (!ask.length) return
    for (const m of ask) askedAdult.add(m)
    fetchAdultFlags({ modIds: ask, request, log }).then(found => { for (const m of found) adultIds.add(m); pushAll() }, () => {})
  }

  // The Nexus session, its handlers once per process: Electron's default user agent (never changed), every permission
  // denied, no page from outside Nexus ever shown, and downloads only through onWillDownload
  function ensureSession() {
    const { session } = electron()
    const s = session.fromPartition(partition)                       // persist: = userData\Partitions\nexus
    if (!sessionReady) {
      // Without the page check the window does not open at all (create() fails, and the player is told it could not)
      if (typeof s.webRequest?.onHeadersReceived !== 'function') throw new Error('the Nexus session cannot check what its pages are')
      sessionReady = true
      // Electron 41: one onHeadersReceived listener per session (this partition is the launcher's own). Every main-frame
      // response passes here before it is shown; one from outside Nexus that would show as a page is answered as 204 No
      // Content instead, so the step page stays where it is: no error page, nothing reloads. A file (one attachment, or
      // only file types) goes on to will-download, where its size and MD5 still decide
      s.webRequest.onHeadersReceived({ urls: ['<all_urls>'], types: ['mainFrame'] }, (details, callback) => {
        let stop = false
        try { stop = stopsAsPage(details); if (stop) stoppedPage(details) }
        catch (error) { log(`[nexus] page check: ${error.message}`) }
        finally { callback(stop ? stoppedAnswer() : {}) }
      })
      // The Nexus session keeps Electron's default user agent; the launcher never sets or changes it
      s.setPermissionRequestHandler((_wc, permission, callback, details) => {
        try { if (permission === 'openExternal' && /^nxm:/i.test(details?.externalURL || '')) setProblem('modManager', current) }
        catch (error) { log(`[nexus] permission: ${error.message}`) }
        finally { callback(false) }                                   // every permission, including openExternal
      })
      s.setPermissionCheckHandler(() => false)
      s.on('will-download', guarded('download', onWillDownload))
    }
    ses = s
    return s
  }
  // One ask at a time: open() and logout() at once share it, since a second listen on our own pipe would answer
  // EADDRINUSE. A win is kept whatever any later answer says
  async function takeLock() {
    if (locked) return true
    if (!locking) {
      const asking = (async () => {
        try { return (await lock(lockName(userDataDir))) === true } catch (error) { log(`[nexus] the Nexus lock: ${error.message}`); return false }
      })()
      locking = asking
      asking.then(() => { if (locking === asking) locking = null })
    }
    const ok = await locking
    locked = locked || ok
    if (!locked) log('[nexus] another Dovakarn launcher is using Nexus')
    return locked
  }

  async function create(target) {
    // 1. One launcher at a time uses the Nexus partition; kept until this launcher exits. Refused, the player's own
    //    browser still gets the mod (browser: the launcher page offers Open in my browser)
    if (!(await takeLock())) return { success: false, error: TEXT.locked, browser: true }
    if (isRemoving()) return { success: false, error: TEXT.removing }
    // 2. Part files a crashed or closed launcher left: removed the first time this run uses that Downloads folder. With
    //    the lock held no other launcher writes there, and this run has not downloaded into it yet. The folder is read
    //    again after the wait for the lock, and never used unless it names its drive
    const named = setup.downloadsDir()
    if (!absolute(named)) return { success: false, error: TEXT.setUpFirst }
    cleanIncoming(path.resolve(named))
    // 3. The session, 4. no TLS client certificate for Nexus, ads or trackers (Electron's default sends the first in the
    //    store). The app-level event's callback takes no certificate; the webContents event's type requires one
    ensureSession()
    const { app, BrowserWindow, WebContentsView, screen } = electron()
    if (!appReady) {
      appReady = true
      app.on('select-client-certificate', guarded('client certificate', (event, wc, _url, _list, callback) => {
        if (view && wc === view.webContents) { event.preventDefault(); callback() }
      }))
    }
    // 5. The window
    const parent = parentWindow(), pb = parent && !parent.isDestroyed() ? parent.getBounds() : null
    const area = screen.getDisplayMatching(pb || { x: 0, y: 0, width: 1, height: 1 }).workArea
    const width = Math.max(WINDOW.minWidth, Math.min(WINDOW.width, area.width - 32)), height = Math.max(WINDOW.minHeight, Math.min(WINDOW.height, area.height - 32))
    let x = pb ? Math.round(pb.x + (pb.width - width) / 2) : area.x + Math.round((area.width - width) / 2)
    let y = pb ? Math.round(pb.y + (pb.height - height) / 2) : area.y + Math.round((area.height - height) / 2)
    x = Math.max(area.x, Math.min(x, area.x + area.width - width)); y = Math.max(area.y, Math.min(y, area.y + area.height - height))
    const made = new BrowserWindow({
      title: 'Nexus Mods for Dovakarn', icon, parent: pb ? parent : undefined, modal: false,
      x, y, width, height, minWidth: WINDOW.minWidth, minHeight: WINDOW.minHeight,
      frame: false, resizable: true, maximizable: true, minimizable: true, fullscreenable: false,
      backgroundColor: BACKGROUND, show: false,
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: dev, spellcheck: false },
    })
    gen++
    win = made
    current = target; installAsked = false; allDone = false; allIn = false
    try { wireWindow(made, parent, pb, WebContentsView) } catch (error) {
      // A window half made is never left hidden on the PC: it goes, and the player is told it could not open
      try { if (!made.isDestroyed()) made.destroy() } catch { /* gone */ }
      if (win === made) { win = null; view = null }
      throw error
    }
    return { success: true }
  }
  function wireWindow(made, parent, pb, WebContentsView) {
    const mine = () => win === made
    made.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))       // our strip never opens windows
    made.webContents.on('will-navigate', event => event.preventDefault())   // or leaves its page
    // Never a Save dialog from the strip either (it uses the launcher's default session, where Electron's default is one)
    if (!stripSessionReady && made.webContents.session) {
      stripSessionReady = true
      made.webContents.session.on('will-download', guarded('strip download', (event, _item, wc) => {
        if (isOpen() && wc === win.webContents) { event.preventDefault(); log('[nexus] refused a download from the strip page') }
      }))
    }
    made.once('ready-to-show', guarded('ready-to-show', () => { if (mine()) { readyToShow = true; maybeShow() } }))
    made.on('closed', guarded('closed', () => { if (mine()) onClosed() }))
    for (const name of ['resize', 'maximize', 'unmaximize', 'restore']) made.on(name, guarded('layout', layout))
    made.loadFile(pagePath).catch(error => log(`[nexus] the strip page did not load: ${error.message}`))
    if (pb) { parentClosed = guarded('launcher closed', () => close()); parent.once('closed', parentClosed) }
    // 6. The Nexus view
    view = new WebContentsView({ webPreferences: { session: ses, devTools: dev, ...VIEW_PREFS } })
    view.setBackgroundColor(BACKGROUND)
    made.contentView.addChildView(view)
    wireView(view.webContents)
    layout()
    startTimer('show', () => { if (isOpen() && !win.isVisible()) { win.show(); win.focus() } }, TIMES.showFallback)
    // 7. The mod's step page, 8. the adult flags (never awaited)
    bounced = false
    navigate()
    askAdult()
  }

  function wireView(wc) {
    const mine = () => viewAlive() && view.webContents === wc
    const on = (name, fn) => wc.on(name, guarded(name, fn))
    wc.setWindowOpenHandler(guarded('new window', ({ url } = {}) => {
      const v = navigationVerdict(url)
      if (v === 'allow' && mine()) { expectedUrl = url; wc.loadURL(url).catch(() => {}) }   // a Nexus page asked for a new tab: it opens here
      else if (v === 'modManager') setProblem('modManager', current)
      return { action: 'deny' }
    }, { action: 'deny' }))
    on('will-frame-navigate', details => guard(details, 'navigate'))
    on('will-navigate', details => guard(details, 'navigate'))
    on('will-redirect', details => guard(details, 'redirect'))
    on('will-attach-webview', event => event.preventDefault())
    on('will-prevent-unload', event => event.preventDefault())       // a page never holds our navigation
    on('did-navigate', (_e, url, httpCode) => { if (mine()) committed(url, httpCode) })
    on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!mine() || !isMainFrame) return
      viewUrl = String(url || '')
      const cur = currentEntry(), was = onStep
      onStep = !!cur && isStepUrl(viewUrl, cur.archive)
      if (was && !onStep) { pageStep = pageKind(viewUrl, cur?.archive); stopTimer('poll') }
      pushAll()
    })
    on('dom-ready', () => {
      if (!mine()) return
      domReady = true; stopTimer('noDom')
      if (onStep) { noBoxSince = now(); emptyReads = 0; return readStep() }
      // Any other Nexus page: one read learns the login
      if (/^(?:www|next)\.nexusmods\.com$/.test(hostOf(viewUrl))) return readPage().then(() => pushAll())
    })
    on('page-title-updated', (_e, title) => { if (mine() && onStep && /^just a moment/i.test(String(title || ''))) enterChallenge() })
    on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (!mine() || !isMainFrame || code === -3) return             // -3: superseded, or turned into a download
      // A link outside Nexus the step page was let go to did not load (its host out of reach, or an answer Chromium
      // refuses, such as two different attachment headers): Chromium's error page goes and the mod comes back, said as a
      // failed link, never as Nexus out of reach. Not the player's press, so a script repeating it counts toward stuck
      if (url === 'about:blank') return                               // the launcher's own blank page
      if (navigationVerdict(url) !== 'allow') {
        log(`[nexus] ${hostOf(url) || 'a link'} did not load (${code}): back to the mod`)
        if (!currentEntry()) { blank(); return pushAll() }
        if (problem?.id !== current || !['elsewhere', 'linkFailed'].includes(problem?.kind)) problem = { kind: looksLikeFile(url) ? 'linkFailed' : 'elsewhere', id: current }
        if (pageStep === 'stuck') { problem = null; blank(); return pushAll() }
        return navigate({ keepProblem: true, auto: true })
      }
      pageStep = 'offline'; stopTimer('poll'); stopTimer('noDom'); pushAll()
    })
    on('render-process-gone', () => { if (!mine()) return; pageStep = 'crashed'; stopTimer('poll'); stopTimer('noDom'); pushAll() })
  }

  // The window is open: brought forward, and pointed at this mod when the player pressed one
  function focusAt(archiveId, target) {
    const parent = parentWindow()
    if (parent && !parent.isDestroyed() && parent.isMinimized()) parent.restore()
    if (win.isMinimized()) win.restore()
    win.show(); win.focus()
    // "Download them all" while open only brings it forward, so a login page in progress is never lost
    if (archiveId !== null && (target !== current || !onStep)) { current = target; pressNavigate() }
    pushAll()
    return { success: true }
  }

  /**
   * The player's Download button: that download (id) or the first still to get (null). A logged-in Premium member gets
   * them by themselves through Nexus's API; everyone else, or anyone who asks for it (useWindow), gets the window.
   */
  async function open(archiveId, { useWindow = false } = {}) {
    // A run the player stopped that is still winding down (its file being dropped) counts as over: this press is a new one
    if (direct && direct.abort.signal.aborted) await direct.done
    if (!direct) neededChanged(setup.neededArchives())                 // a run in progress keeps the list it works through
    if (isRemoving()) return { success: false, error: TEXT.removing }
    if (!absolute(setup.downloadsDir())) return { success: false, error: TEXT.setUpFirst }
    if (direct) return useWindow ? { success: false, error: TEXT.windowWhileDirect } : { success: true, direct: true }
    if (!openEntries().length) return { success: false, error: TEXT.allDownloaded }
    if (archiveId !== null && !entries.has(archiveId)) return { success: false, error: TEXT.notNeeded }
    if (!useWindow && premiumReady() && !isOpen() && !opening) return startDirect(archiveId)
    // Steps so far never touch Electron, a pipe or the disk
    const target = () => archiveId === null ? (isOpen() && current && entries.get(current).state !== 'done' ? current : nextOpen(null))
      : (entries.get(archiveId).state !== 'done' ? archiveId : nextOpen(archiveId))
    if (opening) await opening.catch(() => {})                        // a second press while the first window is made
    if (isOpen()) return focusAt(archiveId, target())
    opening = create(target()).finally(() => { opening = null })
    return opening
  }

  /** Log out of Nexus: everything the partition keeps on this PC goes (the strip, and Settings, Mods). */
  async function logout() {
    if (flight || anyChecking()) return { success: false, error: TEXT.logoutBusy }
    if (!(await takeLock())) return { success: false, error: TEXT.logoutLocked }
    const s = ensureSession()
    await s.clearStorageData()            // cookies, local storage, IndexedDB, service workers
    await s.clearCache()
    await s.clearAuthCache()
    login = 'out'; user = ''; premium = false
    remember('', 'out')
    log('[nexus] logged out of Nexus on this PC')
    if (viewAlive()) navigate()
    pushAll()
    return { success: true }
  }

  async function action(sender, name) {
    if (!isStripSender(sender) || typeof name !== 'string' || !ACTIONS.has(name)) return { success: false }
    const cur = currentEntry()
    switch (name) {
      case 'login': if (!cur || !viewAlive()) return { success: false }
        expectedUrl = signInUrl(cur.archive); view.webContents.loadURL(expectedUrl).catch(() => {}); break
      case 'logout': return logout()
      case 'skip': { const n = nextOpen(current); if (n && n !== current) { current = n; pressNavigate() } break }
      case 'browser': {
        if (!current) return { success: false }
        const result = setup.openMod(current)
        setProblem('inBrowser', current)
        return result
      }
      case 'settings': if (!viewAlive()) return { success: false }
        expectedUrl = SETTINGS_URL; view.webContents.loadURL(SETTINGS_URL).catch(() => {}); break
      case 'back': case 'retry': if (!cur || !viewAlive()) return { success: false }
        pressNavigate(); break
      case 'minimize': { const parent = parentWindow(); if (parent && !parent.isDestroyed()) parent.minimize(); else win.minimize(); break }
      case 'close': win.close(); break
    }
    return { success: true }
  }

  function stripReady(sender) {
    if (!isStripSender(sender)) return
    stripIsReady = true
    pushAll()
    maybeShow()
  }
  // The strip reports CSS px; a zoomed strip page (the default zoom keys work on it too) still gives the view DIPs
  function stripHeight(sender, px) {
    if (!isStripSender(sender) || typeof px !== 'number' || !Number.isFinite(px)) return
    const z = Number(win.webContents.getZoomFactor?.())
    zoom = Number.isFinite(z) && z > 0 ? z : 1
    reportedDip = Math.round(px * zoom)
    layout()
  }
  function close() { if (isOpen()) win.close() }

  /**
   * Remove Dovakarn, after the player confirmed: nothing new starts, the download in flight is cancelled, any file being
   * checked or moved finishes, and the window closes, all before task() deletes the folder (10 seconds at most each).
   * task's own error reaches the caller unchanged.
   */
  async function stopWhile(task) {
    holding = true                                     // open() and will-download refuse from here on
    // Waits for what the window is doing, 10 seconds at most (a plain timer: never cut short)
    const capped = promise => { let timer = null; return Promise.race([promise, new Promise(resolve => { timer = setTimer(resolve, TIMES.stopCap) })]).finally(() => clearTimer(timer)) }
    try {
      if (opening) await opening.catch(() => {})
      const settled = [...pending].map(f => f.settled)
      if (direct) { direct.abort.abort(); settled.push(direct.done) }   // the automatic download stops, its file dropped
      cancelFlight()
      for (const f of pending) f.abort?.abort()                        // a check under way stops reading at once
      // The cancel's 'done', and any check still hashing or moving a file, end before the folder goes
      await capped(Promise.allSettled(settled))
      if (isOpen()) await capped(new Promise(resolve => { win.once('closed', resolve); win.close() }))
      return await task()
    } finally { holding = false }
  }

  return {
    open: guarded('open', open, { success: false, error: TEXT.couldNotOpen, browser: true }),
    action: guarded('button', action, { success: false }),
    logout: guarded('log out', logout, { success: false, error: TEXT.logoutFailed }),
    stripReady: guarded('strip ready', stripReady), stripHeight: guarded('strip height', stripHeight),
    neededChanged: guarded('needed mods', neededChanged), snapshot: guarded('snapshot', snapshot, null), stopDirect: guarded('stop', stopDirect, { success: false }), accountChanged: guarded('account', accountChanged),
    pushMain: guarded('push', pushMain), close: guarded('close', close), removeEnded: guarded('remove ended', removeEnded), stopWhile, isOpen,
  }
}

module.exports = {
  PARTITION, INCOMING, SETTINGS_URL, TIMES, LIMITS, STRIP, WINDOW, ACTIONS, VIEW_PREFS, ADULT_QUERY, TEXT, FACTS_SCRIPT,
  FILE_TYPES, REDIRECTS, OUTSIDE_STORAGES, DIRECT_STOPS, DIRECT_RETRY, stopsTheRun, stoppedAnswer,
  hostOf, nexusHost, withoutHash, hasNmm, looksLikeFile, siteOf, headerValues, responseKind, stopsAsPage, navigationVerdict, stepUrl, signInUrl, isStepUrl,
  pageKind, lockName, takeProcessLock, readFacts, loginFrom, fetchAdultFlags, createInstallTrigger, createNexusDownloads,
}
