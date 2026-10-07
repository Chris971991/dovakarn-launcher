// The local test PC is also the server: rebuild the player file list from the installed game
// copy, then check against it, so a fix copied straight into the game is published instead of
// rolled back. The build folder is never used.
const path = require('path')
const { checkGameFiles } = require('./fileCheck')

// publish rebuilds the list off the main thread (hostJobs.js) and resolves when it is written.
// keyChoices: the keys the player bound in Settings, Controls (main.js modKeyChoices). hostGameDir: the server's own game
// copy, which the list is built from: playing from it, nothing is swept out of it (a file moved out would leave the list).
function createLocalFileCheck({ publish, fileList, gameDir, cacheFile, keyChoices = () => ({}), hostGameDir = () => '' }) {
  const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
  // published: server setup has just rebuilt the list, so it is not built twice.
  const check = async (onProgress, { published = false, signal } = {}) => {
    if (!published) await publish()
    const dir = gameDir()
    return checkGameFiles({ gameDir: dir, ...fileList, cacheFile: cacheFile(), onProgress, signal, keyChoices: keyChoices(), sweep: !same(dir, hostGameDir()) })
  }
  // Also exposed on its own, so the launcher can show a current list (collection link, version) on open.
  check.publish = publish
  return check
}

module.exports = { createLocalFileCheck }
