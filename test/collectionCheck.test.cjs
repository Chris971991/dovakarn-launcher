// 'dovahzul' in these fixtures is the server's name for Dovakarn's own files in its player file list.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { parseCollectionUrl, parseVortexSource, parseUntimedVortexSource, fetchCollection, installedMods, compareCollection, checkCollection } = require('../src/collectionCheck')
const { get, checkGameFiles, checkBeforeLaunch, describeFiles, filesView, checkSummary } = require('../src/fileCheck')

const URL = 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef'

// A loopback stand-in for Nexus's GraphQL API; `reply` may be a function of the request body.
async function nexus(t, reply) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body || 'null'); seen.push({ method: req.method, headers: req.headers, body: parsed })
      const value = typeof reply === 'function' ? reply(parsed) : reply
      if (value === 404) { res.statusCode = 404; return res.end() }
      res.end(JSON.stringify(value))
    })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => srv.close())
  return { endpoint: `http://127.0.0.1:${srv.address().port}/graphql`, seen }
}
const collection = (mods, revision = 2) => ({ data: { collection: { name: 'Example Collection', latestPublishedRevision: { revisionNumber: revision,
  modFiles: mods.map(([modId, date, name = `Mod ${modId}`, optional = false]) => ({ optional, fileId: modId * 10, file: { name, version: '1.0', date, mod: { modId, name } } })) } } } })

// A player's Skyrim folder as Vortex leaves it: deployment records in Data and the game folder, plus staging.
function vortexGame(t, { data = [], root = [], staged = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-collection-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const staging = path.join(dir, 'staging')
  fs.mkdirSync(path.join(dir, 'game/Data'), { recursive: true })
  for (const name of staged) fs.mkdirSync(path.join(staging, name), { recursive: true })
  const record = sources => JSON.stringify({ version: 1, stagingPath: staging, files: sources.map((source, i) => ({ relPath: `file${i}.esp`, source })) })
  if (data.length) fs.writeFileSync(path.join(dir, 'game/Data/vortex.deployment.json'), '\uFEFF' + record(data))
  if (root.length) fs.writeFileSync(path.join(dir, 'game/vortex.deployment.dinput.json'), record(root))
  return path.join(dir, 'game')
}

test('only real Nexus collection links are accepted', () => {
  assert.deepEqual(parseCollectionUrl(URL), { domain: 'skyrimspecialedition', slug: 'abcdef' })
  assert.deepEqual(parseCollectionUrl('https://next.nexusmods.com/skyrimspecialedition/collections/abc123/?tab=mods'), { domain: 'skyrimspecialedition', slug: 'abc123' })
  assert.deepEqual(parseCollectionUrl('https://nexusmods.com/games/SkyrimSpecialEdition/collections/abcdef/'), { domain: 'skyrimspecialedition', slug: 'abcdef' })
  assert.deepEqual(parseCollectionUrl('https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef/revisions/3?tab=mods'),
    { domain: 'skyrimspecialedition', slug: 'abcdef' }, 'A revision link still checks the latest revision')
  for (const bad of ['https://nexusmods.com.evil.example/games/skyrimspecialedition/collections/abcdef', 'http://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef',
    'https://www.nexusmods.com/games/skyrimspecialedition/mods/3038', 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef/../x', '', undefined, 42]) {
    assert.equal(parseCollectionUrl(bad), null, String(bad))
  }
})

test('Vortex folder names give the Nexus mod and the exact file upload time, in both spellings', () => {
  // Older downloads: "<name>-<mod id>-<version>-<upload time in seconds>".
  assert.deepEqual(parseVortexSource('FNIS Behavior SE 7_6-3038-7-6-1582048023'), { mod: 'FNIS Behavior SE 7_6', modId: 3038, uploaded: 1582048023, precision: 1, ids: [3038, 7, 6] })
  assert.deepEqual(parseVortexSource("dTry's Key Utils extend-2222-1-1-1600000001").ids, [2222, 1, 1])
  // A version inside the name must not hide the real id.
  assert.ok(parseVortexSource('RaceMenu Anniversary Edition v0-4-20-0-19080-0-4-20-0-1776620918').ids.includes(19080))
  // Collection installs: "<name> <mod id> <version> <upload time to the minute, UTC> <download id>".
  assert.deepEqual(parseVortexSource('Example Mod A - Latest Version 100001 2.0.1 2026-01-01T00-00Z abc000001'),
    { mod: 'Example Mod A - Latest Version', modId: 100001, uploaded: Date.UTC(2026, 0, 1, 0, 0) / 1000, precision: 60, ids: [100001] })
  assert.deepEqual(parseVortexSource('Example Library (1.7.104.0) v13 100002 13 2026-01-01T00-00Z abc000002').modId, 100002, 'Numbers in the name are not the id')
  assert.equal(parseVortexSource('Example Injector 100003 v0.13.0.4 2026-01-01T00-00Z abc000003').modId, 100003)
  for (const bad of ['My Local Mod', 'Name-123-1-0', 'Name 123 1.0 2026-01-01 00-00Z x', null, undefined, {}]) assert.equal(parseVortexSource(bad), null, String(bad))
})

test('a folder from an older download, named without an upload time, still counts as that mod installed', t => {
  // The Notice Board SE (Nexus 3218, 2016): Vortex names its folder after the archive, "The Notice Board-3218-1-4"
  assert.deepEqual(parseUntimedVortexSource('The Notice Board-3218-1-4'), { mod: 'The Notice Board', modId: 3218, uploaded: null, precision: null, ids: [3218] })
  assert.equal(parseUntimedVortexSource('Foo-2-Bar-3218-1-4').modId, 3218, 'only the number before the version is the id')
  for (const other of ['FNIS Behavior SE 7_6-3038-7-6-1582048023', 'Loose files I made', 'XP32-1988-5-06-1707663131+Example Collection.1', null]) assert.equal(parseUntimedVortexSource(other), null, String(other))
  const game = vortexGame(t, { data: ['The Notice Board-3218-1-4'] })
  const installed = installedMods(game)
  assert.deepEqual(installed.byModId.get(3218), [{ uploaded: null, precision: null }])
  const coll = { revision: 4, mods: [{ modId: 3218, name: 'The Notice Board SE', uploaded: 1479931806 }] }
  assert.deepEqual(compareCollection(coll, installed), { revision: 4, total: 1, deployed: true, missing: [], outdated: [] }, 'neither missing nor out of date')
})

test('a folder with a suffix after its name (a copy installed for another collection) still counts as that file', t => {
  // Folder names as Vortex writes them for a copy installed for another collection
  const game = vortexGame(t, { data: ['More Craftable Equipment-44666-1-4-0-1677446835+Other Collection.1'], staged: ['XP32 Maximum Skeleton Special Extended-1988-5-06-1707663131+Example Collection.1'] })
  const installed = installedMods(game)
  assert.deepEqual(installed.byModId.get(44666), [{ uploaded: 1677446835, precision: 1 }])
  assert.deepEqual(installed.byModId.get(1988), [{ uploaded: 1707663131, precision: 1 }])
  const coll = { revision: 5, mods: [{ modId: 44666, name: 'More Craftable Equipment', uploaded: 1677446835 }, { modId: 1988, name: 'XPMSSE', uploaded: 1707663131 }] }
  assert.deepEqual(compareCollection(coll, installed), { revision: 5, total: 2, deployed: true, missing: [], outdated: [] })
})

test('installed mods come from both deployment records and the staging folder', t => {
  const game = vortexGame(t, {
    data: ['SkyUI-12604-5-2SE-1600000000', 'SkyUI-12604-5-2SE-1600000000', 'Loose files I made'],
    root: ['Skyrim Script Extender (SKSE64)-30379-2-2-6-1700000000'],
    // Its files all lose conflicts, so it appears only in staging.
    staged: ['SkyUI-12604-5-2SE-1600000000', 'Behavior Data Injector-78146-v0-13-1700000001', 'not a nexus folder'],
  })
  const installed = installedMods(game)
  assert.equal(installed.deployed, true)
  for (const id of [12604, 30379, 78146]) assert.ok(installed.byModId.has(id), String(id))
  assert.deepEqual(installed.byModId.get(12604), [{ uploaded: 1600000000, precision: 1 }], 'One entry per folder, however many files it deployed')
  const none = installedMods(vortexGame(t))
  assert.deepEqual([none.deployed, none.byModId.size], [false, 0], 'No Vortex records means nothing is installed')
  const broken = vortexGame(t)
  fs.writeFileSync(path.join(broken, 'Data/vortex.deployment.json'), '{ not json')
  assert.equal(installedMods(broken).deployed, false, 'An unreadable record is ignored')
})

test('each required collection file is installed, missing, or installed at a different version', () => {
  const coll = { revision: 2, mods: [{ modId: 1, name: 'A', uploaded: 100 }, { modId: 2, name: 'B', uploaded: 200 }, { modId: 3, name: 'C', uploaded: 300 }, { modId: 4, name: 'Optional D', uploaded: 400, optional: true }] }
  const at = (uploaded, precision = 1) => ({ uploaded, precision })
  const installed = { deployed: true, byModId: new Map([[1, [at(100)]], [2, [at(150)]]]) }
  assert.deepEqual(compareCollection(coll, installed), { revision: 2, total: 3, deployed: true,
    missing: [{ modId: 3, name: 'C' }], outdated: [{ modId: 2, name: 'B' }] })
  const both = { deployed: true, byModId: new Map([[1, [at(100)]], [2, [at(150), at(200)]], [3, [at(300)]]]) }
  assert.deepEqual(compareCollection(coll, both).outdated, [], 'An installed copy of the exact file counts, even beside another version')
  // Collection installs only name the minute: the same minute matches, the next minute is another file.
  const minute = { revision: 3, mods: [{ modId: 9, name: 'Minute', uploaded: 1700000057 }] }
  assert.deepEqual(compareCollection(minute, { deployed: true, byModId: new Map([[9, [at(1700000040, 60)]]]) }).outdated, [])
  assert.deepEqual(compareCollection(minute, { deployed: true, byModId: new Map([[9, [at(1700000100, 60)]]]) }).outdated, [{ modId: 9, name: 'Minute' }])
})

test('a collection installed by Vortex with its newer folder names counts as installed', t => {
  const game = vortexGame(t, { data: ['Example Mod A - Latest Version 100001 2.0.1 2026-01-01T00-00Z abc000001', 'Example Old Mod v0-4-20-0-100004-0-4-20-0-1767225600'],
    staged: ['Example Set-Up 100005 1 2026-01-02T03-04Z abc000005', 'Example Logger-100006-1-24-0-1767225600', 'Example Logger 100006 1.25.0 2026-01-03T05-06Z abc000006'] })
  const coll = { revision: 3, mods: [{ modId: 100001, name: 'Mod A', uploaded: Date.UTC(2026, 0, 1, 0, 0, 37) / 1000 }, { modId: 100004, name: 'Old Mod', uploaded: 1767225600 },
    { modId: 100005, name: 'Set-Up', uploaded: Date.UTC(2026, 0, 2, 3, 4, 44) / 1000 }, { modId: 100006, name: 'Logger', uploaded: Date.UTC(2026, 0, 3, 5, 6, 9) / 1000 }] }
  assert.deepEqual(compareCollection(coll, installedMods(game)), { revision: 3, total: 4, deployed: true, missing: [], outdated: [] },
    'An older copy left in staging does not hide the current one')
})

test('the latest revision is read from Nexus with the slug as a variable, never pasted into the query', async t => {
  const { endpoint, seen } = await nexus(t, collection([[3038, 1582048023, 'FNIS'], [72347, 1674360214, '<img src=x>'], [0, 5], [5, -1], [6, 700, 'Optional', true]]))
  const result = await fetchCollection({ domain: 'skyrimspecialedition', slug: 'abcdef', request: get, endpoint })
  assert.deepEqual(result.mods.map(m => [m.modId, m.uploaded, m.optional]), [[3038, 1582048023, false], [72347, 1674360214, false], [6, 700, true]], 'Malformed entries are skipped')
  assert.deepEqual([result.name, result.revision], ['Example Collection', 2])
  assert.equal(seen[0].method, 'POST')
  assert.equal(seen[0].headers['application-name'], 'Dovakarn Launcher')
  assert.deepEqual(seen[0].body.variables, { slug: 'abcdef', domain: 'skyrimspecialedition' })
  assert.equal(seen[0].body.query.includes('abcdef'), false)
})

test('Nexus problems become readable errors from the check, which never throws', async t => {
  const game = vortexGame(t)
  const notFound = await nexus(t, { errors: [{ message: 'Collection not found', extensions: { code: 'NOT_FOUND' } }], data: null })
  assert.match((await checkCollection({ url: URL, gameDir: game, request: get, endpoint: notFound.endpoint })).error, /does not lead to a published Nexus collection/)
  const missing = await nexus(t, 404)
  assert.match((await checkCollection({ url: URL, gameDir: game, request: get, endpoint: missing.endpoint })).error, /does not lead to a published Nexus collection/)
  const odd = await nexus(t, { data: { collection: { name: 'X', latestPublishedRevision: null } } })
  assert.match((await checkCollection({ url: URL, gameDir: game, request: get, endpoint: odd.endpoint })).error, /unexpected format/)
  const garbage = await nexus(t, 'not json at all')
  assert.match((await checkCollection({ url: URL, gameDir: game, request: get, endpoint: garbage.endpoint })).error, /Nexus did not return the collection/)
  // Nothing listens on this port any more.
  const closed = await nexus(t, {}); await new Promise(r => setImmediate(r))
  const dead = closed.endpoint.replace(/:\d+/, ':1')
  assert.match((await checkCollection({ url: URL, gameDir: game, request: get, endpoint: dead })).error, /Could not reach Nexus/)
  assert.equal(await checkCollection({ url: 'https://evil.example/collections/abcdef', gameDir: game, request: get, endpoint: dead }), null, 'No valid link, no check')
})

// A server that publishes a file list with a collection link, for the launcher-level tests.
async function server(t, url = URL) {
  const client = 'client v2', sha = crypto.createHash('sha256').update(client).digest('hex')
  const manifest = { schema: 1, revision: 'r1', collection: { name: 'Dovakarn', url }, files: [{ path: 'Data/Platform/Plugins/skymp5-client.js', size: client.length, sha256: sha, kind: 'dovahzul' }] }
  const srv = http.createServer((req, res) => {
    if (req.url === '/manifest') return res.end(JSON.stringify(manifest))
    if (req.url === `/files/${sha}`) return res.end(client)
    res.statusCode = 404; res.end()
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve)); t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.address().port}`
  return { base, manifestUrl: `${base}/manifest`, filesUrl: `${base}/files` }
}

test('a PC without the collection gets one plain row, a Vortex instruction, and can still play', async t => {
  const game = vortexGame(t), urls = await server(t), cacheFile = path.join(game, 'hashes.json')
  const { endpoint } = await nexus(t, collection([[1, 100, 'SkyUI'], [2, 200, 'MCO'], [3, 300, 'TDM']]))
  const result = await checkGameFiles({ gameDir: game, ...urls, cacheFile, nexusApi: endpoint })
  assert.deepEqual(result.updated, ['Data/Platform/Plugins/skymp5-client.js'], 'Dovakarn files still install')
  assert.equal(result.blocked, false, 'A missing collection warns; it never blocks on its own')
  const view = filesView(result)
  assert.deepEqual(view.mods, [{ name: 'Dovakarn collection, revision 2', missing: 0, changed: 0, critical: false, state: 'notInstalled', count: 3 }])
  assert.equal(describeFiles(result), 'The Dovakarn collection, revision 2, is not installed. Install it with Vortex, then check again. You can still play, but you may see problems.')
  assert.deepEqual(checkSummary(result, 1).collection, { revision: 2, total: 3, missing: 3, outdated: 0 })
  assert.equal(checkSummary(result, 1).problems, 0, '"Your game" counts file problems only')
})

test('a partly installed collection names each missing or outdated mod', async t => {
  const game = vortexGame(t, { data: ['SkyUI-1-5-2-1600000100', 'MCO-2-1-5-1600000150'] }), urls = await server(t)
  const { endpoint } = await nexus(t, collection([[1, 1600000100, 'SkyUI'], [2, 1600000200, 'MCO'], [3, 1600000300, 'TDM']]))
  const result = await checkGameFiles({ gameDir: game, ...urls, cacheFile: path.join(game, 'hashes.json'), nexusApi: endpoint })
  assert.deepEqual(filesView(result).mods.map(m => [m.name, m.state]), [['TDM', 'missing'], ['MCO', 'outdated']])
  assert.match(describeFiles(result), /^2 mods from the Dovakarn collection, revision 2, are missing or out of date\. Update the collection in Vortex/)
  const done = vortexGame(t, { data: ['SkyUI-1-5-2-1600000100', 'MCO-2-1-6-1600000200', 'TDM-3-2-2-1600000300'] })
  const clean = await checkGameFiles({ gameDir: done, ...urls, cacheFile: path.join(done, 'hashes.json'), nexusApi: endpoint })
  assert.deepEqual([clean.warnings.length, describeFiles(clean)], [0, ''], 'A fully installed collection passes')
})

test('PLAY asks again when the collection moves to a new revision, and Nexus being down never blocks', async t => {
  const game = vortexGame(t), urls = await server(t)
  let revision = 2
  const { endpoint } = await nexus(t, () => collection([[1, 100, 'SkyUI']], revision))
  let accepted
  const first = await checkBeforeLaunch({ baseUrl: urls.base, gameDir: game, cacheFile: path.join(game, 'h.json'), accepted, accept: k => { accepted = k }, nexusApi: endpoint })
  assert.match(first.error, /collection, revision 2, is not installed.*Press PLAY again to play anyway/)
  assert.equal(first.collectionUrl, URL)
  assert.equal((await checkBeforeLaunch({ baseUrl: urls.base, gameDir: game, cacheFile: path.join(game, 'h.json'), accepted, accept: () => assert.fail('already accepted'), nexusApi: endpoint })).success, true)
  revision = 3
  const again = await checkBeforeLaunch({ baseUrl: urls.base, gameDir: game, cacheFile: path.join(game, 'h.json'), accepted, accept: k => { accepted = k }, nexusApi: endpoint })
  assert.match(again.error, /revision 3/, 'A new revision is a new warning')
  const down = await checkBeforeLaunch({ baseUrl: urls.base, gameDir: game, cacheFile: path.join(game, 'h.json'), accepted, accept: () => assert.fail('nothing to accept'), nexusApi: 'http://127.0.0.1:1/graphql' })
  assert.equal(down.success, true)
  assert.match(down.files.collectionCheck.error, /Could not reach Nexus/)
  assert.equal(checkSummary(down.files, 1).collection.error.length > 0, true)
})
