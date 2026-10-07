// combat-test paths and --combat-test are the local test server's folder layout and launch flag.
const test = require('node:test')
const assert = require('node:assert/strict')
const local = require('../src/localTest')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

test('offline profile is confined to the local server and omits online credentials', () => {
  const settings = local.clientSettings(local.server)
  assert.deepEqual(settings.gameData, { profileId: 1 })
  assert.equal(settings.master, '')
  assert.equal(settings['server-master-key'], null)
  assert.equal(settings['server-info-ignore'], true)
  assert.equal(local.enabled, false)
  assert.throws(() => local.clientSettings({ address: 'example.com', port: 7777 }))
  assert.throws(() => local.clientSettings({ address: '127.0.0.1', port: 7778 }))
})

test('local bypass requires the explicit process flag', () => {
  const modulePath = path.resolve(__dirname, '../src/localTest.js')
  const run = flag => execFileSync(process.execPath, ['-e',
    `process.argv.push(${JSON.stringify(flag)}); console.log(require(${JSON.stringify(modulePath)}).enabled)`],
    { encoding: 'utf8' }).trim()
  assert.equal(run('--local-test'), 'true')
  assert.equal(run('--dev'), 'false')
})

function combatModule({profile = '2', port = 7780, changed = false} = {}) {
  const contents = Buffer.from('test plugin')
  const manifest = {mode:'combat',port,httpPort:7781,gamePath:'G:/combat-test/skyrim',loadOrder:['Skyrim.esm'],hashes:{'Skyrim.esm':crypto.createHash('sha256').update(contents).digest('hex')}}
  const context = {module:{exports:{}}, __dirname:path.resolve(__dirname,'../src'),process:{argv:['--combat-test',`--test-profile=${profile}`]},
    require:name => name === 'fs' ? {readFileSync:p=>String(p).endsWith('manifest.json') ? JSON.stringify(manifest) : assert.fail('Plugins are streamed, never read in one blocking call'),
      createReadStream:()=>Readable.from([changed ? Buffer.from('different plugin') : contents])} : require(name)}
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../src/localTest.js'),'utf8'),context)
  return context.module.exports
}

test('combat profile uses its separate loopback server and selected character', () => {
  const combat = combatModule()
  assert.equal(combat.enabled,true)
  assert.equal(combat.server.port,7780)
  assert.equal(combat.clientSettings(combat.server).gameData.profileId,2)
  assert.ok(!Object.keys(combat.clientSettings(combat.server)).some(name=>/KeyCode$/.test(name)),'no keys of its own: the hold menu is on the server\'s key, not a key of its own')
  assert.equal(combat.clientSettings(combat.server).difficulty,2)
  assert.equal(combat.clientSettings(combat.server).combatDodgeStamina,true)
  assert.equal(combat.clientSettings(combat.server).serverAuthoritativeDamage,true)
  assert.throws(()=>combat.clientSettings({address:'127.0.0.1',port:7777}))
  assert.throws(()=>combat.clientSettings({address:'example.com',port:7780}))
})

test('combat launch rejects modified plugins and invalid configuration', async () => {
  await assert.doesNotReject(combatModule().verifyGameFiles('G:/combat-test/skyrim'))
  await assert.rejects(combatModule({changed:true}).verifyGameFiles('G:/combat-test/skyrim'),/does not match the server/)
  assert.throws(()=>combatModule({profile:'0'}),/profile must/)
  assert.throws(()=>combatModule({profile:'NaN'}),/profile must/)
  assert.throws(()=>combatModule({port:7777}),/Invalid combat test manifest/)
})

test('the login mode trims the master address, so the game builds "<master>/api/..." with one slash', () => {
  // The real module, reading a stand-in server folder: nothing on this PC is read or changed
  const src = path.resolve(__dirname, '../src'), files = new Map([
    [path.resolve(src, '../../../combat-test/manifest.json'), JSON.stringify({ mode: 'combat', port: 7780, httpPort: 7781, loadOrder: [] })],
    [path.resolve(src, '../../../combat-test/server/server-settings-login.json'), JSON.stringify({ offlineMode: false, master: 'http://127.0.0.1:4000//', masterKey: 'local-master-key' })],
  ])
  const disk = { readFileSync: file => { if (!files.has(file)) throw new Error(`No ${file}`); return files.get(file) }, existsSync: file => files.has(file) }
  const loaded = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(src, 'localTest.js'), 'utf8'), {
    module: loaded, exports: loaded.exports, __dirname: src, console, Buffer,
    process: { argv: [process.execPath, 'main.js', '--combat-test'], env: {} },
    require: name => name === 'fs' ? disk : require(name),
  })
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.exports.loginMode())), { discord: true, master: 'http://127.0.0.1:4000', masterKey: 'local-master-key' })
})
