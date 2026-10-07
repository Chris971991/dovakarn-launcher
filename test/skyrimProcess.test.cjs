const test = require('node:test')
const assert = require('node:assert/strict')
const { liveSkyrim, parseTasklist } = require('../src/skyrimProcess')

const row = (status, title) => `"SkyrimSE.exe","16404","Console","1","1,249,220 K","${status}","DESKTOP\\Player","0:07:30","${title}"`

test('a closed Skyrim left windowless and unresponsive is not an open game', () => {
  // A windowless, unresponsive SkyrimSE.exe as tasklist reports it.
  assert.equal(liveSkyrim(row('Not Responding', 'N/A')), false)
  assert.equal(liveSkyrim('INFO: No tasks are running which match the specified criteria.\r\n'), false)
  assert.equal(liveSkyrim(''), false)
})

test('starting, running and hung-with-a-window games all count as open', () => {
  assert.equal(liveSkyrim(row('Running', 'N/A')), true, 'Starting up before its window appears')
  assert.equal(liveSkyrim(row('Unknown', 'N/A')), true)
  assert.equal(liveSkyrim(row('Running', 'Skyrim Special Edition')), true)
  assert.equal(liveSkyrim(row('Not Responding', 'Skyrim Special Edition')), true, 'A hung game with a window is still open')
  assert.equal(liveSkyrim(`${row('Not Responding', 'N/A')}\r\n${row('Running', 'Skyrim Special Edition')}`), true, 'A real game beside a stuck one')
})

test('memory figures with commas do not shift the columns', () => {
  assert.deepEqual(parseTasklist(row('Not Responding', 'N/A')), [{ image: 'SkyrimSE.exe', status: 'Not Responding', title: 'N/A' }])
})
