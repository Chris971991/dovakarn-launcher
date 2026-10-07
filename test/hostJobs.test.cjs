const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { execFileSync } = require('node:child_process')
const { createHostJobs } = require('../src/hostJobs')

// Stand-ins for the local test server's tools (the server's own folder layout) that log, report progress, hold their
// thread busy, fail or crash on request. Nothing outside the temp folder is needed.
function fakeInstall(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dov-host-jobs-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const lib = path.join(root, 'skyrp/server-admin/lib'), log = path.join(root, 'log.txt')
  fs.mkdirSync(lib, { recursive: true })
  const busy = 'const busy=ms=>{const end=Date.now()+ms;while(Date.now()<end){}};'
  fs.writeFileSync(path.join(lib, 'store.cjs'), "module.exports={read:file=>JSON.parse(require('fs').readFileSync(file,'utf8'))}")
  fs.writeFileSync(path.join(lib, 'client-manifest.cjs'), `${busy}const fs=require('fs'),path=require('path');
module.exports={writeClientManifest({root,manifest}){const log=path.join(root,'log.txt');fs.appendFileSync(log,'publish start\\n');busy(manifest.publishMs||0);if(manifest.fail)throw new Error(manifest.fail);fs.appendFileSync(log,'publish end\\n');return {files:[]}}}`)
  fs.writeFileSync(path.join(lib, 'host-stage.cjs'), `${busy}const fs=require('fs'),path=require('path');
module.exports={async stageHost({root,onProgress}){const plan=JSON.parse(fs.readFileSync(path.join(root,'stage.json'),'utf8')),log=path.join(root,'log.txt');
fs.appendFileSync(log,'stage start\\n');for(const p of plan.progress||[])onProgress(p);if(plan.wait)await new Promise(r=>setTimeout(r,plan.wait));busy(plan.ms||0);if(plan.exit)process.exit(plan.exit);if(plan.fail)throw new Error(plan.fail);fs.appendFileSync(log,'stage end\\n');return plan.result===undefined?null:plan.result}}`)
  const adminConfig = { repo: path.join(root, 'skyrp'), root, serverDir: path.join(root, 'server'), manifest: path.join(root, 'manifest.json') }
  const plan = (stage, manifest = {}) => { fs.writeFileSync(path.join(root, 'stage.json'), JSON.stringify(stage)); fs.writeFileSync(adminConfig.manifest, JSON.stringify(manifest)) }
  plan({})
  const said = []
  const jobs = createHostJobs({ root, adminConfig, log: line => said.push(line) })
  t.after(() => jobs.stop())
  return { root, adminConfig, jobs, plan, said, log: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] }
}

const limit = { timeout: 20000 }

test('slow server work runs on its own thread, so the launcher window keeps responding', limit, async t => {
  const h = fakeInstall(t)
  h.plan({ ms: 600, result: { changed: false } })
  let last = performance.now(), worst = 0
  const beat = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now }, 5)
  const started = performance.now()
  const report = await h.jobs.run('prepareHost')
  // A job that blocked this thread could end before the timer ticks again, so the last gap counts too.
  worst = Math.max(worst, performance.now() - last)
  clearInterval(beat)
  assert.deepEqual(report, { changed: false })
  assert.ok(performance.now() - started >= 550, 'The job really held its thread for 600 ms')
  assert.ok(worst < 200, `The main thread never stalled (longest gap ${Math.round(worst)} ms)`)
})

test('jobs run one at a time in the order asked, and progress arrives before the result', limit, async t => {
  const h = fakeInstall(t), seen = []
  // Server setup waits on Nemesis part way through; a list rebuild must not slip in meanwhile.
  h.plan({ wait: 150, ms: 50, progress: ['Setting up the server from the Dovakarn collection...', 'Writing the server settings...'], result: { changed: true, loadOrder: ['Skyrim.esm'] } }, { publishMs: 50 })
  const [report, published] = await Promise.all([h.jobs.run('prepareHost', message => seen.push(message)), h.jobs.run('publish')])
  assert.deepEqual(h.log(), ['stage start', 'stage end', 'publish start', 'publish end'], 'Both write the server files, so they never overlap')
  assert.equal(published, undefined)
  assert.deepEqual(report, { changed: true, loadOrder: ['Skyrim.esm'] })
  assert.deepEqual(seen, ['Setting up the server from the Dovakarn collection...', 'Writing the server settings...'])
})

test('a failed job is reported to its caller and the next job still runs', limit, async t => {
  const h = fakeInstall(t)
  h.plan({ fail: 'Nemesis could not generate the animation files.' })
  await assert.rejects(h.jobs.run('prepareHost'), /^Error: Nemesis could not generate the animation files\.$/)
  h.plan({}, { fail: 'The download folder is blocked.' })
  await assert.rejects(h.jobs.run('publish'), /The download folder is blocked/)
  h.plan({ result: 'staged' })
  assert.equal(await h.jobs.run('prepareHost'), 'staged')
  await assert.rejects(h.jobs.run('deleteEverything'), /Unknown background job deleteEverything/, 'Only the two known jobs run')
})

test('a crashed worker fails its job and a fresh one takes the next', limit, async t => {
  const h = fakeInstall(t)
  h.plan({ exit: 3 })
  await assert.rejects(h.jobs.run('prepareHost'), /^Error: The launcher's background worker stopped\. Try again\.$/)
  assert.ok(h.said.includes('[local] the background worker stopped with exit code 3'), 'the exit code goes to the log, not to the player')
  h.plan({ result: 'back' })
  assert.equal(await h.jobs.run('prepareHost'), 'back')
})

test('the worker finishes each job before the launcher may quit, then never holds it open', limit, async t => {
  const h = fakeInstall(t)
  // Two jobs back to back: the second starts on a worker that went idle after the first.
  const script = `const {createHostJobs}=require(${JSON.stringify(path.resolve(__dirname, '../src/hostJobs.js'))});
const jobs=createHostJobs({root:${JSON.stringify(h.root)},adminConfig:${JSON.stringify(h.adminConfig)}});
jobs.run('publish').then(()=>new Promise(r=>setImmediate(r))).then(()=>jobs.run('publish')).then(()=>console.log('published twice'))`
  h.plan({}, { publishMs: 300 })
  // Held open forever by the worker, this would hit the timeout and throw.
  assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 15000 }).trim(), 'published twice')
})
