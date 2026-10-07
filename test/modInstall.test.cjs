const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const AdmZip = require('adm-zip')
const modInstall = require('../src/modInstall')
const { HashCache } = require('../src/fileCheck')

const TOOL = path.join(__dirname, '..', 'assets', '7zip', '7z.exe')
// 7z.exe and Windows drive paths: these tests run on Windows only
const SEVEN_ZIP = process.platform !== 'win32' ? 'Windows only (7z.exe)' : !fs.existsSync(TOOL) && '7-Zip is not in assets'
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const crc = bytes => (zlib.crc32(Buffer.from(bytes)) >>> 0).toString(16).toUpperCase().padStart(8, '0')
const scratch = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-mods-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

// A Nexus download as a zip, with an installer layout (a numbered folder, as FOMOD archives have)
function download(dir, name, members) {
  const zip = new AdmZip()
  for (const [member, text] of Object.entries(members)) zip.addFile(member, Buffer.from(text))
  const file = path.join(dir, name)
  zip.writeZip(file)
  const bytes = fs.readFileSync(file)
  return { file, size: bytes.length, md5: md5(bytes) }
}
function fixture(t) {
  const dir = scratch(t)
  const zipped = download(path.join(dir, 'Browser Downloads'), 'SkyUI_5_2_SE-12604-5-2SE.zip', {
    '00 Core/SkyUI_SE.esp': 'skyui plugin', '00 Core/Interface/skyui/config.txt': 'config', 'readme.txt': 'not installed',
  })
  const archive = { id: '35407', modId: 12604, fileId: 35407, name: 'SkyUI', version: '5.2', file: 'SkyUI_5_2_SE-12604-5-2SE.zip', size: zipped.size, md5: zipped.md5 }
  const list = { schema: 1, archives: [archive], files: [
    { path: 'Data/SkyUI_SE.esp', size: 12, crc: crc('skyui plugin'), archive: '35407', member: '00 Core/SkyUI_SE.esp', original: true },
    { path: 'Data/Interface/skyui/config.txt', size: 6, sha256: sha('config'), archive: '35407', member: '00 Core/Interface/skyui/config.txt' },
  ] }
  return { dir, zipped, archive, list, game: path.join(dir, 'Dovakarn', 'Game'), downloads: path.join(dir, 'Dovakarn', 'Downloads') }
}

test('the install list is checked before anything is done with it', () => {
  const ok = { schema: 1, archives: [{ id: '1', modId: 2, fileId: 1, name: 'A', size: 3, md5: 'a'.repeat(32) }], files: [{ path: 'Data/a.esp', size: 1, sha256: 'b'.repeat(64), archive: '1', member: 'a.esp' }] }
  assert.equal(modInstall.validate(ok), ok)
  const bad = change => () => { const list = JSON.parse(JSON.stringify(ok)); change(list); return modInstall.validate(list) }
  assert.throws(bad(l => { l.schema = 2 }), /supported format/)
  assert.throws(bad(l => { l.files[0].path = '../outside.esp' }), /Unsafe file path/)
  assert.throws(bad(l => { l.files[0].member = '../../evil.dll' }), /invalid file/)
  assert.throws(bad(l => { l.files[0].member = 'C:/evil.dll' }), /invalid file/)
  assert.throws(bad(l => { l.files[0].archive = '9' }), /invalid file/)
  assert.throws(bad(l => { l.archives[0].md5 = 'nope' }), /invalid download/)
  assert.throws(bad(l => { l.files[0] = { ...l.files[0], original: true, sha256: undefined, crc: 'xyz' } }), /invalid file/)
  // The download's version and Nexus file name: optional, display only. Never a reason to refuse the whole list: a long
  // one is trimmed (a file name keeps its end, its archive type), one that is not text is dropped
  const named = JSON.parse(JSON.stringify(ok)); Object.assign(named.archives[0], { version: '5.2', file: 'SkyUI_5_2_SE-12604-5-2SE.zip' })
  assert.equal(modInstall.validate(named), named)
  assert.deepEqual([named.archives[0].version, named.archives[0].file], ['5.2', 'SkyUI_5_2_SE-12604-5-2SE.zip'], 'within the caps: unchanged')
  assert.deepEqual(modInstall.CAPS, { version: 80, file: 260 })
  const long = JSON.parse(JSON.stringify(ok)); Object.assign(long.archives[0], { version: 'v'.repeat(200), file: `${'a'.repeat(400)}.7z` })
  const kept = modInstall.validate(long).archives[0]
  assert.deepEqual([kept.version, kept.file.length, kept.file.endsWith('.7z'), modInstall.ARCHIVE.test(kept.file)], ['v'.repeat(80), 260, true, true])
  const odd = JSON.parse(JSON.stringify(ok)); Object.assign(odd.archives[0], { version: 5, file: {} })
  const dropped = modInstall.validate(odd).archives[0]
  assert.deepEqual(['version' in dropped, 'file' in dropped, dropped.name], [false, false, 'A'])
  // The fields a launcher acts on are still checked as strictly as ever
  assert.throws(bad(l => { l.archives[0].name = 5 }), /invalid download/)
  assert.throws(bad(l => { l.archives[0].size = 0 }), /invalid download/)
})

test('a file\'s Nexus page opens on that exact file', () => {
  assert.equal(modInstall.nexusFileUrl({ modId: 12604, fileId: 35407 }), 'https://www.nexusmods.com/skyrimspecialedition/mods/12604?tab=files&file_id=35407')
})

test('a download keeps the Nexus file\'s own ids as its name, with its archive type', async t => {
  const archive = { modId: 62775, fileId: 454617 }
  assert.equal(modInstall.downloadName(archive, 'TrueHUD-62775-1-1-9-1703382929.7z'), '62775-454617.7z')
  assert.equal(modInstall.downloadName(archive, 'TRUEHUD.ZIP'), '62775-454617.zip')
  assert.equal(modInstall.downloadName(archive, 'TrueHUD.rar'), '62775-454617.rar')
  assert.equal(modInstall.downloadName(archive, '1700000000-1.download'), '62775-454617.7z', 'no archive type: 7z')
  assert.equal(modInstall.downloadName(archive, ''), '62775-454617.7z')
  assert.equal(modInstall.ARCHIVE.test('a.7z'), true)
  assert.equal(modInstall.NEXUS_GAME, 'skyrimspecialedition')
  const file = path.join(scratch(t), 'bytes.bin')
  fs.writeFileSync(file, 'the bytes Nexus sent')
  assert.equal(await modInstall.hashFile(file, 'md5'), '9c02b38b095f18123a9d0fe92a72d3b9')
})

test('a download is found by size and MD5 whatever its name, never a partial one, and kept as a copy', async t => {
  const f = fixture(t), browser = path.dirname(f.zipped.file)
  put(path.join(browser, 'same size.zip.crdownload'), Buffer.alloc(f.archive.size))
  put(path.join(browser, 'same size other.zip'), Buffer.alloc(f.archive.size))
  const finder = new modInstall.DownloadFinder({ dirs: [path.join(f.dir, 'nowhere'), browser], cacheFile: path.join(f.dir, 'md5.json') })
  const found = await finder.find(f.archive)
  assert.equal(found, f.zipped.file)
  finder.save()
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir, 'md5.json'), 'utf8'))).length >= 2)
  const kept = await modInstall.keepDownload(found, f.archive, f.downloads)
  assert.equal(path.basename(kept), '12604-35407.zip')
  assert.ok(fs.existsSync(f.zipped.file), 'the player\'s own download stays where it was')
  assert.equal(await finder.find({ ...f.archive, md5: 'f'.repeat(32) }), null)
})

test('each folder is listed once per check, off the main thread; one that does not answer in time is skipped, never waited on', async t => {
  const f = fixture(t), browser = path.dirname(f.zipped.file), hung = path.join(f.dir, 'Offline NAS'), nowhere = path.join(f.dir, 'nowhere')
  // A network share that went offline: its listing never answers
  const calls = [], logs = []
  const fsp = {
    readdir: dir => { calls.push(dir); return dir === hung ? new Promise(() => {}) : fs.promises.readdir(dir) },
    stat: file => fs.promises.stat(file),
  }
  const finder = new modInstall.DownloadFinder({ dirs: [hung, nowhere, browser], cacheFile: path.join(f.dir, 'md5.json'), timeout: 50, fsp, log: line => logs.push(line) })
  let ticked = false
  setImmediate(() => { ticked = true })
  const started = Date.now()
  assert.equal(await finder.find(f.archive), f.zipped.file, 'found in the next folder')
  assert.ok(ticked, 'the launcher kept running while the folder did not answer')
  assert.ok(Date.now() - started < 2000, 'not waited on')
  // A second download looked for in the same check: no folder is listed again, and the offline one is not waited on again
  const again = Date.now()
  assert.equal(await finder.find({ ...f.archive, md5: 'f'.repeat(32) }), null)
  assert.ok(Date.now() - again < 40)
  assert.deepEqual(calls, [hung, nowhere, browser], 'each folder listed once')
  assert.deepEqual(logs, [`[game] ${hung} gave no answer for 0.05 seconds: not looked in for this check`], 'a missing folder is not news')
  assert.deepEqual(finder.skipped, [hung], 'the skipped folder is named, for the mods window')
  // The next check: the folder's read is still waiting on it, so that check joins it rather than reading it a second time,
  // and skips it the same way
  const next = new modInstall.DownloadFinder({ dirs: [hung, browser], cacheFile: '', timeout: 50, fsp })
  assert.equal(await next.find(f.archive), f.zipped.file)
  assert.deepEqual([calls.filter(d => d === hung).length, next.skipped], [1, [hung]], 'one read of it across checks')
  // A missing folder has nothing; partial downloads are never listed
  assert.deepEqual(await modInstall.listFolder(nowhere), [])
  put(path.join(browser, 'x.zip.crdownload'), 'part')
  assert.deepEqual((await modInstall.listFolder(browser)).map(e => [path.basename(e.file), e.size]), [[path.basename(f.zipped.file), f.zipped.size]])
  assert.equal(modInstall.LIST_TIMEOUT, 3000, 'three seconds for a real folder')
  // Cancel stops the search before the next folder
  const abort = new AbortController(); abort.abort()
  await assert.rejects(new modInstall.DownloadFinder({ dirs: [browser], cacheFile: '' }).find(f.archive, abort.signal), e => e.code === 'CANCELLED')
})

test('a big folder that keeps answering is read to its end; one that stops answering partway is given up on, and its read stops there', async t => {
  const dir = path.join(scratch(t), 'Big Vortex Downloads'), names = Array.from({ length: 64 * 5 }, (_, i) => `mod ${String(i).padStart(3, '0')}.7z`)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  // Each part of 64 files answers in 30 ms: 150 ms in all, three times the 50 ms limit, yet never 50 ms without an answer
  const stats = []
  const slow = {
    readdir: async () => { await wait(30); return names },
    stat: async file => { stats.push(file); if (stats.length % 64 === 1) await wait(30); return { isFile: () => true, size: 7, mtimeMs: 1 } },
  }
  const started = Date.now(), all = await modInstall.listFolder(dir, { timeout: 50, fsp: slow })
  assert.ok(Date.now() - started >= 150, 'longer than the limit in all')
  assert.equal(all?.length, names.length, 'read to its end')
  // A folder that answers its listing and its first 64 files, then stops answering: given up on after 50 ms with nothing...
  const held = [], calls = []
  const stalls = {
    readdir: async () => { calls.push('readdir'); return names },
    stat: () => { calls.push('stat'); return calls.length <= 65 ? Promise.resolve({ isFile: () => true, size: 7, mtimeMs: 1 }) : new Promise(resolve => held.push(() => resolve({ isFile: () => true, size: 7, mtimeMs: 1 }))) },
  }
  const other = path.join(path.dirname(dir), 'NAS mods')
  assert.equal(await modInstall.listFolder(other, { timeout: 50, fsp: stalls }), null)
  const asked = calls.length
  assert.equal(asked, 1 + 64 + 64, 'the listing, the first part, and the part that stalled')
  // A second check meanwhile joins the read still waiting, rather than starting another
  assert.equal(await modInstall.listFolder(other, { timeout: 50, fsp: stalls }), null)
  assert.equal(calls.length, asked, 'one read of the folder at a time')
  // ...and once that part answers after all, the read stops instead of going on through the folder nobody waits for
  for (const answer of held) answer()
  await wait(20)
  assert.equal(calls.length, asked, 'nothing more is read')
  // The next check reads it afresh: the stopped read is not kept
  calls.length = 0
  const fresh = { readdir: async () => { calls.push('readdir'); return ['a.7z'] }, stat: async () => ({ isFile: () => true, size: 1, mtimeMs: 1 }) }
  assert.deepEqual((await modInstall.listFolder(other, { timeout: 50, fsp: fresh })).map(e => path.basename(e.file)), ['a.7z'])
  assert.deepEqual(calls, ['readdir'])
})

test('what is remembered of a folder\'s files can be dropped, and a check keeps only what it remembers of folders still looked in', async t => {
  const dir = scratch(t), cache = path.join(dir, 'md5s.json'), keep = path.join(dir, 'Downloads'), gone = path.join(dir, 'NAS mods')
  const entry = (folder, name) => [path.join(folder, name).toLowerCase(), { stamp: '1:1', md5: 'a'.repeat(32) }]
  fs.writeFileSync(cache, JSON.stringify(Object.fromEntries([entry(keep, 'a.7z'), entry(gone, 'b.7z'), entry(gone, 'c.7z'), entry(path.join(gone, 'sub'), 'd.7z')])))
  assert.equal(modInstall.forgetFolderMd5s(cache, gone.toUpperCase()), true, 'the same folder in other letters')
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8'))), [entry(keep, 'a.7z')[0], entry(path.join(gone, 'sub'), 'd.7z')[0]], 'only that folder\'s own files')
  assert.equal(modInstall.forgetFolderMd5s(cache, gone), false, 'nothing more to drop: the file is not rewritten')
  assert.equal(modInstall.forgetFolderMd5s(path.join(dir, 'none.json'), gone), false, 'no file: nothing to do')
  // A finder saves only what it remembers of the folders still looked in when it saves
  let folders = [keep, gone]
  fs.writeFileSync(cache, JSON.stringify(Object.fromEntries([entry(keep, 'a.7z'), entry(gone, 'b.7z')])))
  const finder = new modInstall.DownloadFinder({ dirs: [keep, gone], cacheFile: cache, keepFolders: () => folders })
  folders = [keep]                                               // forgotten while the check ran
  finder.save()
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8'))), [entry(keep, 'a.7z')[0]])
  // Without keepFolders it keeps everything; a cache that is not an object starts empty
  fs.writeFileSync(cache, '[1,2]')
  const plainFinder = new modInstall.DownloadFinder({ dirs: [keep], cacheFile: cache })
  assert.deepEqual(plainFinder.md5s, {})
})

test('the plan lists what the copy still needs; an original counts once it exists, whatever it holds now', async t => {
  const f = fixture(t), cache = new HashCache(path.join(f.dir, 'hashes.json'))
  let plan = await modInstall.plan({ gameDir: f.game, list: f.list, hashCache: cache })
  assert.deepEqual([plan.done, plan.total, plan.archives.map(a => [a.id, a.files])], [0, 2, [['35407', 2]]])
  put(path.join(f.game, 'Data', 'SkyUI_SE.esp'), 'patched by the player file list')
  put(path.join(f.game, 'Data', 'Interface', 'skyui', 'config.txt'), 'config')
  plan = await modInstall.plan({ gameDir: f.game, list: f.list, hashCache: cache })
  assert.deepEqual([plan.done, plan.archives.length], [2, 0])
  fs.writeFileSync(path.join(f.game, 'Data', 'Interface', 'skyui', 'config.txt'), 'CONFIG')
  plan = await modInstall.plan({ gameDir: f.game, list: f.list, hashCache: cache })
  assert.deepEqual([plan.done, plan.archives.map(a => a.files)], [1, [1]])
})

test('a download is unpacked and only its listed files go in, each checked; a read-only target is replaced', { skip: SEVEN_ZIP }, async t => {
  const f = fixture(t)
  put(path.join(f.game, 'Data', 'Interface', 'skyui', 'config.txt'), 'old')
  fs.chmodSync(path.join(f.game, 'Data', 'Interface', 'skyui', 'config.txt'), 0o444)
  const n = await modInstall.installArchive({ tool: TOOL, archivePath: f.zipped.file, archive: f.archive, files: f.list.files, gameDir: f.game, workDir: path.join(f.downloads, '.unpack') })
  assert.equal(n, 2)
  assert.equal(fs.readFileSync(path.join(f.game, 'Data', 'SkyUI_SE.esp'), 'utf8'), 'skyui plugin')
  assert.equal(fs.readFileSync(path.join(f.game, 'Data', 'Interface', 'skyui', 'config.txt'), 'utf8'), 'config')
  assert.ok(!fs.existsSync(path.join(f.game, 'readme.txt')), 'files the list does not name stay out')
  assert.deepEqual(fs.readdirSync(path.join(f.downloads, '.unpack')), [], 'the work folder is cleaned')
})

test('a download that is not the server\'s file stops with its name, and nothing half-done is left', { skip: SEVEN_ZIP }, async t => {
  const f = fixture(t)
  const wrong = download(path.join(f.dir, 'Other'), 'skyui.zip', { '00 Core/SkyUI_SE.esp': 'skyui plugin', '00 Core/Interface/skyui/config.txt': 'tampered' })
  await assert.rejects(modInstall.installArchive({ tool: TOOL, archivePath: wrong.file, archive: f.archive, files: f.list.files, gameDir: f.game, workDir: path.join(f.downloads, '.unpack') }),
    /00 Core\/Interface\/skyui\/config.txt in SkyUI is not the server's file/)
  assert.ok(!fs.existsSync(path.join(f.game, 'Data', 'Interface', 'skyui', 'config.txt')))
  assert.deepEqual(fs.readdirSync(path.join(f.downloads, '.unpack')), [])
})

test('a download 7-Zip cannot unpack is named in plain words; 7-Zip\'s own error goes to the log', { skip: SEVEN_ZIP }, async t => {
  const f = fixture(t), broken = path.join(f.dir, 'Browser Downloads', 'broken.7z'), said = []
  put(broken, 'these bytes are not an archive')
  await assert.rejects(modInstall.installArchive({ tool: TOOL, archivePath: broken, archive: f.archive, files: f.list.files, gameDir: f.game, workDir: path.join(f.downloads, '.unpack'), log: line => said.push(line) }),
    e => e.message === '7-Zip could not unpack SkyUI. The download may be damaged.')
  assert.equal(said.length, 1)
  assert.match(said[0], /^\[game\] 7-Zip could not unpack SkyUI: \S/)
  assert.deepEqual(fs.readdirSync(path.join(f.downloads, '.unpack')), [], 'nothing half-done is left')
})

test('Cancel stops an install before it unpacks', { skip: SEVEN_ZIP }, async t => {
  const f = fixture(t), abort = new AbortController()
  abort.abort()
  await assert.rejects(modInstall.installArchive({ tool: TOOL, archivePath: f.zipped.file, archive: f.archive, files: f.list.files, gameDir: f.game, workDir: path.join(f.downloads, '.unpack'), signal: abort.signal }), e => e.code === 'CANCELLED')
  assert.ok(!fs.existsSync(path.join(f.game, 'Data', 'SkyUI_SE.esp')))
})

test('the player\'s Vortex download folders: its default and the one beside the staging folder their Skyrim names', t => {
  const dir = scratch(t), skyrim = path.join(dir, 'Skyrim'), staging = path.join(dir, 'V', 'skyrimse', 'mods')
  put(path.join(skyrim, 'Data', 'vortex.deployment.json'), JSON.stringify({ stagingPath: staging, files: [] }))
  assert.deepEqual(modInstall.vortexDownloadDirs({ appData: path.join(dir, 'AppData'), skyrimDir: skyrim }),
    [path.join(dir, 'AppData', 'Vortex', 'downloads', 'skyrimse'), path.join(dir, 'V', 'downloads', 'skyrimse')])
  assert.deepEqual(modInstall.vortexDownloadDirs({ appData: path.join(dir, 'AppData'), skyrimDir: path.join(dir, 'none') }), [path.join(dir, 'AppData', 'Vortex', 'downloads', 'skyrimse')])
})
