// Whether Skyrim is really open. A closed Skyrim can linger for hours as a windowless,
// "Not Responding" process that Windows cannot finish ending; that must not count as an
// open game. A starting game (no window yet, but not hung) or a hung game with a window
// still counts, so a second copy is never launched by mistake.
const { execFile } = require('child_process')

// tasklist /V /FO CSV /NH columns: image, PID, session, session number, memory, status, user,
// CPU time, window title. Memory contains commas, so fields are split on the quote boundaries.
function parseTasklist(output) {
  return String(output).split(/\r?\n/).filter(line => line.startsWith('"')).map(line => {
    const fields = line.trim().replace(/^"|"$/g, '').split('","')
    return { image: fields[0], status: fields[5], title: fields[8] }
  })
}

// English Windows labels; on other languages the lingering case is not recognised and the
// process counts as open, which is the old, safe behaviour.
const lingering = row => row.status === 'Not Responding' && row.title === 'N/A'

function liveSkyrim(output) {
  return parseTasklist(output).some(row => row.image && row.image.toLowerCase() === 'skyrimse.exe' && !lingering(row))
}

function isSkyrimRunning() {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise(resolve => {
    execFile('tasklist', ['/V', '/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq SkyrimSE.exe'], { timeout: 5000, windowsHide: true },
      (error, stdout) => resolve(!error && liveSkyrim(stdout)))
  })
}

module.exports = { isSkyrimRunning, liveSkyrim, parseTasklist }
