const test = require('node:test');
const assert = require('node:assert/strict');

// The launcher's backend address: Dovakarn's own server by default; API_URL overrides it for development.
test('the built-in address is Dovakarn\'s own server, and API_URL overrides it', () => {
  const load = env => {
    const saved = process.env.API_URL;
    if (env === undefined) delete process.env.API_URL; else process.env.API_URL = env;
    delete require.cache[require.resolve('../src/config')];
    try { return require('../src/config').apiUrl; } finally { if (saved === undefined) delete process.env.API_URL; else process.env.API_URL = saved; delete require.cache[require.resolve('../src/config')]; }
  };
  assert.equal(load(undefined), 'https://dovakarn.com');
  assert.equal(load('https://api.dovakarn.example'), 'https://api.dovakarn.example');
});
