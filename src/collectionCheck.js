// Checks that a player's Vortex has the server's Nexus collection installed at its latest revision.
// Vortex names each installed mod folder after the Nexus file, including the file's upload time, so a
// folder identifies the exact file that was installed. Two spellings exist:
//   "<name>-<mod id>-<version>-<upload time in seconds>"                     (older downloads)
//   "<name> <mod id> <version> <upload time to the minute, UTC> <download id>" (collection installs)
const fs = require('fs')
const path = require('path')
const { nexusHeaders } = require('./nexusApp')

const NEXUS_API = 'https://api-router.nexusmods.com/graphql'
// A link to one revision is accepted too; the check always uses the latest published revision.
const COLLECTION_URL = /^https:\/\/(?:www\.|next\.)?nexusmods\.com\/(?:games\/)?([a-z0-9]+)\/collections\/([a-z0-9]+)(?:\/revisions\/\d+)?\/?(?:[?#].*)?$/i
const VORTEX_SOURCE = /^(.+?)-(\d+)-(.+)-(\d{9,})$/
const VORTEX_COLLECTION_SOURCE = /^(.*\S) (\d+) (\S+) (\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})Z \S+$/
const MANIFEST = /^vortex\.deployment(?:\.[a-z0-9_-]+)?\.json$/i
const QUERY = 'query($slug: String!, $domain: String) { collection(slug: $slug, domainName: $domain, viewAdultContent: true) { name latestPublishedRevision { revisionNumber modFiles { optional fileId file { name version date mod { modId name } } } } } }'

// The game domain and collection id from a Nexus collection link, or null.
function parseCollectionUrl(url) {
  const m = COLLECTION_URL.exec(typeof url === 'string' ? url : '')
  return m ? { domain: m[1].toLowerCase(), slug: m[2] } : null
}

/**
 * A Vortex mod folder's Nexus mod and upload time, or null for folders not named from a Nexus download.
 * `precision` is how exact `uploaded` is, in seconds. In the older spelling a name like "v0-4-20-0" can
 * look like ids, so `ids` holds every number that could be the mod id and matching needs the upload time too.
 */
function parseVortexSource(source) {
  const text = typeof source === 'string' ? source : ''
  let m = VORTEX_COLLECTION_SOURCE.exec(text)
  if (m) {
    const uploaded = Date.UTC(Number(m[4]), Number(m[5]) - 1, Number(m[6]), Number(m[7]), Number(m[8])) / 1000
    return { mod: m[1], modId: Number(m[2]), uploaded, precision: 60, ids: [Number(m[2])] }
  }
  m = VORTEX_SOURCE.exec(text)
  if (!m) return null
  const ids = [...text.slice(0, text.length - m[4].length).matchAll(/-(\d+)(?=-)/g)].map(x => Number(x[1]))
  return { mod: m[1], modId: Number(m[2]), uploaded: Number(m[4]), precision: 1, ids }
}

// A third spelling, for files uploaded before Nexus put an upload time in their names: Vortex names the folder after the
// archive, "<name>-<mod id>-<version>" ("The Notice Board-3218-1-4", Nexus 3218 from 2016). It has no upload time, so any
// installed file of that mod counts as the collection's (uploaded null). Only for names the two spellings above reject.
const VORTEX_UNTIMED_SOURCE = /^(.+?)-(\d+)-(\d+(?:-\d+)*)$/
function parseUntimedVortexSource(source) {
  const text = typeof source === 'string' ? source : ''
  if (parseVortexSource(text)) return null
  const m = VORTEX_UNTIMED_SOURCE.exec(text)
  return m ? { mod: m[1], modId: Number(m[2]), uploaded: null, precision: null, ids: [Number(m[2])] } : null
}

// Whether an installed folder is this exact Nexus file (one named without an upload time counts as any of its mod's files).
const sameUpload = (have, uploaded) => have.uploaded === null || Math.floor(have.uploaded / have.precision) === Math.floor(uploaded / have.precision)

const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : ''
const positive = value => Number.isSafeInteger(value) && value > 0

/** The collection's latest published revision from Nexus: its name, revision and required files. */
async function fetchCollection({ domain, slug, request, endpoint = NEXUS_API }) {
  let reply
  try {
    const body = JSON.stringify({ query: QUERY, variables: { slug, domain } })
    const response = await request(endpoint, { method: 'POST', body, maxBytes: 4 * 1024 * 1024, timeout: 20000,
      headers: nexusHeaders({ 'Content-Type': 'application/json' }) })
    reply = JSON.parse(response.body.toString('utf8'))
  } catch (error) {
    if (error.code === 'NOT_FOUND') throw new Error('The collection link does not lead to a published Nexus collection.')
    throw new Error(`Could not reach Nexus to check the collection: ${error.message}`)
  }
  const collection = reply?.data?.collection
  if (!collection) {
    if (reply?.errors?.some(e => e?.extensions?.code === 'NOT_FOUND')) throw new Error('The collection link does not lead to a published Nexus collection.')
    throw new Error('Nexus did not return the collection.')
  }
  const latest = collection.latestPublishedRevision
  if (!latest || !positive(latest.revisionNumber) || !Array.isArray(latest.modFiles)) throw new Error('Nexus returned the collection in an unexpected format.')
  const mods = []
  for (const entry of latest.modFiles) {
    const file = entry?.file
    if (!file || !positive(file.mod?.modId) || !positive(file.date)) continue
    mods.push({ modId: file.mod.modId, name: text(file.mod.name) || `Nexus mod ${file.mod.modId}`, version: text(file.version, 40), uploaded: file.date, optional: entry.optional === true })
  }
  return { name: text(collection.name), revision: latest.revisionNumber, mods }
}

/** Mods Vortex has installed for this game folder: Nexus mod id to the installed files' upload times. */
function installedMods(gameDir) {
  const byModId = new Map(), staging = new Set(), seen = new Set()
  let deployed = false
  // A suffix Vortex or a person added after the name ("+Other Collection.1", a copy installed for another collection)
  // is ignored, as the server's install list does
  const parse = text => parseVortexSource(text) || parseUntimedVortexSource(text)
  const add = source => {
    const parsed = parse(source) || (typeof source === 'string' && source.includes('+') ? parse(source.replace(/\+[^+]*$/, '')) : null)
    if (!parsed || seen.has(source)) return
    seen.add(source)
    for (const id of parsed.ids) {
      if (!byModId.has(id)) byModId.set(id, [])
      byModId.get(id).push({ uploaded: parsed.uploaded, precision: parsed.precision })
    }
  }
  // Vortex keeps one record per deployment folder: Data for most mods, the game folder for SKSE's loader.
  for (const dir of [path.join(gameDir, 'Data'), gameDir]) {
    let names = []
    try { names = fs.readdirSync(dir).filter(n => MANIFEST.test(n)) } catch { continue }
    for (const name of names) {
      let manifest
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
      if (!Array.isArray(manifest?.files)) continue
      deployed = true
      if (typeof manifest.stagingPath === 'string' && manifest.stagingPath) staging.add(manifest.stagingPath)
      for (const file of manifest.files) add(file?.source)
    }
  }
  // A mod whose files all lose conflicts appears in no record, but it is still installed in the staging folder.
  for (const dir of staging) {
    try { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) add(entry.name) } catch { /* staging folder moved or offline */ }
  }
  return { deployed, byModId }
}

/** Which required collection files are not installed, or installed at a different version. */
function compareCollection(collection, installed) {
  const required = collection.mods.filter(m => !m.optional), missing = [], outdated = []
  for (const mod of required) {
    const have = installed.byModId.get(mod.modId) || []
    if (!have.length) missing.push({ modId: mod.modId, name: mod.name })
    else if (!have.some(h => sameUpload(h, mod.uploaded))) outdated.push({ modId: mod.modId, name: mod.name })
  }
  const byName = (a, b) => a.name.localeCompare(b.name)
  return { revision: collection.revision, total: required.length, missing: missing.sort(byName), outdated: outdated.sort(byName), deployed: installed.deployed }
}

/** The full check for a launcher; network and format problems come back as { error } so they never block play. */
async function checkCollection({ url, gameDir, request, endpoint }) {
  const link = parseCollectionUrl(url)
  if (!link) return null
  try {
    const collection = await fetchCollection({ ...link, request, endpoint })
    return compareCollection(collection, installedMods(gameDir))
  } catch (error) {
    return { error: error.message }
  }
}

module.exports = { parseCollectionUrl, parseVortexSource, parseUntimedVortexSource, fetchCollection, installedMods, compareCollection, checkCollection, NEXUS_API }
