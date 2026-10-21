// Bundles src/ui/main.js (IIFE) and inlines it, src/styles.css and the logos into dist/index.html.
// The output is a page fragment: the publish step wraps it in the platform's document skeleton.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url));
const dataUri = (p) => `data:image/png;base64,${read(p).toString('base64')}`;

const { outputFiles } = await build({
  entryPoints: [new URL('src/ui/main.js', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  charset: 'utf8',
  legalComments: 'none',
  write: false,
});
const script = outputFiles[0].text.replace(/<\/(script)/gi, '<\\/$1');

const slots = {
  '/*@STYLES@*/': read('src/styles.css').toString(),
  '/*@SCRIPT@*/': script,
  '@LOGO_BLUE@': dataUri('src/assets/met-logo-blue.png'),
  '@LOGO_WHITE@': dataUri('src/assets/met-logo-white.png'),
};
let html = read('src/page.html').toString();
for (const [slot, value] of Object.entries(slots)) {
  if (!html.includes(slot)) throw new Error(`page.html is missing ${slot}`);
  html = html.split(slot).join(value);
}
mkdirSync(new URL('dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('dist/index.html', import.meta.url), html);
console.log(`dist/index.html ${(Buffer.byteLength(html) / 1024).toFixed(1)} KB`);
