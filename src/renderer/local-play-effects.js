'use strict'
// Decorative animation lifecycle only. This module has no launcher/IPC access.
const sky = () => document.querySelector('video.atmosphere')
const wantsMotion = () =>
  !document.hidden && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

function updateMotionVisibility() {
  document.documentElement.setAttribute('data-motion-paused', document.hidden ? 'true' : 'false')
  // The background video stops while the window is hidden or the player asked for less motion.
  const video = sky()
  if (!video) return
  video.dataset.playing = wantsMotion() ? 'true' : 'false'
  try {
    if (wantsMotion()) Promise.resolve(video.play()).catch(() => {})
    else video.pause()
  } catch {}
}
document.addEventListener('visibilitychange', updateMotionVisibility)
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')
if (reducedMotion && reducedMotion.addEventListener) reducedMotion.addEventListener('change', updateMotionVisibility)
updateMotionVisibility()

// After the window has been covered, the PC slept or the graphics driver reset, Chromium can leave
// the video black: the element still says it is playing, but no frame ever advances and no event
// fires. Watch the clock; a stuck video gets one gentle play(), then a full reload of the source.
let lastTime = -1
let stuckTicks = 0
let recoveries = 0
function recoverSky(video) {
  lastTime = -1
  stuckTicks = 0
  recoveries++
  try {
    video.load()
    Promise.resolve(video.play()).catch(() => {})
  } catch {}
}
setInterval(() => {
  const video = sky()
  if (!video || !wantsMotion()) { lastTime = -1; stuckTicks = 0; return }
  const now = video.currentTime
  if (now !== lastTime) {
    stuckTicks = 0
    recoveries = 0
    lastTime = now
    return
  }
  // Three reloads without a single frame means the file itself is the problem; stop thrashing.
  if (recoveries >= 3) return
  stuckTicks++
  if (video.error || stuckTicks >= 2) recoverSky(video)
  else { try { Promise.resolve(video.play()).catch(() => {}) } catch {} }
}, 4000)
