'use strict'

/**
 * Legacy Mod Organizer 2 support. Earlier launchers set up a portable MO2 instance; the current launcher no longer
 * installs or offers MO2 (servers with a file list refuse MO2 launches), but an existing instance can still be launched
 * through, and the pre-launch guards below still apply to it.
 *
 *   %LOCALAPPDATA%\SkyRP\MO2\      the legacy instance folder (name kept so existing installs are found)
 *     ModOrganizer.exe             MO2 itself
 *     ModOrganizer.ini             portable instance config
 *     mods\<Mod Name>\             installed mods
 *     profiles\SkyRP\               the single launcher-managed profile (legacy name, kept for existing installs)
 */

const path = require('path')
const fs   = require('fs')
const os   = require('os')
const { spawn } = require('child_process')

const MO2_VERSION = '2.5.2'
// Legacy profile name, kept so instances made by earlier launchers keep working
const PROFILE     = 'SkyRP'

// Logger
let _log = (...args) => console.log('[mo2]', ...args)
function setLogger(fn) { _log = (...args) => fn('[mo2]', ...args) }

// Paths

let _rootProvider = null
function setRootProvider(fn) { _rootProvider = fn }

function getRoot() {
  const custom = _rootProvider ? _rootProvider() : null
  if (custom) return custom
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  // Legacy folder name, kept so instances made by earlier launchers are found
  return path.join(local, 'SkyRP', 'MO2')
}

const getExe          = () => path.join(getRoot(), 'ModOrganizer.exe')
const getDownloadsDir = () => path.join(getRoot(), 'downloads')
const getModsDir      = () => path.join(getRoot(), 'mods')
const getProfileDir   = () => path.join(getRoot(), 'profiles', PROFILE)

function isInstalled() {
  return fs.existsSync(getExe())
}

// Portable instance / profile

// Forward slashes everywhere: valid for Windows APIs and avoids INI escaping.
const fwd = p => p.replace(/\\/g, '/')

// Detect the Skyrim SE store edition
function detectEdition(gameDir) {
  try {
    const names = fs.readdirSync(gameDir)
    const lower = new Set(names.map(name => name.toLowerCase()))
    if (lower.has('galaxy64.dll') || names.some(f => /^goggame-.*\.(info|dll|hashdb)$/i.test(f))) return 'GOG'
    if (lower.has('eossdk-win64-shipping.dll')) return 'Epic Games'
    if (names.some(f => /^Gaming\.Desktop|appxmanifest/i.test(f))) return 'Microsoft Store'
    if (lower.has('steam_api64.dll')) return 'Steam'
  } catch { /* unreadable */ }
  return 'Unknown'
}

function instanceDirLines() {
  const root = fwd(getRoot())
  return [
    `base_directory=${root}`,
    `mod_directory=${root}/mods`,
    `download_directory=${root}/downloads`,
    `cache_directory=${root}/webcache`,
    `profiles_directory=${root}/profiles`,
    `overwrite_directory=${root}/overwrite`,
  ]
}

// The custom-executable entry (array slot n) that moshortcut://:SKSE resolves against.
function skseExecutableLines(skyrimPath, n) {
  return [
    `${n}\\title=SKSE`,
    `${n}\\binary=${fwd(path.join(skyrimPath, 'skse64_loader.exe'))}`,
    `${n}\\workingDirectory=${fwd(skyrimPath)}`,
    `${n}\\arguments=`,
    `${n}\\hide=false`,
    `${n}\\toolbar=true`,
    `${n}\\ownicon=true`,
  ]
}

// Full portable-instance ini, written once when the instance is first created.
function buildInstanceIni(skyrimPath, style) {
  return [
    '[General]',
    'gameName=Skyrim Special Edition',
    `gameEdition=${detectEdition(skyrimPath)}`,
    `gamePath=@ByteArray(${fwd(skyrimPath)})`,
    `selected_profile=@ByteArray(${PROFILE})`,
    `version=${MO2_VERSION}`,
    'first_start=false',
    '',
    '[Settings]',
    'check_for_updates=false',
    ...instanceDirLines(),
    ...(style ? [`style=${style}`] : []),
    '',
    '[customExecutables]',
    'size=1',
    ...skseExecutableLines(skyrimPath, 1),
    '',
  ].join('\r\n')
}

// Reinstate a lost SKSE shortcut entry; MO2 cannot resolve moshortcut://:SKSE without it.
function ensureSkseEntry(txt, skyrimPath) {
  const lines = txt.split(/\r?\n/)
  const start = lines.findIndex(l => l.trim() === '[customExecutables]')
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
    return lines.concat(['', '[customExecutables]', 'size=1', ...skseExecutableLines(skyrimPath, 1), '']).join('\r\n')
  }
  let end = start + 1
  while (end < lines.length && !/^\[/.test(lines[end].trim())) end++
  // Append as the next array slot, bumping (or adding) the section's size counter.
  let n = 1
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^size=(\d+)/)
    if (m) { n = parseInt(m[1], 10) + 1; lines[i] = `size=${n}`; break }
  }
  const insert = skseExecutableLines(skyrimPath, n)
  if (n === 1) insert.unshift('size=1')
  let at = end
  while (at > start + 1 && lines[at - 1].trim() === '') at--
  lines.splice(at, 0, ...insert)
  return lines.join('\r\n')
}

// Update ini path
function healInstancePaths(iniPath, skyrimPath) {
  const gamePath = fwd(skyrimPath)
  const ssePath  = fwd(path.join(skyrimPath, 'skse64_loader.exe'))
  let txt = fs.readFileSync(iniPath, 'utf8')
  // Function replacers avoid '$' in paths being treated as replacement tokens.
  txt = txt.replace(/^gamePath=.*$/m, () => `gamePath=@ByteArray(${gamePath})`)

  // Heal the SKSE entry by its title (MO2 may reorder the array on save), or reinstate it when lost.
  const skseIdx = (txt.match(/^(\d+)\\title=SKSE\s*$/m) || [])[1]
  if (skseIdx) {
    txt = txt.replace(new RegExp(`^${skseIdx}\\\\binary=.*$`, 'm'),           () => `${skseIdx}\\binary=${ssePath}`)
    txt = txt.replace(new RegExp(`^${skseIdx}\\\\workingDirectory=.*$`, 'm'), () => `${skseIdx}\\workingDirectory=${gamePath}`)
  } else {
    txt = ensureSkseEntry(txt, skyrimPath)
  }

  // Upsert each directory pin: replace an existing key or append under [Settings].
  for (const line of instanceDirLines()) {
    const key = line.slice(0, line.indexOf('='))
    const re = new RegExp(`^${key}=.*$`, 'm')
    if (re.test(txt)) txt = txt.replace(re, () => line)
    else if (/^\[Settings\]\s*$/m.test(txt)) txt = txt.replace(/^\[Settings\]\s*$/m, m => `${m}\r\n${line}`)
    else txt += `\r\n[Settings]\r\n${line}\r\n`
  }
  fs.writeFileSync(iniPath, txt)
}

/**
 * Pick a dark stylesheet bundled with MO2 (preference order, then any *.qss
 * with "dark" in the name). Returns '' if none found.
 */
function pickDarkStyle() {
  const dir = path.join(getRoot(), 'stylesheets')
  const preferred = ['Paper Dark.qss', 'paper-dark.qss', 'VS15.qss', 'dark.qss', '1809.qss']
  try {
    const files = fs.readdirSync(dir)
    for (const name of preferred) {
      if (files.includes(name)) return name
    }
    const anyDark = files.find(f => /dark/i.test(f) && f.toLowerCase().endsWith('.qss'))
    if (anyDark) return anyDark
  } catch { /* stylesheets dir missing */ }
  return ''
}

/**
 * Create or refresh the portable instance config and the launcher-managed profile.
 * Safe to call repeatedly; user data (mods, downloads) is never touched.
 *
 * @param {string}   skyrimPath
 * @param {string[]} [loadOrder]  Server esp/esm order for the profile's plugins.txt
 */
function ensureInstance(skyrimPath, loadOrder) {
  const root = getRoot()
  for (const dir of [getDownloadsDir(), getModsDir(), getProfileDir(), path.join(root, 'overwrite')]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // portable.txt is MO2's portable-instance marker. Without it MO2 ignores
  // the local ModOrganizer.ini and opens the user's registry-selected
  // (global) instance instead.
  fs.writeFileSync(path.join(root, 'portable.txt'), '')

  const iniPath = path.join(root, 'ModOrganizer.ini')
  if (fs.existsSync(iniPath)) {
    healInstancePaths(iniPath, skyrimPath)
  } else {
    fs.writeFileSync(iniPath, buildInstanceIni(skyrimPath, pickDarkStyle()))
  }

  // Profile files - only created when missing so MO2-side changes survive.
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  if (!fs.existsSync(modlistPath)) {
    fs.writeFileSync(modlistPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }

  const pluginsPath = path.join(getProfileDir(), 'plugins.txt')
  if (Array.isArray(loadOrder) && loadOrder.length > 0) {
    const vanilla = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'])
    const lines = loadOrder
      .map(f => path.basename(f))
      .filter(f => !vanilla.has(f.toLowerCase()))
      .map(f => `*${f}`)
    fs.writeFileSync(pluginsPath,
      '# This file was automatically generated by Mod Organizer.\r\n' + lines.join('\r\n') + '\r\n')
  } else if (!fs.existsSync(pluginsPath)) {
    fs.writeFileSync(pluginsPath, '# This file was automatically generated by Mod Organizer.\r\n')
  }
}

// Mod management

// Windows caps fs paths at MAX_PATH (260) unless prefixed with \\?\. Big mods
// (deep mesh trees, e.g. JK's) exceed that while building, so prefix every fs
// boundary - MO2 itself opts into long paths, so it succeeds where plain Node
// copies would fail.
function lp(p) {
  if (process.platform !== 'win32') return p
  const abs = path.resolve(p)
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs
}

// Launch-time lockdown (anti-desync / anti-cheat)

const PLUGIN_RE = /\.(esp|esm|esl)$/i

/** True if modName's meta.ini marks it as launcher-installed (managed; the key name is the one earlier launchers wrote). */
function isManaged(modName) {
  try {
    return /^skyrpManaged\s*=\s*true/im.test(fs.readFileSync(path.join(getModsDir(), modName, 'meta.ini'), 'utf8'))
  } catch { return false }
}

/** Does a mod folder ship a plugin (esp/esm/esl) or an SKSE plugin DLL? */
function modHasRestrictedContent(modDir) {
  const stack = [modDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try { entries = fs.readdirSync(lp(dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.isDirectory()) { stack.push(path.join(dir, e.name)); continue }
      if (PLUGIN_RE.test(e.name)) return true
      if (/\.dll$/i.test(e.name) && /[\\/]skse[\\/]plugins$/i.test(dir)) return true
    }
  }
  return false
}

// Stray plugins and archives in MO2's overwrite folder
const OVERWRITE_JUNK_RE = /\.(esp|esl|esm|bsa)$/i
function cleanOverwrite() {
  const overwrite = path.join(getRoot(), 'overwrite')
  let entries
  try { entries = fs.readdirSync(overwrite, { withFileTypes: true }) } catch { return [] }

  const removed = []
  for (const e of entries) {
    const junk = e.isFile() && (OVERWRITE_JUNK_RE.test(e.name) || /^cc/i.test(e.name))
    if (!junk) continue
    try { fs.rmSync(lp(path.join(overwrite, e.name)), { force: true }); removed.push(e.name) }
    catch (err) { _log(`could not remove overwrite item ${e.name}: ${err.message}`) }
  }
  if (removed.length === 0) return []

  // Drop any now-orphaned plugin lines from plugins.txt (matched case-insensitively).
  const pluginsPath = path.join(getProfileDir(), 'plugins.txt')
  try {
    const gone = new Set(removed.filter(n => OVERWRITE_JUNK_RE.test(n)).map(n => n.toLowerCase()))
    const kept = fs.readFileSync(pluginsPath, 'utf8').split(/\r?\n/)
      .filter(l => !gone.has(l.replace(/^\*/, '').trim().toLowerCase()))
    fs.writeFileSync(pluginsPath, kept.join('\r\n'))
  } catch { /* plugins.txt is rewritten from the server list on install anyway */ }

  _log(`cleaned ${removed.length} stray overwrite item(s): ${removed.join(', ')}`)
  return removed
}

function enforceModRules() {
  const modlistPath = path.join(getProfileDir(), 'modlist.txt')
  let lines
  try { lines = fs.readFileSync(modlistPath, 'utf8').split(/\r?\n/) } catch { return [] }

  const disabled = []
  const out = lines.map(line => {
    if (line[0] !== '+') return line               // comment, blank, or already disabled
    const name = line.slice(1).trim()
    if (!name || name.endsWith('_separator') || isManaged(name)) return line
    if (modHasRestrictedContent(path.join(getModsDir(), name))) {
      disabled.push(name)
      return `-${name}`
    }
    return line
  })

  if (disabled.length > 0) {
    fs.writeFileSync(modlistPath, out.join('\r\n'))
    _log(`disabled ${disabled.length} unauthorised mod(s): ${disabled.join(', ')}`)
  }
  return disabled
}

// Creation Club quarantine (non-portable installs)

// Real CC files follow the ccXXXsseNNN- naming (e.g. ccBGSSSE001-Fish.esm).
// A bare cc* match would also catch community mods like CCOR.esp.
const CC_FILE_RE = /^cc[a-z]{3}sse\d{3}-.*\.(?:es[mlp]|bsa)$/i
// AE extras the engine force-loads without a plugins.txt entry.
const CC_EXTRAS  = new Set(['_resourcepack.esl', '_resourcepack.bsa', 'marketplacetextures.bsa'])

/**
 * Move Creation Club plugins/archives (plus the AE resource pack and
 * marketplace textures) out of <gamePath>/Data into "<gamePath>/disabled CC
 * mods". Non-portable installs play from the user's real Skyrim folder, where
 * the engine force-loads CC content via Skyrim.ccc regardless of plugins.txt
 * and fights the server's load order. Files named in serverLoadOrder are left
 * alone. Idempotent; returns the number of files moved.
 */
function disableCcContent(gamePath, serverLoadOrder) {
  const dataDir = path.join(gamePath, 'Data')
  const keep = new Set((serverLoadOrder || []).map(f => path.basename(f).toLowerCase()))
  let names = []
  try { names = fs.readdirSync(dataDir) } catch { return 0 }

  const destDir = path.join(gamePath, 'disabled CC mods')
  let moved = 0
  for (const name of names) {
    const l = name.toLowerCase()
    if (!(CC_FILE_RE.test(l) || CC_EXTRAS.has(l))) continue
    if (keep.has(l)) continue   // the server actually uses it - leave it alone
    try {
      fs.mkdirSync(lp(destDir), { recursive: true })
      fs.renameSync(lp(path.join(dataDir, name)), lp(path.join(destDir, name)))
      moved++
    } catch (err) {
      _log(`could not move ${name} to disabled CC mods: ${err.message}`)
    }
  }
  if (moved > 0) _log(`moved ${moved} Creation Club file(s) to ${destDir}`)
  return moved
}

// Launch

/** Launch the game through MO2's VFS using the SKSE executable entry. */
function launchGame(skyrimPath) {
  if (!isInstalled()) throw new Error('MO2 is not installed. Run its setup in Settings first.')
  // moshortcut://:SKSE only resolves against the ini's SKSE entry, so verify it and self-heal before spawning.
  const iniPath = path.join(getRoot(), 'ModOrganizer.ini')
  const hasShortcut = () => { try { return /^\d+\\title=SKSE\s*$/m.test(fs.readFileSync(iniPath, 'utf8')) } catch { return false } }
  if (!hasShortcut() && skyrimPath) ensureInstance(skyrimPath)
  if (!hasShortcut()) throw new Error('The MO2 SKSE shortcut is missing from ModOrganizer.ini. Run Install Modlist to repair it.')
  spawn(getExe(), ['-p', PROFILE, 'moshortcut://:SKSE'], {
    detached: true,
    stdio: 'ignore',
    cwd: getRoot(),
  }).unref()
}

module.exports = {
  setLogger,
  setRootProvider,
  detectEdition,
  PROFILE,
  getRoot,
  getDownloadsDir,
  getModsDir,
  getProfileDir,
  isInstalled,
  ensureInstance,
  enforceModRules,
  cleanOverwrite,
  disableCcContent,
  launchGame,
}
