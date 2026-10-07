'use strict'
// Who the launcher is, said on every request it makes to Nexus Mods. Nexus's API rules ask every app for an
// Application-Name, kept the same across versions, and its Application-Version.
const APP_NAME = 'Dovakarn Launcher'
const APP_VERSION = String(require('../package.json').version || '0.0.0')

const nexusHeaders = (extra = {}, version = APP_VERSION) => ({ 'Application-Name': APP_NAME, 'Application-Version': String(version), ...extra })

module.exports = { APP_NAME, APP_VERSION, nexusHeaders }
