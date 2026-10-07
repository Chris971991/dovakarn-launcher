const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { launchDetached } = require('../src/launchProcess')

test('game launch waits for OS spawn confirmation before reporting success', async () => {
  const child = new EventEmitter()
  let detached = false, complete = false
  child.unref = () => { detached = true }
  const launched = launchDetached('skse64_loader.exe', [], 'G:\\game', (exe, args, options) => {
    assert.equal(exe, 'skse64_loader.exe')
    assert.deepEqual(args, [])
    assert.deepEqual(options, { detached: true, stdio: 'ignore', cwd: 'G:\\game' })
    return child
  }).then(() => { complete = true })
  await Promise.resolve()
  assert.equal(complete, false)
  assert.equal(detached, false)
  child.emit('spawn')
  await launched
  assert.equal(complete, true)
  assert.equal(detached, true)
})

test('asynchronous Windows execution failure rejects normally instead of an unhandled error', async () => {
  const child = new EventEmitter()
  child.unref = () => assert.fail('failed process must not be detached')
  const launched = launchDetached('skse64_loader.exe', [], 'G:\\game', () => child)
  child.emit('error', Object.assign(new Error('Access denied'), { code: 'EACCES' }))
  await assert.rejects(launched, { message: 'Access denied', code: 'EACCES' })
})

test('synchronous spawn failure also rejects to the launch error handler', async () => {
  await assert.rejects(launchDetached('skse64_loader.exe', [], 'G:\\game', () => {
    throw new Error('Invalid process arguments')
  }), /Invalid process arguments/)
})
