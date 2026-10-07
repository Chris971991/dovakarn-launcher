// Explicit, process-local test mode. Never reuse an online session or server.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
// The local test PC's folders: ROOT holds the local server, REPO is the server checkout this launcher runs from.
// DOVAHZUL_HOME (the local test server's environment variable) overrides ROOT; without it ROOT is the folder beside
// the checkout. combat-test is the local test server's folder layout.
const REPO = path.resolve(__dirname, '../..')
const ROOT = process.env && process.env.DOVAHZUL_HOME ? path.resolve(process.env.DOVAHZUL_HOME) : path.resolve(__dirname, '../../..')
const combat = process.argv.includes('--combat-test')
const enabled = process.argv.includes('--local-test') || combat
let manifest = combat ? JSON.parse(fs.readFileSync(path.join(ROOT, 'combat-test/manifest.json'), 'utf8')) : null
if (manifest && (manifest.mode !== 'combat' || manifest.port !== 7780 || manifest.httpPort !== 7781 || !Array.isArray(manifest.loadOrder))) throw new Error('Invalid combat test manifest')
const profileArg = process.argv.find(a => a.startsWith('--test-profile='))
const profileId = combat && profileArg ? Number(profileArg.split('=')[1]) : 1
if (!Number.isInteger(profileId) || profileId < 1 || profileId > 8) throw new Error('Test profile must be 1 through 8')
const gamePath = manifest?.gamePath
// The combat server publishes its player file list over its loopback HTTP port (dovahzul-* is the server's name for
// these routes).
const fileList = combat ? { manifestUrl: `http://127.0.0.1:${manifest.httpPort}/dovahzul-client-manifest.json`, filesUrl: `http://127.0.0.1:${manifest.httpPort}/dovahzul-files` } : null
const server = { name: combat ? 'Dovakarn-Local-Test' : 'Dovakarn Legacy Basic Test', address: '127.0.0.1', port: combat ? 7780 : 7777 }
const info = {
  ...server, offlineMode: true, masterUrl: '', masterKey: null,
  discordAuthRequired: false, allowed: true, locked: false, maxPlayers: combat ? 8 : 1,
  loadOrder: manifest?.loadOrder || ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm'],
}

function refreshManifest() {
  if (!combat) return
  const next = JSON.parse(fs.readFileSync(path.join(ROOT, 'combat-test/manifest.json'), 'utf8'))
  if (next.mode !== 'combat' || next.port !== 7780 || next.httpPort !== 7781 || next.gamePath !== gamePath || !Array.isArray(next.loadOrder)) throw new Error('Local server setup changed. Close and reopen this launcher.')
  manifest = next
  info.loadOrder = next.loadOrder
}

// With a Discord login the game logs in with its play session (online mode); without one, as test profile N (offline)
function clientSettings(srv, login = null) {
  if (srv.address !== server.address || Number(srv.port) !== server.port) {
    throw new Error(`Local test login is restricted to 127.0.0.1:${server.port}.`)
  }
  // No keys here: the local test plays with the server's keys (the file check's gameKeys), as players do
  const extras = combat ? { difficulty: 2, combatDodgeStamina: true, serverAuthoritativeDamage: true } : {}
  if (login) {
    return {
      'server-ip': server.address, 'server-port': server.port,
      master: login.master, 'server-master-key': login.masterKey, 'server-info-ignore': true,
      'discord-invite': login.inviteUrl || '',
      ...extras,
    }
  }
  return {
    'server-ip': server.address, 'server-port': server.port,
    master: '', 'server-master-key': null, 'server-info-ignore': true,
    gameData: { profileId },
    ...extras,
  }
}

// The local server's login settings, written by the local server window before it starts the
// server: Discord login when it runs online against the local backend, else the offline test profiles.
const LOGIN_SETTINGS = path.join(ROOT, 'combat-test/server/server-settings-login.json')
function loginMode() {
  if (!combat) return { discord: false }
  try {
    const s = JSON.parse(fs.readFileSync(LOGIN_SETTINGS, 'utf8'))
    const discord = s.offlineMode === false && typeof s.master === 'string' && /^https?:\/\//.test(s.master) && typeof s.masterKey === 'string' && s.masterKey.length > 0
    // "http://host:4000/" is the same backend: the game builds "<master>/api/..." from it
    return discord ? { discord: true, master: s.master.replace(/\/+$/, ''), masterKey: s.masterKey } : { discord: false }
  } catch { return { discord: false } }
}

async function status() {
  const http = require('http')
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${combat ? 7781 : 3000}/dovakarn-local-test.json`, response => {
      let body = ''
      response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy() })
      response.on('error', () => resolve({ ok: true, status: 'offline' }))
      response.on('end', () => {
        try {
          const data = JSON.parse(body)
          const ready = response.statusCode === 200 && data.localTest === true && data.offlineMode === true && data.port === server.port && (!combat || (data.mode === 'combat' && JSON.stringify(data.hashes) === JSON.stringify(manifest.hashes)))
          resolve({ ok: true, status: ready ? 'online' : 'offline' })
        } catch { resolve({ ok: true, status: 'offline' }) }
      })
    })
    request.setTimeout(1500, () => request.destroy())
    request.on('error', () => resolve({ ok: true, status: 'offline' }))
  })
}

// The plugins are hundreds of MB, so they stream through the hash instead of freezing the launcher.
async function verifyGameFiles(dir) {
  if (!combat) return
  for (const name of info.loadOrder) {
    if (path.basename(name) !== name) throw new Error('Invalid plugin name')
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      fs.createReadStream(path.join(dir, 'Data', name), { highWaterMark: 1 << 20 }).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')))
    })
    if (digest !== manifest.hashes[name]) throw new Error(`The game copy of ${name} does not match the server. Close Skyrim and press Verify in the launcher, then try again.`)
  }
}
// The local Dovakarn backend (Discord login, accounts); the server window starts it on this PC only
const apiUrl = 'http://127.0.0.1:4000'
module.exports = { root: ROOT, repo: REPO, enabled, combat, gamePath, fileList, server, info, clientSettings, status, verifyGameFiles, refreshManifest, profileId, loginMode, apiUrl }
