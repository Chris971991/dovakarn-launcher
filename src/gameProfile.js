// The game copy's own load order and Skyrim INI files, in "<copy>\Dovakarn Profile". DovakarnProfile.dll (an SKSE plugin
// in the copy) makes the game and every mod use these instead of the player's Plugins.txt (AppData) and INIs (Documents),
// so playing Dovakarn never changes the player's own Skyrim. The INIs start as copies of the player's own (their screen
// size, language and graphics) and are the copy's from then on.
const fs = require('fs')
const path = require('path')
const ini = require('./ini')
const { profileDirOf } = require('./gameCopy')

const INIS = ['Skyrim.ini', 'SkyrimPrefs.ini', 'SkyrimCustom.ini']
const BASE_MASTERS = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'])
// Bethesda.net drives the main menu's Creations news and the "download AE content" prompt; the copy never uses Creations
const FORCED = { 'Skyrim.ini': { 'Bethesda.net': { bEnablePlatform: '0' } } }

const appDataDirOf = gameDir => path.join(profileDirOf(gameDir), 'AppData', 'Skyrim Special Edition')
const pluginsFileOf = gameDir => path.join(appDataDirOf(gameDir), 'Plugins.txt')

// Through a side file, so a failure never leaves half a file
function replaceText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const part = `${file}.dovakarn-part`
  fs.writeFileSync(part, text)
  try { fs.renameSync(part, file) } catch (error) { fs.rmSync(part, { force: true }); throw error }
}

/**
 * The copy's Plugins.txt: exactly the server's plugins, in its order (the base game's masters load by themselves).
 * Returns whether it changed.
 */
function writeLoadOrder(gameDir, loadOrder) {
  const lines = loadOrder.map(p => path.basename(String(p))).filter(p => !BASE_MASTERS.has(p.toLowerCase())).map(p => `*${p}`)
  const text = lines.join('\r\n') + '\r\n', file = pluginsFileOf(gameDir)
  let current = null
  try { current = fs.readFileSync(file, 'utf8') } catch { /* first time */ }
  if (current === text) return false
  replaceText(file, text)
  return true
}

/**
 * The copy's INIs, seeded once: the player's own from Documents\My Games when they have them, otherwise the game's
 * defaults (Skyrim_Default.ini, and the SkyrimPrefs.ini Steam ships in the game's Skyrim folder). Dovakarn's forced
 * settings are put in every time. myGamesDir: the player's "Documents\My Games\Skyrim Special Edition".
 */
function seedInis(gameDir, myGamesDir) {
  const profile = profileDirOf(gameDir), seeded = []
  fs.mkdirSync(profile, { recursive: true })
  for (const name of INIS) {
    const file = path.join(profile, name)
    if (fs.existsSync(file)) continue
    const own = myGamesDir && path.join(myGamesDir, name)
    const fallback = { 'Skyrim.ini': path.join(gameDir, 'Skyrim_Default.ini'), 'SkyrimPrefs.ini': path.join(gameDir, 'Skyrim', 'SkyrimPrefs.ini') }[name]
    const from = [own, fallback].find(f => f && fs.existsSync(f))
    replaceText(file, from ? fs.readFileSync(from) : '')
    seeded.push({ name, from: from ? (from === own ? 'yours' : 'defaults') : 'empty' })
  }
  // Written only when a value differs, so the file is not touched on every Play
  for (const [name, values] of Object.entries(FORCED)) {
    const file = path.join(profile, name), text = fs.readFileSync(file, 'utf8'), have = ini.settings(text)
    const differs = Object.entries(values).some(([section, keys]) => Object.entries(keys).some(([k, v]) => have[section.toLowerCase()]?.[k.toLowerCase()] !== v))
    if (differs) replaceText(file, ini.applyEdits(text, values))
  }
  return seeded
}

module.exports = { INIS, FORCED, appDataDirOf, pluginsFileOf, writeLoadOrder, seedInis }
