// Launch coordination for the Dovakarn page, local test server and online server alike. Server access stays in
// Electron's main process; online mode (main.js onlinePlayDeps) swaps the local server for the Dovakarn server:
// runtime.status reads its heartbeat, runtime.start only confirms it is reachable, and there is no server log.
const fs = require('node:fs')
const { describeFiles, filesView: toFilesView, checkSummary } = require('./fileCheck')
const { parseCollectionUrl } = require('./collectionCheck')

function logSize(file) { try { return fs.statSync(file).size } catch { return 0 } }
function newLogText(file, offset) {
  let fd
  try {
    const size = logSize(file), start = Math.max(size < offset ? 0 : offset, size - 65536)
    const bytes = Buffer.alloc(Math.max(0, size - start))
    fd = fs.openSync(file, 'r'); fs.readSync(fd, bytes, 0, bytes.length, start)
    return bytes.toString('utf8')
  } catch { return '' } finally { if (fd !== undefined) fs.closeSync(fd) }
}
const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const STOPPED = 'Stopped. Anything already downloaded is kept.'
// Server refusals the launcher's account notice shows on its own once the account is refreshed
const EXPLAINED = ['notLoggedIn', 'notMember', 'pendingMember', 'banned']
// A file check step as the progress bar reads it: by bytes where the step counts bytes (checking, downloading), else by
// files, where a step names the file it is starting (adapting); null when there is nothing to measure (Nexus)
function meterOf(step) {
  const whole = (part, all) => Math.max(0, Math.min(100, Math.floor(part / all * 100)))
  if (step.bytes > 0 && Number.isFinite(step.received)) return { percent: whole(step.received, step.bytes), received: step.received, bytes: step.bytes, done: step.done, total: step.total }
  if (step.total > 0 && Number.isFinite(step.done)) return { percent: whole(step.stage === 'patching' ? step.done - 1 : step.done, step.total), done: step.done, total: step.total }
  return null
}

class LocalPlay {
  // account: the Discord login (discordLogin.js); loginMode: whether the local server runs with Discord login (localTest.js)
  // keyChoices: the mod keys the player bound in Settings, Controls (main.js modKeyChoices), for the page
  // gameControls: the keys Skyrim's own controls use ({ code: [control] }, gameControls.js), for the Controls tab's clash notes
  // Dovakarn's own game copy (online, gameCopy.js): prepareGame({ progress, signal }) repairs it and installs the server's
  // mods before each check, answering { blocked: 'setup' | 'mods', message, mods } when the player must act first;
  // buildGame({ progress, signal }) makes it the first time; gameCopyState() describes it for the page
  // held(): why nothing may start now ('' when it may): main.js says so while Dovakarn's folder is being removed
  constructor({ runtime, launch, running, refreshFiles, checkFiles = async () => null, prepareHost = async () => null, fileList = () => null, gameFolder = () => null, openUrl = () => {}, serverLog, profileId = 1, maxPlayers = 8, launcherVersion = '', now = Date.now, notify = () => {}, account = null, loginMode = () => ({ discord: false }), serverName = 'Dovakarn-Local-Test', serverAddress = '', online = false, filesRevision = async () => null, verifiedRevision = () => '', rememberRevision = () => {}, keyChoices = () => ({}), gameControls = () => ({}), prepareGame = null, buildGame = null, gameCopyState = async () => null, held = () => '' }) {
    Object.assign(this, { runtime, launch, running, refreshFiles, checkFiles, prepareHost, fileList, gameFolder, openUrl, serverLog, profileId, maxPlayers, launcherVersion, now, notify, account, loginMode, serverName, serverAddress, online, filesRevision, verifiedRevision, rememberRevision, keyChoices, gameControls, prepareGame, buildGame, gameCopyState, held })
    // Quiet until there is something to say: the gold button already says Play
    this.phase = { stage: 'ready', message: '' }
    this.busy = false; this.startedAt = 0; this.offset = 0; this.files = null; this.lastCheck = null; this.launchedProfileId = null
    this.probe = null
  }
  // The status line; the page is told only when it changes (state() repeats the same line on every refresh). meter:
  // how far a long step has got, for the page's progress bar ({ percent, received, bytes, done, total }); the page is
  // told again only when its whole percent moves
  progress(stage, message, meter = null) {
    if (this.phase.stage === stage && this.phase.message === message && (this.phase.meter?.percent ?? null) === (meter?.percent ?? null)) return
    this.phase = meter ? { stage, message, meter } : { stage, message }; this.notify(this.phase)
  }
  // Online, the server is not started from this PC: runtime.start only confirms it answers.
  startingMessage() { return this.online ? `Contacting ${this.serverName}...` : `Starting ${this.serverName}...` }
  // Why nothing may start now, or '' (a held() that throws holds nothing)
  heldBy() { try { const why = this.held(); return typeof why === 'string' ? why : '' } catch { return '' } }
  discord() { return !!(this.loginMode().discord && this.account) }
  // With Discord login the game plays as the player's account number, else as the offline test profile. A launch keeps
  // the number it started with, so a logout while the game runs does not lose track of it.
  activeProfileId() { return this.launchedProfileId || (this.discord() ? (this.account.status().account?.number || null) : this.profileId) }
  // The Discord play session for this launch; a refusal (not logged in, not in the Discord, banned) stops the launch
  async discordLogin() {
    const mode = this.loginMode()
    try {
      const data = await this.account.play()
      return { login: { session: data.session, account: data.account, master: mode.master, masterKey: mode.masterKey, inviteUrl: await this.account.inviteUrl() } }
    } catch (error) {
      // Refusals the account notice already explains step aside for it; any other (server unreachable, Discord not
      // answering, the server locked) is news, so it shows as a failure
      this.progress(EXPLAINED.includes(error.code) ? 'account' : 'failed', error.message)
      return { refused: { success: false, error: error.message, account: error.code || 'error', inviteUrl: error.inviteUrl || null } }
    }
  }
  // Cancel pressed on the page: the running check or file update stops at once; files already fetched are kept
  cancel() {
    if (!this.abort) return { success: false }
    this.abort.abort(); return { success: true }
  }
  // Starts the server and checks game files; returns the refusal to show, or null to carry on.
  async verify(ignoreWarnings) {
    this.abort = new AbortController()
    try { return await this.verifyFiles(ignoreWarnings, this.abort.signal) } finally { this.abort = null }
  }
  async verifyFiles(ignoreWarnings, signal) {
    // The server follows this PC's own mod install: collection plugins and Nemesis output, redone when they change.
    let staged
    try { staged = await this.prepareHost(message => this.progress('preparingHost', message)) }
    catch (error) { this.lastCheck = { at: this.now(), failed: true, error: `Could not set up the server's mods: ${error.message}` }; throw Error(this.lastCheck.error) }
    if (staged?.changed) {
      const status = await this.runtime.status()
      // Players already in keep playing; the new mods load at the next restart.
      if (status.online && !(status.players || []).length) {
        this.progress('startingServer', `Restarting ${this.serverName} with the updated mods...`)
        // A server running in its own console window restarts there, so the window stays.
        if (this.runtime.restart) await this.runtime.restart(); else await this.runtime.stop()
      }
    }
    this.progress('startingServer', this.startingMessage())
    await this.runtime.start()
    // Dovakarn's own game copy: put right if a file was damaged, then the server's mods installed into it. A copy not
    // set up yet, or mods still to download from Nexus, stop here with what to do.
    if (this.prepareGame) {
      let ready
      try { ready = await this.prepareGame({ progress: (stage, message, meter) => this.progress(stage, message, meter), signal }) }
      catch (error) {
        if (error.code === 'CANCELLED' || signal.aborted) throw Object.assign(new Error(STOPPED), { code: 'CANCELLED' })
        this.lastCheck = { at: this.now(), failed: true, error: error.message }; throw error
      }
      if (ready?.blocked) {
        this.lastCheck = { at: this.now(), published: true, setup: ready.blocked, ...(ready.mods ? { mods: ready.mods.length } : {}) }
        this.progress(ready.blocked === 'mods' ? 'modsNeeded' : 'setupNeeded', ready.message)
        return { success: false, error: ready.message, setup: ready.blocked }
      }
    }
    this.progress('checking', 'Checking your game files against the server...')
    this.refreshFiles()
    try {
      // Server setup ends by rebuilding the player file list, so the check does not build it again.
      this.files = await this.checkFiles(step => this.progress(...({
        updating: ['updatingFiles', `Updating Dovakarn files, ${step.done} of ${step.total}...`],
        patching: ['patchingFiles', `Adapting mod files for the server, ${step.done} of ${step.total}...`],
        collection: ['checking', 'Checking the mod collection on Nexus...'],
      }[step.stage] || ['checking', 'Checking your game files against the server...']), meterOf(step)), { published: !!staged, signal })
    } catch (error) {
      // Stopped by the player: not a failure, and the last real result stands
      if (error.code === 'CANCELLED' || signal.aborted) throw Object.assign(new Error(STOPPED), { code: 'CANCELLED' })
      this.lastCheck = { at: this.now(), failed: true, error: error.message }; throw error
    }
    // The online fixes to mod files server setup could not make show with the check, so they are never silent
    this.lastCheck = { ...checkSummary(this.files, this.now()), ...(staged?.unfixed?.length ? { unfixed: staged.unfixed.map(u => ({ fix: u.fix, reason: u.reason })) } : {}) }
    // The revision just verified is what the Update button's staleness check compares against.
    if (this.files?.revision) { this.rememberRevision(this.files.revision); this.probe = null }
    // Blocking mismatches wait for the player; mod warnings can be accepted with Play anyway.
    if (this.files?.blocked) { this.progress('filesBlocked', describeFiles(this.files)); return { success: false, error: this.phase.message } }
    if (this.files?.warnings.length && !ignoreWarnings) { this.progress('filesWarning', describeFiles(this.files)); return { success: false, error: this.phase.message, canPlayAnyway: true } }
    return null
  }
  async play({ ignoreWarnings = false } = {}) {
    if (this.busy) return { success: false, error: 'Skyrim is already being prepared. Please wait.' }
    const held = this.heldBy()
    if (held) return { success: false, error: held }
    this.busy = true
    try {
      if (await this.running()) throw Error(`Skyrim is already open. Close it first, then use this launcher to join ${this.serverName}.`)
      // Asked before the long file check, so nobody waits through it only to be told to log in, that they are banned,
      // or that they must join the Dovakarn Discord (Discord is asked afresh, so someone who just joined gets in)
      if (this.discord()) {
        let current = this.account.status().loggedIn ? await this.account.refresh({ fresh: true }) : this.account.status()
        // The Dovakarn backend starts with the server window: with the window closed, the server starts first (opening
        // it), and the account is asked once it runs
        if (current.loggedIn && current.reached === false && !(await this.runtime.status().catch(() => ({ online: false }))).online) {
          this.progress('startingServer', this.startingMessage())
          await this.runtime.start()
          current = await this.account.refresh({ fresh: true })
        }
        if (!current.loggedIn) {
          const text = current.error || 'Log in with Discord to play.'
          this.progress('account', text)
          return { success: false, error: text, account: 'notLoggedIn' }
        }
        // The server did not answer: say so, rather than judge the account this PC saved last time
        if (current.reached === false) {
          const text = current.problem || 'The Dovakarn server could not be reached. Try again in a minute.'
          this.progress('failed', text)
          return { success: false, error: text, account: 'unreachable' }
        }
        // The rules screen and membership count only when this server requires the Dovakarn Discord, as on the server,
        // and only on an answer Discord gave just now (askAgainIn 0): the backend asks Discord at most every 30 seconds,
        // so a player who joined a moment ago goes on, and Play itself asks Discord again. A ban always stops here.
        const a = current.account || {}, required = a.requireMembership !== false, fresh = !current.askAgainIn
        const block = a.banned ? (a.banLinked ? a.banReason : a.banReason ? `You are banned: ${a.banReason}` : 'You are banned from Dovakarn.')
          : a.pending && required && fresh ? 'Finish the Dovakarn Discord rules screen, then press Play again.'
          : a.member === false && required && fresh ? 'Join the Dovakarn Discord to play.' : null
        if (block) {
          this.progress('account', block)
          return { success: false, error: block, account: a.banned ? 'banned' : a.pending ? 'pendingMember' : 'notMember', inviteUrl: a.banned ? null : await this.account.inviteUrl() }
        }
      }
      const refused = await this.verify(ignoreWarnings)
      if (refused) return refused
      let login = null
      if (this.discord()) {
        const result = await this.discordLogin()
        if (result.refused) return result.refused
        login = result.login
      }
      this.offset = logSize(this.serverLog)
      this.progress('startingGame', 'Starting Skyrim with the multiplayer client...')
      // The game client's own keys from the check just passed (the online launch checks again and uses its own)
      const result = await this.launch({ login, gameKeys: this.files?.gameKeys || null })
      if (!result.success) throw Error(result.error || 'Skyrim could not start.')
      this.launchedProfileId = login ? login.account.number : this.profileId
      this.startedAt = this.now()
      this.progress('connecting', 'Skyrim is connecting. Your character menu will appear inside the game. Do not use the normal New or Continue buttons.')
      return { success: true }
    } catch (error) {
      this.startedAt = 0; this.launchedProfileId = null
      if (error.code === 'CANCELLED') { this.progress('ready', STOPPED); return { success: false, cancelled: true, error: STOPPED } }
      this.progress('failed', error.message)
      return { success: false, error: error.message }
    } finally { this.busy = false }
  }
  // Checks and repairs game files against the server without starting Skyrim.
  async check() {
    if (this.busy) return { success: false, error: 'Skyrim is already being prepared. Please wait.', code: 'BUSY' }
    const held = this.heldBy()
    if (held) return { success: false, error: held }
    this.busy = true
    try {
      // Skyrim keeps its plugins and DLLs locked while it runs, so nothing could be updated.
      if (await this.running()) throw Error('Close Skyrim before checking your mods.')
      const refused = await this.verify(false)
      if (refused) return refused
      const s = this.lastCheck
      const done = [s.updated && `updated ${count(s.updated, 'Dovakarn file')}`, s.patched && `adapted ${count(s.patched, 'mod file')}`,
        s.moved && `moved ${count(s.moved, 'file')} the server does not use into "Dovakarn removed files" in ${this.prepareGame ? "Dovakarn's game folder" : 'your Skyrim folder'}`].filter(Boolean)
      // All quiet when all is well: the main screen only speaks when the check changed or found something.
      this.progress('ready', !s.published ? 'This server does not publish a file list, so there is nothing to check.'
        : done.length ? `Your game was brought up to date: ${done.join(', ')}.` : '')
      return { success: true }
    } catch (error) {
      if (error.code === 'CANCELLED') { this.progress('ready', STOPPED); return { success: false, cancelled: true, error: STOPPED } }
      this.progress('failed', error.message)
      return { success: false, error: error.message }
    } finally { this.busy = false }
  }
  // Makes Dovakarn's own game copy the first time (Install in the setup window): Skyrim 1.6.1170 copied or moved in and
  // checked file by file. Cancel stops it; files already in place are kept and checked again next time.
  async setupGame() {
    if (!this.buildGame) return { success: false, error: 'This launcher plays from a server game copy.' }
    if (this.busy) return { success: false, error: 'Skyrim is already being prepared. Please wait.' }
    const held = this.heldBy()
    if (held) return { success: false, error: held }
    this.busy = true
    this.abort = new AbortController()
    try {
      if (await this.running()) throw Error('Close Skyrim before setting up Dovakarn.')
      await this.buildGame({ progress: (stage, message, meter) => this.progress(stage, message, meter), signal: this.abort.signal })
      this.progress('ready', 'Skyrim 1.6.1170 is in place. Next, the mods.')
      return { success: true }
    } catch (error) {
      if (error.code === 'CANCELLED' || this.abort?.signal.aborted) { this.progress('ready', STOPPED); return { success: false, cancelled: true, error: STOPPED } }
      this.progress('failed', error.message)
      return { success: false, error: error.message, code: error.code || null }
    } finally { this.busy = false; this.abort = null }
  }
  // A server announcement says the published files changed: the next state() asks afresh instead of trusting the cache.
  pokeFilesProbe() { this.probe = null }
  // Whether the server has published game files this PC has not verified yet. Asked at most once a minute; the
  // answer turns Play into the Update button, and the real gate stays in verify() either way.
  async updateProbe() {
    if (!this.online) return null
    const now = this.now()
    if (this.probe && now - this.probe.at < 60000) return this.probe.view
    let revision = null
    try { revision = await this.filesRevision() } catch { /* Offline or the server is restarting: keep the last answer. */ }
    const view = revision ? { needed: revision !== this.verifiedRevision(), revision } : (this.probe?.view || null)
    this.probe = { at: now, view }
    return view
  }
  async state() {
    const [status, gameRunning, gameFolder, gameCopy] = await Promise.all([this.runtime.status(), this.running(), this.gameFolder(), this.readGameCopy()])
    if (this.startedAt && !this.busy) {
      const elapsed = this.now() - this.startedAt
      if (!gameRunning && elapsed > 20000) {
        this.startedAt = 0; this.launchedProfileId = null
        this.progress('ready', 'Skyrim is closed. Launch again to choose one of your saved characters.')
      } else if (this.online) {
        // The online server names no players and has no log here, so a running game is taken at its word: no
        // menu confirmation, and a missed heartbeat is never called a failure while the game may be playing fine.
      } else if (!status.online) {
        // A roster from before a server shutdown cannot confirm a new connection.
        this.offset = logSize(this.serverLog)
        this.progress('failed', 'Your local server is no longer responding. Close Skyrim, then launch again to restart the server and reconnect.')
      } else if (gameRunning && (status.players || []).some(player => player.profileId === this.activeProfileId())) {
        this.progress('playing', `Your character is connected to ${this.serverName}. Enjoy your adventure!`)
      } else if (newLogText(this.serverLog, this.offset).includes(`Character selection ready profile ${this.activeProfileId()} `)) {
        this.progress('characterMenu', 'Connected. Choose your character in the Dovakarn menu inside Skyrim, or create a new one.')
      } else if (elapsed > 180000) {
        this.progress('failed', 'The character menu has not been confirmed yet. Close Skyrim and try again from this launcher. If you still see the normal main menu, check the multiplayer client logs.')
      }
    }
    const online = !!status.online
    const playerNames = online ? (status.players || []).map(p => typeof p.name === 'string' && p.name ? p.name : 'Player') : []
    return {
      serverOnline: online, gameRunning, busy: this.busy, phase: this.phase, files: this.filesView(), filesUpdate: await this.updateProbe(),
      // Whether this launcher plays on the online Dovakarn server or a server on this PC (the page words itself by it)
      mode: this.online ? 'online' : 'local',
      // Only names and numbers reach the page. The online heartbeat carries a player count and no names.
      server: {
        name: this.serverName, address: this.serverAddress,
        uptime: online && Number.isFinite(status.uptime) ? Math.floor(status.uptime) : null,
        players: playerNames,
        count: online ? (Number.isFinite(status.count) ? status.count : playerNames.length) : 0,
        max: Number.isFinite(status.max) ? status.max : this.maxPlayers,
      },
      fileList: this.readFileList(), lastCheck: this.lastCheck, gameFolder, gameCopy, launcherVersion: this.launcherVersion, keyChoices: this.keyChoices(), gameControls: this.readGameControls(),
      // Discord login: whether this server needs it, and who is logged in (name, picture, account number, staff level)
      login: { testProfile: this.profileId, ...(this.account ? { discord: this.discord(), ...this.account.status() } : { discord: false, loggedIn: false, account: null, pending: false, error: null }) },
    }
  }
  // Results for the old folder no longer apply once the player picks another Skyrim.
  folderChanged() {
    this.files = null; this.lastCheck = null
    // The new folder's files have not been verified against anything yet.
    this.rememberRevision(''); this.probe = null
    this.progress('ready', 'Skyrim folder changed.')
  }
  // Dovakarn's own game copy for the page (null where the launcher plays from a server's copy); a failure only hides it
  async readGameCopy() { try { return await this.gameCopyState() } catch { return null } }
  // A missing or unreadable list only hides the details; the check itself reports real errors.
  readFileList() { try { return this.fileList() } catch { return null } }
  // An unreadable control map only drops the clash notes
  readGameControls() { try { return this.gameControls() || {} } catch { return {} } }
  filesView() {
    if (!this.files || !['filesBlocked', 'filesWarning'].includes(this.phase.stage)) return null
    return toFilesView(this.files)
  }
  openCollection() {
    const url = this.files?.collection?.url || this.readFileList()?.collection?.url
    if (!url) return { success: false, error: 'The server has not published a mod collection link yet.' }
    this.openUrl(url)
    return { success: true }
  }
  // A mod's Nexus page, on the same game site as the collection; only a whole mod id is accepted.
  openMod(modId) {
    if (!Number.isSafeInteger(modId) || modId <= 0) return { success: false, error: 'Unknown mod.' }
    const domain = parseCollectionUrl(this.files?.collection?.url || this.readFileList()?.collection?.url)?.domain || 'skyrimspecialedition'
    this.openUrl(`https://www.nexusmods.com/${domain}/mods/${modId}`)
    return { success: true }
  }
}
module.exports = { LocalPlay, newLogText }
