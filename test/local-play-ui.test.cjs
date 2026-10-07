const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const renderer = path.join(__dirname, '../src/renderer');
const html = fs.readFileSync(path.join(renderer, 'local-play.html'), 'utf8');
const script = fs.readFileSync(path.join(renderer, 'local-play.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const SKYRIM = 'C:\\Games\\steamapps\\common\\Skyrim Special Edition - Dovakarn';
const goodFolder = { path: SKYRIM, exe: true, version: '1.6.1170.0', versionOk: true, required: '1.6.1170.0', skse: true };
const link = { name: 'Dovakarn', url: 'https://www.nexusmods.com/games/skyrimspecialedition/collections/abcdef' };
const fileList = (version = { label: 'v0.1.0', tag: 'v0.1.0', ahead: 0, commit: 'abc12345', date: '2026-01-15T10:00:00Z', modified: false }, extra = {}) => ({
  version, generatedAt: '2026-01-15T10:05:00Z', files: 219, served: 150, base: 5,
  mods: [{ name: 'Skyrim Script Extender (SKSE64)', files: 64, critical: true }], collection: link, ...extra });
const passed = (extra = {}) => ({ at: Date.now(), published: true, checked: 219, updated: 0, patched: 0, problems: 0, blocked: false,
  collection: { revision: 3, total: 52, missing: 0, outdated: 0 }, ...extra });

// A page on a real origin, like Electron's file page, so browser storage behaves as it does there.
// hold: the launcher has not answered yet, as while its main process starts up.
// nexusAtStart: the Nexus window's state the launcher answers when the page asks at start (nexus:snapshot)
// nexusMe: the player's Nexus account as the launcher answers at start (nexusAccount:state)
async function fixture(t, initial = {}, { check, hold = false, nexusAtStart = null, nexusMe = { loggedIn: false, account: null, pending: false, error: null, available: false } } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://launcher.test/local-play.html' });
  t.after(() => dom.window.close()); // Includes the renderer's refresh interval.
  const w = dom.window;
  const state = {
    serverOnline: false, gameRunning: false, busy: false, mode: 'local',
    phase: { stage: 'ready', message: 'Ready to launch.' },
    server: { name: 'Dovakarn-Local-Test', address: 'This PC · 127.0.0.1:7780', uptime: null, players: [], max: 8 }, fileList: null, lastCheck: null, gameFolder: goodFolder, launcherVersion: '2.1.1',
    ...initial,
  };
  const calls = { play: 0, check: 0, cancel: 0, close: 0, minimize: 0, state: 0, collection: 0, openFolder: 0, updateCheck: 0, updateInstall: 0, updateDownload: 0, updateCancel: 0, options: [], mods: [], folder: [], account: [], controls: [], updates: 0, game: [], nexusMe: [] };
  // The Nexus account stand-in: what the launcher answers, and how a Log in to Nexus ends (a test decides)
  let nexusMeState = nexusMe, nexusMePush = () => {};
  let nexusMeLogin = async () => ({ success: true, state: nexusMeState });
  // Cancel: the waiting login ends as cancelled, with the account's state as it then is. (The launcher's own Cancel answers
  // while the login still waits, and the login's end follows; the page takes the login's end as the last word either way)
  let cancelLogin = () => {};
  // Dovakarn's own game copy: what each launcher call answers; a test changes them
  const gameAnswers = { setup: async () => ({ success: true }), chooseInstall: async () => ({ success: false, cancelled: true }), remove: async () => ({ success: true }),
    restoreSkyrim: async () => ({ success: true, summary: 'Done: removed 3 Dovakarn files.' }), downloadMods: async () => ({ success: true }), logoutNexus: async () => ({ success: true }),
    openInBrowser: async () => ({ success: true }), addModsFolder: async () => ({ success: false, cancelled: true }),
    // Settings, Mods: Forget one of the player's own mod folders; the launcher's state then lists the rest
    forgetModsFolder: async (state, dir) => { state.gameCopy = { ...state.gameCopy, modsFolders: (state.gameCopy?.modsFolders || []).filter(d => d !== dir) }; return { success: true }; } };
  // The Nexus window's pushes (nexus:state): a test sends them with f.nexus(snapshot)
  let nexusPush = () => {};
  let progress, answer = Promise.resolve(), release = () => {};
  if (hold) answer = new Promise(resolve => { release = resolve; });
  let launch = async () => ({ success: true }), checkFiles = check || (async () => ({ success: true })), pickFolder = async () => ({ success: false, cancelled: true });
  // Discord login stand-in: a test decides how the browser login ends; like main.js, results land in the launcher's status line
  let accountLogin = async () => ({ success: true, state: state.login });
  let updateAnswer = async () => ({ current: '2.1.1', latest: '2.1.1', hasUpdate: false, retry: false, downloadUrl: '' });
  let installAnswer = async () => ({ ok: true });
  let downloadAnswer = async () => ({ ok: true, version: '' });
  let updateProgress = () => {};
  // Check again: what the server says when asked afresh, by default a fresh answer about the same account
  let accountRecheck = async () => ({ ...state.login, reached: true, membershipError: null, membershipAge: 0, askAgainIn: 0 });
  let openDiscord = async () => ({ success: true });
  // Latest updates: what the notice board says; by default none yet
  let updatesAnswer = { entries: [], fresh: [], reached: true };
  w.localPlay = {
    account: {
      async login() {
        calls.account.push('login'); state.login = { ...state.login, pending: true };
        const result = await accountLogin(state);
        if (result.success) state.phase = { stage: 'ready', message: `Logged in as ${result.state.account.name}, Dovakarn account #${result.state.account.number}.` };
        else if (result.code !== 'cancelled') state.phase = { stage: 'account', message: result.error };
        return result;
      },
      async cancel() { calls.account.push('cancel'); state.login = { ...state.login, pending: false }; return state.login; },
      async refresh(fresh) { calls.account.push(fresh ? 'refresh-fresh' : 'refresh'); return fresh ? accountRecheck(state) : state.login; },
      async logout() { calls.account.push('logout'); state.login = { ...state.login, loggedIn: false, account: null }; state.phase = { stage: 'ready', message: 'Logged out of Dovakarn on this PC.' }; return state.login; },
      async openDiscord() { calls.account.push('discord'); return openDiscord(); },
    },
    async state() { calls.state++; await answer; return state; },
    async updates() { calls.updates++; return updatesAnswer; },
    play(options) { calls.play++; calls.options.push(options); return launch(); },
    check() { calls.check++; return checkFiles(state); },
    async cancel() { calls.cancel++; return { success: true }; },
    async openCollection() { calls.collection++; return { success: true }; },
    async openMod(id) { calls.mods.push(id); return { success: true }; },
    chooseFolder() { calls.folder.push('choose'); return pickFolder(); },
    async openGameFolder() { calls.openFolder++; return { success: true }; },
    // Settings, Controls: the launcher keeps the keys (main.js); every change is accepted here
    controls: {
      async set(id, key) { calls.controls.push([id, key]); const c = { ...(state.keyChoices || {}) }; if (key === null) delete c[id]; else c[id] = key; state.keyChoices = c; return { success: true }; },
      async reset() { calls.controls.push(['reset']); state.keyChoices = {}; return { success: true }; },
    },
    onProgress(callback) { progress = callback; },
    // Launcher self-update: a test decides what the server says; by default this launcher is current
    update: {
      async check() { calls.updateCheck++; return updateAnswer(); },
      async download() { calls.updateDownload++; return downloadAnswer(); },
      async install() { calls.updateInstall++; return installAnswer(); },
      async cancel() { calls.updateCancel++; return { ok: true }; },
      onProgress(callback) { updateProgress = callback; },
    },
    close() { calls.close++; },
    minimize() { calls.minimize++; },
    game: {
      chooseInstall() { calls.game.push(['chooseInstall']); return gameAnswers.chooseInstall(state); },
      setup() { calls.game.push(['setup']); return gameAnswers.setup(state); },
      async openConsole() { calls.game.push(['openConsole']); return { success: true }; },
      async copy(value) { calls.game.push(['copy', value]); return { success: true }; },
      async downloadMods(id, useWindow) { calls.game.push(useWindow ? ['downloadMods', id, 'window'] : ['downloadMods', id]); return gameAnswers.downloadMods(state, id); },
      async stopDownloads() { calls.game.push(['stopDownloads']); return { success: true, stopped: gameAnswers.stopped !== false }; },
      async downloads() { return nexusAtStart; },
      onDownloads(callback) { nexusPush = callback; },
      async logoutNexus() { calls.game.push(['logoutNexus']); return gameAnswers.logoutNexus(state); },
      async openInBrowser(id) { calls.game.push(['openInBrowser', id]); return gameAnswers.openInBrowser(state, id); },
      async addModsFolder() { calls.game.push(['addModsFolder']); return gameAnswers.addModsFolder(state); },
      async forgetModsFolder(dir) { calls.game.push(['forgetModsFolder', dir]); return gameAnswers.forgetModsFolder(state, dir); },
      async openInstall() { calls.game.push(['openInstall']); return { success: true }; },
      remove() { calls.game.push(['remove']); return gameAnswers.remove(state); },
      restoreSkyrim() { calls.game.push(['restoreSkyrim']); return gameAnswers.restoreSkyrim(state); },
    },
    nexusAccount: {
      async state() { calls.nexusMe.push('state'); return nexusMeState; },
      async login() { calls.nexusMe.push('login'); const result = await nexusMeLogin(); if (result.state) nexusMeState = { ...nexusMeState, ...result.state }; return result; },
      async cancel() { calls.nexusMe.push('cancel'); cancelLogin(); return nexusMeState; },
      async logout() { calls.nexusMe.push('logout'); nexusMeState = { ...nexusMeState, loggedIn: false, account: null, pending: false }; return { success: true, stopped: gameAnswers.stopped === true, state: nexusMeState }; },
      onState(callback) { nexusMePush = callback; },
    },
  };
  // The page's 2 second refresh runs only when a test asks, so results never depend on timing.
  const ticks = [];
  w.setInterval = callback => ticks.push(callback);
  w.eval(script);
  await settle();
  const d = w.document, $ = id => d.querySelector(id), text = id => $(id).textContent;
  const key = (el, name, shiftKey = false) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }));
  return {
    w, d, $, state, calls, text, key,
    play: $('#play'), verify: $('#verify'), message: $('#message'), server: $('#server'), notice: $('#notice'),
    settings: $('#settings'), checks: $('#checks'),
    checkTitles: () => [...d.querySelectorAll('#checks-list > li')].map(li => [li.querySelector('strong').textContent, li.className.replace('check check--', '')]),
    checkText: title => [...d.querySelectorAll('#checks-list > li')].find(li => li.querySelector('strong').textContent === title)?.querySelector('p').textContent,
    progress: value => progress(value),
    launch: callback => { launch = callback; },
    loginWith: callback => { accountLogin = callback; },
    recheckWith: callback => { accountRecheck = callback; },
    discordWith: callback => { openDiscord = callback; },
    checkWith: callback => { checkFiles = callback; },
    pickWith: callback => { pickFolder = callback; },
    answer: () => { release(); return settle(); },
    tick: () => Promise.all(ticks.map(callback => callback())),
    updateWith: callback => { updateAnswer = callback; },
    installWith: callback => { installAnswer = callback; },
    downloadWith: callback => { downloadAnswer = callback; },
    updateProgress: value => updateProgress(value),
    updatesWith: value => { updatesAnswer = value; },
    nexus: value => { nexusPush(value); return settle(); },
    // The Nexus account: a push from the launcher (nexusAccount:state), and how the next Log in to Nexus ends
    nexusMe: value => { nexusMeState = { ...nexusMeState, ...value }; nexusMePush(value); return settle(); },
    nexusLoginWith: callback => { nexusMeLogin = callback; },
    // A login that waits until cancelled, as the real one does while the browser is open
    nexusLoginWaits: () => { nexusMeLogin = () => new Promise(resolve => { nexusMeState = { ...nexusMeState, pending: true }; nexusMePush({ ...nexusMeState }); cancelLogin = () => { nexusMeState = { ...nexusMeState, pending: false }; resolve({ success: false, code: 'cancelled', error: 'Login cancelled.', state: { ...nexusMeState } }); }; }); },
    gameAnswers,
  };
}

test('the main screen shows the server and one button, with Verify and Settings up top', async t => {
  const f = await fixture(t);
  assert.doesNotMatch(f.d.body.textContent, /Choose your character inside the game|next chapter/, 'No how-to-join steps');
  assert.equal(f.server.textContent, 'Server starts when you play');
  assert.equal(f.$('#population').hidden, true, 'No players gauge for a server that is not running');
  assert.equal(f.notice.hidden, true, 'Nothing to say, so no notice');
  assert.deepEqual([f.message.hidden, f.message.textContent], [false, 'Ready to launch.']);
  assert.deepEqual([f.play.textContent, f.play.disabled, f.verify.disabled], ['Play', false, false]);
  assert.equal(f.d.querySelectorAll('select,input,[data-character],[data-slot]').length, 0,
    'The launcher does not offer a second character selector outside Skyrim');
  assert.deepEqual([...f.d.querySelectorAll('button')].map(button => button.id),
    ['account-login', 'account-cancel', 'account-chip', 'verify', 'settings-open', 'minimize', 'close', 'notice-primary', 'notice-secondary', 'progress-cancel', 'play',
      'tab-account-button', 'tab-game-button', 'tab-controls-button', 'tab-mods-button', 'tab-updates-button',
      'account-settings-login', 'account-discord', 'account-logout',
      'copy-open', 'copy-remove', 'copy-setup', 'open-folder', 'folder-change', 'folder-switch', 'restore-skyrim', 'controls-reset', 'mods-get', 'mods-details', 'nexus-me-login', 'nexus-me-cancel', 'nexus-me-logout', 'nexus-logout', 'mods-check', 'updates-check', 'updates-launcher-check', 'updates-install', 'settings-done',
      'checks-collection', 'checks-again', 'checks-close', 'setup-change', 'setup-console', 'setup-install', 'setup-close', 'mods-folder', 'mods-premium-login', 'mods-browser-open', 'mods-window', 'mods-all', 'mods-stop', 'mods-again', 'mods-close']);
  assert.equal(f.$('#account').hidden, true, 'A server without Discord login shows no account area');
  assert.deepEqual([f.settings.hidden, f.checks.hidden], [true, true], 'Settings and Verify stay closed until asked for');
  assert.equal(f.text('#footer-version'), 'Dovakarn v2.1.1', 'The footer carries the launcher version, published server build or not');
  f.$('#minimize').click();
  f.$('#close').click();
  assert.deepEqual([f.calls.minimize, f.calls.close], [1, 1]);
});

test('launch button disables immediately and blocks repeated clicks while Skyrim starts', async t => {
  const f = await fixture(t, { lastCheck: passed() });
  let complete;
  f.launch(() => new Promise(resolve => { complete = resolve; }));
  f.play.click();
  assert.equal(f.calls.play, 1);
  assert.deepEqual([f.play.disabled, f.verify.disabled], [true, false], 'Only Play waits while a launch prepares the files');
  f.play.click(); f.verify.click();
  assert.deepEqual([f.calls.play, f.calls.check], [1, 1], 'Repeated clicks cannot start another launch or a check');
  assert.deepEqual([f.checks.hidden, f.text('#checks-title'), f.$('#checks-again').disabled], [false, 'Checking...', true], 'Verify follows the launch\'s own check');
  f.$('#checks-close').click();

  f.state.serverOnline = true;
  f.state.gameRunning = true;
  f.state.phase = { stage: 'characterMenu', message: 'Connected. Choose your character in the Dovakarn menu inside Skyrim, or create a new one.' };
  complete({ success: true });
  await settle();
  assert.equal(f.server.textContent, 'Server running');
  assert.equal(f.message.textContent, f.state.phase.message);
  assert.deepEqual([f.play.textContent, f.play.disabled, f.verify.disabled], ['Skyrim is running', true, false], 'Skyrim keeps its files locked while it runs');
  assert.deepEqual([f.$('#folder-change').disabled, f.$('#folder-change').title], [true, 'Close Skyrim to change the folder.'], 'The folder cannot change under a running game');
  f.verify.click();
  assert.deepEqual([f.checks.hidden, f.calls.check, f.text('#checks-title'), f.$('#checks-again').disabled], [false, 1, 'All good', true], 'Verify shows the last result without checking a running game');
  assert.match(f.text('#checks-summary'), /^Checked at .+\. Close Skyrim to check again\.$/);
  f.$('#checks-close').click();
  f.play.click();
  assert.equal(f.calls.play, 1);
});

test('before the launcher answers, only Play waits: Settings and Verify open straight away', async t => {
  const f = await fixture(t, { fileList: fileList() }, { hold: true, check: async state => { state.lastCheck = passed(); return { success: true }; } });
  assert.deepEqual([f.play.disabled, f.play.textContent, f.verify.disabled, f.$('#settings-open').disabled], [true, 'Checking...', false, false]);
  f.play.click();
  assert.equal(f.calls.play, 0, 'Nothing launches before the first check');
  f.$('#settings-open').click();
  assert.equal(f.settings.hidden, false, 'Settings opens at once');
  assert.deepEqual([f.$('#settings-loading').hidden, f.$('.modal-box--settings').classList.contains('loading'), f.$('#folder-change').disabled], [false, true, true], 'It says it is loading instead of guessing');
  f.key(f.settings, 'Escape');
  f.verify.click();
  assert.deepEqual([f.checks.hidden, f.text('#checks-title'), f.$('#checks-again').disabled, f.calls.check], [false, 'Checking...', true, 0], 'Verify opens too and waits for the check on open');
  assert.equal(f.d.querySelectorAll('#checks-list li').length, 0, 'No guessed results');
  await f.answer();
  assert.equal(f.calls.check, 1, 'The check on open runs once, not once more for Verify');
  assert.deepEqual([f.text('#checks-title'), f.checks.hidden, f.play.disabled, f.play.textContent], ['All good', false, false, 'Play']);
  f.$('#checks-close').click();
  f.$('#settings-open').click();
  assert.deepEqual([f.$('#settings-loading').hidden, f.$('.modal-box--settings').classList.contains('loading'), f.text('#folder-path'), f.$('#folder-change').disabled], [true, false, SKYRIM, false]);
});

test('while a check runs, Verify follows it step by step and Settings stays usable', async t => {
  let finish;
  const f = await fixture(t, { serverOnline: true, fileList: fileList() }, { check: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(f.calls.check, 1, 'The check on open is running');
  assert.deepEqual([f.play.disabled, f.play.textContent, f.verify.disabled, f.$('#settings-open').disabled], [true, 'Checking game files...', false, false], 'Play waits for the check, and says so');
  f.$('#settings-open').click();
  assert.deepEqual([f.settings.hidden, f.text('#folder-path')], [false, SKYRIM], 'Settings shows real details mid-check');
  assert.deepEqual([f.$('#folder-change').disabled, f.$('#folder-change').title], [true, 'You can change the folder when the current check finishes.']);
  assert.deepEqual([f.$('#mods-check').disabled, f.$('#updates-check').disabled], [false, false]);
  f.$('#tab-mods-button').click(); f.$('#mods-check').click();
  assert.deepEqual([f.settings.hidden, f.checks.hidden, f.calls.check, f.text('#checks-title')], [true, false, 1, 'Checking...'], 'Check now shows the running check instead of starting another');
  f.progress({ stage: 'preparingHost', message: 'Setting up the server from the Dovakarn collection...' });
  assert.equal(f.text('#checks-summary'), 'Setting up the server from the Dovakarn collection...', 'Each step shows as it happens');
  f.progress({ stage: 'updatingFiles', message: 'Updating Dovakarn files (2 of 5)...' });
  assert.equal(f.text('#checks-summary'), 'Updating Dovakarn files (2 of 5)...');
  f.$('#checks-close').click(); f.verify.click(); f.$('#checks-close').click(); f.verify.click();
  assert.deepEqual([f.checks.hidden, f.calls.check], [false, 1], 'Verify opens as often as wanted without piling up checks');
  f.state.lastCheck = passed(); f.state.phase = { stage: 'ready', message: 'Your game files match the server (219 files checked).' };
  finish({ success: true }); await settle();
  assert.deepEqual([f.text('#checks-title'), f.play.disabled, f.play.textContent, f.$('#folder-change').disabled, f.$('#folder-change').title], ['All good', false, 'Play', false, '']);
  assert.match(f.text('#checks-summary'), /^Checked at .+\.$/);
});

test('busy and already-open sessions disable launch and failure details stay plain text', async t => {
  const f = await fixture(t, {
    serverOnline: true, gameRunning: true,
    phase: { stage: 'characterMenu', message: 'Choose your saved character inside Skyrim.' },
  });
  assert.equal(f.play.disabled, true);
  assert.equal(f.calls.check, 0, 'No check while Skyrim is running');
  assert.equal(f.message.textContent, 'Choose your saved character inside Skyrim.');
  const dangerous = '<img src=x onerror="window.executed=true"> Check your game files.';
  f.progress({ stage: 'failed', message: dangerous });
  assert.equal(f.message.textContent, dangerous);
  assert.equal(f.message.className, 'error');
  assert.equal(f.message.querySelector('img'), null);
  assert.equal(f.w.executed, undefined);
  f.progress({ stage: 'checking', message: 'Checking your game files against the server...' });
  assert.equal(f.message.className, '', 'A new attempt clears the previous error styling');

  const busy = await fixture(t, { busy: true });
  assert.equal(busy.play.disabled, true);
  assert.match(busy.play.textContent, /Preparing Skyrim/);
  assert.equal(busy.calls.check, 0, 'No check while the launcher is busy');
  busy.play.click();
  assert.equal(busy.calls.play, 0);
  busy.verify.click();
  assert.deepEqual([busy.checks.hidden, busy.text('#checks-title'), busy.calls.check], [false, 'Checking...', 0], 'A launch from a Play shortcut shows in Verify without a second check');
});

test('failed launch keeps a readable error and allows another attempt', async t => {
  const f = await fixture(t);
  const error = 'Missing client <script>window.executed=true</script>';
  f.launch(async () => {
    f.state.phase = { stage: 'failed', message: error };
    return { success: false, error };
  });
  f.play.click();
  await settle();
  assert.deepEqual([f.text('#notice-title'), f.text('#notice-text'), f.notice.className, f.play.textContent], ['Skyrim did not start', error, 'notice notice--bad', 'Try again'], 'A failed launch is a card, not a quiet line');
  assert.deepEqual([f.message.textContent, f.message.className, f.message.hidden], [error, 'error', true], 'said once, in the card');
  assert.equal(f.d.querySelector('#notice script'), null);
  assert.deepEqual([f.play.disabled, f.verify.disabled], [false, false]);
  assert.equal(f.w.executed, undefined);
  f.play.click();
  await settle();
  assert.equal(f.calls.play, 2, 'A failure does not leave the launcher stuck');
});

test('mods needed before playing show one notice, and its list names each mod as plain text', async t => {
  const hostile = '<img src=x onerror="window.executed=true">Evil Mod';
  const message = '2 mods are missing or out of date. Install or reinstall the Dovakarn mod collection, then check again.';
  const f = await fixture(t, {
    serverOnline: true, fileList: fileList(),
    phase: { stage: 'filesBlocked', message },
    files: { blocked: true, collection: true, collectionName: 'Dovakarn', mods: [
      { name: hostile, missing: 2, changed: 0, critical: true },
      { name: 'TrueHUD', missing: 0, changed: 1, critical: true },
    ] },
    lastCheck: passed({ problems: 2, blocked: true }),
  });
  assert.equal(f.notice.hidden, false);
  assert.equal(f.notice.className, 'notice notice--bad');
  assert.deepEqual([f.text('#notice-title'), f.text('#notice-text')], ['Mods needed before you can play', '2 mods missing or out of date.']);
  assert.deepEqual([f.text('#notice-primary'), f.text('#notice-secondary'), f.$('#notice-secondary').hidden], ['Get the Dovakarn collection', "See what's missing", false], 'The fix is the button; the list is the link');
  assert.equal(f.message.hidden, true, 'The notice already says it, so the status line steps aside');
  assert.equal(f.play.textContent, 'Check again and play', 'Blocking problems cannot be skipped');
  f.$('#notice-secondary').click();
  assert.equal(f.checks.hidden, false);
  const files = [...f.d.querySelectorAll('#checks-list .check-list li')].map(li => li.textContent);
  assert.deepEqual(files, [`${hostile}: 2 files missing`, 'TrueHUD: 1 file out of date']);
  assert.equal(f.d.querySelector('#checks-list img'), null);
  assert.equal(f.w.executed, undefined);
  f.$('#checks-close').click();
  f.$('#notice-primary').click(); await settle();
  assert.equal(f.calls.collection, 1);
  f.play.click(); await settle();
  assert.equal(f.calls.play, 1);
  assert.equal(f.calls.options[0], undefined, 'Checking again never skips a blocking problem');

  const noLink = await fixture(t, { phase: { stage: 'filesBlocked', message }, files: { blocked: true, collection: false, collectionName: 'Dovakarn', mods: [] }, lastCheck: passed({ problems: 1, blocked: true }) });
  assert.deepEqual([noLink.$('#notice-secondary').hidden, noLink.text('#notice-text')], [true, '1 mod missing or out of date.'], 'No collection button without a link');
});

test('mod warnings offer Play anyway, and once Skyrim starts a card says what to do inside it', async t => {
  const f = await fixture(t, {
    serverOnline: true,
    phase: { stage: 'filesWarning', message: '1 mod has files that differ from the server.' },
    files: { blocked: false, collection: false, collectionName: 'Dovakarn', mods: [{ name: 'Textures', missing: 0, changed: 3, critical: false }] },
    lastCheck: passed({ problems: 1, collection: null }),
  });
  assert.deepEqual([f.notice.className, f.text('#notice-title')], ['notice notice--warn', 'Some mod files differ from the server']);
  assert.deepEqual([f.play.textContent, f.message.className, f.message.hidden], ['Play anyway', '', true]);
  f.launch(async () => { f.state.files = null; f.state.phase = { stage: 'connecting', message: 'Skyrim is connecting.' }; return { success: true }; });
  f.play.click(); await settle();
  assert.equal(f.calls.options[0].ignoreWarnings, true);
  assert.deepEqual([f.play.textContent, f.message.hidden, f.text('#notice-title'), f.notice.className], ['Play', true, 'Pick your character inside Skyrim', 'notice notice--info']);
  assert.match(f.text('#notice-text'), /Do not press New or Continue\.$/);
});

test('the server line and Settings show uptime, players and version, all as plain text', async t => {
  const hostile = '<img src=x onerror="window.executed=true">';
  const f = await fixture(t, { serverOnline: true, server: { uptime: 4380, players: [hostile, 'Ulfric', 'Lydia', 'Serana'], max: 8 }, fileList: fileList(), lastCheck: passed() });
  assert.equal(f.server.textContent, 'Server running', 'Says what "online" meant: the server is up. How long it has been up is in Settings');
  assert.deepEqual([f.$('#population').hidden, f.text('#population-now'), f.$('#population-of').hidden, f.text('#population-max'), f.$('#capacity-fill').style.getPropertyValue('--p')],
    [false, '4', false, '8', '0.5'], 'The count sits on its own gauge row, and the bar is that count against the limit');
  assert.equal(f.text('#server-status'), 'Running, up 1h 13m', 'Who is online belongs to the Players row alone');
  assert.equal(f.text('#server-players'), `${hostile}, Ulfric, Lydia, Serana`);
  assert.equal(f.d.querySelector('#server-players img'), null);
  assert.equal(f.w.executed, undefined);
  assert.equal(f.text('#footer-version'), 'Dovakarn v2.1.1');

  const crowd = await fixture(t, { serverOnline: true, server: { uptime: 12, players: ['A', 'B', 'C', 'D', 'E'], max: 8 } });
  assert.deepEqual([crowd.text('#population-now'), crowd.text('#server-players'), crowd.$('#server-players').title],
    ['5', 'A, B, C and 2 more', 'A, B, C, D, E'], 'Every name is on hover');
  const nobody = await fixture(t, { serverOnline: true, server: { uptime: 190000, players: [], max: 8 } });
  assert.deepEqual([nobody.$('#population').hidden, nobody.text('#population-now'), nobody.text('#population-max'), nobody.$('#capacity-fill').style.getPropertyValue('--p'), nobody.text('#server-players')],
    [false, '0', '8', '0', 'Nobody online yet'], 'An empty world still shows its gauge, empty');
  const noMax = await fixture(t, { serverOnline: true, server: { uptime: null, players: ['Ulfric'] } });
  assert.deepEqual([noMax.text('#population-now'), noMax.$('#population-of').hidden, noMax.$('#capacity').hidden], ['1', true, true], 'An unknown player limit is left out, not printed as undefined');
  const offline = await fixture(t);
  assert.deepEqual([offline.text('#server-status'), offline.text('#server-players')], ['Starts when you play', 'Server offline']);
});

test('the server version comes from release tags', async t => {
  const version = extra => fileList({ label: 'v0.1.0', tag: 'v0.1.0', ahead: 0, commit: 'abc12345', date: '2026-01-15T10:00:00Z', modified: false, ...extra });
  const release = await fixture(t, { fileList: version() });
  assert.match(release.text('#updates-version'), /^v0\.1\.0, released .+\.$/);
  assert.equal(release.d.querySelector('#tab-advanced'), null, 'No Advanced tab: the Updates tab is the one home for versions');
  const ahead = await fixture(t, { fileList: version({ label: 'v0.1.0 +3', ahead: 3, modified: true }) });
  assert.match(ahead.text('#updates-version'), /^v0\.1\.0, released .+\.$/, 'No commit counting: version convention only');
  assert.equal(ahead.text('#footer-version'), 'Dovakarn v2.1.1');

  const dev = await fixture(t, { fileList: version({ label: 'Development build', tag: '', ahead: 0 }) });
  assert.match(dev.text('#updates-version'), /^A test build from .+, before the first release\.$/);
  const none = await fixture(t, { fileList: fileList(null) });
  assert.deepEqual([none.text('#updates-version'), none.text('#footer-version')], ['The server has not published a version yet.', 'Dovakarn v2.1.1']);
  assert.deepEqual([none.text('#launcher-version'), none.text('#updates-launcher')], ['Launcher 2.1.1', 'Version 2.1.1.']);
});

test('Settings opens from the top bar, switches tabs, and closes with Escape, Done or a click outside', async t => {
  const f = await fixture(t, { fileList: fileList(), lastCheck: passed() });
  f.$('#settings-open').focus();
  f.$('#settings-open').click();
  assert.equal(f.settings.hidden, false);
  assert.equal(f.d.activeElement.id, 'tab-game-button', 'Focus starts on the open tab');
  const open = () => ['game', 'mods', 'updates'].filter(name => !f.$(`#tab-${name}`).hidden);
  assert.deepEqual(open(), ['game']);
  f.$('#tab-mods-button').click();
  assert.deepEqual([open(), f.$('#tab-mods-button').getAttribute('aria-selected'), f.$('#tab-game-button').getAttribute('aria-selected')], [['mods'], 'true', 'false']);
  f.key(f.$('#tab-mods-button'), 'Escape');
  assert.equal(f.settings.hidden, true);
  assert.equal(f.d.activeElement.id, 'settings-open', 'Focus returns to the Settings button');
  f.$('#settings-open').click();
  assert.deepEqual(open(), ['mods'], 'The last tab stays open');
  f.$('#settings-done').click();
  assert.equal(f.settings.hidden, true);
  f.$('#settings-open').click();
  f.settings.dispatchEvent(new f.w.MouseEvent('click', { bubbles: true }));
  assert.equal(f.settings.hidden, true, 'A click on the dark backdrop closes it');
  f.$('#settings-open').click();
  f.$('#tab-mods-button').click();
  f.$('#mods-check').click(); await settle();
  assert.deepEqual([f.settings.hidden, f.checks.hidden, f.calls.check], [true, false, 2], 'Check now closes Settings and shows the checklist');
  f.$('#checks-close').click();
  f.$('#open-folder').click();
  assert.equal(f.calls.openFolder, 1);
});

test('the Mods tab speaks plainly about the collection and the last check', async t => {
  const at = Date.now(), withLink = fileList(), noLink = fileList(undefined, { collection: null });
  const collection = [
    [noLink, null, 'The server has not set a collection link yet.'],
    [withLink, null, 'Not checked yet.'],
    [withLink, { at, published: true, collection: { error: 'Could not reach Nexus: timeout' } }, 'Could not check Nexus: Could not reach Nexus: timeout'],
    [withLink, { at, published: true, collection: { revision: 3, total: 52, missing: 52, outdated: 0 } }, 'Not installed. It has 52 mods.'],
    [withLink, { at, published: true, collection: { revision: 3, total: 52, missing: 1, outdated: 2 } }, '3 mods missing or out of date.'],
    [withLink, { at, published: true, collection: { revision: 3, total: 52, missing: 0, outdated: 1 } }, '1 mod missing or out of date.'],
    [withLink, { at, published: true, collection: { revision: 3, total: 52, missing: 0, outdated: 0 } }, 'Installed, 52 mods.'],
  ];
  for (const [list, lastCheck, expected] of collection) {
    const f = await fixture(t, { fileList: list, lastCheck });
    assert.equal(f.text('#mods-collection'), expected);
    assert.equal(f.$('#mods-get').disabled, !list.collection);
  }
  const checked = { at, published: true, checked: 219, updated: 0, patched: 0 };
  const lasts = [
    [null, /^Not checked yet\.$/],
    [{ at, failed: true }, /^Last check failed at .+\.$/],
    [{ at, published: false }, /^Checked at .+: the server lists no files\.$/],
    [{ ...checked, problems: 2, blocked: true }, /^Checked at .+: 2 mods need\.$/],
    [{ ...checked, problems: 1, blocked: true }, /^Checked at .+: 1 mod needs\.$/],
    [{ ...checked, problems: 1, blocked: false }, /^Checked at .+: 1 mod differs\.$/],
    [{ ...checked, problems: 0, blocked: false }, /^Checked at .+: all files match\.$/],
  ];
  for (const [lastCheck, pattern] of lasts) assert.match((await fixture(t, { lastCheck })).text('#mods-last'), pattern);
  const f = await fixture(t, { fileList: withLink });
  assert.match(f.text('#mods-list'), /^The server lists 219 files from 1 mod, updated .+\.$/);
  assert.equal(f.$('#mods-details').hidden, true, "See what's missing only appears when something is");
  assert.equal((await fixture(t)).text('#mods-list'), 'The server has not published its file list yet.');
  f.$('#mods-get').click(); await settle();
  assert.equal(f.calls.collection, 1);
});

test('Verify checks everything, locks the buttons while it runs, and reports failures as plain text', async t => {
  const f = await fixture(t, { serverOnline: true, fileList: fileList() });
  assert.equal(f.calls.check, 1, 'The check already ran by itself on open');
  let finish;
  f.checkWith(() => new Promise(resolve => { finish = resolve; }));
  f.verify.click();
  assert.equal(f.checks.hidden, false, 'The checklist opens straight away');
  assert.deepEqual([f.calls.check, f.text('#checks-title'), f.play.disabled, f.play.textContent], [2, 'Checking...', true, 'Checking game files...']);
  assert.equal(f.$('#checks-again').disabled, true);
  f.verify.click(); f.play.click();
  assert.deepEqual([f.calls.check, f.calls.play], [2, 0], 'Nothing else starts during a check');
  f.state.lastCheck = passed();
  finish({ success: true }); await settle();
  assert.equal(f.text('#checks-title'), 'All good');
  assert.match(f.text('#checks-summary'), /^Checked at .+\.$/);
  assert.equal(f.calls.play, 0, 'Play pressed during the check did nothing, and the game waits for a press now');
  assert.deepEqual(f.checkTitles(), [['Skyrim folder', 'ok'], ['Skyrim version', 'ok'], ['Game files', 'ok'], ['Mod collection', 'ok']]);
  assert.equal(f.$('#checks-collection').hidden, true, 'Nothing to get when everything is installed');
  assert.deepEqual([f.play.disabled, f.play.textContent, f.$('#checks-again').disabled], [false, 'Play', false]);

  const error = "Could not read the server's file list: <b>timeout</b>";
  f.checkWith(async () => { f.state.lastCheck = { at: Date.now(), failed: true, error }; f.state.phase = { stage: 'failed', message: error }; return { success: false, error }; });
  f.$('#checks-again').click(); await settle();
  assert.deepEqual([f.text('#checks-title'), f.checkTitles()[0], f.checkTitles().at(-1)], ['1 thing worth a look', ['Game files', 'bad'], ['Everything else is fine', 'ok']], 'Problems first; what passed is one line');
  assert.equal(f.checkText('Everything else is fine'), 'Skyrim folder and Skyrim version.');
  assert.equal(f.d.querySelector('#checks-list b'), null);
  f.$('#checks-close').click();
  assert.deepEqual([f.notice.hidden, f.text('#notice-title'), f.text('#notice-text')], [false, 'Your game could not be checked', error]);
  assert.equal(f.d.querySelector('#notice b'), null);
  assert.equal(f.message.hidden, true, 'The error shows once, in the notice');
  f.checkWith(async () => { throw Error('IPC gone'); });
  assert.equal(f.play.textContent, 'Check again', 'The gold button carries the fix');
  f.play.click(); await settle();
  assert.equal(f.calls.check, 4, 'Check again in the notice runs a new check');
  assert.deepEqual([f.play.disabled, f.verify.disabled, f.$('#folder-change').disabled], [false, false, false], 'A thrown error never leaves the buttons stuck');
});

test('online fixes to mod files the server could not make show in the checklist with why, and never stop play', async t => {
  const hostile = '<img src=x onerror="window.executed=true">';
  const unfixed = [
    { fix: 'SKSE Menu Framework: its menu opens on F10 and does not pause the game', reason: 'the mod\'s file changed ("ToggleKey = F1" does not end its line there), so players get it as the mod ships it.' },
    { fix: hostile, reason: 'the mod\'s file changed.' }];
  const f = await fixture(t, { serverOnline: true, fileList: fileList() }, { check: async state => { state.lastCheck = passed({ unfixed }); return { success: true }; } });
  f.verify.click(); await settle();
  assert.deepEqual([f.text('#checks-title'), f.checkTitles()[0]], ['1 thing worth a look', ['Server mod fixes', 'warn']]);
  assert.equal(f.checkText('Server mod fixes'), 'The server could not make 2 of its online fixes to mod files, so players do not get those fixes. You can still play.');
  assert.deepEqual([...f.d.querySelectorAll('#checks-list .check-list li span')].map(s => s.textContent), [
    'SKSE Menu Framework: its menu opens on F10 and does not pause the game. The mod\'s file changed ("ToggleKey = F1" does not end its line there), so players get it as the mod ships it.',
    `${hostile}. The mod's file changed.`]);
  assert.equal(f.d.querySelector('#checks-list img'), null); assert.equal(f.w.executed, undefined);
  assert.deepEqual([f.play.disabled, f.play.textContent], [false, 'Play'], 'nothing stops play');
  // The main screen says so too, until it is sorted, and See details opens the list
  f.$('#checks-close').click();
  assert.deepEqual([f.notice.hidden, f.notice.className, f.text('#notice-title'), f.text('#notice-text'), f.text('#notice-primary')],
    [false, 'notice notice--warn', '2 mod fixes could not be made', 'Players do not get them until they are sorted. You can still play.', 'See details']);
  f.$('#notice-primary').click(); await settle();
  assert.equal(f.checks.hidden, false);
  // One fix, said as one; none once it is sorted
  f.checkWith(async state => { state.lastCheck = passed({ unfixed: unfixed.slice(0, 1) }); return { success: true }; });
  f.$('#checks-again').click(); await settle();
  assert.equal(f.checkText('Server mod fixes'), 'The server could not make one of its online fixes to mod files, so players do not get that fix. You can still play.');
  assert.deepEqual([f.text('#notice-title'), f.text('#notice-text')], ['A mod fix could not be made', 'Players do not get it until it is sorted. You can still play.']);
  f.checkWith(async state => { state.lastCheck = passed(); return { success: true }; });
  f.$('#checks-again').click(); await settle();
  assert.deepEqual([f.checkText('Server mod fixes'), f.notice.hidden], [undefined, true]);
});

const missingFiles = (missing, outdated = [], extra = []) => ({ blocked: false, collection: true, collectionName: 'Dovakarn',
  mods: [...(missing.length === 52 ? [{ name: 'Dovakarn collection, revision 3', missing: 0, changed: 0, critical: false, state: 'notInstalled', count: 52 }] : []), ...extra],
  collectionCheck: { revision: 3, total: 52, missing, outdated, domain: 'skyrimspecialedition' } });

test('a missing collection opens the checklist by itself, naming every mod with its Nexus page', async t => {
  const hostile = '<img src=x onerror="window.executed=true">';
  const missing = Array.from({ length: 52 }, (_, i) => ({ modId: 1000 + i, name: i === 0 ? hostile : `Mod ${i}` }));
  const message = 'The Dovakarn collection, revision 3, is not installed. Install it with Vortex, then check again. You can still play, but you may see problems.';
  let fixed = false;
  const f = await fixture(t, { serverOnline: true, fileList: fileList() }, { check: async state => {
    if (fixed) { state.files = null; state.lastCheck = passed(); state.phase = { stage: 'ready', message: 'Your game files match the server (219 files checked).' }; return { success: true }; }
    state.files = missingFiles(missing); state.lastCheck = passed({ collection: { revision: 3, total: 52, missing: 52, outdated: 0 } });
    state.phase = { stage: 'filesWarning', message }; return { success: false, error: message, canPlayAnyway: true };
  } });
  assert.equal(f.calls.check, 1);
  assert.equal(f.checks.hidden, false, 'The check on open finds the gap and opens the checklist by itself');
  assert.equal(f.text('#checks-title'), '1 thing worth a look');
  assert.deepEqual(f.checkTitles()[0], ['Mod collection', 'warn']);
  assert.equal(f.checkText('Mod collection'), 'Not installed. Install it with Vortex.');
  const names = [...f.d.querySelectorAll('#checks-list .check-list li span')].map(s => s.textContent);
  assert.equal(names.length, 52, 'Every missing mod is named, not a summary');
  assert.deepEqual([names[0], names[51]], [hostile, 'Mod 51']);
  assert.equal(f.d.querySelector('#checks-list img'), null);
  assert.equal(f.w.executed, undefined);
  assert.equal(f.d.activeElement.id, 'checks-collection', 'Focus starts on Get the collection');
  f.d.querySelectorAll('#checks-list button[data-mod]')[5].focus();
  const before = f.calls.state;
  await f.tick();
  assert.equal(f.calls.state, before + 1, 'The page refreshed');
  assert.equal(f.d.activeElement.dataset.mod, '1005', 'The list redraws on every refresh without losing keyboard focus');
  f.d.querySelectorAll('#checks-list button[data-mod]')[5].click(); await settle();
  assert.deepEqual(f.calls.mods, [1005]);
  f.$('#checks-collection').click(); await settle();
  assert.equal(f.calls.collection, 1);
  f.key(f.checks, 'Escape');
  assert.equal(f.checks.hidden, true);

  assert.deepEqual([f.notice.className, f.notice.dataset.kind, f.text('#notice-title'), f.text('#notice-text')],
    ['notice notice--warn', 'Mod collection', 'Install the Dovakarn collection', 'It has 52 mods. You need a free Nexus Mods account and Vortex: get the collection, press Add to Vortex and let it finish. The launcher checks again when you come back.']);
  assert.deepEqual([f.message.hidden, f.play.textContent], [true, 'Play anyway']);
  f.$('#notice-primary').click(); await settle();
  assert.equal(f.calls.collection, 2);
  f.$('#notice-secondary').focus();
  f.$('#notice-secondary').click();
  assert.equal(f.checks.hidden, false, "See what's missing reopens the list");
  f.$('#settings-open').click();
  assert.deepEqual([f.checks.hidden, f.settings.hidden], [true, false], 'Only one window at a time');
  assert.equal(f.$('#mods-details').hidden, false);
  f.$('#mods-details').click();
  assert.deepEqual([f.checks.hidden, f.settings.hidden], [false, true]);
  f.key(f.checks, 'Escape');
  assert.equal(f.d.activeElement.id, 'notice-secondary', 'Switching windows still returns focus to where it started');
  f.$('#notice-secondary').click();

  fixed = true;
  f.$('#checks-again').click(); await settle();
  assert.deepEqual([f.text('#checks-title'), f.checks.hidden, f.notice.hidden, f.play.textContent], ['All good', false, true, 'Play'], 'Once installed, the notice goes away');
});

test('the checklist lists outdated mods and server file problems, and a refused launch opens it', async t => {
  const f = await fixture(t, { serverOnline: true, fileList: fileList() }), d = f.d;
  const files = { ...missingFiles([{ modId: 7, name: 'TDM' }], [{ modId: 8, name: 'MCO' }],
    [{ name: 'TrueHUD', missing: 3, changed: 0, critical: true }]), blocked: true };
  f.launch(async () => {
    f.state.files = files; f.state.lastCheck = passed({ problems: 1, blocked: true, collection: { revision: 3, total: 52, missing: 1, outdated: 1 } });
    f.state.phase = { stage: 'filesBlocked', message: '1 mod is missing or out of date.' }; return { success: false, error: '1 mod is missing or out of date.' };
  });
  f.play.click(); await settle();
  assert.equal(f.checks.hidden, false);
  assert.equal(f.text('#checks-title'), '2 things worth a look');
  assert.deepEqual(f.checkTitles(), [['Game files', 'bad'], ['Mod collection', 'warn'], ['Everything else is fine', 'ok']]);
  const lists = [...d.querySelectorAll('#checks-list .check-list')].map(ul => [...ul.querySelectorAll('li span')].map(s => s.textContent));
  assert.deepEqual(lists, [['TrueHUD: 3 files missing'], ['TDM', 'MCO, a different version']]);
  assert.equal(f.checkText('Mod collection'), '2 mods missing or out of date. Update the collection in Vortex.');
  assert.deepEqual([...d.querySelectorAll('#checks-list button[data-mod]')].map(b => b.dataset.mod), ['7', '8'], 'Server file rows have no Nexus link');
  assert.equal(f.text('#notice-title'), 'Mods needed before you can play', 'Blocking beats the collection notice');
  f.$('#checks-close').focus(); f.key(f.d.activeElement, 'Tab');
  assert.equal(d.activeElement, d.querySelector('#checks-list button[data-mod="7"]'), 'Tab wraps inside the window');
  f.key(f.d.activeElement, 'Tab', true);
  assert.equal(d.activeElement.id, 'checks-close', 'Shift+Tab wraps back');
});

test('the Skyrim folder is chosen in Settings, and a missing or wrong Skyrim is the first thing shown', async t => {
  const f = await fixture(t, { serverOnline: true });
  assert.equal(f.text('#folder-path'), SKYRIM);
  assert.deepEqual([...f.d.querySelectorAll('#folder-ticks li')].map(li => [li.textContent, li.className]), [['SkyrimSE.exe 1.6.1170.0', 'ok'], ['Script extender', 'ok']]);
  const checksBefore = f.calls.check;
  f.$('#folder-change').click(); await settle();
  assert.deepEqual([f.calls.folder, f.calls.check, f.message.className], [['choose'], checksBefore, ''], 'A cancelled picker changes nothing');
  f.pickWith(async () => ({ success: false, error: 'There is no SkyrimSE.exe in that folder.' }));
  f.$('#folder-change').click(); await settle();
  assert.deepEqual([f.message.textContent, f.message.className, f.calls.check], ['There is no SkyrimSE.exe in that folder.', 'error', checksBefore]);
  await f.tick();
  assert.deepEqual([f.message.textContent, f.message.className], ['There is no SkyrimSE.exe in that folder.', 'error'], 'The refusal stays through the 2 second refresh');
  let finish;
  f.checkWith(() => new Promise(resolve => { finish = resolve; }));
  f.pickWith(async () => { f.state.gameFolder = { ...goodFolder, path: 'D:\\Skyrim' }; return { success: true }; });
  f.$('#folder-change').click(); await settle();
  assert.equal(f.calls.check, checksBefore + 1, 'The new folder is checked straight away');
  assert.deepEqual([f.message.textContent, f.message.className], ['Ready to launch.', ''], 'A folder that works clears the refusal at once');
  assert.equal(f.text('#folder-path'), 'D:\\Skyrim');
  finish({ success: true }); await settle();
  f.verify.click();
  assert.equal(f.$('#folder-change').disabled, true, 'The folder cannot change mid-check');
  finish({ success: true }); await settle();
  assert.equal(f.$('#folder-change').disabled, false);

  const gone = await fixture(t, { lastCheck: passed(), gameFolder: { path: 'D:\\Old Skyrim', exe: false, version: '', versionOk: false, required: '1.6.1170.0', skse: false } });
  assert.deepEqual([gone.notice.className, gone.text('#notice-title'), gone.text('#notice-text'), gone.play.textContent, gone.$('#notice-primary').hidden],
    ['notice notice--bad', 'Skyrim was not found', 'There is no SkyrimSE.exe in D:\\Old Skyrim.', 'Choose Skyrim folder', true], 'The gold button carries the fix, once');
  assert.deepEqual([...gone.d.querySelectorAll('#folder-ticks li')].map(li => [li.textContent, li.className]), [['SkyrimSE.exe missing', 'bad'], ['Script extender missing', 'bad']]);
  gone.verify.click(); await settle();
  assert.deepEqual(gone.checkTitles()[0], ['Skyrim folder', 'bad'], 'The problem comes first');
  assert.equal(gone.checkTitles().some(([title]) => title === 'Skyrim version'), false, 'No version line without a game');
  gone.$('#checks-close').click();
  gone.play.click(); await settle();
  assert.deepEqual(gone.calls.folder, ['choose']);

  // Not Steam's edition: nothing to switch it with, so the fix is another folder
  const wrong = await fixture(t, { gameFolder: { ...goodFolder, version: '1.6.1179.0', versionOk: false, steam: false } });
  assert.deepEqual([wrong.text('#notice-title'), wrong.text('#notice-text')], ['This Skyrim is the wrong version', 'It is 1.6.1179.0. Dovakarn needs the Steam edition of Skyrim Special Edition, version 1.6.1170.']);
  wrong.verify.click(); await settle();
  assert.deepEqual([wrong.checkTitles()[0], wrong.play.textContent], [['Skyrim version', 'bad'], 'Choose Skyrim folder']);
  assert.equal(wrong.$('#folder-switch-row').hidden, true);
  const noSkse = await fixture(t, { gameFolder: { ...goodFolder, skse: false } });
  noSkse.verify.click(); await settle();
  assert.deepEqual(noSkse.checkTitles()[0], ['Skyrim folder', 'warn']);
  assert.match(noSkse.d.querySelector('#checks-list > li p').textContent, /skse64_loader\.exe/);
});

test('the main screen stays quiet unless something is wrong, even after an update', async t => {
  const newer = fileList({ label: 'v0.2.0', tag: 'v0.2.0', ahead: 0, commit: 'aaaaaaaa', date: '2026-02-01T00:00:00Z', modified: false });
  const updated = await fixture(t, { fileList: newer, phase: { stage: 'ready', message: 'Your game files match the server (577 files checked).' },
    lastCheck: passed({ updated: 2, patched: 1, collection: { revision: 4, total: 52, missing: 0, outdated: 0 } }) });
  assert.equal(updated.notice.hidden, true, 'A new release or collection revision that is already installed needs nothing from the player');
  assert.deepEqual([updated.message.hidden, updated.message.textContent], [false, 'Your game files match the server (577 files checked).']);
  assert.equal(updated.w.localStorage.length, 0, 'Nothing is remembered between sessions');
  const broken = await fixture(t, { fileList: newer, lastCheck: { at: Date.now(), failed: true, error: 'timeout' } });
  assert.equal(broken.text('#notice-title'), 'Your game could not be checked', 'A problem always shows');
  assert.deepEqual([broken.text('#notice-text'), broken.message.textContent, broken.message.hidden], ['timeout', 'Ready to launch.', false],
    'The notice keeps the check error while the status line moves on');
  assert.equal(broken.$('.notice-actions').hidden, false, 'and comes with its buttons');
});

test('launcher mist and background video are decorative and pause while the page is hidden', async t => {
  const f = await fixture(t), d = f.w.document;
  const sky = d.querySelector('video.atmosphere'), media = [];
  assert.ok(sky, 'The launcher has a background video');
  assert.deepEqual([sky.muted || sky.hasAttribute('muted'), sky.loop, sky.autoplay, sky.getAttribute('aria-hidden')], [true, true, true, 'true']);
  for (const src of [sky.getAttribute('src'), sky.getAttribute('poster')]) assert.ok(fs.statSync(path.join(renderer, src)).size > 10000, src + ' ships with the launcher');
  const faces = fs.readFileSync(path.join(renderer, 'local-play.css'), 'utf8').match(/@font-face\{font-family:Sovngarde;[^}]*\}/g) || [];
  assert.deepEqual(faces.map(face => /font-display:block/.test(face)), [true, true], 'Text waits the few ms for the bundled Sovngarde instead of showing Georgia first');
  sky.pause = () => media.push('pause');
  sky.play = () => { media.push('play'); return Promise.resolve(); };
  f.w.eval(fs.readFileSync(path.join(renderer, 'local-play-effects.js'), 'utf8'));
  assert.deepEqual(media, [d.hidden ? 'pause' : 'play'], 'The first state is applied as soon as the page loads');
  media.length = 0;
  assert.equal(d.querySelector('.mist').getAttribute('aria-hidden'), 'true');
  assert.equal(d.querySelectorAll('.mist i').length, 3);
  assert.equal(d.querySelector('.journey .mist'), null);
  for (const hidden of [false, true, false]) {
    Object.defineProperty(d, 'hidden', { configurable: true, get: () => hidden });
    d.dispatchEvent(new f.w.Event('visibilitychange'));
    assert.equal(d.documentElement.getAttribute('data-motion-paused'), String(hidden));
    assert.equal(sky.dataset.playing, String(!hidden));
  }
  assert.deepEqual(media, ['play', 'pause', 'play'], 'The video stops while the window is hidden and starts again when it is shown');
  f.w.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  d.dispatchEvent(new f.w.Event('visibilitychange'));
  assert.deepEqual([media.at(-1), sky.dataset.playing], ['pause', 'false'], 'Reduced motion keeps the still picture');
  assert.equal(f.calls.play, 0);
  assert.equal(f.calls.close, 0);
});

test("a missing file row links to its mod on Nexus", async t => {
  const f = await fixture(t, { serverOnline: true, fileList: fileList(), phase: { stage: "filesBlocked", message: "x" },
    files: { blocked: true, collection: true, collectionName: "Dovakarn", mods: [{ name: "Engine Fixes - SKSE64 Preloader", missing: 1, changed: 0, critical: true, nexusId: 17230 }] },
    lastCheck: passed({ problems: 1, blocked: true }) });
  f.$("#notice-secondary").click();
  const button = f.d.querySelector("#checks-list button[data-mod]");
  assert.deepEqual([button.dataset.mod, button.title, button.getAttribute("aria-label")], ["17230", "Open Engine Fixes - SKSE64 Preloader: 1 file missing on Nexus Mods", "Open Engine Fixes - SKSE64 Preloader: 1 file missing on Nexus Mods"], "Each Nexus button is named for screen readers");
  button.click(); await settle();
  assert.deepEqual(f.calls.mods, [17230]);
});

const hadvar = { number: 12, discordId: '333333333333333333', name: 'Hadvar', username: 'hadvar', avatar: 'https://cdn.discordapp.com/avatars/333333333333333333/abc.png?size=128', member: true, pending: false, banned: false, banReason: '', staff: 'admin', slots: 4 };
const discordServer = (extra = {}) => ({ discord: true, loggedIn: false, account: null, pending: false, error: null, testProfile: 1, ...extra });

test('with Discord login, the top bar and the main button log the player in, then show who is logged in', async t => {
  const f = await fixture(t, { lastCheck: passed(), login: discordServer() });
  assert.deepEqual([f.$('#account').hidden, f.$('#account-login').hidden, f.$('#account-chip').hidden, f.$('#account-waiting').hidden], [false, false, true, true]);
  assert.match(f.text('#account-login'), /Log in with Discord/);
  assert.deepEqual([f.notice.hidden, f.text('#notice-title'), f.$('#notice-primary').hidden, f.notice.className], [false, 'Log in with Discord to play', true, 'notice notice--info'], 'The card explains; the gold button and the top bar log in');
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Log in with Discord', false], 'The main button is the login until the player logs in');
  let finish;
  f.loginWith(state => new Promise(resolve => { finish = () => { state.login = discordServer({ loggedIn: true, account: hadvar }); resolve({ success: true, state: state.login }); }; }));
  f.play.click();
  assert.deepEqual([f.calls.account.filter(c => c === 'login').length, f.calls.play], [1, 0], 'Pressing it starts the Discord login, never the game');
  assert.deepEqual([f.play.disabled, f.play.textContent, f.$('#account-waiting').hidden, f.$('#account-login').hidden], [true, 'Waiting for Discord...', false, true]);
  f.play.click(); f.$('#account-login').click();
  assert.equal(f.calls.account.filter(c => c === 'login').length, 1, 'One browser login at a time');
  finish(); await settle(); await settle();
  assert.deepEqual([f.$('#account-chip').hidden, f.text('#account-name'), f.text('#account-number'), f.text('#account-badge'), f.$('#account-badge').hidden], [false, 'Hadvar', '#12', 'Admin', false]);
  assert.equal(f.$('#account-avatar').getAttribute('src'), hadvar.avatar);
  assert.match(f.$('#account-chip').title, /Logged in with Discord as Hadvar\. Dovakarn account #12\./);
  assert.deepEqual([f.notice.hidden, f.play.textContent, f.play.disabled], [true, 'Play', false]);
  assert.equal(f.message.textContent, 'Logged in as Hadvar, Dovakarn account #12.');
  f.play.click(); await settle();
  assert.equal(f.calls.play, 1, 'Once logged in, the button launches');
});

test('the Account tab shows the Discord account, and Log out and Cancel work', async t => {
  const f = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: hadvar }) });
  f.$('#account-chip').click();
  assert.deepEqual([f.settings.hidden, f.$('#tab-account').hidden, f.$('#tab-account-button').getAttribute('aria-selected'), f.d.activeElement.id], [false, false, 'true', 'tab-account-button']);
  assert.deepEqual([f.text('#account-card-name'), f.text('#account-card-line'), f.text('#account-fact-number'), f.text('#account-fact-member'), f.text('#account-fact-staff'), f.text('#account-fact-slots')],
    ['Hadvar', '@hadvar on Discord', '#12', 'Member', 'Admin', 'Up to 4']);
  assert.deepEqual([f.$('#account-logout').hidden, f.$('#account-discord').hidden, f.$('#account-settings-login').hidden], [false, false, true]);
  f.$('#account-discord').click(); await settle();
  f.$('#account-logout').click(); await settle(); await settle();
  assert.deepEqual(f.calls.account.filter(c => c !== 'refresh'), ['discord', 'logout']);
  assert.deepEqual([f.$('#account-card').hidden, f.$('#account-settings-login').hidden, f.$('#account-chip').hidden, f.$('#account-login').hidden], [true, false, true, false]);
  assert.equal(f.message.textContent, 'Logged out of Dovakarn on this PC.');

  const waiting = await fixture(t, { lastCheck: passed(), login: discordServer({ pending: true }) });
  assert.deepEqual([waiting.$('#account-waiting').hidden, waiting.play.disabled, waiting.play.textContent], [false, true, 'Waiting for Discord...']);
  assert.equal(waiting.notice.hidden, true, 'No login notice while the browser login runs');
  waiting.$('#account-cancel').click(); await settle(); await settle();
  assert.deepEqual([waiting.calls.account.includes('cancel'), waiting.$('#account-waiting').hidden, waiting.play.textContent], [true, true, 'Log in with Discord']);

  const cancelled = await fixture(t, { lastCheck: passed(), login: discordServer() });
  cancelled.loginWith(async state => { state.login = discordServer(); return { success: false, code: 'cancelled', error: 'Login cancelled.' }; });
  cancelled.$('#account-login').click(); await settle(); await settle();
  assert.notEqual(cancelled.message.className, 'error', 'A cancel is not an error');
  const failed = await fixture(t, { lastCheck: passed(), login: discordServer() });
  failed.loginWith(async state => { state.login = discordServer(); return { success: false, code: 'loginNotConfigured', error: 'Discord login is not set up on this server yet. Ask the server owner.' }; });
  failed.$('#account-login').click(); await settle(); await settle();
  assert.deepEqual([failed.message.textContent, failed.message.className], ['Discord login is not set up on this server yet. Ask the server owner.', 'error']);
});

test('not in the Discord, rules not accepted, or banned: one plain notice says what to do', async t => {
  const outsider = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, member: false, staff: null } }) });
  assert.deepEqual([outsider.text('#notice-title'), outsider.text('#notice-primary'), outsider.$('#notice-secondary').hidden, outsider.play.textContent], ['Join the Dovakarn Discord', 'Check again', true, 'Join the Dovakarn Discord']);
  assert.equal(outsider.$('#account-badge').hidden, true, 'No staff badge for players');
  outsider.play.click(); await settle();
  outsider.$('#notice-primary').click(); await settle();
  assert.deepEqual(outsider.calls.account.filter(c => c !== 'refresh'), ['discord', 'refresh-fresh']);

  const rules = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, pending: true } }) });
  assert.equal(rules.text('#notice-title'), 'Finish the Discord rules screen');

  const hostile = '<img src=x onerror="window.executed=true">griefing';
  const banned = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, banned: true, banReason: hostile } }) });
  assert.deepEqual([banned.text('#notice-title'), banned.text('#notice-text'), banned.play.textContent, banned.play.disabled], ['You are banned from Dovakarn', hostile, 'Banned from Dovakarn', true], 'Nothing to press that would only be refused');
  assert.equal(banned.d.querySelector('#notice img'), null);
  assert.equal(banned.w.executed, undefined);
});

test('an offline test server shows no account area, and only Discord pictures are shown', async t => {
  const offline = await fixture(t, { lastCheck: passed(), login: { discord: false, loggedIn: false, account: null, pending: false, error: null, testProfile: 2 } });
  assert.equal(offline.$('#account').hidden, true);
  offline.$('#settings-open').click(); offline.$('#tab-account-button').click();
  assert.equal(offline.text('#account-note'), 'This test server runs without Discord login, so this launcher plays as test profile 2.');
  assert.deepEqual([offline.$('#account-settings-login').hidden, offline.$('#account-discord').hidden, offline.$('#account-logout').hidden], [true, true, true]);

  const odd = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, avatar: 'https://evil.example/tracker.png' } }) });
  assert.deepEqual([odd.$('#account-avatar').hidden, odd.$('#account-avatar').getAttribute('src')], [true, null], 'A picture from anywhere else is never loaded');
  const csp = odd.d.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.match(csp, /img-src 'self' https:\/\/cdn\.discordapp\.com;/, 'The page may load images from Discord\'s image server and nowhere else');
});

const outsider = { ...hadvar, member: false, staff: null };
const clockAt = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const recheck = async f => { f.$('#notice-primary').click(); await settle(); await settle(); };

test('Check again says what Discord answered, and the line stays until the launcher has news', async t => {
  const f = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  await recheck(f);
  assert.match(f.message.textContent, /^Checked with the Dovakarn Discord at .+: @hadvar is not in it yet\.$/, 'Names the Discord account, in case it is the wrong one');
  assert.deepEqual([f.message.hidden, f.message.className, f.notice.hidden, f.text('#notice-title')], [false, '', false, 'Join the Dovakarn Discord']);
  await f.tick();
  assert.match(f.message.textContent, /@hadvar is not in it yet\.$/, 'The 2 second refresh does not wipe it');
  f.progress({ stage: 'ready', message: 'Ready to launch.' });
  assert.equal(f.message.textContent, 'Ready to launch.', 'Anything the launcher says next replaces it, even the line it showed before');
  await f.tick();
  assert.equal(f.message.textContent, 'Ready to launch.', 'and it does not come back');

  const joined = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  joined.recheckWith(async state => { state.login = discordServer({ loggedIn: true, account: hadvar }); return { ...state.login, reached: true, membershipError: null, membershipAge: 0, askAgainIn: 0 }; });
  await recheck(joined);
  assert.match(joined.message.textContent, /^Checked with the Dovakarn Discord at .+: you are a member\.$/);
  assert.deepEqual([joined.notice.hidden, joined.play.textContent, joined.play.disabled], [true, 'Play', false]);

  const rules = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, pending: true } }) });
  await recheck(rules);
  assert.match(rules.message.textContent, /^Checked with the Dovakarn Discord at .+: the rules screen is not finished yet\.$/);

  // Pressed twice in quick succession: the server gives Discord's earlier answer (here an hour old, so the time shown
  // can only come from its age), and says when Discord can be asked again
  const quick = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  quick.recheckWith(async state => ({ ...state.login, reached: true, membershipError: null, membershipAge: 3600, askAgainIn: 10 }));
  const before = clockAt(Date.now() - 3600 * 1000);
  await recheck(quick);
  const after = clockAt(Date.now() - 3600 * 1000);
  assert.ok([before, after].some(time => quick.message.textContent === `Checked with the Dovakarn Discord at ${time}: @hadvar is not in it yet. Press Check again in 10 seconds to ask Discord again.`), quick.message.textContent);
});

test('Check again says when the server or Discord could not answer, even under the Discord notice', async t => {
  const unreachable = 'The Dovakarn server could not be reached. Check your internet connection, or try again in a minute.';
  const down = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  down.recheckWith(async state => ({ ...state.login, reached: false, problem: unreachable }));
  await recheck(down);
  assert.deepEqual([down.message.textContent, down.message.className, down.message.hidden, down.text('#notice-title')], [unreachable, 'error', false, 'Join the Dovakarn Discord']);
  await down.tick();
  assert.deepEqual([down.message.textContent, down.message.className], [unreachable, 'error'], 'It stays through the refresh');

  const discordDown = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  discordDown.recheckWith(async state => { state.login = discordServer({ loggedIn: true, account: { ...outsider, member: null } }); return { ...state.login, reached: true, membershipError: 'Discord answered 503', membershipAge: null, askAgainIn: 0 }; });
  await recheck(discordDown);
  assert.deepEqual([discordDown.message.textContent, discordDown.message.className, discordDown.message.hidden], ['Your Discord membership could not be checked right now. Try again in a minute.', 'error', false]);
  discordDown.$('#account-chip').click();
  assert.equal(discordDown.text('#account-fact-member'), 'Could not check right now');

  // The login ended meanwhile: the Log in notice says so, and nothing claims a check happened
  const ended = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  ended.recheckWith(async state => { state.login = discordServer({ error: 'Your Dovakarn login has ended. Log in with Discord again.' }); return { ...state.login, reached: false, problem: 'Log in with Discord again.' }; });
  await recheck(ended);
  assert.deepEqual([ended.text('#notice-title'), ended.text('#notice-text'), ended.play.textContent], ['Log in with Discord to play', 'Your Dovakarn login has ended. Log in with Discord again.', 'Log in with Discord']);
  assert.doesNotMatch(ended.message.textContent, /Checked with|Log in with Discord again\./);

  // Open the Discord failing (no web browser) says so instead of doing nothing
  const noBrowser = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  noBrowser.discordWith(async () => ({ success: false, error: 'The launcher could not open your web browser. Set a default browser in Windows settings, then try again.' }));
  noBrowser.play.click(); await settle();
  assert.deepEqual([noBrowser.message.textContent, noBrowser.message.className, noBrowser.message.hidden], ['The launcher could not open your web browser. Set a default browser in Windows settings, then try again.', 'error', false]);
});

test('an account refusal steps aside only for the notice that already explains it', async t => {
  const banned = await fixture(t, { lastCheck: passed(), phase: { stage: 'account', message: 'You are banned: griefing' }, login: discordServer({ loggedIn: true, account: { ...hadvar, banned: true, banReason: 'griefing' } }) });
  assert.deepEqual([banned.text('#notice-title'), banned.message.hidden], ['You are banned from Dovakarn', true], 'The ban notice already says it');
  // A ban this launcher's copy of the account does not show yet, under an unrelated mods notice
  const mods = await fixture(t, { lastCheck: passed({ problems: 2 }), phase: { stage: 'account', message: 'You are banned: griefing' }, login: discordServer({ loggedIn: true, account: hadvar }) });
  assert.deepEqual([mods.text('#notice-title'), mods.message.hidden, mods.message.textContent], ['Some mod files differ from the server', false, 'You are banned: griefing']);
  // Not something the notice explains (the launcher records these as failures): shown under the Discord notice
  const busy = 'The server could not check your Discord membership right now. Try again in a minute.';
  const out = await fixture(t, { lastCheck: passed(), phase: { stage: 'failed', message: busy }, login: discordServer({ loggedIn: true, account: outsider }) });
  assert.deepEqual([out.text('#notice-title'), out.message.hidden, out.message.textContent], ['Join the Dovakarn Discord', false, busy]);
  // No Discord membership needed on this server: no join notice at all
  const open = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...outsider, requireMembership: false } }) });
  assert.deepEqual([open.notice.hidden, open.play.textContent, open.play.disabled], [true, 'Play', false]);
});

test('logged out, the main button stays the Discord login while a check runs', async t => {
  let finish;
  const f = await fixture(t, { login: discordServer() }, { check: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(f.calls.check, 1, 'The check on open is running');
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Log in with Discord', false], 'Never "Checking...": logging in works during the check');
  f.loginWith(async state => { state.login = discordServer({ loggedIn: true, account: hadvar }); return { success: true, state: state.login }; });
  f.play.click(); await settle(); await settle();
  assert.deepEqual([f.calls.account.filter(c => c === 'login').length, f.calls.play], [1, 0]);
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Checking game files...', true], 'Logged in, the button waits for the check');
  f.play.click();
  f.state.lastCheck = passed(); finish({ success: true }); await settle();
  assert.deepEqual([f.play.textContent, f.play.disabled, f.calls.play], ['Play', false, 0], 'Play is ready once the check passed');

  const shortcut = await fixture(t, { busy: true, login: discordServer() });
  assert.deepEqual([shortcut.play.textContent, shortcut.play.disabled], ['Log in with Discord', false], 'Also while a Play shortcut prepares Skyrim');
  const preparing = await fixture(t, { busy: true, login: discordServer({ loggedIn: true, account: hadvar }) });
  assert.deepEqual([preparing.play.textContent, preparing.play.disabled], ['Preparing Skyrim...', true]);
});

test('keyboard focus follows the account buttons, and the chip is named for screen readers', async t => {
  let finish;
  const waitForDiscord = f => f.loginWith(state => new Promise(resolve => { finish = ok => { state.login = ok ? discordServer({ loggedIn: true, account: hadvar }) : discordServer(); resolve(ok ? { success: true, state: state.login } : { success: false, code: 'cancelled', error: 'Login cancelled.' }); }; }));
  const f = await fixture(t, { lastCheck: passed(), login: discordServer() });
  waitForDiscord(f);
  f.$('#account-login').focus(); f.$('#account-login').click();
  assert.equal(f.d.activeElement.id, 'account-cancel', 'Log in hides itself, so focus moves to Cancel');
  finish(true); await settle(); await settle();
  assert.equal(f.d.activeElement.id, 'account-chip', 'Logged in: focus lands on the account chip');
  assert.equal(f.$('#account-chip').getAttribute('aria-label'), 'Logged in with Discord as Hadvar, Dovakarn account #12, Admin. Open account settings.');

  const cancelled = await fixture(t, { lastCheck: passed(), login: discordServer() });
  waitForDiscord(cancelled);
  cancelled.$('#account-login').focus(); cancelled.$('#account-login').click();
  cancelled.$('#account-cancel').click(); finish(false); await settle(); await settle();
  assert.equal(cancelled.d.activeElement.id, 'account-login', 'Cancelled: focus returns to Log in');

  const main = await fixture(t, { lastCheck: passed(), login: discordServer() });
  waitForDiscord(main);
  main.play.focus(); main.play.click();
  assert.equal(main.d.activeElement.id, 'account-cancel', 'From the main button, which now waits, focus goes to Cancel');

  const inSettings = await fixture(t, { lastCheck: passed(), login: discordServer() });
  waitForDiscord(inSettings);
  inSettings.$('#settings-open').click(); inSettings.$('#tab-account-button').click();
  inSettings.$('#account-settings-login').focus(); inSettings.$('#account-settings-login').click();
  assert.deepEqual([inSettings.$('#account-settings-login').hidden, inSettings.d.activeElement.id, inSettings.text('#account-note')],
    [true, 'tab-account-button', 'Finish logging in with Discord in your browser. This window updates by itself. If Discord shows an error page instead, press Cancel and tell the server owner.'], 'In Settings, focus moves to the Account tab');
  finish(true); await settle(); await settle();
  inSettings.$('#account-logout').focus(); inSettings.$('#account-logout').click(); await settle(); await settle();
  assert.equal(inSettings.d.activeElement.id, 'account-settings-login', 'Logged out: focus moves to Log in');

  const player = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, staff: null } }) });
  assert.equal(player.$('#account-chip').getAttribute('aria-label'), 'Logged in with Discord as Hadvar, Dovakarn account #12. Open account settings.');

  // The login card only explains: the main button logs in, the card goes while the browser is open, and focus goes
  // to Cancel
  const fromNotice = await fixture(t, { lastCheck: passed(), login: discordServer() });
  waitForDiscord(fromNotice);
  assert.equal(fromNotice.$('#notice-primary').hidden, true);
  fromNotice.play.focus(); fromNotice.play.click();
  assert.deepEqual([fromNotice.notice.hidden, fromNotice.play.disabled, fromNotice.d.activeElement.id], [true, true, 'account-cancel']);
  // Discord shows its own error page when the server's login is set up wrong: the player is told what to do then
  assert.equal(fromNotice.message.textContent, 'Finish logging in with Discord in your browser. If Discord shows an error page there instead, press Cancel and tell the server owner.');
  fromNotice.$('#account-cancel').click(); finish(false); await settle(); await settle();
  assert.deepEqual([fromNotice.notice.hidden, fromNotice.text('#notice-title'), fromNotice.play.textContent], [false, 'Log in with Discord to play', 'Log in with Discord'], 'Cancelled: the card is back');
  assert.deepEqual([fromNotice.message.textContent, fromNotice.message.className], ['Discord login cancelled.', ''], 'said plainly, not as an error');

  // A notice button whose notice goes away hands focus to the main button
  const notice = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: outsider }) });
  notice.recheckWith(async state => { state.login = discordServer({ loggedIn: true, account: hadvar }); return { ...state.login, reached: true, membershipError: null, membershipAge: 0, askAgainIn: 0 }; });
  notice.$('#notice-primary').focus();
  await recheck(notice);
  assert.deepEqual([notice.notice.hidden, notice.d.activeElement.id], [true, 'play']);
});

test('the account is asked of the server as soon as the launcher opens', async t => {
  const f = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: hadvar }) });
  await settle(); await settle();
  assert.ok(f.calls.account.includes('refresh'), 'not after five minutes');
  const offline = await fixture(t, { lastCheck: passed(), login: { discord: false, loggedIn: false, account: null, pending: false, error: null, testProfile: 1 } });
  await settle(); await settle();
  assert.deepEqual(offline.calls.account, [], 'a server without Discord login is not asked');
});

test('while Skyrim runs the main button only says so, and never starts a Discord login', async t => {
  const f = await fixture(t, { gameRunning: true, lastCheck: passed(), login: discordServer() });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Skyrim is running', true]);
  f.play.click(); await settle();
  assert.deepEqual(f.calls.account.filter(c => c === 'login'), []);
  assert.equal(f.$('#account-login').hidden, false, 'logging in stays in the top bar');
});

test('a linked ban says the PC or network is blocked, and the rules screen counts only when the Discord is required', async t => {
  const linked = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, banned: true, banLinked: true, banReason: 'This PC or network is linked to a banned account.' } }) });
  assert.deepEqual([linked.text('#notice-title'), linked.text('#notice-text')], ['This PC or network is blocked', 'This PC or network is linked to a banned account.']);
  const rules = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, pending: true, requireMembership: false } }) });
  assert.deepEqual([rules.notice.hidden, rules.play.textContent], [true, 'Play']);
});

test('while the browser login waits, the status line keeps saying what to do if Discord shows an error page', async t => {
  let finish;
  const f = await fixture(t, { lastCheck: passed(), login: discordServer() });
  f.loginWith(state => new Promise(resolve => { finish = () => { state.login = discordServer(); resolve({ success: false, code: 'cancelled', error: 'Login cancelled.' }); }; }));
  const waiting = 'Finish logging in with Discord in your browser. If Discord shows an error page there instead, press Cancel and tell the server owner.';
  f.$('#account-login').click(); await settle();
  assert.equal(f.message.textContent, waiting);
  // A check's progress does not push it away
  f.progress({ stage: 'checking', message: 'Checking your game files against the server...' });
  f.progress({ stage: 'ready', message: 'All 219 files match the server.' });
  assert.equal(f.message.textContent, waiting);
  // A problem still shows
  f.progress({ stage: 'failed', message: 'The server could not start.' });
  assert.deepEqual([f.message.textContent, f.message.className], ['The server could not start.', 'error']);
  finish(); await settle(); await settle();
  assert.notEqual(f.message.textContent, waiting, 'gone once the browser login is over');
});

test('what a browser login came to shows at once, before the launcher has sent its state again', async t => {
  const f = await fixture(t, { lastCheck: passed(), login: discordServer() });
  // Over the real bridge the page holds a copy of the launcher's state, and here the next copy is slow to come
  let slow = null;
  const real = f.w.localPlay.state;
  f.w.localPlay.state = async () => { if (slow) await slow; return structuredClone(await real()); };
  await f.tick(); await settle();
  let release;
  slow = new Promise(resolve => { release = resolve; });
  f.loginWith(state => { state.login = discordServer({ loggedIn: true, account: hadvar }); return Promise.resolve({ success: true, state: state.login }); });
  f.play.click(); await settle();
  assert.equal(f.message.textContent, 'Logged in as Hadvar, Dovakarn account #12.', 'not still "finish logging in" while the state is on its way');
  release(); await settle(); await settle();
  assert.equal(f.message.textContent, 'Logged in as Hadvar, Dovakarn account #12.');
});

// Online mode: the same page pointed at the Dovakarn server. The words change, the layout does not.
test('online, the page names Dovakarn, counts players without names, and says when the server is not answering', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true,
    server: { name: 'Dovakarn', address: 'dovakarn.com', uptime: null, players: [], count: 3, max: 20 } });
  assert.equal(f.text('#world-name'), 'Dovakarn');
  assert.equal(f.text('#window-mode'), '', 'Online, the brand stands alone');
  assert.equal(f.text('#footer-world'), 'dovakarn.com');
  assert.equal(f.server.textContent, 'Server running');
  assert.deepEqual([f.text('#population-now'), f.text('#population-max')], ['3', '20']);
  f.$('#settings-open').click();
  assert.deepEqual([f.text('#server-name'), f.text('#server-address')], ['Dovakarn', 'dovakarn.com']);
  assert.equal(f.text('#server-players'), '3 players in the world');
  assert.equal(f.text('#server-status'), 'Running');
  // The heartbeat stops answering: said as that, never as "starts when you launch"
  f.state.serverOnline = false;
  f.state.server = { name: 'Dovakarn', address: 'dovakarn.com', uptime: null, players: [], count: 0, max: 20 };
  await f.tick(); await settle();
  assert.equal(f.server.textContent, 'Server not answering right now');
  assert.equal(f.text('#server-status'), 'Not answering right now');
  assert.equal(f.$('#population').hidden, true);
  assert.doesNotMatch(f.d.body.textContent, /This PC only|starts when you launch|Test launcher/, 'No local-test wording online');
});

test('the local test keeps its own wording on the shared page', async t => {
  const f = await fixture(t);
  assert.equal(f.text('#world-name'), 'Dovakarn-Local-Test');
  assert.equal(f.text('#window-mode'), 'Test launcher');
  assert.equal(f.text('#footer-world'), 'Private world · This PC only');
  f.$('#settings-open').click();
  assert.deepEqual([f.text('#server-name'), f.text('#server-address')], ['Dovakarn-Local-Test', 'This PC · 127.0.0.1:7780']);
});

// Launcher self-update, from the Updates tab: offered when the server names a newer installer, silent otherwise.
test('a launcher update is offered, installed on one press, and its progress shows; failures free the button', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.updateCheck, 1, 'checked once when the page opens');
  assert.equal(f.$('#updates-available').hidden, true, 'an up-to-date launcher says nothing uninvited');
  assert.equal(f.$('#updates-install').hidden, true);
  // The server now names a newer version: the Updates tab says so, and so does the main screen
  f.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: false, downloadUrl: 'https://dovakarn.com/x' }));
  f.$('#updates-launcher-check').click(); await settle();
  assert.equal(f.calls.updateDownload, 1, 'a found update downloads itself, unasked');
  assert.match(f.text('#updates-available'), /^Launcher version 2\.2\.0 is downloaded and checked/);
  assert.equal(f.$('#updates-install').hidden, false);
  assert.equal(f.notice.hidden, false, 'an update speaks up on the main screen, not only in a tab');
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title')], ['Launcher', 'Launcher 2.2.0 is ready']);
  assert.equal(f.play.textContent, 'Update launcher', 'the main button installs the downloaded release');
  // Both updates pending share one card that names the order, and the button still leads with the launcher
  f.state.filesUpdate = { needed: true, revision: 'r2' }; await f.tick();
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title')], ['Updates', 'A launcher and game files are ready']);
  assert.equal(f.play.textContent, 'Update launcher');
  f.state.filesUpdate = null; await f.tick();
  assert.equal(f.play.disabled, false);
  // There is no Not now: nobody plays on an outdated launcher, so the only way forward is the update
  assert.equal(f.$('#notice-secondary').hidden, true, 'no way to wave the update aside');
  assert.equal(f.$('#updates-install').hidden, false);
  // Install: one press, progress lines, then the launcher restarts itself (nothing more to press)
  let finish; f.installWith(() => new Promise(resolve => { finish = resolve; }));
  f.$('#updates-install').click(); await settle();
  assert.equal(f.calls.updateInstall, 1);
  assert.equal(f.$('#updates-install').disabled, true, 'no second press while it runs');
  f.updateProgress({ phase: 'download', received: 50, total: 100 });
  assert.equal(f.text('#updates-available'), 'Downloading the update... 50%');
  assert.equal(f.$('#updates-available .pct-sign')?.textContent, '%', 'the update line\'s % in its own span too');
  f.updateProgress({ phase: 'install' });
  assert.match(f.text('#updates-available'), /^Installing.../);
  finish({ ok: true }); await settle();
  assert.match(f.text('#updates-available'), /^Installing.../);
  // A failed install says why and frees the button for another try
  const g = await fixture(t, {});
  g.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: true, downloadUrl: 'https://dovakarn.com/x' }));
  g.$('#updates-launcher-check').click(); await settle();
  assert.match(g.text('#updates-available'), /^Launcher version 2\.2\.0 is downloaded and checked/, 'the retry downloads itself again too');
  g.installWith(async () => ({ ok: false, error: 'The downloaded update is not the file the Dovakarn server named, so it was not installed. Try again later.' }));
  g.$('#updates-install').click(); await settle();
  assert.match(g.text('#updates-available'), /not the file the Dovakarn server named/);
  assert.equal(g.$('#updates-install').disabled, false, 'free to try again');
  // While a retry downloads, the line says the last update did not finish, in plain sentences
  const k = await fixture(t, {});
  k.downloadWith(() => new Promise(() => {}));
  k.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: true, downloadUrl: 'https://dovakarn.com/x' }));
  k.$('#updates-launcher-check').click(); await settle();
  assert.equal(k.text('#updates-available'), 'Launcher version 2.2.0 is out. The last update did not finish, so it is downloading again now.');
  const m = await fixture(t, {});
  m.downloadWith(() => new Promise(() => {}));
  m.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: false, downloadUrl: 'https://dovakarn.com/x' }));
  m.$('#updates-launcher-check').click(); await settle();
  assert.equal(m.text('#updates-available'), 'Launcher version 2.2.0 is out. It is downloading now.');
  // A launcher the update system gave up on shows the server's full explanation
  const h = await fixture(t, {});
  h.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: false, blocked: true, blockedMessage: 'The update to v2.2.0 was tried 3 times and the launcher is still v2.1.1. Download the launcher from the Dovakarn Discord instead, and tell the staff the update did not work.' }));
  h.$('#updates-launcher-check').click(); await settle();
  assert.match(h.text('#updates-available'), /Download the launcher from the Dovakarn Discord/);
  assert.equal(h.$('#updates-install').hidden, true, 'no button for a file that will not work');
});

// The progress card: one bar with a percentage for game files and for the launcher's own update
const MB = 1024 * 1024;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
test('updating game files shows one bar with a percentage, the files and the sizes, and nothing competes with it', async t => {
  let finish;
  const f = await fixture(t, { serverOnline: true, lastCheck: passed(), filesUpdate: { needed: true } }, { check: () => new Promise(resolve => { finish = resolve; }) });
  finish({ success: true }); await settle();
  f.checkWith(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(f.play.textContent, 'Update game files');
  f.play.click(); await settle();
  f.progress({ stage: 'updatingFiles', message: 'Updating Dovakarn files (2 of 5)...', meter: { percent: 37, received: 3.4 * MB, bytes: 9.2 * MB, done: 2, total: 5 } });
  assert.equal(f.$('#progress').hidden, true, 'A step that ends within a moment never flashes the card');
  await pause(900);
  const track = f.$('#progress-track');
  assert.deepEqual([f.$('#progress').hidden, f.text('#progress-title'), f.text('#progress-pct'), f.text('#progress-detail')],
    [false, 'Updating game files', '37%', 'File 2 of 5 · 3.4 of 9.2 MB']);
  assert.deepEqual([track.getAttribute('role'), track.getAttribute('aria-valuenow'), track.getAttribute('aria-valuetext')], ['progressbar', '37', '37 percent. File 2 of 5 · 3.4 of 9.2 MB']);
  assert.equal(track.querySelector('i').style.getPropertyValue('--p'), '0.37');
  assert.deepEqual([f.notice.hidden, f.$('#population').hidden, f.message.classList.contains('quiet')], [true, true, true], 'One story at a time: the card replaces the notice and the player gauge, and the status line is only read aloud');
  assert.equal(f.message.hidden, false, 'still in the page for screen readers');
  f.progress({ stage: 'updatingFiles', message: 'Updating Dovakarn files (5 of 5)...', meter: { percent: 100, received: 9.2 * MB, bytes: 9.2 * MB, done: 5, total: 5 } });
  assert.deepEqual([f.text('#progress-pct'), f.text('#progress-detail')], ['100%', 'File 5 of 5 · 9.2 of 9.2 MB']);
  f.progress({ stage: 'checking', message: 'Checking the mod collection on Nexus...' });
  await pause(900);
  assert.deepEqual([f.text('#progress-title'), f.text('#progress-pct'), track.classList.contains('indeterminate'), track.hasAttribute('aria-valuenow')],
    ['Checking the mod collection on Nexus', '', true, false], 'A step with nothing to measure moves without a number');
  f.state.filesUpdate = null; f.state.lastCheck = passed({ updated: 5 }); f.state.phase = { stage: 'ready', message: 'Your game was brought up to date: updated 5 Dovakarn files.' };
  finish({ success: true }); await settle();
  assert.deepEqual([f.$('#progress').hidden, f.message.classList.contains('quiet'), f.$('#population').hidden, f.play.textContent], [true, false, false, 'Play'], 'Done: the card goes and the page is as before');
});

test('a quick check never shows the progress card', async t => {
  let finish;
  const f = await fixture(t, { serverOnline: true, lastCheck: passed() }, { check: () => new Promise(resolve => { finish = resolve; }) });
  f.progress({ stage: 'checking', message: 'Checking your game files against the server...', meter: { percent: 50, received: 50, bytes: 100, done: 2, total: 4 } });
  assert.equal(f.$('#progress').hidden, true, 'not the moment the check starts');
  f.state.phase = { stage: 'ready', message: '' }; finish({ success: true }); await settle();
  await pause(900);
  assert.equal(f.$('#progress').hidden, true);
});

test('the launcher downloads its update with a bar and percent, never leaves a stale line, and installs from one press', async t => {
  let done;
  const f = await fixture(t, { lastCheck: passed() });
  f.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: false }));
  f.downloadWith(() => new Promise(resolve => { done = resolve; }));
  f.$('#updates-launcher-check').click(); await settle();
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Downloading launcher update...', true]);
  assert.equal(f.$('#updates-install').hidden, true, 'no install button until the download is in and checked');
  const before = f.message.textContent;
  f.updateProgress({ phase: 'download', received: 31 * MB, total: 84 * MB });
  await pause(900);
  assert.deepEqual([f.$('#progress').hidden, f.text('#progress-title'), f.text('#progress-pct'), f.text('#progress-detail')], [false, 'Downloading launcher 2.2.0', '36%', '31.0 of 84.0 MB']);
  assert.equal(f.$('#updates-track').hidden, false, 'the Updates tab has its own small bar');
  assert.equal(f.message.textContent, before, 'each percent feeds the bar, not the status line read aloud');
  f.updateProgress({ phase: 'download', received: 84 * MB, total: 84 * MB });
  assert.equal(f.text('#progress-pct'), '99%', 'never 100% before the file is checked');
  done({ ok: true, version: '2.2.0' }); await settle();
  assert.deepEqual([f.$('#progress').hidden, f.$('#updates-track').hidden, f.message.textContent], [true, true, before], 'no stale "100%" line afterwards');
  assert.deepEqual([f.play.textContent, f.play.disabled, f.$('#updates-install').hidden], ['Update launcher', false, false]);
  let finish; f.installWith(() => new Promise(resolve => { finish = resolve; }));
  f.play.click(); await settle();
  f.updateProgress({ phase: 'install' });
  assert.deepEqual([f.$('#progress').hidden, f.text('#progress-title'), f.text('#progress-detail'), f.play.textContent, f.play.disabled],
    [false, 'Installing launcher 2.2.0', 'The launcher closes now and opens again by itself.', 'Installing launcher update...', true], 'the install shows at once, and says the window will close');
  assert.equal(f.$('#progress-cancel').hidden, true, 'an install that has begun runs to the end');
  finish({ ok: true });
});

test('online, a server that is not answering cannot be joined, and says so on the button', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: false, lastCheck: passed(), server: { name: 'Dovakarn', address: 'dovakarn.com', uptime: null, players: [], count: 0, max: 600 } });
  assert.deepEqual([f.play.textContent, f.play.disabled, f.server.textContent], ['Dovakarn is offline', true, 'Server not answering right now']);
  assert.ok(f.$('#server-line').classList.contains('down'), 'the status light turns to the problem colour');
  f.state.serverOnline = true; f.state.server = { ...f.state.server, count: 23 }; await f.tick();
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Play', false]);
  const gauge = f.$('#capacity');
  assert.deepEqual([f.$('#population').hidden, gauge.hidden, gauge.getAttribute('role'), gauge.getAttribute('aria-valuenow'), gauge.getAttribute('aria-valuemax'), gauge.getAttribute('aria-valuetext')],
    [false, false, 'meter', '23', '600', '23 of 600 players in the world'], 'the player gauge is a real meter');
  assert.deepEqual([f.text('#population-now'), f.text('#population-max'), f.$('.population-head').getAttribute('aria-hidden')], ['23', '600', 'true'],
    'the count on the gauge row is read once, by the meter');
  const local = await fixture(t, { lastCheck: passed() });
  assert.deepEqual([local.play.textContent, local.play.disabled], ['Play', false], 'a server on this PC starts when you play');
});

test('Settings tabs move with the arrow keys, Home and End', async t => {
  const f = await fixture(t, { lastCheck: passed() });
  f.$('#settings-open').click();
  assert.equal(f.d.activeElement.id, 'tab-game-button');
  f.key(f.d.activeElement, 'ArrowDown');
  assert.deepEqual([f.d.activeElement.id, f.$('#tab-controls').hidden, f.$('#tab-controls-button').getAttribute('tabindex'), f.$('#tab-game-button').getAttribute('tabindex')], ['tab-controls-button', false, '0', '-1']);
  f.key(f.d.activeElement, 'ArrowDown');
  assert.deepEqual([f.d.activeElement.id, f.$('#tab-mods').hidden, f.$('#tab-controls').hidden], ['tab-mods-button', false, true]);
  f.key(f.d.activeElement, 'End');
  assert.equal(f.d.activeElement.id, 'tab-updates-button');
  f.key(f.d.activeElement, 'ArrowDown');
  assert.equal(f.d.activeElement.id, 'tab-account-button', 'wraps round');
  assert.equal(f.$('#tab-account-button').getAttribute('aria-controls'), 'tab-account');
});

// The keys a server lets players bind, as describeFileList passes them to the page
const KEYS = [
  { id: 'tdm|lock', mod: 'True Directional Movement', label: 'Target lock', default: 258 },
  { id: 'tdm|left', mod: 'True Directional Movement', label: 'Switch target left', default: -1 },
  { id: 'ui|search', mod: 'SkyUI', label: 'Search', default: 57, inMenus: true },
  { id: 'ui|focus', mod: 'SkyUI', label: 'Favourites: switch focus', default: 57, inMenus: true },
];
async function controlsPage(t, extra = {}) {
  const f = await fixture(t, { lastCheck: passed(), fileList: fileList(undefined, { keys: KEYS }), keyChoices: {}, ...extra });
  f.$('#settings-open').click(); f.$('#tab-controls-button').click();
  const row = id => [...f.d.querySelectorAll('#controls-groups .control')].find(r => r.dataset.id === id);
  return {
    ...f, row,
    rows: () => [...f.d.querySelectorAll('#controls-groups .control')].map(r => [r.querySelector('.control-label').textContent, r.querySelector('.keycap').textContent]),
    notes: id => [...row(id).querySelectorAll('.control-note')].map(n => n.textContent),
    press: (code, type = 'keydown') => f.d.activeElement.dispatchEvent(new f.w.KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true })),
    mouse: (button, target = f.d.body) => target.dispatchEvent(new f.w.MouseEvent('mousedown', { button, bubbles: true, cancelable: true })),
    change: id => row(id).querySelector('[data-role="change"]').click(),
  };
}

test('Settings, Controls lists the server\'s keys by mod and changes one by pressing it', async t => {
  const f = await controlsPage(t);
  assert.deepEqual([...f.d.querySelectorAll('#controls-groups h3')].map(h => h.textContent), ['True Directional Movement', 'SkyUI']);
  assert.deepEqual(f.rows(), [['Target lock', 'Middle mouse'], ['Switch target left', 'No key'], ['Search', 'Space'], ['Favourites: switch focus', 'Space']]);
  assert.deepEqual(f.notes('ui|focus'), [], 'a mod\'s own defaults may share a key without a warning');
  assert.equal(f.$('#controls-reset').disabled, true, 'nothing to reset yet');
  assert.match(f.text('#controls-intro'), /Every other mod setting is set by the server.*next time you press Play/);
  // Change: the row waits for a key, and keyboard focus goes to its Cancel
  f.change('tdm|lock');
  assert.deepEqual([f.row('tdm|lock').querySelector('.keycap').textContent, f.d.activeElement.dataset.role, f.text('#controls-status')],
    ['Press a key', 'cancel', 'Press the key or mouse button for Target lock. Esc cancels.']);
  // Esc stops waiting and leaves Settings open; nothing is saved
  f.press('Escape'); await settle();
  assert.deepEqual([f.settings.hidden, f.row('tdm|lock').querySelector('.keycap').textContent, f.calls.controls, f.d.activeElement.dataset.role], [false, 'Middle mouse', [], 'change']);
  // A key Skyrim has no code for is refused and the row keeps waiting
  f.change('tdm|lock'); f.press('F13');
  assert.deepEqual([f.text('#controls-status'), f.row('tdm|lock').classList.contains('control--waiting')], ['Skyrim cannot use that key. Press another, or Esc to cancel.', true]);
  // G: saved as its scan code, shown gold with the server's key under it
  f.press('KeyG'); await settle();
  assert.deepEqual(f.calls.controls, [['tdm|lock', 34]]);
  assert.deepEqual([f.row('tdm|lock').querySelector('.keycap').textContent, f.row('tdm|lock').classList.contains('control--changed'), f.notes('tdm|lock')], ['G', true, ['Server key: Middle mouse']]);
  assert.equal(f.text('#controls-status'), 'Target lock: G. Applied the next time you press Play.');
  assert.equal(f.$('#controls-reset').disabled, false);
  // Mouse buttons and the wheel count; the left button only works the page
  f.change('tdm|left'); f.mouse(0, f.row('tdm|left').querySelector('[data-role="cancel"]'));
  assert.equal(f.row('tdm|left').classList.contains('control--waiting'), true, 'pressing the row\'s own buttons is not a key');
  f.mouse(2); await settle();
  assert.deepEqual(f.calls.controls.at(-1), ['tdm|left', 257]);
  assert.equal(f.row('tdm|left').querySelector('.keycap').textContent, 'Right mouse');
  f.change('tdm|left'); f.w.dispatchEvent(new f.w.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })); await settle();
  assert.equal(f.row('tdm|left').querySelector('.keycap').textContent, 'Wheel up');
  f.change('tdm|left'); f.mouse(0); await settle();
  assert.deepEqual([f.row('tdm|left').classList.contains('control--waiting'), f.calls.controls.length], [false, 3], 'a left click elsewhere stops waiting');
});

test('Settings, Controls warns about a key used twice in one mod, and gives keys back to the server', async t => {
  const f = await controlsPage(t);
  f.change('ui|search'); f.press('KeyE'); await settle();
  f.change('ui|focus'); f.press('KeyE'); await settle();
  assert.deepEqual([f.notes('ui|search'), f.notes('ui|focus')],
    [['Server key: Space', 'Also used by Favourites: switch focus'], ['Server key: Space', 'Also used by Search']], 'warned, never refused');
  // The server's own key is no choice at all
  f.change('ui|search'); f.press('Space'); await settle();
  assert.deepEqual(f.calls.controls.at(-1), ['ui|search', null]);
  assert.deepEqual([f.notes('ui|search'), f.text('#controls-status')], [[], 'Search: Space, the server key. Applied the next time you press Play.']);
  // No key, then Reset on the row
  f.change('ui|focus'); f.row('ui|focus').querySelector('[data-role="none"]').click(); await settle();
  assert.deepEqual([f.calls.controls.at(-1), f.row('ui|focus').querySelector('.keycap').textContent], [['ui|focus', -1], 'No key']);
  f.row('ui|focus').querySelector('[data-role="reset"]').click(); await settle();
  assert.deepEqual([f.calls.controls.at(-1), f.row('ui|focus').querySelector('.keycap').textContent], [['ui|focus', null], 'Space']);
  // Reset all keys
  f.change('tdm|lock'); f.press('KeyG'); await settle();
  f.$('#controls-reset').click(); await settle();
  assert.deepEqual([f.calls.controls.at(-1), f.rows()[0][1], f.$('#controls-reset').disabled], [['reset'], 'Middle mouse', true]);
  assert.equal(f.text('#controls-status'), 'Every key is back to the server key. Applied the next time you press Play.');
});

test('Settings, Controls: Dodge and Sneak come first, and warn when one of the game\'s own controls is on the same key', async t => {
  const GAME = [
    { id: 'game|dodgeKeyCode', mod: 'Ultimate Dodge Mod', label: 'Dodge', default: 29, game: true },
    { id: 'game|sneakKeyCode', mod: 'Ultimate Dodge Mod', label: 'Sneak', default: 45, game: true },
  ];
  // The game's controls on this PC as gameControls.js gives them: Sneak itself is left out, since the Dodge key takes it
  const gameControls = { 18: ['Activate'], 46: ['Auto-Move'], 256: ['Right Attack/Block'], 257: ['Left Attack/Block'] };
  const f = await controlsPage(t, { fileList: fileList(undefined, { keys: [...GAME, ...KEYS] }), gameControls });
  assert.deepEqual([...f.d.querySelectorAll('#controls-groups h3')].map(h => h.textContent), ['Ultimate Dodge Mod', 'True Directional Movement', 'SkyUI']);
  assert.deepEqual(f.rows().slice(0, 2), [['Dodge', 'Left Ctrl'], ['Sneak', 'X']]);
  assert.deepEqual([f.notes('game|dodgeKeyCode'), f.notes('game|sneakKeyCode')], [[], []], 'the server\'s keys are free in the game');
  // Sneak on E: the game's Activate is on it too
  f.change('game|sneakKeyCode'); f.press('KeyE'); await settle();
  assert.deepEqual(f.calls.controls.at(-1), ['game|sneakKeyCode', 18]);
  assert.deepEqual(f.notes('game|sneakKeyCode'), ['Server key: X', 'Also used by the game\'s Activate'], 'warned, never refused');
  // Sneak on the Dodge key: told on the key the player chose
  f.change('game|sneakKeyCode'); f.press('ControlLeft'); await settle();
  assert.deepEqual(f.notes('game|sneakKeyCode'), ['Server key: X', 'Also used by Dodge']);
  // A mod's key used in play is told about the game's controls too
  f.change('tdm|lock'); f.press('KeyE'); await settle();
  assert.deepEqual(f.notes('tdm|lock'), ['Server key: Middle mouse', 'Also used by the game\'s Activate']);
});

test('Settings, Controls warns across every mod and Dovakarn\'s own keys, the server\'s too, and about keys other mods keep', async t => {
  const OURS = [
    { id: 'game|interactMenuKeyCode', mod: 'Dovakarn', label: 'Interact with a player', default: 45, game: true },
    { id: 'game|partyMenuKeyCode', mod: 'Dovakarn', label: 'Party menu', default: 21, game: true },
    { id: 'game|uiToggleKeyCode', mod: 'Dovakarn', label: 'Show or hide the interface', default: 59, game: true },
    { id: 'game|sneakKeyCode', mod: 'Ultimate Dodge Mod', label: 'Sneak', default: 48, game: true },
  ];
  const GROUPS = [{ id: 'ui|group1', mod: 'SkyUI', label: 'Favourites group 1', default: 59 }];
  const fixedKeys = [{ mod: 'SKSE Menu Framework', label: 'Menu', code: 59 }, { mod: 'Immersive Equipment Displays', label: 'Editor', code: 14 }];
  const f = await controlsPage(t, { fileList: fileList(undefined, { keys: [...OURS, ...KEYS, ...GROUPS], fixedKeys }), gameControls: { 57: ['Jump'] } });
  // The server's own keys on one key, in different mods: told on both, with the other key's mod, before anyone chose anything
  assert.deepEqual([f.notes('game|uiToggleKeyCode'), f.notes('ui|group1')],
    [['Also used by Favourites group 1 (SkyUI) and Menu (SKSE Menu Framework)'], ['Also used by Show or hide the interface (Dovakarn) and Menu (SKSE Menu Framework)']]);
  assert.deepEqual([f.notes('game|interactMenuKeyCode'), f.notes('game|partyMenuKeyCode'), f.notes('game|sneakKeyCode')], [[], [], []], 'the rest are free');
  // Party on the Sneak key: told on both rows, whichever the player moved
  f.change('game|partyMenuKeyCode'); f.press('KeyB'); await settle();
  assert.deepEqual([f.notes('game|partyMenuKeyCode'), f.notes('game|sneakKeyCode')], [['Server key: Y', 'Also used by Sneak (Ultimate Dodge Mod)'], ['Also used by Party menu (Dovakarn)']]);
  // Two of Dovakarn's own keys on one key: the same mod in play is a clash too
  f.change('game|interactMenuKeyCode'); f.press('KeyB'); await settle();
  assert.deepEqual(f.notes('game|sneakKeyCode'), ['Also used by Interact with a player (Dovakarn) and Party menu (Dovakarn)']);
  assert.deepEqual(f.notes('game|interactMenuKeyCode'), ['Server key: X', 'Also used by Party menu and Sneak (Ultimate Dodge Mod)']);
  // A key other mods keep, which players cannot change here
  f.change('game|partyMenuKeyCode'); f.press('Backspace'); await settle();
  assert.deepEqual(f.notes('game|partyMenuKeyCode'), ['Server key: Y', 'Also used by Editor (Immersive Equipment Displays)']);
  // Keys that only work inside the game's menus are never compared with keys used in play, nor with the game's controls
  f.change('game|partyMenuKeyCode'); f.press('Space'); await settle();
  assert.deepEqual([f.notes('game|partyMenuKeyCode'), f.notes('ui|search'), f.notes('ui|focus')], [['Server key: Y', 'Also used by the game\'s Jump'], [], []]);
  f.change('ui|search'); f.press('Backspace'); await settle();
  assert.deepEqual(f.notes('ui|search'), ['Server key: Space'], 'a menu key on a key another mod keeps in play');
  // The server's kept keys change on their own: the notes follow at the next refresh
  f.state.fileList = fileList(undefined, { keys: [...OURS, ...KEYS, ...GROUPS], fixedKeys: [...fixedKeys, { mod: 'Voice chat', label: 'Talk', code: 48 }] });
  await f.tick(); await settle();
  assert.deepEqual(f.notes('game|sneakKeyCode'), ['Also used by Interact with a player (Dovakarn) and Talk (Voice chat)']);
});

test('Settings, Controls warns when the cursor key is one that types in the chat', async t => {
  const CURSOR = { id: 'game|freeCursorKeyCode', mod: 'Dovakarn', label: 'Free or lock the mouse cursor', default: 64, game: true };
  const f = await controlsPage(t, { fileList: fileList(undefined, { keys: [CURSOR, { ...CURSOR, id: 'game|namePlatesKeyCode', label: 'Show or hide names above players', default: 49 }] }) });
  const typing = 'Types in the chat, so press Esc to lock the cursor again';
  assert.deepEqual([f.notes('game|freeCursorKeyCode'), f.notes('game|namePlatesKeyCode')], [[], []], 'F6; and the names key on N, which never acts while typing, gets no note');
  for (const [code, warned] of [['KeyC', true], ['Digit9', true], ['Comma', true], ['Space', true], ['Numpad5', true], ['F9', false], ['Insert', false], ['ControlRight', false]]) {
    f.change('game|freeCursorKeyCode'); f.press(code); await settle();
    assert.equal(f.notes('game|freeCursorKeyCode').includes(typing), warned, code);
  }
  f.change('game|freeCursorKeyCode'); f.mouse(1); await settle();
  assert.deepEqual(f.notes('game|freeCursorKeyCode'), ['Server key: F6'], 'a mouse button types nothing');
});

test('Settings, Controls keeps waiting through the page refresh, and stops when the tab or Settings closes', async t => {
  const f = await controlsPage(t);
  f.change('tdm|lock');
  await f.tick(); await settle();
  assert.deepEqual([f.row('tdm|lock').classList.contains('control--waiting'), f.d.activeElement.dataset.role], [true, 'cancel'], 'the refresh never redraws a waiting row');
  // Not even when the server's list changes meanwhile; the new key shows once the row is done
  f.state.fileList = fileList(undefined, { keys: [...KEYS, { id: 'hud|toggle', mod: 'TrueHUD', label: 'Toggle HUD', default: 35 }] });
  await f.tick(); await settle();
  assert.deepEqual([f.row('tdm|lock').classList.contains('control--waiting'), f.d.activeElement.dataset.role, f.rows().length], [true, 'cancel', 4]);
  f.press('Escape'); await settle();
  assert.equal(f.rows().length, 5);
  f.change('tdm|lock');
  f.$('#tab-mods-button').click();
  f.$('#tab-controls-button').click();
  assert.equal(f.row('tdm|lock').classList.contains('control--waiting'), false, 'another tab stops waiting');
  f.change('tdm|lock'); f.$('#settings-done').click();
  f.$('#settings-open').click(); f.$('#tab-controls-button').click();
  assert.equal(f.row('tdm|lock').classList.contains('control--waiting'), false, 'closing Settings stops waiting');
  // Keys pressed with nothing waiting reach the page as usual: Escape closes Settings
  f.key(f.$('#tab-controls-button'), 'Escape');
  assert.equal(f.settings.hidden, true);
  assert.deepEqual(f.calls.controls, []);
});

test('Settings, Controls says so when a server has no keys to change or no list yet', async t => {
  const none = await controlsPage(t, { fileList: fileList(undefined, { keys: [] }) });
  assert.deepEqual([none.text('#controls-intro'), none.$('#controls-actions').hidden, none.d.querySelectorAll('#controls-groups .control').length],
    ['This server has no mod keys to change. Every mod setting is set by the server.', true, 0]);
  const unlisted = await controlsPage(t, { fileList: null });
  assert.equal(unlisted.text('#controls-intro'), 'The server has not published its file list yet.');
  // A choice the player made earlier shows as theirs
  const chosen = await controlsPage(t, { keyChoices: { 'tdm|lock': 48 } });
  assert.deepEqual([chosen.rows()[0], chosen.notes('tdm|lock')], [['Target lock', 'B'], ['Server key: Middle mouse']]);
});

test('the account chip shows a letter when there is no Discord picture, and staff rows show only for staff', async t => {
  const f = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: { ...hadvar, avatar: null, staff: null } }) });
  assert.deepEqual([f.$('#account-avatar').hidden, f.$('#account-initial').hidden, f.text('#account-initial')], [true, false, 'H']);
  f.$('#account-chip').click();
  assert.deepEqual([f.$('#account-fact-staff-row').hidden, f.$('#account-number-note').hidden], [true, false], 'players are not shown a Staff: None row; the number is explained');
  const staff = await fixture(t, { lastCheck: passed(), login: discordServer({ loggedIn: true, account: hadvar }) });
  assert.deepEqual([staff.$('#account-avatar').hidden, staff.$('#account-initial').hidden], [false, true]);
  staff.$('#account-chip').click();
  assert.deepEqual([staff.$('#account-fact-staff-row').hidden, staff.text('#account-fact-staff')], [false, 'Admin']);
});

test('one motto, no small labels over headings, drawn icons, and a footer that waits for its words', async t => {
  const f = await fixture(t, {}, { hold: true });
  assert.equal(f.$('#footer-private').hidden, true, 'no lone diamond before the version arrives');
  const words = f.d.body.textContent;
  assert.equal(words.split('Sky above. Voice within.').length - 1, 1, 'the motto appears once');
  assert.doesNotMatch(words, /Your name\. Your legacy\./);
  assert.equal(f.d.querySelectorAll('.eyebrow, #notice-eyebrow').length, 0);
  assert.deepEqual([...f.d.querySelectorAll('.window-controls button')].map(b => [b.textContent.trim(), !!b.querySelector('svg')]), [['', true], ['', true]], 'the window buttons are drawn, not typed characters');
  await f.answer();
  assert.equal(f.$('#footer-private').hidden, false);
  f.$('#settings-open').click();
  assert.ok([...f.d.querySelectorAll('#folder-ticks li')].every(li => li.querySelector('svg')), 'ticks are drawn icons');
  const css = fs.readFileSync(path.join(renderer, 'local-play.css'), 'utf8');
  assert.doesNotMatch(css, /box-shadow:[^;}]*\b0 0 \d+px #[0-9a-f]{6,8}/i, 'no coloured halo glows');
  assert.doesNotMatch(css, /\.notice[^{]*\{[^}]*border-left:[2-9]px/, 'cards carry a 1px border, not a coloured side bar');
});

test('back from Nexus or Vortex with a mods card showing, the launcher checks again by itself', async t => {
  const f = await fixture(t, { lastCheck: passed({ collection: { revision: 3, total: 52, missing: 52, outdated: 0 } }), fileList: fileList() });
  const before = f.calls.check;
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, before + 1);
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, before + 1, 'at most every 20 seconds');
  const quiet = await fixture(t, { lastCheck: passed() });
  const was = quiet.calls.check;
  quiet.w.dispatchEvent(new quiet.w.Event('focus')); await settle();
  assert.equal(quiet.calls.check, was, 'nothing to fix: no extra check');
});

test('a mod named under Game files is not named again under the collection, and the count says where it went', async t => {
  const files = { ...missingFiles([{ modId: 7, name: 'TDM' }], [{ modId: 12604, name: 'SkyUI' }], [{ name: 'SkyUI', missing: 2, changed: 0, critical: false, nexusId: 12604 }]) };
  const f = await fixture(t, { serverOnline: true, fileList: fileList(), phase: { stage: 'filesWarning', message: 'x' }, files,
    lastCheck: passed({ problems: 1, collection: { revision: 3, total: 52, missing: 1, outdated: 1 } }) });
  f.verify.click(); await settle();
  assert.equal(f.checkText('Mod collection'), '2 mods missing or out of date. One of them is listed above. Update the collection in Vortex.');
  const lists = [...f.d.querySelectorAll('#checks-list .check-list')].map(ul => [...ul.querySelectorAll('li span')].map(s => s.textContent));
  assert.deepEqual(lists, [['SkyUI: 2 files missing'], ['TDM']]);
});

// Cancel on the progress card: game files and the launcher's own download stop at once, and nothing reads as a failure
test('Cancel stops a game-file update: no failure, and the gold button offers the update again', async t => {
  let finish;
  const f = await fixture(t, { serverOnline: true, lastCheck: passed(), filesUpdate: { needed: true } }, { check: () => new Promise(resolve => { finish = resolve; }) });
  finish({ success: true }); await settle();
  f.checkWith(() => new Promise(resolve => { finish = resolve; }));
  f.play.click(); await settle();
  f.progress({ stage: 'updatingFiles', message: 'Updating Dovakarn files (2 of 5)...', meter: { percent: 37, received: 3.4 * MB, bytes: 9.2 * MB, done: 2, total: 5 } });
  await pause(900);
  const cancel = f.$('#progress-cancel');
  assert.deepEqual([cancel.hidden, cancel.disabled, cancel.textContent], [false, false, 'Cancel']);
  cancel.focus(); cancel.click(); await settle();
  assert.equal(f.calls.cancel, 1);
  assert.deepEqual([cancel.disabled, cancel.textContent], [true, 'Stopping...'], 'one press, and it shows it was heard');
  cancel.click(); await settle();
  assert.equal(f.calls.cancel, 1, 'a second press does not ask again');
  const stopped = 'Stopped. Anything already downloaded is kept.', reds = [];
  new f.w.MutationObserver(() => { if (f.message.classList.contains('error')) reds.push(f.message.textContent); }).observe(f.message, { attributes: true, childList: true, characterData: true, subtree: true });
  f.state.phase = { stage: 'ready', message: stopped };
  finish({ success: false, cancelled: true, error: stopped }); await settle();
  assert.deepEqual(reds, [], 'not even for a moment does the status line turn red');
  assert.deepEqual([f.$('#progress').hidden, f.message.textContent, f.message.classList.contains('error')], [true, stopped, false], 'stopped, not failed');
  assert.notEqual(f.notice.dataset.kind, 'Check', 'no red "could not be updated" card');
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Update game files', false]);
  assert.equal(f.d.activeElement, f.play, 'keyboard focus moves to the gold button instead of being lost with the card');
});

test('Cancel shows only for what can stop, and the gold button names each step and waits for it', async t => {
  let finish;
  const f = await fixture(t, { serverOnline: true, lastCheck: passed() }, { check: () => new Promise(resolve => { finish = resolve; }) });
  f.progress({ stage: 'startingServer', message: 'Starting Dovakarn-Local-Test...' });
  await pause(900);
  assert.deepEqual([f.$('#progress').hidden, f.$('#progress-cancel').hidden], [false, true], 'starting the server runs to the end');
  f.progress({ stage: 'checking', message: 'Checking your game files against the server...', meter: { percent: 10, received: 10, bytes: 100, done: 1, total: 4 } });
  assert.deepEqual([f.$('#progress').hidden, f.text('#progress-title'), f.$('#progress-cancel').hidden], [false, 'Checking your game files', false],
    'the next step takes over the card at once: it never blinks out between steps');
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Checking game files...', true]);
  f.progress({ stage: 'updatingFiles', message: 'Updating game files...', meter: { percent: 40, received: 40, bytes: 100, done: 2, total: 4 } });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Updating game files...', true], 'an update of game files is no time to press Play');
  f.play.click(); await settle();
  f.$('#progress-cancel').click(); await settle();
  assert.deepEqual([f.calls.cancel, f.calls.play], [1, 0]);
  f.state.phase = { stage: 'ready', message: 'Stopped. Anything already downloaded is kept.' };
  finish({ success: false, cancelled: true, error: 'Stopped. Anything already downloaded is kept.' }); await settle();
  assert.equal(f.calls.play, 0, 'nothing launches after a stopped check');
});

test('Cancel stops the launcher download, and it waits for the gold button to start again', async t => {
  let done;
  const f = await fixture(t, { lastCheck: passed() });
  f.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: false }));
  f.downloadWith(() => new Promise(resolve => { done = resolve; }));
  f.$('#updates-launcher-check').click(); await settle();
  f.updateProgress({ phase: 'download', received: 31 * MB, total: 84 * MB });
  await pause(900);
  f.$('#progress-cancel').click(); await settle();
  assert.equal(f.calls.updateCancel, 1);
  done({ ok: false, cancelled: true, error: 'Download stopped.' }); await settle();
  assert.deepEqual([f.$('#progress').hidden, f.notice.hidden, f.notice.dataset.kind, f.text('#notice-title')], [true, false, 'Launcher', 'Launcher 2.2.0 is not downloaded']);
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Download launcher update', false]);
  assert.equal(f.message.classList.contains('error'), false, 'stopped, not failed');
  const downloads = f.calls.updateDownload;
  f.$('#updates-launcher-check').click(); await settle();
  assert.equal(f.calls.updateDownload, downloads, 'a later update check does not start it again by itself');
  assert.equal(f.text('#updates-available'), 'You stopped the launcher update. Press Download launcher update to start it again.');
  f.downloadWith(async () => ({ ok: true, version: '2.2.0' }));
  f.play.click(); await settle();
  assert.equal(f.calls.updateDownload, downloads + 1);
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Update launcher', false]);
});

test('Cancel during the install press stops its download too, and nothing says it failed', async t => {
  const f = await fixture(t, { lastCheck: passed() });
  f.updateWith(async () => ({ current: '2.1.1', latest: '2.2.0', hasUpdate: true, retry: false }));
  f.downloadWith(async () => ({ ok: false, error: 'HTTP 503' }));
  f.$('#updates-launcher-check').click(); await settle();
  assert.equal(f.play.textContent, 'Retry launcher update');
  let finish; f.installWith(() => new Promise(resolve => { finish = resolve; }));
  f.$('#updates-install').click(); await settle();
  f.updateProgress({ phase: 'download', received: 10 * MB, total: 84 * MB });
  assert.equal(f.$('#progress-cancel').hidden, false, 'the download before an install can stop');
  f.$('#progress-cancel').click(); await settle();
  assert.equal(f.calls.updateCancel, 1);
  finish({ ok: false, cancelled: true, error: 'Download stopped.' }); await settle();
  assert.deepEqual([f.$('#progress').hidden, f.play.textContent, f.message.classList.contains('error'), f.text('#notice-title')],
    [true, 'Download launcher update', false, 'Launcher 2.2.0 is not downloaded']);
});

test('a launch that updates game files first says so on the gold button, and takes no press', async t => {
  const f = await fixture(t, { serverOnline: true, busy: true, lastCheck: passed() });
  f.progress({ stage: 'startingServer', message: 'Starting Dovakarn...' });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Preparing Skyrim...', true]);
  f.progress({ stage: 'updatingFiles', message: 'Updating game files...', meter: { percent: 37, received: 37, bytes: 100, done: 2, total: 5 } });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Updating game files...', true]);
  f.play.click(); await settle();
  assert.equal(f.calls.play, 0);
});

test('Steam\'s 1.7 Skyrim is sent to the Skyrim Downgrader Tool, and checked the moment it is on 1.6.1170', async t => {
  const steam17 = { ...goodFolder, version: '1.7.104.0', versionOk: false, steam: true };
  const f = await fixture(t, { gameFolder: steam17 });
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title'), f.play.textContent, f.text('#notice-secondary')], ['Skyrim version', 'Switch Skyrim to 1.6.1170', 'Get the Skyrim Downgrader Tool', 'Choose another folder']);
  assert.equal(f.text('#notice-text'), "This Skyrim is 1.7.104, and Dovakarn runs on 1.6.1170. The Skyrim Downgrader Tool on Nexus Mods switches it with Steam's own files. Run it, then come back here.");
  f.play.click(); await settle();
  assert.deepEqual(f.calls.mods, [188916], 'the tool\'s Nexus page opens');
  // Settings, Game offers it too
  f.$('#settings-open').click(); await settle();
  assert.deepEqual([f.$('#folder-switch-row').hidden, f.text('#folder-switch')], [false, 'Get the Skyrim Downgrader Tool']);
  f.$('#folder-switch').click(); await settle();
  assert.deepEqual(f.calls.mods, [188916, 188916]);
  f.$('#settings-done').click();
  f.verify.click(); await settle();
  assert.match(f.checkText('Skyrim version'), /The Skyrim Downgrader Tool on Nexus Mods switches it/);
  f.$('#checks-close').click();
  // The tool ran: the launcher sees 1.6.1170 at its next refresh, the card goes and the game is checked straight away
  const checks = f.calls.check;
  f.state.gameFolder = { ...goodFolder, steam: true };
  await f.tick(); await settle();
  assert.deepEqual([f.notice.hidden, f.play.textContent !== 'Get the Skyrim Downgrader Tool'], [true, true]);
  assert.equal(f.calls.check, checks + 1, 'checked once, as soon as the version is right');
  await f.tick(); await settle();
  assert.equal(f.calls.check, checks + 1, 'and not again at every refresh');
});

test('the main screen leads with the latest updates; the server, the players and Play stay pinned below them', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true });
  const foot = f.$('.journey-foot');
  assert.ok(foot.contains(f.play) && foot.contains(f.$('#server-line')) && foot.contains(f.$('#population')) && foot.contains(f.notice), 'one pinned group at the foot of the column');
  assert.equal(f.$('#updates').compareDocumentPosition(foot) & f.w.Node.DOCUMENT_POSITION_FOLLOWING, f.w.Node.DOCUMENT_POSITION_FOLLOWING, 'the updates come first, in reading and focus order');
  assert.ok(f.$('#world-name').classList.contains('visually-hidden'), 'the world name stays for screen readers only');
  assert.ok(f.calls.updates >= 1, 'asked as the launcher opens');
  assert.deepEqual([f.$('#updates').hidden, f.$('#updates-list').hidden, f.text('#updates-note')], [false, true, 'No updates yet.']);
  const body2 = 'Update 2: sample notes. A longer body than fits in two lines, so the entry opens in place to be read in full.';
  f.updatesWith({ reached: true, fresh: ['u2'], entries: [
    { id: 'u2', version: 'Update 2', date: 'Jan 2, 2026', title: 'Sample update two', body: body2 },
    { id: 'u1', version: 'Update 1', date: 'Jan 1, 2026', title: 'Sample update one', body: 'Update 1: sample notes.' }] });
  await f.tick(); await settle();
  const items = () => [...f.d.querySelectorAll('#updates-list > li')];
  assert.deepEqual(items().map(li => [li.querySelector('.update-title').textContent, !!li.querySelector('.update-new'), li.querySelector('.update-meta').textContent]),
    [['Sample update two', true, 'Update 2 · Jan 2, 2026'], ['Sample update one', false, 'Update 1 · Jan 1, 2026']], 'newest first; New only on what was posted since the last open');
  assert.equal(f.$('#updates-note').hidden, true);
  const first = items()[0], toggle = first.querySelector('.update-toggle');
  assert.deepEqual([toggle.getAttribute('aria-expanded'), first.querySelector('.update-text').textContent, toggle.getAttribute('aria-controls')], ['false', body2, first.querySelector('.update-text').id], 'the whole text is there for screen readers; the page shows two lines of it');
  toggle.click(); await settle();
  assert.deepEqual([items()[0].classList.contains('update--open'), items()[0].querySelector('.update-toggle').getAttribute('aria-expanded'), f.d.activeElement === items()[0].querySelector('.update-toggle')], [true, 'true', false]);
  items()[0].querySelector('.update-text').click(); await settle();
  assert.equal(items()[0].classList.contains('update--open'), false, 'a press on the words closes it again');
  // The server does not answer and nothing was kept: said plainly
  f.updatesWith({ reached: false, fresh: [], entries: [] }); await f.tick(); await settle();
  assert.deepEqual([f.$('#updates-list').hidden, f.text('#updates-note')], [true, 'The latest updates could not be loaded. They show here once the Dovakarn server answers.']);
  // The test launcher plays on a server on this PC: no panel
  f.updatesWith({ local: true, entries: [], fresh: [], reached: true }); await f.tick(); await settle();
  assert.equal(f.$('#updates').hidden, true);
});

// Dovakarn's own game copy: the online launcher plays from C:\Dovakarn\Game, never the player's own Skyrim
const copyState = (extra = {}) => ({ installDir: 'C:\\Dovakarn', chosen: true, gameDir: 'C:\\Dovakarn\\Game', ready: false, steamDir: SKYRIM, steamReady: false,
  depots: [{ id: '489831', command: 'download_depot 489830 489831 8442952117333549665', state: 'done', files: 19, total: 19 },
    { id: '489832', command: 'download_depot 489830 489832 8042843504692938467', state: 'downloading', files: 7, total: 26 },
    { id: '489833', command: 'download_depot 489830 489833 1914580699073641964', state: 'waiting', files: 0, total: 1 }],
  missing: 20, todo: 46, bytes: 0, free: 2e12, mods: null, oldInstall: false, ...extra });

test('a launcher without its game copy sets it up first: Steam\'s three download lines, then Install, then the usual check', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState() });
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title'), f.play.textContent, f.play.disabled], ['Setup', 'Set up Dovakarn', 'Set up Dovakarn', false]);
  assert.match(f.text('#notice-text'), /own copy of Skyrim in C:\\Dovakarn, so your own Skyrim and its mods stay exactly as they are/);
  f.play.click(); await settle();
  const setup = f.$('#setup');
  assert.equal(setup.hidden, false);
  assert.equal(f.text('#setup-path'), 'C:\\Dovakarn');
  assert.match(f.text('#setup-source'), /Your Steam Skyrim is a newer version\. Steam still has 1\.6\.1170/);
  const rows = [...f.d.querySelectorAll('#setup-depots li')];
  assert.deepEqual(rows.map(li => [li.querySelector('code').textContent, li.querySelector('.depot-state').textContent, li.className]), [
    ['download_depot 489830 489831 8442952117333549665', 'Downloaded', 'depot depot--done'],
    ['download_depot 489830 489832 8042843504692938467', '7 of 26 files', 'depot depot--downloading'],
    ['download_depot 489830 489833 1914580699073641964', 'Not started', 'depot depot--waiting']]);
  assert.deepEqual([f.$('#setup-install').disabled, f.$('#setup-install').title], [true, "Skyrim 1.6.1170 is not on this PC yet: download it with Steam's console first."]);
  rows[2].querySelector('button').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['copy', 'download_depot 489830 489833 1914580699073641964']);
  assert.equal(f.text('#setup-status'), "Copied. In Steam's console, press Ctrl+V to paste it, then press Enter.");
  f.$('#setup-console').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['openConsole']);
  // Steam finishes: the next refresh shows it, keeps keyboard focus where it was, and Install opens up
  rows[1].querySelector('button').focus();
  f.state.gameCopy = copyState({ missing: 0, depots: copyState().depots.map(d => ({ ...d, state: 'done', files: d.total })) });
  await f.tick(); await settle();
  assert.equal(f.d.activeElement.dataset.command, 'download_depot 489830 489832 8042843504692938467');
  assert.deepEqual([f.$('#setup-install').disabled, f.text('#setup-source'), f.$('#setup-console-row').hidden], [false, "Steam's 1.6.1170 download is ready. Press Install.", true]);
  const checks = f.calls.check;
  f.gameAnswers.setup = async state => { state.gameCopy = copyState({ ready: true, missing: 0, todo: 0 }); return { success: true }; };
  f.$('#setup-install').click(); await settle(); await settle();
  assert.equal(setup.hidden, true, 'the window closes and the main screen follows the copy');
  assert.deepEqual(f.calls.game.filter(c => c[0] === 'setup').length, 1);
  assert.equal(f.calls.check, checks + 1, 'then the usual check, which installs the mods');
});

test('Steam\'s download still on the PC: the window says its files move in, never that it copies from the player\'s Skyrim', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ steamReady: true, fromDownload: true, missing: 0, bytes: 0 }) });
  f.play.click(); await settle();
  assert.equal(f.text('#setup-source'), "Steam's 1.6.1170 download is already on this PC, so its files move in, and anything it lacks is copied from your Steam Skyrim. Your Skyrim is only read, never changed.");
  assert.equal(f.text('#setup-space'), "Steam's downloaded files move straight in, so nothing is stored twice.");
});

test('the copy\'s progress shows on the main screen, and a refused setup reopens its window with why', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ steamReady: true, missing: 0, bytes: 16e9 }) });
  f.play.click(); await settle();
  assert.match(f.text('#setup-source'), /already 1\.6\.1170, so the launcher copies its game files from it/);
  assert.match(f.text('#setup-space'), /^About 14\.9 GB to copy\. C: has 1,862\.6 GB free\.$/);
  let finish;
  f.gameAnswers.setup = () => new Promise(resolve => { finish = resolve; });
  f.$('#setup-install').click(); await settle();
  f.state.busy = true;
  f.state.phase = { stage: 'copyingGame', message: 'Copying Skyrim 1.6.1170 (file 3 of 46)...', meter: { percent: 40, received: 6e9, bytes: 15e9, done: 3, total: 46 } };
  f.progress(f.state.phase);
  await new Promise(resolve => setTimeout(resolve, 850)); await f.tick(); await settle();
  assert.deepEqual([f.$('#progress').hidden, f.text('#progress-title'), f.text('#progress-pct'), f.play.textContent], [false, 'Copying Skyrim 1.6.1170', '40%', 'Copying Skyrim...']);
  assert.equal(f.$('#progress-pct .pct-sign')?.textContent, '%', 'the % in its own span, so Sovngarde\'s gap before it is closed');
  assert.match(f.text('#progress-detail'), /^File 3 of 46 · 5\.6 of 14\.0 GB$/);
  assert.equal(f.$('#progress-cancel').hidden, false, 'Cancel stops the copy');
  f.state.busy = false; f.state.phase = { stage: 'failed', message: 'Not enough free space on C:\\: 14.9 GB needed, 2.0 GB free.' };
  finish({ success: false, error: 'Not enough free space on C:\\: 14.9 GB needed, 2.0 GB free.' }); await settle(); await settle();
  assert.equal(f.$('#setup').hidden, false, 'the window comes back to say why');
  assert.deepEqual([f.text('#setup-status'), f.$('#setup-status').classList.contains('error')], ['Not enough free space on C:\\: 14.9 GB needed, 2.0 GB free.', true]);
});

test('a 1.6.1170 Skyrim with a file a mod changed: the setup window says so and asks for Steam\'s download, and Settings agrees', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ missing: 1, steamChanged: ['Data/Update.esm'] }) });
  f.play.click(); await settle();
  assert.equal(f.text('#setup-source'), "A mod changed one of Skyrim's own files in your Steam Skyrim: Data/Update.esm. So Dovakarn takes Skyrim 1.6.1170 from Steam's own download instead. Open Steam's console, then copy each line below into it and press Enter. Your installed Skyrim stays as it is.");
  assert.deepEqual([f.$('#setup-depots').hidden, f.$('#setup-console-row').hidden, f.$('#setup-install').disabled], [false, false, true]);
  f.state.gameCopy = copyState({ missing: 2, steamChanged: ['Data/Update.esm', 'SkyrimSE.exe'] });
  await f.tick(); await settle();
  assert.match(f.text('#setup-source'), /^A mod changed 2 of Skyrim's own files in your Steam Skyrim: Data\/Update\.esm and more\. So Dovakarn takes/);
  f.$('#setup-close').click(); await settle();
  f.$('#settings-open').click(); await settle();
  assert.deepEqual([...f.d.querySelectorAll('#folder-ticks li')].map(li => li.textContent), ["Skyrim 1.6.1170, with 2 files a mod changed: Dovakarn uses Steam's 1.6.1170 download"]);
});

test('mods to download: Download them all opens the Nexus window, rows follow each download, and the mods install by themselves', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 2 },
    phase: { stage: 'modsNeeded', message: '2 mods to download from Nexus Mods.' } });
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title'), f.text('#notice-text'), f.play.textContent],
    ['Mods', '2 mods to download', 'They come from Nexus Mods with your own Nexus account. A free one works. Press Get the mods, then Download them all, and Nexus opens inside the launcher, where you log in to Nexus once. Once every mod is downloaded, the launcher installs them.', 'Get the mods']);
  assert.equal(f.message.classList.contains('error'), false, 'mods to download is not a failure');
  f.play.click(); await settle();
  assert.equal(f.$('#mods').hidden, false);
  const rows = () => [...f.d.querySelectorAll('#mods-needed li')];
  assert.deepEqual(rows().map(li => [li.querySelector('strong').textContent, li.querySelector('p').textContent]),
    [['SkyUI', 'Version 5.2 · 2.2 MB'], ['Skyrim Script Extender (SKSE64)', '742 KB']]);
  assert.equal(f.text('#mods-intro'), 'Press Download them all and Nexus opens inside the launcher. Log in once. A free account works. Then press Slow download for each mod, and the launcher takes each file by itself.');
  assert.equal(f.d.activeElement.id, 'mods-all', 'the window opens on its gold button, never on the folder link in its title row');
  assert.doesNotMatch(f.text('#mods-intro'), /[()]/, 'no brackets: Sovngarde draws them like square ones');
  assert.equal(f.$('#mods-browser'), null, 'the browser sentence no longer takes rows from the list');
  assert.equal(f.$('#mods-again').title, 'Downloaded some in your own browser? Press Check my downloads and the launcher picks them up.', 'it is Check my downloads\' tooltip');
  assert.deepEqual([f.text('#mods-status'), f.$('#mods-browser-open').hidden, f.$('#mods-more').hidden, f.text('#mods-folder')], ['', true, false, 'My mods are in another folder']);
  assert.deepEqual([f.text('#mods-all'), f.$('#mods-all').hidden], ['Download them all', false]);
  f.$('#mods-all').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', null], 'Download them all: the first one still to get');
  rows()[1].querySelector('button').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', '412']);
  assert.equal(f.text('#mods-status'), '', 'an opened window says nothing here');
  // The Nexus window works: each row follows its download, and coming back to the launcher starts no check meanwhile
  const checks = f.calls.check;
  await f.nexus({ open: true, current: '35407', archives: { 35407: { state: 'downloading', percent: 63 }, 412: { state: 'waiting', percent: null } } });
  assert.deepEqual(rows().map(li => li.querySelector('p').textContent), ['Version 5.2 · 2.2 MB · Downloading 63%', '742 KB']);
  assert.deepEqual(rows().map(li => li.className), ['check check--warn', 'check']);
  // The percent sign sits in its own span, so Sovngarde's gap before it can be closed
  assert.deepEqual([...rows()[0].querySelectorAll('p .pct-sign')].map(s => s.textContent), ['%']);
  // A download in flight: its row's button brings the Nexus window forward, never a second download
  const running = rows()[0].querySelector('button');
  assert.deepEqual([running.textContent, running.getAttribute('aria-label'), rows()[1].querySelector('button').textContent], ['Show', 'Show the Nexus window', 'Download']);
  running.click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', null], 'Show only brings the window forward, wherever it is');
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, checks, 'no check while the Nexus window is open');
  await f.nexus({ open: true, current: '412', archives: { 35407: { state: 'done', percent: null }, 412: { state: 'wrong', percent: null } } });
  assert.deepEqual([rows()[0].querySelector('p').textContent, rows()[0].querySelectorAll('svg').length, rows()[0].querySelector('button').hidden, rows()[0].className], ['Downloaded', 1, true, 'check check--ok']);
  assert.deepEqual([rows()[1].querySelector('p').textContent, rows()[1].className, rows()[1].querySelector('button').hidden, rows()[1].querySelector('button').textContent],
    ['742 KB · Wrong file: press Download to try again', 'check check--bad', false, 'Download']);
  await f.nexus({ open: true, current: '412', archives: { 35407: { state: 'done', percent: null }, 412: { state: 'failed', percent: null } } });
  assert.equal(rows()[1].querySelector('p').textContent, '742 KB · Did not download: press Download to try again');
  assert.deepEqual([f.text('#mods-title'), f.text('#notice-title')], ['1 mod to download', '1 mod to download']);
  // Every one downloaded, the window closed: the launcher installs them as soon as it is free, and the mods window says so
  await f.nexus({ open: false, installQueued: true, current: null, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'done', percent: null } } });
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title'), f.text('#notice-text'), f.play.textContent, f.play.disabled],
    ['Mods', 'Every mod is downloaded', 'The launcher installs them as soon as it is free.', 'Waiting to install the mods', true]);
  assert.deepEqual([f.text('#mods-title'), f.$('#mods-all').hidden, f.$('#mods-intro').hidden, f.text('#mods-intro'), f.$('#mods-more').hidden],
    ['Every mod is downloaded', true, false, 'The launcher installs them as soon as it is free.', true],
    'downloaded, not yet installed: the next step, never "Every mod is in" before the install');
  assert.equal(f.calls.check, checks, 'the window closing with nothing left to get starts no check of its own');
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, checks, 'no check while the install waits');
  await f.nexus({ open: false, installQueued: true, installing: true, current: null, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'done', percent: null } } });
  assert.equal(f.$('#mods').hidden, true, 'the install has begun: the mods window gives way to the main screen');
  assert.equal(f.play.disabled, true, 'never Play during the install');
  // Installed: the launcher's state is asked at once, not at the next 2 second refresh, so the card is never stale
  f.state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods: null });
  f.state.lastCheck = { at: Date.now(), published: true, checked: 920, updated: 0, patched: 0, problems: 0, blocked: false };
  f.state.phase = { stage: 'ready', message: 'Every mod is installed. Press Play when you are ready.' };
  const asked = f.calls.state;
  await f.nexus({ open: false, installQueued: false, installing: false, current: null, archives: {} });
  await settle(); await settle();
  assert.equal(f.calls.state, asked + 1, 'the install ending asks for the state straight away');
  assert.deepEqual([f.notice.hidden, f.play.textContent, f.play.disabled, f.message.textContent], [true, 'Play', false, 'Every mod is installed. Press Play when you are ready.']);
});

test('Check my downloads still picks up browser downloads, and coming back checks again when the Nexus window is closed', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 2 },
    phase: { stage: 'modsNeeded', message: '2 mods to download from Nexus Mods.' } });
  f.play.click(); await settle();
  const checks = f.calls.check;
  // One downloaded in the browser: Check my downloads finds it
  f.checkWith(async state => { state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods: mods.slice(1) }); return { success: false, error: '1 mod to download from Nexus Mods.', setup: 'mods' }; });
  f.$('#mods-again').click(); await settle(); await settle();
  assert.equal(f.calls.check, checks + 1);
  assert.deepEqual([f.text('#mods-status'), f.text('#mods-title'), f.d.querySelectorAll('#mods-needed li').length], ['1 mod still to download.', '1 mod to download', 1]);
  // Back in the launcher with the last one downloaded: checked by itself, the mods go in and the window says so
  f.checkWith(async state => { state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods: null }); state.lastCheck = { at: Date.now(), published: true, checked: 920, updated: 0, patched: 0, problems: 0, blocked: false }; state.phase = { stage: 'ready', message: '' }; return { success: true }; });
  f.w.dispatchEvent(new f.w.Event('focus')); await settle(); await settle();
  assert.equal(f.calls.check, checks + 2);
  assert.deepEqual([f.text('#mods-title'), f.$('#mods-all').hidden, f.notice.hidden, f.play.textContent], ['Every mod is installed', true, true, 'Play']);
  // Nothing left to look for: no Check my downloads, no empty list, and the next step is Play
  assert.deepEqual([f.$('#mods-again').hidden, f.$('#mods-needed').hidden, f.$('#mods-more').hidden, f.text('#mods-intro')], [true, true, true, 'Press Play on the main screen when you are ready.']);
  // Check my downloads that finds the last one and installs them all: the status says installed, never "in"
  const g = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: mods.slice(1) }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 1 },
    phase: { stage: 'modsNeeded', message: '1 mod to download from Nexus Mods.' } });
  g.play.click(); await settle();
  g.checkWith(async state => { state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods: null }); return { success: true }; });
  g.$('#mods-again').click(); await settle(); await settle();
  assert.equal(g.text('#mods-status'), 'Every mod is installed.');
});

test('with Dovakarn\'s game, Verify never offers the Vortex collection and Settings and Verify speak of Dovakarn\'s game', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, fileList: fileList(), lastCheck: passed({ problems: 1, blocked: true, moved: 2 }),
    gameCopy: copyState({ ready: true, missing: 0, todo: 0 }) });
  f.$('#settings-open').click(); await settle();
  assert.equal(f.text('#mods-heading'), 'Mods');
  assert.equal(f.text('#updates-files-note'), "Your game files and Dovakarn's mods are checked every time the launcher opens and again before every game. Anything that changed is fixed for you or shown on the main screen.");
  f.$('#settings-done').click(); await settle();
  let finish;
  f.checkWith(() => new Promise(resolve => { finish = resolve; }));
  f.verify.click(); await settle();
  assert.equal(f.text('#checks-summary'), "Checking Dovakarn's game, its mods and its files.");
  finish({ success: true }); await settle(); await settle();
  assert.equal(f.$('#checks-collection').hidden, true, 'a blocked check with a collection link still never offers Vortex here');
  assert.equal(f.checkText('Files moved out'), '2 files the server does not use were moved into the "Dovakarn removed files" folder in Dovakarn\'s game. Nothing was deleted.');
});

test('a check stopped for setup or mods is never shown as a failed launch', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0 }) });
  f.launch(async () => { f.state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods: [{ id: '1', name: 'A mod', size: 10, files: 1 }] }); f.state.phase = { stage: 'modsNeeded', message: '1 mod to download from Nexus Mods.' }; return { success: false, error: '1 mod to download from Nexus Mods.', setup: 'mods' }; });
  f.play.click(); await settle(); await settle();
  assert.deepEqual([f.notice.dataset.kind, f.text('#notice-title'), f.message.classList.contains('error')], ['Mods', '1 mod to download', false]);
});

test('Settings, Game shows Dovakarn\'s game apart from the player\'s own Skyrim, which it only reads; Remove and Put my Skyrim back', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameFolder: { ...goodFolder, path: 'C:\\Dovakarn\\Game' }, gameCopy: copyState({ ready: true, missing: 0, todo: 0, oldInstall: true, steamReady: false }) });
  f.$('#settings-open').click(); await settle();
  assert.deepEqual([f.$('#copy-section').hidden, f.text('#copy-path'), f.text('#folder-heading'), f.text('#folder-path')], [false, 'C:\\Dovakarn\\Game', 'Your Skyrim', SKYRIM]);
  assert.equal(f.text('#mods-heading'), 'Mods');
  assert.deepEqual([...f.d.querySelectorAll('#copy-ticks li')].map(li => [li.textContent, li.className]), [['Skyrim 1.6.1170', 'ok'], ['Script extender', 'ok'], ['Mods installed', 'ok']]);
  assert.match(f.text('#folder-note'), /only reads it/);
  assert.deepEqual([...f.d.querySelectorAll('#folder-ticks li')].map(li => li.textContent), ["A newer Skyrim: Dovakarn uses Steam's 1.6.1170 download"]);
  assert.deepEqual([f.$('#folder-switch-row').hidden, f.$('#restore-row').hidden, f.$('#copy-setup-row').hidden, f.$('#mods-get').hidden], [true, false, true, true], 'no Downgrader Tool and no Vortex collection here');
  f.$('#restore-skyrim').click(); await settle(); await settle();
  assert.deepEqual([f.calls.game.at(-1), f.text('#restore-status')], [['restoreSkyrim'], 'Done: removed 3 Dovakarn files.']);
  f.$('#copy-open').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['openInstall']);
  f.gameAnswers.remove = async state => { state.gameCopy = copyState(); return { success: true }; };
  f.$('#copy-remove').click(); await settle(); await settle();
  assert.deepEqual([f.calls.game.at(-1), f.message.textContent], [['remove'], "Dovakarn's game was removed from this PC."]);
  assert.deepEqual([f.$('#copy-setup-row').hidden, f.text('#copy-path')], [false, 'C:\\Dovakarn, not set up yet']);
});

test('Verify on Dovakarn\'s game lists the game and the mods still to download, with their Nexus pages, and no Vortex collection', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, fileList: fileList(), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 1 },
    gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: [{ id: '35407', name: 'SkyUI', size: 2.3e6, files: 22 }] }) });
  f.checkWith(async () => ({ success: false, error: '1 mod to download from Nexus Mods.', setup: 'mods' }));
  f.verify.click(); await settle(); await settle();
  assert.deepEqual(f.checkTitles(), [['Mods', 'warn'], ['Game files', 'idle'], ["Dovakarn's game", 'ok']]);
  assert.equal(f.checkText('Game files'), 'Checked against the server once the mods are in.');
  assert.equal(f.checkText("Dovakarn's game"), 'Skyrim 1.6.1170 in C:\\Dovakarn\\Game.');
  f.d.querySelector('#checks-list button[data-archive]').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', '35407']);
  assert.equal(f.$('#checks-collection').hidden, true);
});

// Every mod downloaded by the Nexus window, the install not queued or running (it never started, or it stopped)
const ONE_MOD = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }];
const allDownloaded = (extra = {}) => ({ open: false, installQueued: false, installing: false, current: null, account: { user: '' }, archives: { 35407: { state: 'done', percent: null } }, ...extra });
const modsLeft = (extra = {}) => ({ mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: ONE_MOD }),
  lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 1 }, phase: { stage: 'modsNeeded', message: '1 mod to download from Nexus Mods.' }, ...extra });

test('every mod downloaded but nothing installing: the gold button is Install the mods, never a disabled wait, and the card says why', async t => {
  const f = await fixture(t, modsLeft());
  await f.nexus(allDownloaded());
  assert.deepEqual([f.notice.className, f.text('#notice-title'), f.text('#notice-text'), f.play.textContent, f.play.disabled],
    ['notice notice--info', 'Every mod is downloaded', "Press Install the mods to put them into Dovakarn's game.", 'Install the mods', false]);
  const checks = f.calls.check;
  f.play.click(); await settle(); await settle();
  assert.equal(f.calls.check, checks + 1, 'one press, one check: the one that installs them');
  // The install stopped: the card says why, once (the red status line with the same words steps aside)
  const error = "Could not read the server's install list: timed out.";
  f.state.lastCheck = { at: Date.now(), failed: true, error };
  f.state.phase = { stage: 'failed', message: error };
  await f.tick(); await settle();
  assert.deepEqual([f.notice.className, f.text('#notice-text'), f.play.textContent, f.play.disabled, f.message.hidden],
    ['notice notice--bad', `They are downloaded, but installing them stopped: ${error} Press Install the mods to try again.`, 'Install the mods', false, true]);
  // Dovakarn offline: the usual offline button, and the card says when to press
  f.state.serverOnline = false;
  await f.tick(); await settle();
  assert.deepEqual([f.text('#notice-text'), f.play.textContent, f.play.disabled], ['Dovakarn is not answering right now. Once it is, press Install the mods.', 'Dovakarn is offline', true]);
  // Skyrim running
  f.state.serverOnline = true; f.state.gameRunning = true;
  await f.tick(); await settle();
  assert.deepEqual([f.text('#notice-text'), f.play.textContent], ['Close Skyrim, then press Install the mods.', 'Skyrim is running']);
  await f.nexus(allDownloaded({ installQueued: true }));
  assert.equal(f.text('#notice-text'), 'Close Skyrim and the launcher installs them.');
});

test('closing the Nexus window with mods still to get looks in the Downloads folder once; with every mod in it does not', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  const checks = f.calls.check;
  await f.nexus({ open: true, current: '35407', archives: { 35407: { state: 'done', percent: null }, 412: { state: 'waiting', percent: null } } });
  await f.nexus({ open: false, current: null, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'waiting', percent: null } } });
  await settle();
  assert.equal(f.calls.check, checks + 1, 'one check when the window closes (a browser download is found)');
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, checks + 1, 'and the focus right after starts none');
  const g = await fixture(t, modsLeft());
  const before = g.calls.check;
  await g.nexus(allDownloaded({ open: true }));
  await g.nexus(allDownloaded({ installQueued: true }));
  assert.equal(g.calls.check, before, 'every mod in: the install is already on its way');
});

test('the Nexus window\'s state comes from the launcher at start, so a reloaded page shows each download where it is', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }),
    { nexusAtStart: { open: true, current: '35407', account: { user: '' }, archives: { 35407: { state: 'downloading', percent: 40 }, 412: { state: 'waiting', percent: null } } } });
  await settle();
  // The window is open: the card says what to do there, its gold button brings it forward, and Verify shows each download
  // where it is, in the mods window's own rows
  assert.deepEqual([f.text('#notice-text'), f.play.textContent],
    ['The Nexus window is open. Press Slow download there for each mod. Once every mod is downloaded, the launcher installs them.', 'Show the Nexus window']);
  f.verify.click(); await settle(); await settle();
  assert.deepEqual([...f.d.querySelectorAll('#checks-list .check-row-line')].map(p => p.textContent), ['Version 5.2 · 2.2 MB · Downloading 40%', '742 KB']);
});

test('Settings, Mods shows the Nexus login the launcher keeps and logs it out, even when every mod is in', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) });
  f.$('#settings-open').click(); await settle();
  // No login kept: it says so plainly, and there is nothing to log out of
  assert.deepEqual([f.$('#nexus-section').hidden, f.text('#nexus-account'), f.$('#nexus-logout-row').hidden],
    [false, "The Nexus window is not logged in. You log in there when you download the mods in it.", true]);
  await f.nexus({ open: false, account: { user: 'Dragonborn' }, archives: {} });
  assert.deepEqual([f.text('#nexus-account'), f.$('#nexus-logout-row').hidden, f.$('#nexus-logout').disabled],
    ["The Nexus window is logged in as Dragonborn. The launcher keeps that login on this PC until you press Log out of the Nexus window.", false, false]);
  f.$('#nexus-logout').focus();
  f.$('#nexus-logout').click(); await settle(); await settle();
  assert.deepEqual([f.calls.game.at(-1), f.text('#nexus-status')], [['logoutNexus'], 'The Nexus window is logged out on this PC.']);
  // The launcher forgets the name: Log out goes, and keyboard focus goes back to the Mods tab rather than to nothing
  f.$('[data-tab="mods"]').click();
  f.$('#nexus-logout').focus();
  await f.nexus({ open: false, account: { user: '' }, archives: {} });
  assert.deepEqual([f.$('#nexus-logout-row').hidden, f.d.activeElement.id], [true, 'tab-mods-button']);
  await f.nexus({ open: false, account: { user: 'Dragonborn' }, archives: {} });
  f.gameAnswers.logoutNexus = async () => ({ success: false, error: 'Wait until the current download finishes, then press Log out of the Nexus window.' });
  f.$('#nexus-logout').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-status'), 'Wait until the current download finishes, then press Log out of the Nexus window.');
  f.gameAnswers.logoutNexus = async () => ({ success: false });
  f.$('#nexus-logout').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-status'), 'The launcher could not log the Nexus window out. Try again.');
  await f.nexus({ open: true, account: { user: '<img src=x onerror="window.executed=true">' }, archives: { 35407: { state: 'checking', percent: null } } });
  assert.deepEqual([f.$('#nexus-logout').disabled, f.$('#nexus-logout').title], [true, 'You can log out once the current download finishes.']);
  assert.match(f.text('#nexus-account'), /<img src=x/, 'a name is only ever text');
  assert.equal(f.d.querySelectorAll('#nexus-account img').length, 0);
  // Without Dovakarn's game (the test launcher) there is no Nexus window, so no section
  const g = await fixture(t);
  g.$('#settings-open').click(); await settle();
  assert.equal(g.$('#nexus-section').hidden, true);
});

test('downloaded but not installed: Verify, Settings and the mods window all say so, and never "Every mod is in"', async t => {
  const f = await fixture(t, modsLeft());
  await f.nexus(allDownloaded());
  f.$('#settings-open').click(); await settle();
  assert.equal(f.text('#mods-collection'), 'Every mod is downloaded. Press Install the mods on the main screen to put them in.');
  assert.deepEqual([...f.d.querySelectorAll('#copy-ticks li')].map(li => li.textContent).at(-1), 'Every mod downloaded, not installed yet');
  await f.nexus(allDownloaded({ installQueued: true }));
  assert.equal(f.text('#mods-collection'), 'Every mod is downloaded. The launcher installs them as soon as it is free.');
  f.$('#settings-done').click(); await settle();
  f.checkWith(async () => ({ success: false, error: '1 mod to download from Nexus Mods.', setup: 'mods' }));
  await f.nexus(allDownloaded());
  f.verify.click(); await settle(); await settle();
  assert.equal(f.checkText('Mods'), 'Every mod is downloaded. Press Install the mods on the main screen to put them in.');
});

test('Remove Dovakarn waits for the mods\' install, and the Nexus window closing for a Remove starts no check', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  f.$('#settings-open').click(); await settle();
  assert.equal(f.$('#copy-remove').disabled, false);
  // The install the Nexus window asked for waits its turn: nothing may start, Remove included, and the title says why
  await f.nexus(allDownloaded({ installQueued: true, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'done', percent: null } } }));
  assert.deepEqual([f.$('#copy-remove').disabled, f.$('#copy-remove').title], [true, 'You can remove it once the mods are installed.']);
  f.$('#settings-done').click(); await settle();
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Waiting to install the mods', true], 'the waiting install keeps its own words');
  f.verify.click(); await settle();
  assert.notEqual(f.text('#checks-title'), 'Checking...', 'an install waiting its turn is not a check running');
  f.$('#checks-close').click(); await settle();
  // Removing: the gold button says so, and neither the window closing nor coming back to the launcher starts a check
  const checks = f.calls.check;
  await f.nexus({ open: true, removing: true, current: '412', account: { user: '' }, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'downloading', percent: 10 } } });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Removing Dovakarn...', true]);
  await f.nexus({ open: false, removing: true, current: null, account: { user: '' }, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'waiting', percent: null } } });
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, checks, 'Remove closed the window: no check of a folder being removed');
  // Without a Remove, the same close looks for browser downloads once, as before
  await f.nexus({ open: true, removing: false, current: '412', account: { user: '' }, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'waiting', percent: null } } });
  await f.nexus({ open: false, removing: false, current: null, account: { user: '' }, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'waiting', percent: null } } });
  await settle();
  assert.equal(f.calls.check, checks + 1);
});

test('when the Nexus window cannot open, the mods window says why and offers the mod in the player\'s own browser, from Verify too', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  const LOCKED = 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Download again.';
  f.gameAnswers.downloadMods = async () => ({ success: false, error: LOCKED, browser: true });
  f.play.click(); await settle();
  f.d.querySelectorAll('#mods-needed li')[1].querySelector('button').click(); await settle(); await settle();
  const browser = f.$('#mods-browser-open');
  assert.deepEqual([f.text('#mods-status'), browser.hidden, browser.textContent, browser.getAttribute('aria-label')],
    [`${LOCKED} Or press Open in my browser to get Skyrim Script Extender (SKSE64) there.`, false, 'Open in my browser', 'Open Skyrim Script Extender (SKSE64) in my browser']);
  assert.equal(browser.parentElement, f.$('#mods-status').parentElement, 'the status and its browser button share one line');
  browser.click(); await settle(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['openInBrowser', '412'], 'that exact mod, in the browser');
  assert.equal(f.text('#mods-status'), 'Skyrim Script Extender (SKSE64) is open in your own browser. Download it there, then press Check my downloads.');
  // Download them all: the first one still to get
  f.$('#mods-all').click(); await settle(); await settle();
  browser.click(); await settle(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['openInBrowser', '35407']);
  // A refusal the browser does not get round (that mod is no longer needed): said, with no browser button
  f.gameAnswers.downloadMods = async () => ({ success: false, error: 'That mod is no longer needed. Press Check my downloads to refresh the list.' });
  f.$('#mods-all').click(); await settle(); await settle();
  assert.deepEqual([f.text('#mods-status'), browser.hidden], ['That mod is no longer needed. Press Check my downloads to refresh the list.', true]);
  // The window opening after all clears both
  f.gameAnswers.downloadMods = async () => ({ success: true });
  f.$('#mods-all').click(); await settle(); await settle();
  assert.deepEqual([f.text('#mods-status'), browser.hidden], ['', true]);
  // From Verify: the mods window opens to say it, never a silent press; a call that failed on its way says it plainly
  f.$('#mods-close').click(); await settle();
  f.gameAnswers.downloadMods = async () => { throw new Error("Error invoking remote method 'nexus:open': An object could not be cloned.") };
  f.verify.click(); await settle(); await settle();
  f.d.querySelector('#checks-list button[data-archive]').click(); await settle(); await settle();
  assert.deepEqual([f.checks.hidden, f.$('#mods').hidden, f.text('#mods-status'), browser.hidden],
    [true, false, 'The Nexus window could not open. Press Download again. If it still does not open, tell the Dovakarn staff. Or press Open in my browser to get SkyUI there.', false]);
  f.gameAnswers.openInBrowser = async () => ({ success: false });
  browser.click(); await settle(); await settle();
  assert.equal(f.text('#mods-status'), 'Your browser could not be opened. Set a default browser in Windows settings, then try again.');
});

test('My mods are in another folder: Windows\' folder picker, the folder kept, and a check that looks in it at once', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  f.play.click(); await settle();
  const folder = f.$('#mods-folder'), checks = f.calls.check;
  assert.deepEqual([folder.hidden, folder.disabled, folder.className], [false, false, 'link']);
  // Cancelled in the picker: nothing said, nothing checked
  folder.click(); await settle(); await settle();
  assert.deepEqual([f.calls.game.at(-1), f.text('#mods-status'), f.calls.check], [['addModsFolder'], '', checks]);
  f.gameAnswers.addModsFolder = async () => ({ success: false, error: 'That folder was not found. Choose another.' });
  folder.click(); await settle(); await settle();
  assert.deepEqual([f.text('#mods-status'), f.calls.check], ['That folder was not found. Choose another.', checks]);
  // Kept: the check runs at once and finds one of them there
  let seen = '';
  f.gameAnswers.addModsFolder = async () => ({ success: true, dir: 'D:\\Vortex Downloads\\skyrimse' });
  f.checkWith(async state => { seen = f.text('#mods-status'); state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods: mods.slice(1) }); return { success: false, error: '1 mod to download from Nexus Mods.', setup: 'mods' }; });
  folder.click(); await settle(); await settle(); await settle();
  assert.equal(seen, 'The launcher also looks in D:\\Vortex Downloads\\skyrimse now. Looking for your mods there...');
  assert.deepEqual([f.calls.check, f.text('#mods-status')], [checks + 1, '1 mod still to download.']);
  // Nothing may start while a check runs: the folder waits too
  let finish;
  f.checkWith(() => new Promise(resolve => { finish = resolve; }));
  f.$('#mods-again').click(); await settle();
  assert.equal(folder.disabled, true);
  finish({ success: true }); await settle(); await settle();
});

test('a folder of the player\'s own that gave no answer is named in the mods window, after whatever the window last said', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods, modsFolders: ['\\\\NAS\\mods', 'D:\\Mods'], modsFoldersSkipped: ['\\\\NAS\\mods'] }) }));
  f.play.click(); await settle();
  assert.equal(f.text('#mods-status'), '\\\\NAS\\mods did not answer, so the launcher did not look in it.');
  // After a press's own words, which come first
  f.checkWith(async state => { state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods, modsFolders: ['\\\\NAS\\mods', 'D:\\Mods'], modsFoldersSkipped: ['\\\\NAS\\mods', 'D:\\Mods'] }); return { success: false, error: '2 mods to download from Nexus Mods.', setup: 'mods' }; });
  f.$('#mods-again').click(); await settle(); await settle(); await settle();
  assert.equal(f.text('#mods-status'), '2 mods still to download. \\\\NAS\\mods and D:\\Mods did not answer, so the launcher did not look in them.');
  // A folder name is only ever text
  f.state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods, modsFoldersSkipped: ['<img src=x onerror="window.executed=true">', 5, ''] });
  await f.tick(); await settle();
  assert.equal(f.text('#mods-status'), '2 mods still to download. <img src=x onerror="window.executed=true"> did not answer, so the launcher did not look in it.');
  assert.deepEqual([f.d.querySelectorAll('#mods img').length, f.w.executed], [0, undefined]);
  // A later check that read every folder: the line goes, and the window's own words stay
  f.state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods, modsFoldersSkipped: [] });
  await f.tick(); await settle();
  assert.equal(f.text('#mods-status'), '2 mods still to download.');
  // Every mod downloaded: nothing left to look for, so no line about where the launcher looked
  f.state.gameCopy = copyState({ ready: true, missing: 0, todo: 0, mods, modsFoldersSkipped: ['\\\\NAS\\mods'] });
  await f.tick(); await settle();
  assert.match(f.text('#mods-status'), /NAS\\mods did not answer/);
  await f.nexus({ open: false, archives: { 35407: { state: 'done' }, 412: { state: 'done' } } });
  assert.equal(f.text('#mods-status'), '2 mods still to download.', 'the line about the folder goes; the window\'s own words stay until the next press');
});

test('the Mods card follows the Nexus window: what to press there while it is open, Show the Nexus window, and the install while it runs', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  assert.deepEqual([f.text('#notice-text'), f.play.textContent],
    ['They come from Nexus Mods with your own Nexus account. A free one works. Press Get the mods, then Download them all, and Nexus opens inside the launcher, where you log in to Nexus once. Once every mod is downloaded, the launcher installs them.', 'Get the mods']);
  await f.nexus({ open: true, current: '35407', archives: { 35407: { state: 'downloading', percent: 10 }, 412: { state: 'waiting', percent: null } } });
  assert.deepEqual([f.text('#notice-title'), f.text('#notice-text'), f.play.textContent, f.play.disabled],
    ['2 mods to download', 'The Nexus window is open. Press Slow download there for each mod. Once every mod is downloaded, the launcher installs them.', 'Show the Nexus window', false]);
  f.play.click(); await settle(); await settle();
  assert.deepEqual([f.calls.game.at(-1), f.$('#mods').hidden], [['downloadMods', null], true], 'brought forward wherever it is, nothing else opens');
  // It could not come forward after all: the mods window opens to say why
  f.gameAnswers.downloadMods = async () => ({ success: false, error: 'The Nexus window could not open. Press Download again. If it still does not open, tell the Dovakarn staff.', browser: true });
  f.play.click(); await settle(); await settle();
  assert.equal(f.$('#mods').hidden, false);
  f.$('#mods-close').click(); await settle();
  // Closed again: Get the mods
  await f.nexus({ open: false, current: null, archives: { 35407: { state: 'waiting', percent: null }, 412: { state: 'waiting', percent: null } } });
  assert.equal(f.play.textContent, 'Get the mods');
  // Every mod downloaded and installing: the card says so
  await f.nexus({ open: false, installQueued: true, installing: true, current: null, archives: { 35407: { state: 'done', percent: null }, 412: { state: 'done', percent: null } } });
  assert.deepEqual([f.text('#notice-title'), f.text('#notice-text'), f.play.textContent, f.play.disabled],
    ['Every mod is downloaded', 'The launcher is installing them now.', 'Installing mods...', true]);
});

test('the mods window once every mod is downloaded: Install the mods there, the next step while the install waits; the list and Check my downloads go', async t => {
  const f = await fixture(t, modsLeft());
  f.play.click(); await settle();
  assert.deepEqual([f.text('#mods-all'), f.$('#mods-again').hidden, f.$('#mods-more').hidden], ['Download them all', false, false]);
  // The last one came in while the window was open, and nothing waits to install them: the gold button installs them
  await f.nexus(allDownloaded());
  const all = f.$('#mods-all');
  assert.deepEqual([f.text('#mods-title'), f.text('#mods-intro'), all.textContent, all.hidden, all.disabled, f.$('#mods-again').hidden, f.$('#mods-more').hidden, f.$('#mods-needed').hidden],
    ['Every mod is downloaded', "Press Install the mods to put them into Dovakarn's game.", 'Install the mods', false, false, true, true, false]);
  assert.doesNotMatch(f.text('#mods-intro'), /[();]/);
  // Skyrim running: it cannot install now, and says why
  f.state.gameRunning = true; await f.tick(); await settle();
  assert.deepEqual([all.disabled, all.title], [true, 'Close Skyrim first.']);
  f.state.gameRunning = false; await f.tick(); await settle();
  assert.deepEqual([all.disabled, all.title], [false, '']);
  const checks = f.calls.check;
  all.click(); await settle(); await settle();
  assert.deepEqual([f.calls.check, f.$('#mods').hidden], [checks + 1, true], 'one press, one check that installs them, and the main screen follows it');
  // The install the Nexus window asked for waits its turn: no gold button, the next step said
  const g = await fixture(t, modsLeft());
  g.play.click(); await settle();
  await g.nexus(allDownloaded({ installQueued: true }));
  assert.deepEqual([g.text('#mods-intro'), g.$('#mods-all').hidden, g.$('#mods-again').hidden], ['The launcher installs them as soon as it is free.', true, true]);
});

test('Verify\'s mod rows are the mods window\'s own: Download, Show while it runs, Wrong file, Did not download, and Downloaded with a tick', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 },
    { id: '454617', name: 'TrueHUD', version: '1.1.9', size: 305668, files: 3 }, { id: '469854', name: 'XPMSSE', version: '5.06', size: 2365019, files: 9 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  f.checkWith(async () => ({ success: false, error: '3 mods to download from Nexus Mods.', setup: 'mods' }));
  await f.nexus({ open: true, current: '35407', archives: { 35407: { state: 'downloading', percent: 63 }, 412: { state: 'done', percent: null }, 454617: { state: 'wrong', percent: null }, 469854: { state: 'failed', percent: null } } });
  f.verify.click(); await settle(); await settle();
  const rows = () => [...f.d.querySelectorAll('#checks-list .check-list li')];
  const seen = rows().map(li => { const b = li.querySelector('button'); return [li.querySelector('.check-row-name').textContent, li.querySelector('.check-row-line').textContent, b.hidden ? null : b.textContent, b.getAttribute('aria-label')]; });
  assert.deepEqual(seen, [
    ['SkyUI', 'Version 5.2 · 2.2 MB · Downloading 63%', 'Show', 'Show the Nexus window'],
    ['Skyrim Script Extender (SKSE64)', 'Downloaded', null, 'Download Skyrim Script Extender (SKSE64) from Nexus Mods'],
    ['TrueHUD', 'Version 1.1.9 · 299 KB · Wrong file: press Download to try again', 'Download', 'Download TrueHUD from Nexus Mods'],
    ['XPMSSE', 'Version 5.06 · 2.3 MB · Did not download: press Download to try again', 'Download', 'Download XPMSSE from Nexus Mods'],
  ]);
  assert.equal(rows()[1].querySelectorAll('.check-row-line svg').length, 1, 'the tick, as in the mods window');
  assert.deepEqual([...rows()[0].querySelectorAll('.check-row-line .pct-sign')].map(e => e.textContent), ['%']);
  rows()[0].querySelector('button').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', null], 'Show brings the Nexus window forward, never a second download');
  rows()[2].querySelector('button').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', '454617']);
});

test('Settings, Mods offers Log out of Nexus whenever there may be a login, says why it is greyed out, and clears its old line', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) });
  f.$('#settings-open').click(); await settle();
  f.$('[data-tab="mods"]').click();
  const say = () => [f.text('#nexus-account'), f.$('#nexus-logout-row').hidden];
  // Logged in, and Nexus showed no name: logged in all the same, with Log out
  await f.nexus({ open: false, account: { user: '', login: 'in', kept: true }, archives: {} });
  assert.deepEqual([...say(), f.$('#nexus-logout').disabled, f.$('#nexus-logout-why').hidden],
    ["The Nexus window is logged in. The launcher keeps that login on this PC until you press Log out of the Nexus window.", false, false, true]);
  // Not known either way while the window's session keeps something: Log out offered, never a player left with no way out
  await f.nexus({ open: false, account: { user: '', login: 'unknown', kept: true }, archives: {} });
  assert.deepEqual(say(), ["The Nexus window may still be logged in to Nexus on this PC. Press Log out of the Nexus window to be sure it is not.", false]);
  // Nothing kept, or logged out: nothing to log out of
  for (const account of [{ user: '', login: 'unknown', kept: false }, { user: '', login: 'out', kept: true }]) {
    await f.nexus({ open: false, account, archives: {} });
    assert.deepEqual(say(), ["The Nexus window is not logged in. You log in there when you download the mods in it.", true], JSON.stringify(account));
  }
  // An older launcher's state, a name with no login said: logged in
  await f.nexus({ open: false, account: { user: 'Dragonborn' }, archives: {} });
  assert.deepEqual(say(), ["The Nexus window is logged in as Dragonborn. The launcher keeps that login on this PC until you press Log out of the Nexus window.", false]);
  // A download running: greyed out, and why is said on the page, not only in a tooltip
  await f.nexus({ open: true, account: { user: 'Dragonborn', login: 'in', kept: true }, archives: { 35407: { state: 'downloading', percent: 5 } } });
  assert.deepEqual([f.$('#nexus-logout').disabled, f.$('#nexus-logout-why').hidden, f.text('#nexus-logout-why'), f.$('#nexus-logout').title],
    [true, false, 'You can log out once the current download finishes.', 'You can log out once the current download finishes.']);
  // Its line goes when the login changes...
  await f.nexus({ open: false, account: { user: 'Dragonborn', login: 'in', kept: true }, archives: {} });
  assert.equal(f.$('#nexus-logout-why').hidden, true);
  f.gameAnswers.logoutNexus = async () => ({ success: false, error: 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Log out of the Nexus window again.' });
  f.$('#nexus-logout').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-status'), 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Log out of the Nexus window again.');
  await f.nexus({ open: false, account: { user: '', login: 'out', kept: true }, archives: {} });
  assert.equal(f.text('#nexus-status'), '', 'the login changed: the old line no longer applies');
  // ...and when Settings opens again
  await f.nexus({ open: false, account: { user: 'Dragonborn', login: 'in', kept: true }, archives: {} });
  f.$('#nexus-logout').click(); await settle(); await settle();
  assert.notEqual(f.text('#nexus-status'), '');
  f.$('#settings-done').click(); await settle();
  f.$('#settings-open').click(); await settle();
  assert.equal(f.text('#nexus-status'), '', 'Settings opens fresh');
  // A logout that worked keeps its line, though its push changes the login first
  f.gameAnswers.logoutNexus = async () => { await f.nexus({ open: false, account: { user: '', login: 'out', kept: true }, archives: {} }); return { success: true }; };
  f.$('[data-tab="mods"]').click();
  f.$('#nexus-logout').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-status'), 'The Nexus window is logged out on this PC.');
});

test('Settings, Mods lists the player\'s own mod folders, each with Forget, and the launcher stops looking there', async t => {
  const dirs = ['D:\\Vortex Downloads\\skyrimse', '\\\\NAS\\mods', '<img src=x onerror="window.executed=true">'];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null, modsFolders: dirs }) });
  f.$('#settings-open').click(); await settle();
  f.$('[data-tab="mods"]').click();
  const rows = () => [...f.d.querySelectorAll('#mods-folders li')].map(li => [li.querySelector('.folder-path span').textContent, li.querySelector('button').textContent, li.querySelector('button').getAttribute('aria-label'), li.querySelectorAll('svg').length]);
  assert.deepEqual([f.$('#folders-section').hidden, rows()], [false, dirs.map(d => [d, 'Forget', `Forget ${d}`, 1])]);
  assert.equal(f.d.querySelectorAll('#mods-folders img').length, 0, 'a folder name is only ever text');
  // Forget: the launcher stops looking there, says so, and keyboard focus moves to the Forget now in its place
  const first = f.$('#mods-folders button');
  first.focus(); first.click(); await settle(); await settle(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['forgetModsFolder', dirs[0]]);
  assert.equal(f.text('#folders-status'), `The launcher no longer looks in ${dirs[0]}.`);
  assert.deepEqual(rows().map(r => r[0]), dirs.slice(1));
  assert.equal(f.d.activeElement.dataset.dir, dirs[1]);
  // Refused: said
  f.gameAnswers.forgetModsFolder = async () => ({ success: false, error: 'That folder is not one the launcher looks in.' });
  f.$('#mods-folders button').click(); await settle(); await settle();
  assert.equal(f.text('#folders-status'), 'That folder is not one the launcher looks in.');
  // The last ones forgotten: the section goes, and keyboard focus goes back to the Mods tab
  f.gameAnswers.forgetModsFolder = async (state) => { state.gameCopy = { ...state.gameCopy, modsFolders: [] }; return { success: true }; };
  const last = f.$('#mods-folders button').dataset.dir;
  f.$('#mods-folders button').focus(); f.$('#mods-folders button').click(); await settle(); await settle(); await settle();
  assert.deepEqual([f.$('#folders-section').hidden, f.d.activeElement.id], [true, 'tab-mods-button']);
  // ...and its confirmation stays in sight: the line sits outside the section that went
  assert.deepEqual([f.text('#folders-status'), !!f.$('#folders-status').closest('[hidden]'), f.$('#folders-section').contains(f.$('#folders-status'))],
    [`The launcher no longer looks in ${last}.`, false, false]);
  assert.equal(f.w.executed, undefined);
  // Settings opens fresh
  f.$('#settings-done').click(); await settle();
  f.$('#settings-open').click(); await settle();
  assert.equal(f.text('#folders-status'), '');
  // Without Dovakarn's game: no section
  const g = await fixture(t);
  g.$('#settings-open').click(); await settle();
  assert.equal(g.$('#folders-section').hidden, true);
});

test('Remove\'s confirm dialog open: nothing starts and the gold button keeps its words; confirmed: Removing Dovakarn', async t => {
  const mods = [...ONE_MOD, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, modsLeft({ gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }) }));
  const waiting = { 35407: { state: 'waiting', percent: null }, 412: { state: 'waiting', percent: null } };
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Get the mods', false]);
  const checks = f.calls.check;
  // The dialog is open: the player may still press Cancel, so nothing says Dovakarn is being removed yet
  await f.nexus({ open: false, removeAsking: true, archives: waiting });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Get the mods', true]);
  f.$('#settings-open').click(); await settle();
  assert.deepEqual([f.$('#copy-remove').disabled, f.$('#copy-remove').title], [true, '']);
  f.$('#settings-done').click(); await settle();
  // Coming back to the launcher (the dialog closing gives it focus) and the Nexus window closing start no check
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  await f.nexus({ open: true, removeAsking: true, current: '412', archives: waiting });
  await f.nexus({ open: false, removeAsking: true, current: null, archives: waiting });
  await settle();
  assert.equal(f.calls.check, checks, 'no check while Remove is being decided');
  // Confirmed: now it says so
  await f.nexus({ open: false, removing: true, archives: waiting });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Removing Dovakarn...', true]);
  // Cancelled: everything as it was, and coming back checks again as usual
  await f.nexus({ open: false, archives: waiting });
  assert.deepEqual([f.play.textContent, f.play.disabled], ['Get the mods', false]);
  f.w.dispatchEvent(new f.w.Event('focus')); await settle();
  assert.equal(f.calls.check, checks + 1);
});

test('Verify\'s line for what passed reads as a sentence: a capital only at its start and for names', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, fileList: fileList(), gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }),
    lastCheck: passed({ unfixed: [{ fix: 'Smooth Moveset patch', reason: 'its file was not found' }] }) });
  f.verify.click(); await settle(); await settle();
  assert.deepEqual(f.checkTitles().map(([title]) => title), ['Server mod fixes', 'Everything else is fine']);
  assert.equal(f.checkText('Everything else is fine'), "Dovakarn's game, mods and game files.");
});

// ---- The player's Nexus account (nexusAccount.js) and the automatic download it allows with Nexus Premium ----
const NEXUS_OFF = { loggedIn: false, account: null, pending: false, error: null, available: false };
const NEXUS_READY = { ...NEXUS_OFF, available: true };
const PREMIUM = { loggedIn: true, account: { name: 'Dragonborn', premium: true }, pending: false, error: null };
const FREE = { loggedIn: true, account: { name: 'Dragonborn', premium: false }, pending: false, error: null };
const held = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

test("Settings, Mods: Log in to Nexus in the player's own browser, the account and Premium named, and Log out", async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) }, { nexusMe: NEXUS_READY });
  f.$('#settings-open').click(); await settle(); await settle();
  const buttons = () => ['#nexus-me-login', '#nexus-me-cancel', '#nexus-me-logout'].map(id => f.$(id).hidden);
  assert.equal(f.text('#nexus-me'), 'Log in to Nexus with a Premium account and the mods download by themselves. A free account downloads them in the Nexus window.');
  assert.deepEqual(buttons(), [false, true, true]);
  // The browser login waits: Cancel in its place
  const gate = held();
  f.nexusLoginWith(async () => { await f.nexusMe({ pending: true }); await gate.promise; return { success: true, state: PREMIUM }; });
  // The account row is on the Mods tab: a button in a hidden tab cannot take focus, in Chromium or in jsdom
  f.$('#tab-mods-button').click();
  f.$('#nexus-me-login').focus();
  assert.equal(f.d.activeElement.id, 'nexus-me-login');
  f.$('#nexus-me-login').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me'), 'Finish logging in to Nexus in your browser.');
  assert.deepEqual(buttons(), [true, false, true]);
  assert.equal(f.d.activeElement.id, 'nexus-me-cancel', 'keyboard focus follows to Cancel');
  gate.release(); await settle(); await settle(); await settle();
  assert.equal(f.text('#nexus-me'), 'Logged in to Nexus as Dragonborn, with Nexus Premium.', 'every mod is in: no Download them all to point at');
  assert.equal(f.text('#nexus-me-status'), 'Logged in to Nexus as Dragonborn, with Nexus Premium.');
  assert.deepEqual(buttons(), [true, true, false]);
  f.$('#nexus-me-logout').click(); await settle(); await settle();
  assert.deepEqual([f.calls.nexusMe.filter(c => c !== 'state'), f.text('#nexus-me-status'), buttons()], [['login', 'logout'], 'Logged out of Nexus on this PC.', [false, true, true]]);
  // A free account: said plainly, the window stays the way in
  f.nexusLoginWith(async () => ({ success: true, state: FREE }));
  f.$('#nexus-me-login').click(); await settle(); await settle(); await settle();
  assert.equal(f.text('#nexus-me-status'), 'Logged in to Nexus as Dragonborn. It is a free account, so the mods still download in the Nexus window.');
  assert.equal(f.text('#nexus-me'), 'Logged in to Nexus as Dragonborn. Only Nexus Premium members get the mods downloaded by themselves, so yours download in the Nexus window.');
  // A cancel, and a refusal, in plain words
  await f.nexusMe({ loggedIn: false, account: null });
  f.nexusLoginWith(async () => ({ success: false, code: 'cancelled', error: 'Login cancelled.', state: NEXUS_READY }));
  f.$('#nexus-me-login').click(); await settle(); await settle(); await settle();
  assert.equal(f.text('#nexus-me-status'), 'Nexus login cancelled.');
  f.nexusLoginWith(async () => ({ success: false, code: 'portsBusy', error: 'Another program is using the Nexus login ports: 41794, 41795. Close it and try again.', state: { ...NEXUS_READY, error: 'Another program is using the Nexus login ports: 41794, 41795. Close it and try again.', ended: false } }));
  f.$('#nexus-me-login').click(); await settle(); await settle(); await settle();
  assert.equal(f.text('#nexus-me-status'), 'Another program is using the Nexus login ports: 41794, 41795. Close it and try again.');
  assert.equal(f.text('#nexus-me'), 'Log in to Nexus with a Premium account and the mods download by themselves. A free account downloads them in the Nexus window.', 'the error is said once, under the buttons');
  // A name is only ever text
  await f.nexusMe({ loggedIn: true, account: { name: '<img src=x onerror="window.executed=true">', premium: true } });
  assert.match(f.text('#nexus-me'), /<img src=x/);
  assert.equal(f.d.querySelectorAll('#nexus-section img').length, 0);
  // Reopening Settings clears what an earlier visit said, and asks the launcher afresh
  const asked = f.calls.nexusMe.filter(c => c === 'state').length;
  f.$('#settings-done').click(); f.$('#settings-open').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me-status'), '');
  assert.equal(f.calls.nexusMe.filter(c => c === 'state').length, asked + 1);
});

test('Settings, Mods without Nexus login on the server: said plainly, with no button that cannot work', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) });
  f.$('#settings-open').click(); await settle(); await settle();
  assert.deepEqual([f.text('#nexus-me'), f.$('#nexus-me-row').hidden],
    ['Logging in to Nexus from the launcher is not switched on for Dovakarn yet. The mods download in the Nexus window.', true]);
});

test('the mods window offers Log in to Nexus for Premium while mods are left; Cancel while the browser waits; none for a free account', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 1 },
    phase: { stage: 'modsNeeded', message: '1 mod to download from Nexus Mods.' } }, { nexusMe: NEXUS_READY });
  f.play.click(); await settle(); await settle();
  assert.deepEqual([f.$('#mods-premium').hidden, f.text('#mods-premium-line'), f.text('#mods-premium-login')],
    [false, 'Got Nexus Premium? Log in to Nexus and the mods download by themselves.', 'Log in to Nexus']);
  f.nexusLoginWaits();
  f.$('#mods-premium-login').click(); await settle(); await settle();
  assert.deepEqual([f.text('#mods-premium-line'), f.text('#mods-premium-login')], ['Finish logging in to Nexus in your browser.', 'Cancel']);
  f.$('#mods-premium-login').click(); await settle(); await settle(); await settle();
  assert.equal(f.calls.nexusMe.filter(c => c === 'cancel').length, 1, 'the same button cancels');
  assert.deepEqual([f.text('#mods-status'), f.text('#mods-premium-login')], ['Nexus login cancelled.', 'Log in to Nexus'], 'said where it was pressed, and the offer is back');
  f.nexusLoginWith(async () => ({ success: true, state: FREE }));
  f.$('#mods-premium-login').click(); await settle(); await settle(); await settle();
  assert.equal(f.$('#mods-premium').hidden, true, 'logged in: no offer');
  assert.equal(f.text('#mods-status'), 'Logged in to Nexus as Dragonborn. It is a free account, so the mods still download in the Nexus window.');
  assert.equal(f.text('#mods-intro'), 'Press Download them all and Nexus opens inside the launcher. Log in once. A free account works. Then press Slow download for each mod, and the launcher takes each file by itself.');
  // Without Nexus login on the server there is nothing to offer
  const g = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 1 } });
  g.play.click(); await settle(); await settle();
  assert.equal(g.$('#mods-premium').hidden, true);
});

test('with Nexus Premium the mods download by themselves: the card and the window say so, rows follow with no Show, Stop takes the gold button\'s place, and what could not download offers the Nexus window', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 2 },
    phase: { stage: 'modsNeeded', message: '2 mods to download from Nexus Mods.' } }, { nexusMe: { ...PREMIUM, available: true } });
  await f.nexus({ open: false, premium: true, archives: {} });
  assert.deepEqual([f.text('#notice-title'), f.text('#notice-text'), f.play.textContent],
    ['2 mods to download', 'Your Nexus Premium account downloads them for you. Press Get the mods, then Download them all. Once every mod is in, the launcher installs them.', 'Get the mods']);
  f.play.click(); await settle(); await settle();
  assert.deepEqual([f.text('#mods-intro'), f.$('#mods-premium').hidden, f.$('#mods-stop').hidden, f.$('#mods-window').hidden],
    ['Press Download them all and the launcher downloads every mod for you with your Nexus Premium account, one after another.', true, true, true]);
  f.$('#mods-all').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', null]);
  // Running: progress on the rows, no Download or Show on any row, Stop where the gold button was
  f.$('#mods-all').focus();
  await f.nexus({ open: false, premium: true, direct: { running: true, problem: null }, archives: { 35407: { state: 'downloading', percent: 40 }, 412: { state: 'waiting', percent: null } } });
  const rows = () => [...f.d.querySelectorAll('#mods-needed li')];
  assert.equal(f.text('#mods-intro'), 'Downloading every mod from Nexus with your Premium account. You can close this window: the downloads carry on.');
  assert.deepEqual(rows().map(li => [li.querySelector('p').textContent, li.querySelector('button').hidden]), [['Version 5.2 · 2.2 MB · Downloading 40%', true], ['742 KB', true]]);
  assert.deepEqual([f.$('#mods-all').hidden, f.$('#mods-stop').hidden, f.d.activeElement.id], [true, false, 'mods-close'], 'keyboard focus goes to Close, never to Stop, where a held key would stop the run');
  assert.deepEqual([f.$('#mods-again').hidden, f.$('#mods-more').hidden], [true, true], 'no looking in folders while the mods download by themselves');
  assert.deepEqual([f.text('#notice-text'), f.play.textContent], ['They are downloading from Nexus with your Premium account. Once every mod is in, the launcher installs them.', 'Show the downloads']);
  f.$('#mods-stop').click(); await settle();
  assert.deepEqual([f.calls.game.at(-1), f.text('#mods-status')], [['stopDownloads'], 'Stopped. The mods already downloaded stay.']);
  // Ended with one it could not get: said, and the Nexus window offered for it
  await f.nexus({ open: false, premium: true, direct: { running: false, problem: { kind: 'some', message: 'SkyUI could not download by itself. Press Download them all to try again, or use the Nexus window.' } },
    archives: { 35407: { state: 'failed', percent: null }, 412: { state: 'done', percent: null } } });
  f.$('#mods-close').click(); await settle();
  f.play.click(); await settle(); await settle();
  assert.equal(f.text('#mods-status'), 'SkyUI could not download by itself. Press Download them all to try again, or use the Nexus window.');
  assert.deepEqual([f.$('#mods-window').hidden, f.$('#mods-all').hidden, f.$('#mods-stop').hidden], [false, false, true]);
  f.$('#mods-window').click(); await settle();
  assert.deepEqual(f.calls.game.at(-1), ['downloadMods', null, 'window'], 'the Nexus window, even with Premium');
});

test('Premium with the Nexus window open: the card and the mods window speak of the window, never of downloading by themselves', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 1 } }, { nexusMe: { ...PREMIUM, available: true } });
  await f.nexus({ open: true, premium: true, direct: { running: false, problem: { kind: 'some', message: 'SkyUI could not download by itself. Press Download them all to try again, or use the Nexus window.' } }, archives: { 35407: { state: 'failed', percent: null } } });
  assert.deepEqual([f.text('#notice-text'), f.play.textContent], ['The Nexus window is open. Press Slow download there for each mod. Once every mod is downloaded, the launcher installs them.', 'Show the Nexus window']);
  f.$('#verify').click(); await settle();
  f.$('#checks-close').click(); await settle();
  f.play.click(); await settle(); await settle();
  assert.equal(f.text('#mods-intro'), 'Press Download them all and Nexus opens inside the launcher. Log in once. A free account works. Then press Slow download for each mod, and the launcher takes each file by itself.');
  assert.deepEqual([f.text('#mods-status'), f.$('#mods-window').hidden], ['', true], 'the window is the way round it, and it is open');
});

test('while the mods download by themselves: the window opens on Close, failed rows say when they are tried again, Stop says so only when it stopped something, and Log out says the download stopped', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 2 } }, { nexusMe: { ...PREMIUM, available: true } });
  await f.nexus({ open: false, premium: true, direct: { running: true, problem: null }, archives: { 35407: { state: 'failed', percent: null }, 412: { state: 'downloading', percent: 10 } } });
  f.play.click(); await settle(); await settle();
  assert.equal(f.d.activeElement.id, 'mods-close', 'never on Stop, where a stray key press would stop them');
  assert.equal(f.d.querySelector('#mods-needed li p').textContent, 'Version 5.2 · 2.2 MB · Did not download: Download them all tries it again once this run ends');
  f.$('#mods-stop').click(); await settle(); await settle();
  assert.equal(f.text('#mods-status'), 'Stopped. The mods already downloaded stay.');
  // The run ended in the launcher before this press, and the page has not heard yet: the launcher says nothing was stopped
  f.$('#mods-close').click(); await settle();
  f.play.click(); await settle(); await settle();
  assert.equal(f.$('#mods-stop').hidden, false, 'the page still shows the run');
  f.gameAnswers.stopped = false;
  f.$('#mods-stop').click(); await settle(); await settle();
  assert.equal(f.text('#mods-status'), '', 'nothing said when nothing was stopped');
  f.gameAnswers.stopped = true;
  // Log out during a run
  await f.nexus({ open: false, premium: true, direct: { running: true, problem: null }, archives: { 35407: { state: 'downloading', percent: 3 }, 412: { state: 'waiting', percent: null } } });
  f.$('#mods-close').click();
  f.$('#settings-open').click(); await settle(); await settle();
  f.$('#nexus-me-logout').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me-status'), 'Logged out of Nexus on this PC. The automatic download stopped; the mods already downloaded stay.');
  // The page still shows a run, but it had ended in the launcher: only the logout is said
  await f.nexusMe({ loggedIn: true, account: { name: 'Dragonborn', premium: true } });
  f.gameAnswers.stopped = false;
  f.$('#nexus-me-logout').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me-status'), 'Logged out of Nexus on this PC.');
});

test('Settings says plainly when the Dovakarn server could not be asked about Nexus login, and why a login ended', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) }, { nexusMe: { ...NEXUS_OFF, available: null } });
  f.$('#settings-open').click(); await settle(); await settle();
  assert.deepEqual([f.text('#nexus-me'), f.$('#nexus-me-row').hidden], ['The launcher could not reach the Dovakarn server to check Nexus login. Close Settings and open it again to try again.', true]);
  // A failed login press's own error is said under the buttons, not here
  await f.nexusMe({ available: true, error: 'Another program is using the Nexus login ports: 41794. Close it and try again.', ended: false });
  f.$('#settings-done').click(); f.$('#settings-open').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me'), 'Log in to Nexus with a Premium account and the mods download by themselves. A free account downloads them in the Nexus window.');
  await f.nexusMe({ available: true, error: 'Your Nexus login has ended. Log in to Nexus again.', ended: true });
  f.$('#settings-done').click(); f.$('#settings-open').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me'), 'Your Nexus login has ended. Log in to Nexus again. Log in to Nexus with a Premium account and the mods download by themselves. A free account downloads them in the Nexus window.');
  assert.equal(f.$('#nexus-me-login').hidden, false);
});

test('a row\'s Download that starts the automatic download keeps keyboard focus in the window; Settings says the mods are downloading; no window offer when another launcher holds Nexus', async t => {
  const mods = [{ id: '35407', name: 'SkyUI', version: '5.2', size: 2.3e6, files: 22 }, { id: '412', name: 'Skyrim Script Extender (SKSE64)', size: 760000, files: 64 }];
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods }), lastCheck: { at: Date.now(), published: true, setup: 'mods', mods: 2 } }, { nexusMe: { ...PREMIUM, available: true } });
  await f.nexus({ open: false, premium: true, archives: {} });
  f.play.click(); await settle(); await settle();
  const row = f.d.querySelectorAll('#mods-needed button[data-archive]')[1];
  row.focus();
  await f.nexus({ open: false, premium: true, direct: { running: true, problem: null }, archives: { 35407: { state: 'waiting', percent: null }, 412: { state: 'downloading', percent: 0 } } });
  assert.equal(f.d.activeElement.id, 'mods-close', 'its button went: focus stays in the window');
  // Verify's rows the same
  f.$('#mods-close').click(); await settle();
  await f.nexus({ open: false, premium: true, archives: {} });
  f.$('#verify').click(); await settle();
  const verifyRow = [...f.d.querySelectorAll('#checks-list button[data-archive]')].find(b => !b.hidden);
  verifyRow.focus();
  await f.nexus({ open: false, premium: true, direct: { running: true, problem: null }, archives: { 35407: { state: 'downloading', percent: 0 } } });
  assert.equal(f.d.activeElement.id, 'checks-close');
  f.$('#checks-close').click(); await settle();
  f.$('#settings-open').click(); await settle(); await settle();
  assert.equal(f.text('#nexus-me'), 'Logged in to Nexus as Dragonborn, with Nexus Premium. The mods are downloading by themselves now.');
  f.$('#settings-done').click(); await settle();
  await f.nexus({ open: false, premium: true, direct: { running: false, problem: { kind: 'locked', message: 'Another Dovakarn launcher is open and already using Nexus. Close it, then press Download them all again.' } }, archives: {} });
  f.play.click(); await settle(); await settle();
  assert.deepEqual([f.text('#mods-status'), f.$('#mods-window').hidden], ['Another Dovakarn launcher is open and already using Nexus. Close it, then press Download them all again.', true], 'the Nexus window takes the same lock');
});

test('Settings, Mods: when the browser has already moved focus off a hidden account button to the page, the next redraw puts it on the button in its place', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) }, { nexusMe: NEXUS_READY });
  f.$('#settings-open').click(); await settle(); await settle();
  f.$('#tab-mods-button').click();
  f.$('#nexus-me-login').focus();
  assert.equal(f.d.activeElement.id, 'nexus-me-login');
  // Chromium's focus fixup: the focused button is hidden and focus falls to the page, with no focusin anywhere.
  // jsdom keeps focus on a hidden button, so the test moves it to the page first and then hides the button
  f.$('#nexus-me-login').blur();
  f.$('#nexus-me-login').hidden = true;
  assert.equal(f.d.activeElement, f.d.body);
  await f.nexusMe({ pending: true });
  assert.equal(f.d.activeElement.id, 'nexus-me-cancel', 'focus comes back to the row, on Cancel');
  // Focus that went anywhere else is left there
  f.$('#settings-done').focus();
  await f.nexusMe({ pending: false });
  assert.equal(f.d.activeElement.id, 'settings-done');
});

test('Settings, Mods: focus the player moved off a showing account button, or a click outside the row, is never taken back by a redraw', async t => {
  const f = await fixture(t, { mode: 'online', serverOnline: true, gameCopy: copyState({ ready: true, missing: 0, todo: 0, mods: null }) }, { nexusMe: NEXUS_READY });
  f.$('#settings-open').click(); await settle(); await settle();
  f.$('#tab-mods-button').click();
  // Blurred with the button still showing (as a click on an empty part of Settings does): every redraw leaves it on the page
  f.$('#nexus-me-login').focus();
  f.$('#nexus-me-login').blur();
  assert.equal(f.d.activeElement, f.d.body);
  await f.nexusMe({});
  assert.equal(f.d.activeElement, f.d.body, 'the first redraw leaves focus on the page');
  // The row's memory is used by one redraw only: once a redraw has found focus on the page, the button being hidden
  // later does not bring it back
  f.$('#nexus-me-login').hidden = true;
  await f.nexusMe({ pending: true });
  assert.equal(f.d.activeElement, f.d.body, 'and so does the next, after the button is hidden');
  // A click outside the row forgets it, even when the button it was on is hidden before the next redraw
  f.$('#nexus-me-cancel').focus();
  f.$('#settings').dispatchEvent(new f.w.Event('pointerdown', { bubbles: true }));
  f.$('#nexus-me-cancel').blur();
  f.$('#nexus-me-cancel').hidden = true;
  await f.nexusMe({ pending: false });
  assert.equal(f.d.activeElement, f.d.body, 'clicked outside the row: focus stays on the page');
});
