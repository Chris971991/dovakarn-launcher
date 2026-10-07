const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { gameFolderFromPick, gameFolderProblem, sameFolder } = require('../src/gameFolder')

function skyrim(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-folder-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'Data'))
  fs.writeFileSync(path.join(dir, 'SkyrimSE.exe'), 'exe')
  return dir
}

test('picking the Data folder by mistake uses the game folder above it', t => {
  const game = skyrim(t)
  assert.equal(gameFolderFromPick(path.join(game, 'Data')), game)
  assert.equal(gameFolderFromPick(path.join(game, 'data')), game, 'Any capitalisation')
  assert.equal(gameFolderFromPick(game), game)
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-loose-')); t.after(() => fs.rmSync(loose, { recursive: true, force: true }))
  fs.mkdirSync(path.join(loose, 'Data'))
  assert.equal(gameFolderFromPick(path.join(loose, 'Data')), path.join(loose, 'Data'), 'A Data folder with no game above it is left alone')
  assert.equal(gameFolderFromPick(''), '')
  assert.equal(gameFolderFromPick(undefined), '')
})

test('any folder with SkyrimSE.exe can be chosen, whatever its version: the main screen offers to switch it', async t => {
  const game = skyrim(t)
  assert.match(await gameFolderProblem(path.join(game, 'Data')), /no SkyrimSE\.exe/)
  assert.match(await gameFolderProblem(''), /no SkyrimSE\.exe/)
  assert.equal(await gameFolderProblem(game), '', "Steam's current 1.7 is what every new player has")
})

// Windows paths: drive letters, backslashes and junctions
const windowsOnly = { skip: process.platform !== 'win32' && 'Windows paths only' }
test('the same folder is recognised however it was typed', windowsOnly, () => {
  assert.equal(sameFolder('C:\\Games\\Skyrim', 'c:/games/skyrim/'), true)
  assert.equal(sameFolder('C:\\Games\\Skyrim', 'C:\\Games\\Skyrim - Dovakarn'), false)
  assert.equal(sameFolder('', 'C:\\Games'), false)
  assert.equal(sameFolder('C:\\Games', undefined), false)
})

test('a junction to the server copy counts as the server copy', windowsOnly, t => {
  const game = skyrim(t), link = `${game}-link`
  fs.symlinkSync(game, link, 'junction'); t.after(() => fs.rmSync(link, { force: true }))
  assert.equal(sameFolder(link, game), true)
  assert.equal(sameFolder(`${link}\\`, game.toUpperCase()), true)
  assert.equal(sameFolder(link, path.dirname(game)), false)
})
