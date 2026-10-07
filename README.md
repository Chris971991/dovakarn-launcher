# Dovakarn Launcher

Desktop launcher for the Dovakarn SkyMP server. One page for every mode: online play against the
Dovakarn server, and a local test mode (`--combat-test`) where this PC is also the server. It handles
the Discord login, sets up Dovakarn's own copy of Skyrim 1.6.1170, downloads the server's mods from
Nexus Mods with the player's own account, checks and repairs the game files against the server's
published list, and launches Skyrim through SKSE.

Originally based on the SkyMP team's launcher: https://github.com/F02K/SkyMP-Launcher

## How a player uses it

1) Own Skyrim Special Edition on Steam. Open the launcher and log in with Discord (top right).
2) Press Set up Dovakarn: the launcher makes its own copy of Skyrim 1.6.1170 (in C:\Dovakarn by default)
   from the player's Steam Skyrim, or from Steam's own 1.6.1170 download when the installed game is a
   newer version. The player's own Skyrim is only read, never changed.
3) Press Get the mods, then Download them all: the server's mods come from Nexus Mods with the
   player's own account (see Nexus Mods integration and privacy, below), and the launcher installs them.
4) Press Play. The launcher checks the game files against the server, fixes what it can, fetches a play
   session, writes the client settings and starts SKSE. The character menu appears inside the game.

## Project structure

```
src/
  main.js               Main process: window, IPC, online/local dependency sets, launch pipeline, self-update
  config.js             The Dovakarn backend's address: set apiUrl before building a release
  local-preload.js      Context-isolated bridge: exposes window.localPlay to the launcher page
  nexus-preload.js      Context-isolated bridge for the Nexus window's own strip page (not the Nexus page)
  localPlay.js          Launch coordinator (both modes): account gate, file check, play session, state for the page
  launcherLifecycle.js  Opening and reusing the launcher window, and Play requests from a shortcut
  launchProcess.js      Starts SKSE detached and reports a failed start
  skyrimProcess.js      Whether Skyrim is really running (tasklist)
  skyrimVersion.js      Reads SkyrimSE.exe's file version
  gameFolder.js         Checks a Skyrim folder the player picked
  gameCopy.js           Dovakarn's own copy of Skyrim 1.6.1170: sources, checks, building it
  gameProfile.js        The copy's own load order and INI files
  gameSetup.js          Joins the copy, the mods' install and the player's folders to the launcher's settings
  vanilla-1.6.1170.json Sizes and SHA-256 of every Skyrim 1.6.1170 file (no game file ships with the launcher)
  restoreSkyrim.js      "Put my Skyrim back": undoes what launchers before 3.0 did to the player's own Skyrim
  modInstall.js         Installs the server's mods from the player's Nexus downloads (found by size and MD5)
  nexusApp.js           The Application-Name and Application-Version sent to Nexus
  nexusAccount.js       Log in to Nexus (OAuth with PKCE, tokens sealed with Windows) and Nexus's API for Premium downloads
  nexusDownloads.js     Mods from Nexus: the Nexus window, or by themselves through the API for Nexus Premium
  collectionCheck.js    Nexus collection revision check (no login needed)
  fileCheck.js          The file check engine (manifest fetch, hash, repair, collection check)
  fileSteps.js          Byte-level adaptations made to the player's own copy of a mod file
  modSettings.js        Locked mod settings: repair by settings, the player's keys, read-only mod menus, the sweep
  ini.js                INI reading and editing that keeps every other line (settings, applyEdits, matchSettings)
  gameControls.js       The keys Skyrim's own controls use on this PC, for the Controls tab's notes
  discordLogin.js       Discord login against the Dovakarn backend (account key sealed with Windows)
  gameLogin.js          The game's login file (auth-data-no-load.js), restricted to this Windows user
  updateFile.js         Launcher self-update: install only the file the server names by SHA-256
  announce.js           The server's announce socket: a signal to check for updates at once
  mo2.js                Legacy MO2 helpers still used by the launch pipeline's guards
  localTest.js          Local test mode (dev): --combat-test / --local-test detection and the local server's manifest
  localFileCheck.js     Local test mode (dev): rebuild the published list from this PC's game copy, then check it
  hostJobs.js           Local test mode (dev): the local server's file work on a worker thread
  renderer/
    local-play.html     The one page: latest updates, server card, notice, Verify and Settings
    local-play.js       Page logic (state polling, notices, updates, settings tabs, Controls key binding, launcher update strip)
    local-play.css      The Dovakarn look
    local-play-effects.js        The background video and mist (decorative only)
    nexus-window.html, .js, .css The Nexus window's strip above the Nexus page
    assets/, fonts/     Emblem, background video and the Sovngarde font, with their licences
assets/                 App icon (icon.ico), 7-Zip, third-party licences
test/                   node --test suites
```

## Development

```bash
npm install
npm start        # online launcher against apiUrl (API_URL in .env overrides)
npm run dev      # same, with DevTools
```

The local test mode (`--combat-test`) is started by the server repository's local test tools,
never by hand: it needs the local server window's manifest.

Run the tests with `npm test`. Tests that drive the server's own tools are skipped when those tools are
not present beside this checkout.

Copy `.env.example` to `.env` and set `API_URL` when pointing at a local backend.

## Building

```bash
npm run build:win    # Windows - NSIS installer + portable exe (x64)
```

Output goes to `dist`: `DovakarnLauncher.exe` (installer) and
`DovakarnLauncher-portable.exe`. Set `apiUrl` in src/config.js before building a release; a
packaged launcher reads no .env.

The appId stays `com.skyrp.launcher`, the identity of earlier releases, so existing installs update in place.

### Client settings file format

Online mode (server `offlineMode: false`), the Dovakarn way:
```json
{
  "server-ip": "...",
  "server-port": 7780,
  "master": "https://dovakarn.com",
  "server-master-key": "<key>",
  "discord-invite": "<invite url>",
  "dodgeKeyCode": 29,
  "sneakKeyCode": 45
}
```
The `...KeyCode` entries are the server's game keys (the list's `gameKeys`, below), the player's choice
or the server's key, taken from the file check this Play just passed.
The session credentials are written separately to
`Data/Platform/PluginsNoLoad/auth-data-no-load.js` (readable by this Windows user only) so the
in-game SkyMP client logs in by itself. Game logins happen only through the launcher.

The local test writes its own shape (localTest.clientSettings), pinned to 127.0.0.1.

## Mod settings

Mod settings match the server's at all times.
Players change only the keys the server lists, in **Settings, Controls**: press Change, then the
key or mouse button (Esc cancels, the left button works the page). Keys are DirectX scan codes as
SKSE mods read them (1-255 keyboard, 256-281 mouse and gamepad, -1 none). Every key is checked against every
other key, across mods, Dovakarn's own keys and the server's defaults, and a key used twice is warned
about, never refused. Keys used in play are also checked against Skyrim's own controls on this PC
(`src/gameControls.js`: the player's `ControlMap_Custom.txt` over the game's defaults; Wait is left
out, because waiting is off online) and against keys other mods keep that players cannot change here
(the list's `fixedKeys`). SkyUI's in-menu keys (`inMenus`) are compared only with each other. The
list's `gameKeys` (Dovakarn's menu keys, chat, name plates, the interface, Dodge and Sneak) are not in
any mod file: they go into the client settings file at Play, and come first in Controls. Clean copies of locked files are kept in `mod-settings-copies` beside
`game-file-hashes.json`, named by SHA-256, and pruned to the current list.

## Skyrim version

Steam moved Skyrim SE to 1.7.x in August 2026 and offers no branch back; Dovakarn's client runs on
1.6.1170 only. Online players never change their own Skyrim: when it is not 1.6.1170, the Set up Dovakarn
window gives them Steam's own console commands (`download_depot`) for the three 1.6.1170 depots, with a
Copy button for each and a button that opens Steam's console, and builds Dovakarn's game copy from that
download. Only the test launcher, which plays from a chosen Skyrim folder, shows a card that sends the
player to the Skyrim Downgrader Tool on Nexus Mods (mod 188916) to switch that folder.

## Latest updates

The main screen shows the notice board's Updates (`GET /api/updates`), the same entries as the
game's own Updates tab, newest first; the last good copy is kept (`updatesCache`) for when the server
does not answer. Entries posted since the launcher was last opened carry New (`updatesSeen`).

## Nexus Mods integration and privacy

The server's mods come from Nexus Mods with the player's own Nexus account. The Dovakarn server never
hosts or hands out mod files.

**Logging in to Nexus.** Log in to Nexus is a button the player presses. It uses Nexus's OAuth with PKCE
(S256) as a public client: there is no client secret. The player's own web browser opens Nexus's login
page, and Nexus sends a one-time code back to a listener on 127.0.0.1 (this PC only), which closes once the
token exchange is done. The launcher exchanges the code for tokens itself. The Dovakarn server only tells
the launcher which Nexus application and loopback ports to use (`GET /api/auth/nexus`); the tokens are
never sent to it. Only the tokens are sealed: they are stored on this PC only, encrypted with Windows
through Electron's safeStorage (without Windows encryption they are kept in memory for that run only). The
Nexus account's name, user id and Premium flag are stored as plain text in the launcher's settings file,
so the launcher can show who is logged in. Log out revokes the tokens with Nexus and removes both. The scopes
asked for are `openid profile`; the launcher reads only the account's name, id and membership.

**Every API, OAuth, GraphQL and file-server request** the launcher makes to Nexus carries
`Application-Name: Dovakarn Launcher` and `Application-Version`, the launcher's version. Requests to
Nexus's file servers also carry the user agent `Dovakarn Launcher/<version>`. Pages the player opens in
the Nexus window (below) are ordinary browser requests.

**Nexus Premium.** For a logged-in Premium member, the launcher asks Nexus's API for each file's
`download_link.json` and downloads the files one at a time, with a pause of a second between link
requests. It reads Nexus's rate-limit headers: when `x-rl-hourly-remaining` or `x-rl-daily-remaining` is
0, it makes no further API call until the later of the resets Nexus names (`x-rl-hourly-reset`,
`x-rl-daily-reset`, or an hour or a day from now when none is named) and stops the run. A 429 answer blocks API calls until its `Retry-After` time, else
the next reset still ahead, else one minute. No block lasts more than 24 hours, and a reset time that has
already passed blocks nothing. It only follows links and redirects to Nexus's own hosts over https, never takes more than the
file's known size, and checks each file's size and MD5 before keeping it. A refused token is renewed once.

**Free accounts.** The launcher opens the real Nexus Mods website in a launcher window, in its own
sandboxed session with every permission denied, File System Access pickers switched off, unload prompts
and client certificate requests refused, and the browser's own user agent unchanged. The player logs in on
Nexus's own page and presses Nexus's own Slow download button. The launcher never clicks, types or fills
anything on the page. To word its instructions it runs a small read-only script in the Nexus page (the
logged-in name and the download box's state): about once a second on a mod's file page until the download
box shows, and once when any other Nexus page loads, to learn whether the window is logged in. The
launcher itself navigates the window: it opens each needed mod's file page, moves to the next mod's file
page after a download or when a check finds the shown mod already on this PC (never while the player is on
Nexus's login, sign-up or settings pages), goes back to the mod's file page after a file of the wrong size
or a mod manager link, sends a mod manager (`nmm=1`) variant of the page back to the plain page once, and
returns to the mod when a page from outside Nexus shows. The file page may follow Nexus's Slow download
link to its file host; an answer from outside Nexus that is not a file is stopped before it shows
(answered as 204 No Content), and anything such a site kept in the window's session (cookies, storage) is
cleared. Downloads are accepted only from that window, each file's size and MD5 are checked, and mod
manager (`nxm:`) links are not followed.

**Files the player already has.** Before asking for any download, and at every check, the launcher looks
for the needed files in its own Downloads folder, Vortex's download folders for Skyrim SE, Windows'
Downloads folder and any folder the player names. These folders are only read, and a file is used only
when its size and MD5 match the file the server lists; it is copied into Dovakarn's Downloads folder.

**Without a login**, the launcher uses Nexus's public GraphQL API to check a collection's latest revision
and which mods Nexus marks as adult (a hint for the player).

**Data sent to the Dovakarn server.** Everything the launcher sends to its own server:
- Discord login: Discord's one-time code, the PKCE verifier, the loopback redirect address and the PC's
  Windows MachineGuid (`POST /api/auth/discord`). The account key the server returns is sealed with Windows.
- Each Play: the account key and the MachineGuid (`POST /api/auth/play`), then the launch check with the
  play session, the launcher's version, the verified file-list revision and the plugin list the server
  published, as the launcher wrote it into the game's load order (`POST /api/launch-check`).
- Account refresh and log out: the account key (`GET /api/auth/me`, `POST /api/auth/logout`).
- Reads with nothing of the player's in them: the server list, server info, the file list, install list and
  files by hash, the launcher version, the notice board's Updates, the Discord and Nexus login settings,
  and the announce socket.

The MachineGuid is used to enforce bans. No Nexus token, Nexus account data, file list of the player's
own folders, or anything from the Nexus window is sent to the Dovakarn server.

## Persistent store keys

| Key | Type | Purpose |
|-----|------|---------|
| `skyrimPath` | string | The player's Skyrim Special Edition folder (the game copy's source) |
| `installDir` | string | Dovakarn's folder: its own copy of Skyrim in Game, the mods' downloads in Downloads |
| `serverLoadOrder` | array | The server's plugins as last read, for which Creation Club files the copy keeps |
| `modsFolders` | array | Folders the player named as holding mod downloads (only ever read) |
| `verifiedFilesRevision` | string | The published file-list revision this PC last verified |
| `acceptedFileWarnings` | string | The mod warnings the player chose to play past (asked again when they change) |
| `nexusAccount` | object | The Nexus account logged in with Log in to Nexus: `{ name, id, premium }` |
| `nexusToken` | string | Its Nexus tokens, sealed with Windows; never sent to the Dovakarn server |
| `nexusUser` | string | The Nexus name the Nexus window last showed |
| `nexusLogin` | string | Whether the Nexus window was last seen logged in: `in`, `out` or `unknown` |
| `localGameDir` | string | Test launcher only: Skyrim folder to play from |
| `activeServerIndex` | number | Index into the cached server list |
| `cachedServers` | array | Last-known server list (offline fallback) |
| `discordAccount` | object | The logged-in Dovakarn account as the backend describes it |
| `discordAccountKey` | string | Its account key, sealed with Windows (discordLogin.js) |
| `pendingLogouts` | array | Logouts the server has not received yet, sealed with Windows |
| `updateAttempt` | object | The launcher update started last (updateFile.js) |
| `filesVersion` | string | Legacy installs' client files tag, reported to launch-check |
| `modKeys` | object | Keys bound in Settings, Controls: `{ key id: DirectX scan code }`, -1 for none. Written into the mods' settings files at each check (game keys into the client settings file at Play); a key at the server's value is not stored |
| `updatesCache` | array | The notice board's Updates as last fetched, shown when the server does not answer |
| `updatesSeen` | array | Update ids already shown, so only newer ones carry New |
| `mo2Enabled` | boolean | Legacy; forced off at start (Dovakarn refuses MO2 launches) |
| `isolatedGame`, `baseDirPath`, `gameDirPath` | | Legacy portable-install layout from older launchers, read-only support |
| `discordUser`, `gameSession`, `gameProfileId` | | Legacy login data from older launchers, cleared at start |
| `localTest.*` | | Test launcher only: its own Discord login, kept apart from the real launcher's |

## Backend API endpoints used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/servers` | Server heartbeat: up, player count, max |
| GET | `/api/serverinfo` | Master address/key, load order, lock status |
| GET | `/api/client-files/manifest` | The player file list the server publishes |
| GET | `/api/client-files/files/:sha256` | Dovakarn's own files by hash, installed by the launcher |
| GET | `/api/client-files/install` | The install list: each mod file, the Nexus download it comes from, and its hashes |
| POST | `/api/launch-check` | Reports files version + plugins before launch |
| GET | `/api/version` | Launcher self-update check (SHA-256-named installer) |
| GET | `/api/updates` | The notice board's Updates for the main screen |
| GET | `/api/auth/config` | Discord login settings: client id, loopback redirect ports, invite |
| POST | `/api/auth/discord` | Exchanges Discord's one-time code (with the PKCE verifier) for an account key |
| GET | `/api/auth/me` | The logged-in account (name, membership, ban, staff level) |
| POST | `/api/auth/play` | A play session for one launch |
| POST | `/api/auth/logout` | Ends this PC's login at the server |
| GET | `/api/auth/nexus` | Which Nexus application and loopback ports Log in to Nexus uses |
| WebSocket | `/ws/announce` | Announcements of a new launcher release or new game files |

## Server lock

If the backend sets `locked: true`, play sessions are refused for accounts not on its allow list.
Used during maintenance or testing periods.
