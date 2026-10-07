const fs = require('fs')
const path = require('path')

// Exact supported game build for this launcher/server pair.
// The server targets Steam Skyrim SE 1.6.1170.0, so block launch unless the
// installed executable matches this build exactly.
const REQUIRED_SKYRIM_VERSION = '1.6.1170.0'

function normalizeVersion(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/^v/i, '').replace(/[,]/g, '.')
  const pieces = trimmed.split(/[\s\._-]+/).filter(Boolean)
  if (pieces.length === 0) return ''

  const digits = pieces.flatMap(part => part.split('.')).filter(part => part !== '')
  if (digits.length === 0) return ''

  const numeric = digits.map(part => part.replace(/[^0-9]/g, ''))
  return numeric.filter(Boolean).join('.')
}

function isExactVersionMatch(actualVersion, requiredVersion = REQUIRED_SKYRIM_VERSION) {
  return normalizeVersion(actualVersion) === normalizeVersion(requiredVersion)
}

// The PowerShell command that reads the exe's file version. The path reaches it through an environment variable and
// -LiteralPath, never pasted into the command text, so no folder name can change what runs.
const VERSION_COMMAND = '(Get-Item -LiteralPath $env:DOVAKARN_EXE_PATH).VersionInfo.FileVersion'

// Resolves to the exe's file version or null, without freezing the launcher while PowerShell starts.
function readSkyrimExeVersion(gamePath) {
  if (!gamePath || !fs.existsSync(gamePath)) return Promise.resolve(null)
  const exePath = path.join(gamePath, 'SkyrimSE.exe')
  if (!fs.existsSync(exePath)) return Promise.resolve(null)

  return new Promise(resolve => {
    require('child_process').execFile('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      VERSION_COMMAND,
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, DOVAKARN_EXE_PATH: exePath } },
    (error, out) => resolve(error ? null : normalizeVersion(out)))
  })
}

module.exports = {
  REQUIRED_SKYRIM_VERSION,
  VERSION_COMMAND,
  normalizeVersion,
  isExactVersionMatch,
  readSkyrimExeVersion,
}
