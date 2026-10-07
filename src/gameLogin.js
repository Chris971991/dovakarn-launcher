'use strict'
// The game's saved login (Data/Platform/PluginsNoLoad/auth-data-no-load.js, "//" + JSON) holds one launch's play
// session. It is cleared when a launch stops early, on logout, and once Skyrim has run and closed (or never started
// within a minute), so a session never lies around for the game to be started without the launcher's checks. Every
// file a session was written to this run is cleared, so changing the Skyrim folder meanwhile leaves none behind.
const path = require('path')

// restrict(file): limits a file to the current Windows user (main.js); another user of the PC could otherwise read the
// session from a game folder every user can read (a Steam library often is), and they share the player's IP address
function createGameLogin({ fs, gameDir, gameRunning, restrict = () => {}, log = () => {}, timers = { setInterval, clearInterval }, now = Date.now, tick = 5000, grace = 60 * 1000 }) {
  const written = new Set()
  const fileIn = dir => path.resolve(dir, 'Data', 'Platform', 'PluginsNoLoad', 'auth-data-no-load.js')

  // data: the SkyMP client's login object, or null for none. A session goes only into a file already limited to this
  // user: made afresh, empty, and limited first, so it is never readable by others, even for a moment. A file left
  // there before is removed rather than reused: permissions someone gave it by name would survive the limiting.
  function write(file, data) {
    const full = path.resolve(file)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    if (data) {
      written.add(full)
      // Made by this launcher alone: a file someone else puts there between the removal and the new one is refused
      // (wx), never reused, since its maker could still change who reads it
      try { fs.rmSync(full, { force: true }); fs.writeFileSync(full, '//null', { flag: 'wx' }) }
      catch (err) {
        log(`[launch] the game's login file ${full} could not be replaced: ${err.code || err.message}`)
        throw Object.assign(new Error(`The game's login file could not be replaced: ${full}. Delete it, then press Play again.`), { code: err.code })
      }
      restrict(full)
    }
    fs.writeFileSync(full, '//' + JSON.stringify(data))
  }

  function clear() {
    const files = new Set(written)
    const dir = gameDir()
    if (dir) files.add(fileIn(dir))
    for (const file of files) {
      try {
        if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== '//null') fs.writeFileSync(file, '//null')
        written.delete(file)
      } catch (err) { log(`[launch] could not clear the game login in ${file}: ${err.message}`) }
    }
  }

  // After a launch. A newer launch stops this watch before writing its own session, and a check still running then
  // changes nothing. Once Skyrim has been seen, it counts as closed only after two checks in a row say so: one
  // failed or slow process check must not end a running game's login.
  let watch = null
  function stopWatch() { timers.clearInterval(watch); watch = null }
  function clearWhenGameCloses() {
    stopWatch()
    const started = now()
    let seen = false, misses = 0
    const mine = timers.setInterval(async () => {
      let running
      try { running = await gameRunning() } catch { return }
      if (watch !== mine) return
      if (running) { seen = true; misses = 0; return }
      misses++
      if (seen ? misses < 2 : now() - started < grace) return
      stopWatch()
      clear()
      log('[launch] Skyrim closed: its Dovakarn session was cleared')
    }, tick)
    mine?.unref?.()
    watch = mine
  }

  return { fileIn, write, clear, stopWatch, clearWhenGameCloses }
}

// Limits the game's login file to the current Windows user: no inherited permissions, full control for them (chmod 600
// elsewhere). A failure is logged, not thrown: the session is bound to the player's network and ends within minutes
// unused, so Play goes on.
function restrictToUser(file, { platform = process.platform, env = process.env, username = () => require('os').userInfo().username, execFileSync = require('child_process').execFileSync, chmodSync = require('fs').chmodSync, log = () => {} } = {}) {
  if (platform !== 'win32') { try { chmodSync(file, 0o600) } catch { /* not ours to change */ } return }
  const user = env.USERDOMAIN && env.USERNAME ? [env.USERDOMAIN, env.USERNAME].join(String.fromCharCode(92)) : username()
  try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true, stdio: 'ignore', timeout: 10000 }) }
  catch (err) { log(`[launch] could not limit the game login file to this Windows user: ${err.message}`) }
}

module.exports = { createGameLogin, restrictToUser }
