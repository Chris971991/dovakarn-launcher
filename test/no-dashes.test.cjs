const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// En-dash and em-dash, by code so this file never holds either
const DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
const root = path.join(__dirname, '..');

// Every page, style and script the launcher ships under src/, and every test
function files(dir, kinds = /\.(js|cjs|html|css|json)$/i) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', '.git', 'dist'].includes(entry.name) ? [] : files(full, kinds);
    return kinds.test(entry.name) ? [full] : [];
  });
}
// Every text file in the repository, except two third-party licence texts that are quoted as published: the font's
// OFL.txt and Lucide's licence
const QUOTED = new Set(['ofl.txt', 'lucide-license.txt']);
const texts = () => files(root, /\.txt$/i).filter(file => !QUOTED.has(path.basename(file).toLowerCase()));

// The launcher's writing rule: no em-dashes or en-dashes anywhere. Also catches an editor turning a typed escape into the real character
test('no launcher page, style, script, test, text, README or packaging file contains an em-dash or an en-dash', () => {
  const all = [...files(path.join(root, 'src')), ...files(path.join(root, 'test')), ...texts(),
    ...['README.md', 'package.json', '.env.example', 'installer.nsh', 'LICENSE'].map(name => path.join(root, name))];
  assert.ok(all.some(f => f.endsWith('nexus-window.js')) && all.some(f => f.endsWith('main.js')) && all.some(f => f.endsWith('no-dashes.test.cjs')),
    'The walk reaches src, its renderer and the tests');
  assert.ok(all.some(f => f.endsWith('License.txt')) && all.some(f => f.endsWith('dovakarn-sky.txt')), 'The walk reaches the text files');
  assert.ok(!all.some(f => /(OFL|lucide-LICENSE)\.txt$/i.test(f)), 'The two quoted licence texts are left out');
  const found = [];
  for (const file of all) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (DASH.test(line)) found.push(`${path.relative(root, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});
