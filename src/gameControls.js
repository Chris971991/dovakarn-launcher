// The keys Skyrim's own controls use in play (the player's ControlMap_Custom.txt over the game's defaults), for Controls' clash notes
const fs = require('fs')
const path = require('path')

// Skyrim 1.6.1170's Interface/Controls/PC/ControlMap.txt main gameplay context as parseControlMap reads it: [control, keyboard, mouse]
const DEFAULTS = [
  ['Forward', [0x11], []], ['Back', [0x1f], []], ['Strafe Left', [0x1e], []], ['Strafe Right', [0x20], []],
  ['Move', [], []], ['Look', [], [0xa]], ['Left Attack/Block', [], [0x1]], ['Right Attack/Block', [], [0x0]],
  ['Activate', [0x12], []], ['Ready Weapon', [0x13], []], ['Tween Menu', [0xf], []], ['Toggle POV', [0x21], []],
  ['Zoom Out', [], [0x9]], ['Zoom In', [], [0x8]], ['Jump', [0x39], []], ['Sprint', [0x38], []], ['Shout', [0x2c], []],
  ['Sneak', [0x1d], []], ['Run', [0x2a], []], ['Toggle Always Run', [0x3a], []], ['Auto-Move', [0x2e], []],
  ['Favorites', [0x10], []], ['Hotkey1', [0x2, 0x4f], []], ['Hotkey2', [0x3, 0x50], []], ['Hotkey3', [0x4, 0x51], []],
  ['Hotkey4', [0x5, 0x4b], []], ['Hotkey5', [0x6, 0x4c], []], ['Hotkey6', [0x7, 0x4d], []], ['Hotkey7', [0x8, 0x47], []],
  ['Hotkey8', [0x9, 0x48], []], ['Quicksave', [0x3f], []], ['Quickload', [0x43], []], ['Wait', [0x14], []],
  ['Journal', [0x24], []], ['Pause', [0x1], []], ['Screenshot', [0xb7], []], ['Multi-Screenshot', [], []],
  ['Console', [0x29, 0x94], []], ['CameraPath', [0x58], []], ['Quick Inventory', [0x17], []], ['Quick Magic', [0x19], []],
  ['Quick Stats', [0x35], []], ['Quick Map', [0x32], []],
]
const MOUSE_BASE = 256
const NO_KEY = 0xff
// Mouse buttons 0 to 7 and the wheel (8 up, 9 down); higher codes are the mouse's movement
const LAST_MOUSE_BUTTON = 9

// Codes in one ControlMap field ("0x1d", "0x02,0x4f"); key combinations ("0x1d+0xb7") and links ("!0,Activate") are left out
function codes(field) {
  if (!field || field.includes('+') || field.includes('!')) return []
  return field.split(',').map(s => Number.parseInt(s.trim(), 16)).filter(n => Number.isInteger(n) && n >= 0 && n !== NO_KEY)
}

// The main gameplay context of a ControlMap file (the lines before its first blank line) as [control, keyboard, mouse]
function parseControlMap(text) {
  const rows = []
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) { if (rows.length) break; continue }
    const line = raw.replace(/\/\/.*$/, '')
    if (!line.trim()) continue
    const fields = line.split('\t').map(f => f.trim()).filter(Boolean)
    if (fields.length < 3) continue
    rows.push([fields[0], codes(fields[1]), codes(fields[2])])
  }
  return rows
}

// { code: [control, ...] }, leaving out the controls that do not act on their keys online: the Dodge key takes over Sneak
// (the client's dodge code), and the game client turns Skyrim's waiting off (its limits code, at the first update and at
// each spawn), so Wait never shares T with the chat
function byKey(rows, ownControls) {
  const out = {}
  for (const [name, keyboard, mouse] of rows) {
    if (ownControls.includes(name)) continue
    const keys = [...keyboard.filter(k => k < MOUSE_BASE), ...mouse.filter(m => m <= LAST_MOUSE_BUTTON).map(m => m + MOUSE_BASE)]
    for (const code of keys) (out[code] = out[code] || []).push(name)
  }
  return out
}

const OWN_CONTROLS = ['Sneak', 'Wait']
function customMapPath(documentsDir) { return path.join(documentsDir, 'My Games', 'Skyrim Special Edition', 'ControlMap_Custom.txt') }

// Read again only when the player's file changes
function createGameControls(documentsDir) {
  let cached = null, stamp = ''
  return () => {
    let text = null, now = 'defaults'
    try {
      const file = customMapPath(documentsDir()), stat = fs.statSync(file)
      now = `${stat.mtimeMs}:${stat.size}`
      if (now !== stamp) text = fs.readFileSync(file, 'utf8')
    } catch { now = 'defaults' }
    if (cached && now === stamp) return cached
    stamp = now
    cached = byKey(withCustom(text !== null ? parseControlMap(text) : []), OWN_CONTROLS)
    return cached
  }
}

// The defaults with each control the player's file names in its place, so a file that lists only some controls still counts
function withCustom(custom) {
  const byName = new Map(DEFAULTS.map(row => [row[0].toLowerCase(), row]))
  for (const row of custom) byName.set(row[0].toLowerCase(), row)
  return [...byName.values()]
}

module.exports = { DEFAULTS, parseControlMap, byKey, withCustom, createGameControls, customMapPath }
