/**
 * Launcher configuration - developer-only.
 *
 * apiUrl  - Base URL of the Dovakarn backend (skymp5-backend): Discord login, Play, the server list and the game files.
 *           Set it here before building the installer (https://...): a packaged launcher reads no .env, and players
 *           set no environment variables. The API_URL environment variable overrides it (a .env in development).
 *           Empty, the launcher says it has no server address and sends nothing anywhere.
 *           The available game servers are fetched from GET /api/servers
 *           at runtime so they never need a launcher rebuild to update.
 */
module.exports = {
  apiUrl: process.env.API_URL || 'https://dovakarn.com',
}
