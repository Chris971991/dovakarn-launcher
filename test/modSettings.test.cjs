// 'dovahzul' in these fixtures is the server's name for Dovakarn's own files in its player file list.
// Mod settings locked to the server's (modSettings.js, fileCheck.js): repaired by settings, the player's keys written,
// the mod menus' settings files made read-only, and files the server does not use moved out of the game.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { checkGameFiles, describeFileList } = require('../src/fileCheck')
const ini = require('../src/ini')
const { REMOVED, SERVER_GAME, validKey, keyValuesByFile, gameKeyValues, gameKeySettings } = require('../src/modSettings')

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const entry = (p, text, extra) => ({ path: p, size: Buffer.byteLength(text), sha256: sha(Buffer.from(text)), critical: /\.(esp|esm|esl|dll)$/i.test(p), ...extra })
// A locked INI as the server's file-list builder lists it: config, with the server's settings
const locked = (p, text, extra) => entry(p, text, { config: true, ini: ini.settings(text), ...extra })

async function serve(t, manifest) {
  const srv = http.createServer((req, res) => { if (req.url === '/list.json') return res.end(JSON.stringify(manifest)); res.statusCode = 404; res.end() })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.address().port}`
  return { manifestUrl: `${base}/list.json`, filesUrl: `${base}/files` }
}
function game(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-modsettings-')), staging = `${dir}-staging`, home = `${dir}-launcher`
  t.after(() => { for (const d of [dir, staging, home]) fs.rmSync(d, { recursive: true, force: true }) })
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); try { fs.chmodSync(file, 0o666) } catch {} fs.writeFileSync(file, text) }
  return {
    dir, staging,
    // The launcher's own folder: the hash cache, and the clean copies kept beside it
    cache: path.join(home, 'game-file-hashes.json'),
    put: (rel, text) => write(path.join(dir, rel), text),
    stage: (mod, rel, text) => write(path.join(staging, mod, rel), text),
    read: rel => fs.readFileSync(path.join(dir, rel), 'utf8'),
    exists: rel => fs.existsSync(path.join(dir, rel)),
    readOnly: rel => (fs.statSync(path.join(dir, rel)).mode & 0o200) === 0,
    vortex: () => write(path.join(dir, 'Data/vortex.deployment.json'), JSON.stringify({ stagingPath: staging, files: [] })),
  }
}

const SERVER_INI = '; Tweaks, as the server has it\r\n[Fixes]\r\nbFixA = true\r\nbFixB = false\r\n'
const TWEAKS = 'Data/SKSE/Plugins/Tweaks.ini'

test('ini.matchSettings gives a file the server\'s settings and keeps everything else in it', () => {
  const target = ini.settings('[Fixes]\nbFixA=true\nbFixB=false\n[New]\nfValue=1.5\n')
  const player = '\uFEFF; my notes\r\n[Fixes]\r\nbFixA = true ; kept as it is\r\nbFixA = false\r\nBFIXB = true\r\nbExtra = 1\r\n[Old]\r\nsGone = x\r\n'
  const out = ini.matchSettings(player, target)
  assert.equal(out, '; my notes\r\n[Fixes]\r\nbFixA=true\r\nBFIXB=false\r\n[Old]\r\n\r\n[new]\r\nfvalue=1.5\r\n',
    'a value with a comment after it is a different value, as the mods read it; the first of a repeated key keeps its line and the rest go; ' +
    'a wrong value is set on its own spelling; extra keys go; comments and CRLF stay')
  assert.equal(ini.sameSettings(ini.settings(out), target), true)
  const clean = ini.matchSettings('[Fixes]\nbFixA = true\n', target)
  assert.equal(ini.sameSettings(ini.settings(clean), target), true)
  assert.equal(clean, '[Fixes]\nbFixA = true\nbfixb=false\n\n[new]\nfvalue=1.5\n', 'a line already right is left exactly as it was')
  assert.equal(ini.matchSettings('', { '': { top: '1' }, s: { k: 'v' } }), 'top=1\r\n\r\n[s]\r\nk=v\r\n', 'a missing file is written from the settings alone')
  assert.equal(ini.matchSettings('; only a note', { '': { top: '1' } }), '; only a note\r\ntop=1\r\n')
})

test('a locked INI with the server\'s settings in other bytes is left alone', async t => {
  const g = game(t)
  g.put(TWEAKS, '[fixes]\nBFIXA=true\n\n\nbFixB   =   false\n')
  const urls = await serve(t, { schema: 1, files: [locked(TWEAKS, SERVER_INI, { kind: 'mod', mod: 'Tweaks' })] })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual([result.patched, result.mods, result.blocked], [[], [], false])
  assert.equal(g.read(TWEAKS), '[fixes]\nBFIXA=true\n\n\nbFixB   =   false\n', 'nothing was written')
})

test('a changed mod setting is put back: from staging, from the copy kept last time, or by rewriting its settings', async t => {
  const g = game(t), list = { schema: 1, files: [locked(TWEAKS, SERVER_INI, { kind: 'mod', mod: 'Tweaks' })] }, urls = await serve(t, list)
  const check = () => checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  g.vortex()
  // 1. Vortex's staging copy is still the mod's own: the exact file comes back
  g.stage('Tweaks-1-1', 'SKSE/Plugins/Tweaks.ini', SERVER_INI)
  g.put(TWEAKS, SERVER_INI.replace('bFixB = false', 'bFixB = true'))
  let result = await check()
  assert.deepEqual([g.read(TWEAKS), result.patched, result.blocked], [SERVER_INI, [TWEAKS], false])
  // A matching file is kept aside by the launcher, named by its hash
  const kept = path.join(path.dirname(g.cache), 'mod-settings-copies', list.files[0].sha256)
  assert.equal(fs.readFileSync(kept, 'utf8'), SERVER_INI)
  // A copy of a file the list no longer locks goes at the next check
  const stale = path.join(path.dirname(kept), 'f'.repeat(64))
  fs.writeFileSync(stale, 'an older server copy')
  await check()
  assert.deepEqual([fs.existsSync(stale), fs.existsSync(kept)], [false, true])
  // 2. The edit went through Vortex's hard link into staging as well: the kept copy is used
  g.stage('Tweaks-1-1', 'SKSE/Plugins/Tweaks.ini', SERVER_INI.replace('bFixB = false', 'bFixB = true'))
  g.put(TWEAKS, SERVER_INI.replace('bFixB = false', 'bFixB = true'))
  result = await check()
  assert.deepEqual([g.read(TWEAKS), result.patched], [SERVER_INI, [TWEAKS]])
  assert.equal(fs.readFileSync(path.join(g.staging, 'Tweaks-1-1/SKSE/Plugins/Tweaks.ini'), 'utf8'), SERVER_INI.replace('bFixB = false', 'bFixB = true'), 'staging is only read')
  // 3. No copy kept, but staging holds the mod's file saved again (same settings, other bytes): that copy is used
  fs.rmSync(kept)
  g.stage('Tweaks-1-1', 'SKSE/Plugins/Tweaks.ini', '[Fixes]\nbFixA=true\nbFixB=false\n')
  g.put(TWEAKS, SERVER_INI.replace('bFixB = false', 'bFixB = true'))
  result = await check()
  assert.deepEqual([g.read(TWEAKS), result.patched], ['[Fixes]\nbFixA=true\nbFixB=false\n', [TWEAKS]])
  // 4. No clean copy anywhere: the player's own file takes the server's settings, keeping its own lines
  fs.rmSync(kept, { force: true })
  g.stage('Tweaks-1-1', 'SKSE/Plugins/Tweaks.ini', SERVER_INI.replace('bFixB = false', 'bFixB = true'))
  g.put(TWEAKS, '; my notes\r\n[Fixes]\r\nbFixA = true\r\nbFixB = true\r\nbCheat = true\r\n')
  result = await check()
  assert.equal(g.read(TWEAKS), '; my notes\r\n[Fixes]\r\nbFixA = true\r\nbFixB=false\r\n')
  assert.deepEqual([result.patched, result.mods, result.blocked], [[TWEAKS], [], false], 'a settings file never blocks Play when it can be put right')
  // 5. Missing altogether: written from the server's settings
  fs.rmSync(path.join(g.dir, TWEAKS)); fs.rmSync(g.staging, { recursive: true })
  result = await check()
  assert.equal(ini.sameSettings(ini.settings(g.read(TWEAKS)), list.files[0].ini), true)
  assert.deepEqual(result.patched, [TWEAKS])
})

test('a changed locked settings file that is not an INI blocks Play until its mod is reinstalled', async t => {
  const g = game(t), OAR = 'Data/meshes/actors/character/animations/OpenAnimationReplacer/Dodge/config.json'
  g.put(OAR, '{"priority": 1}')
  const urls = await serve(t, { schema: 1, files: [entry(OAR, '{"priority": 900}', { kind: 'mod', mod: 'Dodge', nexusId: 5, config: true })] })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual([result.blocked, result.mods.map(m => [m.name, m.changed.length, m.critical])], [true, [['Dodge', 1, true]]])
})

test('the player\'s keys go into the mod menus\' settings files, which are made read-only', async t => {
  const g = game(t), TDM = 'Data/MCM/Settings/TDM.ini', HUD = 'Data/MCM/Settings/TrueHUD.ini', LISTED = 'Data/MCM/Settings/Listed.ini'
  const LISTED_INI = '[Keys]\r\nuKey = 10\r\n[General]\r\nbOther = 1\r\n'
  const key = (file, k, value, label) => ({ id: `${file}|Keys|${k}`, mod: path.basename(file, '.ini'), label, file, section: 'Keys', key: k, format: 'dx', default: value })
  const list = {
    schema: 1,
    files: [locked(LISTED, LISTED_INI, { kind: 'mod', mod: 'Listed' })],
    mcm: [{ mod: 'TDM', path: TDM }, { mod: 'TrueHUD', path: HUD }, { mod: 'Listed', path: LISTED }],
    keys: [key(TDM, 'uTargetLockKey', '258', 'Target lock'), key(LISTED, 'uKey', '10', 'Listed key')],
  }
  g.put(LISTED, LISTED_INI)
  // The player changed a setting in TrueHUD's in-game menu; the server has no copy, so TrueHUD uses its defaults
  g.put(HUD, '[General]\r\nbDisplayHealth=0\r\n')
  const urls = await serve(t, list)
  const check = keyChoices => checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, keyChoices })
  const choices = { [list.keys[0].id]: 48, [list.keys[1].id]: 20 }
  let result = await check(choices)
  assert.deepEqual(result.keysWritten.sort(), [LISTED, TDM, HUD].sort())
  assert.equal(result.menusLocked, 3)
  assert.equal(g.read(TDM), '[Keys]\r\nuTargetLockKey=48\r\n')
  assert.equal(g.read(HUD), '', 'the menu change is gone: the server decides, so TrueHUD reads its own defaults')
  assert.equal(g.read(LISTED), '[Keys]\r\nuKey=20\r\n[General]\r\nbOther = 1\r\n', 'a listed file keeps the server\'s settings with the player\'s key in it')
  assert.deepEqual([g.readOnly(TDM), g.readOnly(HUD), g.readOnly(LISTED)], [true, true, true], 'MCM Helper cannot save an in-game change')
  // The same keys next time: nothing is written, and the listed file with the player's key counts as the server's
  result = await check(choices)
  assert.deepEqual([result.keysWritten, result.patched, result.mods, result.blocked], [[], [], [], false])
  // A key given back to the server, and a key Skyrim cannot read, are the server's key again
  result = await check({ [list.keys[0].id]: 'Q', [list.keys[1].id]: 999 })
  assert.equal(g.read(TDM), '[Keys]\r\nuTargetLockKey=258\r\n')
  assert.equal(g.read(LISTED), LISTED_INI, 'the server\'s own copy is back, from the copy kept when it last matched')
  assert.equal(g.readOnly(TDM), true, 'still read-only after the launcher changed it')
  // The menu got edited anyway (read-only cleared by hand): the next check puts it back
  fs.chmodSync(path.join(g.dir, HUD), 0o666); g.put(HUD, '[General]\r\nbDisplayHealth=0\r\n')
  result = await check({})
  assert.deepEqual([g.read(HUD), g.readOnly(HUD), result.keysWritten], ['', true, [HUD]])
})

test('a server file that gives a key twice still takes the player\'s key, once', async t => {
  const g = game(t), DUP = 'Data/SKSE/Plugins/Dup.ini', DUP_INI = '[Keys]\r\nuKey = 1\r\nuKey = 10\r\n'
  const list = { schema: 1, files: [locked(DUP, DUP_INI, { kind: 'mod', mod: 'Dup' })],
    keys: [{ id: 'dup', mod: 'Dup', label: 'Key', file: DUP, section: 'Keys', key: 'uKey', format: 'dx', default: '10' }] }
  g.put(DUP, DUP_INI)
  const urls = await serve(t, list)
  const check = () => checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, keyChoices: { dup: 20 } })
  let result = await check()
  assert.deepEqual([ini.settings(g.read(DUP)).keys.ukey, result.keysWritten], ['20', [DUP]], 'the last of the two is what the mod reads')
  result = await check()
  assert.deepEqual([result.keysWritten, result.patched, result.blocked], [[], [], false], 'settled: not written again at every check')
})

test('files the server does not use are moved into "Dovakarn removed files", keeping their folders; nothing else is touched', async t => {
  const g = game(t)
  const list = {
    schema: 1,
    files: [entry('Data/SKSE/Plugins/Listed.dll', 'listed', { kind: 'mod', mod: 'Listed' }), entry('Data/Platform/Plugins/skymp5-client.js', 'client', { kind: 'dovahzul' })],
    mcm: [{ mod: 'TDM', path: 'Data/MCM/Settings/TDM.ini' }],
    unresolved: [{ path: 'Data/SKSE/Plugins/ServerOnly.dll', reason: 'Not found in any mod Vortex has installed' }],
    sweep: {
      patterns: ['Data/*.ini', 'Data/SKSE/**/*.ini', 'Data/SKSE/**/*.json', 'Data/SKSE/Plugins/*.dll', 'Data/MCM/Settings/*.ini', 'Data/Platform/Plugins/*.js',
        'Data/Scripts/*.pex', 'Data/meshes/**/OpenAnimationReplacer/**/*.json'],
      keep: ['Data/SKSE/Plugins/*_ImGui.ini'],
    },
  }
  const swept = ['Data/Other.ini', 'Data/SKSE/Plugins/Extra.dll', 'Data/SKSE/Plugins/Deep/cache.json', 'Data/SKSE/Plugins/Extra.ini', 'Data/MCM/Settings/Unknown.ini',
    'Data/Platform/Plugins/cheat.js', 'Data/Scripts/Foo.pex', 'Data/meshes/actors/OpenAnimationReplacer/Mod/sub/config.json']
  const kept = ['Data/SKSE/Plugins/Listed.dll', 'Data/Platform/Plugins/skymp5-client.js', 'Data/MCM/Settings/TDM.ini', 'Data/SKSE/Plugins/ServerOnly.dll',
    'Data/SKSE/Plugins/Precision_ImGui.ini', 'Data/Sub/deep.ini', 'Data/meshes/actors/body.nif', 'Data/textures/sky.dds', 'Data/Scripts/Source/Foo.psc',
    'Data/Platform/Plugins/skymp5-client-settings.txt', 'Data/Skyrim.esm', 'Data/SKSE/Plugins/Deep/notes.txt', 'SkyrimSE.exe', 'Data/SKSE/Plugins/Busy.dll.dovakarn-part']
  for (const rel of [...swept, ...kept]) g.put(rel, rel === 'Data/SKSE/Plugins/Listed.dll' ? 'listed' : rel === 'Data/Platform/Plugins/skymp5-client.js' ? 'client' : `content of ${rel}`)
  const urls = await serve(t, list)
  // The server's own game copy (the local test) is never swept
  let result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, sweep: false })
  assert.deepEqual(result.moved, [])
  for (const rel of swept) assert.equal(g.exists(rel), true, rel)
  // Nor is any folder server staging marked as a server's game copy, even by a launcher playing online from it
  g.put(SERVER_GAME, 'marker')
  result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })
  assert.deepEqual(result.moved, [])
  for (const rel of swept) assert.equal(g.exists(rel), true, `${rel} stays in a server's game copy`)
  fs.rmSync(path.join(g.dir, SERVER_GAME))
  // Only the folders the patterns name are listed: Data/*.ini reads Data itself, never its meshes and textures, which in
  // a real game hold a hundred thousand files
  const listedDirs = [], readdir = fs.readdirSync
  fs.readdirSync = (dir, ...rest) => { listedDirs.push(path.relative(g.dir, String(dir)).replace(/\\/g, '/')); return readdir(dir, ...rest) }
  try { result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache }) } finally { fs.readdirSync = readdir }
  for (const dir of ['Data/textures', 'Data/Sub', 'Data/Scripts/Source']) assert.equal(listedDirs.includes(dir), false, `${dir} is not read`)
  assert.equal(listedDirs.includes('Data/meshes/actors/OpenAnimationReplacer/Mod/sub'), true, 'a ** pattern reaches down')
  assert.deepEqual(result.moved.slice().sort(), swept.slice().sort())
  const stamps = fs.readdirSync(path.join(g.dir, REMOVED))
  assert.equal(stamps.length, 1)
  assert.match(stamps[0], /^\d{4}-\d\d-\d\d \d\d-\d\d-\d\d$/, 'one folder per check, named by its time')
  for (const rel of swept) {
    assert.equal(g.exists(rel), false, `${rel} left the game`)
    assert.equal(fs.readFileSync(path.join(g.dir, REMOVED, stamps[0], rel), 'utf8'), `content of ${rel}`, `${rel} kept its folders and content`)
  }
  for (const rel of kept) assert.equal(g.exists(rel), true, `${rel} stays`)
  assert.equal(result.blocked, false)
  // Nothing left to move the next time
  assert.deepEqual((await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })).moved, [])
})

test('a list with an unsafe or malformed mod settings part is refused whole', async t => {
  const g = game(t), base = { schema: 1, files: [] }
  const key = { id: 'k', mod: 'M', label: 'Key', file: 'Data/MCM/Settings/M.ini', section: 'Keys', key: 'uKey', format: 'dx', default: '258' }
  const bad = [
    { sweep: { patterns: ['Data/**'] } }, { sweep: { patterns: ['Data/*'] } }, { sweep: { patterns: ['Data/*.*'] } }, { sweep: { patterns: ['Data/SKSE/**'] } },
    { sweep: { patterns: ['Skyrim/*.ini'] } }, { sweep: { patterns: ['Data/../*.ini'] } }, { sweep: { patterns: ['Data\\*.ini'] } }, { sweep: { patterns: ['C:/Data/*.ini'] } },
    { sweep: { patterns: 'Data/*.ini' } }, { sweep: { patterns: ['Data/*.ini'], keep: ['*'] } },
    { keys: [{ ...key, format: 'vk' }] }, { keys: [{ ...key, default: 'Q' }] }, { keys: [{ ...key, default: '300' }] }, { keys: [{ ...key, file: '../x.ini' }] }, { keys: [{ ...key, label: 5 }] },
    { mcm: [{ mod: 'M', path: 'C:/Windows/win.ini' }] }, { mcm: [{ mod: 'M', path: 'Data/MCM/Settings/M:x.ini' }] },
    { files: [{ ...entry('Data/x.ini', 'a=1', { kind: 'mod' }), ini: { s: { a: 1 } } }] },
  ]
  for (const extra of bad) {
    const urls = await serve(t, { ...base, ...extra })
    await assert.rejects(checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache }), /invalid/, JSON.stringify(extra))
  }
  const urls = await serve(t, { ...base, keys: [key], mcm: [{ mod: 'M', path: 'Data/MCM/Settings/M.ini' }], sweep: { patterns: ['Data/*.ini', 'Data/SKSE/**/*.json'], keep: ['Data/SKSE/Plugins/*_ImGui.ini'] } })
  assert.equal((await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache })).blocked, false, 'the real shape is accepted')
})

test('keys: only DirectX scan codes Skyrim reads, and the page gets names, labels and defaults only', () => {
  for (const ok of [-1, 1, 57, 255, 256, 281, '258', ' 48 ']) assert.equal(validKey('dx', ok), true, String(ok))
  for (const no of [0, -2, 282, 1.5, '1e2', '', 'F1', null, undefined]) assert.equal(validKey('dx', no), false, String(no))
  assert.equal(validKey('vk', 48), false)
  const keys = [{ id: 'a', file: 'Data/MCM/Settings/A.ini', section: 'Keys', key: 'uOne', format: 'dx', default: '258' },
    { id: 'b', file: 'Data/MCM/Settings/a.ini', section: 'Keys', key: 'uTwo', format: 'dx', default: '-1' }]
  assert.deepEqual(keyValuesByFile(keys, { a: 48, b: 'rubbish' }), { 'data/mcm/settings/a.ini': { path: 'Data/MCM/Settings/A.ini', values: { Keys: { uOne: '48', uTwo: '-1' } } } },
    'one file however its name is written; a bad choice is the server\'s key')
  const view = describeFileList({ manifest: { schema: 1, files: [], keys: [{ ...keys[0], mod: 'True Directional Movement', label: 'Target lock' }] }, collection: { name: 'Dovakarn', url: '' } })
  assert.deepEqual(view.keys, [{ id: 'a', mod: 'True Directional Movement', label: 'Target lock', default: 258 }])
})

// The keys the game client applies itself (Dodge, Sneak): the file list's gameKeys, as the server lists them
const DODGE = { id: 'game|dodgeKeyCode', mod: 'Ultimate Dodge Mod', label: 'Dodge', setting: 'dodgeKeyCode', format: 'dx', default: 29 }
const SNEAK = { id: 'game|sneakKeyCode', mod: 'Ultimate Dodge Mod', label: 'Sneak', setting: 'sneakKeyCode', format: 'dx', default: 45 }

test('game keys: the player\'s choice or the server\'s key, and only "...KeyCode" entries ever reach the client settings file', () => {
  assert.deepEqual(gameKeyValues([DODGE, SNEAK], { 'game|dodgeKeyCode': 56, 'game|sneakKeyCode': 'rubbish' }), { dodgeKeyCode: 56, sneakKeyCode: 45 },
    'a bad choice is the server\'s key')
  assert.deepEqual(gameKeyValues([DODGE], { 'game|dodgeKeyCode': -1 }), { dodgeKeyCode: -1 }, 'no key is a choice too')
  assert.deepEqual(gameKeyValues(undefined, {}), {})
  // The settings file also holds the server address and the login: nothing else may be written through a game key
  assert.deepEqual(gameKeySettings({ dodgeKeyCode: 56, sneakKeyCode: 258, master: 'http://evil', 'server-ip': 1, gameData: 3, KeyCode: 5, fooKeyCode: 999, barKeyCode: '12' }),
    { dodgeKeyCode: 56, sneakKeyCode: 258, barKeyCode: 12 })
  assert.deepEqual(gameKeySettings(null), {})
  assert.deepEqual(gameKeySettings('dodgeKeyCode'), {})
})

test('game keys: listed first in Controls, marked as the game\'s, and a malformed one refuses the list', async t => {
  const view = describeFileList({ manifest: { schema: 1, files: [], gameKeys: [DODGE, SNEAK], keys: [{ id: 'a', mod: 'TDM', label: 'Target lock', file: 'Data/MCM/Settings/A.ini', section: 'Keys', key: 'u', format: 'dx', default: '258' }] }, collection: { name: 'Dovakarn', url: '' } })
  assert.deepEqual(view.keys, [
    { id: 'game|dodgeKeyCode', mod: 'Ultimate Dodge Mod', label: 'Dodge', default: 29, game: true },
    { id: 'game|sneakKeyCode', mod: 'Ultimate Dodge Mod', label: 'Sneak', default: 45, game: true },
    { id: 'a', mod: 'TDM', label: 'Target lock', default: 258 },
  ])
  const g = game(t), base = { schema: 1, files: [] }
  const bad = [
    { gameKeys: DODGE }, { gameKeys: [{ ...DODGE, setting: 'master', id: 'game|master' }] }, { gameKeys: [{ ...DODGE, setting: 'server-ipKeyCode', id: 'game|server-ipKeyCode' }] },
    { gameKeys: [{ ...DODGE, id: 'game|sneakKeyCode' }] }, { gameKeys: [{ ...DODGE, default: 300 }] }, { gameKeys: [{ ...DODGE, format: 'vk' }] }, { gameKeys: [{ ...DODGE, label: null }] }, { gameKeys: [null] },
  ]
  for (const extra of bad) {
    const urls = await serve(t, { ...base, ...extra })
    await assert.rejects(checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache }), /invalid/, JSON.stringify(extra))
  }
  const urls = await serve(t, { ...base, gameKeys: [DODGE, SNEAK] })
  const result = await checkGameFiles({ gameDir: g.dir, ...urls, cacheFile: g.cache, keyChoices: { 'game|sneakKeyCode': 258 } })
  assert.deepEqual(result.gameKeys, { dodgeKeyCode: 29, sneakKeyCode: 258 }, 'the check hands Play the keys to write')
  assert.deepEqual(result.keysWritten, [], 'no settings file is written for them')
  const none = await checkGameFiles({ gameDir: g.dir, ...(await serve(t, base)), cacheFile: g.cache })
  assert.deepEqual(none.gameKeys, {}, 'a server without them writes none')
})

test('Controls learns which keys only work inside the game\'s menus, and the keys other mods keep; a bad kept key is left out, never refusing the list', async t => {
  const SEARCH = { id: 'ui|s', mod: 'SkyUI', label: 'Search', file: 'Data/MCM/Settings/SkyUI_SE.ini', section: 'Controls', key: 'iSearchKey', format: 'dx', default: '57', inMenus: true }
  const MENU = { mod: 'SKSE Menu Framework', label: 'Menu', code: 59 }
  const fixedKeys = [MENU, { ...MENU, code: -1 }, { ...MENU, code: 300 }, { ...MENU, code: 'F1' }, { ...MENU, label: '' }, { ...MENU, mod: 7 }, null, 'x']
  const manifest = { schema: 1, files: [], gameKeys: [DODGE], keys: [SEARCH, { ...SEARCH, id: 'ui|g', label: 'Favourites group 1', inMenus: 'yes' }], fixedKeys }
  const view = describeFileList({ manifest, collection: { name: 'Dovakarn', url: '' } })
  assert.deepEqual(view.keys.map(k => [k.id, k.inMenus]), [['game|dodgeKeyCode', undefined], ['ui|s', true], ['ui|g', undefined]], 'only a real true marks a key')
  assert.deepEqual(view.fixedKeys, [MENU], 'no key, a code Skyrim has none of, a key name and a missing label or mod are left out')
  assert.deepEqual(describeFileList({ manifest: { schema: 1, files: [] }, collection: { name: 'Dovakarn', url: '' } }).fixedKeys, [], 'a server without them')
  assert.deepEqual(describeFileList({ manifest: { schema: 1, files: [], fixedKeys: MENU }, collection: { name: 'Dovakarn', url: '' } }).fixedKeys, [])
  const g = game(t)
  const result = await checkGameFiles({ gameDir: g.dir, ...(await serve(t, manifest)), cacheFile: g.cache })
  assert.deepEqual(result.gameKeys, { dodgeKeyCode: 29 }, 'the check accepts the list')
})
