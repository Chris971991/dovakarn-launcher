const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createGameLogin } = require('../src/gameLogin')

const session = n => ({ session: String(n).repeat(64), masterApiId: n })
const read = file => fs.readFileSync(file, 'utf8')

// Two Skyrim folders, a clock and interval timers the test drives by hand, and a game that runs when told
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-game-login-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dirs = { a: path.join(root, 'Skyrim A'), b: path.join(root, 'Skyrim B') }
  let dir = dirs.a, clock = 0, running = false
  const intervals = new Map()
  let nextId = 1
  const timers = {
    setInterval: fn => { const id = nextId++; intervals.set(id, fn); return id },
    clearInterval: id => { intervals.delete(id) },
  }
  const logs = []
  const login = createGameLogin({ fs, gameDir: () => dir, gameRunning: () => (typeof running === 'function' ? running() : running), log: m => logs.push(m), timers, now: () => clock })
  return {
    login, dirs, logs, intervals,
    useDir: d => { dir = d },
    at: ms => { clock = ms },
    gameIs: value => { running = value },
    tick: () => Promise.all([...intervals.values()].map(fn => fn())),
    file: d => login.fileIn(d),
  }
}

test('a written login is cleared from every folder it went to, even after the Skyrim folder changed', async t => {
  const s = setup(t)
  s.login.write(s.file(s.dirs.a), session(1))
  assert.equal(read(s.file(s.dirs.a)), '//' + JSON.stringify(session(1)))
  s.useDir(s.dirs.b)
  s.login.write(s.file(s.dirs.b), null)
  assert.equal(read(s.file(s.dirs.b)), '//null', 'a launch without Discord writes no session')
  s.login.clear()
  assert.equal(read(s.file(s.dirs.a)), '//null', 'the old folder is cleared too')
  assert.equal(read(s.file(s.dirs.b)), '//null')
})

test('the login is cleared once Skyrim has run and closed, or when it never starts within a minute', async t => {
  const s = setup(t)
  s.login.write(s.file(s.dirs.a), session(1))
  s.login.clearWhenGameCloses()
  s.gameIs(true); s.at(5000); await s.tick()
  s.at(10 * 60 * 1000); await s.tick()
  assert.match(read(s.file(s.dirs.a)), /1{64}/, 'kept while Skyrim runs')
  // One check that misses it (tasklist failing or slow while it loads) is not a close
  s.gameIs(false); await s.tick()
  assert.match(read(s.file(s.dirs.a)), /1{64}/, 'one miss is not a close')
  s.gameIs(true); await s.tick()
  s.gameIs(false); await s.tick()
  assert.match(read(s.file(s.dirs.a)), /1{64}/, 'the count starts again after it is seen')
  await s.tick()
  assert.equal(read(s.file(s.dirs.a)), '//null', 'cleared once two checks in a row say it closed')
  assert.equal(s.intervals.size, 0, 'and the watch stops')

  const never = setup(t)
  never.login.write(never.file(never.dirs.a), session(2))
  never.login.clearWhenGameCloses()
  never.at(30 * 1000); await never.tick()
  assert.match(read(never.file(never.dirs.a)), /2{64}/, 'Skyrim may still be starting')
  never.at(61 * 1000); await never.tick()
  assert.equal(read(never.file(never.dirs.a)), '//null', 'it never started: the session goes')
})

test('an earlier launch\'s watch never clears the session a newer launch wrote', async t => {
  const s = setup(t)
  s.login.write(s.file(s.dirs.a), session(1))
  s.login.clearWhenGameCloses()
  // Launch 1's Skyrim never shows up; its watch is checking (tasklist is slow) when launch 2 starts
  let answer
  s.gameIs(() => new Promise(resolve => { answer = resolve }))
  s.at(61 * 1000)
  const inFlight = s.tick()
  s.login.stopWatch()
  s.login.write(s.file(s.dirs.a), session(2))
  s.gameIs(false)
  s.login.clearWhenGameCloses()
  answer(false); await inFlight
  assert.match(read(s.file(s.dirs.a)), /2{64}/, 'launch 2\'s session survives the old check')
  assert.equal(s.intervals.size, 1, 'launch 2\'s own watch is still running')
})

test('a failing process check changes nothing and throws nothing', async t => {
  const s = setup(t)
  s.login.write(s.file(s.dirs.a), session(1))
  s.login.clearWhenGameCloses()
  s.gameIs(() => Promise.reject(Error('tasklist failed')))
  s.at(61 * 1000); await s.tick()
  assert.match(read(s.file(s.dirs.a)), /1{64}/)
})

test('a login file that cannot be cleared is logged and tried again next time', async t => {
  const s = setup(t)
  const file = s.file(s.dirs.a)
  s.login.write(file, session(1))
  s.useDir(null)
  fs.chmodSync(file, 0o444)
  const locked = process.platform === 'win32' ? (() => { try { fs.writeFileSync(file, 'x'); return false } catch { return true } })() : true
  if (!locked) { fs.chmodSync(file, 0o666); t.skip('this file system ignores read-only files'); return }
  s.login.clear()
  assert.match(s.logs.at(-1), /could not clear the game login/)
  fs.chmodSync(file, 0o666)
  s.login.clear()
  assert.equal(read(file), '//null', 'remembered and cleared on the next try')
})

test('a session goes only into a file already limited to this Windows user; a cleared one needs no limit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-game-login-acl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js')
  const seen = []
  const login = createGameLogin({ fs, gameDir: () => root, gameRunning: () => false, restrict: f => seen.push([f, fs.readFileSync(f, 'utf8')]) })
  login.write(file, session(3))
  assert.deepEqual(seen, [[file, '//null']], 'limited while it still held nothing')
  assert.equal(read(file), '//' + JSON.stringify(session(3)))
  seen.length = 0
  login.write(file, null)
  assert.deepEqual(seen, [])
})

test('the login file is made afresh before it is limited: one left there before keeps no permissions of its own', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-game-login-fresh-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js')
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '//"left by someone else"')
  const steps = []
  const spy = { ...fs, rmSync: (f, o) => { steps.push(['remove', path.basename(f)]); return fs.rmSync(f, o) }, writeFileSync: (f, d, o) => { steps.push(['write', String(d).slice(0, 8), o?.flag || 'w']); return fs.writeFileSync(f, d, o) } }
  const login = createGameLogin({ fs: spy, gameDir: () => root, gameRunning: () => false, restrict: () => steps.push(['limit']) })
  login.write(file, session(4))
  // The new file is made only if nothing is there (wx): never one someone else made meanwhile
  assert.deepEqual(steps, [['remove', 'auth-data-no-load.js'], ['write', '//null', 'wx'], ['limit'], ['write', '//{"sess', 'w']])
  // Another user making it again between the removal and the new one: not reused, and no session goes into it
  const raced = createGameLogin({ fs: { ...fs, rmSync: (f, o) => { fs.rmSync(f, o); fs.writeFileSync(f, '//made by someone else') } }, gameDir: () => root, gameRunning: () => false, restrict: () => {} })
  assert.throws(() => raced.write(file, session(6)), e => e.code === 'EEXIST' && e.message === `The game's login file could not be replaced: ${file}. Delete it, then press Play again.`)
  assert.equal(read(file), '//made by someone else')
  // One that cannot be removed (another user's, in a folder this one cannot change) gets no session, and says what to do
  const said = []
  const stuck = createGameLogin({ fs: { ...fs, rmSync: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) } }, gameDir: () => root, gameRunning: () => false, restrict: () => {}, log: line => said.push(line) })
  assert.throws(() => stuck.write(file, session(5)), e => e.code === 'EPERM' && e.message === `The game's login file could not be replaced: ${file}. Delete it, then press Play again.`)
  assert.ok(!read(file).includes('5'.repeat(64)))
  assert.deepEqual(said, [`[launch] the game's login file ${file} could not be replaced: EPERM`], 'the code goes to the log, not to the player')
})

test('the login file is limited to this Windows user: no inherited permissions, full control for them; elsewhere, owner-only', () => {
  const { restrictToUser } = require('../src/gameLogin')
  const runs = [], logs = []
  restrictToUser('C:\\Games\\auth.js', { platform: 'win32', env: { USERDOMAIN: 'DESKTOP-EXAMPLE', USERNAME: 'Player' }, execFileSync: (cmd, args) => runs.push([cmd, ...args]), log: m => logs.push(m) })
  assert.deepEqual(runs, [['icacls', 'C:\\Games\\auth.js', '/inheritance:r', '/grant:r', 'DESKTOP-EXAMPLE' + String.fromCharCode(92) + 'Player:F']])
  restrictToUser('C:\\Games\\auth.js', { platform: 'win32', env: {}, username: () => 'player', execFileSync: (cmd, args) => runs.push([cmd, ...args]) })
  assert.equal(runs[1].at(-1), 'player:F', 'without a domain, the account name alone')
  // icacls failing is logged, and Play goes on (the session is bound to the player's network and ends unused)
  restrictToUser('C:\\Games\\auth.js', { platform: 'win32', env: { USERDOMAIN: 'D', USERNAME: 'U' }, execFileSync: () => { throw new Error('icacls exited 5') }, log: m => logs.push(m) })
  assert.deepEqual(logs, ['[launch] could not limit the game login file to this Windows user: icacls exited 5'])
  const modes = []
  restrictToUser('/games/auth.js', { platform: 'linux', chmodSync: (f, mode) => modes.push([f, mode]), execFileSync: () => { throw new Error('never on Linux') } })
  assert.deepEqual(modes, [['/games/auth.js', 0o600]])
})
