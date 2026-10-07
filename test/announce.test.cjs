const test = require('node:test')
const assert = require('node:assert/strict')
const { startAnnounce } = require('../src/announce')

// A stand-in WebSocket the test drives by hand.
function fakeSocketFactory(made) {
  return function FakeSocket(url) {
    made.push(this)
    this.url = url
    this.closed = false
    this.close = () => { this.closed = true; this.onclose && this.onclose() }
  }
}

test('announcements parse, junk is ignored, and only versions messages reach the listener', () => {
  const made = [], heard = []
  const channel = startAnnounce({ url: 'ws://x/ws/announce', onVersions: v => heard.push(v), WebSocketImpl: fakeSocketFactory(made) })
  assert.equal(made.length, 1)
  const socket = made[0]
  socket.onmessage({ data: 'not json' })
  socket.onmessage({ data: JSON.stringify({ type: 'other' }) })
  socket.onmessage({ data: JSON.stringify({ type: 'versions', launcherVersion: '2.3.0', filesRevision: 'abc' }) })
  socket.onmessage({ data: JSON.stringify({ type: 'versions', launcherVersion: 7, filesRevision: null }) })
  assert.deepEqual(heard, [
    { launcherVersion: '2.3.0', filesRevision: 'abc' },
    { launcherVersion: null, filesRevision: null },
  ])
  channel.stop()
  assert.equal(socket.closed, true)
})

test('a dropped socket reconnects with backoff, and stop() ends the retries', async () => {
  const made = []
  const channel = startAnnounce({ url: 'ws://x/ws/announce', onVersions: () => {}, WebSocketImpl: fakeSocketFactory(made) })
  made[0].onclose()
  assert.equal(made.length, 1, 'the retry waits; it does not hammer')
  await new Promise(resolve => setTimeout(resolve, 10))
  channel.stop()
  const count = made.length
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(made.length, count, 'stopped: no further connections')
})

test('a runtime without WebSocket degrades to polling quietly', () => {
  const channel = startAnnounce({ url: 'ws://x', onVersions: () => {}, WebSocketImpl: undefined })
  channel.stop()
})
