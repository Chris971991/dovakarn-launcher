// 'dovahzul' in these fixtures is the server's name for Dovakarn's own files in its player file list.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const AdmZip = require('adm-zip')
const { createGameSetup, steamLibraryOf, oldInstallIn } = require('../src/gameSetup')
const gameCopy = require('../src/gameCopy')
const { restoreSkyrim, describe } = require('../src/restoreSkyrim')

const TOOL = path.join(__dirname, '..', 'assets', '7zip', '7z.exe')
// 7z.exe and Windows drive paths: these tests run on Windows only
const SEVEN_ZIP = process.platform !== 'win32' ? 'Windows only (7z.exe)' : !fs.existsSync(TOOL) && '7-Zip is not in assets'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const scratch = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-setup-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const plain = value => JSON.parse(JSON.stringify(value))

const CONTENT = { 'SkyrimSE.exe': 'exe 1.6.1170', 'Data/Skyrim.esm': 'skyrim master', 'Skyrim_Default.ini': '[General]\r\n' }
const REF = { app: '9', exeVersion: '1.6.1170.0', depots: [{ id: '1', manifest: '11' }, { id: '2', manifest: '22' }],
  files: Object.entries(CONTENT).map(([p, text]) => ({ path: p, depot: p === 'SkyrimSE.exe' ? '2' : '1', size: Buffer.byteLength(text), sha256: sha(text) })) }

// The launcher's settings store, in memory
const memoryStore = (values = {}) => ({ get: key => values[key], set: (key, value) => { values[key] = value }, values })
function fixture(t, { steam = {}, depots = null, listUrl = '', installDir, listTimeout = 0 } = {}) {
  const dir = scratch(t)
  const steamDir = path.join(dir, 'Steam', 'steamapps', 'common', 'Skyrim Special Edition')
  for (const [p, text] of Object.entries(steam)) put(path.join(steamDir, ...p.split('/')), text)
  if (depots) for (const f of REF.files) if (depots.includes(f.depot)) put(path.join(dir, 'Steam', 'steamapps', 'content', 'app_9', `depot_${f.depot}`, ...f.path.split('/')), CONTENT[f.path])
  const store = memoryStore({ skyrimPath: steamDir, ...(installDir ? { installDir: path.join(dir, installDir) } : {}) })
  const opened = [], told = []
  // The default folder is the scratch one: a test that never chose a folder must not reach a real C:\Dovakarn
  // Vortex's default downloads are looked for under a scratch AppData too: a test never reads the PC's own Vortex
  const setup = createGameSetup({ store, ref: REF, steamClientRoots: () => [path.join(dir, 'Steam')], userDataDir: path.join(dir, 'userData'), tool: TOOL,
    myGamesDir: path.join(dir, 'My Games'), windowsDownloads: path.join(dir, 'Downloads'), installListUrl: listUrl, openExternal: url => opened.push(url),
    defaultInstallDir: path.join(dir, 'Default', 'Dovakarn'), onNeededMods: list => told.push(list), appData: path.join(dir, 'AppData'), listTimeout })
  return { dir, steamDir, store, setup, opened, told }
}

test('the Dovakarn folder: "Dovakarn" inside the folder picked, never inside the player\'s Skyrim or Steam\'s games', { skip: process.platform !== 'win32' && 'Windows paths only' }, t => {
  const f = fixture(t, { steam: CONTENT })
  assert.equal(f.setup.installFolderFor('D:\\').dir, 'D:\\Dovakarn')
  assert.equal(f.setup.installFolderFor('D:\\Games\\Dovakarn').dir, 'D:\\Games\\Dovakarn')
  assert.match(f.setup.installFolderFor(f.steamDir).error, /your own Skyrim folder/)
  assert.match(f.setup.installFolderFor(path.join(f.dir, 'Steam', 'steamapps', 'common')).error, /own Skyrim folder|Steam manages/)
  assert.match(f.setup.installFolderFor('D:\\Spiele\\Überall').error, /plain English/)
  assert.equal(steamLibraryOf(f.steamDir), path.join(f.dir, 'Steam'))
})

test('a 1.6.1170 Steam Skyrim is the source; set up, the copy is made from it and the player\'s Skyrim is only read', async t => {
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn' })
  put(path.join(f.dir, 'My Games', 'SkyrimPrefs.ini'), '[Display]\r\niSize W=3440\r\n')
  let info = plain(await f.setup.info())
  assert.deepEqual([info.ready, info.steamReady, info.missing, info.chosen, info.fromDownload], [false, true, 0, true, false])
  const before = fs.readdirSync(f.steamDir, { recursive: true }).sort().join('|'), steps = []
  await f.setup.buildCopy({ progress: (stage, message, meter) => steps.push([stage, meter?.percent]), signal: new AbortController().signal })
  assert.ok(steps.every(([stage]) => stage === 'copyingGame') && steps.at(-1)[1] >= 0)
  info = plain(await f.setup.info())
  assert.equal(info.ready, true)
  assert.equal(fs.readdirSync(f.steamDir, { recursive: true }).sort().join('|'), before, 'the player\'s Skyrim is unchanged')
  assert.match(fs.readFileSync(path.join(info.gameDir, 'Dovakarn Profile', 'SkyrimPrefs.ini'), 'utf8'), /3440/, 'the copy\'s INIs start as the player\'s own')
})

test('Steam\'s 1.6.1170 download left on the PC by an earlier downgrade: its files move in first, and the page is told', async t => {
  const f = fixture(t, { steam: CONTENT, depots: ['1', '2'], installDir: 'Dovakarn' })
  const info = plain(await f.setup.info())
  assert.deepEqual([info.steamReady, info.fromDownload, info.bytes], [true, true, 0])
})

test('a newer Steam Skyrim: the three depot lines, each depot\'s download followed, and setup refused until they are in', async t => {
  const f = fixture(t, { steam: { ...CONTENT, 'SkyrimSE.exe': 'exe 1.7.104 longer' }, depots: ['1'] })
  let info = plain(await f.setup.info())
  assert.deepEqual([info.steamReady, info.missing, info.depots.map(d => [d.command, d.state])], [false, 1, [['download_depot 9 1 11', 'done'], ['download_depot 9 2 22', 'waiting']]])
  assert.equal(info.installDir, path.join(f.dir, 'Default', 'Dovakarn'), 'nothing chosen: the default folder')
  assert.equal(require('../src/gameSetup').DEFAULT_INSTALL_DIR, 'C:\\Dovakarn', 'which is C:\\Dovakarn for players')
  await assert.rejects(f.setup.buildCopy({ progress: () => {}, signal: new AbortController().signal }), e => e.code === 'NEEDS_DEPOTS')
  // Half a depot: downloading, with how far it got
  put(path.join(f.dir, 'Steam', 'steamapps', 'content', 'app_9', 'depot_2', 'placeholder.txt'), 'x')
  info = plain(await f.setup.info())
  assert.deepEqual(info.depots[1], { id: '2', command: 'download_depot 9 2 22', state: 'downloading', files: 0, total: 1 })
  f.store.set('installDir', '')
})

test('before every check: a copy not set up asks for setup, and a server without an install list skips the mods step', async t => {
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn' })
  const progress = () => {}, signal = new AbortController().signal
  assert.deepEqual(plain(await f.setup.prepare({ progress, signal })).blocked, 'setup')
  await f.setup.buildCopy({ progress, signal })
  assert.deepEqual(plain(await f.setup.prepare({ progress, signal })), {})
  assert.equal(f.setup.installedPaths(), null)
})

test('the mods step: what is missing is named with its Nexus page, and a download found on this PC is installed', { skip: SEVEN_ZIP }, async t => {
  const zip = new AdmZip(); zip.addFile('00 Core/SkyUI_SE.esp', Buffer.from('skyui plugin')); const bytes = zip.toBuffer()
  const list = { schema: 1, archives: [{ id: '35407', modId: 12604, fileId: 35407, name: 'SkyUI', size: bytes.length, md5: md5(bytes) }],
    files: [{ path: 'Data/SkyUI_SE.esp', size: 12, sha256: sha('skyui plugin'), archive: '35407', member: '00 Core/SkyUI_SE.esp' }] }
  const server = http.createServer((req, res) => { res.end(JSON.stringify(list)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn', listUrl: `http://127.0.0.1:${server.address().port}/api/client-files/install` })
  const progress = () => {}, signal = new AbortController().signal
  await f.setup.buildCopy({ progress, signal })
  const blocked = plain(await f.setup.prepare({ progress, signal }))
  assert.deepEqual([blocked.blocked, blocked.message], ['mods', '1 mod to download from Nexus Mods.'])
  assert.deepEqual(plain(await f.setup.info()).mods, [{ id: '35407', name: 'SkyUI', version: '', size: bytes.length, files: 1 }])
  assert.deepEqual(plain(f.setup.openMod('35407')), { success: true })
  assert.deepEqual(f.opened, ['https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35407'])
  // The player downloaded it in the browser: found by size and MD5, kept in Dovakarn's own Downloads, installed
  put(path.join(f.dir, 'Downloads', 'SkyUI_5_2_SE-12604-5-2SE.zip'), bytes)
  const done = plain(await f.setup.prepare({ progress, signal }))
  assert.deepEqual(done, { installed: 1 })
  const game = f.setup.gameDir()
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'SkyUI_SE.esp'), 'utf8'), 'skyui plugin')
  assert.ok(fs.existsSync(path.join(f.dir, 'Dovakarn', 'Downloads', '12604-35407.zip')))
  assert.equal(plain(await f.setup.info()).mods, null)
  assert.equal(f.told.at(-1), null, 'the Nexus window is told nothing is needed any more')
  assert.equal(f.setup.neededArchives(), null)
  assert.deepEqual([...f.setup.installedPaths()], ['data/skyui_se.esp'])
  assert.deepEqual(plain(await f.setup.prepare({ progress, signal })), {}, 'nothing to do the next time')
})

test('the downloads a check still needs reach the Nexus window in full', async t => {
  const bytes = Buffer.from('skyui archive bytes')
  const archive = { id: '35407', modId: 12604, fileId: 35407, name: 'SkyUI', version: '5.2', file: 'SkyUI_5_2_SE-12604-5-2SE.zip', size: bytes.length, md5: md5(bytes) }
  const list = { schema: 1, archives: [archive], files: [{ path: 'Data/SkyUI_SE.esp', size: 12, sha256: sha('skyui plugin'), archive: '35407', member: '00 Core/SkyUI_SE.esp' }] }
  const server = http.createServer((req, res) => { res.end(JSON.stringify(list)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn', listUrl: `http://127.0.0.1:${server.address().port}/api/client-files/install` })
  const progress = () => {}, signal = new AbortController().signal
  assert.equal(f.setup.downloadsDir(), path.join(f.dir, 'Dovakarn', 'Downloads'))
  await f.setup.buildCopy({ progress, signal })
  assert.equal(plain(await f.setup.prepare({ progress, signal })).blocked, 'mods', 'nothing downloaded yet')
  assert.deepEqual(plain(f.told.at(-1)), [archive], 'all eight fields, version and file among them')
  assert.deepEqual(plain(f.setup.neededArchives()), [archive])
  assert.equal(plain(await f.setup.info()).mods[0].version, '5.2')
  assert.deepEqual(plain(await f.setup.remove()), { success: true })
  assert.equal(f.told.at(-1), null)
  assert.equal(f.setup.downloadsDir(), '', 'no Dovakarn folder: nowhere to keep downloads')
})

test('the mods\' downloads are found in Vortex\'s default folder under the AppData given, and in a folder the player named', { skip: SEVEN_ZIP }, async t => {
  const pack = (member, text) => { const zip = new AdmZip(); zip.addFile(member, Buffer.from(text)); return zip.toBuffer() }
  const skyui = pack('00 Core/SkyUI_SE.esp', 'skyui plugin'), truehud = pack('TrueHUD.esp', 'truehud plugin')
  const list = { schema: 1, archives: [
    { id: '35407', modId: 12604, fileId: 35407, name: 'SkyUI', size: skyui.length, md5: md5(skyui) },
    { id: '454617', modId: 62775, fileId: 454617, name: 'TrueHUD', size: truehud.length, md5: md5(truehud) }],
  files: [{ path: 'Data/SkyUI_SE.esp', size: 12, sha256: sha('skyui plugin'), archive: '35407', member: '00 Core/SkyUI_SE.esp' },
    { path: 'Data/TrueHUD.esp', size: 14, sha256: sha('truehud plugin'), archive: '454617', member: 'TrueHUD.esp' }] }
  const server = http.createServer((req, res) => { res.end(JSON.stringify(list)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn', listUrl: `http://127.0.0.1:${server.address().port}/api/client-files/install` })
  const progress = () => {}, signal = new AbortController().signal
  await f.setup.buildCopy({ progress, signal })
  // Vortex's default download folder, under the AppData this launcher was given (never the PC's own in a test)
  put(path.join(f.dir, 'AppData', 'Vortex', 'downloads', 'skyrimse', 'SkyUI_5_2_SE-12604-5-2SE.zip'), skyui)
  // TrueHUD in a folder of the player's own (a Vortex download folder moved elsewhere), not known to the launcher yet
  const mine = path.join(f.dir, 'D drive', 'My Vortex Downloads')
  put(path.join(mine, 'TrueHUD-62775-1-1-9.zip'), truehud)
  let r = plain(await f.setup.prepare({ progress, signal }))
  assert.deepEqual([r.blocked, plain(f.setup.neededArchives()).map(a => a.id)], ['mods', ['454617']], 'SkyUI found in Vortex\'s folder; TrueHUD not yet')
  // Named by the player: kept, and the next check finds it there and installs both; the player's file stays where it is
  assert.deepEqual(plain(f.setup.addModsFolder(mine)), { success: true, dir: mine })
  assert.deepEqual(f.store.values.modsFolders, [mine])
  r = plain(await f.setup.prepare({ progress, signal }))
  assert.deepEqual(r, { installed: 2 })
  assert.equal(fs.readFileSync(path.join(f.setup.gameDir(), 'Data', 'TrueHUD.esp'), 'utf8'), 'truehud plugin')
  assert.ok(fs.existsSync(path.join(mine, 'TrueHUD-62775-1-1-9.zip')), 'only ever read')
})

test('a folder the player names for their mods must name its drive and exist; the latest ten are kept, each once', { skip: process.platform !== 'win32' && 'Windows paths only' }, t => {
  const f = fixture(t, { steam: CONTENT })
  for (const bad of ['', 'relative\\folder', 'Downloads', '\\no-drive', 'C:no-slash', 5, null, undefined, `C:\\${'x'.repeat(2000)}`]) {
    assert.deepEqual(plain(f.setup.addModsFolder(bad)), { success: false, error: "Choose a folder on one of this PC's drives." }, String(bad).slice(0, 20))
  }
  assert.deepEqual(plain(f.setup.addModsFolder(path.join(f.dir, 'missing'))), { success: false, error: 'That folder was not found. Choose another.' })
  put(path.join(f.dir, 'a file'), 'x')
  assert.equal(f.setup.addModsFolder(path.join(f.dir, 'a file')).success, false, 'a file is not a folder')
  assert.equal(f.store.values.modsFolders, undefined, 'nothing kept for a refusal')
  const dirs = Array.from({ length: 12 }, (_, i) => { const d = path.join(f.dir, `mods ${i}`); fs.mkdirSync(d); return d })
  for (const d of dirs) assert.equal(f.setup.addModsFolder(d).success, true)
  assert.equal(f.setup.addModsFolder(dirs[3].toUpperCase()).success, true, 'the same folder in other letters')
  assert.deepEqual(f.setup.modsFolders(), [path.resolve(dirs[3].toUpperCase()), ...dirs.slice().reverse().filter(d => d !== dirs[3]).slice(0, 9)], 'newest first, ten at most, each once')
  // A store edited by hand gives only folders that name their drive
  f.store.values.modsFolders = ['relative', 7, dirs[0]]
  assert.deepEqual(f.setup.modsFolders(), [dirs[0]])
})

test('a folder the player named can be forgotten from Settings: only one the launcher keeps, and nothing in it is touched', { skip: process.platform !== 'win32' && 'Windows paths only' }, async t => {
  const f = fixture(t, { steam: CONTENT })
  const a = path.join(f.dir, 'mods a'), b = path.join(f.dir, 'mods b')
  put(path.join(a, 'TrueHUD.7z'), 'truehud'); fs.mkdirSync(b)
  f.setup.addModsFolder(a); f.setup.addModsFolder(b)
  assert.deepEqual(plain(await f.setup.info()).modsFolders, [b, a], 'Settings lists them, newest first')
  assert.deepEqual(plain(f.setup.forgetModsFolder(a.toUpperCase())), { success: true }, 'the same folder in other letters')
  assert.deepEqual([f.setup.modsFolders(), plain(await f.setup.info()).modsFolders], [[b], [b]])
  assert.equal(fs.readFileSync(path.join(a, 'TrueHUD.7z'), 'utf8'), 'truehud', 'only ever read: its files stay')
  for (const bad of [a, 'relative', '', 5, null, undefined, path.join(f.dir, 'never named')]) {
    assert.deepEqual(plain(f.setup.forgetModsFolder(bad)), { success: false, error: 'That folder is not one the launcher looks in.' }, String(bad))
  }
  assert.deepEqual(f.setup.modsFolders(), [b])
})

test('a folder of the player\'s own that gives no answer is skipped and named for the mods window; forgetting a folder drops what was remembered of its files, even mid-check', async t => {
  const modInstall = require('../src/modInstall')
  const bytes = Buffer.from('truehud archive bytes')
  const list = { schema: 1, archives: [{ id: '454617', modId: 62775, fileId: 454617, name: 'TrueHUD', size: bytes.length, md5: md5(bytes) }],
    files: [{ path: 'Data/TrueHUD.esp', size: 14, sha256: sha('truehud plugin'), archive: '454617', member: 'TrueHUD.esp' }] }
  const server = http.createServer((req, res) => { res.end(JSON.stringify(list)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn', listUrl: `http://127.0.0.1:${server.address().port}/api/client-files/install`, listTimeout: 400 })
  const signal = new AbortController().signal
  await f.setup.buildCopy({ progress: () => {}, signal })
  const nas = path.join(f.dir, 'NAS mods'), mine = path.join(f.dir, 'My Mods'), cache = path.join(f.dir, 'userData', 'download-md5s.json')
  fs.mkdirSync(nas); put(path.join(mine, 'Not TrueHUD.7z'), Buffer.alloc(bytes.length, 'x'))     // its size, other bytes: hashed, never used
  f.setup.addModsFolder(nas); f.setup.addModsFolder(mine)
  // The NAS went offline: a read of it already waits and never answers (this check joins it rather than reading again)
  assert.equal(await modInstall.listFolder(nas, { timeout: 10, fsp: { readdir: () => new Promise(() => {}), stat: () => new Promise(() => {}) } }), null)
  // While this check waits on the NAS, the player forgets My Mods: what was remembered of its file is not written back
  let forgot = null
  const progress = (_stage, message) => { if (!forgot && /^Looking for the mods' downloads/.test(message)) forgot = new Promise(resolve => setTimeout(() => resolve(f.setup.forgetModsFolder(mine)), 100)) }
  const r = plain(await f.setup.prepare({ progress, signal }))
  assert.deepEqual([r.blocked, plain(await forgot)], ['mods', { success: true }])
  assert.deepEqual(plain(await f.setup.info()).modsFoldersSkipped, [nas], 'the player\'s own folder that gave no answer is named')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8'))).filter(k => k.startsWith(mine.toLowerCase())), [], 'nothing of the forgotten folder kept')
  // Forgotten after the check: what was remembered of it goes from the file at once
  f.setup.addModsFolder(mine)
  fs.writeFileSync(cache, JSON.stringify({ [path.join(mine, 'Not TrueHUD.7z').toLowerCase()]: { stamp: '1:1', md5: 'a'.repeat(32) }, [path.join(f.dir, 'Downloads', 'b.7z').toLowerCase()]: { stamp: '1:1', md5: 'b'.repeat(32) } }))
  f.setup.forgetModsFolder(mine)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8'))), [path.join(f.dir, 'Downloads', 'b.7z').toLowerCase()])
  // A folder that is also one the check looks in anyway (the browser's Downloads) keeps what was remembered of it
  fs.mkdirSync(path.join(f.dir, 'Downloads'))
  f.setup.addModsFolder(path.join(f.dir, 'Downloads')); f.setup.forgetModsFolder(path.join(f.dir, 'Downloads'))
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8'))), [path.join(f.dir, 'Downloads', 'b.7z').toLowerCase()])
  // Forgetting the skipped folder takes it out of the mods window's line; the next check starts the list again
  f.setup.forgetModsFolder(nas)
  assert.deepEqual(plain(await f.setup.info()).modsFoldersSkipped, [])
})

test('a setup stopped partway: the folder cannot be changed (its files would be stranded) and the page says it is unfinished', async t => {
  const f = fixture(t, { steam: { ...CONTENT, 'SkyrimSE.exe': 'exe 1.7.104 longer' }, installDir: 'Dovakarn' })
  await assert.rejects(f.setup.buildCopy({ progress: () => {}, signal: new AbortController().signal }), e => e.code === 'NEEDS_DEPOTS')
  assert.deepEqual(plain(f.setup.chooseInstallDir(path.join(f.dir, 'Elsewhere'))), { success: true, dir: path.join(f.dir, 'Elsewhere', 'Dovakarn') }, 'nothing copied yet: free to move')
  f.store.set('installDir', path.join(f.dir, 'Dovakarn'))
  put(path.join(f.dir, 'Dovakarn', 'Game', 'Data', 'Skyrim.esm'), 'skyrim master')
  const info = plain(await f.setup.info())
  assert.deepEqual([info.ready, info.partial], [false, true])
  assert.match(plain(f.setup.chooseInstallDir(path.join(f.dir, 'Elsewhere'))).error, /^Part of Dovakarn's game is already in .*Dovakarn\. To set it up somewhere else, remove that first in Settings, Game\.$/)
  assert.deepEqual(plain(f.setup.chooseInstallDir(path.join(f.dir, 'Dovakarn'))).success, true, 'the same folder is fine')
})

test('a ready copy that loses a file nothing can replace stops being ready, so the player is asked to set it up again', async t => {
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn' })
  const progress = () => {}, signal = new AbortController().signal
  await f.setup.buildCopy({ progress, signal })
  // Steam updates the player's Skyrim to a newer version, then a file in the copy is damaged
  fs.writeFileSync(path.join(f.steamDir, 'SkyrimSE.exe'), 'exe 1.7.104 longer')
  fs.writeFileSync(path.join(f.setup.gameDir(), 'SkyrimSE.exe'), 'damaged!!!!!')
  const blocked = plain(await f.setup.prepare({ progress, signal }))
  assert.equal(blocked.blocked, 'setup')
  assert.match(blocked.message, /^A game file in your Dovakarn folder is damaged, and nothing on this PC can replace it\. Press Set up Dovakarn to get it from Steam again\./)
  const info = plain(await f.setup.info())
  assert.deepEqual([info.ready, info.partial, info.missing], [false, true, 1], 'the Setup card and the depot lines come back')
})

test('Cancel stops the search for the mods\' downloads', { skip: SEVEN_ZIP }, async t => {
  const list = { schema: 1, archives: [{ id: '35407', modId: 12604, fileId: 35407, name: 'SkyUI', size: 5, md5: md5('skyui') }],
    files: [{ path: 'Data/SkyUI_SE.esp', size: 12, sha256: sha('skyui plugin'), archive: '35407', member: 'SkyUI_SE.esp' }] }
  const server = http.createServer((req, res) => { res.end(JSON.stringify(list)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn', listUrl: `http://127.0.0.1:${server.address().port}/api/client-files/install` })
  await f.setup.buildCopy({ progress: () => {}, signal: new AbortController().signal })
  const abort = new AbortController(), stages = []
  const progress = (stage, message) => { stages.push(message); if (/^Looking for the mods' downloads/.test(message)) abort.abort() }
  put(path.join(f.dir, 'Downloads', 'SkyUI.zip'), 'skyui')
  await assert.rejects(f.setup.prepare({ progress, signal: abort.signal }), e => e.code === 'CANCELLED')
  // No brackets: Sovngarde draws them like square ones
  assert.ok(stages.includes("Looking for the mods' downloads, 1 of 1..."))
  assert.ok(stages.every(line => !/[();]/.test(line)), stages.join(' | '))
  assert.ok(!fs.existsSync(path.join(f.dir, 'Dovakarn', 'Downloads', '12604-35407.zip')), 'nothing copied after Cancel')
})

test('Remove deletes only a Dovakarn folder the launcher made', async t => {
  const f = fixture(t, { steam: CONTENT, installDir: 'Dovakarn' })
  await f.setup.buildCopy({ progress: () => {}, signal: new AbortController().signal })
  put(path.join(f.dir, 'Dovakarn', 'my notes.txt'), 'mine')
  assert.match(plain(await f.setup.remove()).error, /also holds my notes.txt/)
  assert.ok(fs.existsSync(path.join(f.dir, 'Dovakarn', 'Game')))
  fs.rmSync(path.join(f.dir, 'Dovakarn', 'my notes.txt'))
  assert.deepEqual(plain(await f.setup.remove()), { success: true })
  assert.ok(!fs.existsSync(path.join(f.dir, 'Dovakarn')))
  assert.equal(f.store.values.installDir, '')
  assert.ok(fs.existsSync(path.join(f.steamDir, 'SkyrimSE.exe')), 'the player\'s Skyrim stays')
})

test('Put my Skyrim back: Dovakarn\'s exact files go, moved files return, read-only menus are freed; nothing else is touched', async t => {
  const dir = scratch(t), skyrim = path.join(dir, 'Skyrim')
  put(path.join(skyrim, 'SkyrimSE.exe'), 'exe')
  put(path.join(skyrim, 'Data', 'Platform', 'Plugins', 'skymp5-client.js'), 'dovakarn client')
  put(path.join(skyrim, 'Data', 'Platform', 'Plugins', 'other-server.js'), 'another server\'s client')
  put(path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll'), 'a different version')
  put(path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'DovakarnProfile.dll'), 'any version')
  put(path.join(skyrim, 'Dovakarn removed files', '2026-01-01 00-00-00', 'Data', 'SKSE', 'Plugins', 'MyMod.ini'), 'mine')
  put(path.join(skyrim, 'Dovakarn removed files', '2026-01-02 00-00-00', 'Data', 'SKSE', 'Plugins', 'MyMod.ini'), 'mine, moved again')
  put(path.join(skyrim, 'disabled CC mods', 'ccBGSSSE001-Fish.esm'), 'fish')
  put(path.join(skyrim, 'Data', 'MCM', 'Settings', 'TrueHUD.ini'), '[Keys]')
  fs.chmodSync(path.join(skyrim, 'Data', 'MCM', 'Settings', 'TrueHUD.ini'), 0o444)
  // Address Library deployed by the player's Vortex (a hard link to its staging folder): the server lists it too
  put(path.join(dir, 'Vortex staging', 'versionlib-1-6-1170-0.bin'), 'address library')
  fs.linkSync(path.join(dir, 'Vortex staging', 'versionlib-1-6-1170-0.bin'), path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'versionlib-1-6-1170-0.bin'))
  const manifest = { files: [
    { path: 'Data/Platform/Plugins/skymp5-client.js', kind: 'dovahzul', sha256: sha('dovakarn client') },
    { path: 'Data/SKSE/Plugins/MpClientPlugin.dll', kind: 'dovahzul', sha256: sha('our version') },
    { path: 'Data/SKSE/Plugins/versionlib-1-6-1170-0.bin', kind: 'dovahzul', sha256: sha('address library') },
  ], mcm: [{ path: 'Data/MCM/Settings/TrueHUD.ini' }] }
  const r = await restoreSkyrim({ skyrimDir: skyrim, manifest })
  assert.deepEqual(r, { removed: 2, returned: 2, unlocked: 1, left: 1, linked: 1, differs: 1 })
  assert.equal(fs.readFileSync(path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'versionlib-1-6-1170-0.bin'), 'utf8'), 'address library', 'Vortex\'s file stays for Vortex')
  assert.match(describe(r), /1 file at Dovakarn's paths has other content, from an older Dovakarn or another multiplayer server, so it was left\. .* 1 file Vortex put there was left for Vortex\./)
  assert.ok(!fs.existsSync(path.join(skyrim, 'Data', 'Platform', 'Plugins', 'skymp5-client.js')))
  assert.ok(!fs.existsSync(path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'DovakarnProfile.dll')))
  assert.equal(fs.readFileSync(path.join(skyrim, 'Data', 'Platform', 'Plugins', 'other-server.js'), 'utf8'), 'another server\'s client', 'another SkyMP server\'s files stay')
  assert.equal(fs.readFileSync(path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'MpClientPlugin.dll'), 'utf8'), 'a different version', 'a same-named file with other content stays')
  assert.equal(fs.readFileSync(path.join(skyrim, 'Data', 'SKSE', 'Plugins', 'MyMod.ini'), 'utf8'), 'mine', 'the first move held the player\'s own file')
  assert.equal(fs.readFileSync(path.join(skyrim, 'Data', 'ccBGSSSE001-Fish.esm'), 'utf8'), 'fish')
  assert.ok(fs.statSync(path.join(skyrim, 'Data', 'MCM', 'Settings', 'TrueHUD.ini')).mode & 0o200)
  assert.ok(!fs.existsSync(path.join(skyrim, 'disabled CC mods')), 'an emptied folder goes')
  assert.ok(fs.existsSync(path.join(skyrim, 'Dovakarn removed files')), 'the second copy that could not go back stays, so nothing is lost')
  assert.match(describe(r), /^Done: removed 2 Dovakarn files, put back 2 files earlier launchers moved out, made 1 mod settings file writable again\. 1 file could not be moved, because it is in use or a file of yours is there now\. It stays where it was\./)
  assert.ok(oldInstallIn(skyrim))
})
