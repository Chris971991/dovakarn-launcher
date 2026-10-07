'use strict'
// The player's Nexus Mods account in the launcher: "Log in to Nexus" from a button the player presses, and, for Nexus
// Premium members, each mod's download link asked from Nexus's API so the mods download by themselves. A free account
// keeps the launcher's Nexus window (nexusDownloads.js): Nexus never lets a free account download through its API.
//
// The login is Nexus's OAuth with PKCE (Nexus's own oauth2-demo-app and Vortex do the same): the player's own browser
// logs in on Nexus's site and sends a one-time code back to a listener on 127.0.0.1 (this PC only, closed again as soon
// as it answers); the launcher swaps the code for Nexus's tokens itself. There is no client secret, so nothing goes
// through the Dovakarn server: it only tells the launcher which Nexus application and ports to use (/api/auth/nexus),
// and the tokens never leave this PC. They are kept sealed with Windows (Electron safeStorage), as the Discord key is.
// Every call to Nexus says who is asking (Application-Name, Application-Version), as Nexus's API rules require.

const https = require('https')
const fs = require('fs')
const { LoginError, pkce, listenOnFirstFree, secureBase, LOOPBACK_CALLBACK } = require('./discordLogin')
const { NEXUS_GAME } = require('./modInstall')
const { APP_NAME, APP_VERSION, nexusHeaders: appHeaders } = require('./nexusApp')

const USERS = 'https://users.nexusmods.com'
const API = 'https://api.nexusmods.com'
// Only what the launcher uses: the account's name and membership, read from the access token. No email is asked for
const SCOPE = 'openid profile'
// A new player may first have to make a Nexus account, confirm their email and set up two-factor
const LOGIN_TIMEOUT = 5 * 60 * 1000
// A token is renewed this long before Nexus says it ends, so a download never starts with one about to run out
const RENEW_EARLY = 60 * 1000
const STALL = 60 * 1000
const REDIRECTS = 5
const ENDED = 'Your Nexus login has ended. Log in to Nexus again.'
const NOT_ON = 'Nexus login is not switched on for Dovakarn yet. Download the mods in the Nexus window for now.'

const WORDS = {
  tag: '[nexus]',
  outOfDate: 'This Nexus login link is out of date. Close this tab. If the launcher is still waiting, use the newest tab it opened, or press Cancel there and log in again.',
  cancelledPage: 'You cancelled the Nexus login. Close this tab and try again from the launcher.',
  cancelled: 'You cancelled the Nexus login.',
  refused: 'Nexus refused the login',
  setupPage: 'Nexus login is not set up correctly for Dovakarn. Close this tab and tell the Dovakarn staff.',
  setup: ['Nexus login is not set up correctly for Dovakarn. Tell the Dovakarn staff.', 'nexusMisconfigured'],
  failedPage: 'Nexus could not finish the login. Close this tab and try again from the launcher in a minute.',
  failed: ['Nexus could not finish the login. Try again in a minute.', 'nexusError'],
  noCodePage: 'Nexus did not send a login code. Close this tab and try again from the launcher.',
  noCode: 'Nexus did not send a login code. Try again.',
  approvedTitle: 'Nexus approved',
  approved: 'Go back to the Dovakarn launcher. It finishes logging you in to Nexus.',
  timeout: 'Timed out waiting for Nexus. Press Log in to Nexus to try again.',
  reserved: ports => `Windows has set aside the ports the Nexus login uses: ${ports}. Hyper-V, WSL or Docker often do this. Restarting the PC usually frees them.`,
  busy: ports => `Another program is using the Nexus login ports: ${ports}. Close it and try again.`,
}

// Nexus's own hosts: its site, its API and its file servers. A download link, and every redirect on the way to the file,
// must stay on them
const hostOf = url => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } }
const nexusFileHost = host => host === 'nexusmods.com' || host.endsWith('.nexusmods.com') || host.endsWith('.nexus-cdn.com')
const nexusFileUrl = url => { try { const u = new URL(url); return u.protocol === 'https:' && u.port === '' && nexusFileHost(u.hostname.toLowerCase()) } catch { return false } }

// The account a Nexus access token is for. Nexus's access token is a JWT whose payload carries the user (Vortex and
// node-nexus-api read it the same way: user.id, user.username, user.membership_roles). It is read, not verified: it came
// straight from Nexus over HTTPS, and it only decides what the launcher shows and whether to ask for links
function accountFromToken(token) {
  try {
    const part = String(token).split('.')[1]
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    const user = payload && payload.user
    if (!user || typeof user !== 'object') return null
    const name = typeof user.username === 'string' ? user.username.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : ''
    const roles = Array.isArray(user.membership_roles) ? user.membership_roles.map(String) : []
    return { name, id: Number.isSafeInteger(user.id) ? user.id : null, premium: roles.includes('premium'),
      expiresAt: Number.isFinite(payload.exp) ? payload.exp * 1000 : null }
  } catch { return null }
}

/**
 * apiUrl(): the Dovakarn server, asked for the Nexus application (GET /api/auth/nexus). store: { get, set }. safeStorage:
 * Electron's. openExternal(url): the player's own browser. appVersion: this launcher's version, sent to Nexus.
 * fetchImpl: fetch-like, for the server and Nexus's token endpoint. getFile(url, options): https GET with redirects
 * refused (nexusFile follows them itself); tests pass stand-ins for both.
 */
function createNexusAccount({ apiUrl, store, safeStorage, openExternal, appVersion = APP_VERSION, log = () => {}, fetchImpl = globalThis.fetch, now = Date.now,
  timeoutMs = LOGIN_TIMEOUT, getFile = httpsGet, usersUrl = USERS, apiBase = API,
  unreachableMessage = () => 'The Dovakarn server could not be reached. Check your internet connection, or try again in a minute.' }) {
  let pending = null
  let lastError = null
  let configCache = null
  let memoryTokens = null                  // without Windows encryption: kept for this run only, never written
  let renewing = null                      // one token renewal at a time; everyone waiting shares it
  // Nexus's rate limit: no API call until `until` (0: none). kind words the message; accountId: whose limit it is
  let limit = { until: 0, kind: null, accountId: null }
  const listeners = new Set()
  const tell = () => { for (const fn of listeners) { try { fn(status()) } catch (error) { log(`[nexus] the page was not told: ${error.message}`) } } }

  const nexusHeaders = extra => appHeaders(extra, appVersion)

  // ---- the Dovakarn server: which Nexus application to log in with ----
  // Only a real answer is kept (a minute): Nexus login on or off, or an older server without it (404, the same as off).
  // The server not answering, or answering with an error, is never taken as "off": it is asked again next time
  async function config() {
    if (configCache && now() - configCache.at < 60 * 1000) return configCache.value
    const base = String(apiUrl() || '').replace(/\/+$/, '')
    if (!base) throw new LoginError('This launcher has no Dovakarn server address.', 'noServer')
    if (!secureBase(base)) throw new LoginError("This launcher's Dovakarn server address is not a secure https address.", 'insecureServer')
    let res
    try { res = await fetchImpl(`${base}/api/auth/nexus`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000) }) }
    catch { throw new LoginError(unreachableMessage(), 'unreachable') }
    let data = null
    try { data = await res.json() } catch { /* not JSON */ }
    let value
    if (res.status === 404) value = { ready: false }
    else if (res.ok && data && typeof data === 'object') value = data
    else { log(`[nexus] the Dovakarn server answered ${res.status} about Nexus login`); throw new LoginError(unreachableMessage(), 'unreachable') }
    configCache = { at: now(), value }
    return value
  }
  // Whether the server has a Nexus application set up: true, false, or null when the server could not be asked (the page
  // says so rather than calling Nexus login off)
  async function available() {
    try {
      const cfg = await config()
      return !!(cfg.ready && cfg.clientId && (cfg.redirectUris || []).some(uri => LOOPBACK_CALLBACK.test(String(uri))))
    } catch { return null }
  }

  // ---- the tokens, sealed with Windows ----
  // { access, refresh, expiresAt, clientId }: the Nexus application they were issued to goes with them, so renewing and
  // revoking never depend on the Dovakarn server answering, or on its client id changing later
  const canSeal = () => !!(safeStorage && safeStorage.isEncryptionAvailable())
  function saveTokens(tokens) {
    if (canSeal()) { memoryTokens = null; store.set('nexusToken', 'enc:v1:' + safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')); return }
    log('[nexus] Windows encryption is unavailable: this Nexus login lasts until the launcher closes')
    memoryTokens = tokens
    store.set('nexusToken', null)
  }
  function tokens() {
    if (memoryTokens) return memoryTokens
    const stored = store.get('nexusToken')
    if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return null
    try {
      const t = JSON.parse(safeStorage.decryptString(Buffer.from(stored.slice(7), 'base64')))
      return t && typeof t.access === 'string' && typeof t.refresh === 'string' && typeof t.clientId === 'string' ? t : null
    } catch { return null }
  }
  function forget() { memoryTokens = null; store.set('nexusToken', null); store.set('nexusAccount', null) }

  // ended: the error is Nexus ending the login (said before the way back in); any other error is a login press's own
  function status() {
    const account = store.get('nexusAccount') || null
    return { loggedIn: !!(account && tokens()), account: account && tokens() ? account : null, pending: !!pending, error: lastError, ended: lastError === ENDED }
  }
  // Rejects with a Cancel once signal aborts (a race partner, so a slow step never holds a cancelled login)
  const stopped = signal => new Promise((_resolve, reject) => {
    const cancel = () => reject(new LoginError('Login cancelled.', 'cancelled'))
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
  })

  // ---- Nexus's token endpoint ----
  // stop: the login's Cancel, which ends the wait at once. The request itself still runs to its end, so tokens Nexus issues
  // after a Cancel are seen, and Nexus is told they are not used
  async function tokenRequest(form, stop = null) {
    const call = fetchImpl(`${usersUrl}/oauth/token`, {
      method: 'POST',
      headers: nexusHeaders({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' }),
      body: new URLSearchParams(form).toString(),
      redirect: 'error', signal: AbortSignal.timeout(15000),
    }).then(async res => { let data = null; try { data = await res.json() } catch { /* not JSON */ } return { res, data } })
    let answer
    try { answer = await (stop ? Promise.race([call, stopped(stop)]) : call) }
    catch (error) {
      if (error?.code === 'cancelled') {
        call.then(({ res, data }) => { if (res.ok && data && typeof data.refresh_token === 'string') revoke({ refresh: data.refresh_token, clientId: String(form.client_id) }, 'about a cancelled login') }, () => {})
        throw error
      }
      throw new LoginError('Nexus could not be reached. Check your internet connection, or try again in a minute.', 'nexusUnreachable')
    }
    const { res, data } = answer
    if (!res.ok) {
      const code = data && typeof data.error === 'string' ? data.error : `http${res.status}`
      log(`[nexus] the token request answered ${res.status} (${code})`)
      throw Object.assign(new LoginError(res.status >= 500 ? 'Nexus is having trouble right now. Try again in a minute.' : 'Nexus refused the login. Try again.', code), { status: res.status })
    }
    if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') throw new LoginError('Nexus sent an unexpected reply. Try again.', 'badReply')
    const who = accountFromToken(data.access_token)
    const expiresIn = Number(data.expires_in)
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : who?.expiresAt || now() + 60 * 60 * 1000
    return { tokens: { access: data.access_token, refresh: data.refresh_token, expiresAt, clientId: String(form.client_id) }, who }
  }
  function keep(result) {
    // Another Nexus account: the last one's rate limit is not this one's
    if (result.who && result.who.id !== limit.accountId) clearLimit()
    saveTokens(result.tokens)
    if (result.who) store.set('nexusAccount', { name: result.who.name, id: result.who.id, premium: result.who.premium })
  }
  // Tokens Nexus issued that the launcher will not keep (a Cancel after Nexus answered, a renewal that lost to a logout):
  // Nexus is told, in the background, so they do not stay usable
  function revoke(t, why) {
    if (!t || !t.refresh || !t.clientId) return Promise.resolve()
    return fetchImpl(`${usersUrl}/oauth/revoke`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: nexusHeaders({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }),
      body: new URLSearchParams({ client_id: t.clientId, token: t.refresh, token_type_hint: 'refresh_token' }).toString() })
      .then(() => {}, error => log(`[nexus] Nexus was not told ${why}: ${error.message}`))
  }

  // ---- logging in ----
  async function login() {
    if (pending) throw new LoginError('A Nexus login is already waiting in your browser. Finish it there, or press Cancel.', 'pending')
    lastError = null
    const flow = { cancelled: false, listener: null, stop: new AbortController() }
    pending = { cancel: () => { flow.cancelled = true; flow.stop.abort(); flow.listener?.close(new LoginError('Login cancelled.', 'cancelled')) } }
    tell()
    try {
      // Cancel ends the wait even while the Dovakarn server is still being asked
      const cfg = await Promise.race([config(), stopped(flow.stop.signal)])
      const redirectUris = (cfg && Array.isArray(cfg.redirectUris) ? cfg.redirectUris : []).filter(uri => LOOPBACK_CALLBACK.test(String(uri)))
      if (!cfg || !cfg.ready || !cfg.clientId || !redirectUris.length) throw new LoginError(NOT_ON, 'nexusNotConfigured')
      const { verifier, challenge, state } = pkce()
      flow.listener = await listenOnFirstFree(redirectUris, state, timeoutMs, log, WORDS)
      if (flow.cancelled) throw new LoginError('Login cancelled.', 'cancelled')
      const url = new URL(`${usersUrl}/oauth/authorize`)
      url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: flow.listener.redirectUri, scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
      try { await openExternal(url.toString()) }
      catch (err) {
        log(`[nexus] could not open the browser: ${err.message}`)
        throw new LoginError('The launcher could not open your web browser. Set a default browser in Windows settings, then try again.', 'browser')
      }
      const { code } = await flow.listener.result
      const result = await tokenRequest({ grant_type: 'authorization_code', client_id: cfg.clientId, redirect_uri: flow.listener.redirectUri, code, code_verifier: verifier }, flow.stop.signal)
      // Cancel pressed as Nexus answered: the login is not kept, and Nexus is told
      if (flow.cancelled) { revoke(result.tokens, 'about a cancelled login'); throw new LoginError('Login cancelled.', 'cancelled') }
      if (!result.who || !result.who.name) { revoke(result.tokens, 'about a login it could not read'); throw new LoginError('Nexus sent an unexpected reply. Try again.', 'badReply') }
      keep(result)
      log(`[nexus] logged in to Nexus as ${result.who.name}${result.who.premium ? ' (Premium)' : ''}`)
    } catch (err) {
      if (err.code !== 'cancelled') lastError = err.message
      throw err
    } finally {
      flow.listener?.close()
      pending = null
      tell()
    }
    // Said once the wait is over, so the answer never reads as still waiting
    return status()
  }
  function cancel() { if (pending) pending.cancel(); return status() }

  // A valid access token: renewed first when it ends within a minute (or when Nexus refused it: rejected). One renewal at a
  // time. Nexus refusing the renewal ends the login; Nexus out of reach keeps it for later
  async function accessToken({ rejected = null } = {}) {
    const t = tokens()
    if (!t) throw new LoginError('Log in to Nexus first.', 'nexusLoggedOut')
    if (!rejected && t.expiresAt - RENEW_EARLY > now()) return t.access
    if (rejected && rejected !== t.access) return t.access          // someone else renewed it meanwhile
    if (!renewing) {
      renewing = (async () => {
        try {
          const result = await tokenRequest({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refresh })
          // A logout or a new login while this ran: what it brought is not kept, and Nexus is told
          const kept = tokens()
          if (kept?.refresh !== t.refresh) {
            revoke(result.tokens, 'about a renewal nobody needs')
            if (!kept) throw new LoginError('Log in to Nexus first.', 'nexusLoggedOut')
            return kept.access
          }
          keep(result)
          return result.tokens.access
        } catch (err) {
          if (err.code === 'nexusLoggedOut') throw err                   // logged out while it ran (above)
          if (err.status === 400 || err.status === 401) {
            const now = tokens()
            // Another launcher on this PC renewed first (Nexus gives each refresh token once): its tokens are used
            if (now && now.refresh !== t.refresh) return now.access
            if (now) { forget(); lastError = ENDED; log('[nexus] Nexus ended the login') }
            throw new LoginError(ENDED, 'nexusLoggedOut')
          }
          // Any other failure to renew (Nexus out of reach, its limit, its own trouble): the login is kept for later, and an
          // automatic download stops rather than asking again for every file
          throw Object.assign(new LoginError(err.code === 'nexusUnreachable' ? err.message : 'Nexus could not renew your login right now. Try again in a few minutes.', 'renewFailed'), { status: err.status })
        }
      })().finally(() => { renewing = null; tell() })
    }
    return renewing
  }

  async function logout() {
    const t = tokens()
    forget()
    clearLimit()
    lastError = null
    tell()
    // Nexus is told the tokens are no longer used; if it cannot be, they are gone from this PC all the same
    await revoke(t, 'about the logout')
    log('[nexus] logged out of the Nexus account on this PC')
    return status()
  }

  // ---- Nexus's API ----
  // Nexus's rate limits. Its answers carry x-rl-hourly-remaining and x-rl-daily-remaining (with x-rl-*-reset times); a
  // 429 may carry Retry-After. Remaining counts are read with Number() and used only when finite, so "0", "0.0", "0x0"
  // and "-1" all mean none left, and anything non-numeric is ignored. The daily and hourly counts are read separately and
  // the block lasts until the later of their resets. A block never lasts more than a day from now, and a reset time that
  // is already past blocks nothing: Nexus is asked again, and if it still has none left, the 429 that follows sets the
  // one-minute block (or its Retry-After or a reset still ahead).
  const MINUTE = 60 * 1000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
  function clearLimit() { limit = { until: 0, kind: null, accountId: null } }
  function blockUntil(at, kind) {
    const until = Math.min(at, now() + DAY)
    if (!(until > now()) || until <= limit.until) return
    limit = { until, kind, accountId: store.get('nexusAccount')?.id ?? null }
  }
  // A time from a header: a date (ISO, HTTP or Nexus's "2026-10-08 07:00:00 +0000"), or seconds from now when seconds is set
  function timeFrom(value, { seconds = false } = {}) {
    const text = String(value ?? '').trim()
    if (!text) return null
    if (seconds && /^\d+(\.\d+)?$/.test(text)) return now() + Number(text) * 1000
    const at = Date.parse(text)
    return Number.isFinite(at) ? at : null
  }
  const headerOf = res => name => { try { return res.headers?.get?.(name) ?? null } catch { return null } }
  function exhausted(value) {
    if (value === null || String(value).trim() === '') return false
    const n = Number(value)
    return Number.isFinite(n) && n <= 0
  }
  function noteLimits(res) {
    const header = headerOf(res)
    const reset = (name, fallback) => { const at = timeFrom(header(name)); return at === null ? now() + fallback : at }
    // Each one on its own: blockUntil keeps whichever ends later, and ignores a reset that is already past
    if (exhausted(header('x-rl-hourly-remaining'))) blockUntil(reset('x-rl-hourly-reset', HOUR), 'hourly')
    if (exhausted(header('x-rl-daily-remaining'))) blockUntil(reset('x-rl-daily-reset', DAY), 'daily')
  }
  // A 429: the first of Retry-After, the hourly reset and the daily reset that is still ahead, else a minute from now
  // (a Retry-After of 0, or a date or reset already past, would otherwise let the next call straight through)
  function note429(res) {
    const header = headerOf(res)
    const ahead = [timeFrom(header('retry-after'), { seconds: true }), timeFrom(header('x-rl-hourly-reset')), timeFrom(header('x-rl-daily-reset'))]
      .find(at => at !== null && at > now())
    blockUntil(ahead ?? now() + MINUTE, 'busy')
  }
  // In plain words, from the block's real end: minutes up to an hour, then about so many hours, to the nearest hour
  function waitWords() {
    const minutes = Math.max(1, Math.ceil((limit.until - now()) / MINUTE))
    if (minutes <= 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
    const hours = Math.round(minutes / 60)
    return `about ${hours} hour${hours === 1 ? '' : 's'}`
  }
  function limitError() {
    const lead = limit.kind === 'daily' ? "Nexus's daily limit on requests for your account is used up."
      : limit.kind === 'hourly' ? "Nexus's hourly limit on requests for your account is used up."
      : 'Nexus is limiting how many downloads you can start right now.'
    return new LoginError(`${lead} Try again in ${waitWords()}, or use the Nexus window.`, 'rateLimited')
  }
  // One GET to Nexus's API with the player's token; Nexus refusing the token renews it once and asks again
  async function apiGet(route, { signal } = {}) {
    if (now() < limit.until) throw limitError()
    let token = await accessToken()
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetchImpl(`${apiBase}${route}`, { method: 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
          headers: nexusHeaders({ Authorization: `Bearer ${token}`, Accept: 'application/json' }) })
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
        throw new LoginError('Nexus could not be reached. Check your internet connection, or try again in a minute.', 'nexusUnreachable')
      }
      // Refused once: a renewed token is tried (401: the token ended; 403: Premium may have started or ended since it was
      // issued, and a renewed token carries the account as it is now)
      noteLimits(res)
      if ((res.status === 401 || res.status === 403) && attempt === 0) { token = await accessToken({ rejected: token }); continue }
      let data = null
      try { data = await res.json() } catch { /* not JSON */ }
      if (res.ok) return data
      const message = data && typeof data.message === 'string' ? data.message.slice(0, 300) : ''
      log(`[nexus] ${route} answered ${res.status}${message ? `: ${message}` : ''}`)
      if (res.status === 401) { if (tokens()?.access === token) { forget(); lastError = ENDED; tell() } throw new LoginError(ENDED, 'nexusLoggedOut') }
      // Still refused with a fresh token. The fresh token says whether the account is Premium now (the renewal stored it):
      // not Premium, and the launcher stops offering downloads by themselves; still Premium, and it is this one file Nexus
      // will not give (hidden, under moderation), so only that file fails and the rest go on
      if (res.status === 403 && store.get('nexusAccount')?.premium) throw new LoginError('Nexus would not give this file to your account. Get it in the Nexus window.', 'fileRefused')
      if (res.status === 403) throw new LoginError('Only Nexus Premium members get the mods downloaded by themselves. Use the Nexus window and its Slow download button.', 'notPremium')
      if (res.status === 404) throw new LoginError('Nexus no longer has this file.', 'gone')
      // A 429 always leaves a block that is still ahead (a minute at least), so its own words say how long
      if (res.status === 429) { note429(res); throw limitError() }
      throw new LoginError(res.status >= 500 ? 'Nexus is having trouble right now. Try again in a minute.' : 'Nexus refused the download. Try again.', `http${res.status}`)
    }
  }

  /** The download address Nexus gives a Premium member for one file: on Nexus's own file servers, https only. */
  async function downloadLink(archive, { signal } = {}) {
    const links = await apiGet(`/v1/games/${NEXUS_GAME}/mods/${Number(archive.modId)}/files/${Number(archive.fileId)}/download_link.json`, { signal })
    const list = Array.isArray(links) ? links : []
    const uri = list.map(l => l && typeof l.URI === 'string' ? l.URI : '').find(nexusFileUrl)
    if (!uri) { log(`[nexus] no usable download link for ${archive.name}: ${list.length} offered`); throw new LoginError('Nexus did not give a download link for this file. Try again, or use the Nexus window.', 'noLink') }
    return uri
  }

  /**
   * One file from Nexus's file servers into savePath. Redirects are followed only while they stay on Nexus's hosts, and
   * no more than limit bytes are taken (a bigger file is not the one needed and never fills the drive). onProgress gets
   * { received, total }. Stops on signal, and when no bytes arrive for a minute.
   */
  async function nexusFile(url, savePath, { limit, onProgress = () => {}, signal } = {}) {
    // Never without a cap: a file of unknown size could fill the drive
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new LoginError('The launcher does not know the size of this file, so it did not download it.', 'different')
    let at = url
    for (let hop = 0; hop <= REDIRECTS; hop++) {
      if (!nexusFileUrl(at)) throw new LoginError('Nexus sent the download somewhere that is not Nexus, so the launcher did not take it.', 'elsewhere')
      let answer
      try { answer = await getFile(at, { headers: nexusHeaders({ 'User-Agent': `${APP_NAME}/${appVersion}` }), signal }) }
      catch (error) {
        if (signal?.aborted || error?.code === 'CANCELLED') throw Object.assign(new Error('Stopped.'), { code: 'CANCELLED' })
        if (error instanceof LoginError) throw error
        log(`[nexus] the file server ${hostOf(at)} could not be reached: ${error?.code || error?.message}`)
        throw new LoginError('Nexus could not send the file. Try again in a minute.', 'fileFailed')
      }
      if ([301, 302, 303, 307, 308].includes(answer.status)) {
        answer.discard()
        let next = null
        // No Location at all would resolve to this same address and go round in circles
        try { if (answer.location) next = new URL(answer.location, at).href } catch { /* no address */ }
        if (!next) throw new LoginError('Nexus sent the download nowhere. Try again.', 'noLink')
        at = next
        continue
      }
      if (answer.status !== 200) { answer.discard(); log(`[nexus] the file server answered ${answer.status} for ${hostOf(at)}`); throw new LoginError(answer.status === 403 || answer.status === 410 ? 'The download link ran out. Try again.' : 'Nexus could not send the file. Try again in a minute.', 'fileFailed') }
      const total = Number.isSafeInteger(answer.length) && answer.length > 0 ? answer.length : 0
      if (total && total > limit) { answer.discard(); throw new LoginError('Nexus sent a different file from the one Dovakarn needs.', 'different') }
      await answer.saveTo(savePath, { limit, onProgress: received => onProgress({ received, total }), signal, stallMs: STALL })
      return { host: hostOf(at) }
    }
    throw new LoginError('Nexus sent the download round in circles. Try again.', 'noLink')
  }

  return { status, login, cancel, logout, available, accessToken, downloadLink, nexusFile, config, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn) } }
}

// An https GET that never follows a redirect itself: { status, location, length, discard(), saveTo(file, opts) }.
// transport: Node's https (a test passes http, for a server on this PC)
function httpsGet(url, { headers = {}, signal, transport = https } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Stopped.'), { code: 'CANCELLED' }))
    // 30 seconds for the server to answer; once it has, the body's own stall check (a minute without bytes) takes over
    let answered = false
    const req = transport.get(url, { headers, signal, timeout: 30000 }, res => {
      answered = true
      req.setTimeout(0)
      resolve({
        status: res.statusCode,
        location: typeof res.headers.location === 'string' ? res.headers.location : '',
        length: Number(res.headers['content-length']),
        discard: () => res.resume(),
        saveTo: (file, { limit = 0, onProgress = () => {}, signal: stop, stallMs = STALL } = {}) => new Promise((done, fail) => {
          const out = fs.createWriteStream(file)
          let received = 0, ended = false, stall = null
          // A connection that drops partway (Node's ECONNRESET, "aborted") is said as a cut-off download, which is tried again
          const cutOff = () => new LoginError('The download was cut off. Try again.', 'interrupted')
          const end = error => {
            if (ended) return
            ended = true
            clearTimeout(stall)
            stop?.removeEventListener('abort', onAbort)
            if (error) { res.destroy(); out.destroy(); fail(error instanceof LoginError || error.code === 'CANCELLED' ? error : cutOff()) }
            // The last writes, and closing the file itself, can still fail (a full disk, a network folder gone): only a file
            // that has closed counts as finished
            else { out.once('error', closeError => fail(saveError(closeError))); out.once('close', () => done()); out.end() }
          }
          const saveError = error => new LoginError(`The launcher could not save the file: ${error.code || error.message}.`, 'save')
          const kick = () => { clearTimeout(stall); stall = setTimeout(() => end(new LoginError('No bytes came from Nexus for a minute. Try again.', 'stalled')), stallMs) }
          const onAbort = () => end(Object.assign(new Error('Stopped.'), { code: 'CANCELLED' }))
          stop?.addEventListener('abort', onAbort, { once: true })
          kick()
          res.on('data', chunk => {
            if (ended) return
            received += chunk.length
            if (limit && received > limit) return end(new LoginError('Nexus sent a different file from the one Dovakarn needs.', 'different'))
            if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()) }
            kick()
            onProgress(received)
          })
          res.on('end', () => end(res.complete ? null : cutOff()))
          res.on('aborted', () => end(cutOff()))
          res.on('error', error => end(error))
          res.on('close', () => { if (!res.complete) end(cutOff()) })
          // The disk refusing the file (full, removed) is said as that, not as a cut-off download
          out.on('error', error => end(saveError(error)))
        }),
      })
    })
    req.on('timeout', () => { if (!answered) req.destroy(new LoginError("Nexus's file server took too long to answer. Try again.", 'fileFailed')) })
    req.on('error', error => reject(signal?.aborted ? Object.assign(new Error('Stopped.'), { code: 'CANCELLED' }) : error))
  })
}

module.exports = { createNexusAccount, accountFromToken, nexusFileUrl, httpsGet, WORDS, APP_NAME, SCOPE, USERS, API, ENDED, NOT_ON }
