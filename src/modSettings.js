// Mod settings the server locks: every mod INI setting matches the server's at all times, and is put back when it differs.
// Skyrim's own INIs (Documents) stay the player's; the keys the server lets
// players bind are changed here in the launcher only. fileCheck.js calls this around its file check:
//   - a locked INI counts as matching when its settings match, so a mod saving its own file again is not a change;
//   - a changed or missing settings file is put back from a clean copy (Vortex staging, or one kept here earlier);
//   - the mod menus' settings files (MCM Helper) are written with the player's keys and made read-only: MCM Helper then
//     cannot save an in-game change, and Precision, TDM and TrueHUD only apply one by reading that file back;
//   - files the server does not use in the swept folders are moved out of the game into "Dovakarn removed files".
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ini = require('./ini')

const REMOVED = 'Dovakarn removed files'
const COPY_LIMIT = 4 * 1024 * 1024
// Left beside SkyrimSE.exe in a Dovakarn server's own game folder (written by the server's setup). The server builds its
// player file list from that folder, so a launcher playing from it never moves files out of it: a mod staged there
// and not yet published would otherwise vanish from the server's copy.
const SERVER_GAME = 'Dovakarn server game.txt'
function isServerGame(gameDir) { try { return fs.statSync(path.join(gameDir, SERVER_GAME)).isFile() } catch { return false } }

// A key value the launcher accepts: a DirectX scan code (1-255 keyboard, 256-281 mouse and gamepad), or -1 for none.
function validKey(format, value) {
  if (format !== 'dx') return false
  const text = String(value).trim(), n = Number(text)
  return /^-?\d+$/.test(text) && (n === -1 || (n >= 1 && n <= 281))
}

// { lowerPath: { path, values: { Section: { key: value } } } }: every bindable key, the player's choice or the server's value.
function keyValuesByFile(keys, choices) {
  const out = {}
  for (const k of keys || []) {
    const own = choices && Object.prototype.hasOwnProperty.call(choices, k.id) && validKey(k.format, choices[k.id])
    const value = own ? String(Number(choices[k.id])) : String(k.default)
    const file = out[k.file.toLowerCase()] = out[k.file.toLowerCase()] || { path: k.file, values: {} }
    ;(file.values[k.section] = file.values[k.section] || {})[k.key] = value
  }
  return out
}

// { setting: key } for the game client's own keys (manifest.gameKeys, written to its settings file at Play): the player's or the server's
function gameKeyValues(gameKeys, choices) {
  const out = {}
  for (const k of gameKeys || []) {
    const own = choices && Object.prototype.hasOwnProperty.call(choices, k.id) && validKey(k.format, choices[k.id])
    out[k.setting] = Number(own ? choices[k.id] : k.default)
  }
  return out
}

// A game key's entry in the client settings file: only "...KeyCode" names, never the server address or the login
const GAME_KEY_SETTING = /^[a-z][A-Za-z0-9]{0,40}KeyCode$/
function gameKeySettings(values) {
  const out = {}
  if (!values || typeof values !== 'object') return out
  for (const [name, key] of Object.entries(values)) if (GAME_KEY_SETTING.test(name) && validKey('dx', key)) out[name] = Number(key)
  return out
}

// The settings a locked INI must have: the server's, with the player's keys where this file holds any.
const expectedSettings = (entry, byFile) => ini.withValues(entry.ini, byFile[entry.path.toLowerCase()]?.values)

function readSettings(abs) {
  try { return ini.settings(fs.readFileSync(abs, 'utf8')) } catch { return null }
}

const sha256Of = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

// Clean copies of locked settings files, kept the first time a player's copy matches the server, so a file edited later
// (Vortex's hard link edits its staging copy too) can still be put back. Named by their SHA256; checked before use.
function copiesDir(cacheFile) { return path.join(path.dirname(cacheFile), 'mod-settings-copies') }
function remember(cacheFile, entry, abs) {
  if (!cacheFile || !entry.config || entry.size > COPY_LIMIT) return
  const file = path.join(copiesDir(cacheFile), entry.sha256)
  if (fs.existsSync(file)) return
  try {
    const bytes = fs.readFileSync(abs)
    if (sha256Of(bytes) !== entry.sha256) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file + '.part', bytes); fs.renameSync(file + '.part', file)
  } catch { /* A copy that could not be kept only means one repair source fewer. */ }
}
// Copies of files the server's list no longer locks are removed, so the folder never grows past the current list.
function pruneCopies(cacheFile, wanted) {
  if (!cacheFile) return
  const dir = copiesDir(cacheFile)
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names) if (!wanted.has(name)) try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* in use: next time */ }
}
function recall(cacheFile, sha256) {
  if (!cacheFile) return null
  const file = path.join(copiesDir(cacheFile), sha256)
  try { return sha256Of(fs.readFileSync(file)) === sha256 ? file : null } catch { return null }
}

// A clean copy of a locked INI whose settings are the server's even though its bytes are not (a mod saved it again, or
// the player's staging copy is the download while the server's was re-saved). Vortex staging first, then kept copies.
function settingsCopy(vortex, entry, cacheFile) {
  const candidates = []
  if (vortex) {
    const inner = entry.path.replace(/^Data\//i, '')
    for (const mod of vortex.mods) candidates.push(path.join(vortex.staging, mod, inner))
  }
  const kept = recall(cacheFile, entry.sha256)
  if (kept) candidates.push(kept)
  for (const file of candidates) {
    const s = readSettings(file)
    if (s && ini.sameSettings(s, entry.ini)) return file
  }
  return null
}

// Replaces a file through a side file and a rename (never writing through a Vortex hard link), clearing read-only first.
function replaceText(abs, text) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const part = abs + '.dovakarn-part'
  fs.writeFileSync(part, text)
  try { fs.chmodSync(abs, 0o666) } catch { /* new file */ }
  try { fs.renameSync(part, abs) } catch (error) { fs.rmSync(part, { force: true }); throw error }
}
function setReadOnly(abs) { try { fs.chmodSync(abs, 0o444) } catch { /* missing: written next check */ } }
function isReadOnly(abs) { try { return (fs.statSync(abs).mode & 0o200) === 0 } catch { return false } }

/**
 * After the file check: the player's keys go into the files that hold them, and every mod menu's settings file is made
 * to match (the server's copy, or only the player's keys) and read-only. Returns the paths written and the menus locked.
 */
function applyKeysAndMenus({ gameDir, manifest, choices, resolveInside }) {
  const byFile = keyValuesByFile(manifest.keys, choices)
  const listed = new Map((manifest.files || []).map(f => [f.path.toLowerCase(), f]))
  const menus = new Set((manifest.mcm || []).map(m => m.path.toLowerCase()))
  const targets = new Map()
  for (const f of Object.values(byFile)) targets.set(f.path.toLowerCase(), f.path)
  for (const m of manifest.mcm || []) targets.set(m.path.toLowerCase(), m.path)
  const written = []
  for (const [lower, rel] of targets) {
    const abs = resolveInside(gameDir, rel), entry = listed.get(lower), values = byFile[lower]?.values || {}
    const expected = ini.withValues(entry?.ini || {}, values), current = readSettings(abs)
    if (!current || !ini.sameSettings(current, expected)) {
      // A listed file already holds the server's copy (the check put it back); only the player's keys change in it.
      // A menu file the server has none of holds only the player's keys (MCM Helper then uses the mod's defaults).
      let base = ''
      if (entry) try { base = fs.readFileSync(abs, 'utf8') } catch { /* put back by the check */ }
      // A key given twice in the file would keep its old value (the last one counts): then every line is matched
      let text = ini.applyEdits(entry ? base : '', values)
      if (!ini.sameSettings(ini.settings(text), expected)) text = ini.matchSettings(text, expected)
      replaceText(abs, text)
      written.push(rel)
    }
    if (menus.has(lower) && !isReadOnly(abs)) setReadOnly(abs)
  }
  return { written, menusLocked: menus.size }
}

// Allowlist-style patterns: * stays inside one folder, ** crosses folders; case does not matter (Windows).
function globRegex(pattern) {
  return new RegExp(`^${pattern.split('**').map(part => part.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`, 'i')
}
function walk(dir, base = '') {
  let entries
  try { entries = fs.readdirSync(path.join(dir, base), { withFileTypes: true }) } catch { return [] }
  return entries.flatMap(e => {
    const rel = base ? `${base}/${e.name}` : e.name
    return e.isDirectory() ? walk(dir, rel) : (e.isFile() || e.isSymbolicLink()) ? [rel] : []
  })
}

/**
 * Files the server does not use in the folders its sweep names are moved into "<game>/Dovakarn removed files/<time>/",
 * keeping their paths, so nothing is deleted. Listed files, the mod menus' settings files and the keep patterns stay.
 */
// installed: paths (lower case) the launcher installed from the server's install list, which are the server's own files too
function sweepExtras({ gameDir, manifest, now = new Date(), keep: installed = null }) {
  const sweep = manifest.sweep
  if (!sweep || !Array.isArray(sweep.patterns) || !sweep.patterns.length) return []
  const patterns = sweep.patterns.map(globRegex), keep = (sweep.keep || []).map(globRegex)
  // Files the server has but cannot share (unresolved) are the server's too, so a player who has them keeps them
  const known = new Set([...(installed || []), ...(manifest.files || []).map(f => f.path.toLowerCase()), ...(manifest.mcm || []).map(m => m.path.toLowerCase()),
    ...(manifest.keys || []).map(k => k.file.toLowerCase()), ...(Array.isArray(manifest.unresolved) ? manifest.unresolved : []).map(u => String(u?.path).toLowerCase())])
  // Each pattern's fixed folder, looked at once: into its subfolders only when the pattern reaches them (Data/*.ini
  // lists Data itself, never its meshes and textures).
  const roots = new Map()
  for (const p of sweep.patterns) {
    const parts = p.split('/'), at = parts.findIndex(s => s.includes('*'))
    if (at < 1) continue
    const root = parts.slice(0, at).join('/'), deep = p.includes('**') || parts.length - at > 1
    roots.set(root, roots.get(root) || deep)
  }
  const files = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() || e.isSymbolicLink()).map(e => e.name) } catch { return [] } }
  // The player's own clock, as Explorer shows times: "YYYY-MM-DD hh-mm-ss"
  const two = n => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
  const moved = []
  for (const [root, deep] of roots) {
    for (const inner of deep ? walk(path.join(gameDir, root)) : files(path.join(gameDir, root))) {
      const rel = `${root}/${inner}`, lower = rel.toLowerCase()
      if (lower.endsWith('.dovakarn-part') || known.has(lower) || keep.some(re => re.test(rel)) || !patterns.some(re => re.test(rel))) continue
      const from = path.join(gameDir, rel), to = path.join(gameDir, REMOVED, stamp, rel)
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        try { fs.chmodSync(from, 0o666) } catch { /* moved as it is */ }
        fs.renameSync(from, to)
        moved.push(rel)
      } catch { /* A file in use stays; the next check tries again. */ }
    }
  }
  return moved
}

module.exports = { REMOVED, SERVER_GAME, GAME_KEY_SETTING, isServerGame, validKey, keyValuesByFile, gameKeyValues, gameKeySettings, expectedSettings, readSettings, remember, recall, pruneCopies, settingsCopy, applyKeysAndMenus, sweepExtras, globRegex }
