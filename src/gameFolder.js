// Checks a Skyrim folder a player picked before the launcher plays from it.
const fs = require('fs')
const path = require('path')

// Picking the Data folder by mistake is common; use the game folder above it.
function gameFolderFromPick(dir) {
  if (typeof dir !== 'string' || !dir) return ''
  if (path.basename(dir).toLowerCase() === 'data' && fs.existsSync(path.join(dir, '..', 'SkyrimSE.exe'))) return path.dirname(dir)
  return dir
}

// Why a folder can't be chosen, or '' when it can. Another Skyrim version is chosen all the same: Steam's current one
// is what every new player has, and the main screen offers to switch it to the version Dovakarn needs.
async function gameFolderProblem(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'SkyrimSE.exe'))) return 'That folder has no SkyrimSE.exe. Choose the Skyrim Special Edition folder itself, the one with SkyrimSE.exe in it.'
  return ''
}

// Junctions count: combat-test\skyrim can point at the very folder picked.
const real = dir => { try { return fs.realpathSync.native(dir) } catch { return path.resolve(dir) } }
const sameFolder = (a, b) => !!a && !!b && real(a).toLowerCase().replace(/[\\/]+$/, '') === real(b).toLowerCase().replace(/[\\/]+$/, '')

module.exports = { gameFolderFromPick, gameFolderProblem, sameFolder }
