const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const renderer = path.join(__dirname, '../src/renderer');
const html = fs.readFileSync(path.join(renderer, 'nexus-window.html'), 'utf8');
const script = fs.readFileSync(path.join(renderer, 'nexus-window.js'), 'utf8');
const css = fs.readFileSync(path.join(renderer, 'nexus-window.css'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// En-dash, em-dash and the ellipsis Sovngarde lacks, by code so this file never holds them
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014, 0x2026)}]`);

const TRUEHUD = { name: 'TrueHUD', version: '1.1.9', size: 305668 };
const XPMSSE = { name: 'XP32 Maximum Skeleton Special Extended', version: '5.06', size: 2365019 };
const SKYUI = { name: 'SkyUI', version: '', size: 2.3e6 };
// A StripState as main pushes it (nexusDownloads.js stripState): TrueHUD is the third of 43, logged out, its box on screen
const strip = (extra = {}) => ({ count: { position: 3, total: 43, left: 41 }, mod: TRUEHUD, login: 'out', user: '', premium: false,
  step: 'ready', offStep: false, busy: false, problem: null, progress: null, adult: false, justIn: null, room: 320, ...extra });
const BUTTONS = ['nx-logout', 'nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser', 'nx-retry', 'nx-back', 'nx-settings'];
const ADULT_IN = 'Nexus marks this mod as adult. If you cannot download it, switch on adult content in your Nexus settings.';
const ADULT_OUT = 'Nexus marks this mod as adult. Once you are logged in, you may need to switch on adult content in your Nexus settings.';

// The strip page with a stand-in for nexus-preload.js's nexusStrip, like Electron's sandboxed page sees it
function fixture(t) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://launcher.test/nexus-window.html' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const calls = { act: [], ready: 0, height: [] };
  let state = null;
  w.nexusStrip = {
    onState(callback) { state = callback; },
    act(action) { calls.act.push(action); return Promise.resolve({ success: true }); },
    ready() { calls.ready++; },
    height(px) { calls.height.push(px); },
  };
  w.eval(script);
  const d = w.document, $ = sel => d.querySelector(sel);
  // Shown: neither the element nor anything around it has the hidden attribute (the attribute, not .hidden: the tone
  // icons are SVG, which has no hidden property, so setting .hidden on one hides nothing in Chromium)
  const shown = el => { for (let e = el; e; e = e.parentElement) if (e.hasAttribute('hidden')) return false; return true; };
  return {
    w, d, $, calls, shown,
    push: value => state(value),
    text: sel => $(sel).textContent,
    buttons: () => BUTTONS.filter(id => shown($(`#${id}`))),
    tone: () => ['busy', 'info', 'alert', 'ok'].filter(tone => shown($(`#say-${tone}`))),
  };
}

test('the strip page has its own strict CSP and every button in its pinned order, with its exact strings', t => {
  const f = fixture(t);
  assert.deepEqual([...f.d.querySelectorAll('button')].map(b => b.id), BUTTONS);
  assert.equal(f.$('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'),
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(f.d.title, 'Nexus Mods for Dovakarn');
  assert.deepEqual([f.text('.brand'), f.text('.bar-title'), f.$('#strip').getAttribute('aria-label')],
    ['DOVAKARN', 'Mods from Nexus Mods', "Downloading Dovakarn's mods from Nexus Mods"]);
  // Minimize as the launcher spells it (local-play.html)
  assert.deepEqual(BUTTONS.map(id => f.$(`#${id}`).getAttribute('aria-label') || f.text(`#${id}`)),
    ['Log out of Nexus', 'Minimize the launcher and this window', 'Close the Nexus window', 'Log in to Nexus', 'Next mod',
      'Open in my browser', 'Try again', 'Back to the mod', 'Open my Nexus settings']);
  // The adult note is a line of the instruction row, not a box of its own
  assert.equal(f.$('#adult').parentElement.id, 'say');
  assert.equal(f.d.querySelectorAll('svg').length, 7, 'Every icon is inline SVG: user, minus, x, info, two alerts, check');
  for (const svg of f.d.querySelectorAll('svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
  // Before the first state: nothing said, no chip
  assert.deepEqual([f.text('#say-text'), f.$('#chip').hidden, f.$('#meter').hidden, f.$('#adult').hidden, f.text('#adult-text')], ['', true, true, true, '']);
});

test('the mod line shows the counter with what is left, the name and its version and size', t => {
  const f = fixture(t);
  f.push(strip());
  assert.deepEqual([f.$('#mod').hidden, f.text('#mod-count'), f.text('#mod-name'), f.text('#mod-meta')],
    [false, 'Mod 3 of 43 · 41 still to download', 'TrueHUD', 'Version 1.1.9 · 299 KB']);
  f.push(strip({ mod: SKYUI, count: { position: 1, total: 2, left: 2 }, step: 'opening' }));
  assert.deepEqual([f.text('#mod-count'), f.text('#mod-name'), f.text('#mod-meta'), f.text('#say-text')],
    ['Mod 1 of 2 · 2 still to download', 'SkyUI', '2.2 MB', 'Opening SkyUI on Nexus Mods.']);
  f.push(strip({ mod: null, count: null, step: 'opening' }));
  assert.equal(f.$('#mod').hidden, true, 'No mod, no mod line');
});

test('a version is said once: no leading v, and never again after a name that already carries it', t => {
  const f = fixture(t);
  const cases = [
    // [name, version, the mod line's meta, the instruction's name]
    ['Address Library All in One (1.7.104.0) v13', '13', '6.3 MB', 'Address Library All in One (1.7.104.0) v13'],
    ['Fores New Idles in Skyrim SE - FNIS SE - FNIS Behavior SE 7_6', '7.6', '1.2 MB', 'Fores New Idles in Skyrim SE - FNIS SE - FNIS Behavior SE 7_6'],
    ['Behavior Data Injector Universal Support', 'v0.13.0.4', 'Version 0.13.0.4 · 6.3 MB', 'Behavior Data Injector Universal Support 0.13.0.4'],
    ['TrueHUD', '1.1.9', 'Version 1.1.9 · 6.3 MB', 'TrueHUD 1.1.9'],
    // A version that is only part of a longer number in the name is still said
    ['Mod 2023 Edition', '2', 'Version 2 · 6.3 MB', 'Mod 2023 Edition 2'],
    ['Something 1.1.9', '1.1', 'Version 1.1 · 6.3 MB', 'Something 1.1.9 1.1'],
    ['SkyUI', '', '6.3 MB', 'SkyUI'],
  ];
  for (const [name, version, meta, said] of cases) {
    const size = name.includes('FNIS') ? 1288700 : 6640552;
    f.push(strip({ mod: { name, version, size }, step: 'opening' }));
    assert.deepEqual([f.text('#mod-name'), f.text('#mod-meta'), f.text('#say-text')], [name, meta, `Opening ${said} on Nexus Mods.`], `${name} / ${version}`);
  }
});

test('every instruction line, with its tone', t => {
  const f = fixture(t);
  const rows = [
    [{ step: 'opening' }, 'busy', 'Opening TrueHUD 1.1.9 on Nexus Mods.'],
    [{ step: 'challenge' }, 'info', 'Nexus is checking this window first. If it shows a box to tick, tick it.'],
    [{ step: 'stuck' }, 'alert', 'Nexus keeps checking this window and does not let it through. Press Open in my browser to get TrueHUD 1.1.9 there, or press Try again in a minute.'],
    [{ step: 'ready', login: 'out' }, 'info', 'Press Log in to Nexus first. A free account works. No account yet? Press Register in the Nexus box below.'],
    [{ step: 'ready', login: 'in', user: 'Dragonborn' }, 'info', 'Scroll down to Slow download and press it. Free accounts wait a few seconds, then the file comes straight to the launcher.'],
    [{ step: 'ready', login: 'in', user: 'Dragonborn', premium: true }, 'info', 'Scroll down to Start download and press it. The file comes straight to the launcher.'],
    [{ step: 'ready', login: 'unknown' }, 'info', 'Scroll down to Slow download and press it. If Nexus asks you to log in, press Log in to Nexus. A free account works.'],
    [{ step: 'downloading', progress: { percent: 63, received: 192571, mod: TRUEHUD } }, 'busy', 'Downloading TrueHUD 1.1.9: 63%'],
    [{ step: 'downloading', progress: { percent: null, received: 1.5 * 1024 ** 2, mod: XPMSSE } }, 'busy', 'Downloading XP32 Maximum Skeleton Special Extended 5.06: 1.5 MB so far'],
    // Another download pressed meanwhile: said in place of the progress line, never as a line more
    [{ step: 'downloading', progress: { percent: 63, received: 192571, mod: TRUEHUD }, problem: { kind: 'oneAtATime', mod: TRUEHUD } }, 'busy',
      'One download at a time: TrueHUD 1.1.9 is at 63%.'],
    [{ step: 'downloading', progress: { percent: null, received: 1.5 * 1024 ** 2, mod: XPMSSE }, problem: { kind: 'oneAtATime', mod: TRUEHUD } }, 'busy',
      'One download at a time: XP32 Maximum Skeleton Special Extended 5.06 is at 1.5 MB so far.'],
    [{ step: 'checking', progress: { percent: 100, received: 305668, mod: XPMSSE } }, 'busy', 'Checking that XP32 Maximum Skeleton Special Extended 5.06 came through whole.'],
    [{ step: 'checking', progress: { percent: null, received: 305668, mod: TRUEHUD }, problem: { kind: 'oneAtATime', mod: TRUEHUD } }, 'busy',
      'One download at a time: wait until TrueHUD 1.1.9 is checked.'],
    [{ step: 'moving', justIn: TRUEHUD }, 'ok', 'TrueHUD 1.1.9 is downloaded. Opening the next mod.'],
    // A mod that just came in: said in place of the instruction for a moment, never as a line more
    [{ step: 'ready', login: 'in', user: 'Dragonborn', justIn: XPMSSE }, 'ok', 'XP32 Maximum Skeleton Special Extended 5.06 is downloaded.'],
    [{ step: 'problem', problem: { kind: 'different', mod: TRUEHUD } }, 'alert',
      'That was a different file. Dovakarn needs TrueHUD 1.1.9, 299 KB. Press Slow download in the box below, not Manual at the top of the Nexus page.'],
    [{ step: 'problem', premium: true, problem: { kind: 'different', mod: { name: 'TrueHUD', version: '1.1.9' } } }, 'alert',
      'That was a different file. Dovakarn needs TrueHUD 1.1.9. Press Start download in the box below, not Manual at the top of the Nexus page.'],
    [{ step: 'problem', problem: { kind: 'damaged', mod: TRUEHUD } }, 'alert', 'TrueHUD 1.1.9 did not come through whole. Press Slow download below to get it again.'],
    [{ step: 'problem', problem: { kind: 'interrupted', mod: TRUEHUD } }, 'alert', 'TrueHUD 1.1.9 stopped downloading before it finished. Press Slow download below to try again.'],
    [{ step: 'problem', premium: true, problem: { kind: 'save', mod: TRUEHUD } }, 'alert',
      "The launcher could not save the file in Dovakarn's Downloads folder. Check that the drive has free space, then press Start download again."],
    [{ step: 'problem', problem: { kind: 'move', mod: TRUEHUD } }, 'alert',
      "TrueHUD 1.1.9 came through, but the launcher could not move it into Dovakarn's Downloads folder. Another program may be using it: press Slow download again in a moment."],
    [{ step: 'problem', problem: { kind: 'modManager', mod: TRUEHUD } }, 'alert', 'That button is for mod managers like Vortex. Press Slow download in the box below instead.'],
    [{ step: 'problem', problem: { kind: 'elsewhere', mod: TRUEHUD } }, 'alert', 'That link leads outside Nexus Mods, so the launcher stopped it. Press Slow download below.'],
    [{ step: 'problem', premium: true, problem: { kind: 'elsewhere', mod: TRUEHUD } }, 'alert', 'That link leads outside Nexus Mods, so the launcher stopped it. Press Start download below.'],
    // A problem with a mod that is not the one on screen: named, and the window comes back to it
    ...['different', 'damaged', 'interrupted', 'save', 'move'].map(kind => [{ step: 'problem', problem: { kind, mod: XPMSSE, other: true } }, 'alert',
      'XP32 Maximum Skeleton Special Extended 5.06 did not download. The launcher comes back to it after the others. Press Slow download below for TrueHUD 1.1.9.']),
    [{ step: 'problem', premium: true, problem: { kind: 'interrupted', mod: XPMSSE, other: true } }, 'alert',
      'XP32 Maximum Skeleton Special Extended 5.06 did not download. The launcher comes back to it after the others. Press Start download below for TrueHUD 1.1.9.'],
    [{ step: 'problem', problem: { kind: 'damaged', mod: TRUEHUD, other: false } }, 'alert', 'TrueHUD 1.1.9 did not come through whole. Press Slow download below to get it again.'],
    [{ step: 'problem', problem: { kind: 'linkFailed', mod: TRUEHUD } }, 'alert', "Nexus's download link did not work. Press Slow download below to try again."],
    [{ step: 'problem', problem: { kind: 'inBrowser', mod: TRUEHUD } }, 'info',
      "TrueHUD 1.1.9 is open in your own browser. Download it there. When you close this window, the launcher looks for it in your browser's Downloads folder."],
    [{ step: 'problem', problem: { kind: 'error', mod: TRUEHUD } }, 'alert', 'Something went wrong in the Nexus window. Press Try again. If it keeps happening, tell the Dovakarn staff.'],
    [{ step: 'nobox' }, 'alert', 'Nexus did not show the download box. Press Try again, or Open in my browser to get TrueHUD 1.1.9 there.'],
    // An adult mod: the line says what to press, by the login
    [{ step: 'nobox', adult: true, login: 'in', user: 'Dragonborn' }, 'alert', 'Nexus did not show the download box. Press Open my Nexus settings below and switch on adult content.'],
    [{ step: 'nobox', adult: true, login: 'unknown' }, 'alert', 'Nexus did not show the download box. Press Open my Nexus settings below and switch on adult content.'],
    [{ step: 'nobox', adult: true, login: 'out' }, 'alert', 'Nexus did not show the download box. Press Log in to Nexus first.'],
    [{ step: 'nmm' }, 'alert', 'Nexus only offers this file to mod managers on this page. Press Try again, or press Open in my browser to get TrueHUD 1.1.9 there.'],
    [{ step: 'offline' }, 'alert', 'Nexus Mods could not be reached. Check your internet connection, then press Try again. If your internet works, Nexus may be down for a while.'],
    [{ step: 'down' }, 'alert', 'Nexus Mods is not working right now. Press Try again in a few minutes.'],
    [{ step: 'crashed' }, 'alert', 'The Nexus page stopped working. Press Try again.'],
    [{ step: 'signin', offStep: true }, 'info', "Log in on the Nexus page below. Nexus brings you back to TrueHUD 1.1.9 afterwards. This window has its own Nexus login, apart from your browser's."],
    [{ step: 'register', offStep: true }, 'info', 'Make your free Nexus account on the page below. If Nexus emails you a link, open it, then come back here and press Log in to Nexus.'],
    [{ step: 'premium', offStep: true }, 'info', 'That page is for buying Nexus Premium. You do not need it: press Back to the mod, then Slow download.'],
    [{ step: 'settings', offStep: true, adult: true, login: 'in', user: 'Dragonborn' }, 'info', 'Switch on adult content on this Nexus page, then press Back to the mod.'],
    [{ step: 'settings', offStep: true, adult: true, login: 'unknown' }, 'info',
      'Switch on adult content on this Nexus page, then press Back to the mod. If Nexus says your session has expired, press Log in to Nexus first, then Open my Nexus settings again.'],
    [{ step: 'otherFile', offStep: true }, 'info', 'This page is not the TrueHUD 1.1.9 download. Press Back to the mod.'],
    // Worded by where the page is from: only a Nexus page is called one
    [{ step: 'away', offStep: true, site: 'nexus' }, 'info', 'This is another Nexus page. Press Back to the mod to return to TrueHUD 1.1.9.'],
    [{ step: 'away', offStep: true, site: 'files' }, 'info', "Nexus's download link opened as a page. Press Back to the mod to return to TrueHUD 1.1.9."],
    [{ step: 'away', offStep: true, site: 'outside' }, 'info', 'This page is not on Nexus Mods. Press Back to the mod to return to TrueHUD 1.1.9.'],
    [{ step: 'away', offStep: true }, 'info', 'This page is not on Nexus Mods. Press Back to the mod to return to TrueHUD 1.1.9.'],
    // The window got the last one: the install comes next, never said as already running
    [{ step: 'allDone', count: { position: 3, total: 43, left: 0 } }, 'ok', 'Every mod is downloaded. The launcher installs them next.'],
    [{ step: 'allIn', count: { position: 3, total: 43, left: 0 } }, 'ok', 'Every mod is downloaded. This window closes now.'],
  ];
  for (const [extra, tone, said] of rows) {
    f.push(strip(extra));
    const step = extra.problem ? `${extra.step} ${extra.problem.kind}` : `${extra.step} ${extra.login || ''}`;
    assert.equal(f.text('#say-text'), said, step);
    assert.deepEqual(f.tone(), [tone], `${step}: one icon, its tone`);
    assert.equal(f.$('#say').className, tone === 'alert' ? 'say say--alert' : 'say', step);
    assert.doesNotMatch(said, DASHES, `${step}: no dashes or ellipsis`);
    // Sovngarde draws brackets like square ones, and house style is short sentences: neither in our own words
    assert.doesNotMatch(said.replace(/TrueHUD 1\.1\.9|XP32 Maximum Skeleton Special Extended 5\.06/g, ''), /[();]/, `${step}: no brackets or semicolons`);
  }
});

test('a short note stands in for the instruction on its own row and keeps the row\'s height, so the Nexus page below never moves while the player aims', t => {
  const f = fixture(t), line = f.$('#say-text');
  // JSDOM lays nothing out: the line's height as Chromium would measure it
  let height = 64;
  line.getBoundingClientRect = () => ({ height, width: 600, top: 0, left: 0, right: 600, bottom: height });
  const shownInRow = () => [...f.$('#say').children].filter(e => f.shown(e)).length;
  f.push(strip({ step: 'ready', login: 'in', user: 'Dragonborn' }));                 // the instruction: two lines
  const rowItems = shownInRow();
  assert.equal(line.style.minHeight, '');
  // A mod came in: "X is downloaded." in place of the instruction (one line), the row kept at the instruction's height
  height = 32;
  f.push(strip({ step: 'ready', login: 'in', user: 'Dragonborn', justIn: XPMSSE }));
  assert.deepEqual([f.text('#say-text'), line.style.minHeight, f.tone(), shownInRow()], ['XP32 Maximum Skeleton Special Extended 5.06 is downloaded.', '64px', ['ok'], rowItems], 'never a line more');
  f.push(strip({ step: 'ready', login: 'in', user: 'Dragonborn', justIn: XPMSSE }));
  assert.equal(line.style.minHeight, '64px', 'kept while the note stays');
  // The instruction back: the row is its own height again
  height = 64;
  f.push(strip({ step: 'ready', login: 'in', user: 'Dragonborn' }));
  assert.deepEqual([f.text('#say-text'), line.style.minHeight], ['Scroll down to Slow download and press it. Free accounts wait a few seconds, then the file comes straight to the launcher.', '']);
  // Another download pressed while one runs: said in place of the progress line, the same way
  height = 32;
  const downloading = { step: 'downloading', login: 'in', user: 'Dragonborn', busy: true, progress: { percent: 5, received: 1, mod: TRUEHUD } };
  f.push(strip(downloading));
  height = 30;
  f.push(strip({ ...downloading, problem: { kind: 'oneAtATime', mod: XPMSSE } }));
  assert.deepEqual([f.text('#say-text'), line.style.minHeight, f.$('#meter').hidden], ['One download at a time: TrueHUD 1.1.9 is at 5%.', '32px', false]);
  // A note shown before any instruction was measured locks nothing
  const g = fixture(t);
  g.push(strip({ step: 'moving', justIn: TRUEHUD }));
  assert.equal(g.$('#say-text').style.minHeight, '');
});

test('a percent sign sits in its own span, so Sovngarde\'s gap before it is closed', t => {
  const f = fixture(t);
  f.push(strip({ step: 'downloading', login: 'in', user: 'Dragonborn', progress: { percent: 63, received: 192571, mod: TRUEHUD } }));
  assert.equal(f.text('#say-text'), 'Downloading TrueHUD 1.1.9: 63%');
  assert.deepEqual([...f.$('#say-text').querySelectorAll('.pct-sign')].map(s => s.textContent), ['%']);
  assert.equal(f.$('#say-text').querySelectorAll('*').length, 1, 'only the sign is wrapped');
  f.push(strip({ step: 'opening' }));
  assert.equal(f.$('#say-text').children.length, 0, 'words without a percent stay plain text');
  assert.match(css, /\.pct-sign\{margin-left:-\.2em\}/);
});

test('Close says the download in progress stops, while one runs', t => {
  const f = fixture(t), close = f.$('#nx-close');
  f.push(strip({ step: 'downloading', login: 'in', user: 'Dragonborn', busy: true, progress: { percent: 5, received: 1, mod: TRUEHUD } }));
  assert.deepEqual([close.getAttribute('aria-label'), close.title], ['Close the Nexus window. The download in progress stops.', 'Close the Nexus window. The download in progress stops.']);
  f.push(strip({ step: 'checking', login: 'in', user: 'Dragonborn', busy: true, progress: { percent: 100, received: 1, mod: TRUEHUD } }));
  assert.deepEqual([close.getAttribute('aria-label'), close.hasAttribute('title')], ['Close the Nexus window', false], 'a file being checked finishes whatever happens');
});

test('the buttons follow the login, the page, the mods left and the adult flag; Back shows whenever the view is off the step page', t => {
  const f = fixture(t);
  // Log in to Nexus shows whenever the window is not known to be logged in, except on Nexus's own login page
  const cases = [
    [{ step: 'ready', login: 'out' }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser']],
    [{ step: 'ready', login: 'in', user: 'Dragonborn' }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser']],
    [{ step: 'ready', login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser']],
    [{ step: 'signin', offStep: true, login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'downloading', login: 'in', user: 'Dragonborn', busy: true, progress: { percent: 5, received: 1, mod: TRUEHUD } }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser']],
    [{ step: 'signin', offStep: true }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'register', offStep: true }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'register', offStep: true, login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'premium', offStep: true, login: 'in', user: 'Dragonborn' }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'settings', offStep: true, login: 'in', user: 'Dragonborn', adult: true }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'settings', offStep: true, login: 'unknown', adult: true }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'away', offStep: true, login: 'in', user: 'Dragonborn' }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'otherFile', offStep: true, login: 'in', user: 'Dragonborn' }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'problem', offStep: true, login: 'in', user: 'Dragonborn', problem: { kind: 'modManager', mod: TRUEHUD } }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-back']],
    [{ step: 'problem', offStep: false, login: 'in', user: 'Dragonborn', problem: { kind: 'different', mod: TRUEHUD } }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser']],
    [{ step: 'problem', login: 'in', user: 'Dragonborn', problem: { kind: 'error', mod: TRUEHUD } }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    [{ step: 'nobox', login: 'in', user: 'Dragonborn' }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    [{ step: 'nmm', login: 'in', user: 'Dragonborn' }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    // Nexus out of reach, stopped, or still checking the window: Log in to Nexus could not work, so it is not offered
    [{ step: 'down', login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    [{ step: 'offline', login: 'unknown', offStep: true }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    [{ step: 'stuck', login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    [{ step: 'crashed' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry']],
    [{ step: 'challenge', login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser']],
    // A page still opening: nothing read yet, so a logged-in player never sees Log in flash
    [{ step: 'opening', login: 'unknown' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser']],
    [{ step: 'opening', login: 'out' }, ['nx-minimize', 'nx-close', 'nx-skip', 'nx-browser']],
    [{ step: 'allDone', login: 'in', user: 'Dragonborn', count: { position: 3, total: 3, left: 0 }, adult: true }, ['nx-minimize', 'nx-close']],
    [{ step: 'allIn', count: { position: 3, total: 3, left: 0 } }, ['nx-minimize', 'nx-close']],
    [{ step: 'ready', count: { position: 3, total: 3, left: 1 } }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-browser']],
    [{ step: 'ready', count: { position: 3, total: 3, left: 2 } }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser']],
    [{ step: 'ready', login: 'in', user: 'Dragonborn', adult: true }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-settings']],
    [{ step: 'ready', login: 'unknown', adult: true }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser', 'nx-settings']],
    [{ step: 'ready', login: 'out', adult: true }, ['nx-minimize', 'nx-close', 'nx-login', 'nx-skip', 'nx-browser']],
    [{ step: 'nobox', login: 'in', user: 'Dragonborn', adult: true }, ['nx-logout', 'nx-minimize', 'nx-close', 'nx-skip', 'nx-browser', 'nx-retry', 'nx-settings']],
  ];
  for (const [extra, buttons] of cases) {
    f.push(strip(extra));
    assert.deepEqual(f.buttons(), buttons, JSON.stringify(extra));
    // The adult note: hidden once every mod is in, and on the settings page, whose own line already says it
    assert.equal(f.shown(f.$('#adult')), extra.adult === true && !['allDone', 'allIn', 'settings'].includes(extra.step), `adult line: ${JSON.stringify(extra)}`);
    if (extra.adult === true) assert.equal(f.text('#adult-text'), extra.login === 'out' || extra.login === undefined ? ADULT_OUT : ADULT_IN, `adult wording: ${JSON.stringify(extra)}`);
    assert.equal(f.$('#mod').hidden, ['allDone', 'allIn'].includes(extra.step), `mod line: ${JSON.stringify(extra)}`);
  }
});

test('the login chip names the Nexus account, and stays hidden until a Nexus page has said', t => {
  const f = fixture(t);
  f.push(strip({ login: 'unknown', step: 'opening' }));
  assert.equal(f.$('#chip').hidden, true);
  f.push(strip({ login: 'out' }));
  assert.deepEqual([f.$('#chip').hidden, f.$('#chip').className, f.text('#chip-text')], [false, 'chip chip--out', 'Not logged in to Nexus']);
  f.push(strip({ login: 'in', user: 'Dragonborn' }));
  assert.deepEqual([f.$('#chip').hidden, f.$('#chip').className, f.text('#chip-text')], [false, 'chip', 'Logged in to Nexus as Dragonborn']);
  f.push(strip({ login: 'in', user: '' }));
  assert.equal(f.text('#chip-text'), 'Logged in to Nexus', 'No name read yet: never a sentence ending in "as"');
  f.push(strip({ login: 'unknown', step: 'opening' }));
  assert.equal(f.$('#chip').hidden, true);
});

test('the meter fills to the percent, and sweeps when Nexus did not say the size', t => {
  const f = fixture(t);
  const meter = f.$('#meter'), fill = meter.querySelector('i');
  f.push(strip({ login: 'in', user: 'Dragonborn' }));
  assert.equal(meter.hidden, true);
  f.push(strip({ step: 'downloading', login: 'in', user: 'Dragonborn', progress: { percent: 63, received: 192571, mod: TRUEHUD } }));
  assert.deepEqual([meter.hidden, meter.getAttribute('aria-valuenow'), fill.style.getPropertyValue('--p'), meter.classList.contains('indeterminate'), meter.getAttribute('aria-valuetext')],
    [false, '63', '0.63', false, 'Downloading TrueHUD 1.1.9: 63%']);
  f.push(strip({ step: 'downloading', login: 'in', user: 'Dragonborn', progress: { percent: null, received: 0, mod: TRUEHUD } }));
  assert.deepEqual([meter.hidden, meter.hasAttribute('aria-valuenow'), meter.classList.contains('indeterminate'), meter.getAttribute('aria-valuetext')],
    [false, false, true, 'Downloading TrueHUD 1.1.9: 0.0 MB so far']);
  f.push(strip({ step: 'checking', login: 'in', user: 'Dragonborn', progress: { percent: 100, received: 305668, mod: TRUEHUD } }));
  assert.equal(meter.hidden, true, 'Only a download shows the meter');
});

test('the strip keeps to the room main gives it, and scrolls inside it', t => {
  const f = fixture(t);
  f.push(strip({ room: 300 }));
  assert.equal(f.$('#strip').style.maxHeight, '300px');
  for (const bad of ['300', NaN, null, 50]) { f.push(strip({ room: bad })); assert.equal(f.$('#strip').style.maxHeight, '300px', String(bad)); }
  f.push(strip({ room: 680.7 }));
  assert.equal(f.$('#strip').style.maxHeight, '680px');
  assert.match(css, /\.strip\{[^}]*overflow-y:auto/, 'more than the room scrolls inside the strip, never under the Nexus page');
  assert.match(css, /\.bar\{[^}]*position:sticky/, 'the window controls stay in reach while it scrolls');
});

test('each button asks main for its own action', t => {
  const f = fixture(t);
  f.push(strip());
  for (const id of BUTTONS) f.$(`#${id}`).click();
  assert.deepEqual(f.calls.act, ['logout', 'minimize', 'close', 'login', 'skip', 'browser', 'retry', 'back', 'settings']);
});

test('names from Nexus or the install list are only ever text', t => {
  const f = fixture(t);
  const hostile = '<img src=x onerror="window.executed=true">', hostile2 = '<b onclick="window.executed=true">5%</b>';
  const mod = { name: hostile, version: hostile2, size: 1000 };
  f.push(strip({ mod, login: 'in', user: hostile, justIn: mod }));
  assert.equal(f.text('#mod-name'), hostile);
  assert.equal(f.text('#mod-meta'), `Version ${hostile2} · 1 KB`);
  assert.equal(f.text('#chip-text'), `Logged in to Nexus as ${hostile}`);
  f.push(strip({ mod, step: 'problem', problem: { kind: 'different', mod } }));
  assert.equal(f.text('#say-text'), `That was a different file. Dovakarn needs ${hostile} ${hostile2}, 1 KB. Press Slow download in the box below, not Manual at the top of the Nexus page.`);
  assert.equal(f.d.querySelectorAll('b').length, 0, 'a percent sign in a name is wrapped as text, never markup');
  assert.equal(f.d.querySelectorAll('img').length, 0);
  assert.equal(f.w.executed, undefined);
});

test('a state that is not an object, or has a step or problem this page does not know, changes nothing', t => {
  const f = fixture(t);
  f.push(strip({ login: 'in', user: 'Dragonborn' }));
  const before = [f.text('#say-text'), f.text('#chip-text'), f.text('#mod-name'), f.buttons().join()];
  for (const bad of [null, undefined, 'ready', 42, [], {}, { step: 'nope' }, { step: 'login' }, strip({ step: 'problem', problem: { kind: 'nope', mod: TRUEHUD } }), strip({ step: 'problem', problem: null })]) {
    f.push(bad);
    assert.deepEqual([f.text('#say-text'), f.text('#chip-text'), f.text('#mod-name'), f.buttons().join()], before, JSON.stringify(bad));
  }
});

test('the page tells main it is ready once, after the font and two frames', async t => {
  const f = fixture(t);
  assert.equal(f.calls.ready, 0, 'Not before the frames');
  await wait(120);
  assert.equal(f.calls.ready, 1);
  f.push(strip());
  await wait(60);
  assert.equal(f.calls.ready, 1, 'A state never says ready again');
  assert.ok(f.calls.height.every(px => px > 0), 'A height of nothing is never reported');
});

test('the strip\'s CSS keeps the launcher\'s rules: Sovngarde loaded before text shows, 1px borders, no glows, body text at 21px or more', () => {
  // At 1000 px and narrower the title gives way: the brand's auto margin keeps the chip and window buttons at the right edge
  assert.match(css, /\.brand\{margin-right:auto;/);
  assert.match(css, /@media\(max-width:1000px\)\{\.bar-title\{display:none\}\}/);
  const faces = css.match(/@font-face\{font-family:Sovngarde;[^}]*\}/g) || [];
  assert.deepEqual(faces.map(face => [/Sovngarde-(Light|Bold)\.ttf/.exec(face)?.[1], /font-display:block/.test(face)]), [['Light', true], ['Bold', true]]);
  assert.match(css, /body,body \*\{font-family:Sovngarde,Georgia,serif!important\}/);
  assert.doesNotMatch(css, /box-shadow:[^;}]*\b0 0 \d+px #[0-9a-f]{6,8}/i, 'no coloured halo glows');
  for (const sel of ['.strip', '.bar', '.mod', '.say', '.adult', '.meter']) {
    const rule = new RegExp(`(?:^|\\})${sel.replace('.', '\\.')}\\{([^}]*)\\}`, 'm').exec(css)?.[1] || '';
    assert.doesNotMatch(rule, /border(?:-\w+)?:[2-9]px/, `${sel}: 1px borders only`);
  }
  for (const sel of ['.say p', '.adult p', '.mod-meta', '.chip', '.link', '.primary', '.secondary']) {
    const rule = new RegExp(`(?:^|\\}|,)${sel.replace('.', '\\.').replace(' ', ' ')}\\{([^}]*)\\}`, 'm').exec(css)?.[1] || '';
    const px = Number(/font-size:(\d+)px/.exec(rule)?.[1]);
    assert.ok(px >= 21, `${sel} is ${px}px`);
  }
});
