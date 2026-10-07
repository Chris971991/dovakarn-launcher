// Keeps every shortcut invocation useful while one Electron process is alive.
// LocalPlay still owns the server/game checks and its launch serialization.
function createLauncherLifecycle({ getWindow, createWindow, whenLoaded, play, onError }) {
  let pendingPlay = null
  function open({ playRequested = false } = {}) {
    let window
    try {
      window = getWindow()
      // A new window shows itself once it is painted with its fonts (main.js), so it never opens half drawn.
      if (!window || window.isDestroyed()) window = createWindow()
      else {
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
    } catch (error) {
      onError(error)
      return Promise.resolve({ success: false, error: error.message })
    }
    // Coalesce repeated explicit -Play requests while loading/preparing. A later
    // request after Skyrim exits may launch again using the same visible window.
    if (playRequested && pendingPlay) return pendingPlay
    const operation = Promise.resolve().then(() => whenLoaded(window)).then(() => {
      if (playRequested) return play()
    }).catch(error => {
      onError(error)
      return { success: false, error: error.message }
    })
    if (!playRequested) return operation
    pendingPlay = operation.finally(() => { pendingPlay = null })
    return pendingPlay
  }
  return { open }
}

module.exports = { createLauncherLifecycle }
