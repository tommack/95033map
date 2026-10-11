// The public map's build (site/build-map.mjs) on the committed data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildAll } from '../site/build-map.mjs';
import { placeKind } from '../tools/place-kinds.mjs';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const graph = read('graph-derived.json'), layout = read('layout-derived.json'), slugs = read('slugs.json');
const areaLayouts = Object.fromEntries((layout.groups || []).filter((g) => g.kind === 'area')
  .filter((g) => existsSync(new URL(`../data/layout-${g.id}-derived.json`, import.meta.url)))
  .map((g) => [g.id, read(`layout-${g.id}-derived.json`)]));
const built = buildAll(graph, layout, areaLayouts, slugs);

test('builds without warnings', () => {
  assert.deepEqual([...new Set(built.warnings)], []);
});

test('hands out no new link names (data/slugs.json is up to date)', () => {
  assert.deepEqual(built.slugs, slugs);
});

test('every line and junction has a link name, and they are unique', () => {
  for (const m of [built.map, ...Object.values(built.areas)]) {
    const names = m.edges.map((e) => e.slug);
    assert.ok(names.every(Boolean));
    assert.equal(new Set(names).size, names.length);
  }
});

test('every place is on a line of its map', () => {
  for (const m of [built.map, ...Object.values(built.areas)]) {
    for (const p of m.places || []) {
      assert.ok(m.edges[p.e], `${p.name} is on line ${p.e}`);
      assert.ok(p.t >= 0 && p.t <= 1 && Math.abs(p.side) === 1, p.name);
    }
  }
});

test('each neighborhood with its own map gets one, linked from the main map', () => {
  for (const [slug, m] of Object.entries(built.areas)) {
    assert.equal(m.area.slug, slug);
    assert.ok(built.map.nodes.some((n) => n.sub === slug), `${slug} is linked`);
  }
});

test('warns when a neighborhood map is out of date', () => {
  const [id] = Object.keys(areaLayouts);
  if (!id) return;
  const stale = { ...areaLayouts, [id]: { ...areaLayouts[id], area: { ...areaLayouts[id].area, nodes: ['nope'] } } };
  assert.ok(buildAll(graph, layout, stale, slugs).warnings.some((w) => /junctions changed/.test(w)));
  const old = { ...areaLayouts, [id]: { ...areaLayouts[id], graphGeneratedAt: 'earlier' } };
  assert.ok(buildAll(graph, layout, old, slugs).warnings.some((w) => /graph changed/.test(w)));
});

test('place kinds: known ones have icons, others a pin and a readable label', () => {
  assert.deepEqual(placeKind('shop=supermarket'), ['🛒', 'Grocery store']);
  assert.deepEqual(placeKind('amenity=ice_cream'), ['📍', 'Ice cream']);
  assert.deepEqual(placeKind('tourism=yes'), ['📍', 'Place']);
});
