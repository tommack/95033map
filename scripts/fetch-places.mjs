// Fetch named places (shops, schools, fire stations, parks…) from OpenStreetMap for the layout
// editor's Places search. Only places inside the map's region (the boundary in data/roads.json) are kept.
//
//   node scripts/fetch-places.mjs
//   node scripts/fetch-places.mjs --from saved.json   # an Overpass response saved earlier (servers are often busy)
//
// Output: data/places-osm.json  { source, timestamp, places: [{ osm, name, kind, lat, lon, street }] }

import { readFileSync, writeFileSync } from 'node:fs';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'office', 'emergency', 'craft', 'healthcare', 'building'];
// Named buildings count only as these (some places, like a school, are mapped as just a building).
const BUILDINGS = 'school|kindergarten|college|church|chapel|temple|mosque|synagogue|fire_station|hospital|civic|public|government|library|museum|retail|supermarket|hotel|stadium';

const roads = JSON.parse(readFileSync('data/roads.json', 'utf8'));
const rings = roads.boundary;   // [[lat, lon], …] each
const all = rings.flat();
const bbox = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))].join(',');

function inRing(ring, lat, lon) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Too small or too many to be worth a marker.
const SKIP = new Set(['amenity=toilets', 'amenity=parking', 'amenity=parking_entrance', 'amenity=parking_space', 'amenity=recycling',
  'amenity=bench', 'amenity=bicycle_rental', 'amenity=bicycle_parking', 'amenity=waste_basket', 'amenity=waste_disposal',
  'amenity=drinking_water', 'amenity=charging_station', 'amenity=vending_machine', 'amenity=atm', 'amenity=telephone',
  'amenity=post_box', 'amenity=fountain', 'amenity=bbq', 'amenity=hunting_stand', 'emergency=fire_hydrant', 'emergency=phone']);
const query = `[out:json][timeout:120];(${KEYS.map((k) => `nwr["name"]["${k}"${k === 'building' ? `~"^(${BUILDINGS})$"` : ''}](${bbox});`).join('')});out center tags;`;
const from = process.argv.indexOf('--from');
let data = from > 0 ? JSON.parse(readFileSync(process.argv[from + 1], 'utf8')) : null;
for (const url of data ? [] : MIRRORS) {
  try {
    const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': '95033map places fetch' } });
    const text = await r.text();
    if (r.ok && text.startsWith('{')) {
      // Some mirrors lag OpenStreetMap by months; keep looking for a current one, but fall back to the freshest.
      const d = JSON.parse(text), at = d.osm3s?.timestamp_osm_base || '', days = (Date.now() - Date.parse(at)) / 864e5;
      console.log(`${url}: data from ${at.slice(0, 10)}`);
      if (!data || at > data.osm3s?.timestamp_osm_base) data = d;
      if (days < 7) break;
      continue;
    }
    console.log(`${url}: ${r.status} ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`${url}: ${e.message}`); }
}
if (!data) { console.error('No Overpass server answered; try again later.'); process.exit(1); }

const places = [];
for (const el of data.elements) {
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon, t = el.tags || {};
  if (lat == null || !rings.some((ring) => inRing(ring, lat, lon))) continue;
  const key = KEYS.find((k) => t[k]);
  if (SKIP.has(`${key}=${t[key]}`)) continue;
  places.push({
    osm: `${el.type}/${el.id}`, name: t.name, kind: `${key}=${t[key]}`,
    lat: +lat.toFixed(6), lon: +lon.toFixed(6), ...(t['addr:street'] ? { street: t['addr:street'] } : {}),
  });
}
places.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync('data/places-osm.json', JSON.stringify({ source: 'OpenStreetMap contributors (ODbL), via Overpass', timestamp: data.osm3s?.timestamp_osm_base, places }));
console.log(`data/places-osm.json: ${places.length} places`);
