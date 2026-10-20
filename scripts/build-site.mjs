// Builds the public map's data from the editors' output:
//
//   node scripts/build-site.mjs           # writes site/data/map.json (and site/data/areas/<neighborhood>.json
//                                         # for each neighborhood with its own map), updates data/slugs.json
//   node scripts/build-site.mjs --strict  # the same, but fails if there are warnings (CI)
//
// site/ is then a static site (deploy with `npx wrangler deploy`, see wrangler.jsonc).
// data/slugs.json records every link name handed out, so links keep working across
// rebuilds: keep it (and commit it, once this is in git).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from '../site/build-map.mjs';
import { buildRecentPage } from './build-recent-page.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.SAVE_DIR ? path.resolve(process.env.SAVE_DIR) : path.join(ROOT, 'data');
const readJSON = async (f) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };

const graph = await readJSON(path.join(DATA, 'graph-derived.json'));
const layout = await readJSON(path.join(DATA, 'layout-derived.json'));
if (!graph || !layout) {
  console.error('Need data/graph-derived.json (node picker) and data/layout-derived.json (layout editor).');
  process.exit(1);
}
const slugFile = path.join(DATA, 'slugs.json');
// Neighborhood maps: data/layout-g35-derived.json for the area group g35, from the layout editor's ?area=g35.
const areaLayouts = {};
for (const g of (layout.groups || []).filter((g) => g.kind === 'area')) {
  const l = await readJSON(path.join(DATA, `layout-${g.id}-derived.json`));
  if (l) areaLayouts[g.id] = l;
}
const { map, areas, slugs, warnings } = buildAll(graph, layout, areaLayouts, await readJSON(slugFile));

const out = path.join(ROOT, 'site', 'data', 'map.json');
await fs.mkdir(path.dirname(out), { recursive: true });
const text = JSON.stringify(map);
await fs.writeFile(out, text);
const areaDir = path.join(ROOT, 'site', 'data', 'areas');
await fs.rm(areaDir, { recursive: true, force: true });
if (Object.keys(areas).length) await fs.mkdir(areaDir, { recursive: true });
for (const [slug, m] of Object.entries(areas)) await fs.writeFile(path.join(areaDir, `${slug}.json`), JSON.stringify(m));
// One link per line, so the file diffs well.
const block = (o) => '{\n' + Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n }';
await fs.writeFile(slugFile, `{\n "version": ${slugs.version},\n "edges": ${block(slugs.edges)},\n "nodes": ${block(slugs.nodes)}\n}\n`);

await buildRecentPage();

for (const w of new Set(warnings)) console.warn('warning:', w);
if (warnings.length && process.argv.includes('--strict')) process.exitCode = 1;
console.log(`site/data/map.json: ${map.nodes.filter((n) => !n.kind).length} junctions, ${map.edges.length} lines, ` +
  `${Object.keys(map.retired).length} retired links, ${(text.length / 1024).toFixed(0)} KB`);
for (const [slug, m] of Object.entries(areas)) console.log(`site/data/areas/${slug}.json: ${m.area.label}, ${m.nodes.filter((n) => !n.kind).length} junctions, ${m.edges.length} lines`);
