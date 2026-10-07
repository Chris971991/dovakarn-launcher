// Byte-level adaptations the launcher reproduces on a player's own copy of a mod file,
// so the server never has to hand out the mod itself.
const OPS = new Set(['clearFlags', 'replace'])

// Renames must keep the same length so no data shifts; plain printable ASCII only.
function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 8) return false
  return steps.every(step => step && OPS.has(step.op) && (step.op === 'clearFlags'
    ? Number.isInteger(step.mask) && step.mask > 0 && step.mask <= 0xffffffff
    : typeof step.find === 'string' && typeof step.replace === 'string' && step.find.length > 0 &&
      step.find.length === step.replace.length && step.find.length <= 260 && /^[\x20-\x7e]+$/.test(step.find + step.replace)))
}

// Returns the adapted bytes, or null when a plugin step meets a file that is not a plugin.
function applySteps(bytes, steps) {
  const out = Buffer.from(bytes)
  for (const step of steps) {
    if (step.op === 'clearFlags') {
      if (out.length < 12 || out.toString('ascii', 0, 4) !== 'TES4') return null
      out.writeUInt32LE((out.readUInt32LE(8) & ~step.mask) >>> 0, 8)
      continue
    }
    for (const encoding of ['ascii', 'utf16le']) {
      const find = Buffer.from(step.find, encoding), replace = Buffer.from(step.replace, encoding)
      for (let i = out.indexOf(find); i !== -1; i = out.indexOf(find, i + find.length)) replace.copy(out, i)
    }
  }
  return out
}

module.exports = { validateSteps, applySteps }
