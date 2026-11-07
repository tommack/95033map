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

test('a hidden place keeps its spot in the data, marked hidden; the others carry no mark', () => {
  const l = structuredClone(layout), p = l.places.find((x) => !x.hidden);
  p.hidden = true;
  const places = buildAll(graph, l, areaLayouts, slugs).map.places;
  const q = places.find((x) => x.name === p.name);
  assert.equal(q.hidden, true);
  assert.equal(q.t, p.t);
  const inLayout = new Map(l.places.map((x) => [x.name, !!x.hidden]));
  for (const x of places) assert.equal('hidden' in x, inLayout.get(x.name), x.name);
});

test('a corner place keeps its mark and sits at an end of its line', () => {
  const l = structuredClone(layout), p = l.places.find((x) => !x.corner);
  Object.assign(p, { corner: true, t: 0 });
  const q = buildAll(graph, l, areaLayouts, slugs).map.places.find((x) => x.name === p.name);
  assert.equal(q.corner, true);
  assert.equal(q.t, 0);
  for (const x of built.map.places) if (x.corner) assert.ok(x.t === 0 || x.t === 1, x.name);
});

test('a place shown only zoomed in keeps its zoom level', () => {
  const l = structuredClone(layout), p = l.places.find((x) => !x.lod);
  p.lod = 1;
  assert.equal(buildAll(graph, l, areaLayouts, slugs).map.places.find((x) => x.name === p.name).lod, 1);
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
