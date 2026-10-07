// The keys Skyrim's own controls use (gameControls.js), for the Controls tab's clash notes on every key used in play
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DEFAULTS, parseControlMap, byKey, withCustom, createGameControls, customMapPath } = require('../src/gameControls')

// The game's own layout: comment header, tab-separated fields, a blank line before the next input context
const SAMPLE = [
  '// 1st field: User event name.',
  '// Main Gameplay\t\t\t\t\t\t\t',
  'Forward\t\t\t\t0x11\t\t\t\t0xff\t0xff\t\t\t\t1\t1\t0\t0x801',
  'Look\t\t\t\t0xff\t\t\t\t0xa\t\t0x000c\t\t\t\t0\t0\t0\t0x2',
  'Right Attack/Block\t0xff\t\t\t\t0x0\t\t0x000a\t\t\t\t1\t1\t1\t0x841',
  'Activate\t\t\t0x2d\t\t\t\t0xff\t0x1000\t\t\t\t1\t1\t1\t0x804',
  'Sneak\t\t\t\t0x1d\t\t\t\t0xff\t0x0040\t\t\t\t1\t1\t1\t0x881',
  'Hotkey1\t\t\t\t0x02,0x4f\t\t\t0xff\t0x0004\t\t\t\t0\t0\t0\t0x908',
  'Multi-Screenshot\t0x1d+0xb7,0x9d+0xb7\t0xff\t0xff\t\t\t\t0\t0\t0',
  '\t\t\t\t\t\t\t',
  '// Menu Mode',
  'Accept\t\t!0,Activate\t\t\t\t!0,Activate\t\t\t\t0x1000\t\t\t0\t0\t0\t0x8',
].join('\r\n')

test('a control map is read as the game reads its main gameplay context', () => {
  assert.deepEqual(parseControlMap(SAMPLE), [
    ['Forward', [0x11], []], ['Look', [], [0xa]], ['Right Attack/Block', [], [0x0]], ['Activate', [0x2d], []],
    ['Sneak', [0x1d], []], ['Hotkey1', [0x02, 0x4f], []], ['Multi-Screenshot', [], []],
  ], 'unmapped (0xff), key combinations and later contexts are left out')
})

test('each key names the controls on it: mouse buttons from 256, never the mouse\'s movement, and never Sneak (the Dodge key takes it)', () => {
  const keys = byKey(parseControlMap(SAMPLE), ['Sneak'])
  assert.deepEqual(keys, { 17: ['Forward'], 256: ['Right Attack/Block'], 45: ['Activate'], 2: ['Hotkey1'], 79: ['Hotkey1'] })
  const defaults = byKey(DEFAULTS, ['Sneak'])
  assert.equal(defaults[29], undefined, 'Left Ctrl is the Dodge key\'s own')
  assert.equal(defaults[45], undefined, 'X, the server\'s Sneak key, is free in the game')
  assert.deepEqual([defaults[18], defaults[46], defaults[256], defaults[257], defaults[264]], [['Activate'], ['Auto-Move'], ['Right Attack/Block'], ['Left Attack/Block'], ['Zoom In']])
  assert.equal(defaults[266], undefined, 'no gamepad code from the mouse\'s movement')
})

test('the player\'s own file counts control by control, over the game\'s defaults', () => {
  const merged = byKey(withCustom(parseControlMap(SAMPLE)), ['Sneak'])
  assert.deepEqual(merged[45], ['Activate'], 'Activate moved to X in the player\'s file')
  assert.equal(merged[18], undefined, 'and is no longer on E')
  assert.deepEqual(merged[19], ['Ready Weapon'], 'controls the file does not name keep the game\'s key')
})

test('the player\'s ControlMap_Custom.txt is read when there is one, and read again only when it changes', t => {
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-controls-'))
  t.after(() => fs.rmSync(docs, { recursive: true, force: true }))
  const controls = createGameControls(() => docs)
  assert.deepEqual(controls()[18], ['Activate'], 'no file: the game\'s defaults')
  // Online the Dodge key takes over Sneak, and the game client turns waiting off (Game.setInChargen), so T is the chat's alone
  assert.deepEqual(DEFAULTS.find(row => row[0] === 'Wait'), ['Wait', [0x14], []], 'the game puts Wait on T')
  assert.deepEqual([controls()[0x14], controls()[0x1d]], [undefined, undefined], 'neither Wait nor Sneak is told')
  const file = customMapPath(docs)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, SAMPLE)
  assert.deepEqual(controls()[45], ['Activate'])
  const first = controls()
  assert.equal(controls(), first, 'unchanged: the same answer, not read again')
  fs.writeFileSync(file, SAMPLE.replace('0x2d', '0x2e') + '\r\n')
  assert.deepEqual(controls()[46], ['Activate', 'Auto-Move'], 'changed: read again')
  fs.rmSync(file)
  assert.deepEqual(controls()[18], ['Activate'], 'removed: the defaults again')
})
