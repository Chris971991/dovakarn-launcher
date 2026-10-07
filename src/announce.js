'use strict'
// The Dovakarn announce channel: a WebSocket the server speaks on the moment a launcher release or
// the published game files change. It is a doorbell, never a delivery: hearing it only makes the
// launcher run its ordinary checks, which verify everything by hash against the server's answers.
// The socket reconnects on its own, backing off to a minute between tries while the server is away.

// WebSocketImpl is injectable for tests; Electron's main process carries Node's own WebSocket.
function startAnnounce({ url, onVersions, log = () => {}, WebSocketImpl = globalThis.WebSocket }) {
  if (typeof WebSocketImpl !== 'function') { log('[announce] no WebSocket in this runtime; polling carries it'); return { stop: () => {} } }
  let socket = null, closed = false, timer = null, delay = 5000
  const retry = () => {
    if (closed || timer) return
    timer = setTimeout(() => { timer = null; connect() }, delay + Math.floor(Math.random() * 2000))
    delay = Math.min(Math.floor(delay * 1.7), 60000)
  }
  const connect = () => {
    if (closed) return
    try { socket = new WebSocketImpl(url) } catch { return retry() }
    socket.onopen = () => { delay = 5000; log('[announce] listening for server announcements') }
    socket.onmessage = (event) => {
      let data
      try { data = JSON.parse(String(event.data)) } catch { return }
      if (!data || data.type !== 'versions') return
      onVersions({
        launcherVersion: typeof data.launcherVersion === 'string' ? data.launcherVersion : null,
        filesRevision: typeof data.filesRevision === 'string' ? data.filesRevision : null,
      })
    }
    socket.onclose = () => retry()
    socket.onerror = () => { try { socket.close() } catch { /* Already closing. */ } }
  }
  connect()
  return { stop: () => { closed = true; if (timer) clearTimeout(timer); try { if (socket) socket.close() } catch { /* Gone. */ } } }
}

module.exports = { startAnnounce }
