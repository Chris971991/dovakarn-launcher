const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const na = require('../src/nexusAccount')

const settle = () => new Promise(resolve => setImmediate(resolve))
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')
// A Nexus access token as Nexus sends it: a JWT whose payload carries the user (read, never verified, by the launcher)
const jwt = ({ name = 'Dragonborn', id = 4242, roles = ['member', 'premium'], exp = Math.floor(Date.now() / 1000) + 3600 } = {}) =>
  `${b64({ alg: 'RS256' })}.${b64({ sub: String(id), exp, user: { id, username: name, membership_roles: roles } })}.c2lnbmF0dXJl`
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })
// Windows encryption as Electron gives it: reversible here, never the plain text
const sealing = (available = true) => ({ isEncryptionAvailable: () => available, encryptString: s => Buffer.from(s).map(b => b ^ 0x5a), decryptString: buf => Buffer.from(buf).map(b => b ^ 0x5a).toString() })
const memoryStore = () => { const m = new Map(); return { get: k => m.has(k) ? m.get(k) : null, set: (k, v) => m.set(k, v), raw: m } }

// One server on this PC playing both the Dovakarn backend (/api/auth/nexus) and Nexus (/oauth/*, /v1/*). The test sets
// what each answers; every request is kept with its headers and form
async function fakeNexus(t, { ready = true, clientId = 'dovakarn_launcher' } = {}) {
  const ports = [await freePort(), await freePort()]
  const s = { requests: [], ready, clientId, ports, refreshes: 0, revoked: [], challenge: null, codes: new Map(), validAccess: new Set(), api: null,
    tokens: { access_token: jwt(), refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' } }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x'), form = Object.fromEntries(new URLSearchParams(body))
      s.requests.push({ method: req.method, path: url.pathname, headers: req.headers, form })
      const json = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)) }
      if (url.pathname === '/api/auth/nexus' && s.holdConfig) return void s.holdConfig.then(() => json(200, { ready: s.ready, clientId: s.clientId, redirectUris: s.ports.map(p => 'http://127.0.0.1:' + p + '/callback'), scope: na.SCOPE }))
      if (url.pathname === '/api/auth/nexus' && s.configStatus) return json(s.configStatus, { error: 'down' })
      if (url.pathname === '/api/auth/nexus') return json(200, { ready: s.ready, clientId: s.ready ? s.clientId : null, redirectUris: s.ports.map(p => `http://127.0.0.1:${p}/callback`), scope: na.SCOPE })
      if (url.pathname === '/oauth/token' && s.holdToken) { const hold = s.holdToken; s.holdToken = null; return hold.then(reply) }
      if (url.pathname === '/oauth/token') return reply()
      function reply() {
        if (form.client_id !== s.clientId) return json(401, { error: 'invalid_client' })
        if (form.grant_type === 'authorization_code') {
          const want = s.codes.get(form.code)
          const challenge = crypto.createHash('sha256').update(form.code_verifier || '').digest('base64url')
          if (!want || want.redirect !== form.redirect_uri || challenge !== s.challenge) return json(400, { error: 'invalid_grant' })
          s.validAccess.add(s.tokens.access_token)
          return json(200, s.tokens)
        }
        if (form.grant_type === 'refresh_token') {
          s.refreshes++
          // refuseRefresh: Nexus gave that refresh token out once already (another launcher on this PC renewed first)
          if (form.refresh_token === 'dead' || s.refuseRefresh) return json(400, { error: 'invalid_grant' })
          if (s.refreshStatus) return json(s.refreshStatus, { error: 'slow_down' })
          const next = { access_token: jwt({ roles: s.renewRoles || ['member', 'premium'] }) + s.refreshes, refresh_token: `refresh-${s.refreshes + 1}`, expires_in: 3600, token_type: 'Bearer' }
          s.validAccess.add(next.access_token)
          return json(200, next)
        }
        return json(400, { error: 'unsupported_grant_type' })
      }
      if (url.pathname === '/oauth/revoke') { s.revoked.push(form); return json(200, {}) }
      if (url.pathname.startsWith('/v1/')) {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '')
        if (s.api) return s.api(url, token, json)
        if (!s.validAccess.has(token)) return json(401, { message: 'Token is invalid' })
        return json(200, [{ name: 'Nexus CDN', short_name: 'Nexus CDN', URI: 'https://cf-files.nexusmods.com/cdn/1704/62775/TrueHUD-62775-1-1-9.7z?md5=x&expires=1' }])
      }
      json(404, {})
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  s.base = `http://127.0.0.1:${server.address().port}`
  return s
}

// The launcher's Nexus account against that server. browser(url): what the player's browser does with the login page
// (by default: Nexus approves, and the browser lands on the launcher's 127.0.0.1 listener with the code)
function account(t, s, { store = memoryStore(), safeStorage = sealing(), browser, now = Date.now, timeoutMs } = {}) {
  const opened = [], logs = []
  const approve = async url => {
    const u = new URL(url), code = `code-${opened.length}`
    s.challenge = u.searchParams.get('code_challenge')
    s.codes.set(code, { redirect: u.searchParams.get('redirect_uri') })
    return fetch(`${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}`).then(r => r.text())
  }
  const a = na.createNexusAccount({
    apiUrl: () => s.base, usersUrl: s.base, apiBase: s.base, store, safeStorage, appVersion: '3.1.0', log: line => logs.push(line), now,
    ...(timeoutMs ? { timeoutMs } : {}),
    openExternal: async url => { opened.push(url); setImmediate(() => (browser || approve)(url)) },
  })
  return { a, opened, logs, store, approve }
}

test("an access token's account: name, id and Premium from Nexus's JWT; anything else is no account", () => {
  assert.deepEqual(na.accountFromToken(jwt({ exp: 2000000000 })), { name: 'Dragonborn', id: 4242, premium: true, expiresAt: 2000000000000 })
  assert.equal(na.accountFromToken(jwt({ roles: ['member', 'supporter'] })).premium, false, 'Supporter is not Premium')
  assert.equal(na.accountFromToken(jwt({ name: `Ab\u0001c\n${'x'.repeat(90)}` })).name.length, 64)
  assert.doesNotMatch(na.accountFromToken(jwt({ name: 'Ab\u0001c' })).name, /[\u0000-\u001f]/)
  for (const bad of ['', 'a.b.c', 'only-one-part', `x.${b64({ sub: '1' })}.y`, null, 7]) assert.equal(na.accountFromToken(bad), null, String(bad))
})

test("only Nexus's own https hosts on the default port count as a Nexus file address", () => {
  for (const ok of ['https://cf-files.nexusmods.com/cdn/1/2/a.7z', 'https://premium-files.nexus-cdn.com/1/2/a.7z', 'https://nexusmods.com/x']) assert.equal(na.nexusFileUrl(ok), true, ok)
  for (const bad of ['http://cf-files.nexusmods.com/a.7z', 'https://cf-files.nexusmods.com:8443/a.7z', 'https://nexusmods.com.evil.example/a.7z', 'https://evil.example/?h=nexus-cdn.com', 'ftp://x', 'nonsense', '']) {
    assert.equal(na.nexusFileUrl(bad), false, bad)
  }
})

test('Nexus login switched off on the server: said plainly, nothing opened, nothing listening', async t => {
  const s = await fakeNexus(t, { ready: false }), { a, opened } = account(t, s)
  assert.equal(await a.available(), false)
  await assert.rejects(a.login(), err => err.code === 'nexusNotConfigured' && err.message === na.NOT_ON)
  assert.deepEqual(opened, [])
  assert.deepEqual(a.status(), { loggedIn: false, account: null, pending: false, error: na.NOT_ON, ended: false })
  // An older Dovakarn server without the route reads the same
  s.base += '/old'
  const old = account(t, s)
  assert.equal(await old.a.available(), false)
})

test("Log in to Nexus: PKCE in the player's own browser, the code swapped on this PC, the tokens sealed, the account named", async t => {
  const s = await fakeNexus(t), { a, opened, store, logs } = account(t, s)
  const seen = []
  a.onChange(state => seen.push(state.pending))
  assert.equal(await a.available(), true)
  const state = await a.login()
  assert.deepEqual(state, { loggedIn: true, account: { name: 'Dragonborn', id: 4242, premium: true }, pending: false, error: null, ended: false })
  assert.deepEqual(seen, [true, false], 'the page hears the wait and its end')
  const u = new URL(opened[0])
  assert.equal(`${u.origin}${u.pathname}`, `${s.base}/oauth/authorize`)
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: 'dovakarn_launcher', response_type: 'code', redirect_uri: `http://127.0.0.1:${s.ports[0]}/callback`, scope: 'openid profile',
    state: u.searchParams.get('state'), code_challenge: u.searchParams.get('code_challenge'), code_challenge_method: 'S256' })
  assert.match(u.searchParams.get('state'), /^[A-Za-z0-9_-]{20,}$/)
  const token = s.requests.find(r => r.path === '/oauth/token')
  assert.deepEqual(Object.keys(token.form).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri'], 'no client secret: a public client')
  assert.deepEqual([token.headers['application-name'], token.headers['application-version']], ['Dovakarn Launcher', '3.1.0'])
  const sealed = store.raw.get('nexusToken')
  assert.match(sealed, /^enc:v1:/)
  assert.ok(!sealed.includes('refresh-1') && !sealed.includes(s.tokens.access_token), 'never written in plain text')
  assert.deepEqual(store.raw.get('nexusAccount'), { name: 'Dragonborn', id: 4242, premium: true })
  assert.ok(logs.includes('[nexus] logged in to Nexus as Dragonborn (Premium)'))
  assert.equal(await a.accessToken(), s.tokens.access_token)
  // The listener is gone once the login ends
  await assert.rejects(fetch(`http://127.0.0.1:${s.ports[0]}/callback?code=x&state=y`))
})

test('a busy first port moves to the next; a foreign callback is ignored; cancelling on Nexus or in the launcher ends it', async t => {
  const s = await fakeNexus(t)
  const blocker = http.createServer(); await new Promise(r => blocker.listen(s.ports[0], '127.0.0.1', r)); t.after(() => blocker.close())
  let flow = null
  const browser = async url => { flow = new URL(url) }
  const { a } = account(t, s, { browser })
  const done = a.login(); done.catch(() => {})
  while (!flow) await settle()
  const redirect = flow.searchParams.get('redirect_uri')
  assert.equal(redirect, `http://127.0.0.1:${s.ports[1]}/callback`)
  const foreign = await fetch(`${redirect}?code=stolen&state=someone-else`)
  assert.equal(foreign.status, 400)
  assert.match(await foreign.text(), /This Nexus login link is out of date/)
  const denied = await fetch(`${redirect}?error=access_denied&state=${flow.searchParams.get('state')}`)
  assert.match(await denied.text(), /You cancelled the Nexus login/)
  await assert.rejects(done, err => err.code === 'cancelled')
  assert.equal(a.status().error, null, 'a cancel is not an error')
  // Cancel in the launcher while the browser waits
  flow = null
  const again = a.login(); again.catch(() => {})
  while (!flow) await settle()
  assert.equal(a.status().pending, true)
  await assert.rejects(a.login(), err => err.code === 'pending', 'one login at a time')
  a.cancel()
  await assert.rejects(again, err => err.code === 'cancelled')
  assert.equal(a.status().pending, false)
  // Nexus refusing this application (set up wrong) is said as that
  flow = null
  const wrong = a.login(); wrong.catch(() => {})
  while (!flow) await settle()
  const refused = await fetch(`${flow.searchParams.get('redirect_uri')}?error=invalid_client&state=${flow.searchParams.get('state')}`)
  assert.match(await refused.text(), /not set up correctly for Dovakarn/)
  await assert.rejects(wrong, err => err.code === 'nexusMisconfigured')
})

test('the token renews before it ends, once for everyone asking; Nexus refusing the renewal ends the login', async t => {
  const s = await fakeNexus(t)
  let clock = Date.now()
  const { a, store } = account(t, s, { now: () => clock })
  await a.login()
  const first = await a.accessToken()
  clock += 3600 * 1000 - 30 * 1000                                 // 30 seconds before Nexus says it ends
  s.renewRoles = ['member']                                          // Premium ran out meanwhile
  const [x, y] = await Promise.all([a.accessToken(), a.accessToken()])
  assert.equal(x, y)
  assert.notEqual(x, first)
  assert.equal(s.refreshes, 1, 'one renewal for both')
  assert.equal(a.status().account.premium, false, 'the renewal also says whether the account is still Premium')
  const renew = s.requests.filter(r => r.path === '/oauth/token').at(-1)
  assert.deepEqual(renew.form, { grant_type: 'refresh_token', client_id: 'dovakarn_launcher', refresh_token: 'refresh-1' })
  // Nexus refusing the renewal (revoked on its site): the login ends on this PC
  const t2 = JSON.parse(sealing().decryptString(Buffer.from(store.raw.get('nexusToken').slice(7), 'base64')))
  store.raw.set('nexusToken', 'enc:v1:' + sealing().encryptString(JSON.stringify({ ...t2, refresh: 'dead', expiresAt: 0 })).toString('base64'))
  await assert.rejects(a.accessToken(), err => err.code === 'nexusLoggedOut' && err.message === na.ENDED)
  assert.deepEqual(a.status(), { loggedIn: false, account: null, pending: false, error: na.ENDED, ended: true })
})

test('without Windows encryption the login lasts this run only and is never written', async t => {
  const s = await fakeNexus(t), store = memoryStore()
  const { a, logs } = account(t, s, { store, safeStorage: sealing(false) })
  await a.login()
  assert.equal(a.status().loggedIn, true)
  assert.equal(store.raw.get('nexusToken'), null)
  assert.ok(logs.includes('[nexus] Windows encryption is unavailable: this Nexus login lasts until the launcher closes'))
  const later = account(t, s, { store, safeStorage: sealing(false) }).a
  assert.equal(later.status().loggedIn, false, 'the next run starts logged out')
})

test('log out: the tokens leave this PC and Nexus is told; Nexus out of reach logs out all the same', async t => {
  const s = await fakeNexus(t), { a, store } = account(t, s)
  await a.login()
  const state = await a.logout()
  assert.deepEqual(state, { loggedIn: false, account: null, pending: false, error: null, ended: false })
  assert.deepEqual([store.raw.get('nexusToken'), store.raw.get('nexusAccount')], [null, null])
  assert.deepEqual(s.revoked, [{ client_id: 'dovakarn_launcher', token: 'refresh-1', token_type_hint: 'refresh_token' }])
  await a.login()
  s.base = 'http://127.0.0.1:1'                                      // nothing answers there
  const off = account(t, s, { store }).a
  assert.equal((await off.logout()).loggedIn, false)
  assert.equal(store.raw.get('nexusToken'), null)
})

test("Nexus's API: the player's token and the app's name on every call; a refused token renews once; refusals in plain words", async t => {
  const s = await fakeNexus(t), { a } = account(t, s)
  await a.login()
  const archive = { modId: 62775, fileId: 454617, name: 'TrueHUD' }
  assert.equal(await a.downloadLink(archive), 'https://cf-files.nexusmods.com/cdn/1704/62775/TrueHUD-62775-1-1-9.7z?md5=x&expires=1')
  const call = s.requests.find(r => r.path.startsWith('/v1/'))
  assert.equal(call.path, '/v1/games/skyrimspecialedition/mods/62775/files/454617/download_link.json')
  assert.deepEqual([call.headers.authorization, call.headers['application-name'], call.headers['application-version']], [`Bearer ${s.tokens.access_token}`, 'Dovakarn Launcher', '3.1.0'])
  // Nexus refuses the token once (revoked meanwhile): renewed and asked again
  s.validAccess.clear()
  assert.match(await a.downloadLink(archive), /^https:\/\/cf-files/)
  assert.equal(s.refreshes, 1)
  // 403 for a Premium account (its renewed token still Premium): this one file is refused; not Premium is its own test
  for (const [status, code] of [[403, 'fileRefused'], [404, 'gone'], [503, 'http503']]) {
    s.api = (_url, _token, json) => json(status, { message: 'from Nexus' })
    await assert.rejects(a.downloadLink(archive), err => err.code === code, String(status))
  }
  // Links anywhere but Nexus's own https hosts are never used
  s.api = (_url, _token, json) => json(200, [{ URI: 'https://evil.example/TrueHUD.7z' }, { URI: 'http://cf-files.nexusmods.com/a.7z' }])
  await assert.rejects(a.downloadLink(archive), err => err.code === 'noLink')
  s.api = (_url, _token, json) => json(200, [{ URI: 'https://evil.example/a.7z' }, { URI: 'https://premium-files.nexus-cdn.com/1/2/a.7z' }])
  assert.equal(await a.downloadLink(archive), 'https://premium-files.nexus-cdn.com/1/2/a.7z', 'the first Nexus link wins')
  // A token Nexus keeps refusing ends the login
  s.api = (_url, _token, json) => json(401, { message: 'Token is invalid' })
  await assert.rejects(a.downloadLink(archive), err => err.code === 'nexusLoggedOut')
  assert.equal(a.status().loggedIn, false)
  await assert.rejects(a.downloadLink(archive), err => err.code === 'nexusLoggedOut', 'logged out: nothing is asked')
})

test("a file comes only from Nexus's hosts, redirects included, and never more than the file needed", async t => {
  const s = await fakeNexus(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-nexusfile-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const answers = new Map(), asked = []
  const getFile = async (url, { headers }) => {
    asked.push([url, headers['User-Agent'], headers])
    const a = answers.get(url) || { status: 404 }
    return { status: a.status, location: a.location || '', length: a.bytes ? a.bytes.length : NaN, discard() {},
      saveTo: async (file, { limit, onProgress }) => { if (a.bytes.length > limit) throw Object.assign(new Error('bigger'), { code: 'different' }); fs.writeFileSync(file, a.bytes); onProgress(a.bytes.length) } }
  }
  const a = na.createNexusAccount({ apiUrl: () => s.base, store: memoryStore(), safeStorage: sealing(), openExternal: async () => {}, appVersion: '3.1.0', getFile })
  const bytes = Buffer.from('TrueHUD archive '.repeat(20)), save = path.join(dir, 'part.download')
  answers.set('https://cf-files.nexusmods.com/start', { status: 302, location: 'https://premium-files.nexus-cdn.com/real.7z' })
  answers.set('https://premium-files.nexus-cdn.com/real.7z', { status: 200, bytes })
  const progress = []
  assert.deepEqual(await a.nexusFile('https://cf-files.nexusmods.com/start', save, { limit: bytes.length, onProgress: p => progress.push(p) }), { host: 'premium-files.nexus-cdn.com' })
  assert.deepEqual(fs.readFileSync(save), bytes)
  assert.deepEqual(progress, [{ received: bytes.length, total: bytes.length }])
  assert.deepEqual(asked.map(x => x[1]), ['Dovakarn Launcher/3.1.0', 'Dovakarn Launcher/3.1.0'])
  assert.deepEqual(asked.map(x => [x[2]['Application-Name'], x[2]['Application-Version']]), [['Dovakarn Launcher', '3.1.0'], ['Dovakarn Launcher', '3.1.0']], "Nexus's two headers on its file servers too, every hop")
  await assert.rejects(a.nexusFile('https://cf-files.nexusmods.com/start', save, {}), err => err.code === 'different', 'never without a size cap')
  answers.set('https://cf-files.nexusmods.com/away', { status: 302, location: 'https://evil.example/real.7z' })
  await assert.rejects(a.nexusFile('https://cf-files.nexusmods.com/away', save, { limit: bytes.length }), err => err.code === 'elsewhere')
  assert.ok(!asked.some(([u]) => u.startsWith('https://evil.example')), 'never asked outside Nexus')
  await assert.rejects(a.nexusFile('https://cf-files.nexusmods.com/start', save, { limit: bytes.length - 1 }), err => err.code === 'different', 'its stated size is too big')
  answers.set('https://cf-files.nexusmods.com/loop', { status: 302, location: 'https://cf-files.nexusmods.com/loop' })
  await assert.rejects(a.nexusFile('https://cf-files.nexusmods.com/loop', save, { limit: 10 }), err => err.code === 'noLink')
  answers.set('https://cf-files.nexusmods.com/expired', { status: 403 })
  await assert.rejects(a.nexusFile('https://cf-files.nexusmods.com/expired', save, { limit: 10 }), err => err.code === 'fileFailed' && /ran out/.test(err.message))
})

test('the file GET writes what arrives, stops at the limit, says a cut-off download, and stops when asked', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-httpsget-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const bytes = Buffer.alloc(200000, 3)
  let mode = 'whole', heldRes = null
  const server = http.createServer((req, res) => {
    if (mode === 'whole') { res.writeHead(200, { 'Content-Length': bytes.length }); return res.end(bytes) }
    if (mode === 'cut') { res.writeHead(200, { 'Content-Length': bytes.length }); res.write(bytes.subarray(0, 1000)); return setTimeout(() => res.destroy(), 20) }
    if (mode === 'hold') { res.writeHead(200, { 'Content-Length': bytes.length }); res.write(bytes.subarray(0, 1000)); heldRes = res }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://cf-files.nexusmods.com/x' }); res.end() }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => { heldRes?.destroy(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}/f`, get = (opts = {}) => na.httpsGet(url, { transport: http, ...opts })
  let seen = 0
  const whole = await get()
  assert.deepEqual([whole.status, whole.length], [200, bytes.length])
  await whole.saveTo(path.join(dir, 'a'), { limit: bytes.length, onProgress: n => { seen = n } })
  assert.deepEqual([fs.statSync(path.join(dir, 'a')).size, seen], [bytes.length, bytes.length])
  await assert.rejects((await get()).saveTo(path.join(dir, 'b'), { limit: 1000 }), err => err.code === 'different')
  mode = 'cut'
  await assert.rejects((await get()).saveTo(path.join(dir, 'c'), { limit: bytes.length }), err => err.code === 'interrupted', 'a dropped connection is a cut-off download, which is tried again')
  mode = 'hold'
  const stop = new AbortController(), held = (await get()).saveTo(path.join(dir, 'd'), { limit: bytes.length, signal: stop.signal })
  await new Promise(r => setTimeout(r, 30))
  stop.abort()
  await assert.rejects(held, err => err.code === 'CANCELLED')
  heldRes?.destroy(); heldRes = null
  // No bytes for a while: the stall check decides, not the socket's own timeout
  mode = 'hold'
  await assert.rejects((await get()).saveTo(path.join(dir, 'e'), { limit: bytes.length, stallMs: 80 }), err => err.code === 'stalled')
  heldRes?.destroy(); heldRes = null
  mode = 'redirect'
  const hop = await get()
  assert.deepEqual([hop.status, hop.location], [302, 'https://cf-files.nexusmods.com/x'], 'a redirect is handed back, never followed here')
  hop.discard()
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(get({ signal: stopped.signal }), err => err.code === 'CANCELLED')
})

test('the Dovakarn server failing is never read as Nexus login off: it is not kept, and said as not known', async t => {
  const s = await fakeNexus(t), { a } = account(t, s)
  s.configStatus = 502
  assert.equal(await a.available(), null)
  await assert.rejects(a.login(), err => err.code === 'unreachable')
  s.configStatus = 0
  assert.equal(await a.available(), true, 'asked again at once: a failure is never kept')
  s.base += '/old'
  assert.equal(await account(t, s).a.available(), false, 'an older server without Nexus login (404) is off')
})

test('Cancel ends the wait at once, even while Nexus swaps the code', async t => {
  const s = await fakeNexus(t)
  let release
  s.holdToken = new Promise(resolve => { release = resolve })
  const { a } = account(t, s)
  const login = a.login(); login.catch(() => {})
  while (!s.requests.some(r => r.path === '/oauth/token')) await settle()
  a.cancel()
  await assert.rejects(login, err => err.code === 'cancelled')
  assert.equal(a.status().pending, false)
  assert.equal(a.status().loggedIn, false)
  release()
})

test("a renewal that loses to a logout is never handed out and Nexus is told; another launcher's renewal is used", async t => {
  const s = await fakeNexus(t)
  let clock = Date.now()
  const { a, store } = account(t, s, { now: () => clock })
  await a.login()
  clock += 3600 * 1000                                               // ended
  let release
  s.holdToken = new Promise(resolve => { release = resolve })
  const renewal = a.accessToken(); renewal.catch(() => {})
  while (!s.requests.some(r => r.form.grant_type === 'refresh_token')) await settle()
  await a.logout()
  release()
  await assert.rejects(renewal, err => err.code === 'nexusLoggedOut')
  while (s.revoked.length < 2) await settle()
  assert.deepEqual(s.revoked.map(r => r.token), ['refresh-1', 'refresh-2'], 'the logout, then the tokens the renewal brought')
  // Another launcher on this PC renewed first: Nexus refuses this one's old refresh token, and the other's tokens are used
  await a.login()
  clock += 3600 * 1000
  const sealed = () => JSON.parse(sealing().decryptString(Buffer.from(store.raw.get('nexusToken').slice(7), 'base64')))
  const mine = sealed()
  s.holdToken = new Promise(resolve => { release = resolve })
  const second = a.accessToken()
  while (!s.requests.some(r => r.form.refresh_token === mine.refresh && r.form.grant_type === 'refresh_token')) await settle()
  const theirs = { ...mine, access: 'their-access', refresh: 'their-refresh', expiresAt: clock + 3600 * 1000 }
  store.raw.set('nexusToken', 'enc:v1:' + sealing().encryptString(JSON.stringify(theirs)).toString('base64'))
  s.refuseRefresh = true
  release()
  assert.equal(await second, 'their-access')
  assert.equal(a.status().loggedIn, true, 'the login on this PC is kept')
})

test('the login carries its Nexus application, so renewing and revoking never need the Dovakarn server', async t => {
  const s = await fakeNexus(t)
  let clock = Date.now()
  const { a, store } = account(t, s, { now: () => clock })
  await a.login()
  const blob = JSON.parse(sealing().decryptString(Buffer.from(store.raw.get('nexusToken').slice(7), 'base64')))
  assert.equal(blob.clientId, 'dovakarn_launcher')
  s.configStatus = 503
  clock += 3600 * 1000
  assert.match(await a.accessToken(), /^ey/, 'renewed with the Dovakarn server down')
  await a.logout()
  assert.equal(s.revoked.at(-1).client_id, 'dovakarn_launcher')
})

test('Cancel during the server check ends at once; tokens Nexus issues after a Cancel are revoked', async t => {
  const s = await fakeNexus(t)
  let release
  s.holdConfig = new Promise(resolve => { release = resolve })
  const { a, opened } = account(t, s)
  const login = a.login(); login.catch(() => {})
  while (!s.requests.some(r => r.path === '/api/auth/nexus')) await settle()
  a.cancel()
  await assert.rejects(login, err => err.code === 'cancelled')
  assert.deepEqual([a.status().pending, opened], [false, []], 'over at once, and no browser opened')
  release(); s.holdConfig = null
  // Cancel while Nexus swaps the code: the wait ends at once, and the tokens Nexus then sends are revoked
  let answer
  s.holdToken = new Promise(resolve => { answer = resolve })
  const second = a.login(); second.catch(() => {})
  while (!s.requests.some(r => r.path === '/oauth/token')) await settle()
  a.cancel()
  await assert.rejects(second, err => err.code === 'cancelled')
  answer()
  while (!s.revoked.length) await settle()
  assert.deepEqual(s.revoked, [{ client_id: 'dovakarn_launcher', token: 'refresh-1', token_type_hint: 'refresh_token' }])
  assert.equal(a.status().loggedIn, false)
})

test("refused by Nexus: a renewed token is tried once, and it says whether the account is still Premium; Nexus limiting a renewal keeps the login", async t => {
  const s = await fakeNexus(t), { a, store } = account(t, s)
  const seen = []
  a.onChange(state => seen.push(state.account?.premium))
  await a.login()
  const archive = { modId: 62775, fileId: 454617, name: 'TrueHUD' }
  s.api = (_url, _token, json) => json(403, { message: 'refused' })
  // Still Premium after the renewal: only this file is refused (hidden or under moderation), the account stays Premium
  await assert.rejects(a.downloadLink(archive), err => err.code === 'fileRefused')
  assert.equal(s.refreshes, 1, 'renewed once first: Premium may have started or ended since the token was issued')
  assert.equal(store.raw.get('nexusAccount').premium, true)
  // Premium ended: the renewed token says so, and the account is kept as not Premium
  s.renewRoles = ['member']
  await assert.rejects(a.downloadLink(archive), err => err.code === 'notPremium')
  assert.equal(store.raw.get('nexusAccount').premium, false)
  assert.equal(seen.at(-1), false, 'the page hears it')
  s.renewRoles = null
  // A renewal Nexus refuses for its own reasons (its limit): the login stays, and the caller is told to stop
  let clock = Date.now() + 3600 * 1000
  const later = account(t, s, { store, now: () => clock }).a
  s.refreshStatus = 429
  await assert.rejects(later.accessToken(), err => err.code === 'renewFailed')
  assert.equal(later.status().loggedIn, true)
  s.refreshStatus = 0
})

test('a redirect with no address and a file the disk refuses are said as such, never as a finished file', async t => {
  const s = await fakeNexus(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-nexusfile2-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let asked = 0
  const getFile = async () => { asked++; return { status: 302, location: '', length: NaN, discard() {}, saveTo: async () => {} } }
  const a = na.createNexusAccount({ apiUrl: () => s.base, store: memoryStore(), safeStorage: sealing(), openExternal: async () => {}, appVersion: '3.1.0', getFile })
  await assert.rejects(a.nexusFile('https://cf-files.nexusmods.com/x', path.join(dir, 'p'), { limit: 10 }), err => err.code === 'noLink')
  assert.equal(asked, 1, 'not asked again round in circles')
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Length': 5 }); res.end('hello') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(() => server.close())
  const answer = await na.httpsGet(`http://127.0.0.1:${server.address().port}/f`, { transport: http })
  await assert.rejects(answer.saveTo(path.join(dir, 'no such folder', 'part'), { limit: 10 }), err => err.code === 'save')
})

// ---- Nexus's rate limits ----
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR
// Nexus's own date format in its x-rl-*-reset headers
const nexusDate = ms => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000')
async function limited(t) {
  let clock = Date.UTC(2026, 0, 1, 12, 0, 0)
  const s = await fakeNexus(t), made = account(t, s, { now: () => clock })
  await made.a.login()
  const link = [{ URI: 'https://cf-files.nexusmods.com/cdn/1704/62775/TrueHUD.7z' }]
  const answers = []
  s.api = (_url, _token, json) => { const next = answers.length > 1 ? answers.shift() : answers[0] || { status: 200, headers: {} }; json(next.status, next.status === 200 ? link : { message: 'from Nexus' }, next.headers) }
  const asked = () => s.requests.filter(r => r.path.startsWith('/v1/')).length
  const get = () => made.a.downloadLink({ modId: 62775, fileId: 454617, name: 'TrueHUD' })
  return { s, ...made, link, answers, asked, get, advance: ms => { clock += ms }, now: () => clock,
    answer: (status, headers = {}) => { answers.length = 0; answers.push({ status, headers }) } }
}
const blocked = async (r, words) => {
  const before = r.asked()
  await assert.rejects(r.get(), err => err.code === 'rateLimited' && (!words || words.test(err.message)), String(words))
  assert.equal(r.asked(), before, 'nothing was asked of Nexus')
}

test('rate limit: an hour used up blocks until the reset Nexus names, in its own date format, and says how long', async t => {
  const r = await limited(t)
  r.answer(200, { 'x-rl-hourly-remaining': '5', 'x-rl-daily-remaining': '100' })
  assert.equal(await r.get(), r.link[0].URI)
  r.answer(200, { 'x-rl-hourly-remaining': '0', 'x-rl-daily-remaining': '99', 'x-rl-hourly-reset': nexusDate(r.now() + 20 * MIN) })
  assert.equal(await r.get(), r.link[0].URI, 'the answer that used it up still counts')
  await blocked(r, /^Nexus's hourly limit on requests for your account is used up\. Try again in 20 minutes, or use the Nexus window\.$/)
  r.advance(19 * MIN)
  await blocked(r, /Try again in 1 minute,/)
  r.advance(MIN)
  r.answer(200, {})
  assert.equal(await r.get(), r.link[0].URI, 'at the reset Nexus is asked again')
})

test('rate limit: the day used up blocks until x-rl-daily-reset, or a day when none is named, worded in hours', async t => {
  const r = await limited(t)
  r.answer(200, { 'x-rl-hourly-remaining': '10', 'x-rl-daily-remaining': '0', 'x-rl-daily-reset': nexusDate(r.now() + 5 * HOUR + 1000) })
  await r.get()
  await blocked(r, /^Nexus's daily limit on requests for your account is used up\. Try again in about 5 hours, or use the Nexus window\.$/)
  r.advance(5 * HOUR + 1000)
  r.answer(200, { 'x-rl-daily-remaining': '0' })
  await r.get()
  await blocked(r, /Try again in about 24 hours,/)
  r.advance(DAY)
  r.answer(200, {})
  assert.equal(await r.get(), r.link[0].URI)
})

test('rate limit: a far-future reset is capped at a day, and a reset already past blocks nothing', async t => {
  const r = await limited(t)
  r.answer(200, { 'x-rl-daily-remaining': '0', 'x-rl-daily-reset': nexusDate(r.now() + 5 * DAY) })
  await r.get()
  await blocked(r, /Try again in about 24 hours,/)
  r.advance(DAY)
  r.answer(200, { 'x-rl-hourly-remaining': '0', 'x-rl-hourly-reset': nexusDate(r.now() - MIN) })
  assert.equal(await r.get(), r.link[0].URI, 'the cap ended the block')
  assert.equal(await r.get(), r.link[0].URI, 'a reset in the past blocks nothing; Nexus is asked again')
  r.answer(200, { 'x-rl-hourly-remaining': '0', 'x-rl-hourly-reset': nexusDate(r.now()) })
  await r.get()
  assert.equal(await r.get(), r.link[0].URI, 'a reset of now blocks nothing either')
})

test('rate limit: -1, 0.0 and 0x0 are none left; a non-numeric or empty count is ignored', async t => {
  for (const value of ['-1', '0.0', '0x0', ' 0 ']) {
    const r = await limited(t)
    r.answer(200, { 'x-rl-hourly-remaining': value })
    await r.get()
    await blocked(r, /Try again in 60 minutes,/)
  }
  for (const value of ['abc', '', 'NaN', 'Infinity']) {
    const r = await limited(t)
    r.answer(200, { 'x-rl-hourly-remaining': value, 'x-rl-daily-remaining': value })
    await r.get()
    assert.equal(await r.get(), r.link[0].URI, JSON.stringify(value))
  }
})

test('rate limit: a 429 blocks later calls for Retry-After (seconds or a date), else the reset header, else a minute', async t => {
  const seconds = await limited(t)
  seconds.answer(429, { 'retry-after': '120' })
  await assert.rejects(seconds.get(), err => err.code === 'rateLimited' && /^Nexus is limiting how many downloads you can start right now\. Try again in 2 minutes, or use the Nexus window\.$/.test(err.message))
  await blocked(seconds, /Try again in 2 minutes,/)
  seconds.advance(2 * MIN)
  seconds.answer(200, {})
  assert.equal(await seconds.get(), seconds.link[0].URI)

  const date = await limited(t)
  date.answer(429, { 'retry-after': new Date(date.now() + 3 * HOUR).toUTCString() })
  await assert.rejects(date.get(), err => err.code === 'rateLimited' && /Try again in about 3 hours,/.test(err.message))
  await blocked(date, /Try again in about 3 hours,/)

  const reset = await limited(t)
  reset.answer(429, { 'x-rl-hourly-reset': nexusDate(reset.now() + 15 * MIN) })
  await assert.rejects(reset.get(), err => err.code === 'rateLimited')
  await blocked(reset, /Try again in 15 minutes,/)

  const bare = await limited(t)
  bare.answer(429, {})
  await assert.rejects(bare.get(), err => err.code === 'rateLimited')
  await blocked(bare, /Try again in 1 minute,/)
  bare.advance(MIN)
  bare.answer(200, {})
  assert.equal(await bare.get(), bare.link[0].URI)

  const huge = await limited(t)
  huge.answer(429, { 'retry-after': String(30 * 24 * 3600) })
  await assert.rejects(huge.get(), err => err.code === 'rateLimited' && /Try again in about 24 hours,/.test(err.message), 'never more than a day')
})

test('rate limit: a 429 whose Retry-After is 0 or already past, or whose reset is stale, uses the next time still ahead, else a minute', async t => {
  const past = await limited(t)
  past.answer(429, { 'retry-after': new Date(past.now() - HOUR).toUTCString() })
  await assert.rejects(past.get(), err => err.code === 'rateLimited' && /Try again in 1 minute,/.test(err.message), 'a past Retry-After date')
  await blocked(past, /Try again in 1 minute,/)
  past.advance(MIN)
  past.answer(200, {})
  assert.equal(await past.get(), past.link[0].URI, 'a minute later Nexus is asked again')

  const zero = await limited(t)
  zero.answer(429, { 'retry-after': '0' })
  await assert.rejects(zero.get(), err => err.code === 'rateLimited' && /Try again in 1 minute,/.test(err.message), 'Retry-After: 0')
  await blocked(zero, /Try again in 1 minute,/)

  const next = await limited(t)
  next.answer(429, { 'retry-after': '0', 'x-rl-hourly-reset': nexusDate(next.now() + 25 * MIN) })
  await assert.rejects(next.get(), err => err.code === 'rateLimited' && /Try again in 25 minutes,/.test(err.message), 'Retry-After: 0 falls through to the hourly reset')

  const stale = await limited(t)
  stale.answer(429, { 'x-rl-hourly-reset': nexusDate(stale.now() - 10 * MIN), 'x-rl-daily-reset': nexusDate(stale.now() + 2 * HOUR) })
  await assert.rejects(stale.get(), err => err.code === 'rateLimited' && /Try again in about 2 hours,/.test(err.message), 'a stale hourly reset falls through to the daily one')

  const allStale = await limited(t)
  allStale.answer(429, { 'retry-after': '0', 'x-rl-hourly-reset': nexusDate(allStale.now() - MIN), 'x-rl-daily-reset': nexusDate(allStale.now()) })
  await assert.rejects(allStale.get(), err => err.code === 'rateLimited' && /Try again in 1 minute,/.test(err.message), 'nothing ahead: a minute')
  await blocked(allStale, /Try again in 1 minute,/)
})

test('rate limit: the daily and hourly counts are read separately, and the block lasts until the later valid reset', async t => {
  const r = await limited(t)
  r.answer(200, { 'x-rl-daily-remaining': '0', 'x-rl-daily-reset': nexusDate(r.now() - MIN), 'x-rl-hourly-remaining': '0', 'x-rl-hourly-reset': nexusDate(r.now() + 30 * MIN) })
  await r.get()
  await blocked(r, /^Nexus's hourly limit on requests for your account is used up\. Try again in 30 minutes,/)

  const both = await limited(t)
  both.answer(200, { 'x-rl-daily-remaining': '0', 'x-rl-daily-reset': nexusDate(both.now() + 3 * HOUR), 'x-rl-hourly-remaining': '0', 'x-rl-hourly-reset': nexusDate(both.now() + 30 * MIN) })
  await both.get()
  await blocked(both, /^Nexus's daily limit on requests for your account is used up\. Try again in about 3 hours,/)

  const hourLater = await limited(t)
  hourLater.answer(200, { 'x-rl-daily-remaining': '0', 'x-rl-daily-reset': nexusDate(hourLater.now() + 10 * MIN), 'x-rl-hourly-remaining': '0', 'x-rl-hourly-reset': nexusDate(hourLater.now() + 40 * MIN) })
  await hourLater.get()
  await blocked(hourLater, /^Nexus's hourly limit on requests for your account is used up\. Try again in 40 minutes,/)
})

test('rate limit: the wait is worded in minutes up to an hour, then about so many hours, to the nearest hour', async t => {
  for (const [ms, words] of [[59 * MIN + 1, '60 minutes'], [60 * MIN, '60 minutes'], [89 * MIN, 'about 1 hour'], [91 * MIN, 'about 2 hours'], [5 * HOUR + 29 * MIN, 'about 5 hours'], [5 * HOUR + 31 * MIN, 'about 6 hours']]) {
    const r = await limited(t)
    r.answer(429, { 'retry-after': String(ms / 1000) })
    await assert.rejects(r.get(), err => err.code === 'rateLimited' && err.message.includes(`Try again in ${words}, or use the Nexus window.`), `${ms} ms: ${words}`)
  }
})

test('rate limit: headers on a refused answer count too, even when the renewed token then gets the link', async t => {
  const r = await limited(t)
  r.answers.length = 0
  r.answers.push({ status: 403, headers: { 'x-rl-hourly-remaining': '0', 'x-rl-hourly-reset': nexusDate(r.now() + 10 * MIN) } }, { status: 200, headers: {} })
  assert.equal(await r.get(), r.link[0].URI, 'the retry with a renewed token still goes')
  await blocked(r, /Try again in 10 minutes,/)
})

test('rate limit: logging out, or another Nexus account logging in, clears the block; the same account renewing keeps it', async t => {
  const r = await limited(t)
  r.answer(200, { 'x-rl-hourly-remaining': '0' })
  await r.get()
  await blocked(r)
  r.advance(2 * HOUR)
  r.answer(200, { 'x-rl-daily-remaining': '0' })
  await r.get()
  await blocked(r, /daily limit/)
  r.advance(2 * HOUR)
  const refreshes = r.s.refreshes
  await r.a.accessToken()                                           // the same account's token renewed while blocked
  assert.equal(r.s.refreshes, refreshes + 1)
  await blocked(r, /daily limit/)
  await r.a.logout()
  await r.a.login()
  r.answer(200, {})
  assert.equal(await r.get(), r.link[0].URI, 'logged out and in again: no block')
  r.answer(200, { 'x-rl-daily-remaining': '0' })
  await r.get()
  await blocked(r)
  r.s.tokens = { ...r.s.tokens, access_token: jwt({ id: 777, name: 'Hadvar' }) }
  await r.a.login()
  assert.equal(r.a.status().account.id, 777)
  r.answer(200, {})
  assert.equal(await r.get(), r.link[0].URI, 'another account: not the last one\'s limit')
})
