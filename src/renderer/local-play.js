'use strict'
const $ = selector => document.querySelector(selector)
const play = $('#play'), message = $('#message'), server = $('#server'), serverLine = $('#server-line')
const notice = $('#notice'), noticePrimary = $('#notice-primary'), noticeSecondary = $('#notice-secondary')
const settings = $('#settings'), checks = $('#checks'), checksList = $('#checks-list'), setupModal = $('#setup'), modsModal = $('#mods')
const progressCard = $('#progress'), progressTrack = $('#progress-track')
let launching = false, checking = false, settingUp = false, refreshing = false, refreshAgain = false
let state = null, filesView = null, returnFocus = null, noticeActions = {}, stage = 'ready', meter = null, shown = null
// Why the last launch did not start, shown in its own card until the next attempt
let launchFailed = null
// Whether the Skyrim folder was on the version Dovakarn needs at the last refresh: a switch made meanwhile (with the
// Skyrim Downgrader Tool) is checked against the server as soon as the launcher sees it
let versionWasOk = null
// A check, a launch or the mods' install is running, from this page or a Play shortcut: what the Verify window and the
// progress card follow
const checkRunning = () => checking || launching || settingUp || !!state?.busy || nexus.installing
// Nothing new may start: something runs, the mods' install waits its turn, or Dovakarn's folder is being removed
const working = () => checkRunning() || nexus.installQueued || nexus.removing
// A new check can start: the launcher has answered, nothing is running, Skyrim is closed and Remove's confirm dialog is not
// open (while it is, nothing starts, but every label stays as it was until the player confirms)
const canCheck = () => !!state && !working() && !nexus.removeAsking && !state.gameRunning
// Steps of a running check, shown live in the Verify window and in the progress card.
const CHECK_STEPS = ['preparingHost', 'startingServer', 'checking', 'updatingFiles', 'patchingFiles', 'copyingGame', 'installingMods']
// Dovakarn's own game copy (gameSetup.js): null where the launcher plays from the server's copy (the test launcher)
const gameCopy = () => state?.gameCopy || null
// The launcher's Nexus window (nexusDownloads.js): each needed download's state, pushed by the launcher while it works,
// and the Nexus login its window keeps on this PC (login 'in' with or without a name, 'out' or 'unknown'; kept: the
// window's session has something on this PC). removeAsking: Remove's confirm dialog is open; removing: confirmed
// direct: the automatic download through Nexus's API (a logged-in Premium member) is running, and what its last run could
// not do; premium: a Download press downloads by itself
let nexus = { open: false, installQueued: false, installing: false, removing: false, removeAsking: false, current: null, account: { user: '', login: 'unknown', kept: false }, archives: {},
  direct: { running: false, problem: null }, premium: false }
// The player's Nexus account (nexusAccount.js), as the launcher last said: { loggedIn, account: { name, premium }, pending,
// error, available }. null until it answers, and in the test launcher, which has none
let nexusMe = null
const nexusMeAvailable = () => !!nexusMe?.available
const directRunning = () => nexus.direct.running
const DOWNLOAD_STATES = new Set(['waiting', 'downloading', 'checking', 'done', 'wrong', 'failed'])
const NEXUS_LOGINS = new Set(['in', 'out', 'unknown'])
const downloadState = id => nexus.archives[id]?.state || 'waiting'
// Needed downloads the Nexus window has not brought in yet
const remainingMods = () => (gameCopy()?.mods || []).filter(m => downloadState(m.id) !== 'done')
// The install the Nexus window asked for is waiting for a free launcher, or running
const installWaiting = () => nexus.installQueued || nexus.installing
const downloadedNext = () => nexus.installing ? 'The launcher is installing them now.' : installWaiting() ? 'The launcher installs them as soon as it is free.' : 'Press Install the mods on the main screen to put them in.'
// Coming back to the launcher checks the downloads again at most every 20 seconds; closing the Nexus window counts too
let lastFocusCheckAt = 0
// Discord shows its own error page, and never comes back here, when this server's login is set up wrong: while the
// browser login waits, the status line says what to do then
const LOGIN_WAITING = 'Finish logging in with Discord in your browser. If Discord shows an error page there instead, press Cancel and tell the server owner.'
const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
// Skyrim Downgrader Tool on Nexus Mods: switches Steam's Skyrim to 1.6.1170 with Steam's own files
const DOWNGRADER_MOD = 188916
function phase(value) {
  // A check's progress would push that away; a problem still shows
  const failed = ['failed', 'filesBlocked', 'account'].includes(value.stage)
  if (!failed && state?.login?.pending) value = { stage: 'ready', message: LOGIN_WAITING }
  stage = value.stage; meter = value.meter || null
  // Set only when it changes: the line is read aloud, and the same words must not be read again
  if (message.textContent !== value.message) message.textContent = value.message
  message.classList.toggle('error', failed)
  syncMessage()
  renderProgress()
  // The gold button names the step a check is on
  syncPlay()
  if (!checks.hidden && checkRunning()) text('#checks-summary', checksSummary())
}
// A message this page says itself (a Skyrim folder the picker refused, what Check again found) stays until the
// launcher's own status line moves on or this page says something else; the 2 second refresh would otherwise put the
// old line back at once
let note = null, launcherPhase = null
function say(value) { note = { value, over: launcherPhase }; phase(value) }
// The launcher's status line: from each refresh, or pushed as it changes (a push is always news)
function launcherSays(value, { pushed = false } = {}) {
  if (note && (pushed || value.stage !== note.over?.stage || value.message !== note.over?.message)) note = null
  launcherPhase = value
  phase(note ? note.value : value)
}
// The status line steps aside while a card already says the same thing. An account refusal (server locked, Discord
// unreachable) only steps aside for a Discord or account card, never for an unrelated one about mods.
function syncMessage() {
  const accountNotice = !!shown && ['Discord', 'Account'].includes(shown.kind)
  message.hidden = !message.textContent || (!!shown && (['filesWarning', 'filesBlocked'].includes(stage) || (stage === 'account' && accountNotice)
    || message.textContent === shown.text || (!!shown.covers && message.textContent === shown.covers) || ['Connecting', 'Launch'].includes(shown.kind)))
}
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Skyrim versions as players know them: 1.6.1170, not 1.6.1170.0
const shortVersion = v => String(v || '').replace(/\.0$/, '')
const when = iso => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const day = iso => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const clock = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
function uptime(seconds) {
  if (seconds < 60) return 'just started'
  const d = Math.floor(seconds / 86400), h = Math.floor(seconds % 86400 / 3600), m = Math.floor(seconds % 3600 / 60)
  return `up ${d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`}`
}
// Sizes as players read them, the unit chosen by the larger number so both sides of "x of y" match
function sizes(part, whole) {
  const [unit, div] = whole >= 1024 ** 3 ? ['GB', 1024 ** 3] : whole >= 1024 ** 2 ? ['MB', 1024 ** 2] : ['KB', 1024]
  const show = n => (n / div).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return `${show(part)} of ${show(whole)} ${unit}`
}
// Words as text nodes, never markup. A percent sign after a number gets its own span: Sovngarde sets it a space away
function setWords(el, value) {
  const parts = String(value).split(/(?<=\d)%/)
  if (parts.length === 1) { el.textContent = value; return }
  const nodes = []
  parts.forEach((part, i) => {
    if (i) { const sign = document.createElement('span'); sign.className = 'pct-sign'; sign.textContent = '%'; nodes.push(sign) }
    if (part) nodes.push(document.createTextNode(part))
  })
  el.replaceChildren(...nodes)
}
// Server values are only ever set as plain text, and only when they change (the notice is read aloud).
const text = (selector, value, title = '') => {
  const el = $(selector)
  if (el.textContent !== value) setWords(el, value)
  if (el.title !== title) el.title = title
  return el
}
// A mod's version as players read it ("v0.13.0.4" is 0.13.0.4), and whether its name already carries it ("... v13" for
// 13, "... 7_6" for 7.6), so it is never said twice. The Nexus window's strip has the same rule (nexus-window.js)
const versionOf = m => m && typeof m.version === 'string' ? m.version.trim().replace(/^v(?=\d)/i, '') : ''
function carriesVersion(m) {
  const v = versionOf(m)
  if (!v || typeof m.name !== 'string') return !v
  const dots = s => s.replace(/[_-]/g, '.').toLowerCase()
  const exact = dots(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?<![0-9a-z.])v?' + exact + '(?![0-9]|\\.[0-9])').test(dots(m.name))
}
const modsVerb = (n, blocked) => `${count(n, 'mod')} ${blocked ? (n === 1 ? 'needs' : 'need') : (n === 1 ? 'differs' : 'differ')}`
// The local server names its players; the online heartbeat only counts them.
const playerCount = srv => Number.isFinite(srv.count) ? srv.count : srv.players.length
// Whether this launcher plays on the online Dovakarn server (wording) rather than a server on this PC.
const online = () => state?.mode !== 'local'
function names(list) { return list.length > 4 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ') }
function listed(list) { return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` }

// Discord login: who is logged in, from the launcher's state (the account key never reaches this page)
const login = () => state?.login || { discord: false, loggedIn: false, account: null, pending: false, error: null }
const STAFF = { admin: 'Admin', gm: 'Game master' }
// Discord pictures come from Discord's own image server only; says whether one is shown
function avatar(img, url) {
  const ok = typeof url === 'string' && url.startsWith('https://cdn.discordapp.com/')
  img.hidden = !ok
  if (ok && img.getAttribute('src') !== url) img.src = url
  return ok
}
// Keyboard focus on a button a change hid moves to the first of these still shown
function refocus(focused, candidates) {
  if (!focused || !focused.closest || !focused.closest('[hidden]')) return
  candidates.find(b => b && !b.closest('[hidden]') && !b.disabled)?.focus()
}
// Top bar: Log in with Discord, the wait for the browser, or the logged-in player's picture, name and number
function renderAccount() {
  const l = login(), a = l.loggedIn ? l.account : null
  const focused = document.activeElement, hadFocus = !!focused?.closest?.('#account')
  $('#account').hidden = !l.discord
  $('#account-login').hidden = !l.discord || !!a || l.pending
  $('#account-waiting').hidden = !l.pending
  $('#account-chip').hidden = !a || l.pending
  if (hadFocus) refocus(focused, [l.pending ? $('#account-cancel') : a ? $('#account-chip') : $('#account-login')])
  if (!a) return
  // No Discord picture: the first letter of the name stands in, so the chip never starts with a gap
  const pictured = avatar($('#account-avatar'), a.avatar)
  $('#account-initial').hidden = pictured
  text('#account-initial', String(a.name || '?').trim().charAt(0).toUpperCase() || '?')
  text('#account-name', a.name)
  text('#account-number', `#${a.number}`)
  const badge = $('#account-badge')
  badge.hidden = !STAFF[a.staff]
  text('#account-badge', STAFF[a.staff] || '')
  $('#account-chip').title = `Logged in with Discord as ${a.name}. Dovakarn account #${a.number}.`
  $('#account-chip').setAttribute('aria-label', `Logged in with Discord as ${a.name}, Dovakarn account #${a.number}${STAFF[a.staff] ? `, ${STAFF[a.staff]}` : ''}. Open account settings.`)
}

// The one card worth showing, most urgent first; null when nothing is wrong. main: what the gold button says and does
// for it, when the card's problem changes the next step.
function pickNotice() {
  const folder = state.gameFolder, last = state.lastCheck, c = last?.collection, gc = gameCopy()
  const choose = { label: 'Choose Skyrim folder', run: changeFolder }
  // Dovakarn's own game copy comes first: nothing plays until it is set up. The player's Skyrim is only its source, so
  // the folder and version cards below are for the test launcher, which plays from a chosen folder.
  if (gc && !gc.ready) return { tone: 'info', kind: 'Setup', title: gc.partial ? 'Finish setting up Dovakarn' : 'Set up Dovakarn',
    text: gc.partial ? `Dovakarn's game in ${gc.installDir} is missing files. Set it up again to finish it. What is already there is kept, and your own Skyrim stays as it is.`
      : `Dovakarn plays from its own copy of Skyrim in ${gc.installDir}, so your own Skyrim and its mods stay exactly as they are. It takes about 16 GB.`,
    main: working() ? null : { label: 'Set up Dovakarn', run: openSetup } }
  if (!gc && folder?.path && !folder.exe) return { tone: 'bad', kind: 'Skyrim folder', title: 'Skyrim was not found', text: `There is no SkyrimSE.exe in ${folder.path}.`, main: choose }
  // Steam's own edition is switched to the version Dovakarn runs on from Steam's downloads; any other cannot be
  if (!gc && folder?.exe && !folder.versionOk) return folder.steam
    ? { tone: 'bad', kind: 'Skyrim version', title: `Switch Skyrim to ${shortVersion(folder.required)}`, text: `This Skyrim is ${shortVersion(folder.version) || 'an unknown version'}, and Dovakarn runs on ${shortVersion(folder.required)}. The Skyrim Downgrader Tool on Nexus Mods switches it with Steam's own files. Run it, then come back here.`,
        main: { label: 'Get the Skyrim Downgrader Tool', run: openDowngrader }, secondary: ['Choose another folder', 'folder'] }
    : { tone: 'bad', kind: 'Skyrim version', title: 'This Skyrim is the wrong version', text: `It is ${folder.version || 'an unknown version'}. Dovakarn needs the Steam edition of Skyrim Special Edition, version ${shortVersion(folder.required)}.`, main: choose }
  const l = login(), a = l.loggedIn ? l.account : null
  if (l.discord && !l.pending) {
    // The gold button and the top bar both log in, so the card only explains
    if (!a) return { tone: l.error ? 'bad' : 'info', kind: 'Discord', title: 'Log in with Discord to play', text: l.error || 'Discord is how you sign up and log in. Your characters stay with your Discord account on any PC.' }
    // Blocked through a banned account's PC or network: the server gives only a general reason, and so does the title
    if (a.banned) return { tone: 'bad', kind: 'Account', title: a.banLinked ? 'This PC or network is blocked' : 'You are banned from Dovakarn', text: a.banReason || 'If you think this is a mistake, ask the staff in the Dovakarn Discord.', primary: ['Open the Dovakarn Discord', 'discord'],
      main: { label: a.banLinked ? 'Blocked from Dovakarn' : 'Banned from Dovakarn', disabled: true } }
    // Membership and the rules screen count only when this server requires the Dovakarn Discord
    const required = a.requireMembership !== false
    if (a.member === false && required) return { tone: 'bad', kind: 'Discord', title: 'Join the Dovakarn Discord', text: 'Players need to be in the Dovakarn Discord server. Join it, then press Check again.', primary: ['Check again', 'recheck'], main: { label: 'Join the Dovakarn Discord', run: openDiscord } }
    if (a.pending && required) return { tone: 'bad', kind: 'Discord', title: 'Finish the Discord rules screen', text: 'Accept the rules in the Dovakarn Discord, then press Check again.', primary: ['Check again', 'recheck'], main: { label: 'Open the Dovakarn Discord', run: openDiscord } }
  }
  if (stage === 'connecting') return { tone: 'info', kind: 'Connecting', title: 'Pick your character inside Skyrim', text: 'Choose one in the Dovakarn menu inside the game, or make a new one. Do not press New or Continue.' }
  if (launchFailed && !working()) return { tone: 'bad', kind: 'Launch', title: 'Skyrim did not start', text: launchFailed, main: { label: 'Try again', run: launch } }
  // Mods still to download from Nexus for Dovakarn's game (a "Mods" card: coming back to the launcher checks again)
  if (gc?.mods?.length) {
    const left = remainingMods().length, waiting = installWaiting()
    // Every mod downloaded: the install is waiting or running, or it never started or stopped. Then the gold button
    // installs them, so it is never left disabled with nothing on its way
    if (!left || waiting) {
      const offline = online() && !state.serverOnline, failed = !waiting && !!last?.failed
      const text = waiting ? (nexus.installing ? 'The launcher is installing them now.' : state.gameRunning ? 'Close Skyrim and the launcher installs them.' : 'The launcher installs them as soon as it is free.')
        : state.gameRunning ? 'Close Skyrim, then press Install the mods.'
        : offline ? 'Dovakarn is not answering right now. Once it is, press Install the mods.'
        : failed ? `They are downloaded, but installing them stopped: ${last.error || 'something went wrong.'} Press Install the mods to try again.`
        : "Press Install the mods to put them into Dovakarn's game."
      // A running check names its own step on the gold button; an install waiting its turn says so
      return { tone: failed ? 'bad' : 'info', kind: 'Mods', title: 'Every mod is downloaded', text, covers: failed ? last.error : null,
        main: checkRunning() ? null : waiting ? { label: 'Waiting to install the mods', disabled: true } : working() || offline ? null : { label: 'Install the mods', run: () => runCheck() } }
    }
    // Downloading by themselves (Nexus Premium): the card says so, and the gold button shows the list as they come in
    if (directRunning()) return { tone: 'info', kind: 'Mods', title: `${count(left, 'mod')} to download`,
      text: 'They are downloading from Nexus with your Premium account. Once every mod is in, the launcher installs them.',
      main: working() ? null : { label: 'Show the downloads', run: openMods } }
    // While the Nexus window is open the card says what to do there, and the gold button brings that window forward (with
    // Premium too: a press brings the open window forward rather than downloading by itself)
    if (nexus.open) return { tone: 'warn', kind: 'Mods', title: `${count(left, 'mod')} to download`,
      text: 'The Nexus window is open. Press Slow download there for each mod. Once every mod is downloaded, the launcher installs them.',
      main: working() ? null : { label: 'Show the Nexus window', run: () => getMod(null) } }
    if (nexus.premium) return { tone: 'warn', kind: 'Mods', title: `${count(left, 'mod')} to download`,
      text: 'Your Nexus Premium account downloads them for you. Press Get the mods, then Download them all. Once every mod is in, the launcher installs them.',
      main: working() ? null : { label: 'Get the mods', run: openMods } }
    return { tone: 'warn', kind: 'Mods', title: `${count(left, 'mod')} to download`,
      text: 'They come from Nexus Mods with your own Nexus account. A free one works. Press Get the mods, then Download them all, and Nexus opens inside the launcher, where you log in to Nexus once. Once every mod is downloaded, the launcher installs them.',
      main: working() ? null : { label: 'Get the mods', run: openMods } }
  }
  if (last?.failed) return { tone: 'bad', kind: 'Check', title: /could not update|did not download/i.test(last.error || '') ? 'Game files could not be updated' : 'Your game could not be checked', text: last.error || 'Something went wrong during the check.', main: working() ? null : { label: 'Check again', run: () => runCheck() } }
  // Vortex's collection page only helps where Vortex installs the mods; Dovakarn's own game gets them from the launcher
  const link = !!state.fileList?.collection?.url && !gc
  if (last?.blocked) return { tone: 'bad', kind: 'Mods', title: 'Mods needed before you can play', text: `${count(last.problems, 'mod')} missing or out of date.`,
    primary: link ? ['Get the Dovakarn collection', 'collection'] : ["See what's missing", 'verify'], secondary: link ? ["See what's missing", 'verify'] : null }
  if (c && !c.error && (c.missing || c.outdated)) {
    const all = c.missing === c.total
    return { tone: 'warn', kind: 'Mod collection', title: all ? 'Install the Dovakarn collection' : 'Update the Dovakarn collection',
      text: all ? `It has ${count(c.total, 'mod')}. You need a free Nexus Mods account and Vortex: get the collection, press Add to Vortex and let it finish. The launcher checks again when you come back.`
        : `${count(c.missing + c.outdated, 'mod')} from it ${c.missing + c.outdated === 1 ? 'is' : 'are'} missing or out of date. Update it in Vortex. The launcher checks again when you come back.`,
      primary: ['Get the Dovakarn collection', 'collection'], secondary: ["See what's missing", 'verify'] }
  }
  if (last?.problems) return { tone: 'warn', kind: 'Mods', title: 'Some mod files differ from the server', text: 'You can still play, but you may see problems.', primary: ['See details', 'verify'] }
  // Both updates at once share one card and one order: the launcher installs first, and the game files follow the
  // moment it reopens.
  const filesNeeded = state.filesUpdate?.needed && !state.gameRunning
  if (updateHeld()) return { tone: 'warn', kind: 'Launcher', title: `Launcher ${launcherUpdate.latest} is not downloaded`, text: 'You stopped the download. Dovakarn needs the new launcher before you can play: press Download launcher update to start it again.' }
  if (filesNeeded && updateReady()) return { tone: 'warn', kind: 'Updates', title: 'A launcher and game files are ready', text: `Press Update launcher: it closes and opens again by itself as ${launcherUpdate.latest}. Then Update game files fetches the rest.` }
  if (filesNeeded && updateFetching()) return { tone: 'warn', kind: 'Updates', title: 'Updates are on their way', text: 'A new launcher is downloading, and the server has new game files. The launcher comes first, then the game files.' }
  if (filesNeeded) return { tone: 'warn', kind: 'Game files', title: 'The server has new game files', text: 'Press Update game files. You can play once your files match the server.' }
  // A launcher release downloads itself; once it is verified the main button installs it in one press.
  if (updateReady()) return { tone: 'warn', kind: 'Launcher', title: `Launcher ${launcherUpdate.latest} is ready`, text: 'Downloaded and checked against the server. Press Update launcher: it closes and opens again by itself, and then you can play.' }
  if (launcherUpdate?.blocked) return { tone: 'warn', kind: 'Launcher', title: 'Get the new launcher from Discord', text: launcherUpdate.blockedMessage || 'The in-app update did not work on this PC.', primary: ['Open the Dovakarn Discord', 'discord'] }
  // Online fixes to mod files that setting up this PC's server could not make: said until they are sorted, never blocking
  const unfixed = last?.unfixed?.length || 0
  if (unfixed) return { tone: 'warn', kind: 'Server', title: unfixed === 1 ? 'A mod fix could not be made' : `${unfixed} mod fixes could not be made`,
    text: `Players do not get ${unfixed === 1 ? 'it' : 'them'} until ${unfixed === 1 ? 'it is' : 'they are'} sorted. You can still play.`, primary: ['See details', 'verify'] }
  // Nothing wrong: the screen stays quiet.
  return null
}
function showNotice() {
  const before = shown, focused = notice.contains(document.activeElement) ? document.activeElement : null
  const n = shown = pickNotice()
  notice.hidden = !n || progressVisible
  syncMessage()
  // A card button that goes away, or now does something else, hands keyboard focus to the main button, or to the
  // top bar's Cancel or Log in while the main button waits
  if (focused && (!n || n.title !== before?.title)) [play, $('#account-cancel'), $('#account-login')].find(b => !b.disabled && !b.closest('[hidden]'))?.focus()
  if (!n) return
  notice.className = `notice notice--${n.tone}`
  notice.dataset.kind = n.kind
  text('#notice-title', n.title); text('#notice-text', n.text)
  // A card without a button only explains: the gold button below carries the action.
  noticeActions = { primary: n.primary?.[1], secondary: n.secondary?.[1] }
  noticePrimary.hidden = !n.primary
  text('#notice-primary', n.primary ? n.primary[0] : '')
  noticeSecondary.hidden = !n.secondary
  text('#notice-secondary', n.secondary ? n.secondary[0] : '')
}

// Progress: the one bar for the launcher's own update and for a check's steps. The launcher's update comes first,
// since Play waits for it. A check that finishes within a moment never shows the card at all.
let progressVisible = false, progressKey = null, progressSince = 0, stepSince = 0, progressTimer = null, samples = []
function progressNow() {
  const version = launcherUpdate?.latest || ''
  if (updateStep && (updateRunning || downloadingVersion)) {
    if (updateStep.phase === 'install') return { key: 'install', now: true, title: `Installing launcher ${version}`.trim(), percent: null, detail: 'The launcher closes now and opens again by itself.' }
    const total = updateStep.total, received = updateStep.received || 0
    return { key: 'download', now: updateRunning, title: `Downloading launcher ${version}`.trim(), percent: total ? Math.min(99, Math.floor(received / total * 100)) : null,
      detail: total ? sizes(received, total) : received ? `${(received / 1024 ** 2).toFixed(1)} MB downloaded` : 'Starting the download...', received, bytes: total }
  }
  if (!checkRunning() || !CHECK_STEPS.includes(stage)) return null
  const m = meter
  if (stage === 'updatingFiles') return { key: 'files', title: 'Updating game files', percent: m ? m.percent : null,
    detail: m ? `File ${m.done} of ${m.total}${m.bytes ? ` · ${sizes(m.received, m.bytes)}` : ''}` : '', received: m?.received, bytes: m?.bytes }
  if (stage === 'patchingFiles') return { key: 'patch', title: 'Fitting your mods to the server', percent: m ? m.percent : null, detail: m ? `File ${m.done} of ${m.total}` : '' }
  // Dovakarn's own game copy: Skyrim 1.6.1170 copied in, then the mods unpacked into it
  if (stage === 'copyingGame') return { key: 'copy', title: 'Copying Skyrim 1.6.1170', percent: m ? m.percent : null,
    detail: m ? `File ${m.done} of ${m.total}${m.bytes ? ` · ${sizes(m.received, m.bytes)}` : ''}` : '', received: m?.received, bytes: m?.bytes }
  if (stage === 'installingMods') return { key: 'mods', title: 'Installing mods', percent: m ? m.percent : null, detail: m ? `Download ${m.done} of ${m.total}` : '' }
  if (stage === 'checking' && !m && /mod collection/i.test(message.textContent)) return { key: 'collection', title: 'Checking the mod collection on Nexus', percent: null, detail: '' }
  if (stage === 'checking') return { key: 'check', title: 'Checking your game files', percent: m ? m.percent : null, detail: m?.bytes ? `${sizes(m.received, m.bytes)} checked` : '', received: m?.received, bytes: m?.bytes }
  // Setting up or contacting the server: no measure, so the bar only shows that something is happening
  return { key: 'server', title: message.textContent.replace(/...$/, ''), percent: null, detail: '' }
}
// Cancel stops what the card shows: a check, a game-file update, or the launcher's download. Setting up the server and
// installing the launcher run to the end.
const CANCELLABLE = ['check', 'files', 'patch', 'collection', 'download', 'copy', 'mods']
// What Cancel is stopping ('download' or 'files') until that run ends: its button says Stopping and takes no second press
let stopping = null
const kindOf = key => key === 'download' ? 'download' : 'files'
async function cancelProgress() {
  const card = progressNow()
  if (!card || !CANCELLABLE.includes(card.key) || stopping === kindOf(card.key)) return
  stopping = kindOf(card.key); renderProgress()
  // The run that stops ends by itself, which takes the card away: nothing more to do here
  if (card.key === 'download') { updateStopped = launcherUpdate?.latest || null; await window.localPlay.update.cancel().catch(() => {}) }
  else await window.localPlay.cancel().catch(() => {})
}
$('#progress-cancel').addEventListener('click', cancelProgress)
// Time left from the last five seconds of bytes, said only once it is worth saying
function timeLeft(card) {
  if (!card.bytes || !Number.isFinite(card.received)) return ''
  const now = Date.now()
  samples.push({ at: now, received: card.received })
  samples = samples.filter(s => now - s.at <= 5000)
  if (now - stepSince < 3000 || samples.length < 2) return ''
  const first = samples[0], rate = (card.received - first.received) / ((now - first.at) / 1000)
  if (!(rate > 0)) return ''
  const left = (card.bytes - card.received) / rate
  if (left <= 10) return ''
  return left < 90 ? `About ${Math.max(10, Math.round(left / 10) * 10)} seconds left` : `About ${Math.round(left / 60)} minute${Math.round(left / 60) === 1 ? '' : 's'} left`
}
function renderProgress() {
  const card = progressNow(), key = card ? card.key : null
  if (key !== progressKey) {
    // The moment of grace (a quick check never flashes the card) runs from when the work began, not from each step,
    // so the card never blinks out between steps
    if (!progressKey) progressSince = Date.now()
    if (!key) stopping = null
    progressKey = key; stepSince = Date.now(); samples = []
    clearTimeout(progressTimer)
    if (card && !card.now && !progressVisible) progressTimer = setTimeout(renderProgress, Math.max(20, 820 - (Date.now() - progressSince)))
  }
  const visible = !!card && (card.now || progressVisible || Date.now() - progressSince >= 800)
  // Keyboard focus on Cancel moves to the gold button when the card goes, or when Cancel no longer applies
  const cancel = $('#progress-cancel'), cancelFocused = document.activeElement === cancel
  if (visible !== progressVisible) {
    progressVisible = visible
    progressCard.hidden = !visible
    // One story at a time: the card replaces the notice, the status line (still read aloud) and the player gauge
    notice.hidden = visible || !shown
    message.classList.toggle('quiet', visible)
    syncCapacity()
    syncPlay()
  }
  cancel.hidden = !visible || !CANCELLABLE.includes(card.key)
  if (cancelFocused && cancel.hidden) [play, $('#settings-open')].find(b => !b.disabled && !b.closest('[hidden]'))?.focus()
  if (!visible) return
  const halted = !!stopping && stopping === kindOf(card.key)
  cancel.disabled = halted
  text('#progress-cancel', halted ? 'Stopping...' : 'Cancel')
  text('#progress-title', card.title)
  text('#progress-detail', card.detail || '')
  text('#progress-eta', timeLeft(card))
  const known = Number.isFinite(card.percent)
  progressTrack.classList.toggle('indeterminate', !known)
  if (known) {
    progressTrack.querySelector('i').style.setProperty('--p', String(card.percent / 100))
    progressTrack.setAttribute('aria-valuenow', String(card.percent))
    progressTrack.setAttribute('aria-valuetext', `${card.percent} percent${card.detail ? `. ${card.detail}` : ''}`)
  } else {
    progressTrack.removeAttribute('aria-valuenow')
    progressTrack.setAttribute('aria-valuetext', card.detail || 'Working')
  }
  text('#progress-pct', known ? `${card.percent}%` : '')     // text() sets the % in its own span
}
// The players' gauge: who is in the world against its limit, the count on the bar's own row. Hidden while an update's
// bar is on screen; with no limit known, the count stands alone.
function syncCapacity() {
  const population = $('#population'), capacity = $('#capacity'), srv = state?.server
  population.hidden = progressVisible || !state?.serverOnline || !srv
  if (population.hidden) return
  const n = playerCount(srv), max = Number.isFinite(srv.max) && srv.max > 0 ? srv.max : null
  text('#population-now', n.toLocaleString())
  $('#population-of').hidden = !max
  text('#population-max', max ? max.toLocaleString() : '')
  capacity.hidden = !max
  if (!max) return
  $('#capacity-fill').style.setProperty('--p', String(n > 0 ? Math.max(Math.min(100, n / max * 100), 1.5) / 100 : 0))
  capacity.setAttribute('aria-valuemax', String(max))
  capacity.setAttribute('aria-valuenow', String(n))
  capacity.setAttribute('aria-valuetext', `${n} of ${max} players in the world`)
}

// A list of [ok, label] as ticks and crosses
const ticks = rows => rows.map(([ok, label]) => { const li = document.createElement('li'); li.className = ok ? 'ok' : 'bad'; li.innerHTML = ok ? TICK : CROSS; li.append(label); return li })
const NEXUS_LOGOUT_WAIT = 'You can log out once the current download finishes.'
// Lucide folder, as on the Dovakarn and Skyrim folder rows
const FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>'
// Settings, Mods: the folders the player named for their mods' downloads (the mods window's "My mods are in another
// folder"), each with Forget. Redrawn only when the list changes, so keyboard focus stays on its row
let foldersDrawn = ''
function renderFolders(folders) {
  $('#folders-section').hidden = !folders.length
  const signature = JSON.stringify(folders)
  if (signature === foldersDrawn) return
  foldersDrawn = signature
  const list = $('#mods-folders'), focused = list.contains(document.activeElement) ? document.activeElement.dataset.dir : undefined
  list.replaceChildren(...folders.map(dir => {
    const li = document.createElement('li'), where = document.createElement('div'), name = document.createElement('span'), forget = document.createElement('button')
    li.className = 'field-row'; where.className = 'folder-path'; where.innerHTML = FOLDER
    name.textContent = dir; name.title = dir; where.append(name)
    forget.className = 'secondary'; forget.textContent = 'Forget'; forget.dataset.dir = dir; forget.setAttribute('aria-label', `Forget ${dir}`)
    li.append(where, forget)
    return li
  }))
  // Keyboard focus stays on its row, or goes to the next Forget, or back to the Mods tab when none is left
  if (focused !== undefined) ([...list.querySelectorAll('button[data-dir]')].find(b => b.dataset.dir === focused) || list.querySelector('button[data-dir]') || settings.querySelector('[role=tab][aria-selected=true]'))?.focus()
}
// Settings: every detail lives here instead of on the main screen.
function showSettings() {
  // Opened before the launcher has answered: it says so instead of showing guesses.
  settings.querySelector('.modal-box').classList.toggle('loading', !state)
  $('#settings-loading').hidden = !!state
  // The folder cannot change under a running check or game; Check now always opens the checklist.
  const folderChange = $('#folder-change')
  folderChange.disabled = !canCheck()
  folderChange.title = !folderChange.disabled ? '' : state?.gameRunning ? 'Close Skyrim to change the folder.' : 'You can change the folder when the current check finishes.'
  if (!state) return
  const folder = state.gameFolder || {}, list = state.fileList || null, last = state.lastCheck, c = last?.collection, v = list?.version
  const gc = gameCopy()
  // Dovakarn's own game, and the player's Skyrim as only its source; the test launcher shows the folder it plays from
  $('#copy-section').hidden = !gc
  text('#folder-heading', gc ? 'Your Skyrim' : 'Skyrim folder')
  $('#folder-note').hidden = !gc
  text('#folder-note', gc ? 'Dovakarn only reads it, to copy Skyrim 1.6.1170 from. Its files, mods and load order are never changed.' : '')
  if (gc) {
    text('#copy-path', gc.ready ? gc.gameDir : `${gc.installDir}, not set up yet`, gc.gameDir)
    $('#copy-ticks').replaceChildren(...ticks(!gc.ready ? [[false, 'Not set up yet']] : [
      [folder.exe && folder.versionOk, 'Skyrim 1.6.1170'], [folder.skse, folder.skse ? 'Script extender' : 'Script extender missing'],
      [!gc.mods?.length, !gc.mods?.length ? 'Mods installed' : remainingMods().length ? `${count(remainingMods().length, 'mod')} to download` : 'Every mod downloaded, not installed yet']]))
    text('#copy-note', gc.ready ? 'Its own load order and game settings are kept in its Dovakarn Profile folder, apart from yours.' : '')
    $('#copy-open').disabled = !gc.chosen
    $('#copy-remove').disabled = !gc.chosen || !canCheck()
    $('#copy-remove').title = !gc.chosen || nexus.removing || nexus.removeAsking ? '' : state.gameRunning ? 'Close Skyrim first.' : installWaiting() ? 'You can remove it once the mods are installed.'
      : working() ? 'You can remove it when the current check finishes.' : ''
    $('#copy-setup-row').hidden = gc.ready
    text('#folder-path', gc.steamDir || 'Not found', gc.steamDir || '')
    const changed = gc.steamChanged?.length || 0
    $('#folder-ticks').replaceChildren(...ticks(gc.steamDir ? [[true, gc.steamReady ? 'Skyrim 1.6.1170'
      : changed ? `Skyrim 1.6.1170, with ${count(changed, 'file')} a mod changed: Dovakarn uses Steam's 1.6.1170 download`
      : "A newer Skyrim: Dovakarn uses Steam's 1.6.1170 download"]] : []))
    $('#folder-switch-row').hidden = true
    $('#restore-row').hidden = !gc.oldInstall
  } else {
    text('#folder-path', folder.path || 'Not set', folder.path || '')
    $('#folder-ticks').replaceChildren(...ticks([
      [folder.exe && folder.versionOk, folder.exe ? `SkyrimSE.exe ${folder.version || ''}`.trim() : 'SkyrimSE.exe missing'],
      [folder.skse, folder.skse ? 'Script extender' : 'Script extender missing'],
    ]))
    $('#folder-switch-row').hidden = !(folder.exe && !folder.versionOk && folder.steam)
    $('#restore-row').hidden = true
  }
  text('#folder-switch', 'Get the Skyrim Downgrader Tool')
  const srv = state.server || { uptime: null, players: [], max: 8 }
  text('#server-name', srv.name || 'Dovakarn')
  text('#server-address', srv.address || '')
  // Status says whether the world is up and for how long; who is in it belongs to the Players row alone.
  text('#server-status', state.serverOnline ? (srv.uptime === null ? 'Running' : `Running, ${uptime(srv.uptime)}`) : online() ? 'Not answering right now' : 'Starts when you play')
  text('#server-players', !state.serverOnline ? 'Server offline' : srv.players.length ? names(srv.players) : playerCount(srv) ? `${count(playerCount(srv), 'player')} in the world` : 'Nobody online yet', srv.players.join(', '))
  const link = gc ? '' : list?.collection?.url
  text('#mods-heading', gc ? 'Mods' : 'Mod collection')
  text('#updates-files-note', gc ? "Your game files and Dovakarn's mods are checked every time the launcher opens and again before every game. Anything that changed is fixed for you or shown on the main screen." : 'Your game files and the mod collection are checked every time the launcher opens and again before every game. Anything that changed is fixed for you or shown on the main screen.')
  text('#mods-collection', gc ? (!gc.ready ? 'Installed once Dovakarn is set up.' : !gc.mods?.length ? 'Installed by the launcher from Nexus Mods.'
    : remainingMods().length ? `${count(remainingMods().length, 'mod')} to download from Nexus Mods.` : `Every mod is downloaded. ${downloadedNext()}`)
    : !link ? 'The server has not set a collection link yet.' : !c ? 'Not checked yet.' : c.error ? `Could not check Nexus: ${c.error}`
    : c.missing === c.total ? `Not installed. It has ${count(c.total, 'mod')}.` : c.missing + c.outdated ? `${count(c.missing + c.outdated, 'mod')} missing or out of date.` : `Installed, ${count(c.total, 'mod')}.`)
  $('#mods-get').disabled = !link
  $('#mods-get').hidden = !!gc
  // The Nexus login the launcher's Nexus window keeps on this PC: always visible with Dovakarn's game, so it can be
  // logged out of long after every mod is in. Log out shows whenever there may be a login to forget: logged in (with or
  // without a name Nexus showed), or not known either way while the window's session keeps something on this PC
  $('#nexus-section').hidden = !gc
  if (gc) renderNexusMe()
  if (gc) {
    const account = nexus.account, who = account.user, logout = $('#nexus-logout'), hadFocus = document.activeElement === logout
    const loggedIn = account.login === 'in', maybe = account.login === 'unknown' && account.kept, offered = loggedIn || maybe
    text('#nexus-account', loggedIn ? `The Nexus window is logged in${who ? ` as ${who}` : ''}. The launcher keeps that login on this PC until you press Log out of the Nexus window.`
      : maybe ? 'The Nexus window may still be logged in to Nexus on this PC. Press Log out of the Nexus window to be sure it is not.'
      : 'The Nexus window is not logged in. You log in there when you download the mods in it.')
    const busy = Object.values(nexus.archives).some(a => a.state === 'downloading' || a.state === 'checking')
    $('#nexus-logout-row').hidden = !offered
    logout.disabled = busy
    logout.title = busy ? NEXUS_LOGOUT_WAIT : ''
    // Why it is greyed out, said on the page itself, not only in a tooltip
    $('#nexus-logout-why').hidden = !offered || !busy
    // Logged out: keyboard focus goes back to the Mods tab rather than to nothing
    if (hadFocus && !offered) settings.querySelector('[role=tab][aria-selected=true]')?.focus()
  }
  // Folders the player named for their mods' downloads, each with Forget
  renderFolders(gc && Array.isArray(gc.modsFolders) ? gc.modsFolders.filter(d => typeof d === 'string' && d) : [])
  $('#mods-details').hidden = !filesView
  text('#mods-list', list ? `The server lists ${count(list.files, 'file')} from ${count(list.mods.length, 'mod')}${list.generatedAt ? `, updated ${when(list.generatedAt)}` : ''}.` : 'The server has not published its file list yet.')
  text('#mods-last', !last ? 'Not checked yet.' : last.failed ? `Last check failed at ${clock(last.at)}.` : !last.published ? `Checked at ${clock(last.at)}: the server lists no files.`
    : last.problems ? `Checked at ${clock(last.at)}: ${modsVerb(last.problems, last.blocked)}.` : `Checked at ${clock(last.at)}: all files match.`)
  // Plain version convention only: the tag, nothing about how many commits sit past it.
  text('#updates-version', !v ? 'The server has not published a version yet.' : v.tag ? `${v.tag}, released ${day(v.date)}.` : `A test build from ${day(v.date)}, before the first release.`)
  text('#updates-launcher', state.launcherVersion ? `Version ${state.launcherVersion}.` : 'Unknown')
  text('#launcher-version', state.launcherVersion ? `Launcher ${state.launcherVersion}` : '')
  renderControls()

  // Account: the Discord login behind this launcher, and how to switch or leave
  const l = login(), a = l.loggedIn ? l.account : null, focused = document.activeElement
  $('#account-card').hidden = !a
  $('#account-facts').hidden = !a
  $('#account-number-note').hidden = !a
  $('#account-settings-login').hidden = !l.discord || !!a || l.pending
  $('#account-discord').hidden = !l.discord
  $('#account-logout').hidden = !a
  // Focus on a button this hid (Log in while the browser login runs, Log out) moves to its replacement, else the open tab
  if (settings.contains(focused)) refocus(focused, [$('#account-settings-login'), $('#account-logout'), settings.querySelector('[role=tab][aria-selected=true]')])
  text('#account-note', !l.discord ? `This test server runs without Discord login, so this launcher plays as test profile ${l.testProfile || 1}.`
    : l.pending ? 'Finish logging in with Discord in your browser. This window updates by itself. If Discord shows an error page instead, press Cancel and tell the server owner.'
    : !a ? (l.error || 'Not logged in. Discord is how you sign up and log in, and your characters stay with your Discord account on any PC.')
    : 'Your characters belong to this Discord account. Log out to use another one on this PC.')
  if (!a) return
  avatar($('#account-card-avatar'), a.avatar)
  text('#account-card-name', a.name)
  text('#account-card-line', a.username ? `@${a.username} on Discord` : 'Discord account')
  text('#account-fact-number', `#${a.number}`)
  text('#account-fact-member', a.member === true ? (a.pending ? 'Joined, rules not accepted yet' : 'Member') : a.member === false ? 'Not a member yet' : 'Could not check right now')
  // Staff see their level; players see nothing about staff at all
  $('#account-fact-staff-row').hidden = !STAFF[a.staff]
  text('#account-fact-staff', STAFF[a.staff] || '')
  text('#account-fact-slots', `Up to ${a.slots}`)
}

// Controls: the mod keys a player may bind (the server lists them; every other mod setting stays the server's). Keys are
// DirectX scan codes as SKSE mods read them: 1 to 255 the keyboard, 256 and up the mouse, -1 no key.
const KEY_NAMES = {
  1: 'Esc', 2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0', 12: 'Minus', 13: 'Equals', 14: 'Backspace', 15: 'Tab',
  16: 'Q', 17: 'W', 18: 'E', 19: 'R', 20: 'T', 21: 'Y', 22: 'U', 23: 'I', 24: 'O', 25: 'P', 26: 'Left bracket', 27: 'Right bracket', 28: 'Enter',
  29: 'Left Ctrl', 30: 'A', 31: 'S', 32: 'D', 33: 'F', 34: 'G', 35: 'H', 36: 'J', 37: 'K', 38: 'L', 39: 'Semicolon', 40: 'Apostrophe', 41: 'Console key',
  42: 'Left Shift', 43: 'Backslash', 44: 'Z', 45: 'X', 46: 'C', 47: 'V', 48: 'B', 49: 'N', 50: 'M', 51: 'Comma', 52: 'Full stop', 53: 'Slash',
  54: 'Right Shift', 55: 'Num *', 56: 'Left Alt', 57: 'Space', 58: 'Caps Lock', 59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6', 65: 'F7',
  66: 'F8', 67: 'F9', 68: 'F10', 69: 'Num Lock', 70: 'Scroll Lock', 71: 'Num 7', 72: 'Num 8', 73: 'Num 9', 74: 'Num -', 75: 'Num 4', 76: 'Num 5',
  77: 'Num 6', 78: 'Num +', 79: 'Num 1', 80: 'Num 2', 81: 'Num 3', 82: 'Num 0', 83: 'Num .', 86: 'Extra backslash', 87: 'F11', 88: 'F12',
  156: 'Num Enter', 157: 'Right Ctrl', 181: 'Num /', 183: 'Print Screen', 184: 'Right Alt', 197: 'Pause', 199: 'Home', 200: 'Up arrow', 201: 'Page Up',
  203: 'Left arrow', 205: 'Right arrow', 207: 'End', 208: 'Down arrow', 209: 'Page Down', 210: 'Insert', 211: 'Delete', 219: 'Left Windows',
  220: 'Right Windows', 221: 'Menu key', 256: 'Left mouse', 257: 'Right mouse', 258: 'Middle mouse', 259: 'Mouse 4', 260: 'Mouse 5', 261: 'Mouse 6',
  262: 'Mouse 7', 263: 'Mouse 8', 264: 'Wheel up', 265: 'Wheel down', 266: 'D-pad up', 267: 'D-pad down', 268: 'D-pad left', 269: 'D-pad right',
  270: 'Start', 271: 'Back', 272: 'Left stick', 273: 'Right stick', 274: 'Left bumper', 275: 'Right bumper', 276: 'A button', 277: 'B button',
  278: 'X button', 279: 'Y button', 280: 'Left trigger', 281: 'Right trigger',
}
const keyName = code => code === -1 ? 'No key' : KEY_NAMES[code] || `Key ${code}`
// The key pressed (KeyboardEvent.code) as the scan code Skyrim reads
const SCAN_CODES = {
  Escape: 1, Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6, Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11, Minus: 12, Equal: 13,
  Backspace: 14, Tab: 15, KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20, KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25, BracketLeft: 26,
  BracketRight: 27, Enter: 28, ControlLeft: 29, KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34, KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43, KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54, NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58, F1: 59, F2: 60, F3: 61, F4: 62,
  F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68, NumLock: 69, ScrollLock: 70, Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83, IntlBackslash: 86,
  F11: 87, F12: 88, NumpadEnter: 156, ControlRight: 157, NumpadDivide: 181, PrintScreen: 183, AltRight: 184, Pause: 197, Home: 199, ArrowUp: 200,
  PageUp: 201, ArrowLeft: 203, ArrowRight: 205, End: 207, ArrowDown: 208, PageDown: 209, Insert: 210, Delete: 211, MetaLeft: 219, MetaRight: 220,
  ContextMenu: 221,
}
// Mouse buttons (MouseEvent.button) as scan codes; the left button is not offered, since it clicks this page
const MOUSE_CODES = { 1: 258, 2: 257, 3: 259, 4: 260 }
const controlsGroups = $('#controls-groups'), controlsStatus = $('#controls-status')
// The key being changed: { id, label } while the row waits for a key; the 2 second refresh leaves the rows alone then
let capturing = null, controlsDrawn = ''
const keyList = () => state?.fileList?.keys || []
const keyValue = k => Object.prototype.hasOwnProperty.call(state?.keyChoices || {}, k.id) ? state.keyChoices[k.id] : k.default
const chosen = k => Object.prototype.hasOwnProperty.call(state?.keyChoices || {}, k.id)
// Every other key on the same key and used in the same place: in play, or only inside the game's menus (SkyUI's). Keys of
// every mod and Dovakarn's own count, the server's too; only a mod's own keys inside its menus may share one (SkyUI's
// work in different menus) until the player chooses one of them. A key used in play is also told about Skyrim's own
// controls on it and about the keys other mods keep (SKSE Menu Framework's menu).
function clashes(k, keys) {
  const value = keyValue(k)
  if (value === -1) return []
  const same = keys.filter(o => o.id !== k.id && keyValue(o) === value && !!o.inMenus === !!k.inMenus && (!k.inMenus || o.mod !== k.mod || chosen(k) || chosen(o)))
    .map(o => o.mod === k.mod ? o.label : `${o.label} (${o.mod})`)
  if (k.inMenus) return same
  const controls = state?.gameControls?.[value]
  const game = Array.isArray(controls) ? controls.map(name => `the game's ${name}`) : []
  const fixed = (state?.fileList?.fixedKeys || []).filter(f => f.code === value).map(f => `${f.label} (${f.mod})`)
  return [...same, ...game, ...fixed]
}
// The game's cursor key also locks the cursor again while the chat has focus, but never on a key that types there
// (skymp5-client browserService.ts typesText, the same keys): letters, digits, punctuation, space and the numpad's
const CURSOR_KEY = 'game|freeCursorKeyCode'
const typesText = code => (code >= 2 && code <= 13) || (code >= 16 && code <= 27) || (code >= 30 && code <= 41) || (code >= 43 && code <= 53) ||
  code === 55 || code === 57 || (code >= 71 && code <= 83) || code === 86 || code === 181
function renderControls({ force = false } = {}) {
  const keys = keyList(), signature = JSON.stringify([keys, state?.keyChoices || {}, state?.gameControls || {}, state?.fileList?.fixedKeys || []])
  $('#controls-actions').hidden = !keys.length
  if (!keys.length) {
    capturing = null
    text('#controls-intro', !state?.fileList ? 'The server has not published its file list yet.' : 'This server has no mod keys to change. Every mod setting is set by the server.')
    controlsGroups.replaceChildren(); controlsDrawn = ''
    return
  }
  text('#controls-intro', 'Keys for Dovakarn and the mods it uses. Every other mod setting is set by the server, and the launcher puts it back if it changes. Your keys are applied the next time you press Play.')
  $('#controls-reset').disabled = !Object.keys(state?.keyChoices || {}).some(id => keys.some(k => k.id === id))
  if (!force && (capturing || signature === controlsDrawn)) return
  controlsDrawn = signature
  const focusedId = controlsGroups.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : null
  const focusedRole = document.activeElement?.dataset?.role
  const mods = [...new Set(keys.map(k => k.mod))]
  controlsGroups.replaceChildren(...mods.map(mod => {
    const group = document.createElement('section'), heading = document.createElement('h3'), list = document.createElement('ul')
    group.className = 'controls-group'; heading.textContent = mod; list.className = 'controls'
    list.replaceChildren(...keys.filter(k => k.mod === mod).map(k => {
      const value = keyValue(k), changed = value !== k.default, waiting = capturing?.id === k.id, clash = clashes(k, keys)
      const row = document.createElement('li'), label = document.createElement('div'), name = document.createElement('span'), cap = document.createElement('kbd')
      row.className = `control${changed ? ' control--changed' : ''}${waiting ? ' control--waiting' : ''}`; row.dataset.id = k.id
      name.className = 'control-label'; name.textContent = k.label; label.append(name)
      // What the server gives this key, once the player has chosen another
      if (changed) { const note = document.createElement('span'); note.className = 'control-note'; note.textContent = `Server key: ${keyName(k.default)}`; label.append(note) }
      if (clash.length) { const note = document.createElement('span'); note.className = 'control-note control-note--clash'; note.textContent = `Also used by ${listed(clash)}`; label.append(note) }
      if (k.id === CURSOR_KEY && typesText(value)) { const note = document.createElement('span'); note.className = 'control-note control-note--clash'; note.textContent = 'Types in the chat, so press Esc to lock the cursor again'; label.append(note) }
      cap.className = `keycap${value === -1 ? ' keycap--none' : ''}`; cap.textContent = waiting ? 'Press a key' : keyName(value)
      const actions = document.createElement('div'); actions.className = 'control-actions'
      const button = (role, textValue, className, aria) => { const b = document.createElement('button'); b.className = className; b.dataset.role = role; b.textContent = textValue; b.setAttribute('aria-label', aria); return b }
      // Cancel sits where Change was
      if (waiting) actions.append(button('cancel', 'Cancel', 'secondary', `Stop changing ${k.label}`), button('none', 'No key', 'link', `${k.label}: no key`))
      else {
        actions.append(button('change', 'Change', 'secondary', `Change ${k.label}, now ${keyName(value)}`))
        if (changed) actions.append(button('reset', 'Reset', 'link', `Reset ${k.label} to the server key, ${keyName(k.default)}`))
      }
      row.append(label, cap, actions)
      return row
    }))
    group.append(heading, list)
    return group
  }))
  // Keyboard focus stays on the same row: its first button, or the one it was on
  if (focusedId) {
    const row = [...controlsGroups.querySelectorAll('[data-id]')].find(r => r.dataset.id === focusedId)
    ;(row?.querySelector(`[data-role="${focusedRole}"]`) || row?.querySelector('button'))?.focus()
  }
}
function startCapture(k) {
  capturing = { id: k.id, label: k.label }
  text('#controls-status', `Press the key or mouse button for ${k.label}. Esc cancels.`)
  renderControls({ force: true })
  controlsGroups.querySelector(`.control--waiting [data-role="cancel"]`)?.focus()
}
// refocus: false when the player left the tab or Settings, where focus follows their click instead
function endCapture(line = '', { refocus = true } = {}) {
  const was = capturing
  capturing = null
  text('#controls-status', line)
  renderControls({ force: true })
  if (was && refocus) [...controlsGroups.querySelectorAll('[data-id]')].find(r => r.dataset.id === was.id)?.querySelector('[data-role="change"]')?.focus()
}
// Saves the player's key (null: the server's key again); the launcher keeps it and writes it at the next Play
async function setKey(k, code) {
  const back = code === null || code === k.default
  let result
  try { result = await window.localPlay.controls.set(k.id, back ? null : code) } catch (error) { result = { success: false, error: error.message } }
  if (!result.success) return endCapture(result.error || 'That key could not be saved.')
  state.keyChoices = { ...(state.keyChoices || {}) }
  if (back) delete state.keyChoices[k.id]; else state.keyChoices[k.id] = code
  const now = back ? k.default : code
  endCapture(`${k.label}: ${keyName(now)}${back ? ', the server key' : ''}. Applied the next time you press Play.`)
  refresh()
}
function captured(code) {
  const k = keyList().find(x => x.id === capturing?.id)
  if (!k) return endCapture()
  setKey(k, code)
}
// While a row waits, every key and mouse button goes to it: nothing else on the page reacts (Tab, Escape closing Settings)
window.addEventListener('keydown', event => {
  if (!capturing) return
  event.preventDefault(); event.stopPropagation()
  if (event.repeat) return
  if (event.code === 'Escape') return endCapture('')
  const code = SCAN_CODES[event.code]
  if (code === undefined) { text('#controls-status', 'Skyrim cannot use that key. Press another, or Esc to cancel.'); return }
  captured(code)
}, true)
// Print Screen reaches the page only as it is let go
window.addEventListener('keyup', event => {
  if (!capturing) return
  event.preventDefault(); event.stopPropagation()
  if (event.code === 'PrintScreen') captured(183)
}, true)
window.addEventListener('mousedown', event => {
  if (!capturing) return
  // The left button works the page: the row's own No key and Cancel, or anywhere else to stop
  if (event.button === 0) { if (!event.target.closest?.('.control--waiting .control-actions')) endCapture('', { refocus: false }); return }
  event.preventDefault(); event.stopPropagation()
  if (MOUSE_CODES[event.button]) captured(MOUSE_CODES[event.button])
}, true)
for (const type of ['auxclick', 'contextmenu', 'mouseup']) window.addEventListener(type, event => { if (capturing && event.button !== 0) { event.preventDefault(); event.stopPropagation() } }, true)
window.addEventListener('wheel', event => {
  if (!capturing || !event.deltaY) return
  event.preventDefault(); event.stopPropagation()
  captured(event.deltaY < 0 ? 264 : 265)
}, { capture: true, passive: false })
controlsGroups.addEventListener('click', event => {
  const b = event.target.closest('button[data-role]'), id = b?.closest('[data-id]')?.dataset.id, k = keyList().find(x => x.id === id)
  if (!k) return
  if (b.dataset.role === 'change') startCapture(k)
  else if (b.dataset.role === 'cancel') endCapture('')
  else if (b.dataset.role === 'none') setKey(k, -1)
  else if (b.dataset.role === 'reset') setKey(k, null)
})
$('#controls-reset').addEventListener('click', async () => {
  let result
  try { result = await window.localPlay.controls.reset() } catch (error) { result = { success: false, error: error.message } }
  if (!result.success) return text('#controls-status', result.error || 'The keys could not be reset.')
  state.keyChoices = {}
  capturing = null
  text('#controls-status', 'Every key is back to the server key. Applied the next time you press Play.')
  renderControls({ force: true })
  refresh()
})

// Verify: problems first, in the order a player would fix them; everything that passed folds into one line.
function fileProblem(mod) {
  const parts = []
  if (mod.missing) parts.push(`${count(mod.missing, 'file')} missing`)
  if (mod.changed) parts.push(`${count(mod.changed, 'file')} out of date`)
  return `${mod.name}: ${parts.join(', ')}`
}
function checkItems() {
  const folder = state.gameFolder || {}, last = state.lastCheck, c = last?.collection, view = filesView, items = [], gc = gameCopy()
  // Dovakarn's own game: set up or not, and the mods still to download; Vortex's collection does not apply to it
  if (gc) {
    items.push(gc.ready ? { tone: 'ok', title: "Dovakarn's game", text: `Skyrim 1.6.1170 in ${gc.gameDir}.` }
      : { tone: 'bad', title: "Dovakarn's game", text: 'Not set up yet. Press Set up Dovakarn on the main screen.' })
    // Each needed download as the mods window shows it: Download, Show while it runs, Wrong file, Did not download,
    // and Downloaded with a tick once it is in
    const left = remainingMods()
    if (gc.ready && gc.mods?.length) items.push(left.length ? { tone: 'warn', title: 'Mods', text: `${count(left.length, 'mod')} to download from Nexus Mods.`, list: gc.mods.map(m => ({ text: m.name, archive: m.id, download: downloadRow(m) })) }
      : { tone: 'idle', title: 'Mods', text: `Every mod is downloaded. ${downloadedNext()}` })
    else if (gc.ready && last && !last.failed && !last.setup) items.push({ tone: 'ok', title: 'Mods', text: 'All installed.' })
  } else items.push(!folder.exe ? { tone: 'bad', title: 'Skyrim folder', text: `There is no SkyrimSE.exe in ${folder.path || 'the chosen folder'}.` }
    : folder.skse ? { tone: 'ok', title: 'Skyrim folder', text: 'Found, with the script extender in place.' }
    : { tone: 'warn', title: 'Skyrim folder', text: 'Found, but the script extender, skse64_loader.exe, is missing. It comes with the Dovakarn collection.' })
  if (!gc && folder.exe) items.push(folder.versionOk ? { tone: 'ok', title: 'Skyrim version', text: `${folder.version}, the build Dovakarn is made for.` }
    : { tone: 'bad', title: 'Skyrim version', text: `${folder.version || 'Unknown'}. Dovakarn needs ${folder.required}.${folder.steam ? ' The Skyrim Downgrader Tool on Nexus Mods switches it: see the main screen.' : ''}` })
  const fileRows = (view?.mods || []).filter(m => !m.state)
  items.push(checkRunning() ? { tone: 'idle', title: 'Game files', text: 'Checking...' }
    : !last ? { tone: 'idle', title: 'Game files', text: 'Not checked yet.' }
    : last.failed ? { tone: 'bad', title: 'Game files', text: `The check failed: ${last.error || 'something went wrong.'}` }
    // Stopped before the files were checked: Dovakarn's game is not set up yet, or its mods are still to download
    : last.setup ? { tone: 'idle', title: 'Game files', text: last.setup === 'mods' ? 'Checked against the server once the mods are in.' : 'Checked once Dovakarn is set up.' }
    : !last.published ? { tone: 'idle', title: 'Game files', text: 'This server does not list any files.' }
    : fileRows.length ? { tone: last.blocked ? 'bad' : 'warn', title: 'Game files', text: last.blocked ? 'These mods must match the server before you can play.' : 'These mods have files that differ from the server. You can still play.', list: fileRows.map(m => ({ text: fileProblem(m), modId: m.nexusId })) }
    : last.problems ? { tone: last.blocked ? 'bad' : 'warn', title: 'Game files', text: `${modsVerb(last.problems, last.blocked)}. Check again to see them.` }
    : { tone: 'ok', title: 'Game files', text: `All ${count(last.checked, 'file')} match the server${last.updated + last.patched ? `, ${last.updated + last.patched} updated just now` : ''}.` })
  // Files the server does not use (other mods' settings, plugins, scripts) were taken out of the game, never deleted
  if (!checkRunning() && last?.moved) items.push({ tone: 'idle', title: 'Files moved out', text: `${count(last.moved, 'file')} the server does not use ${last.moved === 1 ? 'was' : 'were'} moved into the "Dovakarn removed files" folder in ${gc ? "Dovakarn's game" : 'your Skyrim folder'}. Nothing was deleted.` })
  // Online fixes to mod files that setting up this PC's server could not make: players do not get them, so it is said here
  const unfixed = !checkRunning() && last?.unfixed?.length ? last.unfixed : []
  if (unfixed.length) items.push({ tone: 'warn', title: 'Server mod fixes', text: `The server could not make ${unfixed.length === 1 ? 'one of its online fixes' : `${unfixed.length} of its online fixes`} to mod files, so players do not get ${unfixed.length === 1 ? 'that fix' : 'those fixes'}. You can still play.`,
    list: unfixed.map(u => ({ text: `${u.fix}. ${String(u.reason).charAt(0).toUpperCase()}${String(u.reason).slice(1)}` })) })
  const link = state.fileList?.collection?.url, cc = view?.collectionCheck
  if (!gc && !checkRunning() && last && !last.failed && last.published) {
    // A mod already named under Game files is not named twice, and the count says so
    const already = new Set(fileRows.map(m => m.name))
    const rows = cc ? [...cc.missing.map(m => ({ name: m.name, text: m.name, modId: m.modId })), ...cc.outdated.map(m => ({ name: m.name, text: `${m.name}, a different version`, modId: m.modId }))] : null
    const shownRows = rows ? rows.filter(row => !already.has(row.name)) : null, above = rows ? rows.length - shownRows.length : 0
    items.push(!link ? { tone: 'idle', title: 'Mod collection', text: 'The server has not set a collection link yet.' }
      : !c ? { tone: 'idle', title: 'Mod collection', text: 'Not checked yet.' }
      : c.error ? { tone: 'warn', title: 'Mod collection', text: `Could not check Nexus: ${c.error}` }
      : !(c.missing + c.outdated) ? { tone: 'ok', title: 'Mod collection', text: `Installed, ${count(c.total, 'mod')}.` }
      : { tone: 'warn', title: 'Mod collection', text: c.missing === c.total ? 'Not installed. Install it with Vortex.'
          : `${count(c.missing + c.outdated, 'mod')} missing or out of date.${above ? ` ${above === 1 ? 'One of them is' : `${above} of them are`} listed above.` : ''} Update the collection in Vortex.`,
        list: shownRows })
  }
  const rank = { bad: 0, warn: 1, idle: 2, ok: 3 }, sorted = items.slice().sort((x, y) => rank[x.tone] - rank[y.tone])
  const passed = sorted.filter(i => i.tone === 'ok')
  // With something to fix, what passed is one line at the end instead of pushing the problems down. Its titles as a
  // sentence: capital only at its start and for names ("Dovakarn's game and game files.")
  if (passed.length < 2 || passed.length === sorted.length) return sorted
  const inSentence = (title, i) => i === 0 || /^(?:Dovakarn|Skyrim|Nexus|Vortex)\b/.test(title) ? title : title.charAt(0).toLowerCase() + title.slice(1)
  return [...sorted.filter(i => i.tone !== 'ok'), { tone: 'ok', title: 'Everything else is fine', text: `${listed(passed.map((i, n) => inSentence(i.title, n)))}.` }]
}
// While a check runs the summary follows its steps; afterwards it says when it ran.
function checksSummary() {
  if (!state || checkRunning()) return CHECK_STEPS.includes(stage) && message.textContent ? message.textContent : gameCopy() ? "Checking Dovakarn's game, its mods and its files." : 'Checking your Skyrim folder, game files and mod collection.'
  const at = state.lastCheck?.at ? `Checked at ${clock(state.lastCheck.at)}.` : ''
  return state.gameRunning ? `${at} Close Skyrim to check again.`.trim() : at
}
function renderChecks() {
  const running = !state || checkRunning(), items = state ? checkItems() : [], problems = items.filter(i => i.tone === 'warn' || i.tone === 'bad').length
  text('#checks-title', running ? 'Checking...' : problems ? `${count(problems, 'thing')} worth a look` : 'All good')
  text('#checks-summary', checksSummary())
  // The list redraws every refresh; keyboard focus stays on the same Nexus button.
  const focused = checksList.contains(document.activeElement) ? document.activeElement.dataset.mod : undefined
  const focusedArchive = checksList.contains(document.activeElement) ? document.activeElement.dataset.archive : undefined
  checksList.replaceChildren(...items.map(item => {
    const li = document.createElement('li'), dot = document.createElement('span'), body = document.createElement('div'), title = document.createElement('strong'), p = document.createElement('p')
    li.className = `check check--${item.tone}`; dot.className = 'check-dot'; title.textContent = item.title; p.textContent = item.text
    body.append(title, p)
    if (item.list?.length) {
      const ul = document.createElement('ul')
      ul.className = 'check-list'
      ul.replaceChildren(...item.list.map(row => {
        const entry = document.createElement('li'), label = document.createElement('span')
        label.textContent = row.text
        entry.append(label)
        if (row.modId) {
          const b = document.createElement('button'); b.className = 'nexus-link'; b.dataset.mod = String(row.modId); b.textContent = 'Nexus'
          b.title = `Open ${row.text} on Nexus Mods`; b.setAttribute('aria-label', `Open ${row.text} on Nexus Mods`); entry.append(b)
        }
        // A download Dovakarn's game needs: the mods window's own row, its line under its name and its button (Download,
        // Show while it runs, none once it is in)
        if (row.archive) {
          const words = document.createElement('span'), line = document.createElement('span'), b = document.createElement('button')
          words.className = 'check-row-words'; label.className = 'check-row-name'; line.className = 'check-row-line'
          fillRowLine(line, row.download)
          words.append(label, line)
          entry.replaceChildren(words)
          rowButton(b, { id: row.archive, name: row.text }, row.download)
          entry.append(b)
        }
        return entry
      }))
      body.append(ul)
    }
    li.append(dot, body)
    return li
  }))
  if (focused !== undefined) [...checksList.querySelectorAll('button[data-mod]')].find(b => b.dataset.mod === focused)?.focus()
  if (focusedArchive !== undefined) {
    const again = [...checksList.querySelectorAll('button[data-archive]')].find(b => b.dataset.archive === focusedArchive && !b.hidden)
    // Its button went (the mods download by themselves now, or it is in): focus stays in the window, on Close
    if (again) again.focus(); else $('#checks-close').focus()
  }
  const link = !!state?.fileList?.collection?.url, wantsCollection = items.some(i => i.title === 'Mod collection' && i.tone === 'warn') || !!state?.lastCheck?.blocked
  $('#checks-collection').hidden = !!gameCopy() || !(link && wantsCollection)
  $('#checks-again').disabled = !canCheck()
}

// Windows: Escape closes, focus stays inside, and returns to where it was.
const MODALS = [settings, checks, setupModal, modsModal]
function openModal(modal, focusTarget) {
  if (MODALS.every(m => m.hidden)) returnFocus = document.activeElement
  for (const other of MODALS) if (other !== modal) other.hidden = true
  modal.hidden = false
  const target = focusTarget || modal.querySelector('button:not([hidden]):not([disabled])')
  if (target) target.focus()
}
function closeModal(modal) {
  if (modal.hidden) return
  if (modal === settings && capturing) endCapture('', { refocus: false })
  modal.hidden = true
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus()
}
for (const modal of MODALS) {
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(modal) })
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeModal(modal); return }
    if (event.key !== 'Tab') return
    const focusable = [...modal.querySelectorAll('button:not([hidden]):not([disabled])')].filter(b => !b.closest('[hidden]') && b.getAttribute('tabindex') !== '-1')
    const first = focusable[0], last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  })
}
function selectTab(name) {
  if (capturing && name !== 'controls') endCapture('', { refocus: false })
  for (const tab of settings.querySelectorAll('[role=tab]')) {
    const on = tab.dataset.tab === name
    tab.setAttribute('aria-selected', String(on))
    tab.setAttribute('tabindex', on ? '0' : '-1')
    $(`#tab-${tab.dataset.tab}`).hidden = !on
  }
}
const tabList = settings.querySelector('.tabs')
tabList.addEventListener('click', event => { const tab = event.target.closest('[role=tab]'); if (tab) selectTab(tab.dataset.tab) })
// Arrow keys, Home and End move between the tabs, as in any tab list
tabList.addEventListener('keydown', event => {
  const tabs = [...tabList.querySelectorAll('[role=tab]')], at = tabs.indexOf(document.activeElement)
  const next = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key]
  if (at < 0 || next === undefined) return
  event.preventDefault()
  const tab = tabs[(next + tabs.length) % tabs.length]
  selectTab(tab.dataset.tab); tab.focus()
})

// The gold button: what it says, whether it can be pressed, and what a press does. It always carries the real next
// step: logging in, an update, the fix for a card's problem, or Play.
// What the gold button says while a check or a launch works on the game files
const stepLabel = otherwise => stage === 'updatingFiles' ? 'Updating game files...' : stage === 'patchingFiles' ? 'Fitting your mods...' : stage === 'checking' ? 'Checking game files...'
  : stage === 'copyingGame' ? 'Copying Skyrim...' : stage === 'installingMods' ? 'Installing mods...' : otherwise
function mainAction() {
  if (!state) return { label: 'Checking...', disabled: true }
  const l = login()
  // While Skyrim runs the button only says so; logging in stays in the top bar
  if (state.gameRunning) return { label: 'Skyrim is running', disabled: true }
  if (l.discord && l.pending) return { label: 'Waiting for Discord...', disabled: true }
  if (l.discord && !l.loggedIn) return { label: 'Log in with Discord', run: accountLogin }
  if (updateRunning) return { label: 'Installing launcher update...', disabled: true }
  if (updateReady()) return { label: 'Update launcher', run: installLauncherUpdate }
  if (updateHeld()) return { label: 'Download launcher update', run: resumeUpdate }
  if (updateFetching()) return downloadFailed ? { label: 'Retry launcher update', run: autoDownloadUpdate } : { label: 'Downloading launcher update...', disabled: true }
  if (launching || (state.busy && !checking)) return { label: stepLabel('Preparing Skyrim...'), disabled: true }
  if (nexus.installing) return { label: stepLabel('Installing mods...'), disabled: true }
  if (nexus.removing) return { label: 'Removing Dovakarn...', disabled: true }
  // A red card's fix (choose a folder, join the Discord) or the reason nothing can start (a ban)
  if (shown?.main) return shown.main
  // Online, a server that is not answering cannot be joined: the launch would stop at the same check
  if (online() && !state.serverOnline) return { label: 'Dovakarn is offline', disabled: true }
  // A check or a game-file update is running: nothing can be played until it ends, and the button says what it is doing
  if (checking) return { label: stepLabel('Checking game files...'), disabled: true }
  if (filesView) return filesView.blocked ? { label: 'Check again and play', run: launch } : { label: 'Play anyway', run: launch }
  // The server published new game files: this press updates them, and nothing launches until it has
  if (state.filesUpdate?.needed) return { label: 'Update game files', run: () => runCheck() }
  return { label: 'Play', run: launch }
}
function syncPlay() {
  const action = mainAction()
  // Remove's confirm dialog is open: the gold button keeps its words, but nothing starts from it
  play.disabled = !!action.disabled || !action.run || nexus.removeAsking
  if (play.textContent !== action.label) play.textContent = action.label
}
// A refresh asked for while one is running follows it, so a finished action never shows stale buttons.
async function refresh() {
  if (refreshing) { refreshAgain = true; return }
  refreshing = true
  try {
    state = await window.localPlay.state()
    const srv = state.server || { uptime: null, players: [], max: 8 }
    text('#world-name', srv.name || 'Dovakarn')
    // Online, the brand stands alone; only the local test copy labels itself.
    text('#window-mode', online() ? '' : 'Test launcher')
    text('#footer-world', online() ? (srv.address || '') : 'Private world · This PC only')
    // The server line says whether the server is up; how full the world is has its own gauge, how long it has been up is
    // in Settings
    text('#server', state.serverOnline ? 'Server running' : online() ? 'Server not answering right now' : 'Server starts when you play')
    serverLine.classList.toggle('offline', !state.serverOnline)
    serverLine.classList.toggle('down', !state.serverOnline && online())
    // The footer carries the launcher's own version; the server's world build is in Settings, Updates.
    text('#footer-version', state.launcherVersion ? `Dovakarn v${state.launcherVersion}` : 'Dovakarn')
    $('#footer-private').hidden = false
    launcherSays(state.phase)
    filesView = state.files || null
    renderAccount()
    showNotice()
    syncCapacity()
    syncPlay()
    showSettings()
    if (!checks.hidden) renderChecks()
    if (!setupModal.hidden) renderSetup()
    if (!modsModal.hidden) renderMods()
    // Switched to the version Dovakarn needs (with the Skyrim Downgrader Tool) while the launcher was open: the game's
    // files are checked against the server straight away
    const versionOk = state.gameFolder?.exe ? !!state.gameFolder.versionOk : null
    if (versionWasOk === false && versionOk === true && canCheck()) runCheck()
    versionWasOk = versionOk
  } catch (error) { message.textContent = error.message; message.classList.add('error'); message.hidden = false }
  finally { refreshing = false; if (refreshAgain) { refreshAgain = false; await refresh() } }
}
// After a check that finds problems the Verify list opens by itself.
async function afterCheck(result, { show = false } = {}) {
  // The launcher records how a check or launch ended, in its own words, so its status line takes over from here
  note = null
  if (!result.success && !result.cancelled && !result.setup) phase({ stage: result.canPlayAnyway ? 'filesWarning' : 'failed', message: result.error })
  await refresh()
  if (show || (!result.success && filesView)) { renderChecks(); openModal(checks, $('#checks-collection').hidden ? $('#checks-close') : $('#checks-collection')) }
}
async function runCheck({ show = false } = {}) {
  if (checking || launching) return
  checking = true; launchFailed = null; syncPlay()
  if (state) { showSettings(); if (!checks.hidden) renderChecks(); if (!modsModal.hidden) renderMods() }
  let result
  try { result = await window.localPlay.check() }
  catch (error) { result = { success: false, error: error.message } }
  finally { checking = false; if (stopping === 'files') stopping = null }
  await afterCheck(result, { show })
}
async function launch() {
  if (launching || checking) return
  launching = true; launchFailed = null; syncPlay(); showNotice()
  if (state) showSettings()
  let result
  try { result = await window.localPlay.play(filesView && !filesView.blocked ? { ignoreWarnings: true } : undefined) }
  catch (error) { result = { success: false, error: error.message } }
  finally { launching = false; if (stopping === 'files') stopping = null }
  // A launch that stopped for its own reasons (not a mod list, an account refusal or a warning) gets a card
  if (!result.success && !result.cancelled && !result.account && !result.setup && !result.canPlayAnyway && !result.view && result.error) launchFailed = result.error
  await afterCheck(result)
  if (launchFailed && filesView) launchFailed = null
  showNotice(); syncPlay()
}
play.addEventListener('click', () => { const action = mainAction(); if (!action.disabled && action.run) action.run() })
async function openCollection() {
  let result
  try { result = await window.localPlay.openCollection() } catch (error) { result = { success: false, error: error.message } }
  if (!result.success) say({ stage: 'failed', message: result.error })
}
// A new Skyrim folder is checked straight away; a cancelled picker changes nothing.
async function changeFolder() {
  let result
  try { result = await window.localPlay.chooseFolder() } catch (error) { result = { success: false, error: error.message } }
  if (result.success) { note = null; await refresh(); return runCheck() }
  if (!result.cancelled) say({ stage: 'failed', message: result.error })
}
// Discord login starts only from a button the player presses; the browser opens on Discord's own page
async function accountLogin() {
  if (login().pending) return
  if (state?.login) state.login.pending = true
  // Started from the main button, which now waits: keyboard focus goes to Cancel instead of being lost.
  const fromPage = document.activeElement === play || notice.contains(document.activeElement)
  say({ stage: 'ready', message: LOGIN_WAITING })
  renderAccount(); syncPlay(); showNotice(); showSettings()
  if (fromPage) $('#account-cancel').focus()
  let result
  try { result = await window.localPlay.account.login() } catch (error) { result = { success: false, error: error.message } }
  // The browser login is over: what came of it shows at once, before the refresh says so too
  if (state?.login) state.login.pending = false
  if (result.success) say({ stage: 'ready', message: `Logged in as ${result.state.account.name}, Dovakarn account #${result.state.account.number}.` })
  else say(result.code === 'cancelled' ? { stage: 'ready', message: 'Discord login cancelled.' } : { stage: 'account', message: result.error })
  await refresh()
}
// Asks Discord afresh and says what came of it. Logged out meanwhile (the login ended) or replaced by another login,
// the account area already says what to do.
async function accountRecheck() {
  let r
  try { r = await window.localPlay.account.refresh(true) } catch (error) { r = { loggedIn: true, account: login().account, reached: false, problem: error.message } }
  const a = r.loggedIn ? r.account : null
  if (a && r.reached === false) say({ stage: 'failed', message: r.problem || 'The Dovakarn server could not be reached. Try again in a minute.' })
  else if (a && r.reached && (r.membershipError || a.member === null)) say({ stage: 'failed', message: 'Your Discord membership could not be checked right now. Try again in a minute.' })
  else if (a && r.reached) {
    // An answer Discord gave earlier (Check again pressed twice in quick succession) says when it was asked, and when
    // it may be asked again
    const age = r.membershipAge || 0, waiting = a.member === false || a.pending
    const found = a.member === false ? `@${a.username || a.name} is not in it yet.` : a.pending ? 'the rules screen is not finished yet.' : 'you are a member.'
    const again = age > 5 && waiting && r.askAgainIn ? ` Press Check again in ${count(r.askAgainIn, 'second')} to ask Discord again.` : ''
    say({ stage: 'ready', message: `Checked with the Dovakarn Discord at ${clock(Date.now() - age * 1000)}: ${found}${again}` })
  }
  await refresh()
}
async function accountLogout() {
  await window.localPlay.account.logout()
  say({ stage: 'ready', message: 'Logged out of Dovakarn on this PC.' })
  await refresh()
}
async function openDiscord() {
  let result
  try { result = await window.localPlay.account.openDiscord() } catch (error) { result = { success: false, error: error.message } }
  if (!result.success) say({ stage: 'failed', message: result.error })
}
// Skyrim on another version: the Skyrim Downgrader Tool on Nexus Mods switches it with Steam's own files (the launcher
// sees the new version by itself, and then checks the game's files)
const openDowngrader = () => window.localPlay.openMod(DOWNGRADER_MOD).catch(() => {})
$('#folder-switch').addEventListener('click', openDowngrader)

// Latest updates: the notice board's Updates, as the game's own Updates tab shows them, newest first. Asked on open, every
// five minutes and the moment the server announces a change. Each entry opens in place to read in full; entries posted
// since the launcher was last opened carry New.
const updatesPanel = $('#updates'), updatesList = $('#updates-list')
const CHEVRON = '<svg class="update-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>'
let updatesData = null, updatesDrawn = ''
const updatesOpen = new Set()
async function loadUpdates() {
  let r
  try { r = await window.localPlay.updates?.() } catch { r = null }
  if (!r) return
  updatesData = r
  renderUpdates()
}
// The list fades at its foot only while more is below
function syncUpdatesFade() { updatesList.classList.toggle('more', updatesList.scrollHeight - updatesList.scrollTop - updatesList.clientHeight > 4) }
// An entry whose words already fit in its two lines has nothing more to show, so no chevron and no opening. Measured again
// once the font has loaded and whenever the column changes width.
function measureUpdates() {
  for (const li of updatesList.children) {
    if (li.classList.contains('update--open')) { li.classList.remove('update--short'); continue }
    const body = li.querySelector('.update-text')
    li.classList.toggle('update--short', !body || (body.clientHeight > 0 && body.scrollHeight <= body.clientHeight + 1))
  }
}
function renderUpdates() {
  const r = updatesData
  // The test launcher plays on a server on this PC, whose notice board is not the players' one
  updatesPanel.hidden = !!r?.local
  if (!r || r.local) return
  const entries = r.entries || [], fresh = new Set(r.fresh || [])
  const signature = JSON.stringify([entries, [...fresh], [...updatesOpen]])
  if (signature !== updatesDrawn) {
    updatesDrawn = signature
    const focused = updatesList.contains(document.activeElement) ? document.activeElement.closest('[data-id]')?.dataset.id : undefined
    updatesList.replaceChildren(...entries.map((e, i) => {
      const li = document.createElement('li'), toggle = document.createElement('button'), title = document.createElement('span'), open = updatesOpen.has(e.id)
      li.className = `update${open ? ' update--open' : ''}${fresh.has(e.id) ? ' update--new' : ''}`; li.dataset.id = e.id
      toggle.className = 'update-toggle'; toggle.setAttribute('aria-expanded', String(open))
      title.className = 'update-title'; title.textContent = e.title
      toggle.append(title)
      if (fresh.has(e.id)) { const tag = document.createElement('span'); tag.className = 'update-new'; tag.textContent = 'New'; toggle.append(tag) }
      toggle.insertAdjacentHTML('beforeend', CHEVRON)
      li.append(toggle)
      if (e.body) { const body = document.createElement('p'); body.className = 'update-text'; body.id = `update-text-${i}`; body.textContent = e.body; toggle.setAttribute('aria-controls', body.id); li.append(body) }
      const meta = [e.version, e.date].filter(Boolean).join(' · ')
      if (meta) { const p = document.createElement('p'); p.className = 'update-meta'; p.textContent = meta; li.append(p) }
      return li
    }))
    measureUpdates()
    if (focused !== undefined) [...updatesList.querySelectorAll('[data-id]')].find(li => li.dataset.id === focused)?.querySelector('.update-toggle')?.focus()
  }
  const note = entries.length ? '' : r.reached ? 'No updates yet.' : 'The latest updates could not be loaded. They show here once the Dovakarn server answers.'
  text('#updates-note', note)
  $('#updates-note').hidden = !note
  updatesList.hidden = !entries.length
  syncUpdatesFade()
}
updatesList.addEventListener('click', event => {
  const li = event.target.closest('.update')
  if (!li || li.classList.contains('update--short') && !li.classList.contains('update--open')) return
  if (updatesOpen.has(li.dataset.id)) updatesOpen.delete(li.dataset.id); else updatesOpen.add(li.dataset.id)
  renderUpdates()
})
updatesList.addEventListener('scroll', syncUpdatesFade, { passive: true })
// Too little room for even one update (a card and the progress bar showing in a short window): the space stays empty
// rather than showing a sliver of one
// Less room than one whole update: the titles alone; less than one title: nothing
if (typeof ResizeObserver === 'function') new ResizeObserver(([entry]) => {
  const h = entry.contentRect.height
  updatesPanel.classList.toggle('updates--compact', h < 200)
  updatesPanel.classList.toggle('updates--cramped', h < 96)
  measureUpdates(); syncUpdatesFade()
}).observe(updatesPanel)
document.fonts?.ready?.then(() => { measureUpdates(); syncUpdatesFade() })

// Set up Dovakarn: where its game goes, where Skyrim 1.6.1170 comes from (the player's Skyrim if it is that version,
// else Steam's own 1.6.1170 download, three console lines), and Install. Redrawn on every refresh while open, so a depot
// download shows its progress; the rows are only rebuilt when they change, so keyboard focus stays put.
const gigabytes = bytes => `${(bytes / 1024 ** 3).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`
let depotsDrawn = ''
function renderSetup() {
  const gc = gameCopy()
  if (!gc) return
  const busy = working() || !!state?.gameRunning, depots = gc.depots || [], ready = depots.length && depots.every(d => d.state === 'done')
  text('#setup-title', gc.ready ? 'Dovakarn is set up' : 'Set up Dovakarn')
  text('#setup-path', gc.ready ? gc.gameDir : gc.installDir, gc.installDir)
  const change = $('#setup-change')
  change.disabled = gc.ready || !!gc.partial || busy
  change.title = gc.ready ? 'To move it, remove it in Settings, Game, then set it up again.'
    : gc.partial ? 'Part of Dovakarn\'s game is already in this folder. To use another, remove it in Settings, Game first.' : ''
  const drive = (gc.installDir.match(/^[A-Za-z]:/) || [''])[0]
  text('#setup-space', gc.ready ? '' : !gc.todo ? 'Everything is already in place.'
    : gc.bytes ? `About ${gigabytes(gc.bytes)} to copy.${Number.isFinite(gc.free) ? ` ${drive || 'That drive'} has ${gigabytes(gc.free)} free.` : ''}`
    : "Steam's downloaded files move straight in, so nothing is stored twice.")
  text('#setup-source', gc.steamReady && gc.fromDownload ? "Steam's 1.6.1170 download is already on this PC, so its files move in, and anything it lacks is copied from your Steam Skyrim. Your Skyrim is only read, never changed."
    : gc.steamReady ? 'Your Steam Skyrim is already 1.6.1170, so the launcher copies its game files from it. Your Skyrim is only read, never changed.'
    : ready ? "Steam's 1.6.1170 download is ready. Press Install."
    : gc.steamChanged?.length ? `A mod changed ${gc.steamChanged.length === 1 ? "one of Skyrim's own files" : `${gc.steamChanged.length} of Skyrim's own files`} in your Steam Skyrim: ${gc.steamChanged[0]}${gc.steamChanged.length > 1 ? ' and more' : ''}. So Dovakarn takes Skyrim 1.6.1170 from Steam's own download instead. Open Steam's console, then copy each line below into it and press Enter. Your installed Skyrim stays as it is.`
    : "Your Steam Skyrim is a newer version. Steam still has 1.6.1170, and downloads it with your own account: open Steam's console, then copy each line below into it and press Enter. Your installed Skyrim stays on its version.")
  $('#setup-depots').hidden = gc.steamReady
  $('#setup-console-row').hidden = gc.steamReady || ready
  const signature = JSON.stringify(depots)
  if (signature !== depotsDrawn) {
    depotsDrawn = signature
    const focused = $('#setup-depots').contains(document.activeElement) ? document.activeElement.dataset.command : undefined
    $('#setup-depots').replaceChildren(...depots.map(d => {
      const li = document.createElement('li'), code = document.createElement('code'), copy = document.createElement('button'), status = document.createElement('span')
      li.className = `depot depot--${d.state}`; code.textContent = d.command
      copy.className = 'secondary'; copy.textContent = 'Copy'; copy.dataset.command = d.command; copy.setAttribute('aria-label', `Copy ${d.command}`)
      status.className = 'depot-state'
      status.textContent = d.state === 'done' ? 'Downloaded' : d.state === 'downloading' ? `${d.files} of ${d.total} files` : 'Not started'
      li.append(code, copy, status)
      return li
    }))
    if (focused !== undefined) [...$('#setup-depots').querySelectorAll('button[data-command]')].find(b => b.dataset.command === focused)?.focus()
  }
  const install = $('#setup-install')
  install.disabled = !gc.ready && (busy || gc.missing > 0 || (Number.isFinite(gc.free) && gc.free < gc.bytes))
  text('#setup-install', gc.ready ? 'Done' : 'Install')
  install.title = gc.ready || !install.disabled ? '' : state?.gameRunning ? 'Close Skyrim first.' : busy ? 'Wait for the current check to finish.'
    : gc.missing > 0 ? "Skyrim 1.6.1170 is not on this PC yet: download it with Steam's console first." : 'Not enough free space on that drive. Change the folder, or free some space.'
}
function setupSays(line, error = false) { text('#setup-status', line); $('#setup-status').classList.toggle('error', error) }
function openSetup() { setupSays(''); depotsDrawn = ''; renderSetup(); openModal(setupModal) }
async function chooseInstall() {
  let result
  try { result = await window.localPlay.game.chooseInstall() } catch (error) { result = { success: false, error: error.message } }
  if (result.success) setupSays(`Dovakarn goes in ${result.dir}.`)
  else if (!result.cancelled) setupSays(result.error, true)
  await refresh()
}
// Install: the window closes and the main screen's bar follows the copy; then the usual check installs the mods
async function installGame() {
  if (gameCopy()?.ready) return closeModal(setupModal)
  if (settingUp || working()) return
  settingUp = true; closeModal(setupModal); syncPlay(); renderProgress()
  let result
  try { result = await window.localPlay.game.setup() } catch (error) { result = { success: false, error: error.message } }
  finally { settingUp = false; if (stopping === 'files') stopping = null }
  await refresh()
  if (result.success) return runCheck()
  if (!result.cancelled) { renderSetup(); setupSays(result.error, true); openModal(setupModal, $('#setup-close')) }
}
async function copyCommand(command) {
  let result
  try { result = await window.localPlay.game.copy(command) } catch { result = { success: false } }
  setupSays(result.success ? "Copied. In Steam's console, press Ctrl+V to paste it, then press Enter." : 'It could not be copied. Select the line and copy it yourself.', !result.success)
}
$('#setup-depots').addEventListener('click', event => { const b = event.target.closest('button[data-command]'); if (b) copyCommand(b.dataset.command) })
$('#setup-change').addEventListener('click', chooseInstall)
$('#setup-console').addEventListener('click', () => window.localPlay.game.openConsole())
$('#setup-install').addEventListener('click', installGame)
$('#setup-close').addEventListener('click', () => closeModal(setupModal))

// Mods to download: each Nexus download Dovakarn's game still needs, its state while the launcher's Nexus window works,
// and a Download button that opens that window at it. The other ways in: Check my downloads (the player's own browser
// downloads), a folder of their own, and Open in my browser when the Nexus window could not open.
let modsDrawn = ''
const sizeLabel = n => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
const ROW_CLASS = { downloading: ' check--warn', checking: ' check--warn', done: ' check--ok', wrong: ' check--bad', failed: ' check--bad' }
const MODS_INTRO = 'Press Download them all and Nexus opens inside the launcher. Log in once. A free account works. Then press Slow download for each mod, and the launcher takes each file by itself.'
const MODS_PREMIUM = 'Press Download them all and the launcher downloads every mod for you with your Nexus Premium account, one after another.'
const MODS_DIRECT = 'Downloading every mod from Nexus with your Premium account. You can close this window: the downloads carry on.'
const COULD_NOT_OPEN = 'The Nexus window could not open. Press Download again. If it still does not open, tell the Dovakarn staff.'
// The needed download the Nexus window could not open for: Open in my browser offers it in the player's own browser
let browserFallback = null
// The mods window's status line: what its last button press came to, then the player's own folders the last check
// skipped because they gave no answer (an offline network share), so a mod kept there is not simply missing
let modsSaid = ''
function modsSays(line) { modsSaid = line; syncModsStatus() }
function syncModsStatus() {
  const gc = gameCopy(), skipped = remainingMods().length && Array.isArray(gc?.modsFoldersSkipped) ? gc.modsFoldersSkipped.filter(d => typeof d === 'string' && d) : []
  const unread = skipped.length ? `${listed(skipped)} did not answer, so the launcher did not look in ${skipped.length === 1 ? 'it' : 'them'}.` : ''
  // What the last automatic download could not do, while there are mods left, no new run has started and the Nexus window
  // is not open (it is the way round it then)
  const direct = !directRunning() && !nexus.open && remainingMods().length && nexus.direct.problem ? nexus.direct.problem.message : ''
  text('#mods-status', [modsSaid, direct, unread].filter(Boolean).join(' '))
}
// A row's line: its version (only when the name does not carry it) and size, then how its download is going
function rowLine(m) {
  const st = downloadState(m.id), pct = nexus.archives[m.id]?.percent
  const meta = [carriesVersion(m) ? '' : `Version ${versionOf(m)}`, sizeLabel(m.size)].filter(Boolean).join(' · ')
  // While the mods download by themselves no row has a button: a file that failed is tried again by the next run
  const again = directRunning() ? 'Download them all tries it again once this run ends' : 'press Download to try again'
  return st === 'downloading' ? `${meta} · Downloading${Number.isInteger(pct) ? ` ${pct}%` : ''}` : st === 'checking' ? `${meta} · Checking`
    : st === 'wrong' ? `${meta} · Wrong file: ${again}` : st === 'failed' ? `${meta} · Did not download: ${again}` : meta
}
// A needed download as the mods window and Verify both show it: its line (a tick and Downloaded once it is in) and its
// button, which brings the Nexus window forward while its download runs (Show) and is gone once it is downloaded. While
// the mods download by themselves there is no window to show and nothing to press on a row: Stop is the one control
function downloadRow(m) {
  const st = downloadState(m.id), running = st === 'downloading' || st === 'checking'
  return { state: st, rowClass: ROW_CLASS[st] || '', done: st === 'done', line: rowLine(m),
    button: st === 'done' || directRunning() ? null : { label: running ? 'Show' : 'Download', show: running, aria: running ? 'Show the Nexus window' : `Download ${m.name} from Nexus Mods` } }
}
function fillRowLine(el, row) {
  if (!row.done) return setWords(el, row.line)
  const mark = document.createElement('span'); mark.className = 'mods-tick'; mark.innerHTML = TICK
  el.replaceChildren(mark, 'Downloaded')
}
function rowButton(b, m, row) {
  b.className = 'nexus-link'; b.dataset.archive = m.id; b.hidden = !row.button
  b.textContent = row.button ? row.button.label : 'Download'
  if (row.button?.show) b.dataset.show = 'true'
  b.setAttribute('aria-label', row.button ? row.button.aria : `Download ${m.name} from Nexus Mods`)
}
// Every mod downloaded and nothing waiting to install them: the gold button installs them (one check), when one can run
const installReady = () => canCheck() && !(online() && !state?.serverOnline)
function renderMods() {
  const mods = gameCopy()?.mods || [], left = remainingMods(), installNow = !left.length && mods.length > 0 && !installWaiting()
  text('#mods-title', left.length ? `${count(left.length, 'mod')} to download` : mods.length ? 'Every mod is downloaded' : 'Every mod is installed')
  // How they come in while mods are left (by themselves with Nexus Premium, else the Nexus window); once every one is
  // downloaded, the next step; once installed, Play
  text('#mods-intro', left.length ? (directRunning() ? MODS_DIRECT : nexus.premium && !nexus.open ? MODS_PREMIUM : MODS_INTRO) : installNow ? "Press Install the mods to put them into Dovakarn's game."
    : mods.length ? downloadedNext() : 'Press Play on the main screen when you are ready.')
  $('#mods-intro').hidden = false
  // Nexus Premium: offered while mods are left and the launcher can log in to Nexus, until the player is logged in
  const offerPremium = !!left.length && nexusMeAvailable() && !nexusMe.loggedIn
  $('#mods-premium').hidden = !offerPremium
  if (offerPremium) {
    text('#mods-premium-line', nexusMe.pending ? 'Finish logging in to Nexus in your browser.' : 'Got Nexus Premium? Log in to Nexus and the mods download by themselves.')
    text('#mods-premium-login', nexusMe.pending ? 'Cancel' : 'Log in to Nexus')
  }
  // Every mod installed: no empty list (nor its border)
  $('#mods-needed').hidden = !mods.length
  const signature = JSON.stringify([mods, nexus.archives, directRunning()])
  if (signature !== modsDrawn) {
    modsDrawn = signature
    const focused = $('#mods-needed').contains(document.activeElement) ? document.activeElement.dataset.archive : undefined
    $('#mods-needed').replaceChildren(...mods.map(m => {
      const row = downloadRow(m), li = document.createElement('li'), dot = document.createElement('span'), body = document.createElement('div'), name = document.createElement('strong'), line = document.createElement('p'), b = document.createElement('button')
      li.className = `check${row.rowClass}`; dot.className = 'check-dot'; name.textContent = m.name
      fillRowLine(line, row)
      body.append(name, line)
      rowButton(b, m, row)
      li.append(dot, body, b)
      return li
    }))
    if (focused !== undefined) {
      const again = [...$('#mods-needed').querySelectorAll('button[data-archive]')].find(x => x.dataset.archive === focused && !x.hidden)
      // Its button went (the mods download by themselves now, or it is in): focus stays in the window, on Close
      if (again) again.focus(); else $('#mods-close').focus()
    }
  }
  // The gold button: Download them all while mods are left, Install the mods once every one is downloaded. While the mods
  // download by themselves it gives way to Stop
  const all = $('#mods-all')
  all.hidden = (!left.length && !installNow) || directRunning()
  $('#mods-stop').hidden = !directRunning()
  // After an automatic download that could not get some: the Nexus window is offered for the rest. Only with Premium (else
  // Download them all opens the window anyway), and not when the Downloads folder itself was the problem
  $('#mods-window').hidden = directRunning() || !left.length || !nexus.direct.problem || nexus.open || !nexus.premium || ['save', 'locked'].includes(nexus.direct.problem.kind)
  text('#mods-all', left.length ? 'Download them all' : 'Install the mods')
  all.disabled = !left.length && !installReady()
  all.title = !left.length && all.disabled ? (state?.gameRunning ? 'Close Skyrim first.' : online() && !state?.serverOnline ? 'Dovakarn is not answering right now.' : 'You can install them when the current check finishes.') : ''
  // Nothing left to look for: no Check my downloads, no other folder; nor while the mods download by themselves
  $('#mods-again').hidden = !left.length || directRunning()
  $('#mods-more').hidden = !left.length || directRunning()
  const fallback = browserFallback ? left.find(m => m.id === browserFallback) : null
  $('#mods-browser-open').hidden = !fallback
  if (fallback) $('#mods-browser-open').setAttribute('aria-label', `Open ${fallback.name} in my browser`)
  $('#mods-again').disabled = !canCheck()
  $('#mods-folder').disabled = !canCheck()
  syncModsStatus()
  // Keyboard focus never stays on a button that went; it goes to Close first, so a key held from Download them all never
  // lands on Stop
  if (modsModal.contains(document.activeElement) && document.activeElement.closest('[hidden]')) [$('#mods-close'), $('#mods-all'), $('#mods-stop')].find(b => !b.hidden && !b.disabled).focus()
}
// Opens on its gold button (Download them all, or Install the mods), never on the other-folder link in its title row
// While the mods download by themselves it opens on Close, so a stray key press never stops them
function openMods() { modsSays(''); browserFallback = null; modsDrawn = ''; renderMods(); openModal(modsModal, [directRunning() ? null : $('#mods-all'), $('#mods-close')].find(b => b && !b.hidden && !b.disabled)); loadNexusMe() }
// The launcher's Nexus window at this download, or at the first still to get (null); only ever from a press here or in
// Verify. When it cannot open, the mods window says why (it opens for that from Verify) and, when the player's own
// browser gets round it (another launcher holds Nexus, or the window failed), offers the mod there
// With Nexus Premium a press downloads them by themselves instead (the launcher decides); useWindow asks for the window
async function getMod(id, useWindow = false) {
  let result
  // A call that failed on its way to the launcher has no words for a player: the plain could-not-open line stands in
  try { result = await window.localPlay.game.downloadMods(id, useWindow) } catch { result = { success: false, browser: true } }
  if (result?.success) { browserFallback = null; if (!modsModal.hidden) { modsSays(''); renderMods() } return }
  const line = result?.error || COULD_NOT_OPEN, browser = !result || result.browser === true
  if (modsModal.hidden) openMods()
  browserFallback = browser ? (id || remainingMods()[0]?.id || null) : null
  // The way round it, said with the button that does it
  const fallback = browserFallback ? remainingMods().find(m => m.id === browserFallback) : null
  modsSays(fallback ? `${line} Or press Open in my browser to get ${fallback.name} there.` : line)
  renderMods()
}
function takeNexus(value) {
  const v = value && typeof value === 'object' ? value : {}, archives = {}
  for (const [id, a] of Object.entries(v.archives && typeof v.archives === 'object' ? v.archives : {}))
    if (/^\d{1,12}$/.test(id) && a && DOWNLOAD_STATES.has(a.state)) archives[id] = { state: a.state, percent: Number.isInteger(a.percent) && a.percent >= 0 && a.percent <= 100 ? a.percent : null }
  const who = typeof v.account?.user === 'string' ? v.account.user.slice(0, 64) : ''
  const login = NEXUS_LOGINS.has(v.account?.login) ? v.account.login : who ? 'in' : 'unknown'
  const was = nexus
  const problem = v.direct?.problem && typeof v.direct.problem.message === 'string' ? { kind: String(v.direct.problem.kind || ''), message: v.direct.problem.message.slice(0, 400) } : null
  nexus = { open: v.open === true, installQueued: v.installQueued === true, installing: v.installing === true, removing: v.removing === true,
    removeAsking: v.removeAsking === true, current: typeof v.current === 'string' ? v.current : null, account: { user: who, login, kept: v.account?.kept === true }, archives,
    direct: { running: v.direct?.running === true, problem }, premium: v.premium === true }
  // The Nexus login changed (a log out, a log in in the window): an old line about it no longer applies
  if (was.account.user !== who || was.account.login !== login) text('#nexus-status', '')
  // The install has begun: the main screen's progress card takes over from the mods window
  if (nexus.installing && !was.installing && !modsModal.hidden) closeModal(modsModal)
  if (!state) return
  // The install has ended: the launcher's state now says how (the mods in, or why not), so it is asked at once rather than
  // at the next 2 second refresh
  if (was.installing && !nexus.installing) refresh()
  showNotice(); syncPlay(); renderProgress()
  if (!modsModal.hidden) renderMods()
  if (!checks.hidden) renderChecks()
  if (!settings.hidden) showSettings()
  // The Nexus window was closed with mods still to get: what the player saved in their own browser is looked for once,
  // as coming back to the launcher did (the focus event may come before or after this push). Never when Remove closed
  // it, its confirm dialog included
  if (was.open && !nexus.open && !nexus.removing && !nexus.removeAsking && !installWaiting() && shown?.kind === 'Mods' && remainingMods().length && canCheck()) { lastFocusCheckAt = Date.now(); runCheck() }
}
window.localPlay.game?.onDownloads?.(takeNexus)
// The window's state at start: a reloaded page still shows each download where it is
window.localPlay.game?.downloads?.()?.then?.(value => { if (value) takeNexus(value) })?.catch?.(() => {})
$('#mods-needed').addEventListener('click', event => { const b = event.target.closest('button[data-archive]'); if (b) getMod(b.dataset.show ? null : b.dataset.archive) })
// Download them all, or with every mod downloaded, Install the mods: the main screen's progress card follows the install
$('#mods-all').addEventListener('click', () => {
  if (remainingMods().length) return getMod(null)
  if (!installReady()) return renderMods()
  closeModal(modsModal)
  runCheck()
})
// Looks for the mods' downloads again (a check, which installs what it finds), and says what it found
async function lookAgain(line) {
  modsSays(line)
  await runCheck()
  const mods = gameCopy()?.mods || [], left = remainingMods().length
  modsSays(left ? `${count(left, 'mod')} still to download.` : mods.length ? `Every mod is downloaded. ${downloadedNext()}` : 'Every mod is installed.')
}
$('#mods-again').addEventListener('click', () => lookAgain('Looking in your Downloads folder...'))
// A folder of the player's own: chosen in Windows' folder picker, kept by the launcher, and looked in straight away
$('#mods-folder').addEventListener('click', async () => {
  let result
  try { result = await window.localPlay.game.addModsFolder() } catch (error) { result = { success: false, error: error.message } }
  if (result?.cancelled) return
  if (!result?.success) return modsSays(result?.error || 'That folder could not be used. Choose another.')
  await lookAgain(`The launcher also looks in ${result.dir} now. Looking for your mods there...`)
})
// The Nexus window could not open: the same mod's Nexus page in the player's own browser
$('#mods-browser-open').addEventListener('click', async () => {
  const m = remainingMods().find(x => x.id === browserFallback)
  if (!m) return renderMods()
  let result
  try { result = await window.localPlay.game.openInBrowser(m.id) } catch (error) { result = { success: false, error: error.message } }
  modsSays(result?.success ? `${m.name} is open in your own browser. Download it there, then press Check my downloads.`
    : result?.error || 'Your browser could not be opened. Set a default browser in Windows settings, then try again.')
})
$('#mods-close').addEventListener('click', () => closeModal(modsModal))
// Settings, Mods: Log out of Nexus, whatever the Nexus window is doing (main refuses while a download is checked)
$('#nexus-logout').addEventListener('click', async () => {
  let result
  try { result = await window.localPlay.game.logoutNexus() } catch (error) { result = { success: false, error: error.message } }
  text('#nexus-status', result?.success ? 'The Nexus window is logged out on this PC.' : result?.error || 'The launcher could not log the Nexus window out. Try again.')
})

// Settings, Mods: the player's Nexus account. Logged in, it names the account and says whether the mods download by
// themselves (Nexus Premium); logged out, Log in to Nexus in the player's own browser, or why the launcher cannot yet
// The account button that last had keyboard focus. A browser moves focus off a button that is hidden to the page itself,
// and sends no focusin for that, so the row remembers the button: when the next redraw finds focus on the page and that
// button hidden, focus goes back to the row. It is used by one redraw only, and forgotten when focus lands anywhere else
// or the player clicks outside the row (focus the player sent to the page on purpose stays there)
let nexusRowFocus = null
$('#nexus-me-row').addEventListener('focusin', event => { nexusRowFocus = event.target })
document.addEventListener('focusin', event => { if (!$('#nexus-me-row').contains(event.target)) nexusRowFocus = null })
document.addEventListener('pointerdown', event => { if (!$('#nexus-me-row').contains(event.target)) nexusRowFocus = null }, true)
function renderNexusMe() {
  const me = nexusMe, on = nexusMeAvailable(), login = $('#nexus-me-login'), cancel = $('#nexus-me-cancel'), logout = $('#nexus-me-logout')
  const active = document.activeElement, buttons = [login, cancel, logout]
  const remembered = nexusRowFocus
  nexusRowFocus = buttons.includes(active) ? active : null
  const onPage = !active || active === document.body
  const hadFocus = buttons.includes(active) || (!!remembered && onPage && !!remembered.closest('[hidden]'))
  const name = me?.account?.name || ''
  // What Download them all does is said only while there are mods left to download
  const left = remainingMods().length
  text('#nexus-me', !me ? 'Checking your Nexus login...'
    : me.loggedIn ? (me.account?.premium ? `Logged in to Nexus as ${name}, with Nexus Premium.${directRunning() ? ' The mods are downloading by themselves now.' : left && !nexus.open ? ' Press Download them all and the mods download by themselves.' : ''}`
      : `Logged in to Nexus as ${name}. Only Nexus Premium members get the mods downloaded by themselves, so yours download in the Nexus window.`)
    : me.pending ? 'Finish logging in to Nexus in your browser.'
    // Why the last login ended (Nexus ended it), before the way back in; a failed login press says its own error below
    : on ? `${me.ended && me.error ? `${me.error} ` : ''}Log in to Nexus with a Premium account and the mods download by themselves. A free account downloads them in the Nexus window.`
    // The Dovakarn server did not answer: never said as Nexus login being off
    : me.available === null ? 'The launcher could not reach the Dovakarn server to check Nexus login. Close Settings and open it again to try again.'
    : 'Logging in to Nexus from the launcher is not switched on for Dovakarn yet. The mods download in the Nexus window.')
  login.hidden = !me || me.loggedIn || me.pending || !on
  cancel.hidden = !me?.pending
  logout.hidden = !me?.loggedIn
  $('#nexus-me-row').hidden = login.hidden && cancel.hidden && logout.hidden
  // A press that changed the buttons keeps keyboard focus in the row, or on the Mods tab when the row is empty
  const now = document.activeElement
  const lost = !now || now === document.body || !!now.closest?.('[hidden]')
  if (hadFocus && lost) ([cancel, logout, login].find(b => !b.hidden) || settings.querySelector('[role=tab][aria-selected=true]'))?.focus()
}
// The account changed: whatever shows it is drawn again
function drawNexusMe() {
  if (!settings.hidden && gameCopy()) renderNexusMe()
  if (!modsModal.hidden) renderMods()
}
function takeNexusMe(value) {
  if (!value || typeof value !== 'object') return
  const a = value.account && typeof value.account === 'object' ? value.account : null
  // ended: Nexus ended the login (its error says so); any other error was a login press, said where it was pressed
  nexusMe = { loggedIn: value.loggedIn === true, pending: value.pending === true, error: typeof value.error === 'string' ? value.error : null, ended: value.ended === true,
    account: a ? { name: typeof a.name === 'string' ? a.name.slice(0, 64) : '', premium: a.premium === true } : null,
    // true, false, or null when the server could not be asked; a push carries no answer about it, so the last one stands
    available: 'available' in value ? (value.available === true ? true : value.available === false ? false : null) : (nexusMe ? nexusMe.available : null) }
  drawNexusMe()
}
// Asked at start, and again when Settings or the mods window opens (the server may have switched Nexus login on since).
// No answer reads as Nexus login not on, never as a check that goes on for ever; the next opening asks again
const NEXUS_ME_OFF = { loggedIn: false, account: null, pending: false, error: null, available: null }
function loadNexusMe() {
  const ask = window.localPlay.nexusAccount?.state
  if (typeof ask !== 'function') return takeNexusMe(NEXUS_ME_OFF)
  Promise.resolve().then(ask).then(value => takeNexusMe(value || NEXUS_ME_OFF), () => takeNexusMe(NEXUS_ME_OFF))
}
window.localPlay.nexusAccount?.onState?.(takeNexusMe)
loadNexusMe()
// Log in to Nexus, from Settings or the mods window: the player's own browser opens Nexus's login page; the result is said
// where the press was made
async function nexusLogin(where) {
  const say = line => where === 'mods' ? modsSays(line) : text('#nexus-me-status', line)
  say('')
  if (nexusMe) { nexusMe = { ...nexusMe, pending: true }; drawNexusMe() }
  let result
  try { result = await window.localPlay.nexusAccount.login() } catch (error) { result = { success: false, error: error.message } }
  // The launcher's own answer is built once its login has ended, so it is taken as it is; with none, the wait is over
  takeNexusMe(result?.state || { ...(nexusMe || {}), pending: false })
  const a = nexusMe?.account
  say(result?.success && a ? (a.premium ? `Logged in to Nexus as ${a.name}, with Nexus Premium.` : `Logged in to Nexus as ${a.name}. It is a free account, so the mods still download in the Nexus window.`)
    : result?.code === 'cancelled' ? 'Nexus login cancelled.' : result?.error || 'The launcher could not log you in to Nexus. Try again.')
}
async function nexusCancel() { try { takeNexusMe(await window.localPlay.nexusAccount.cancel()) } catch { /* the login ends by itself */ } }
$('#nexus-me-login').addEventListener('click', () => nexusLogin('settings'))
$('#nexus-me-cancel').addEventListener('click', nexusCancel)
$('#nexus-me-logout').addEventListener('click', async () => {
  // The automatic download needs the login: the launcher stops it first, and the player is told
  let result
  try { result = await window.localPlay.nexusAccount.logout() } catch (error) { result = { success: false, error: error.message } }
  if (result?.state) takeNexusMe(result.state)
  // stopped: the launcher says whether a run was going when it stopped it (the page's own view may be a moment old)
  text('#nexus-me-status', result?.success ? `Logged out of Nexus on this PC.${result.stopped === true ? ' The automatic download stopped; the mods already downloaded stay.' : ''}`
    : result?.error || 'The launcher could not log you out of Nexus. Try again.')
})
// The mods window: Log in to Nexus (Cancel while the browser waits), Stop the automatic download, and the Nexus window
// for what it could not get
$('#mods-premium-login').addEventListener('click', () => nexusMe?.pending ? nexusCancel() : nexusLogin('mods'))
$('#mods-stop').addEventListener('click', async () => {
  let result
  try { result = await window.localPlay.game.stopDownloads() } catch { result = null }
  // Said only when the launcher says it stopped a run (the page's own view may be a moment old); otherwise its next push
  // says where things are
  if (result?.success && result.stopped === true) modsSays('Stopped. The mods already downloaded stay.')
})
$('#mods-window').addEventListener('click', () => getMod(null, true))
// Settings, Mods: Forget one of the player's own mod folders; the launcher only stops looking in it
$('#mods-folders').addEventListener('click', async event => {
  const b = event.target.closest('button[data-dir]')
  if (!b) return
  const dir = b.dataset.dir, at = [...$('#mods-folders').querySelectorAll('button[data-dir]')].indexOf(b)
  let result
  try { result = await window.localPlay.game.forgetModsFolder(dir) } catch (error) { result = { success: false, error: error.message } }
  text('#folders-status', result?.success ? `The launcher no longer looks in ${dir}.` : result?.error || 'That folder could not be forgotten. Try again.')
  await refresh()
  // Keyboard focus goes to the Forget now in its place, or back to the Mods tab when none is left
  if (settings.contains(document.activeElement)) return
  const left = [...$('#mods-folders').querySelectorAll('button[data-dir]')]
  ;(left[Math.min(at, left.length - 1)] || settings.querySelector('[role=tab][aria-selected=true]'))?.focus()
})

// Settings, Game: Dovakarn's folder, and putting the player's own Skyrim back the way earlier launchers left it
$('#copy-open').addEventListener('click', () => window.localPlay.game.openInstall())
$('#copy-setup').addEventListener('click', () => { closeModal(settings); openSetup() })
$('#copy-remove').addEventListener('click', async () => {
  let result
  try { result = await window.localPlay.game.remove() } catch (error) { result = { success: false, error: error.message } }
  if (result.success) say({ stage: 'ready', message: "Dovakarn's game was removed from this PC." })
  else if (!result.cancelled) say({ stage: 'failed', message: result.error })
  await refresh()
})
$('#restore-skyrim').addEventListener('click', async () => {
  const status = $('#restore-status')
  status.hidden = false; status.textContent = 'Putting your Skyrim back...'
  let result
  try { result = await window.localPlay.game.restoreSkyrim() } catch (error) { result = { success: false, error: error.message } }
  status.textContent = result.cancelled ? '' : result.success ? result.summary : result.error
  status.hidden = !status.textContent
  await refresh()
})

const ACTIONS = { folder: changeFolder, check: () => runCheck(), verify: () => { renderChecks(); openModal(checks) }, collection: openCollection, login: accountLogin, discord: openDiscord, recheck: accountRecheck,
  updateLauncher: installLauncherUpdate }
noticePrimary.addEventListener('click', () => ACTIONS[noticeActions.primary]?.())
noticeSecondary.addEventListener('click', () => ACTIONS[noticeActions.secondary]?.())
// Both windows open at any time; Verify starts a check only when one can run, else it follows the running one.
function openVerify() { renderChecks(); openModal(checks); if (canCheck()) runCheck({ show: true }) }
$('#verify').addEventListener('click', openVerify)
// Settings opens fresh: what an earlier visit said about logging out of Nexus or forgetting a folder is gone
const clearSettingsLines = () => { text('#nexus-status', ''); text('#nexus-me-status', ''); text('#folders-status', '') }
$('#settings-open').addEventListener('click', () => { clearSettingsLines(); showSettings(); openModal(settings, settings.querySelector('[aria-selected=true]')); loadNexusMe() })
$('#settings-done').addEventListener('click', () => closeModal(settings))
$('#folder-change').addEventListener('click', changeFolder)
$('#mods-get').addEventListener('click', openCollection)
$('#mods-details').addEventListener('click', ACTIONS.verify)
for (const id of ['#mods-check', '#updates-check']) $(id).addEventListener('click', () => { closeModal(settings); openVerify() })
$('#open-folder').addEventListener('click', () => window.localPlay.openGameFolder())
$('#checks-collection').addEventListener('click', openCollection)
$('#checks-again').addEventListener('click', () => runCheck({ show: true }))
$('#checks-close').addEventListener('click', () => closeModal(checks))
checksList.addEventListener('click', event => {
  const link = event.target.closest('button[data-mod]')
  if (link) window.localPlay.openMod(Number(link.dataset.mod))
  // Download, or Show while that download runs (the Nexus window brought forward wherever it is)
  const download = event.target.closest('button[data-archive]')
  if (download) getMod(download.dataset.show ? null : download.dataset.archive)
})
$('#account-login').addEventListener('click', accountLogin)
$('#account-settings-login').addEventListener('click', accountLogin)
$('#account-cancel').addEventListener('click', async () => { await window.localPlay.account.cancel(); await refresh() })
$('#account-chip').addEventListener('click', () => { clearSettingsLines(); showSettings(); selectTab('account'); openModal(settings, $('#tab-account-button')) })
$('#account-discord').addEventListener('click', openDiscord)
$('#account-logout').addEventListener('click', accountLogout)
// Launcher self-update: the server names the newest installer, which is downloaded, checked by hash and run
// silently (the launcher closes and reopens itself). Checked at start; an update on offer shows on the main
// screen (pickNotice), in the progress card while it downloads, and in the Updates tab.
const updatesAvailable = $('#updates-available'), updatesInstall = $('#updates-install'), updatesTrack = $('#updates-track')
let launcherUpdate = null, updateRunning = false, updateStep = null
function showUpdate(line, { installable = false } = {}) {
  updatesAvailable.hidden = !line
  setWords(updatesAvailable, line || '')        // "Downloading the update... 63%": its % in a span
  updatesInstall.hidden = !installable
}
// The Updates tab's own small bar follows the same download
function showUpdateTrack() {
  const step = updateStep, known = step?.phase === 'download' && step.total > 0
  updatesTrack.hidden = !step
  if (!step) return
  updatesTrack.classList.toggle('indeterminate', !known)
  const percent = known ? Math.min(99, Math.floor(step.received / step.total * 100)) : null
  if (known) { updatesTrack.querySelector('i').style.setProperty('--p', String(percent / 100)); updatesTrack.setAttribute('aria-valuenow', String(percent)) }
  else updatesTrack.removeAttribute('aria-valuenow')
}
// A found update downloads itself in the background; the press on the main button only installs.
// Nobody plays on an outdated launcher, so there is no way to wave the update aside.
// updateStopped: the version whose download the player cancelled; it waits for Download launcher update
const UPDATE_STOPPED = 'You stopped the launcher update. Press Download launcher update to start it again.'
let downloadedVersion = null, downloadingVersion = null, downloadFailed = false, downloading = null, updateStopped = null
const updateReady = () => !!launcherUpdate?.hasUpdate && launcherUpdate.latest === downloadedVersion && !updateRunning
const updateFetching = () => !!launcherUpdate?.hasUpdate && !launcherUpdate.blocked && !updateReady() && !updateRunning
const updateHeld = () => updateFetching() && !downloadingVersion && !!updateStopped && updateStopped === launcherUpdate.latest
function resumeUpdate() { updateStopped = null; autoDownloadUpdate() }
async function autoDownloadUpdate() {
  const latest = launcherUpdate?.latest
  if (!launcherUpdate?.hasUpdate || updateRunning || !latest || downloadedVersion === latest || downloadingVersion === latest || updateStopped === latest) return
  downloadingVersion = latest; downloadFailed = false; updateStep = { phase: 'download', received: 0, total: 0 }
  renderProgress(); showUpdateTrack(); syncPlay()
  let result
  downloading = (async () => { try { return await window.localPlay.update.download() } catch (error) { return { ok: false, error: error.message } } })()
  result = await downloading
  downloading = null; downloadingVersion = null; updateStep = null
  if (stopping === 'download') stopping = null
  downloadFailed = !result.ok && !result.cancelled
  if (result.ok) {
    downloadedVersion = latest
    showUpdate(`Launcher version ${latest} is downloaded and checked. Press Update launcher to install it.`, { installable: true })
  } else if (result.cancelled) {
    updateStopped = latest
    showUpdate(UPDATE_STOPPED, { installable: true })
  } else {
    showUpdate(result.error || 'The update could not be downloaded. It will be tried again.', { installable: true })
  }
  renderProgress(); showUpdateTrack(); showNotice(); syncPlay()
}
let lastUpdateCheckAt = 0
async function checkLauncherUpdate({ quiet = false } = {}) {
  if (updateRunning) return
  lastUpdateCheckAt = Date.now()
  let result
  try { result = await window.localPlay.update.check() } catch (error) { result = { hasUpdate: false, latest: null, error: error.message } }

  launcherUpdate = result
  if (result.hasUpdate && !result.blocked) autoDownloadUpdate()
  if (state) { showNotice(); syncPlay() }
  if (result.blocked) return showUpdate(result.blockedMessage)
  // The install button appears once the download is in and checked; until then the bar shows it coming
  if (result.hasUpdate && updateStopped === result.latest) return showUpdate(UPDATE_STOPPED, { installable: true })
  if (result.hasUpdate) return downloadedVersion === result.latest ? undefined : showUpdate(`Launcher version ${result.latest} is out. ${result.retry ? 'The last update did not finish, so it is downloading again now.' : 'It is downloading now.'}`, { installable: downloadFailed })
  if (!quiet) showUpdate(result.latest ? 'This launcher is up to date.'
    : result.reached ? 'This launcher is current: the server names no newer version.'
    : 'The update check could not reach the Dovakarn server. Try again in a minute.')
}
async function installLauncherUpdate() {
  if (updateRunning) return
  // A press here asks for the update, even one whose download was stopped before
  updateStopped = null
  // The same file is still downloading in the background: wait for it rather than start a second download
  if (downloading) await downloading
  // ...unless Cancel stopped that download meanwhile
  if (updateStopped) return
  updateRunning = true
  updatesInstall.disabled = true
  updateStep = { phase: 'download', received: 0, total: 0 }
  showNotice(); renderProgress(); showUpdateTrack(); syncPlay()
  showUpdate('Updating the launcher...', { installable: true })
  say({ stage: 'ready', message: 'Updating the launcher.' })
  let result
  try { result = await window.localPlay.update.install() } catch (error) { result = { ok: false, error: error.message } }
  if (result.ok) { showUpdate('Installing... the launcher closes and reopens itself in a moment.'); return }
  updateRunning = false; updateStep = null
  if (stopping === 'download') stopping = null
  updatesInstall.disabled = false
  if (result.cancelled) {
    // Stopped by the player: the card says so and the gold button starts it again
    updateStopped = launcherUpdate?.latest || null
    showUpdate(UPDATE_STOPPED, { installable: true })
    say({ stage: 'ready', message: '' })
  } else {
    showUpdate(result.error || 'The update could not be installed. Try again in a minute.', { installable: true })
    say({ stage: 'failed', message: result.error || 'The launcher update could not be installed. Try again in a minute.' })
  }
  renderProgress(); showUpdateTrack(); showNotice(); syncPlay()
}
updatesInstall.addEventListener('click', installLauncherUpdate)
// Download and install steps feed the bar only; the status line (read aloud) is not told every percent.
window.localPlay.update.onProgress(step => {
  if (!updateRunning && !downloadingVersion) return
  updateStep = step
  if (updateRunning) showUpdate(step.phase === 'install' ? 'Installing... the launcher closes and reopens itself in a moment.'
    : step.total ? `Downloading the update... ${Math.min(99, Math.floor(step.received / step.total * 100))}%` : 'Downloading the update...', { installable: step.phase !== 'install' })
  renderProgress(); showUpdateTrack(); syncPlay()
})
$('#updates-launcher-check').addEventListener('click', () => { showUpdate('Checking for a launcher update...'); checkLauncherUpdate() })
checkLauncherUpdate({ quiet: true }).catch(() => {})
$('#close').onclick = () => window.localPlay.close()
$('#minimize').onclick = () => window.localPlay.minimize()
window.localPlay.onProgress(value => launcherSays(value, { pushed: true }))
// The account (Discord name, membership, staff level) is asked of the server on open and every few minutes, when
// this server uses Discord login at all
const refreshAccount = () => (login().discord ? window.localPlay.account.refresh().then(refresh) : Promise.resolve()).catch(() => {})
// The check runs by itself when the launcher opens, unless Skyrim is already running or busy. The account is asked
// once the first state has arrived, since only that says whether this server uses Discord login.
refresh().then(() => {
  if (state && !state.gameRunning && !state.busy) runCheck()
  refreshAccount()
})
setInterval(refresh, 2000)
setInterval(refreshAccount, 5 * 60 * 1000)
// An idle launcher still hears about new releases: the check is one tiny request, so it runs every
// minute, and again the moment the window gets focus, so a glance at the launcher is never stale.
setInterval(() => checkLauncherUpdate({ quiet: true }).catch(() => {}), 60 * 1000)
window.addEventListener('focus', () => {
  if (Date.now() - lastUpdateCheckAt > 30 * 1000) checkLauncherUpdate({ quiet: true }).catch(() => {})
  // Back from Nexus or Vortex with a mods card showing: check again by itself, at most every 20 seconds. Never while
  // Dovakarn is being removed (its confirm dialog closing gives the launcher focus back)
  if (['Mods', 'Mod collection'].includes(shown?.kind) && !nexus.open && !nexus.removing && !nexus.removeAsking && !installWaiting() && canCheck() && Date.now() - lastFocusCheckAt > 20000) { lastFocusCheckAt = Date.now(); runCheck() }
})
// The server itself announced a change over its socket: check right now, and refresh the page state and its updates.
window.localPlay.update.onSignal?.(() => { checkLauncherUpdate({ quiet: true }).catch(() => {}); refresh(); loadUpdates() })
loadUpdates()
setInterval(loadUpdates, 5 * 60 * 1000)
