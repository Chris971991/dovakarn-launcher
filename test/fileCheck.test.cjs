// 'dovahzul' in these fixtures is the server's name for Dovakarn's own files in its player file list.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { getEventListeners } = require('node:events')
const crypto = require('node:crypto')
const { checkGameFiles, checkBeforeLaunch, describeFiles, describeFileList, readFileList, filesView, checkSummary, resolveInside } = require('../src/fileCheck')

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const COLLECTION = 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef'

// A loopback game server serving a file list and Dovakarn files by hash.
async function server(t, { manifest, store = {}, corrupt = new Set() }) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/list.json') { if (!manifest) { res.statusCode = 404; return res.end() } return res.end(JSON.stringify(manifest)) }
    const hash = req.url.replace('/files/', '')
    if (!store[hash]) { res.statusCode = 404; return res.end() }
    res.end(corrupt.has(hash) ? Buffer.from('tampered!') : store[hash])
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.address().port}`
  return { manifestUrl: `${base}/list.json`, filesUrl: `${base}/files` }
}

// A loopback stand-in for Nexus's GraphQL API, so tests never touch the internet.
async function nexus(t, reply, seen = []) {
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c }); req.on('end', () => { seen.push({ method: req.method, headers: req.headers, body: JSON.parse(body || 'null') }); res.end(JSON.stringify(typeof reply === 'function' ? reply() : reply)) })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => srv.close())
  return `http://127.0.0.1:${srv.address().port}/graphql`
}
const nexusCollection = (mods, revision = 2) => ({ data: { collection: { name: 'Example Collection', latestPublishedRevision: { revisionNumber: revision,
  modFiles: mods.map(([modId, date, name = `Mod ${modId}`, optional = false]) => ({ optional, fileId: modId * 10, file: { name, version: '1.0', date, mod: { modId, name } } })) } } } })

function game(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-filecheck-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
  return { dir, put, read: rel => fs.readFileSync(path.join(dir, rel), 'utf8'), cache: path.join(dir, 'cache.json') }
}

const entry = (p, text, extra) => ({ path: p, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)), critical: /\.(esp|esm|esl|dll)$/i.test(p), ...extra })

test('outdated Dovakarn files are installed and mod problems are grouped by mod', async t => {
  const g = game(t)
  const client = 'new client v2', platform = 'platform dll v2', master = 'skyrim master', plugin = 'hud plugin', bsa = 'texture archive'
  g.put('Data/Platform/Plugins/skymp5-client.js', 'old client v1')
  g.put('Data/Skyrim.esm', master)
  g.put('Data/Textures.bsa', 'different archive')
  const files = [
    entry('Data/Platform/Plugins/skymp5-client.js', client, { kind: 'dovahzul' }),
    entry('Data/SKSE/Plugins/SkyrimPlatform.dll', platform, { kind: 'dovahzul' }),
    entry('Data/Skyrim.esm', master, { kind: 'base' }),
    entry('Data/TrueHUD.esp', plugin, { kind: 'mod', mod: 'TrueHUD', nexusId: 62775 }),
    entry('Data/Textures.bsa', bsa, { kind: 'mod', mod: 'Pretty Textures' }),
  ]
  const urls = await server(t, { manifest: { schema: 1, revision: 'r1', collection: { name: 'Dovakarn', url: COLLECTION }, files },
    store: { [sha(Buffer.from(client))]: Buffer.from(client), [sha(Buffer.from(platform))]: Buffer.from(platform) } })
  const steps = [], nexusApi = await nexus(t, nexusCollection([]))
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, onProgress: s => steps.push(s), nexusApi })
  assert.deepEqual(result.updated.sort(), ['Data/Platform/Plugins/skymp5-client.js', 'Data/SKSE/Plugins/SkyrimPlatform.dll'])
  assert.equal(g.read('Data/Platform/Plugins/skymp5-client.js'), client)
  assert.equal(g.read('Data/SKSE/Plugins/SkyrimPlatform.dll'), platform)
  assert.deepEqual(result.base, [])
  assert.deepEqual(result.mods.map(m => [m.name, m.missing.length, m.changed.length, m.critical]), [['TrueHUD', 1, 0, true], ['Pretty Textures', 0, 1, false]])
  assert.equal(result.mods[0].nexusId, 62775)
  assert.equal(result.blocked, true)
  assert.deepEqual(result.warnings.map(m => m.name), ['Pretty Textures'])
  assert.equal(result.collection.url, COLLECTION)
  assert.equal(result.checked, 5)
  // Stages in order, each file announced as it starts, and the bar's bytes reach the whole download
  assert.deepEqual(steps.map(s => s.stage).filter((stage, i, all) => stage !== all[i - 1]), ['checking', 'updating', 'collection'])
  assert.deepEqual([steps[0].done, steps[0].total, steps[0].received, steps[0].bytes], [0, 5, 0, files.reduce((n, f) => n + f.size, 0)])
  const updating = steps.filter(s => s.stage === 'updating'), bytes = client.length + platform.length
  assert.deepEqual([...new Set(updating.map(s => s.done + ' of ' + s.total))], ['1 of 2', '2 of 2'])
  assert.ok(updating.every((s, i) => s.bytes === bytes && s.received <= bytes && (i === 0 || s.received >= updating[i - 1].received)), 'bytes only grow')
  assert.equal(updating.at(-1).received, bytes)
  assert.match(describeFiles(result), /^1 mod is missing or out of date\. Install or reinstall the Dovakarn collection with Vortex/)
  assert.equal(result.gameCopy, false, 'the player\'s own Skyrim, checked with its collection')
  assert.equal(fs.readdirSync(path.join(g.dir, 'Data/Platform/Plugins')).some(n => n.endsWith('.dovakarn-part')), false)

  g.put('Data/TrueHUD.esp', plugin)
  const second = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, nexusApi })
  assert.deepEqual(second.updated, [], 'Installed files are not downloaded again')
  assert.equal(second.blocked, false)
  assert.match(describeFiles(second), /1 mod has files that differ from the server\. You can still play/)
})

test('a corrupted download never replaces the installed file', async t => {
  const g = game(t), good = 'client v2'
  g.put('Data/Platform/Plugins/skymp5-client.js', 'client v1')
  const e = entry('Data/Platform/Plugins/skymp5-client.js', good, { kind: 'dovahzul' })
  const urls = await server(t, { manifest: { schema: 1, files: [e] }, store: { [e.sha256]: Buffer.from(good) }, corrupt: new Set([e.sha256]) })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache }), /Could not update Data\/Platform\/Plugins\/skymp5-client\.js/)
  assert.equal(g.read('Data/Platform/Plugins/skymp5-client.js'), 'client v1')
  assert.equal(fs.existsSync(path.join(g.dir, 'Data/Platform/Plugins/skymp5-client.js.dovakarn-part')), false)
})

test('a download larger than listed is stopped and cleaned up', async t => {
  const g = game(t), listed = 'client v2'
  g.put('Data/Platform/Plugins/skymp5-client.js', 'client v1')
  const e = entry('Data/Platform/Plugins/skymp5-client.js', listed, { kind: 'dovahzul' })
  const urls = await server(t, { manifest: { schema: 1, files: [e] }, store: { [e.sha256]: Buffer.alloc(1 << 20, 7) } })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache }), /larger than the server said/)
  assert.equal(g.read('Data/Platform/Plugins/skymp5-client.js'), 'client v1')
  assert.equal(fs.existsSync(path.join(g.dir, 'Data/Platform/Plugins/skymp5-client.js.dovakarn-part')), false)
})

test('a player\'s own settings file is never replaced, even if a server lists it', async t => {
  const g = game(t), mine = '{"gameData":{"profileId":2}}', servers = '{"gameData":{"profileId":1}}'
  g.put('Data/Platform/Plugins/skymp5-client-settings.txt', mine)
  const e = entry('Data/Platform/Plugins/skymp5-client-settings.txt', servers, { kind: 'dovahzul' })
  const urls = await server(t, { manifest: { schema: 1, files: [e] }, store: { [e.sha256]: Buffer.from(servers) } })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual(result.updated, [])
  assert.equal(result.checked, 0, 'Skipped settings files are not counted as checked')
  assert.equal(g.read('Data/Platform/Plugins/skymp5-client-settings.txt'), mine)
})

test('a file list is summarised for launchers: version, one row per mod and only safe links', t => {
  const g = game(t), commit = 'abc1234567890abcdef1234567890abcdef12345'
  const manifest = { schema: 1, generatedAt: '2026-01-15T10:05:00.000Z', revision: 'r1', collection: { name: 'Dovakarn', url: COLLECTION },
    version: { commit, date: '2026-01-15T10:00:00Z', modified: true },
    files: [
      entry('Data/Platform/Plugins/skymp5-client.js', 'client', { kind: 'dovahzul' }),
      entry('Data/Skyrim.esm', 'master', { kind: 'base' }),
      entry('Data/SkyUI_SE.esp', 'ui', { kind: 'mod', mod: 'SkyUI', nexusId: 12604 }),
      entry('Data/SkyUI_SE.bsa', 'ui archive', { kind: 'mod', mod: 'SkyUI', nexusId: 12604 }),
      entry('Data/Textures.bsa', 'textures', { kind: 'mod', mod: 'Pretty Textures', url: 'javascript:alert(1)', nexusId: -4 }),
      entry('skse64_loader.exe', 'loader', { kind: 'mod', mod: 'Skyrim Script Extender (SKSE64)', url: 'https://skse.silverlock.org/' }),
      { ...entry('Data/KCF.esm', 'kcf adapted', { kind: 'patch', mod: 'KCF' }), from: { path: 'Data/KCF.esm', size: 3, sha256: sha('kcf') }, steps: [{ op: 'clearFlags', mask: 0x200 }] },
    ] }
  const file = path.join(g.dir, 'list.json')
  fs.writeFileSync(file, JSON.stringify(manifest))
  const view = describeFileList(readFileList(file))
  assert.deepEqual(view.version, { label: 'Development build', tag: '', ahead: 0, commit: 'abc12345', date: '2026-01-15T10:00:00Z', modified: true }, 'No release tag yet')
  const tagged = (tag, ahead) => { fs.writeFileSync(file, JSON.stringify({ ...manifest, version: { ...manifest.version, tag, ahead } })); return describeFileList(readFileList(file)).version }
  assert.deepEqual(tagged('v0.1.0', 0), { label: 'v0.1.0', tag: 'v0.1.0', ahead: 0, commit: 'abc12345', date: '2026-01-15T10:00:00Z', modified: true }, 'A release shows its tag')
  assert.deepEqual([tagged('v0.1.0', 3).label, tagged('v1.2.3-beta.1', 1).label], ['v0.1.0 +3', 'v1.2.3-beta.1 +1'], 'Changes after a release are counted')
  for (const [tag, ahead] of [['<img src=x>', 0], ['0.1.0', 0], ['v1.0.0-' + 'x'.repeat(40), 0], ['v' + '1.'.repeat(30) + '1', 0], [7, 0], ['v0.1.0', -2], ['v0.1.0', 1.5], ['v0.1.0', '3']]) {
    const v = tagged(tag, ahead)
    assert.equal(v.label, typeof tag === 'string' && tag.startsWith('v0.1.0') ? 'v0.1.0' : 'Development build', `A bad tag or count is dropped: ${JSON.stringify([tag, ahead])}`)
  }
  assert.deepEqual([view.generatedAt, view.files, view.served, view.base], ['2026-01-15T10:05:00.000Z', 7, 1, 1])
  assert.deepEqual(view.mods.map(m => [m.name, m.files, m.critical]), [['KCF', 1, true], ['SkyUI', 2, true], ['Pretty Textures', 1, false], ['Skyrim Script Extender (SKSE64)', 1, false]],
    'Mods the launcher blocks on come first; files of one mod are one row')
  const byName = Object.fromEntries(view.mods.map(m => [m.name, m]))
  assert.equal(byName.SkyUI.nexusId, 12604)
  assert.deepEqual([byName['Pretty Textures'].url, byName['Pretty Textures'].nexusId], ['', null], 'Only https links and real Nexus ids reach the page')
  assert.equal(byName['Skyrim Script Extender (SKSE64)'].url, 'https://skse.silverlock.org/')
  assert.equal(view.collection.url, COLLECTION)
  for (const version of [{ commit: 'abc12345', date: manifest.version.date }, { commit, date: 'yesterday' }, 'abc12345', null]) {
    fs.writeFileSync(file, JSON.stringify({ ...manifest, version, generatedAt: 'soon' }))
    const bad = describeFileList(readFileList(file))
    assert.deepEqual([bad.version, bad.generatedAt], [null, ''], `A malformed version is not shown: ${JSON.stringify(version)}`)
  }
  assert.equal(readFileList(path.join(g.dir, 'missing.json')), null)
  fs.writeFileSync(file, '{ not json'); assert.equal(readFileList(file), null)
  fs.writeFileSync(file, JSON.stringify({ schema: 1, files: [{ path: 'Data/x.esp', kind: 'mod' }] }))
  assert.throws(() => readFileList(file), /invalid entry/)
})

test('launcher pages get names and counts only, and a summary of the last check', () => {
  const result = { revision: 'r1', collection: { name: 'Dovakarn', url: COLLECTION }, checked: 219, updated: ['Data/a.js', 'Data/b.js'], patched: ['Data/KCF.esm'],
    base: [{ path: 'Data/Skyrim.esm', state: 'changed' }],
    mods: [{ name: 'TrueHUD', nexusId: 62775, missing: ['Data/TrueHUD.esp'], changed: [], critical: true }], blocked: true, warnings: [] }
  const view = filesView(result)
  assert.deepEqual(view, { blocked: true, collection: true, collectionName: 'Dovakarn', collectionCheck: null, mods: [
    { name: 'Skyrim base game', missing: 0, changed: 1, critical: true }, { name: 'TrueHUD', missing: 1, changed: 0, critical: true, nexusId: 62775 }] })
  assert.equal(JSON.stringify(view).includes('Data/'), false, 'File paths stay in the main process')
  for (const nexusId of [null, 0, -3, 1.5, '62775']) {
    assert.equal('nexusId' in filesView({ ...result, mods: [{ ...result.mods[0], nexusId }] }).mods[1], false, `Only a whole positive Nexus id is passed on: ${nexusId}`)
  }
  assert.deepEqual(checkSummary(result, 5), { at: 5, published: true, checked: 219, updated: 2, patched: 1, moved: 0, keysWritten: 0, problems: 2, blocked: true, collection: null })
  assert.deepEqual((({ moved, keysWritten }) => [moved, keysWritten])(checkSummary({ ...result, moved: ['Data/x.ini', 'Data/y.ini'], keysWritten: ['Data/MCM/Settings/a.ini'] }, 5)), [2, 1])
  assert.deepEqual(checkSummary(null, 6), { at: 6, published: false })
  const withCollection = { ...result, collectionCheck: { revision: 2, total: 53, missing: [{ modId: 1, name: 'A' }], outdated: [] } }
  assert.deepEqual(checkSummary(withCollection, 7).collection, { revision: 2, total: 53, missing: 1, outdated: 0 })
  assert.deepEqual(checkSummary({ ...result, collectionCheck: { error: 'Could not reach Nexus' } }, 8).collection, { error: 'Could not reach Nexus' })
})

test('base game mismatches block with their own message', async t => {
  const g = game(t)
  g.put('Data/Skyrim.esm', 'edited master')
  const urls = await server(t, { manifest: { schema: 1, files: [entry('Data/Skyrim.esm', 'real master', { kind: 'base' })] } })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual(result.base, [{ path: 'Data/Skyrim.esm', state: 'changed' }])
  assert.equal(result.blocked, true)
  assert.match(describeFiles(result), /base game files do not match/)
})

test('for Dovakarn\'s own copy the check names Verify, never Vortex', async t => {
  const g = game(t)
  const urls = await server(t, { manifest: { schema: 1, revision: 'r1', collection: { name: 'Dovakarn', url: COLLECTION }, files: [entry('Data/TrueHUD.esp', 'hud plugin', { kind: 'mod', mod: 'TrueHUD', nexusId: 62775 })] } })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, collection: false })
  assert.equal(result.gameCopy, true)
  assert.equal(result.blocked, true)
  assert.match(describeFiles(result), /^1 mod is missing or out of date\. Press Verify to put them back\.$/)
  const b = game(t)
  b.put('Data/Skyrim.esm', 'edited master')
  const base = await server(t, { manifest: { schema: 1, files: [entry('Data/Skyrim.esm', 'real master', { kind: 'base' })] } })
  const changed = await checkGameFiles({ gameDir: b.dir, ...base, cacheFile: b.cache, collection: false })
  assert.equal(describeFiles(changed), "Some of Skyrim's own files in Dovakarn's game do not match the server. Press Verify to repair Dovakarn's game.")
})

test('online launches refuse MO2 when the server publishes a list and gate on mod problems', async t => {
  const g = game(t), text = 'archive'
  // checkBeforeLaunch asks for <baseUrl>/manifest, like the backend route.
  const routed = async manifest => {
    const srv = http.createServer((req, res) => { if (req.url === '/manifest') { if (!manifest) { res.statusCode = 404; return res.end() } return res.end(JSON.stringify(manifest)) } res.statusCode = 404; res.end() })
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve)); t.after(() => srv.close())
    return `http://127.0.0.1:${srv.address().port}`
  }
  const list = { schema: 1, revision: 'r9', collection: { url: COLLECTION }, files: [entry('Data/Textures.bsa', text, { kind: 'mod', mod: 'Pretty Textures' })] }
  const withList = await routed(list), noList = await routed(null), nexusApi = await nexus(t, nexusCollection([]))
  const refused = await checkBeforeLaunch({ baseUrl: withList, gameDir: g.dir, cacheFile: g.cache, viaMO2: true, nexusApi })
  assert.equal(refused.success, false)
  assert.match(refused.error, /Untick Mod Organizer 2 in Settings/)
  assert.deepEqual(await checkBeforeLaunch({ baseUrl: noList, gameDir: g.dir, cacheFile: g.cache, viaMO2: true, nexusApi }), { success: true, files: null }, 'Servers without a list keep MO2')
  let accepted
  const first = await checkBeforeLaunch({ baseUrl: withList, gameDir: g.dir, cacheFile: g.cache, accepted, accept: key => { accepted = key }, nexusApi })
  assert.equal(first.success, false)
  assert.match(first.error, /Press PLAY again to play anyway/)
  assert.equal(first.collectionUrl, COLLECTION)
  assert.equal((await checkBeforeLaunch({ baseUrl: withList, gameDir: g.dir, cacheFile: g.cache, accepted, accept: () => assert.fail('already accepted'), nexusApi })).success, true)
  list.files[0].critical = true
  const blocked = await checkBeforeLaunch({ baseUrl: withList, gameDir: g.dir, cacheFile: g.cache, accepted, accept: () => {}, nexusApi })
  assert.deepEqual([blocked.success, blocked.collectionUrl], [false, COLLECTION], 'Blocking problems cannot be accepted')
})

test('mods are always checked in Data, and servers without a list are allowed', async t => {
  const g = game(t)
  const urls = await server(t, { manifest: { schema: 1, files: [entry('Data/SkyUI_SE.esp', 'plugin', { kind: 'mod', mod: 'SkyUI' })] } })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.equal(result.blocked, true, 'A mod installed anywhere but Data counts as missing')
  assert.deepEqual(result.mods.map(m => m.name), ['SkyUI'])
  const none = await server(t, { manifest: null })
  assert.equal(await checkGameFiles({ gameDir: g.dir, ...none, cacheFile: g.cache }), null)
  assert.equal(describeFiles(null), '')
})

// Patches rebuild adapted files from the player's own copy of a mod, as staging did on the server.
const plugin = (flags, text) => { const b = Buffer.alloc(24 + text.length); b.write('TES4', 0, 'ascii'); b.writeUInt32LE(flags, 8); b.write(text, 24, 'ascii'); return b }
const { applySteps } = require('../src/fileSteps')
const patchEntry = (target, original, steps, extra) => {
  const out = applySteps(original, steps)
  return { path: target, size: out.length, sha256: sha(out), kind: 'patch', critical: true, steps, ...extra }
}

test('a flag-cleared plugin and an ESL-to-ESP rename are made from the player\'s originals', async t => {
  const g = game(t), rename = { op: 'replace', find: 'TrueHUD.esl', replace: 'TrueHUD.esp' }
  const kcf = plugin(0x201, 'kcf'), hud = plugin(0x201, 'hud TrueHUD.esl')
  fs.mkdirSync(path.join(g.dir, 'Data'), { recursive: true })
  fs.writeFileSync(path.join(g.dir, 'Data/KCF.esm'), kcf); fs.writeFileSync(path.join(g.dir, 'Data/TrueHUD.esl'), hud)
  const files = [
    patchEntry('Data/KCF.esm', kcf, [{ op: 'clearFlags', mask: 0x200 }], { mod: 'KCF', from: { path: 'Data/KCF.esm', size: kcf.length, sha256: sha(kcf) } }),
    patchEntry('Data/TrueHUD.esp', hud, [{ op: 'clearFlags', mask: 0x201 }, rename], { mod: 'TrueHUD', from: { path: 'Data/TrueHUD.esl', size: hud.length, sha256: sha(hud) } }),
  ]
  const urls = await server(t, { manifest: { schema: 1, files } })
  const steps = []
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, onProgress: s => steps.push(s) })
  assert.deepEqual(result.patched, ['Data/KCF.esm', 'Data/TrueHUD.esp'])
  assert.equal(result.blocked, false)
  assert.deepEqual(steps.map(s => s.stage).filter((stage, i, all) => stage !== all[i - 1]), ['checking', 'patching'])
  assert.deepEqual(steps.filter(s => s.stage === 'patching').map(s => s.done + ' of ' + s.total), ['1 of 2', '2 of 2'])
  assert.equal(sha(fs.readFileSync(path.join(g.dir, 'Data/KCF.esm'))), files[0].sha256)
  assert.equal(fs.readFileSync(path.join(g.dir, 'Data/TrueHUD.esp')).readUInt32LE(8), 0)
  assert.match(fs.readFileSync(path.join(g.dir, 'Data/TrueHUD.esp'), 'ascii'), /TrueHUD\.esp/)
  assert.deepEqual(fs.readFileSync(path.join(g.dir, 'Data/TrueHUD.esl')), hud, 'The collection\'s original stays untouched')
  assert.deepEqual((await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })).patched, [], 'Adapted files are not redone')
})

test('a missing or different original is reported under its mod instead of patched', async t => {
  const g = game(t), original = plugin(0x201, 'kcf v2')
  const e = patchEntry('Data/KCF.esm', original, [{ op: 'clearFlags', mask: 0x200 }], { mod: 'KCF', from: { path: 'Data/KCF.esm', size: original.length, sha256: sha(original) } })
  const urls = await server(t, { manifest: { schema: 1, files: [e] } })
  let result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual([result.mods[0].name, result.mods[0].missing.length, result.blocked], ['KCF', 1, true])
  g.put('Data/KCF.esm', plugin(0x201, 'kcf v1'))
  result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual([result.mods[0].changed.length, result.patched.length], [1, 0])
})

test('a patch that does not rebuild the server\'s file is refused and leaves the game untouched', async t => {
  const g = game(t), original = plugin(0x201, 'kcf')
  fs.mkdirSync(path.join(g.dir, 'Data'), { recursive: true }); fs.writeFileSync(path.join(g.dir, 'Data/KCF.esm'), original)
  const lying = { ...patchEntry('Data/KCF.esm', original, [{ op: 'clearFlags', mask: 0x200 }], { mod: 'KCF', from: { path: 'Data/KCF.esm', size: original.length, sha256: sha(original) } }), sha256: sha('something else') }
  const urls = await server(t, { manifest: { schema: 1, files: [lying] } })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache }), /Could not adapt Data\/KCF\.esm/)
  assert.deepEqual(fs.readFileSync(path.join(g.dir, 'Data/KCF.esm')), original)
  assert.equal(fs.existsSync(path.join(g.dir, 'Data/KCF.esm.dovakarn-part')), false)
  const bad = [{ op: 'replace', find: 'short', replace: 'longer' }]
  const invalid = await server(t, { manifest: { schema: 1, files: [{ ...lying, steps: bad }] } })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...invalid, cacheFile: g.cache }), /invalid entry/)
  const escape = await server(t, { manifest: { schema: 1, files: [{ ...lying, from: { ...lying.from, path: '../../outside.esm' } }] } })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...escape, cacheFile: g.cache }), /Unsafe file path/)
})

test('unchanged size and modified time reuse the cached hash', async t => {
  const g = game(t), text = 'archive one', when = new Date(2026, 0, 1)
  g.put('Data/A.bsa', text)
  const file = path.join(g.dir, 'Data/A.bsa')
  fs.utimesSync(file, when, when)
  const urls = await server(t, { manifest: { schema: 1, files: [entry('Data/A.bsa', text, { kind: 'mod', mod: 'A' })] } })
  assert.deepEqual((await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })).mods, [])
  fs.writeFileSync(file, 'archive two'); fs.utimesSync(file, when, when)
  assert.deepEqual((await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })).mods, [], 'Same size and time: cached')
  fs.utimesSync(file, when, new Date(when.getTime() + 5000))
  assert.equal((await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })).mods[0].changed.length, 1, 'A new modified time forces a re-hash')
})

test('unsafe list entries, bad links and plain HTTP from other hosts are refused', async t => {
  const g = game(t)
  for (const bad of ['../outside.txt', 'Data/../../outside.txt', 'C:/Windows/win.ini', '/etc/passwd', 'Data//x.esp', '', 'Data/x.dll:hidden', 'Data/a?.esp', 'Data/\u0000.esp']) {
    assert.throws(() => resolveInside(g.dir, bad), /Unsafe file path/)
  }
  assert.equal(resolveInside(g.dir, 'Data/Skyrim.esm'), path.join(g.dir, 'Data', 'Skyrim.esm'))
  const traversal = await server(t, { manifest: { schema: 1, files: [entry('../escape.dll', 'x', { kind: 'dovahzul' })] } })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...traversal, cacheFile: g.cache }), /Unsafe file path/)
  const phishing = await server(t, { manifest: { schema: 1, collection: { url: 'https://nexusmods.com.evil.example/collection' }, files: [] } })
  assert.equal((await checkGameFiles({ gameDir: g.dir, ...phishing, cacheFile: g.cache })).collection.url, '')
  const broken = await server(t, { manifest: { schema: 1, files: [{ path: 'Data/x.esp', size: -1, sha256: 'nope', kind: 'mod' }] } })
  await assert.rejects(checkGameFiles({ gameDir: g.dir, ...broken, cacheFile: g.cache }), /invalid entry/)
  await assert.rejects(checkGameFiles({ gameDir: g.dir, manifestUrl: 'http://example.com/list.json', filesUrl: 'http://example.com/files', cacheFile: g.cache }), /must use HTTPS/)
})

test('when Vortex deployed another mod\'s copy, the exact copy the server needs is taken from staging', async t => {
  const g = game(t), staging = path.join(g.dir, '..', `${path.basename(g.dir)}-staging`)
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }))
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  // Vortex deployed the old DLL; the AE build and an ESL-flagged original sit in staging only.
  put(path.join(staging, 'Key Utils SE-1-1/SKSE/Plugins/Keys.dll'), 'old keys')
  put(path.join(staging, 'Key Utils extend 2 1.1 2026-01-01T00-00Z x/SKSE/Plugins/Keys.dll'), 'new AE keys')
  put(path.join(staging, 'Aaa Look-alike-3-1/SKSE/Plugins/Keys.dll'), 'new XX keys')
  const flagged = Buffer.from('TES4xxxx\x00\x02\x00\x00rest'), cleared = Buffer.from(flagged)
  cleared.writeUInt32LE(0, 8)
  put(path.join(staging, 'Precision-4-1/Precision.esp'), flagged)
  g.put('Data/SKSE/Plugins/Keys.dll', 'old keys')
  g.put('Data/Precision.esp', 'an older Precision')
  put(path.join(g.dir, 'Data/vortex.deployment.json'), JSON.stringify({ stagingPath: staging, files: [] }))
  const keys = entry('Data/SKSE/Plugins/Keys.dll', 'new AE keys', { kind: 'mod', mod: 'Key Utils extend' })
  const precision = {
    ...entry('Data/Precision.esp', cleared, { kind: 'patch', mod: 'Precision' }),
    from: { path: 'Data/Precision.esp', size: flagged.length, sha256: sha(flagged) },
    steps: [{ op: 'clearFlags', mask: 0x200 }],
  }
  const missing = entry('Data/SKSE/Plugins/Nowhere.dll', 'not in any mod', { kind: 'mod', mod: 'Nowhere' })
  const urls = await server(t, { manifest: { schema: 1, files: [keys, precision, missing] } })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.equal(g.read('Data/SKSE/Plugins/Keys.dll'), 'new AE keys', 'A same-size look-alike with another hash is never used')
  assert.equal(fs.readFileSync(path.join(g.dir, 'Data/Precision.esp')).equals(cleared), true, 'The original is found in staging and adapted')
  assert.deepEqual(result.patched.sort(), ['Data/Precision.esp', 'Data/SKSE/Plugins/Keys.dll'])
  assert.deepEqual(result.mods.map(m => [m.name, m.missing.length]), [['Nowhere', 1]], 'Only what no mod has is reported')
  assert.equal(fs.readFileSync(path.join(staging, 'Key Utils SE-1-1/SKSE/Plugins/Keys.dll'), 'utf8'), 'old keys', 'Staging is only read')
  assert.equal(fs.readFileSync(path.join(staging, 'Precision-4-1/Precision.esp')).equals(flagged), true)
})

test('a file beside SkyrimSE.exe that Vortex staged but never deployed is put in place', async t => {
  const g = game(t), staging = path.join(g.dir, '..', `${path.basename(g.dir)}-root-staging`)
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }))
  const folder = path.join(staging, 'Engine Fixes - SKSE64 Preloader-17230-7-1700000000')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'd3dx9_42.dll'), 'preloader 7')
  g.put('Data/vortex.deployment.json', JSON.stringify({ stagingPath: staging, files: [] }))
  const urls = await server(t, { manifest: { schema: 1, files: [entry('d3dx9_42.dll', 'preloader 7', { kind: 'mod', mod: 'Engine Fixes - SKSE64 Preloader', nexusId: 17230 })] } })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual([g.read('d3dx9_42.dll'), result.patched, result.blocked], ['preloader 7', ['d3dx9_42.dll'], false])
  fs.rmSync(staging, { recursive: true })
  fs.rmSync(path.join(g.dir, 'd3dx9_42.dll'))
  const missing = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual([missing.blocked, missing.mods.map(m => [m.name, m.nexusId, m.missing.length])], [true, [['Engine Fixes - SKSE64 Preloader', 17230, 1]]],
    'Without it the launch is refused with the mod named, instead of Skyrim closing')
})

test('Cancel stops a download mid-file: the installed file is untouched and no part file is left', async t => {
  const g = game(t), listed = 'client v2'.padEnd(4 << 20, '.')
  g.put('Data/Platform/Plugins/skymp5-client.js', 'client v1')
  const e = entry('Data/Platform/Plugins/skymp5-client.js', listed, { kind: 'dovahzul' })
  // A server that sends the first part of the file, then stalls, as a slow connection would; Cancel comes mid-file
  const abort = new AbortController()
  const srv = http.createServer((req, res) => {
    if (req.url === '/list.json') return res.end(JSON.stringify({ schema: 1, files: [e] }))
    res.writeHead(200, { 'content-length': e.size }); res.write(Buffer.from(listed).subarray(0, 1 << 16))
    setTimeout(() => abort.abort(), 150)
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  const base = `http://127.0.0.1:${srv.address().port}`, seen = []
  const run = checkGameFiles({ gameDir: g.dir, manifestUrl: `${base}/list.json`, filesUrl: `${base}/files`, cacheFile: g.cache, signal: abort.signal, onProgress: step => seen.push(step) })
  await assert.rejects(run, error => error.code === 'CANCELLED')
  assert.equal(g.read('Data/Platform/Plugins/skymp5-client.js'), 'client v1')
  assert.equal(fs.existsSync(path.join(g.dir, 'Data/Platform/Plugins/skymp5-client.js.dovakarn-part')), false)
  // Already stopped: nothing is asked of the server at all
  await assert.rejects(checkGameFiles({ gameDir: g.dir, manifestUrl: `${base}/list.json`, filesUrl: `${base}/files`, cacheFile: g.cache, signal: abort.signal }), error => error.code === 'CANCELLED')
})

test('one signal serves a whole check without piling up listeners', async t => {
  const g = game(t), files = Array.from({ length: 30 }, (_, i) => [`Data/f${i}.txt`, `file ${i}`])
  const entries = files.map(([p, text]) => entry(p, text, { kind: 'dovahzul' }))
  const store = Object.fromEntries(files.map(([, text], i) => [entries[i].sha256, Buffer.from(text)]))
  const urls = await server(t, { manifest: { schema: 1, files: entries }, store })
  const abort = new AbortController()
  await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, signal: abort.signal })
  assert.equal(g.read('Data/f29.txt'), 'file 29')
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0, 'each download lets go of the signal when it is done')
  fs.rmSync(g.cache); fs.appendFileSync(path.join(g.dir, 'Data/f0.txt'), '!')
  await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, signal: abort.signal })
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0, 'and so does each file read for its hash')
})
