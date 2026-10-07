'use strict'
// Discord login for the Dovakarn launcher: Discord is how players sign up and log in, and their Discord account is
// their Dovakarn account. The player's own browser sends Discord's one-time code to a listener on 127.0.0.1 (this PC
// only), protected with PKCE, so a login link someone else shares cannot hand them the account. The Dovakarn backend
// swaps the code for the player's details (it alone holds the client secret) and returns an account key, which this
// launcher keeps encrypted with Windows (Electron safeStorage). Every network call is async: nothing here blocks the window.

const http = require('http')
const crypto = require('crypto')

// A new player may first have to log in to Discord on the web (password, two-factor, an email check)
const LOGIN_TIMEOUT = 5 * 60 * 1000
const FALLBACK_INVITE = 'https://discord.gg/MTxxdWbcCz'
const INVITE = /^https:\/\/(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,32}$/
// Discord may only send the player's browser back to this PC
const LOOPBACK_CALLBACK = /^http:\/\/127\.0\.0\.1:\d{2,5}\/callback$/
// The server no longer knows this launcher's account key (logged out elsewhere, expired, or revoked by staff)
const ENDED = 'Your Dovakarn login has ended. Log in with Discord again.'
// A reply with no message of its own (a proxy's error page, an older server) in plain words; the code goes to the log
function plainStatus(status) {
  if (status === 404) return 'This Dovakarn server does not have Discord login yet. Ask the server owner.'
  if (status === 429) return 'Too many attempts. Wait a few minutes and try again.'
  if (status >= 500) return 'The Dovakarn server is having trouble right now. Try again in a minute.'
  return 'The Dovakarn server refused the request. Try again, and ask the server owner if it keeps happening.'
}

class LoginError extends Error {
  constructor(message, code, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

const b64url = buf => buf.toString('base64url')
function pkce() {
  const verifier = b64url(crypto.randomBytes(48))
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), state: b64url(crypto.randomBytes(16)) }
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// The tab the browser lands on after Discord; closes itself where the browser allows it
function page(ok, title, text) {
  const accent = ok ? '#d9b36a' : '#d0735f'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Dovakarn</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,#1b150e 0%,#0b0906 70%);color:#e3d6bd;font-family:Georgia,'Times New Roman',serif;text-align:center}
.card{padding:2.5rem 3rem;max-width:30rem}.mark{width:4.2rem;height:4.2rem;margin:0 auto 1.3rem;border-radius:50%;border:2px solid ${accent};color:${accent};display:flex;align-items:center;justify-content:center;font-size:1.9rem}
h1{margin:0 0 .8rem;font-size:1.6rem;font-weight:normal;color:${accent};letter-spacing:.14em;text-transform:uppercase}p{margin:0;line-height:1.6;font-size:1.05rem}.brand{margin-top:2rem;font-size:.8rem;letter-spacing:.3em;color:#8d7f66}</style></head>
<body><div class="card"><div class="mark">${ok ? '&#10003;' : '&#10007;'}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><div class="brand">DOVAKARN</div></div>${ok ? '<script>setTimeout(function(){window.close()},1500)</script>' : ''}</body></html>`
}

// The service's errors that mean this server's application is set up wrong: trying again will not help
const SETUP_ERRORS = ['invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope', 'invalid_client']

// What the login listener says, for the service the player is logging in to. The Nexus login (nexusAccount.js) passes its own
const DISCORD_WORDS = {
  tag: '[account]',
  outOfDate: 'This Discord login link is out of date. Close this tab. If the launcher is still waiting, use the newest tab it opened, or press Cancel there and log in again.',
  cancelledPage: 'You cancelled the Discord login. Close this tab and try again from the launcher.',
  cancelled: 'You cancelled the Discord login.',
  refused: 'Discord refused the login',
  setupPage: 'Discord login is not set up correctly on this server. Close this tab and ask the server owner.',
  setup: ['Discord login is not set up correctly on this server. Ask the server owner.', 'discordMisconfigured'],
  failedPage: 'Discord could not finish the login. Close this tab and try again from the launcher in a minute.',
  failed: ['Discord could not finish the login. Try again in a minute.', 'discordError'],
  noCodePage: 'Discord did not send a login code. Close this tab and try again from the launcher.',
  noCode: 'Discord did not send a login code. Try again.',
  approvedTitle: 'Discord approved',
  approved: 'Go back to the Dovakarn launcher. It finishes logging you in.',
  timeout: 'Timed out waiting for Discord. Press Log in with Discord to try again.',
  reserved: ports => `Windows has set aside the ports the Discord login uses: ${ports}. Hyper-V, WSL or Docker often do this. Restarting the PC usually frees them.`,
  busy: ports => `Another program is using the Discord login ports: ${ports}. Close it and try again.`,
}

// Listens once on 127.0.0.1 for the service's redirect. A callback without our state is ignored (someone else's link, or
// an older tab), so only the login this launcher started can finish it.
function listenOnce(redirectUri, state, timeoutMs, log = () => {}, words = DISCORD_WORDS) {
  const target = new URL(redirectUri)
  return new Promise((resolveListening, rejectListening) => {
    let settle = null
    const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
    result.catch(() => {})
    let done = false
    const finish = (err, value) => { if (done) return; done = true; if (err) settle.reject(err); else settle.resolve(value) }
    const server = http.createServer((req, res) => {
      let url
      try { url = new URL(req.url, redirectUri) } catch { res.writeHead(400); res.end(); return }
      if (req.method !== 'GET' || url.pathname !== target.pathname) { res.writeHead(404); res.end(); return }
      const send = (status, ok, title, text) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(ok, title, text)) }
      if (url.searchParams.get('state') !== state) return send(400, false, 'Out of date', words.outOfDate)
      // access_denied is the player pressing Cancel on the service's page; anything else is the service failing
      const serviceError = url.searchParams.get('error')
      if (serviceError === 'access_denied') {
        send(200, false, 'Login cancelled', words.cancelledPage)
        return finish(new LoginError(words.cancelled, 'cancelled'))
      }
      if (serviceError) {
        log(`${words.tag} ${words.refused}: ${serviceError}${url.searchParams.get('error_description') ? ` (${url.searchParams.get('error_description')})` : ''}`)
        if (SETUP_ERRORS.includes(serviceError)) {
          send(200, false, 'Login failed', words.setupPage)
          return finish(new LoginError(...words.setup))
        }
        send(200, false, 'Login failed', words.failedPage)
        return finish(new LoginError(...words.failed))
      }
      const code = url.searchParams.get('code')
      if (!code) {
        send(400, false, 'Login failed', words.noCodePage)
        return finish(new LoginError(words.noCode, 'noCode'))
      }
      // The launcher still has to swap the code, so this tab does not claim more
      send(200, true, words.approvedTitle, words.approved)
      finish(null, { code })
    })
    let timer = null
    const close = err => { clearTimeout(timer); server.close(); if (err) finish(err) }
    server.once('error', err => rejectListening(err))
    server.listen(Number(target.port), '127.0.0.1', () => {
      timer = setTimeout(() => close(new LoginError(words.timeout, 'timeout')), timeoutMs)
      resolveListening({ redirectUri, result, close })
    })
  })
}

// The first registered port that is free. Another program on one moves us to the next; Windows can also reserve
// ports for Hyper-V, WSL or Docker, which is a different fix, so it gets its own message.
async function listenOnFirstFree(redirectUris, state, timeoutMs, log, words = DISCORD_WORDS) {
  const codes = []
  for (const uri of redirectUris) {
    try { return await listenOnce(uri, state, timeoutMs, log, words) }
    catch (err) { codes.push(err.code || err.message); log(`${words.tag} login port ${new URL(uri).port}: ${err.code || err.message}`) }
  }
  const ports = redirectUris.map(u => new URL(u).port).join(', ')
  if (codes.includes('EACCES')) throw new LoginError(words.reserved(ports), 'portsReserved')
  throw new LoginError(words.busy(ports), 'portsBusy')
}

// https, or plain http to this PC only
function secureBase(base) {
  let url
  try { url = new URL(base) } catch { return false }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

// unreachableMessage: what to say when the Dovakarn server does not answer (the test launcher's is on this PC)
function createDiscordLogin({ apiUrl, store, safeStorage, openExternal, hwid = () => null, log = () => {}, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = LOGIN_TIMEOUT,
  unreachableMessage = () => 'The Dovakarn server could not be reached. Check your internet connection, or try again in a minute.' }) {
  let pending = null
  let lastError = null
  let configCache = null
  // Without Windows encryption the key is kept for this run only, never written in plain text
  let memoryKey = null

  async function api(method, route, { body, key } = {}) {
    const base = String(apiUrl() || '').replace(/\/+$/, '')
    if (!base) throw new LoginError('This launcher has no Dovakarn server address.', 'noServer')
    // Login codes, the PKCE verifier and the account key go only over HTTPS, or to this PC (the local test backend)
    if (!secureBase(base)) throw new LoginError("This launcher's Dovakarn server address is not a secure https address, so it will not send your login there.", 'insecureServer')
    let res
    try {
      res = await fetchImpl(base + route, {
        method,
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        // A redirect would carry the login code, the PKCE verifier and the account key somewhere else
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new LoginError(unreachableMessage(), 'unreachable')
    }
    let data = null
    try { data = await res.json() } catch { /* not JSON */ }
    if (!res.ok) {
      if (!(data && data.message)) log(`[account] ${method} ${route} answered ${res.status} without a message`)
      throw new LoginError((data && data.message) || plainStatus(res.status), (data && data.error) || `http${res.status}`, { status: res.status, inviteUrl: data && data.inviteUrl })
    }
    return data
  }

  // The account key is sealed with Windows (DPAPI) so another Windows user cannot copy it off this PC
  const canSeal = () => !!(safeStorage && safeStorage.isEncryptionAvailable())
  function save(key) {
    if (canSeal()) { memoryKey = null; store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(key).toString('base64')); return }
    log('[account] Windows encryption is unavailable: this login lasts until the launcher closes')
    memoryKey = key
    store.set('discordAccountKey', null)
  }
  function unseal(stored) {
    if (typeof stored !== 'string') return null
    if (stored.startsWith('enc:v1:')) {
      try { return safeStorage.decryptString(Buffer.from(stored.slice(7), 'base64')) } catch { return null }
    }
    return stored.startsWith('raw:') ? stored.slice(4) : null
  }
  function accountKey() {
    if (memoryKey) return memoryKey
    const stored = store.get('discordAccountKey')
    const key = unseal(stored)
    // A key an older launcher saved in plain text is sealed as soon as Windows encryption is there
    if (key && typeof stored === 'string' && stored.startsWith('raw:') && canSeal()) save(key)
    return key
  }
  function forget() { memoryKey = null; store.set('discordAccountKey', null); store.set('discordAccount', null) }

  async function config() {
    if (configCache && now() - configCache.at < 60 * 1000) return configCache.value
    const value = await api('GET', '/api/auth/config')
    configCache = { at: now(), value }
    return value
  }

  function status() {
    const account = store.get('discordAccount') || null
    return { loggedIn: !!(account && accountKey()), account, pending: !!pending, error: lastError }
  }

  const hasUnsentLogouts = () => unsentLogouts.length > 0 || (store.get('pendingLogouts') || []).length > 0

  async function login() {
    if (pending) throw new LoginError('A Discord login is already waiting in your browser. Finish it there, or press Cancel.', 'pending')
    if (hasUnsentLogouts()) finishLogouts().catch(() => {})
    lastError = null
    const flow = { cancelled: false, listener: null }
    pending = { cancel: () => { flow.cancelled = true; flow.listener?.close(new LoginError('Login cancelled.', 'cancelled')) } }
    try {
      const cfg = await config()
      const redirectUris = (cfg && Array.isArray(cfg.redirectUris) ? cfg.redirectUris : []).filter(uri => LOOPBACK_CALLBACK.test(String(uri)))
      if (!cfg || !cfg.ready || !cfg.clientId || !redirectUris.length) {
        // misconfigured: set up, but Discord refuses the server's client secret
        throw cfg && cfg.problem === 'misconfigured'
          ? new LoginError('Discord login is not set up correctly on this server. Ask the server owner.', 'loginMisconfigured')
          : new LoginError('Discord login is not set up on this server yet. Ask the server owner.', 'loginNotConfigured')
      }
      const { verifier, challenge, state } = pkce()
      flow.listener = await listenOnFirstFree(redirectUris, state, timeoutMs, log)
      if (flow.cancelled) throw new LoginError('Login cancelled.', 'cancelled')
      const url = new URL('https://discord.com/oauth2/authorize')
      url.search = new URLSearchParams({ client_id: cfg.clientId, response_type: 'code', redirect_uri: flow.listener.redirectUri, scope: 'identify', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
      try { await openExternal(url.toString()) }
      catch (err) {
        log(`[account] could not open the browser: ${err.message}`)
        throw new LoginError('The launcher could not open your web browser. Set a default browser in Windows settings, then try again.', 'browser')
      }
      const { code } = await flow.listener.result
      const data = await api('POST', '/api/auth/discord', { body: { code, codeVerifier: verifier, redirectUri: flow.listener.redirectUri, hwid: hwid() } })
      if (!data || typeof data.accountKey !== 'string' || !data.account) throw new LoginError('The Dovakarn server sent an unexpected reply. Try again.', 'badReply')
      // Cancel pressed while the server was answering: the login is not kept
      if (flow.cancelled) throw new LoginError('Login cancelled.', 'cancelled')
      save(data.accountKey)
      store.set('discordAccount', data.account)
      log(`[account] logged in as ${data.account.name} (#${data.account.number})`)
      return status()
    } catch (err) {
      if (err.code !== 'cancelled') lastError = err.message
      throw err
    } finally {
      flow.listener?.close()
      pending = null
    }
  }

  function cancel() {
    if (pending) pending.cancel()
    return status()
  }

  // Refreshes the account (Discord name, membership, ban, staff level); a key the server no longer knows logs out.
  // An answer about a key that has since been replaced (a new login, a logout) changes nothing. The result also says
  // whether the server answered (reached, else the problem), whether it could ask Discord (membershipError), how many
  // seconds old Discord's answer is (membershipAge) and, when a fresh check was refused as too soon, how many seconds
  // until Discord can be asked again (askAgainIn).
  async function refresh({ fresh = false } = {}) {
    if (hasUnsentLogouts()) finishLogouts().catch(() => {})
    const key = accountKey()
    if (!key) return status()
    try {
      const data = await api('GET', `/api/auth/me${fresh ? '?fresh=1' : ''}`, { key })
      if (accountKey() !== key) return status()
      if (data && data.account) store.set('discordAccount', data.account)
      lastError = null
      const seconds = value => Number.isSafeInteger(value) && value >= 0 ? value : null
      return { ...status(), reached: true, membershipError: (data && data.membershipError) || null, membershipAge: seconds(data && data.membershipAge), askAgainIn: seconds(data && data.askAgainIn) || 0 }
    } catch (err) {
      if (accountKey() !== key) return status()
      if (err.status === 401) { forget(); lastError = ENDED }
      // Unreachable: keep the saved account; Play reports the real problem
      return { ...status(), reached: false, problem: err.message }
    }
  }

  // Logging out ends this PC's login at the server too, and with it a game it started. A server that cannot be reached
  // is asked again later (finishLogouts: at the next start, refresh or login), with the key kept sealed as a logout
  // still to send, never usable to play. Until then a game already running here goes on: logoutPending says so.
  let unsentLogouts = []
  async function logout() {
    const key = accountKey()
    forget()
    lastError = null
    if (!key) return status()
    try { await api('POST', '/api/auth/logout', { key }) }
    catch (err) {
      // 401: the server had ended that login already
      if (err.status !== 401) { keepLogout(key); return { ...status(), logoutPending: true } }
    }
    return status()
  }
  function keepLogout(key) {
    if (canSeal()) {
      const kept = (store.get('pendingLogouts') || []).filter(v => typeof v === 'string')
      store.set('pendingLogouts', [...kept, 'enc:v1:' + safeStorage.encryptString(key).toString('base64')].slice(-5))
    } else unsentLogouts = [...unsentLogouts, key].slice(-5)
  }
  // One pass at a time, and the write-back keeps what was kept while it ran: a logout kept during a slow pass (the
  // server not answering) must never be overwritten by the pass's own older list
  let logoutPass = null
  function finishLogouts() {
    if (!logoutPass) logoutPass = finishLogoutsOnce().finally(() => { logoutPass = null })
    return logoutPass
  }
  async function finishLogoutsOnce() {
    const sealed = (store.get('pendingLogouts') || []).filter(v => typeof v === 'string')
    const memory = unsentLogouts
    const left = [], leftInMemory = []
    for (const value of sealed) {
      const key = unseal(value)
      if (key && !(await sendLogout(key))) left.push(value)
    }
    for (const key of memory) if (!(await sendLogout(key))) leftInMemory.push(key)
    const keptMeanwhile = unsentLogouts.filter(key => !memory.includes(key))
    unsentLogouts = [...leftInMemory, ...keptMeanwhile].slice(-5)
    if (sealed.length || keptMeanwhile.length) {
      const now = (store.get('pendingLogouts') || []).filter(v => typeof v === 'string')
      store.set('pendingLogouts', [...left, ...now.filter(value => !sealed.includes(value))].slice(-5))
    }
    return unsentLogouts.length + ((store.get('pendingLogouts') || []).length)
  }
  async function sendLogout(key) {
    try { await api('POST', '/api/auth/logout', { key }); return true }
    catch (err) { return err.status === 401 }
  }

  // A play session for this launch: the game sends it to the game server, which checks it with the backend
  async function play() {
    const key = accountKey()
    if (!key) throw new LoginError('Log in with Discord to play.', 'notLoggedIn')
    try {
      const data = await api('POST', '/api/auth/play', { key, body: { hwid: hwid() } })
      if (!data || typeof data.session !== 'string' || !data.account) throw new LoginError('The Dovakarn server sent an unexpected reply. Try again.', 'badReply')
      if (accountKey() !== key) throw new LoginError('Your login changed while the game was starting. Press Play again.', 'loginChanged')
      store.set('discordAccount', data.account)
      return data
    } catch (err) {
      if (err.status === 401 && accountKey() === key) { forget(); lastError = ENDED; throw new LoginError(ENDED, 'notLoggedIn') }
      if (err.code === 'notMember' || err.code === 'pendingMember' || err.code === 'banned') refresh().catch(() => {})
      throw err
    }
  }

  async function inviteUrl() {
    try {
      const cfg = await config()
      if (cfg && INVITE.test(String(cfg.inviteUrl || ''))) return cfg.inviteUrl
    } catch { /* fall back */ }
    return FALLBACK_INVITE
  }

  return { status, login, cancel, refresh, logout, finishLogouts, play, config, inviteUrl }
}

module.exports = { createDiscordLogin, LoginError, pkce, page, FALLBACK_INVITE, listenOnFirstFree, secureBase, LOOPBACK_CALLBACK }
