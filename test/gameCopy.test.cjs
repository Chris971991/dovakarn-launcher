const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const gameCopy = require('../src/gameCopy')
const gameProfile = require('../src/gameProfile')

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const scratch = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dovakarn-copy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir }
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

// A small stand-in for the 46 files of 1.6.1170: the exe, masters, an archive and a Creation Club plugin with its archive
const CONTENT = {
  'SkyrimSE.exe': 'exe 1.6.1170', 'Data/Skyrim.esm': 'skyrim master', 'Data/Update.esm': 'update master',
  'Data/Skyrim - Misc.bsa': 'misc archive', 'Data/ccBGSSSE001-Fish.esm': 'fish plugin', 'Data/ccBGSSSE001-Fish.bsa': 'fish archive',
  'Data/MarketplaceTextures.bsa': 'marketplace', 'Skyrim/SkyrimPrefs.ini': '[Display]\r\niSize W=1280\r\n', 'Skyrim_Default.ini': '[General]\r\nsLanguage=ENGLISH\r\n',
  // Steam's own Skyrim.ccc names every Creation Club plugin; the copy writes its own instead
  'Skyrim.ccc': 'ccBGSSSE001-Fish.esm\r\nccQDRSSE001-SurvivalMode.esl\r\n',
}
const DEPOT_OF = { 'SkyrimSE.exe': '3', 'Data/Skyrim.esm': '2', 'Data/Update.esm': '2', 'Skyrim/SkyrimPrefs.ini': '2', 'Skyrim_Default.ini': '2', 'Skyrim.ccc': '2' }
const REF = { app: '9', exeVersion: '1.6.1170.0', depots: [{ id: '1', manifest: '11' }, { id: '2', manifest: '22' }, { id: '3', manifest: '33' }],
  files: Object.entries(CONTENT).map(([p, text]) => ({ path: p, depot: DEPOT_OF[p] || '1', size: Buffer.byteLength(text), sha256: sha(text) })) }

// A Steam library holding the three depots as download_depot leaves them
function depots(root, content = CONTENT) {
  for (const f of REF.files) put(path.join(root, 'steamapps', 'content', 'app_9', `depot_${f.depot}`, ...f.path.split('/')), content[f.path])
  return gameCopy.findDepots([root], REF)
}
function steamFolder(dir, content = CONTENT) { for (const [p, text] of Object.entries(content)) put(path.join(dir, ...p.split('/')), text); return dir }

test('depot commands are the three download_depot lines for the player to type', () => {
  assert.deepEqual(gameCopy.depotCommands(REF).map(c => c.command), ['download_depot 9 1 11', 'download_depot 9 2 22', 'download_depot 9 3 33'])
  // The real reference: Skyrim SE 1.6.1170's own manifests, 46 files
  assert.equal(gameCopy.REF.files.length, 46)
  assert.deepEqual(gameCopy.depotCommands().map(c => c.command), ['download_depot 489830 489831 8442952117333549665', 'download_depot 489830 489832 8042843504692938467', 'download_depot 489830 489833 1914580699073641964'])
})

test('Creation Club files are wanted only when the server loads their plugin; MarketplaceTextures never', () => {
  const names = loadOrder => gameCopy.wantedFiles(loadOrder, REF).map(f => f.path)
  assert.deepEqual(names(['Skyrim.esm', 'Update.esm']), ['SkyrimSE.exe', 'Data/Skyrim.esm', 'Data/Update.esm', 'Data/Skyrim - Misc.bsa', 'Skyrim/SkyrimPrefs.ini', 'Skyrim_Default.ini'])
  assert.ok(names(['Skyrim.esm', 'Data/ccBGSSSE001-Fish.esm']).includes('Data/ccBGSSSE001-Fish.bsa'))
  assert.ok(!names(['Skyrim.esm', 'Data/ccBGSSSE001-Fish.esm']).includes('Data/MarketplaceTextures.bsa'))
})

test('Steam libraries come from the client folder and its libraryfolders.vdf', t => {
  const dir = scratch(t), client = path.join(dir, 'Steam'), lib = path.join(dir, 'Games')
  put(path.join(client, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${client.replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib.replace(/\\/g, '\\\\')}"\n\t}\n}\n`)
  assert.deepEqual(gameCopy.steamRoots([client]).map(r => r.toLowerCase()), [client, lib].map(r => path.resolve(r).toLowerCase()))
})

test('the copy is made from the depots by copying when they are on another drive, and every file is checked', async t => {
  const dir = scratch(t), game = path.join(dir, 'Dovakarn', 'Game'), seen = []
  const depotDirs = depots(path.join(dir, 'Steam'))
  const result = await gameCopy.build({ gameDir: game, depotDirs, loadOrder: ['Skyrim.esm'], ref: REF, onProgress: p => seen.push(p), move: false })
  assert.ok(fs.existsSync(path.join(depotDirs['2'], 'Data', 'Skyrim.esm')), 'copied: the depot keeps its file')
  assert.equal(result.copied, 6)
  for (const f of gameCopy.wantedFiles(['Skyrim.esm'], REF)) assert.equal(fs.readFileSync(path.join(game, ...f.path.split('/')), 'utf8'), CONTENT[f.path])
  assert.ok(gameCopy.isReady(game), 'the marker is written last')
  assert.equal(fs.readFileSync(path.join(game, 'Skyrim.ccc'), 'utf8'), '', 'no Creation Club content: an empty Skyrim.ccc')
  assert.ok(!fs.existsSync(path.join(game, 'Data', 'ccBGSSSE001-Fish.esm')))
  assert.ok(fs.existsSync(gameCopy.profileDirOf(game)))
  assert.equal(seen.at(-1).done, 6)
  assert.ok(seen.every(p => p.received <= p.bytes))
})

test('depot files on the same drive move (nothing to copy twice), and are checked where they land', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), depotDirs = depots(path.join(dir, 'Steam'))
  await gameCopy.build({ gameDir: game, depotDirs, loadOrder: ['Skyrim.esm', 'ccBGSSSE001-Fish.esm'], ref: REF })
  assert.ok(!fs.existsSync(path.join(depotDirs['2'], 'Data', 'Skyrim.esm')), 'moved out of the depot')
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'Skyrim.esm'), 'utf8'), 'skyrim master')
  assert.equal(fs.readFileSync(path.join(game, 'Skyrim.ccc'), 'utf8'), 'ccBGSSSE001-Fish.esm\r\n', 'Skyrim.ccc names the Creation Club plugin the server loads')
})

test('a finished copy made from moved depot files checks clean every time after: nothing copied, marker and Skyrim.ccc untouched', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), depotDirs = depots(path.join(dir, 'Steam'))
  await gameCopy.build({ gameDir: game, depotDirs, loadOrder: ['ccBGSSSE001-Fish.esm'], ref: REF })
  assert.ok(!fs.existsSync(path.join(depotDirs['2'], 'Data', 'Skyrim.esm')), 'moved: the depots no longer have the files')
  const marker = path.join(game, gameCopy.MARKER), ccc = path.join(game, 'Skyrim.ccc')
  const past = new Date(Date.now() - 3600000)
  fs.utimesSync(marker, past, past); fs.utimesSync(ccc, past, past)
  const again = await gameCopy.build({ gameDir: game, depotDirs, loadOrder: ['ccBGSSSE001-Fish.esm'], ref: REF })
  assert.deepEqual([again.copied, again.kept], [0, gameCopy.wantedFiles(['ccBGSSSE001-Fish.esm'], REF).length], 'every wanted file already right')
  assert.ok(!gameCopy.wantedFiles(['ccBGSSSE001-Fish.esm'], REF).some(f => f.path === 'Skyrim.ccc'), 'Skyrim.ccc is never copied')
  assert.equal(fs.statSync(marker).mtimeMs, past.getTime(), 'the marker is not rewritten')
  assert.equal(fs.statSync(ccc).mtimeMs, past.getTime(), 'Skyrim.ccc is not rewritten')
  assert.equal(fs.readFileSync(ccc, 'utf8'), 'ccBGSSSE001-Fish.esm\r\n', 'the copy\'s own Skyrim.ccc, never Steam\'s')
  assert.ok(gameCopy.isReady(game))
})

test('Cancel while a depot file is checked leaves it in the depot', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), depotDirs = depots(path.join(dir, 'Steam')), abort = new AbortController()
  await assert.rejects(gameCopy.build({ gameDir: game, depotDirs, loadOrder: [], ref: REF, signal: abort.signal, onProgress: p => { if (p.file === 'Data/Skyrim.esm') abort.abort() } }), e => e.code === 'CANCELLED')
  assert.equal(fs.readFileSync(path.join(depotDirs['2'], 'Data', 'Skyrim.esm'), 'utf8'), 'skyrim master', 'still where Steam put it')
  assert.ok(!fs.existsSync(path.join(game, 'Data', 'Skyrim.esm')))
  assert.deepEqual(fs.readdirSync(game, { recursive: true }).filter(n => n.endsWith('.dovakarn-part')), [])
  // The next run picks up where it stopped
  await gameCopy.build({ gameDir: game, depotDirs, loadOrder: [], ref: REF })
  assert.ok(gameCopy.isReady(game))
})

test('a vanilla file one of the server\'s mods replaces is left as the mod made it', async t => {
  const dir = scratch(t), steam = steamFolder(path.join(dir, 'Steam Skyrim')), game = path.join(dir, 'Game')
  await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF })
  fs.writeFileSync(path.join(game, 'Skyrim_Default.ini'), '[General]\r\nsLanguage=ENGLISH\r\nbModded=1\r\n')
  const managed = new Set(['skyrim_default.ini'])
  assert.equal(gameCopy.assess({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, managed }).todo, 0)
  const again = await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, managed })
  assert.equal(again.copied, 0)
  assert.match(fs.readFileSync(path.join(game, 'Skyrim_Default.ini'), 'utf8'), /bModded=1/)
  // Gone altogether, the vanilla file comes back until the mod puts its own in again
  fs.rmSync(path.join(game, 'Skyrim_Default.ini'))
  assert.equal((await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, managed })).copied, 1)
})

test('a 1.6.1170 Steam folder is only read: copied from, never changed', async t => {
  const dir = scratch(t), steam = steamFolder(path.join(dir, 'Steam Skyrim')), game = path.join(dir, 'Game')
  const before = fs.readdirSync(steam, { recursive: true }).sort().join('|')
  await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF })
  assert.equal(fs.readdirSync(steam, { recursive: true }).sort().join('|'), before)
  assert.equal(fs.readFileSync(path.join(steam, 'Data', 'Skyrim.esm'), 'utf8'), 'skyrim master')
  assert.ok(gameCopy.isReady(game))
})

test('a wrong file stops the copy, keeps the depot file, and leaves no half-written file', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), depotDirs = depots(path.join(dir, 'Steam'), { ...CONTENT, 'Data/Update.esm': 'update mastes' })
  await assert.rejects(gameCopy.build({ gameDir: game, depotDirs, loadOrder: [], ref: REF }),
    e => e.code === 'NEEDS_DEPOTS' && /^Steam's 1\.6\.1170 download of Data\/Update\.esm is not complete yet/.test(e.message))
  assert.ok(fs.existsSync(path.join(depotDirs['2'], 'Data', 'Update.esm')), 'put back in the depot')
  assert.ok(!fs.existsSync(path.join(game, 'Data', 'Update.esm')))
  assert.deepEqual(fs.readdirSync(path.join(game, 'Data')).filter(n => n.endsWith('.dovakarn-part')), [])
  assert.ok(!gameCopy.isReady(game), 'not marked finished')
})

test('a Steam folder on another version (different sizes) is not a source: the depots are needed', async t => {
  const dir = scratch(t), steam = steamFolder(path.join(dir, 'Steam Skyrim'), { ...CONTENT, 'SkyrimSE.exe': 'exe 1.7.104 is bigger' })
  const plan = gameCopy.assess({ gameDir: path.join(dir, 'Game'), steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF })
  assert.deepEqual(plan.missing, ['SkyrimSE.exe'])
  await assert.rejects(gameCopy.build({ gameDir: path.join(dir, 'Game'), steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF }), e => e.code === 'NEEDS_DEPOTS')
})

test('a file a mod changed in the player\'s Skyrim (same size) falls back to the depot, else asks for the depots, and is left out until it changes', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), changed = { ...CONTENT, 'Data/Update.esm': 'update mastes' }
  const steam = steamFolder(path.join(dir, 'Steam Skyrim'), changed), steamUpdate = path.join(steam, 'Data', 'Update.esm'), refused = new Map()
  // No depots: nothing else has the file, so the depots are asked for and the Steam file is only read
  await assert.rejects(gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, refused }),
    e => e.code === 'NEEDS_DEPOTS' && /^Data\/Update\.esm in your Skyrim folder is not Skyrim 1\.6\.1170's own file\. A mod may have changed it, so Dovakarn needs Steam's 1\.6\.1170 download\.$/.test(e.message) && !/[()]/.test(e.message))
  assert.equal(fs.readFileSync(steamUpdate, 'utf8'), 'update mastes')
  assert.ok(!gameCopy.isReady(game))
  // The setup window now asks for the depots, naming the changed file
  const plan = gameCopy.assess({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, refused })
  assert.deepEqual(plan.missing, ['Data/Update.esm'])
  assert.deepEqual(plan.wanted.find(w => w.path === 'Data/Update.esm').refused, ['steam'])
  // A second build fails before copying anything, with the same reason
  await assert.rejects(gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, refused }), /A mod may have changed it, so Dovakarn needs Steam's 1\.6\.1170 download/)
  // With the depots downloaded the copy completes, the changed file from the depot
  const depotDirs = depots(path.join(dir, 'Steam'))
  await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs, loadOrder: [], ref: REF, refused, move: false })
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'Update.esm'), 'utf8'), 'update master')
  assert.ok(gameCopy.isReady(game))
  // Steam putting its own file back makes it a source again
  fs.writeFileSync(steamUpdate, 'update master'); fs.utimesSync(steamUpdate, new Date(), new Date(Date.now() + 60000))
  assert.deepEqual(gameCopy.assess({ gameDir: path.join(dir, 'Game 2'), steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF, refused }).missing, [])
})

test('a depot file that does not match yet (Steam still downloading) falls back to a 1.6.1170 Steam folder, and stays in the depot', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), steam = steamFolder(path.join(dir, 'Steam Skyrim'))
  const depotDirs = depots(path.join(dir, 'Steam'), { ...CONTENT, 'Data/Update.esm': 'update mastes' })
  await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs, loadOrder: [], ref: REF })
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'Update.esm'), 'utf8'), 'update master')
  assert.equal(fs.readFileSync(path.join(depotDirs['2'], 'Data', 'Update.esm'), 'utf8'), 'update mastes', 'put back where Steam left it')
  assert.ok(gameCopy.isReady(game))
})

test('a finished copy is repaired file by file, and Creation Club files the server dropped leave it', async t => {
  const dir = scratch(t), steam = steamFolder(path.join(dir, 'Steam Skyrim')), game = path.join(dir, 'Game')
  await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: ['ccBGSSSE001-Fish.esm'], ref: REF })
  fs.writeFileSync(path.join(game, 'Data', 'Update.esm'), 'damaged!!!!!!')
  const again = await gameCopy.build({ gameDir: game, steamDir: steam, depotDirs: {}, loadOrder: [], ref: REF })
  assert.equal(again.copied, 1)
  assert.equal(fs.readFileSync(path.join(game, 'Data', 'Update.esm'), 'utf8'), 'update master')
  assert.ok(!fs.existsSync(path.join(game, 'Data', 'ccBGSSSE001-Fish.esm')))
  assert.equal(fs.readFileSync(path.join(game, 'Skyrim.ccc'), 'utf8'), '')
})

test('Cancel stops the copy and leaves it unfinished', async t => {
  const dir = scratch(t), game = path.join(dir, 'Game'), abort = new AbortController()
  abort.abort()
  await assert.rejects(gameCopy.build({ gameDir: game, steamDir: steamFolder(path.join(dir, 'S')), depotDirs: {}, loadOrder: [], ref: REF, signal: abort.signal }), e => e.code === 'CANCELLED')
  assert.ok(!gameCopy.isReady(game))
})

test('the copy\'s Plugins.txt is the server\'s plugins in order, written only when it changes', t => {
  const game = path.join(scratch(t), 'Game')
  assert.equal(gameProfile.writeLoadOrder(game, ['Skyrim.esm', 'Update.esm', 'Data/SkyUI_SE.esp', 'DovakarnRules.esp']), true)
  assert.equal(fs.readFileSync(gameProfile.pluginsFileOf(game), 'utf8'), '*SkyUI_SE.esp\r\n*DovakarnRules.esp\r\n')
  assert.equal(gameProfile.writeLoadOrder(game, ['Skyrim.esm', 'SkyUI_SE.esp', 'DovakarnRules.esp']), false)
  assert.ok(gameProfile.pluginsFileOf(game).includes(path.join('Dovakarn Profile', 'AppData', 'Skyrim Special Edition')))
})

test('the copy\'s INIs start as the player\'s own, else the game\'s defaults, then stay the copy\'s; Bethesda.net is off', t => {
  const dir = scratch(t), game = steamFolder(path.join(dir, 'Game')), myGames = path.join(dir, 'My Games')
  put(path.join(myGames, 'SkyrimPrefs.ini'), '[Display]\r\niSize W=3440\r\n')
  const seeded = gameProfile.seedInis(game, myGames)
  assert.deepEqual(seeded, [{ name: 'Skyrim.ini', from: 'defaults' }, { name: 'SkyrimPrefs.ini', from: 'yours' }, { name: 'SkyrimCustom.ini', from: 'empty' }])
  const profile = gameCopy.profileDirOf(game)
  assert.match(fs.readFileSync(path.join(profile, 'SkyrimPrefs.ini'), 'utf8'), /iSize W=3440/)
  assert.match(fs.readFileSync(path.join(profile, 'Skyrim.ini'), 'utf8'), /sLanguage=ENGLISH[\s\S]*\[Bethesda\.net\]\r\nbEnablePlatform=0/)
  // The player's own files are only read
  assert.equal(fs.readFileSync(path.join(myGames, 'SkyrimPrefs.ini'), 'utf8'), '[Display]\r\niSize W=3440\r\n')
  // Later changes the game made to the copy's INIs stay; the next seed adds nothing and does not rewrite them
  fs.writeFileSync(path.join(profile, 'SkyrimPrefs.ini'), '[Display]\r\niSize W=1920\r\n')
  const stamp = fs.statSync(path.join(profile, 'Skyrim.ini')).mtimeMs
  assert.deepEqual(gameProfile.seedInis(game, myGames), [])
  assert.match(fs.readFileSync(path.join(profile, 'SkyrimPrefs.ini'), 'utf8'), /iSize W=1920/)
  assert.equal(fs.statSync(path.join(profile, 'Skyrim.ini')).mtimeMs, stamp)
})
