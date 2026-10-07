const test = require('node:test')
const assert = require('node:assert/strict')
const { validateSteps, applySteps } = require('../src/fileSteps')

test('only bounded, length-preserving ASCII adaptations are accepted', () => {
  assert.equal(validateSteps([{ op: 'clearFlags', mask: 0x200 }, { op: 'replace', find: 'A.esl', replace: 'A.esp' }]), true)
  for (const bad of [[], null, [{ op: 'delete' }], [{ op: 'clearFlags', mask: 0 }], [{ op: 'clearFlags', mask: 2 ** 33 }],
    [{ op: 'replace', find: 'a', replace: 'ab' }], [{ op: 'replace', find: '', replace: '' }], [{ op: 'replace', find: 'é.esl', replace: 'é.esp' }],
    Array(9).fill({ op: 'clearFlags', mask: 1 })]) {
    assert.equal(validateSteps(bad), false, JSON.stringify(bad))
  }
})

test('renames reach both ASCII and UTF-16 references and flags change only in plugin headers', () => {
  const bytes = Buffer.concat([Buffer.from('x TrueHUD.esl y '), Buffer.from('TrueHUD.esl', 'utf16le')])
  const out = applySteps(bytes, [{ op: 'replace', find: 'TrueHUD.esl', replace: 'TrueHUD.esp' }])
  assert.equal(out.length, bytes.length)
  assert.equal(out.indexOf(Buffer.from('TrueHUD.esl')), -1)
  assert.equal(out.indexOf(Buffer.from('TrueHUD.esl', 'utf16le')), -1)
  assert.equal(bytes.indexOf(Buffer.from('TrueHUD.esl')), 2, 'The input is never modified')
  const header = Buffer.alloc(24); header.write('TES4'); header.writeUInt32LE(0x80000201, 8)
  assert.equal(applySteps(header, [{ op: 'clearFlags', mask: 0x201 }]).readUInt32LE(8), 0x80000000)
  assert.equal(applySteps(Buffer.from('not a plugin at all'), [{ op: 'clearFlags', mask: 0x200 }]), null)
})
