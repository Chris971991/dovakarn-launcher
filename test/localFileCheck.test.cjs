// Names fixed by the Dovakarn server, which the launcher must use as they are: 'dovahzul' is the server's own name for
// Dovakarn, so its player file list is served as dovahzul-client-manifest.json, the files under /dovahzul-files, its
// files of Dovakarn's own carry the kind 'dovahzul', and DOVAHZUL_VORTEX_DATA is the environment variable the server's
// tools read for Vortex's data folder. combat-test paths and --combat-test are the local test server's folder layout and
// launch flag.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createLocalFileCheck } = require('../src/localFileCheck')
const { createHostJobs } = require('../src/hostJobs')

// Optional: needs the Dovakarn server repository beside this one. skyrp is the server repository's folder and
// server-admin holds its tools, including the server's file-list builder. The real server tools are driven against a
// temporary install on the launcher's worker thread; the test is skipped where they are not present.
const realRoot = path.resolve(__dirname, '../../..')
const serverTools = path.join(realRoot, 'skyrp', 'server-admin', 'lib', 'client-manifest.cjs')
const skipWithoutServer = fs.existsSync(serverTools) ? false : 'the server tools are not beside this checkout'

test('a fix copied straight into the server\'s game copy is published, never rolled back', { skip: skipWithoutServer }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-local-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'skyrp'), game = path.join(root, 'combat-test/skyrim'), serverDir = path.join(root, 'combat-test/server')
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
  const dll = path.join(game, 'Data/SKSE/Plugins/SkyrimPlatform.dll')
  put(path.join(repo, 'build/dist/client/Data/SKSE/Plugins/SkyrimPlatform.dll'), 'build folder platform')
  put(dll, 'installed platform')
  // A real game copy holds the multiplayer client; the server's file-list builder never rebuilds the list from one without it
  put(path.join(game, 'Data/Platform/Plugins/skymp5-client.js'), 'installed client')
  put(path.join(repo, 'server-admin/redistribution.json'), JSON.stringify({ allow: [{ pattern: 'Data/SKSE/Plugins/SkyrimPlatform.dll', source: 'client', license: 'GPL-3.0' }] }))
  const manifestFile = path.join(root, 'combat-test/manifest.json')
  put(manifestFile, JSON.stringify({ gamePath: game, loadOrder: [] }))
  // The server tools' own environment variable for where they look for a Vortex install: an empty folder, never this PC's
  const env = process.env.DOVAHZUL_VORTEX_DATA; process.env.DOVAHZUL_VORTEX_DATA = path.join(root, 'no-vortex')
  t.after(() => { if (env === undefined) delete process.env.DOVAHZUL_VORTEX_DATA; else process.env.DOVAHZUL_VORTEX_DATA = env })
  // The game server's HTTP port serves its data folder.
  const srv = http.createServer((req, res) => {
    const file = path.join(serverDir, 'data', decodeURIComponent(req.url))
    if (!file.startsWith(path.join(serverDir, 'data')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end() }
    res.end(fs.readFileSync(file))
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve)); t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.address().port}`
  const jobs = createHostJobs({ root: realRoot, adminConfig: { repo, root, serverDir, manifest: manifestFile } })
  t.after(() => jobs.stop())
  const check = createLocalFileCheck({ publish: () => jobs.run('publish'),
    fileList: { manifestUrl: `${base}/dovahzul-client-manifest.json`, filesUrl: `${base}/dovahzul-files` },
    gameDir: () => game, cacheFile: () => path.join(root, 'hashes.json'), hostGameDir: () => game })
  const listed = () => JSON.parse(fs.readFileSync(path.join(serverDir, 'data/dovahzul-client-manifest.json'), 'utf8'))

  // Opening the launcher republishes the list on its own, so a new collection link shows before any check.
  put(path.join(repo, 'server-admin/collection.json'), JSON.stringify({ name: 'Dovakarn', url: 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef' }))
  await check.publish()
  assert.equal(listed().collection.url, 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef')
  put(path.join(repo, 'server-admin/collection.json'), JSON.stringify({ name: 'Dovakarn', url: '' }))
  await check.publish()
  const built = listed().generatedAt
  await new Promise(resolve => setTimeout(resolve, 20))

  // Server setup already rebuilt the list, so a check right after it does not build it again.
  await check(undefined, { published: true })
  assert.equal(listed().generatedAt, built)
  assert.deepEqual((await check()).updated, [])
  assert.notEqual(listed().generatedAt, built, 'Any other check rebuilds the list first')
  assert.equal(fs.readFileSync(dll, 'utf8'), 'installed platform', 'The build folder never replaces the installed file')
  put(dll, 'hotfixed platform')
  assert.deepEqual((await check()).updated, [], 'A hotfix is published, not treated as outdated')
  assert.equal(fs.readFileSync(dll, 'utf8'), 'hotfixed platform')
})
