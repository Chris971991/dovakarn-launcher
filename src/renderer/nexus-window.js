'use strict'
// The Nexus window's strip: which mod, what to press on the Nexus page below, and the player's buttons. State comes from
// main (nexusDownloads.js, nexus:strip) through nexus-preload.js; every text goes in as text nodes, never as markup
const $ = s => document.querySelector(s)
// Our words as text. A percent sign after a number gets its own span: Sovngarde sets it a space away from the number
function setWords(el, value) {
  const parts = String(value).split(/(?<=\d)%/)
  if (parts.length === 1) { el.textContent = value; return }
  const nodes = []
  parts.forEach((part, i) => {
    if (i) { const sign = document.createElement('span'); sign.className = 'pct-sign'; sign.textContent = '%'; nodes.push(sign) }
    if (part) nodes.push(document.createTextNode(part))
  })
  el.replaceChildren(...nodes)
}
// Set only when it changes: the status line is read aloud
const text = (sel, value) => { const el = $(sel); if (el.textContent !== value) setWords(el, value); return el }
// The attribute, not .hidden: the tone icons are SVG, which has no hidden property (setting it would hide nothing)
const show = (sel, on) => { $(sel).toggleAttribute('hidden', !on) }
const obj = v => v && typeof v === 'object' ? v : null
const size = n => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
const hasSize = m => !!m && Number.isFinite(m.size) && m.size >= 0
// A version as players read it: "v0.13.0.4" is 0.13.0.4
const versionOf = m => m && typeof m.version === 'string' ? m.version.trim().replace(/^v(?=\d)/i, '') : ''
// Whether the name already carries its version ("... v13" for 13, "... 7_6" for 7.6), so it is never said twice. The
// launcher page's mods window has the same rule (local-play.js)
function carriesVersion(m) {
  const v = versionOf(m)
  if (!v || typeof m.name !== 'string') return !v
  const dots = s => s.replace(/[_-]/g, '.').toLowerCase()
  const exact = dots(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(?<![0-9a-z.])v?' + exact + '(?![0-9]|\\.[0-9])').test(dots(m.name))
}
const label = m => m && typeof m.name === 'string' && m.name ? (carriesVersion(m) ? m.name : `${m.name} ${versionOf(m)}`) : 'this mod'
const known = p => typeof p === 'number' && Number.isFinite(p)
const percent = p => Math.max(0, Math.min(100, Math.floor(p)))
const STEPS = new Set(['opening', 'challenge', 'stuck', 'ready', 'nobox', 'nmm', 'offline', 'down', 'crashed', 'signin', 'register', 'premium',
  'settings', 'otherFile', 'away', 'downloading', 'checking', 'moving', 'problem', 'allDone', 'allIn'])
const CLOSE = 'Close the Nexus window', CLOSE_DOWNLOADING = 'Close the Nexus window. The download in progress stops.'
// Problems a download can have, which name their mod when it is not the one on screen
const DOWNLOAD_PROBLEMS = new Set(['different', 'damaged', 'interrupted', 'save', 'move'])

// The instruction line: { tone: 'busy' | 'info' | 'alert' | 'ok', text, note }, or null for a problem this page does not
// know. note: a short line standing in for the instruction for a moment (a mod just downloaded, one download at a time),
// which keeps the row's height
function instruction(s) {
  const mod = obj(s.mod), problem = obj(s.problem), progress = obj(s.progress), justIn = obj(s.justIn)
  const press = s.premium === true ? 'Start download' : 'Slow download', name = label(mod)
  const busy = t => ({ tone: 'busy', text: t }), alert = t => ({ tone: 'alert', text: t }), ok = t => ({ tone: 'ok', text: t })
  const note = (tone, t) => ({ tone, text: t, note: true })
  // A mod that just came in is said in place of any other info line while main keeps it set, then the line comes back
  const info = t => justIn ? note('ok', `${label(justIn)} is downloaded.`) : { tone: 'info', text: t }
  const oneAtATime = problem?.kind === 'oneAtATime'
  switch (s.step) {
    case 'opening': return busy(`Opening ${name} on Nexus Mods.`)
    case 'challenge': return info('Nexus is checking this window first. If it shows a box to tick, tick it.')
    case 'stuck': return alert(`Nexus keeps checking this window and does not let it through. Press Open in my browser to get ${name} there, or press Try again in a minute.`)
    // The download box is there, below the file's details on the Nexus page: worded by what the page said about the login
    case 'ready': return info(s.login === 'out' ? 'Press Log in to Nexus first. A free account works. No account yet? Press Register in the Nexus box below.'
      : s.login === 'in' ? (s.premium === true ? 'Scroll down to Start download and press it. The file comes straight to the launcher.'
        : 'Scroll down to Slow download and press it. Free accounts wait a few seconds, then the file comes straight to the launcher.')
        : 'Scroll down to Slow download and press it. If Nexus asks you to log in, press Log in to Nexus. A free account works.')
    // Another download pressed meanwhile: said in place of the progress line, about as long, so the strip keeps its height
    case 'downloading': {
      const of = label(obj(progress?.mod) || mod)
      const received = progress && known(progress.received) && progress.received > 0 ? progress.received : 0
      const sofar = progress && known(progress.percent) ? `${percent(progress.percent)}%` : `${(received / 1024 ** 2).toFixed(1)} MB so far`
      return oneAtATime ? note('busy', `One download at a time: ${of} is at ${sofar}.`) : busy(`Downloading ${of}: ${sofar}`)
    }
    case 'checking': {
      const of = label(obj(progress?.mod) || mod)
      return oneAtATime ? note('busy', `One download at a time: wait until ${of} is checked.`) : busy(`Checking that ${of} came through whole.`)
    }
    case 'moving': return note('ok', `${label(justIn || mod)} is downloaded. Opening the next mod.`)
    case 'problem': {
      const of = obj(problem?.mod) || mod, needs = label(of)
      // A mod that is not the one on screen: the window comes back to it once the others are done, and the line ends on
      // what to press for the mod that is on screen
      if (problem?.other === true && DOWNLOAD_PROBLEMS.has(problem.kind)) return alert(`${needs} did not download. The launcher comes back to it after the others. Press ${press} below for ${name}.`)
      switch (problem?.kind) {
        case 'different': return alert(`That was a different file. Dovakarn needs ${needs}${hasSize(of) ? `, ${size(of.size)}` : ''}. Press ${press} in the box below, not Manual at the top of the Nexus page.`)
        case 'damaged': return alert(`${needs} did not come through whole. Press ${press} below to get it again.`)
        case 'interrupted': return alert(`${needs} stopped downloading before it finished. Press ${press} below to try again.`)
        case 'save': return alert(`The launcher could not save the file in Dovakarn's Downloads folder. Check that the drive has free space, then press ${press} again.`)
        case 'move': return alert(`${needs} came through, but the launcher could not move it into Dovakarn's Downloads folder. Another program may be using it: press ${press} again in a moment.`)
        case 'modManager': return alert(`That button is for mod managers like Vortex. Press ${press} in the box below instead.`)
        case 'elsewhere': return alert(`That link leads outside Nexus Mods, so the launcher stopped it. Press ${press} below.`)
        case 'linkFailed': return alert(`Nexus's download link did not work. Press ${press} below to try again.`)
        case 'inBrowser': return info(`${name} is open in your own browser. Download it there. When you close this window, the launcher looks for it in your browser's Downloads folder.`)
        case 'error': return alert('Something went wrong in the Nexus window. Press Try again. If it keeps happening, tell the Dovakarn staff.')
        default: return null
      }
    }
    // An adult mod: Nexus hides its download box until the player is logged in with adult content switched on
    case 'nobox': return alert(s.adult === true ? (s.login === 'out' ? 'Nexus did not show the download box. Press Log in to Nexus first.'
      : 'Nexus did not show the download box. Press Open my Nexus settings below and switch on adult content.')
      : `Nexus did not show the download box. Press Try again, or Open in my browser to get ${name} there.`)
    case 'nmm': return alert(`Nexus only offers this file to mod managers on this page. Press Try again, or press Open in my browser to get ${name} there.`)
    case 'offline': return alert('Nexus Mods could not be reached. Check your internet connection, then press Try again. If your internet works, Nexus may be down for a while.')
    case 'down': return alert('Nexus Mods is not working right now. Press Try again in a few minutes.')
    case 'crashed': return alert('The Nexus page stopped working. Press Try again.')
    case 'signin': return info(`Log in on the Nexus page below. Nexus brings you back to ${name} afterwards. This window has its own Nexus login, apart from your browser's.`)
    case 'register': return info('Make your free Nexus account on the page below. If Nexus emails you a link, open it, then come back here and press Log in to Nexus.')
    case 'premium': return info('That page is for buying Nexus Premium. You do not need it: press Back to the mod, then Slow download.')
    case 'settings': return info(s.login === 'in' ? 'Switch on adult content on this Nexus page, then press Back to the mod.'
      : 'Switch on adult content on this Nexus page, then press Back to the mod. If Nexus says your session has expired, press Log in to Nexus first, then Open my Nexus settings again.')
    case 'otherFile': return info(`This page is not the ${name} download. Press Back to the mod.`)
    // Worded by where the page is from: a page outside Nexus is never called a Nexus page
    case 'away': return info(s.site === 'nexus' ? `This is another Nexus page. Press Back to the mod to return to ${name}.`
      : s.site === 'files' ? `Nexus's download link opened as a page. Press Back to the mod to return to ${name}.`
      : `This page is not on Nexus Mods. Press Back to the mod to return to ${name}.`)
    // The window got the last one: the launcher installs them once it has closed (never said as already installing)
    case 'allDone': return ok('Every mod is downloaded. The launcher installs them next.')
    // A check found the rest: that check installs them
    case 'allIn': return ok('Every mod is downloaded. This window closes now.')
    default: return null
  }
}

// The instruction row's height under its last full instruction: a note standing in for it keeps at least that height
let steadyHeight = 0
// Steps where our Log in to Nexus cannot work yet or is not wanted: Nexus's own login page, a page still opening, a
// Cloudflare check, and a Nexus that cannot be reached or has stopped
const NO_LOGIN = ['signin', 'opening', 'challenge', 'stuck', 'offline', 'down', 'crashed']

function render(raw) {
  const s = obj(raw)
  if (!s || !STEPS.has(s.step)) return                       // the last good state stays
  const say = instruction(s)
  if (!say) return
  const step = s.step, done = step === 'allDone' || step === 'allIn', login = s.login
  // The room main leaves the strip above the Nexus page; more than that scrolls inside the strip
  if (typeof s.room === 'number' && Number.isFinite(s.room) && s.room >= 96) $('#strip').style.maxHeight = `${Math.floor(s.room)}px`
  // Who is logged in to Nexus in this window; hidden until a Nexus page has said
  const chip = $('#chip'), user = typeof s.user === 'string' ? s.user : ''
  chip.hidden = login !== 'in' && login !== 'out'
  if (!chip.hidden) {
    chip.className = login === 'out' ? 'chip chip--out' : 'chip'
    text('#chip-text', login === 'out' ? 'Not logged in to Nexus' : user ? `Logged in to Nexus as ${user}` : 'Logged in to Nexus')
  }
  // The mod the Nexus page is on; its version only when the name does not carry it already
  const mod = obj(s.mod), count = obj(s.count), left = Number.isInteger(count?.left) ? count.left : 0
  show('#mod', !done && !!mod)
  if (mod) {
    text('#mod-count', count && Number.isInteger(count.position) && Number.isInteger(count.total) && count.position > 0
      ? `Mod ${count.position} of ${count.total}${Number.isInteger(count.left) ? ` · ${count.left} still to download` : ''}` : '')
    text('#mod-name', typeof mod.name === 'string' ? mod.name : '')
    const version = carriesVersion(mod) ? '' : `Version ${versionOf(mod)}`
    text('#mod-meta', [version, hasSize(mod) ? size(mod.size) : ''].filter(Boolean).join(' · '))
  }
  // Log in shows whenever Nexus has not said this window is logged in and a press can work: never on the login page itself,
  // and never while a page opens, so a logged-in player never sees it flash before the first page is read
  show('#nx-login', !done && login !== 'in' && !NO_LOGIN.includes(step))
  show('#nx-logout', login === 'in' && !done && s.busy !== true)
  show('#nx-skip', left > 1 && !done)
  show('#nx-browser', !done)
  show('#nx-retry', ['nobox', 'nmm', 'offline', 'down', 'crashed', 'stuck'].includes(step) || (step === 'problem' && obj(s.problem)?.kind === 'error'))
  // Off the step page, Back to the mod is the way back, a problem showing or not
  show('#nx-back', !done && s.offStep === true && !['offline', 'crashed', 'stuck'].includes(step))
  // An adult mod's note, in the instruction row; not on the settings page, whose own line already says it
  show('#adult', s.adult === true && !done && step !== 'settings')
  text('#adult-text', login === 'out' ? 'Nexus marks this mod as adult. Once you are logged in, you may need to switch on adult content in your Nexus settings.'
    : 'Nexus marks this mod as adult. If you cannot download it, switch on adult content in your Nexus settings.')
  show('#nx-settings', login !== 'out')
  // Close says what it does to a download in flight
  const close = $('#nx-close'), closing = step === 'downloading' ? CLOSE_DOWNLOADING : CLOSE
  if (close.getAttribute('aria-label') !== closing) close.setAttribute('aria-label', closing)
  if (step === 'downloading') close.title = CLOSE_DOWNLOADING; else close.removeAttribute('title')
  // The instruction line and its icon. A note standing in for the instruction keeps the row at least as tall as the
  // instruction was, so the Nexus page under the strip never moves while the player aims at it
  for (const tone of ['busy', 'info', 'alert', 'ok']) show(`#say-${tone}`, say.tone === tone)
  $('#say').className = say.tone === 'alert' ? 'say say--alert' : 'say'
  const line = $('#say-text')
  if (!say.note) line.style.removeProperty('min-height')
  else if (!line.style.minHeight && steadyHeight > 0) line.style.minHeight = `${steadyHeight}px`
  text('#say-text', say.text)
  if (!say.note) steadyHeight = Math.ceil(line.getBoundingClientRect().height)
  // The download's progress: a known size fills the bar, an unknown one sweeps
  const meter = $('#meter'), fill = meter.querySelector('i'), progress = obj(s.progress)
  meter.hidden = step !== 'downloading'
  if (step === 'downloading') {
    if (progress && known(progress.percent)) {
      const p = percent(progress.percent)
      meter.classList.remove('indeterminate')
      fill.style.setProperty('--p', String(p / 100))
      meter.setAttribute('aria-valuenow', String(p))
    } else {
      meter.classList.add('indeterminate')
      fill.style.removeProperty('--p')
      meter.removeAttribute('aria-valuenow')
    }
    meter.setAttribute('aria-valuetext', say.text)
  }
}

// The player's buttons: main checks the sender and the name (nexusDownloads.js action)
const ACT = { 'nx-login': 'login', 'nx-logout': 'logout', 'nx-skip': 'skip', 'nx-browser': 'browser', 'nx-retry': 'retry',
  'nx-back': 'back', 'nx-settings': 'settings', 'nx-minimize': 'minimize', 'nx-close': 'close' }
for (const [id, action] of Object.entries(ACT)) {
  $(`#${id}`).addEventListener('click', () => { try { Promise.resolve(window.nexusStrip.act(action)).catch(() => {}) } catch { /* main is gone */ } })
}
// The strip's real height, so main puts the Nexus page right under it
let told = 0
const tellHeight = () => { const h = Math.ceil($('#strip').getBoundingClientRect().height); if (h > 0 && h !== told) { told = h; window.nexusStrip.height(h) } }
if (typeof ResizeObserver === 'function') new ResizeObserver(tellHeight).observe($('#strip'))
window.nexusStrip.onState(value => { render(value); tellHeight() })
// Ready once Sovngarde is in and two frames are painted: main shows the window then, never an unstyled strip
const frame = window.requestAnimationFrame ? fn => window.requestAnimationFrame(fn) : fn => setTimeout(fn, 16)
;(document.fonts?.ready || Promise.resolve()).then(() => frame(() => frame(() => { tellHeight(); window.nexusStrip.ready() })))
