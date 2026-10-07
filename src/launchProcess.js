const { spawn } = require('node:child_process')

// A returned ChildProcess does not mean Windows accepted the executable.
// Wait for spawn/error so callers can show launch failures instead of crashing.
function launchDetached(executable, args, cwd, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { detached: true, stdio: 'ignore', cwd })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

module.exports = { launchDetached }
