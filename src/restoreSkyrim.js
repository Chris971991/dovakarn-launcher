// "Put my Skyrim back": undoes what launchers before 3.0 did to the player's own Skyrim, now that Dovakarn has its own
// game. Only what those launchers did is touched:
//   - Dovakarn's own files go: the server's files whose content is exactly the server's. Other SkyMP servers use
//     the same names under Data\Platform, so a file is never removed for its name alone, except
//     DovakarnProfile.dll, which only Dovakarn has. A hard-linked file is a Vortex deployment (a mod the server also
//     uses, such as Address Library), so it stays for Vortex; one with other content (an older Dovakarn, or another
//     server's) stays too, and is counted so the page says so;
//   - files they moved out come back where they were ("Dovakarn removed files", "disabled CC mods"), never over a file
//     that is there now;
//   - mod menu settings files they made read-only are writable again.
// Mod files they adapted for online play belong to the player's Vortex, which puts them back when it deploys.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { resolveInside } = require('./fileCheck')
const { REMOVED } = require('./modSettings')

const CC_DISABLED = 'disabled CC mods'
// Paths only Dovakarn uses, whatever version put them there
const OURS = [/^Data\/SKSE\/Plugins\/DovakarnProfile\.dll$/i]

const sha256Of = file => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256')
  fs.createReadStream(file).on('data', c => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
})
const isFile = file => { try { return fs.statSync(file).isFile() } catch { return false } }
const walk = (dir, base = '') => {
  let entries = []
  try { entries = fs.readdirSync(path.join(dir, base), { withFileTypes: true }) } catch { return [] }
  return entries.flatMap(e => { const rel = base ? `${base}/${e.name}` : e.name; return e.isDirectory() ? walk(dir, rel) : e.isFile() ? [rel] : [] })
}
// Removes a folder left empty, and the empty folders inside it
function pruneEmpty(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) if (e.isDirectory()) pruneEmpty(path.join(dir, e.name))
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir) } catch { /* still in use */ }
}

/**
 * manifest: the server's player file list (Dovakarn's own files, kind 'dovahzul' in the list, and mod menus). Returns what was done, counted, for the
 * page to say. A file in use stays where it is and is counted as left.
 */
async function restoreSkyrim({ skyrimDir, manifest }) {
  const out = { removed: 0, returned: 0, unlocked: 0, left: 0, linked: 0, differs: 0 }
  const listed = new Map((manifest?.files || []).filter(f => f.kind === 'dovahzul').map(f => [f.path.toLowerCase(), f]))
  // 1. Dovakarn's own files
  for (const rel of walk(skyrimDir)) {
    const lower = rel.toLowerCase(), entry = listed.get(lower)
    if (lower.startsWith(`${REMOVED.toLowerCase()}/`) || lower.startsWith(`${CC_DISABLED.toLowerCase()}/`)) continue
    const ours = OURS.some(re => re.test(rel))
    if (!ours && !entry) continue
    const abs = path.join(skyrimDir, ...rel.split('/'))
    let stat
    try { stat = fs.statSync(abs) } catch { continue }
    if (stat.nlink > 1) { out.linked++; continue }
    if (!ours && await sha256Of(abs) !== entry.sha256) { out.differs++; continue }
    try { fs.chmodSync(abs, 0o666); fs.rmSync(abs); out.removed++ } catch { out.left++ }
  }
  pruneEmpty(path.join(skyrimDir, 'Data', 'Platform'))
  // 2. Files moved out, oldest first: the first time a file was moved it was the player's own
  const moved = path.join(skyrimDir, REMOVED)
  let stamps = []
  try { stamps = fs.readdirSync(moved, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() } catch { /* none */ }
  for (const stamp of stamps) {
    for (const rel of walk(path.join(moved, stamp))) {
      let to
      try { to = resolveInside(skyrimDir, rel) } catch { out.left++; continue }
      if (fs.existsSync(to)) { out.left++; continue }
      try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(path.join(moved, stamp, ...rel.split('/')), to); out.returned++ } catch { out.left++ }
    }
  }
  const cc = path.join(skyrimDir, CC_DISABLED)
  for (const rel of walk(cc).filter(r => !r.includes('/'))) {
    const to = path.join(skyrimDir, 'Data', rel)
    if (fs.existsSync(to)) { out.left++; continue }
    try { fs.renameSync(path.join(cc, rel), to); out.returned++ } catch { out.left++ }
  }
  for (const dir of [moved, cc]) pruneEmpty(dir)
  // 3. Mod menu settings files made read-only
  for (const m of manifest?.mcm || []) {
    let abs
    try { abs = resolveInside(skyrimDir, m.path) } catch { continue }
    if (!isFile(abs)) continue
    try { if (!(fs.statSync(abs).mode & 0o200)) { fs.chmodSync(abs, 0o666); out.unlocked++ } } catch { out.left++ }
  }
  return out
}

// What was done, as the page says it
function describe(r) {
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`
  const done = [r.removed && `removed ${n(r.removed, 'Dovakarn file')}`, r.returned && `put back ${n(r.returned, 'file')} earlier launchers moved out`,
    r.unlocked && `made ${n(r.unlocked, 'mod settings file')} writable again`].filter(Boolean)
  const head = done.length ? `Done: ${done.join(', ')}.` : r.differs || r.linked ? 'Nothing was removed.' : 'Nothing of Dovakarn was left in your Skyrim.'
  const one = r.left === 1
  const left = r.left ? ` ${n(r.left, 'file')} could not be moved, because ${one ? 'it is' : 'they are'} in use or a file of yours is there now. ${one ? 'It stays where it was' : 'They stay where they were'}.` : ''
  const differs = r.differs ? ` ${n(r.differs, 'file')} at Dovakarn's paths ${r.differs === 1 ? 'has' : 'have'} other content, from an older Dovakarn or another multiplayer server, so ${r.differs === 1 ? 'it was' : 'they were'} left. If only Dovakarn used this Skyrim, delete its Data\\Platform folder yourself.` : ''
  const linked = r.linked ? ` ${n(r.linked, 'file')} Vortex put there ${r.linked === 1 ? 'was' : 'were'} left for Vortex.` : ''
  return `${head}${left}${differs}${linked} If you use Vortex, open it and deploy, or remove the Dovakarn collection there. Vortex then puts back any mod file Dovakarn changed. Steam's "Verify integrity of game files" returns Skyrim to Steam's own version.`
}

module.exports = { restoreSkyrim, describe, OURS }
