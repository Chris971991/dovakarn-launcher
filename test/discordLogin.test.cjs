const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const { createDiscordLogin } = require('../src/discordLogin')

// Stand-in Dovakarn backend: remembers what the launcher sent
// problem: why login is not ready ('misconfigured': Discord refuses the server's client secret)
function backend(t, { ready = true, ports, problem = null } = {}) {
  // me: extra fields /api/auth/me answers with (how old Discord's answer is, and so on)
  const seen = { exchanges: [], plays: [], logouts: 0, keys: new Set(['key-from-backend-0123456789abcdef0123456789']), meUrls: [], me: null }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
      const key = String(req.headers.authorization || '').replace(/^Bearer /, '')
      if (req.url === '/api/auth/config') return send(200, { ready, problem, clientId: '111111111111111111', redirectUris: ports.map(p => `http://127.0.0.1:${p}/callback`), scope: 'identify', inviteUrl: 'https://discord.gg/MTxxdWbcCz' })
      if (req.url === '/api/auth/discord') {
        const b = JSON.parse(body)
        seen.exchanges.push(b)
        return send(200, { accountKey: 'key-from-backend-0123456789abcdef0123456789', account: { number: 7, name: 'Hadvar', avatar: null, member: true, banned: false, staff: 'admin' } })
      }
      if (req.url.startsWith('/api/auth/me')) {
        seen.meUrls.push(req.url)
        return seen.keys.has(key) ? send(200, { account: { number: 7, name: 'Hadvar Renamed', member: true }, ...seen.me }) : send(401, { error: 'notLoggedIn', message: 'Log in with Discord again.' })
      }
      if (req.url === '/api/auth/play') {
        seen.plays.push({ key, body: JSON.parse(body) })
        if (!seen.keys.has(key)) return send(401, { error: 'notLoggedIn' })
        if (seen.notMember) return send(403, { error: 'notMember', message: 'Join the Dovakarn Discord to play.', inviteUrl: 'https://discord.gg/MTxxdWbcCz' })
        return send(200, { session: 'a'.repeat(64), account: { number: 7, name: 'Hadvar', member: true } })
      }
      // logoutStatus: the server's answer to a logout (401: it had ended that login already)
      if (req.url === '/api/auth/logout') { seen.logouts++; return seen.logoutStatus ? send(seen.logoutStatus, { error: 'notLoggedIn' }) : send(200, { ok: true }) }
      send(404, { error: 'nope' })
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => server.close())
    resolve({ url: `http://127.0.0.1:${server.address().port}`, seen })
  }))
}

async function freePorts(n) {
  const ports = []
  for (let i = 0; i < n; i++) {
    ports.push(await new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) }))
  }
  return ports
}

function fakeStore() { const m = new Map(); return { get: k => m.get(k), set: (k, v) => m.set(k, v), raw: m } }
// Stand-in for Electron safeStorage: reversible, but never the plain text
const safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`sealed:${s}`).reverse(), decryptString: b => Buffer.from(b).reverse().toString().replace(/^sealed:/, '') }

async function browserVisit(url) {
  const res = await fetch(url)
  return { status: res.status, text: await res.text() }
}

test('login opens Discord with PKCE, finishes only through this launcher\'s own state, and stores the key sealed', async t => {
  const ports = await freePorts(2)
  const api = await backend(t, { ports })
  const store = fakeStore()
  let authorizeUrl = null
  const login = createDiscordLogin({ apiUrl: () => api.url, store, safeStorage, openExternal: url => { authorizeUrl = new URL(url) }, hwid: () => 'pc-guid' })
  const done = login.login()
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://discord.com/oauth2/authorize')
  const q = authorizeUrl.searchParams
  assert.equal(q.get('client_id'), '111111111111111111')
  assert.equal(q.get('scope'), 'identify')
  assert.equal(q.get('code_challenge_method'), 'S256')
  assert.equal(q.get('redirect_uri'), `http://127.0.0.1:${ports[0]}/callback`)
  assert.equal(login.status().pending, true)

  // A link with someone else's state is refused and does not end the real login
  const foreign = await browserVisit(`${q.get('redirect_uri')}?code=stolen&state=someone-else`)
  assert.equal(foreign.status, 400)
  assert.match(foreign.text, /This Discord login link is out of date/)

  const ok = await browserVisit(`${q.get('redirect_uri')}?code=real-code-123&state=${q.get('state')}`)
  assert.equal(ok.status, 200)
  assert.match(ok.text, /Discord approved.*Go back to the Dovakarn launcher/s, 'the tab does not claim a login the server has not accepted yet')
  const status = await done
  assert.equal(status.loggedIn, true)
  assert.equal(status.account.number, 7)
  assert.equal(api.seen.exchanges.length, 1)
  const sent = api.seen.exchanges[0]
  assert.equal(sent.code, 'real-code-123')
  assert.equal(sent.redirectUri, q.get('redirect_uri'))
  assert.equal(sent.hwid, 'pc-guid')
  assert.equal(crypto.createHash('sha256').update(sent.codeVerifier).digest('base64url'), q.get('code_challenge'), 'the verifier matches the challenge Discord saw')
  const stored = store.get('discordAccountKey')
  assert.match(stored, /^enc:v1:/)
  assert.ok(!stored.includes('key-from-backend'), 'the account key never sits in the settings file as plain text')
  assert.equal(login.status().pending, false)
  // The listener is gone after the login
  await assert.rejects(fetch(`${q.get('redirect_uri')}?code=x&state=${q.get('state')}`))
})

test('a busy port moves the listener to the next registered one', async t => {
  const ports = await freePorts(2)
  const blocker = net.createServer().listen(ports[0], '127.0.0.1')
  t.after(() => blocker.close())
  await new Promise(r => blocker.once('listening', r))
  const api = await backend(t, { ports })
  let authorizeUrl = null
  const login = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: url => { authorizeUrl = new URL(url) } })
  const done = login.login()
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `http://127.0.0.1:${ports[1]}/callback`)
  login.cancel()
  await assert.rejects(done, err => err.code === 'cancelled')
})

test('cancelling on Discord, cancelling in the launcher and timing out all end the wait cleanly', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  let authorizeUrl = null
  const login = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: url => { authorizeUrl = new URL(url) }, timeoutMs: 300 })
  const denied = login.login().catch(err => err)
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  const page = await browserVisit(`${authorizeUrl.searchParams.get('redirect_uri')}?error=access_denied&state=${authorizeUrl.searchParams.get('state')}`)
  assert.match(page.text, /Login cancelled/)
  assert.equal((await denied).code, 'cancelled')
  assert.equal(login.status().error, null, 'a cancel is not an error')

  // Discord failing is not the player cancelling: it gets a plain message
  authorizeUrl = null
  const failed = login.login().catch(err => err)
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  const failedPage = await browserVisit(`${authorizeUrl.searchParams.get('redirect_uri')}?error=temporarily_unavailable&state=${authorizeUrl.searchParams.get('state')}`)
  assert.match(failedPage.text, /Login failed/)
  const err = await failed
  assert.deepEqual([err.code, err.message], ['discordError', 'Discord could not finish the login. Try again in a minute.'])
  assert.equal(login.status().error, 'Discord could not finish the login. Try again in a minute.')

  authorizeUrl = null
  const stopped = login.login().catch(err => err)
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  login.cancel()
  assert.equal((await stopped).code, 'cancelled')

  authorizeUrl = null
  await assert.rejects(login.login(), err => err.code === 'timeout')
  assert.match(login.status().error, /Timed out/)
})

test('Discord refusing a login because the server is set up wrong says so, and its own words go to the launcher log', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  const logged = []
  let authorizeUrl = null
  const login = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: url => { authorizeUrl = new URL(url) }, log: line => logged.push(line) })
  for (const error of ['invalid_request', 'unauthorized_client', 'unsupported_response_type', 'invalid_scope', 'invalid_client']) {
    authorizeUrl = null; logged.length = 0
    const failed = login.login().catch(err => err)
    while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
    const page = await browserVisit(`${authorizeUrl.searchParams.get('redirect_uri')}?error=${error}&error_description=Invalid+%22redirect_uri%22+in+request.&state=${authorizeUrl.searchParams.get('state')}`)
    assert.match(page.text, /not set up correctly on this server.*ask the server owner/s, error)
    const err = await failed
    assert.deepEqual([err.code, err.message], ['discordMisconfigured', 'Discord login is not set up correctly on this server. Ask the server owner.'], error)
    assert.deepEqual(logged, [`[account] Discord refused the login: ${error} (Invalid "redirect_uri" in request.)`], 'the owner can see which setting Discord objected to')
  }
  // The player cancelling is not logged as a failure
  authorizeUrl = null; logged.length = 0
  const denied = login.login().catch(err => err)
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  await browserVisit(`${authorizeUrl.searchParams.get('redirect_uri')}?error=access_denied&state=${authorizeUrl.searchParams.get('state')}`)
  assert.equal((await denied).code, 'cancelled')
  assert.deepEqual(logged, [])
})

test('login stops early when the server has no Discord login set up', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports, ready: false })
  let opened = false
  const login = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: () => { opened = true } })
  await assert.rejects(login.login(), err => err.code === 'loginNotConfigured')
  assert.equal(opened, false, 'no browser tab for a login that cannot work')
  // Set up, but Discord refuses the server's client secret: said so, still before any browser tab
  const wrong = await backend(t, { ports, ready: false, problem: 'misconfigured' })
  const refused = createDiscordLogin({ apiUrl: () => wrong.url, store: fakeStore(), safeStorage, openExternal: () => { opened = true } })
  await assert.rejects(refused.login(), err => err.code === 'loginMisconfigured' && /not set up correctly on this server\. Ask the server owner\./.test(err.message))
  assert.equal(opened, false)
})

test('refresh, play and logout use the sealed key; a key the server forgot logs the launcher out', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  const store = fakeStore()
  const key = 'key-from-backend-0123456789abcdef0123456789'
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(key).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  const login = createDiscordLogin({ apiUrl: () => api.url, store, safeStorage, openExternal: () => {}, hwid: () => 'pc-guid' })
  const refreshed = await login.refresh()
  assert.deepEqual([refreshed.account.name, refreshed.reached, refreshed.membershipError, refreshed.membershipAge, refreshed.askAgainIn], ['Hadvar Renamed', true, null, null, 0])
  assert.equal(api.seen.meUrls.at(-1), '/api/auth/me')
  // Check again: Discord asked afresh, and the answer says how it went
  api.seen.me = { membershipError: 'Discord answered 503', membershipAge: 20, askAgainIn: 10 }
  const again = await login.refresh({ fresh: true })
  assert.equal(api.seen.meUrls.at(-1), '/api/auth/me?fresh=1')
  assert.deepEqual([again.membershipError, again.membershipAge, again.askAgainIn], ['Discord answered 503', 20, 10])
  api.seen.me = { membershipAge: -5, askAgainIn: 'soon' }
  const odd = await login.refresh()
  assert.deepEqual([odd.membershipAge, odd.askAgainIn], [null, 0], 'Odd numbers from the server are not passed on')
  api.seen.me = null
  const played = await login.play()
  assert.equal(played.session, 'a'.repeat(64))
  assert.deepEqual(api.seen.plays.at(-1), { key, body: { hwid: 'pc-guid' } })

  api.seen.notMember = true
  await assert.rejects(login.play(), err => err.code === 'notMember' && err.inviteUrl === 'https://discord.gg/MTxxdWbcCz')
  api.seen.notMember = false

  api.seen.keys.clear()
  const after = await login.refresh()
  assert.equal(after.loggedIn, false)
  assert.match(after.error, /login has ended/)
  await assert.rejects(login.play(), err => err.code === 'notLoggedIn')

  // Play finding the key forgotten logs out too, and the launcher says why, as refresh does
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(key).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  api.seen.keys.add(key)
  assert.equal((await login.refresh()).error, null, 'logged in again, with no old reason left')
  api.seen.keys.clear()
  await assert.rejects(login.play(), err => err.code === 'notLoggedIn' && /login has ended/.test(err.message))
  assert.deepEqual([login.status().loggedIn, login.status().error], [false, 'Your Dovakarn login has ended. Log in with Discord again.'])

  api.seen.keys.add(key)
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(key).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  const out = await login.logout()
  assert.equal(out.loggedIn, false)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(api.seen.logouts, 1, 'the server forgets the key too')
})

test('Discord may only send the browser back to this PC, and the server cannot redirect the login elsewhere', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  const evil = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: () => { throw Error('must not open') },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/api/auth/config')) return new Response(JSON.stringify({ ready: true, clientId: '111111111111111111', redirectUris: ['https://evil.example/callback', 'http://192.168.1.5:41791/callback'] }), { status: 200 })
      return fetch(url, init)
    } })
  await assert.rejects(evil.login(), err => err.code === 'loginNotConfigured', 'no listener or browser for addresses off this PC')
  let redirectMode = null
  const watched = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: () => {}, fetchImpl: (url, init) => { redirectMode = init.redirect; return fetch(url, init) } })
  await watched.config()
  assert.equal(redirectMode, 'error')
})

test('without Windows encryption the key lasts this run only; an old plain-text key is sealed when encryption works', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  const store = fakeStore()
  const noEncryption = { ...safeStorage, isEncryptionAvailable: () => false }
  let authorizeUrl = null
  const login = createDiscordLogin({ apiUrl: () => api.url, store, safeStorage: noEncryption, openExternal: url => { authorizeUrl = new URL(url) } })
  const done = login.login()
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  await browserVisit(`${authorizeUrl.searchParams.get('redirect_uri')}?code=real-code-123&state=${authorizeUrl.searchParams.get('state')}`)
  assert.equal((await done).loggedIn, true)
  assert.equal(store.get('discordAccountKey'), null, 'nothing written in plain text')
  assert.ok(![...store.raw.values()].some(v => String(v).includes('key-from-backend')))

  const legacy = fakeStore()
  legacy.set('discordAccountKey', 'raw:key-from-backend-0123456789abcdef0123456789')
  legacy.set('discordAccount', { number: 7, name: 'Hadvar' })
  const upgraded = createDiscordLogin({ apiUrl: () => api.url, store: legacy, safeStorage, openExternal: () => {} })
  assert.equal(upgraded.status().loggedIn, true)
  assert.match(legacy.get('discordAccountKey'), /^enc:v1:/)
})

test('a cancel while the server answers keeps nothing, and an answer about a replaced key changes nothing', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  const store = fakeStore()
  let authorizeUrl = null, cancelNow = null
  const login = createDiscordLogin({ apiUrl: () => api.url, store, safeStorage, openExternal: url => { authorizeUrl = new URL(url) },
    fetchImpl: async (url, init) => { if (String(url).endsWith('/api/auth/discord')) cancelNow?.(); return fetch(url, init) } })
  cancelNow = () => login.cancel()
  const done = login.login().catch(err => err)
  while (!authorizeUrl) await new Promise(r => setTimeout(r, 10))
  await browserVisit(`${authorizeUrl.searchParams.get('redirect_uri')}?code=real-code-123&state=${authorizeUrl.searchParams.get('state')}`)
  assert.equal((await done).code, 'cancelled')
  assert.equal(store.get('discordAccountKey'), undefined, 'the cancelled login was not kept')

  // A refresh that finishes after a logout does not bring the old account back
  const key = 'key-from-backend-0123456789abcdef0123456789'
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(key).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  let slowMe = null
  const racing = createDiscordLogin({ apiUrl: () => api.url, store, safeStorage, openExternal: () => {},
    fetchImpl: (url, init) => (String(url).includes('/api/auth/me') ? new Promise(resolve => { slowMe = () => resolve(fetch(url, init)) }) : fetch(url, init)) })
  const refreshing = racing.refresh()
  while (!slowMe) await new Promise(r => setTimeout(r, 10))
  await racing.logout()
  slowMe()
  const after = await refreshing
  assert.equal(after.loggedIn, false)
  assert.equal(store.get('discordAccount'), null, 'the late answer did not restore the account')
})

test('a browser that will not open is explained', async t => {
  const ports = await freePorts(1)
  const api = await backend(t, { ports })
  const login = createDiscordLogin({ apiUrl: () => api.url, store: fakeStore(), safeStorage, openExternal: async () => { throw Error('No application is associated') } })
  await assert.rejects(login.login(), err => err.code === 'browser' && /default browser/.test(err.message))
  assert.equal(login.status().pending, false)
})

test('a server error with no message of its own is said in plain words, never as a number', async () => {
  const logs = []
  const store = fakeStore()
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString('k'.repeat(43)).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  let status = 502
  const login = createDiscordLogin({ apiUrl: () => 'https://dovakarn.test', store, safeStorage, openExternal: () => {}, log: m => logs.push(m),
    fetchImpl: async () => new Response('<html>Bad gateway</html>', { status, headers: { 'Content-Type': 'text/html' } }) })
  for (const [code, text] of [[502, /having trouble right now/], [404, /does not have Discord login yet/], [429, /Too many attempts/], [400, /refused the request/]]) {
    status = code
    const err = await login.play().catch(e => e)
    assert.match(err.message, text, String(code))
    assert.doesNotMatch(err.message, /\d{3}/, 'no raw status code')
    assert.equal(err.status, code)
  }
  assert.match(logs.at(-1), /answered 400 without a message/, 'the code is kept for the log')
})

test('a login, its key and its code go only over https, or to this PC', async () => {
  const store = fakeStore()
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString('k'.repeat(43)).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  const sent = []
  const fetchImpl = async url => { sent.push(url); return new Response(JSON.stringify({ session: 's'.repeat(64), account: { number: 7, name: 'Hadvar' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
  for (const address of ['http://dovakarn.example', 'http://203.0.113.5:4000', 'ftp://dovakarn.example', 'not an address']) {
    const login = createDiscordLogin({ apiUrl: () => address, store, safeStorage, openExternal: () => {}, fetchImpl })
    await assert.rejects(login.play(), err => err.code === 'insecureServer' && /not a secure https address/.test(err.message), address)
  }
  assert.deepEqual(sent, [], 'nothing was sent to an insecure address')
  for (const address of ['https://dovakarn.example', 'http://127.0.0.1:4000', 'http://localhost:4000', 'http://[::1]:4000']) {
    const login = createDiscordLogin({ apiUrl: () => address, store, safeStorage, openExternal: () => {}, fetchImpl })
    assert.equal((await login.play()).account.number, 7, address)
  }
  assert.equal(sent.length, 4)
})

test('an unreachable server keeps the saved login and says so plainly', async () => {
  const store = fakeStore()
  store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString('k'.repeat(43)).toString('base64'))
  store.set('discordAccount', { number: 7, name: 'Hadvar' })
  const login = createDiscordLogin({ apiUrl: () => 'http://127.0.0.1:9', store, safeStorage, openExternal: () => {} })
  const r = await login.refresh({ fresh: true })
  assert.deepEqual([r.loggedIn, r.reached], [true, false])
  assert.match(r.problem, /could not be reached/, 'Check again can say the server did not answer')
  await assert.rejects(login.play(), err => err.code === 'unreachable' && /could not be reached/.test(err.message))
})

test('a logout the server did not receive is kept sealed and sent when it answers, and the player is told a running game plays on', async t => {
  const be = await backend(t, { ports: await freePorts(1) })
  const store = fakeStore()
  let reachable = false
  const fetchImpl = (url, init) => (reachable ? fetch(url, init) : Promise.reject(new Error('connect ECONNREFUSED')))
  const account = createDiscordLogin({ apiUrl: () => be.url, store, safeStorage, openExternal: async () => {}, fetchImpl })
  const KEY = 'key-from-backend-0123456789abcdef0123456789'
  const logIn = () => { store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(KEY).toString('base64')); store.set('discordAccount', { number: 7, name: 'Hadvar' }) }
  logIn()
  const out = await account.logout()
  assert.deepEqual([out.loggedIn, out.logoutPending], [false, true], 'logged out on this PC all the same')
  const pending = store.get('pendingLogouts')
  assert.equal(pending.length, 1); assert.ok(!pending[0].includes(KEY), 'kept sealed, never in plain text')
  assert.equal(await account.finishLogouts(), 1, 'still unreachable: kept')
  // The server answers again: the next refresh sends it
  reachable = true
  await account.refresh()
  for (let i = 0; i < 50 && store.get('pendingLogouts').length; i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual([be.seen.logouts, store.get('pendingLogouts')], [1, []])
  // Reached at once: nothing kept; a server that had ended the login already counts as done
  logIn()
  assert.equal((await account.logout()).logoutPending, undefined)
  be.seen.logoutStatus = 401
  logIn(); reachable = false
  await account.logout()
  reachable = true
  assert.equal(await account.finishLogouts(), 0)
  assert.deepEqual(store.get('pendingLogouts'), [])
  // Without Windows encryption the key is kept for this run only, in memory
  const plain = createDiscordLogin({ apiUrl: () => be.url, store: fakeStore(), safeStorage: { isEncryptionAvailable: () => false }, openExternal: async () => {}, fetchImpl: () => Promise.reject(new Error('offline')) })
  assert.equal((await plain.logout()).logoutPending, undefined, 'not logged in: nothing to send')
})

test('a logout kept while another is being retried is never overwritten, and one retry pass runs at a time', async t => {
  const be = await backend(t, { ports: await freePorts(1) })
  const store = fakeStore()
  // mode 'fail': the server refuses at once (down); 'hang': the send waits until gate() fails it
  let mode = 'fail', gate = null
  const fetchImpl = url => (String(url).endsWith('/api/auth/logout') && mode === 'hang'
    ? new Promise((_, reject) => { gate = () => reject(new Error('connect ECONNREFUSED')) })
    : Promise.reject(new Error('connect ECONNREFUSED')))
  const account = createDiscordLogin({ apiUrl: () => be.url, store, safeStorage, openExternal: async () => {}, fetchImpl })
  const logIn = key => { store.set('discordAccountKey', 'enc:v1:' + safeStorage.encryptString(key).toString('base64')); store.set('discordAccount', { number: 7, name: 'Hadvar' }) }
  logIn('key-one-0123456789abcdef0123456789abcdef')
  await account.logout()
  assert.equal(store.get('pendingLogouts').length, 1)
  // A retry pass hangs on the dead server; meanwhile the player logs out of another account
  mode = 'hang'
  const pass = account.finishLogouts()
  await new Promise(r => setImmediate(r))
  mode = 'fail'
  logIn('key-two-0123456789abcdef0123456789abcdef')
  await account.logout()
  assert.equal(store.get('pendingLogouts').length, 2, 'the second logout is kept while the pass runs')
  gate()
  await pass
  assert.equal(store.get('pendingLogouts').length, 2, 'the finished pass keeps both: nothing kept meanwhile is lost')
  // One pass at a time
  mode = 'hang'
  const p1 = account.finishLogouts(), p2 = account.finishLogouts()
  assert.equal(p1, p2, 'a second call during a pass joins it')
  mode = 'fail'; gate()
  await p1
  assert.equal(store.get('pendingLogouts').length, 2, 'still kept for the next try')
})
