const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { normalizeVersion, isExactVersionMatch, readSkyrimExeVersion, VERSION_COMMAND } = require('../src/skyrimVersion')

test('the exe version is read without freezing the launcher while PowerShell starts', { skip: process.platform !== 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-version-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(await readSkyrimExeVersion(dir), null, 'No SkyrimSE.exe, no version')
  assert.equal(await readSkyrimExeVersion(''), null)
  // Any Windows exe carries a version resource; where.exe is small and always present.
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), path.join(dir, 'SkyrimSE.exe'))
  let last = performance.now(), worst = 0
  const beat = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now }, 5)
  const reading = readSkyrimExeVersion(dir)
  assert.ok(reading instanceof Promise, 'The caller gets a promise back at once')
  const version = await reading
  // A read that blocked would also end before the timer could tick again, so the last gap counts too.
  worst = Math.max(worst, performance.now() - last)
  clearInterval(beat)
  assert.match(version, /^\d+\.\d+\.\d+/)
  assert.ok(worst < 150, `The event loop kept running while PowerShell worked (longest gap ${Math.round(worst)} ms)`)
})

test('a folder name with an apostrophe or PowerShell syntax is read as a path, never run as a command', { skip: process.platform !== 'win32' }, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-version-quote-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  // An apostrophe, and text that would make a file in the working folder if it were ever run as PowerShell
  const name = `dov-ran-${process.pid}.txt`, marker = path.join(process.cwd(), name)
  t.after(() => fs.rmSync(marker, { force: true }))
  const dir = path.join(parent, `Player's Skyrim'; New-Item ${name}; '`)
  fs.mkdirSync(dir)
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), path.join(dir, 'SkyrimSE.exe'))
  assert.match(await readSkyrimExeVersion(dir), /^\d+\.\d+\.\d+/)
  assert.equal(fs.existsSync(marker), false, 'nothing in the folder name ran')
  assert.ok(!VERSION_COMMAND.includes('Skyrim'), 'the path is never part of the command')
})

test('normalizeVersion strips Windows punctuation and normalizes to dot format', () => {
  assert.equal(normalizeVersion('1,5,97,0,8'), '1.5.97.0.8')
  assert.equal(normalizeVersion('1.5.97.0.8'), '1.5.97.0.8')
  assert.equal(normalizeVersion(' v1.6.1170.0 '), '1.6.1170.0')
})

test('isExactVersionMatch requires an exact match, not just same major series', () => {
  assert.equal(isExactVersionMatch('1.6.1170.0', '1.6.1170.0'), true)
  assert.equal(isExactVersionMatch('1.6.1170.1', '1.6.1170.0'), false)
  assert.equal(isExactVersionMatch('1.6.1170.0', '1.6.640.0'), false)
})
