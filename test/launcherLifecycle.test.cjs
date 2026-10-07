// combat-test paths and --combat-test are the local test server's folder layout and launch flag.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createLauncherLifecycle } = require('../src/launcherLifecycle')
const { LocalPlay } = require('../src/localPlay')

function fixture() {
  let window = null, created = 0, plays = 0, load = Promise.resolve()
  const errors = []
  const lifecycle = createLauncherLifecycle({
    getWindow: () => window,
    createWindow: () => {
      created++
      return window = { destroyed: false, minimized: false, visible: false, focused: false, restores: 0,
        isDestroyed() { return this.destroyed }, isMinimized() { return this.minimized },
        restore() { this.restores++; this.minimized = false }, show() { this.visible = true }, focus() { this.focused = true } }
    },
    whenLoaded: () => load,
    play: async () => { plays++; return { success: true } },
    onError: error => errors.push(error),
  })
  return { lifecycle, errors, get window() { return window }, get created() { return created }, get plays() { return plays },
    set load(value) { load = value } }
}

test('cold shortcut creates the launcher at once, which shows itself when painted, without starting Skyrim', async () => {
  const h = fixture(); let loaded; h.load = new Promise(resolve => { loaded = resolve })
  const opening = h.lifecycle.open()
  assert.equal(h.created, 1)
  assert.equal(h.window.visible, false, 'A half-drawn window is never shown; main.js shows it on its first painted frame')
  assert.equal(h.plays, 0)
  loaded(); await opening
  assert.equal(h.plays, 0)
})

test('a second shortcut restores the existing hidden or minimized launcher', async () => {
  const h = fixture(); await h.lifecycle.open()
  h.window.visible = false; h.window.focused = false; h.window.minimized = true
  await h.lifecycle.open()
  assert.equal(h.created, 1); assert.equal(h.window.visible, true); assert.equal(h.window.focused, true)
  assert.equal(h.window.restores, 1); assert.equal(h.plays, 0)
})

test('a destroyed launcher window is recreated by the next shortcut', async () => {
  const h = fixture(); await h.lifecycle.open(); h.window.destroyed = true
  await h.lifecycle.open()
  assert.equal(h.created, 2); assert.equal(h.window.visible, false, 'The new window shows itself when painted'); assert.equal(h.plays, 0)
})

test('explicit Play waits for the page and coalesces repeated requests while preparing', async () => {
  const h = fixture(); let loaded; h.load = new Promise(resolve => { loaded = resolve })
  const first = h.lifecycle.open({ playRequested: true })
  const second = h.lifecycle.open({ playRequested: true })
  assert.equal(first, second); assert.equal(h.plays, 0)
  loaded(); await Promise.all([first, second]); assert.equal(h.plays, 1)
  await h.lifecycle.open({ playRequested: true }); assert.equal(h.plays, 2)
})

test('page failures are reported and explicit Play can be retried', async () => {
  const h = fixture(); h.load = Promise.reject(new Error('Launcher page missing'))
  assert.equal((await h.lifecycle.open({ playRequested: true })).success, false)
  assert.equal(h.errors[0].message, 'Launcher page missing'); assert.equal(h.plays, 0)
  h.load = Promise.resolve(); await h.lifecycle.open({ playRequested: true }); assert.equal(h.plays, 1)
})

test('real LocalPlay guards remain effective and a later explicit request relaunches after game exit', async () => {
  let gameRunning = false, starts = 0, launches = 0
  const player = new LocalPlay({ runtime: { start: async () => { starts++ } }, refreshFiles() {},
    running: async () => gameRunning,
    launch: async () => { launches++; gameRunning = true; return { success: true } }, serverLog: '' })
  const window = { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} }
  const lifecycle = createLauncherLifecycle({ getWindow: () => window, createWindow: () => assert.fail('Existing window should be reused'),
    whenLoaded: async () => {}, play: () => player.play(), onError: error => assert.fail(error.message) })
  await Promise.all([lifecycle.open({ playRequested: true }), lifecycle.open({ playRequested: true })])
  assert.equal(launches, 1); assert.equal(starts, 1)
  assert.equal((await lifecycle.open({ playRequested: true })).success, false)
  assert.equal(launches, 1, 'running game must not be duplicated')
  gameRunning = false
  await lifecycle.open(); assert.equal(launches, 1, 'ordinary shortcut only opens the launcher')
  assert.equal((await lifecycle.open({ playRequested: true })).success, true)
  assert.equal(launches, 2); assert.equal(starts, 2)
})

// Optional: needs the local test server's shortcut, dev\play-combat-test.ps1, in the folder that holds this checkout;
// skipped where it is not present
const shortcutScript = path.resolve(__dirname, '../../dev/play-combat-test.ps1')
test('actual PowerShell shortcut opens Electron normally and only -Play requests auto-launch',
  { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(shortcutScript) && 'the local test shortcut is not beside this checkout' }, t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-launch-shortcut-'))
  const fixtureScript = path.join(temp, 'launch-fixture.ps1')
  t.after(() => { fs.unlinkSync(fixtureScript); fs.rmdirSync(temp) })
  // Execute the real script with process/network/filesystem boundaries mocked;
  // this starts no server or game and does not read/write any player data.
  fs.writeFileSync(fixtureScript, `param([string]$LauncherScript, [switch]$Play)
function Test-Path { param($Path, $LiteralPath) if ($LiteralPath -like '*pending-client.js') { return $false }; return $true }
function Invoke-RestMethod { return [PSCustomObject]@{ mode='combat'; port=7780; offlineMode=$true } }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
  [PSCustomObject]@{ executable=$FilePath; arguments=$ArgumentList; directory=$WorkingDirectory; style=$WindowStyle } | ConvertTo-Json -Compress
}
& $LauncherScript -Play:$Play
`)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript, '-LauncherScript', shortcutScript]
  const ordinary = JSON.parse(execFileSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true }))
  assert.equal(ordinary.style, 'Normal'); assert.ok(ordinary.arguments.includes('--combat-test'))
  assert.ok(!ordinary.arguments.includes('--play-local')); assert.ok(ordinary.arguments.includes('--test-profile=1'))
  const direct = JSON.parse(execFileSync('powershell.exe', [...args, '-Play'], { encoding: 'utf8', windowsHide: true }))
  assert.equal(direct.style, 'Normal'); assert.ok(direct.arguments.includes('--play-local'))
})
