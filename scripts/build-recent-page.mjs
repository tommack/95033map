// Writes site/recent/index.html, the page at 95033map.com/recent: the map's own page with its
// title changed and its two files one folder up. app.js sees the path and draws the recent reports.
//   node scripts/build-recent-page.mjs   (build-site.mjs runs it too)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'site');

export async function buildRecentPage() {
  let html = await fs.readFile(path.join(SITE, 'index.html'), 'utf8');
  const swap = (from, to) => {
    if (!html.includes(from)) throw new Error(`site/index.html no longer has ${from}`);
    html = html.replace(from, to);
  };
  swap('href="style.css"', 'href="../style.css"');
  swap('src="app.js"', 'src="../app.js"');
  html = html.replace(/<title>[^<]*<\/title>/, '<title>Recent reports · 95033 Road Map</title>')
    .replace(/<meta name="description" content="[^"]*">/,
      '<meta name="description" content="What neighbors have reported lately on the roads of the Santa Cruz Mountains (95033): trees down, closures, loose animals.">');
  await fs.mkdir(path.join(SITE, 'recent'), { recursive: true });
  await fs.writeFile(path.join(SITE, 'recent', 'index.html'), html);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildRecentPage();
  console.log('site/recent/index.html');
}
