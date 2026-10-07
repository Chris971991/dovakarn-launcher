const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { namedHash, isNamedFile, MAX_ATTEMPTS, triedOut, nextAttempt, installUpdate, downloadUpdate } = require('../src/updateFile')

test('an update runs only when the server names its SHA-256 and the download is that very file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-update-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const installer = Buffer.from('the Dovakarn launcher installer')
  const hash = crypto.createHash('sha256').update(installer).digest('hex')
  for (const data of [{}, { sha256: '' }, { sha256: 'abc' }, { sha256: 'g'.repeat(64) }, null]) assert.equal(namedHash(data), null, JSON.stringify(data))
  assert.equal(namedHash({ sha256: hash.toUpperCase() }), hash)
  const good = path.join(dir, 'good.exe')
  fs.writeFileSync(good, installer)
  assert.equal(isNamedFile(good, hash), true)
  assert.equal(fs.existsSync(good), true)
  // Anything else a host or redirect hands over is refused and deleted
  const swapped = path.join(dir, 'swapped.exe')
  fs.writeFileSync(swapped, Buffer.from('something else entirely'))
  assert.equal(isNamedFile(swapped, hash), false)
  assert.equal(fs.existsSync(swapped), false)
})

test('the in-app update downloads the installer the server names over HTTPS, and runs it only if it is that very file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-install-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const installer = Buffer.from('the Dovakarn launcher installer, 2.1.2')
  const hash = crypto.createHash('sha256').update(installer).digest('hex')
  const url = 'https://dovakarn.com/download/DovakarnLauncher.exe'
  // served: what the download host hands over
  const flow = (version, served = installer) => {
    fs.rmSync(path.join(dir, 'update.exe'), { force: true })
    const seen = { downloads: [], runs: [], quits: 0, progress: [] }
    const run = installUpdate({
      fetchVersion: async () => version,
      download: async (from, dest, onProgress) => { seen.downloads.push(from); onProgress(served.length, served.length); fs.writeFileSync(dest, served) },
      run: file => seen.runs.push(file), quit: () => { seen.quits++ }, progress: p => seen.progress.push(p.phase), dest: path.join(dir, 'update.exe'),
    })
    return run.then(result => ({ result, ...seen }))
  }
  const good = await flow({ version: '2.1.2', downloadUrl: url, sha256: hash })
  assert.deepEqual([good.result, good.downloads, good.runs, good.quits], [{ ok: true }, [url], [path.join(dir, 'update.exe')], 1])
  assert.deepEqual(good.progress, ['download', 'download', 'install'])
  // A file that is not the one named is never run, and is deleted
  const swapped = await flow({ version: '2.1.2', downloadUrl: url, sha256: hash }, Buffer.from('something else'))
  assert.deepEqual([swapped.result.ok, swapped.runs, swapped.quits, fs.existsSync(path.join(dir, 'update.exe'))], [false, [], 0, false])
  assert.match(swapped.result.error, /not the file the Dovakarn server named/)
  // No hash named, no https, or no link: nothing is even downloaded
  for (const [version, error] of [
    [{ downloadUrl: url }, /did not say which update file to trust/],
    [{ downloadUrl: url, sha256: 'abc' }, /did not say which update file to trust/],
    [{ downloadUrl: 'http://example.com/DovakarnLauncher.exe', sha256: hash }, /non-HTTPS/],
    [{ downloadUrl: '' }, /No download URL/],
    [null, /No download URL/],
  ]) {
    const refused = await flow(version)
    assert.deepEqual([refused.result.ok, refused.downloads, refused.runs], [false, [], []], JSON.stringify(version))
    assert.match(refused.result.error, error)
  }
  // A download that fails says why
  const broken = await installUpdate({ fetchVersion: async () => ({ downloadUrl: url, sha256: hash }), download: async () => { throw new Error('Download timed out') }, run: () => { throw new Error('never') }, quit: () => {}, dest: path.join(dir, 'x.exe') })
  assert.deepEqual(broken, { ok: false, error: 'Download timed out' })
  // A file downloadUpdate already fetched and verified installs at once, with no second download
  fs.writeFileSync(path.join(dir, 'update.exe'), installer)
  const cachedSeen = { downloads: [], runs: 0, quits: 0, progress: [] }
  const cached = await installUpdate({ fetchVersion: async () => ({ version: '2.1.2', downloadUrl: url, sha256: hash }), download: async from => { cachedSeen.downloads.push(from) },
    run: () => cachedSeen.runs++, quit: () => cachedSeen.quits++, progress: p => cachedSeen.progress.push(p.phase), dest: path.join(dir, 'update.exe') })
  assert.deepEqual([cached.ok, cachedSeen.downloads, cachedSeen.runs, cachedSeen.quits, cachedSeen.progress], [true, [], 1, 1, ['install']], 'no second download for a verified file')
})

test('downloadUpdate fetches and verifies the named installer without running anything', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-prefetch-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const installer = Buffer.from('the launcher offered as 2.1.4'), hash = crypto.createHash('sha256').update(installer).digest('hex')
  const url = 'https://dovakarn.com/download/DovakarnLauncher.exe', dest = path.join(dir, 'update.exe')
  const seen = { downloads: 0 }
  const fetchWith = (served = installer) => downloadUpdate({ fetchVersion: async () => ({ version: '2.1.4', downloadUrl: url, sha256: hash }),
    download: async (_from, to) => { seen.downloads++; fs.writeFileSync(to, served) }, dest, current: '2.1.2' })
  assert.deepEqual(await fetchWith(), { ok: true, version: '2.1.4' })
  assert.equal(seen.downloads, 1)
  assert.deepEqual(await fetchWith(), { ok: true, version: '2.1.4' })
  assert.equal(seen.downloads, 1, 'already fetched and verified: not downloaded again')
  fs.rmSync(dest, { force: true })
  const swapped = await fetchWith(Buffer.from('something else'))
  assert.deepEqual([swapped.ok, fs.existsSync(dest)], [false, false], 'a wrong file is refused and deleted')
  assert.match(swapped.error, /not the file the Dovakarn server named/)
})

test('an update that did not change the launcher is tried again, up to three times from the same version, and never counted when the installer could not start', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-install-again-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const installer = Buffer.from('the launcher offered as 2.1.3'), hash = crypto.createHash('sha256').update(installer).digest('hex')
  const url = 'https://dovakarn.com/download/DovakarnLauncher.exe', data = { version: '2.1.3', downloadUrl: url, sha256: hash }
  assert.equal(MAX_ATTEMPTS, 3)
  // What is recorded as an installer starts: the first try from this version, then one more each time
  assert.deepEqual(nextAttempt(data, null, '2.1.2'), { sha256: hash, fromVersion: '2.1.2', attempts: 1 })
  assert.deepEqual(nextAttempt(data, { sha256: hash, fromVersion: '2.1.2', attempts: 1 }, '2.1.2'), { sha256: hash, fromVersion: '2.1.2', attempts: 2 })
  assert.deepEqual(nextAttempt(data, { sha256: hash, fromVersion: '2.1.1', attempts: 5 }, '2.1.2'), { sha256: hash, fromVersion: '2.1.2', attempts: 1 }, 'another version: counted afresh')
  assert.deepEqual(nextAttempt({ ...data, sha256: hash.toUpperCase() }, { sha256: hash, fromVersion: '2.1.2', attempts: 1 }, '2.1.2').attempts, 2, 'the same file however its hash is written')
  for (const [attempt, out] of [[null, false], [{ sha256: hash, fromVersion: '2.1.2', attempts: 2 }, false], [{ sha256: hash, fromVersion: '2.1.2', attempts: 3 }, true], [{ sha256: 'b'.repeat(64), fromVersion: '2.1.2', attempts: 9 }, false], [{ sha256: hash, fromVersion: '2.1.1', attempts: 9 }, false]]) {
    assert.equal(triedOut(data, attempt, '2.1.2'), out, JSON.stringify(attempt))
  }
  // Recorded only once the installer started, after the check that it is the very file named
  const order = [], remembered = []
  const flow = (attempt, run = () => order.push('run')) => installUpdate({
    fetchVersion: async () => data, download: async (from, dest) => { order.push('download'); fs.writeFileSync(dest, installer) },
    run, quit: () => order.push('quit'), remember: a => { order.push('remember'); remembered.push(a) }, dest: path.join(dir, 'update.exe'), current: '2.1.2', attempt,
  })
  assert.deepEqual(await flow(null), { ok: true })
  assert.deepEqual(order, ['download', 'run', 'remember', 'quit'])
  assert.deepEqual(remembered.at(-1), { sha256: hash, fromVersion: '2.1.2', attempts: 1 })
  // An installer that could not start (antivirus took the file): nothing recorded, so it is simply tried again
  order.length = 0
  const failed = await flow(null, () => { throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) })
  assert.deepEqual([failed.ok, order], [false, []], 'the verified file from the first try is reused, not downloaded again')
  // Tried three times from this very version: not installed again, and the player is told what to do
  order.length = 0
  const out = await flow({ sha256: hash, fromVersion: '2.1.2', attempts: 3 })
  assert.equal(out.ok, false); assert.equal(out.error, 'This update was tried 3 times and the launcher is still version 2.1.2. Download the launcher from the Dovakarn Discord instead, and tell the staff the update did not work.')
  assert.deepEqual(order, [])
})

test('a stopped launcher download says it was stopped, so the page does not call it a failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-stopped-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const hash = 'a'.repeat(64), dest = path.join(dir, 'update.exe'), url = 'https://dovakarn.com/download/DovakarnLauncher.exe'
  const stop = async () => { throw Object.assign(new Error('Download stopped.'), { code: 'CANCELLED' }) }
  const fetchVersion = async () => ({ version: '2.1.4', downloadUrl: url, sha256: hash })
  assert.deepEqual(await downloadUpdate({ fetchVersion, download: stop, dest, current: '2.1.2' }), { ok: false, error: 'Download stopped.', cancelled: true })
  let ran = 0
  assert.deepEqual(await installUpdate({ fetchVersion, download: stop, run: () => { ran++ }, quit: () => {}, dest, current: '2.1.2' }), { ok: false, error: 'Download stopped.', cancelled: true })
  assert.equal(ran, 0)
  const broken = await downloadUpdate({ fetchVersion, download: async () => { throw new Error('HTTP 503') }, dest, current: '2.1.2' })
  assert.deepEqual(broken, { ok: false, error: 'HTTP 503' }, 'a real failure is not called stopped')
})
