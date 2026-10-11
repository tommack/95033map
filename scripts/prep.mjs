// Clip raw Overpass road data to the map region and write a compact file for
// the node-picker tool. The region is the 95033 ZCTA plus everything between
// the ZCTA's southern edge and Hwy 1, which serves as the map's southern edge.
//
//   node scripts/prep.mjs
//
// Inputs:  data/osm_raw.json, data/osm_raw_south.json
//            (Overpass "out body; >; out skel qt;" for the ZCTA bbox and the strip down to Hwy 1)
//          data/zcta95033.geojson (Census TIGERweb ZCTA polygon)
// Output:  data/roads.json

import { readFileSync, writeFileSync } from 'node:fs';

const raws = ['data/osm_raw.json', 'data/osm_raw_south.json'].map((f) => JSON.parse(readFileSync(f, 'utf8')));
const zcta = JSON.parse(readFileSync('data/zcta95033.geojson', 'utf8'));

const geom = zcta.features[0].geometry;
const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat();
const outer = rings[0]; // [lon, lat]

let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
for (const [x, y] of outer) {
  minLon = Math.min(minLon, x); maxLon = Math.max(maxLon, x);
  minLat = Math.min(minLat, y); maxLat = Math.max(maxLat, y);
}

function inRing(ring, lon, lat) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Lowest latitude at which a set of [lon, lat] segments crosses a given longitude.
function minLatAt(segments, lon) {
  let best = null;
  for (const [[x1, y1], [x2, y2]] of segments) {
    if ((x1 <= lon) === (x2 <= lon)) continue;
    const y = y1 + ((lon - x1) / (x2 - x1)) * (y2 - y1);
    if (best === null || y < best) best = y;
  }
  return best;
}

const coords = new Map();
const rawWays = new Map();
for (const raw of raws) {
  for (const el of raw.elements) {
    if (el.type === 'node') coords.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way') rawWays.set(el.id, el);
  }
}

// Southern extension: between the ZCTA's southern edge and Hwy 1.
const HWY1_BUFFER = 0.0015; // ~150 m south of Hwy 1, so the highway and its ramps are inside
// Longitude limits for the extension (null = the ZCTA's full width, which spans
// roughly Felton/Ben Lomond in the west to Aptos in the east).
const EXT_WEST = null;
const EXT_EAST = null;
const zctaSegs = outer.map((p, i) => [outer[i ? i - 1 : outer.length - 1], p]);
const hwy1Segs = [];
for (const w of rawWays.values()) {
  const refs = (w.tags?.ref || '').split(';').map((r) => r.trim());
  if (!refs.includes('CA 1') || /_link$/.test(w.tags.highway)) continue;
  for (let i = 1; i < w.nodes.length; i++) {
    const a = coords.get(w.nodes[i - 1]), b = coords.get(w.nodes[i]);
    if (a && b) hwy1Segs.push([[a[1], a[0]], [b[1], b[0]]]);
  }
}
const upper = [], lower = [];
for (let lon = EXT_WEST ?? minLon; lon <= (EXT_EAST ?? maxLon); lon += 0.002) {
  const top = minLatAt(zctaSegs, lon), bottom = minLatAt(hwy1Segs, lon);
  if (top === null || bottom === null || bottom >= top) continue;
  upper.push([lon, top + 0.002]);
  lower.push([lon, bottom - HWY1_BUFFER]);
}
const extension = [...upper, ...lower.reverse()];
console.log(`southern extension: ${upper.length} samples, Hwy 1 segments: ${hwy1Segs.length}`);

function inRegion(lon, lat) {
  return inRing(outer, lon, lat) || inRing(extension, lon, lat);
}

// Keep roads within ~1 km of the region too, so notches in the ZCTA outline don't
// cut gaps into through roads. Rasterize the region to a grid and dilate it.
const CELL = 0.002; // degrees, ~220 m N-S, ~180 m E-W
const DILATE = 5;   // cells
const g0Lon = minLon - 0.05, g0Lat = Math.min(minLat, ...extension.map((p) => p[1])) - 0.05;
const gW = Math.ceil((maxLon + 0.05 - g0Lon) / CELL), gH = Math.ceil((maxLat + 0.05 - g0Lat) / CELL);
const base = new Uint8Array(gW * gH), grid = new Uint8Array(gW * gH);
for (let y = 0; y < gH; y++)
  for (let x = 0; x < gW; x++) base[y * gW + x] = inRegion(g0Lon + (x + 0.5) * CELL, g0Lat + (y + 0.5) * CELL) ? 1 : 0;
for (let y = 0; y < gH; y++)
  for (let x = 0; x < gW; x++) {
    if (!base[y * gW + x]) continue;
    for (let dy = -DILATE; dy <= DILATE; dy++)
      for (let dx = -DILATE; dx <= DILATE; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < gH && xx >= 0 && xx < gW && dx * dx + dy * dy <= DILATE * DILATE) grid[yy * gW + xx] = 1;
      }
  }

function inside(lon, lat) {
  const x = Math.floor((lon - g0Lon) / CELL), y = Math.floor((lat - g0Lat) / CELL);
  return x >= 0 && x < gW && y >= 0 && y < gH && grid[y * gW + x] === 1;
}

const insideCache = new Map();
const isIn = (id) => {
  if (!insideCache.has(id)) {
    const c = coords.get(id);
    insideCache.set(id, c ? inside(c[1], c[0]) : false);
  }
  return insideCache.get(id);
};

const ways = [];
const usedNodes = new Set();
for (const w of rawWays.values()) {
  if (!w.nodes.some(isIn)) continue;
  const t = w.tags || {};
  ways.push({
    id: w.id,
    hw: t.highway,
    name: t.name || null,
    ref: t.ref || null,
    access: t.access || null,
    oneway: t.oneway || null,
    nodes: w.nodes,
  });
  w.nodes.forEach((n) => usedNodes.add(n));
}

const nodes = {};
for (const id of usedNodes) {
  const c = coords.get(id);
  if (c) nodes[id] = [+c[0].toFixed(6), +c[1].toFixed(6)];
}

const toLatLon = (ring) => ring.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]);
const boundary = [toLatLon(outer), toLatLon(extension)];

writeFileSync(
  'data/roads.json',
  JSON.stringify({
    source: 'OpenStreetMap contributors (ODbL), via Overpass',
    timestamp: raws[0].osm3s?.timestamp_osm_base,
    boundary,
    nodes,
    ways,
  })
);

const counts = {};
ways.forEach((w) => (counts[w.hw] = (counts[w.hw] || 0) + 1));
console.log(`ways: ${ways.length}, nodes: ${usedNodes.size}`);
console.log(counts);
