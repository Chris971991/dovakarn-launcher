// The local server's slow file work runs on a worker thread. Electron's main thread also answers the
// window's clicks and loads its font and video, so seconds of hashing there freeze the whole launcher.
const path = require('path')
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads')

// Local test mode only (dev). root: the local server's folder; repo: the server checkout ('skyrp' is that checkout's
// folder name); adminConfig: the server tools' config (or a test copy). log: the launcher's log, which
// keeps the worker's exit code (the player is only told it stopped)
function createHostJobs({ root, repo = path.join(root, 'skyrp'), adminConfig, log = () => {} }) {
  let worker = null, nextId = 1, queue = Promise.resolve()
  const pending = new Map()
  function start() {
    const current = worker = new Worker(__filename, { workerData: { hostJobs: { root, repo, adminConfig } } })
    const fail = error => {
      if (worker === current) worker = null
      for (const job of pending.values()) job.reject(error)
      pending.clear()
    }
    current.on('message', ({ id, progress, result, error }) => {
      const job = pending.get(id)
      if (!job) return
      if (progress !== undefined) { try { job.onProgress(progress) } catch { /* progress is display only */ } return }
      pending.delete(id)
      // An idle worker never keeps the app from quitting.
      if (!pending.size) current.unref()
      if (error !== undefined) job.reject(new Error(error)); else job.resolve(result)
    })
    current.on('error', fail)
    current.on('exit', code => { log(`[local] the background worker stopped with exit code ${code}`); fail(new Error("The launcher's background worker stopped. Try again.")) })
    return current
  }
  // One job at a time: both jobs write the server's file list and settings.
  function run(job, onProgress = () => {}) {
    const task = queue.then(() => new Promise((resolve, reject) => {
      const id = nextId++, current = worker || start()
      pending.set(id, { resolve, reject, onProgress })
      current.ref()
      current.postMessage({ id, job })
    }))
    queue = task.catch(() => {})
    return task
  }
  return { run, stop: () => worker ? worker.terminate() : Promise.resolve() }
}

if (!isMainThread && workerData && workerData.hostJobs) {
  // 'skyrp': the local server checkout's folder name, as above (dev only)
  const { root, repo = path.join(root, 'skyrp'), adminConfig } = workerData.hostJobs
  const lib = name => require(path.join(repo, 'server-admin/lib', name))
  const jobs = {
    // The player file list, rebuilt from the server's installed game copy.
    publish: () => {
      const { writeClientManifest } = lib('client-manifest.cjs'), { read } = lib('store.cjs')
      writeClientManifest({ repo: adminConfig.repo, root: adminConfig.root, serverDir: adminConfig.serverDir, manifest: read(adminConfig.manifest) })
    },
    // The server set up from this PC's Vortex collection install; null without one.
    prepareHost: onProgress => lib('host-stage.cjs').stageHost({ repo: adminConfig.repo, root: adminConfig.root, onProgress }),
  }
  parentPort.on('message', async ({ id, job }) => {
    try {
      if (!Object.hasOwn(jobs, job)) throw new Error(`Unknown background job ${job}`)
      parentPort.postMessage({ id, result: await jobs[job](progress => parentPort.postMessage({ id, progress })) })
    } catch (error) { parentPort.postMessage({ id, error: error && error.message ? error.message : String(error) }) }
  })
}

module.exports = { createHostJobs }
