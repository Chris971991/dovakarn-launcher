/**
 * Minimal INI reader/editor for the launcher's Settings tab.
 *
 * read(path)  → { Section: { key: value, ... }, ... }  (empty object if missing)
 * write(path, edits) applies edits { Section: { key: value } } in place,
 *   preserving every other line, comment and ordering. Missing keys are
 *   appended to their section; missing sections are appended to the file.
 *
 * Skyrim INIs use CRLF; we preserve whatever the file already uses (CRLF if
 * present, else LF) and default to CRLF for brand-new files.
 */
const fs = require('fs')
const path = require('path')

function read(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return {}
  }
  const out = {}
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) {
      section = sec[1]
      out[section] = out[section] || {}
      continue
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim()
      out[section] = out[section] || {}
      out[section][k] = v
    }
  }
  return out
}

function write(filePath, edits) {
  let text = ''
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    text = ''
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, applyEdits(text, edits))
}

// The text with edits applied (the same rules as write), for callers that write the result themselves.
// Section and key names match in any case, as the mods read them.
function applyEdits(text, edits) {
  text = String(text).replace(/^\uFEFF/, '')
  const eol = text.includes('\r\n') ? '\r\n' : (text.includes('\n') ? '\n' : '\r\n')
  const lines = text.length ? text.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  // Per section (lower case): its name as the edits give it, and the keys still to write (lower case -> [name, value]).
  const wanted = new Map()
  for (const [s, map] of Object.entries(edits)) {
    const entry = wanted.get(s.toLowerCase()) || { name: s, keys: new Map() }
    for (const [k, v] of Object.entries(map)) entry.keys.set(k.toLowerCase(), [k, v])
    wanted.set(s.toLowerCase(), entry)
  }
  const flush = (sec, result) => {
    const entry = wanted.get(sec)
    if (!entry) return
    for (const [k, v] of entry.keys.values()) result.push(`${k}=${v}`)
    entry.keys.clear()
  }

  const result = []
  let curSection = ''
  for (const raw of lines) {
    const trimmed = raw.trim()
    const sec = /^\[(.+)\]$/.exec(trimmed)
    if (sec) {
      flush(curSection, result) // append any unwritten keys before leaving the section
      curSection = sec[1].trim().toLowerCase()
      result.push(raw)
      continue
    }
    const eq = trimmed.indexOf('=')
    const entry = wanted.get(curSection)
    if (eq > 0 && entry && !trimmed.startsWith(';') && !trimmed.startsWith('#')) {
      const k = trimmed.slice(0, eq).trim(), hit = entry.keys.get(k.toLowerCase())
      if (hit) {
        result.push(`${k}=${hit[1]}`)
        entry.keys.delete(k.toLowerCase())
        continue
      }
    }
    result.push(raw)
  }
  flush(curSection, result)

  // Sections that didn't exist in the file at all.
  for (const entry of wanted.values()) {
    if (!entry.keys.size) continue
    if (result.length && result[result.length - 1].trim() !== '') result.push('')
    result.push(`[${entry.name}]`)
    for (const [k, v] of entry.keys.values()) result.push(`${k}=${v}`)
  }
  return result.join(eol) + (result.length ? eol : '')
}

/**
 * A mod INI's settings as the mods read them (SimpleIni without inline comments): { section: { key: value } } with
 * section and key names in lower case and values trimmed. Comments, blank lines, spacing and order do not count, and a
 * key given twice keeps its last value. The server's player file list carries this for every locked INI, and the
 * launcher compares a player's file by it, so a mod saving its own file again with other spacing is not a change.
 */
function settings(text) {
  const out = {}
  let section = ''
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) { section = sec[1].trim().toLowerCase(); continue }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    if (!key) continue
    ;(out[section] = out[section] || {})[key] = line.slice(eq + 1).trim()
  }
  return out
}

/** Same settings: every section and key present in both, with the same values. */
function sameSettings(a, b) {
  const keys = s => Object.entries(s || {}).flatMap(([section, map]) => Object.keys(map).map(k => `${section}\u0000${k}`)).sort()
  const ka = keys(a), kb = keys(b)
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every(k => { const [s, key] = k.split('\u0000'); return a[s][key] === b[s][key] })
}

/**
 * text rewritten so its settings are exactly target ({ section: { key: value } }, names in lower case as settings() gives
 * them): each of target's keys keeps its line and its own spelling with target's value, a key target lacks or a key
 * given twice is dropped, and a missing key is added to its section. Comments, blank lines and other lines stay. For a
 * locked mod INI with no clean copy to put back (a player edited it, and Vortex's hard link carried the edit into its
 * staging copy too).
 */
function matchSettings(text, target) {
  text = String(text).replace(/^\uFEFF/, '')
  const eol = text.includes('\r\n') ? '\r\n' : (text.includes('\n') ? '\n' : '\r\n')
  const lines = text.length ? text.split(/\r?\n/) : []
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  // Per section, the keys still to write
  const left = new Map(Object.entries(target || {}).map(([s, map]) => [s, new Map(Object.entries(map))]))
  const result = []
  let section = ''
  const flush = () => {
    const keys = left.get(section)
    if (!keys) return
    for (const [k, v] of keys) result.push(`${k}=${v}`)
    keys.clear()
  }
  for (const raw of lines) {
    const line = raw.trim()
    const sec = /^\[(.+)\]$/.exec(line)
    if (sec) { flush(); section = sec[1].trim().toLowerCase(); result.push(raw); continue }
    const eq = line.indexOf('=')
    const name = eq > 0 && !line.startsWith(';') && !line.startsWith('#') ? line.slice(0, eq).trim() : ''
    // Not a setting (a comment, a blank line, a line without "="): settings() skips it, so it stays as it is
    if (!name) { result.push(raw); continue }
    const keys = left.get(section), key = name.toLowerCase()
    if (!keys || !keys.has(key)) continue
    const value = keys.get(key)
    result.push(line.slice(eq + 1).trim() === value ? raw : `${name}=${value}`)
    keys.delete(key)
  }
  flush()
  // Keys before any section go at the top; missing sections at the end
  const top = left.get('')
  if (top && top.size) { result.unshift(...[...top].map(([k, v]) => `${k}=${v}`)); top.clear() }
  for (const [s, keys] of left) {
    if (!keys.size) continue
    if (result.length && result[result.length - 1].trim() !== '') result.push('')
    result.push(`[${s}]`)
    for (const [k, v] of keys) result.push(`${k}=${v}`)
  }
  return result.join(eol) + (result.length ? eol : '')
}

/** settings with some values replaced ({ section: { key: value } }, names in any case); a copy. */
function withValues(base, values) {
  const out = JSON.parse(JSON.stringify(base || {}))
  for (const [section, map] of Object.entries(values || {})) {
    const s = section.toLowerCase()
    for (const [key, value] of Object.entries(map)) (out[s] = out[s] || {})[key.toLowerCase()] = String(value)
  }
  return out
}

module.exports = { read, write, applyEdits, settings, sameSettings, matchSettings, withValues }
