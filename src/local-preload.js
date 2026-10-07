const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('localPlay', {
  state: () => ipcRenderer.invoke('local-play:state'),
  play: options => ipcRenderer.invoke('local-play:play', options),
  check: () => ipcRenderer.invoke('local-play:check'),
  // Stops a running check or game-file update; files already fetched are kept
  cancel: () => ipcRenderer.invoke('local-play:cancel'),
  openCollection: () => ipcRenderer.invoke('local-play:collection'),
  openMod: modId => ipcRenderer.invoke('local-play:mod', modId),
  chooseFolder: () => ipcRenderer.invoke('local-play:chooseFolder'),
  openGameFolder: () => ipcRenderer.invoke('local-play:openGameFolder'),
  onProgress: callback => ipcRenderer.on('local-play:progress', (_event, value) => callback(value)),
  // The notice board's Updates for the main screen, with the ones posted since the launcher was last opened
  updates: () => ipcRenderer.invoke('local-play:updates'),
  // Dovakarn's own game copy (gameSetup.js): where it goes, making it, Steam's console, the mods' downloads from Nexus, removing it
  game: {
    chooseInstall: () => ipcRenderer.invoke('game:chooseInstall'),
    setup: () => ipcRenderer.invoke('game:setup'),
    openConsole: () => ipcRenderer.invoke('game:openConsole'),
    copy: value => ipcRenderer.invoke('game:copyText', value),
    // One needed download, or the first still to get (id null): by themselves for a logged-in Premium member, else the
    // launcher's own Nexus window; useWindow asks for the window whatever the account
    downloadMods: (id, useWindow) => ipcRenderer.invoke('nexus:open', { archive: typeof id === 'string' ? id : null, window: useWindow === true }),
    // Stops the automatic download; the mods already in stay
    stopDownloads: () => ipcRenderer.invoke('nexus:stop'),
    // Each needed download's state while the Nexus window works (nexusDownloads.js snapshot): once now, then as it changes
    downloads: () => ipcRenderer.invoke('nexus:snapshot'),
    onDownloads: callback => ipcRenderer.on('nexus:state', (_event, value) => callback(value)),
    // Settings, Mods: forget the Nexus login the launcher's Nexus window keeps on this PC
    logoutNexus: () => ipcRenderer.invoke('nexus:logout'),
    // When the Nexus window could not open: that needed download's exact Nexus page in the player's own browser
    openInBrowser: id => ipcRenderer.invoke('nexus:browser', { archive: typeof id === 'string' ? id : null }),
    // The mods window's "My mods are in another folder": Windows' folder picker, and the folder kept as a place to look
    addModsFolder: () => ipcRenderer.invoke('game:modsFolder'),
    // Settings, Mods: stop looking in one of those folders (its files are never touched)
    forgetModsFolder: dir => ipcRenderer.invoke('game:forgetModsFolder', typeof dir === 'string' ? dir : ''),
    openInstall: () => ipcRenderer.invoke('game:openInstall'),
    remove: () => ipcRenderer.invoke('game:remove'),
    restoreSkyrim: () => ipcRenderer.invoke('game:restoreSkyrim'),
  },
  // Mod keys bound in Settings, Controls: a DirectX scan code, or null for the server's key; written at the next check
  controls: {
    set: (id, key) => ipcRenderer.invoke('controls:set', { id, key }),
    reset: () => ipcRenderer.invoke('controls:reset'),
  },
  // Discord login; the account key itself never reaches the page
  account: {
    login: () => ipcRenderer.invoke('account:login'),
    cancel: () => ipcRenderer.invoke('account:cancel'),
    refresh: fresh => ipcRenderer.invoke('account:refresh', { fresh: fresh === true }),
    logout: () => ipcRenderer.invoke('account:logout'),
    openDiscord: () => ipcRenderer.invoke('account:openDiscord'),
  },
  // The player's Nexus account (Log in to Nexus in their own browser); its tokens never reach the page
  nexusAccount: {
    state: () => ipcRenderer.invoke('nexusAccount:state'),
    login: () => ipcRenderer.invoke('nexusAccount:login'),
    cancel: () => ipcRenderer.invoke('nexusAccount:cancel'),
    logout: () => ipcRenderer.invoke('nexusAccount:logout'),
    onState: callback => ipcRenderer.on('nexusAccount:state', (_event, value) => callback(value)),
  },
  // Launcher self-update: the installer the server names is checked by hash and run silently (updateFile.js)
  update: {
    check: () => ipcRenderer.invoke('app:checkUpdate'),
    download: () => ipcRenderer.invoke('app:downloadUpdate'),
    install: () => ipcRenderer.invoke('app:installUpdate'),
    cancel: () => ipcRenderer.invoke('app:cancelUpdate'),
    onProgress: callback => ipcRenderer.on('update:progress', (_event, value) => callback(value)),
    // The server announced a change: the page re-checks right away.
    onSignal: callback => ipcRenderer.on('update:signal', () => callback()),
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
})
