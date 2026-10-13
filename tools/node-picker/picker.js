import { placeKind } from '../place-kinds.mjs';

const STATE_VERSION = 3;
const DERIVED_VERSION = 5;                      // 4: edges carry route refs; 5: open ends say if the road continues
const BUFFER_KEY = 'subway.nodePicker.v3';      // crash buffer of unsaved edits
const VIEW_KEY = 'subway.nodePicker.view';
const LEGACY_KEY = 'subway.nodePicker.v2';      // browser-only storage before the save server
const API = '/api/graph';
const SAVE_DELAY = 600;
const MIN_CANDIDATE_ZOOM = 13;
const DATA_URLS = ['roads.json', '../../data/roads.json'];

const CLASSES = [
  { key: 'major',  label: 'Highways',    hw: ['motorway','trunk','primary','motorway_link','trunk_link','primary_link'], color: '#e07b17', weight: 4.5, on: true },
  { key: 'second', label: 'Secondary',   hw: ['secondary','secondary_link'], color: '#d4a20b', weight: 3.5, on: true },
  { key: 'tert',   label: 'Tertiary',    hw: ['tertiary','tertiary_link'], color: '#b3a12a', weight: 3, on: true },
  { key: 'minor',  label: 'Residential', hw: ['residential','unclassified','living_street','road'], color: '#6d6d6d', weight: 2, on: true },
  { key: 'service',label: 'Service',     hw: ['service'], color: '#9a9a9a', weight: 1.2, on: false },
  { key: 'track',  label: 'Track',       hw: ['track'], color: '#9b7a4f', weight: 1.2, on: false, dash: '4 3' },
];
const hwClass = {};
CLASSES.forEach(c => c.hw.forEach(h => hwClass[h] = c));

const EDGE_COLORS = ['#3cb44b','#4363d8','#911eb4','#0fa3b1','#469990','#000075','#2e7d32','#5e35b1','#00838f','#1565c0'];
const CORRIDOR_COLORS = ['#d32f2f', '#1976d2', '#7b1fa2', '#00796b'];
const OPEN_COLOR = '#e6007e';

// ---------- state ----------
// A graph node is a group of one or more OSM nodes (an interchange is several).
//   nodes: key -> { name, members: [osmId, ...], auto, access? }
//   key is the first member's OSM id as a string; access holds manual overrides per corridor.
// A corridor is a divided highway drawn as one line: { id, ref, label, dirLabels: [fwd, rev] }.
let data, nodeWays, linkAdj;
let enabled = new Set(CLASSES.filter(c => c.on).map(c => c.key));
let nodes = new Map();
let corridors = [];
let memberOf = new Map(); // osmId (number) -> node key
let active = null;        // key of the node Shift-clicks add to
let history = [];
let showDeadEnds = false, showEdges = true, snapMode = false, groupMode = false;
let adj, junctions, deadEnds, edges, openEnds;
let corrGeo = new Map();   // corridor id -> derived geometry (spine, node sets)
let stationInfo = new Map(); // node key -> [{ corr, s, auto, access, manual }]
let ready = false;

// ---------- map ----------
const map = L.map('map', { preferCanvas: true, zoomControl: true });
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, className: 'basemap',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

map.createPane('roads');
map.getPane('roads').style.zIndex = 390;
map.getPane('roads').style.pointerEvents = 'none';
const roadRenderer = L.canvas({ pane: 'roads', padding: 0.3 });
const overlayRenderer = L.canvas({ padding: 0.3, tolerance: 6 });

const roadLayer = L.layerGroup().addTo(map);
const overlayLayer = L.layerGroup().addTo(map);

// ---------- helpers ----------
const R = 6371008.8, rad = Math.PI / 180;
function dist(a, b) {
  const dLat = (b[0]-a[0])*rad, dLon = (b[1]-a[1])*rad;
  const s = Math.sin(dLat/2)**2 + Math.cos(a[0]*rad)*Math.cos(b[0]*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
// Local planar projection in meters; fine at this scale.
const MX = 111320 * Math.cos(37.1 * rad), MY = 110540;
const toXY = ([lat, lon]) => [lon * MX, lat * MY];
const fmtLen = m => m < 1609 ? `${Math.round(m*3.281)} ft` : `${(m/1609.34).toFixed(2)} mi`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const wayLabel = w => w.name || w.ref || `(${w.hw})`;
const wayOn = w => { const c = hwClass[w.hw]; return c && enabled.has(c.key); };
const isLink = w => /_link$/.test(w.hw);
const refsOf = w => (w.ref || '').split(';').map(r => r.trim()).filter(Boolean);
// 1 = travel in node order, -1 = against it, 0 = two-way. Motorways are one-way unless tagged otherwise.
function onewayDir(w) {
  if (w.oneway === 'yes' || w.oneway === 'true' || w.oneway === '1') return 1;
  if (w.oneway === '-1') return -1;
  if (w.oneway === 'no') return 0;
  return (w.hw === 'motorway' || w.hw === 'motorway_link') ? 1 : 0;
}
function bearingLL(pa, pb) {
  return Math.atan2((pb[1] - pa[1]) * Math.cos(pa[0] * rad), pb[0] - pa[0]) / rad;
}
const bearing = (a, b) => bearingLL(data.nodes[a], data.nodes[b]);
const turnAngle = (h1, h2) => Math.abs(((h2 - h1 + 540) % 360) - 180);

function centroid(node) {
  let lat = 0, lon = 0;
  for (const id of node.members) { lat += data.nodes[id][0]; lon += data.nodes[id][1]; }
  return [lat / node.members.length, lon / node.members.length];
}

function reindex() {
  memberOf = new Map();
  for (const [key, n] of nodes) for (const id of n.members) memberOf.set(id, key);
  if (active && !nodes.has(active)) active = null;
}

// ---------- graph ----------
function indexData() {
  nodeWays = new Map();
  linkAdj = new Map();
  for (const w of data.ways) {
    for (const n of w.nodes) { if (!nodeWays.has(n)) nodeWays.set(n, []); nodeWays.get(n).push(w); }
    if (!isLink(w)) continue;
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = w.nodes[i], b = w.nodes[i + 1];
      if (!linkAdj.has(a)) linkAdj.set(a, []);
      if (!linkAdj.has(b)) linkAdj.set(b, []);
      linkAdj.get(a).push({ to: b, way: w, idx: i, fwd: true });
      linkAdj.get(b).push({ to: a, way: w, idx: i + 1, fwd: false });
    }
  }
}

function buildGraph() {
  adj = new Map();
  const add = (a, b, w) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, way: w }); };
  for (const w of data.ways) {
    if (!wayOn(w)) continue;
    const n = w.nodes;
    for (let i = 0; i < n.length - 1; i++) {
      if (n[i] === n[i+1] || !data.nodes[n[i]] || !data.nodes[n[i+1]]) continue;
      add(n[i], n[i+1], w); add(n[i+1], n[i], w);
    }
  }
  junctions = []; deadEnds = [];
  for (const [id, nbrs] of adj) {
    if (nbrs.length >= 3) junctions.push(id);
    else if (nbrs.length === 1) deadEnds.push(id);
  }
}

// ---------- corridors ----------
// Divided highways (one-way carriageways sharing a ref) are candidates.
function corridorCandidates() {
  const count = new Map();
  for (const w of data.ways) {
    if (isLink(w) || !onewayDir(w)) continue;
    for (const r of refsOf(w)) count.set(r, (count.get(r) || 0) + 1);
  }
  return [...count].filter(([, n]) => n >= 20).map(([r]) => r).sort();
}

// Derive a corridor's geometry: its carriageway ways, the ramps attached to them, and a
// "spine" — one continuous line along the highway that everything is projected onto.
// The spine is walked from the corridor's southernmost vertex following legal travel
// direction, so increasing distance along it is the "forward" (default NB) direction.
function buildCorridor(c) {
  const ways = data.ways.filter(w => !isLink(w) && refsOf(w).includes(c.ref));
  const wayIds = new Set(ways.map(w => w.id));
  const nodeSet = new Set();
  const out = new Map();
  const addOut = (a, b) => { if (!out.has(a)) out.set(a, []); out.get(a).push(b); };
  for (const w of ways) {
    const d = onewayDir(w);
    for (let i = 0; i < w.nodes.length - 1; i++) {
      const a = w.nodes[i], b = w.nodes[i + 1];
      if (!data.nodes[a] || !data.nodes[b]) continue;
      nodeSet.add(a); nodeSet.add(b);
      if (d >= 0) addOut(a, b);
      if (d <= 0) addOut(b, a);
    }
  }
  let start = null;
  for (const id of out.keys()) if (start === null || data.nodes[id][0] < data.nodes[start][0]) start = id;
  const spine = [];
  const visited = new Set();
  let cur = start, heading = 0;
  while (cur != null) {
    spine.push(cur); visited.add(cur);
    let next = null, bestTurn = Infinity;
    for (const n of out.get(cur) || []) {
      if (visited.has(n)) continue;
      const t = turnAngle(heading, bearing(cur, n));
      if (t < bestTurn) { bestTurn = t; next = n; }
    }
    if (next == null || bestTurn > 100) {
      // Gap in the data (or a dead end): hop to the nearest unvisited vertex ahead.
      next = null;
      let bestD = 250;
      const p = data.nodes[cur];
      for (const n of out.keys()) {
        if (visited.has(n)) continue;
        const d = dist(p, data.nodes[n]);
        if (d < bestD && turnAngle(heading, bearing(cur, n)) < 70) { bestD = d; next = n; }
      }
    }
    if (next != null) heading = bearing(cur, next);
    cur = next;
  }
  const coords = spine.map(id => data.nodes[id]);
  const xy = coords.map(toXY);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));

  // Ramps: link ways reachable from the carriageways through other links.
  const linkIds = new Set(), touch = new Set(nodeSet);
  const queue = [...nodeSet], seen = new Set(nodeSet);
  while (queue.length) {
    const x = queue.pop();
    for (const e of linkAdj.get(x) || []) {
      linkIds.add(e.way.id);
      touch.add(e.to);
      if (!seen.has(e.to) && !nodeSet.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return { wayIds, nodeSet, linkIds, touch, spine, coords, xy, cum, length: cum[cum.length - 1] };
}

// Distance along the spine of the closest point to a lat/lon, plus the spine heading there.
function project(g, ll) {
  const [px, py] = toXY(ll);
  let best = { d: Infinity, s: 0, i: 0 };
  for (let i = 0; i < g.xy.length - 1; i++) {
    const [ax, ay] = g.xy[i], [bx, by] = g.xy[i + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + t * dx - px, qy = ay + t * dy - py, d = qx * qx + qy * qy;
    if (d < best.d) best = { d, s: g.cum[i] + t * (g.cum[i + 1] - g.cum[i]), i };
  }
  const i = Math.min(best.i, g.spine.length - 2);
  return { s: best.s, dist: Math.sqrt(best.d), heading: bearingLL(g.coords[i], g.coords[i + 1]) };
}

function pointAt(g, s) {
  let i = 0;
  while (i < g.cum.length - 2 && g.cum[i + 1] < s) i++;
  const seg = g.cum[i + 1] - g.cum[i] || 1, t = Math.max(0, Math.min(1, (s - g.cum[i]) / seg));
  const a = g.coords[i], b = g.coords[i + 1];
  return { ll: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], i };
}

// Spine geometry between two distances along it.
function slice(g, s1, s2) {
  const a = pointAt(g, s1), b = pointAt(g, s2);
  return {
    coords: [a.ll, ...g.coords.slice(a.i + 1, b.i + 1), b.ll],
    osmNodes: g.spine.slice(a.i, b.i + 2),
  };
}

// Which travel direction(s) of the corridor pass through carriageway vertex h.
function carriagewayDirs(c, g, h) {
  const dirs = new Set();
  const heading = project(g, data.nodes[h]).heading;
  for (const w of nodeWays.get(h) || []) {
    if (!g.wayIds.has(w.id)) continue;
    const d = onewayDir(w);
    if (!d) { dirs.add('fwd'); dirs.add('rev'); continue; }
    const i = w.nodes.indexOf(h);
    const j = i + d >= 0 && i + d < w.nodes.length ? i + d : i - d;
    const travel = i + d === j ? bearing(h, w.nodes[j]) : bearing(w.nodes[j], h);
    dirs.add(turnAngle(heading, travel) < 90 ? 'fwd' : 'rev');
  }
  return [...dirs];
}

const emptyAccess = () => ({ fwd: { on: false, off: false }, rev: { on: false, off: false } });

// Work out how a node connects to a corridor, from OSM one-way tags:
//  - a two-way road meeting a carriageway at grade = on + off for that direction
//  - a ramp whose travel ends at the carriageway = on-ramp; starting there = off-ramp
function analyzeStation(node, c, g) {
  const acc = emptyAccess();
  const points = [];
  const mark = (h, dirs, on, off) => {
    for (const d of dirs) { acc[d].on ||= on; acc[d].off ||= off; }
    points.push(h);
  };
  const key = memberOf.get(node.members[0]);
  for (const m of node.members) {
    if (g.nodeSet.has(m)) {
      points.push(m);
      for (const w of nodeWays.get(m) || []) {
        if (g.wayIds.has(w.id) || isLink(w) || !wayOn(w)) continue;
        const d = onewayDir(w), i = w.nodes.indexOf(m), last = w.nodes.length - 1;
        let on = true, off = true;
        if (d && (i === 0 || i === last)) {
          const arrives = (d === 1) === (i === last);
          on = arrives; off = !arrives;
        }
        mark(m, carriagewayDirs(c, g, m), on, off);
      }
    }
    // Follow ramps out from this member (bounded) until they reach the carriageway.
    const seen = new Map([[m, 0]]);
    const queue = [m];
    while (queue.length) {
      const x = queue.shift();
      for (const e of linkAdj.get(x) || []) {
        if (!g.linkIds.has(e.way.id)) continue;
        const d0 = seen.get(x);
        if (g.nodeSet.has(x)) {
          // e leaves carriageway vertex x along ramp e.way
          const d = onewayDir(e.way);
          const leaves = d === 0 ? null : (d === 1) === e.fwd;
          mark(x, carriagewayDirs(c, g, x), leaves !== true, leaves !== false);
          if (x !== m) continue;
        }
        if (seen.has(e.to)) continue;
        const other = memberOf.get(e.to);
        if (other != null && other !== key) continue;
        const nd = d0 + dist(data.nodes[x], data.nodes[e.to]);
        if (nd > 2500) continue;
        seen.set(e.to, nd);
        queue.push(e.to);
      }
    }
  }
  if (!points.length) return null;
  const s = points.reduce((t, h) => t + project(g, data.nodes[h]).s, 0) / points.length;
  return { s, auto: acc };
}

function rebuildCorridors() {
  corrGeo = new Map();
  for (const c of corridors) corrGeo.set(c.id, buildCorridor(c));
}

// ---------- edges ----------
// At a junction where the current OSM way ends, continue onto a way carrying the same
// road name or route ref (so CA 9 carries on where it becomes River Street), but only
// the straightest one and only if it doesn't turn sharply.
const MAX_TURN = 60;
function continuation(prev, cur, way, opts) {
  const label = way.name || way.ref, refs = refsOf(way);
  if (!label) return null;
  const heading = bearing(prev, cur);
  let best = null, bestTurn = MAX_TURN;
  for (const o of opts) {
    if ((o.way.name || o.way.ref) !== label && !refsOf(o.way).some(r => refs.includes(r))) continue;
    const turn = turnAngle(heading, bearing(cur, o.to));
    if (turn < bestTurn) { bestTurn = turn; best = o; }
  }
  return best;
}

// Walk out from every member of every node along each incident road until reaching
// a member of another node. Pass straight through degree-2 vertices; at an unpicked
// junction keep going on the same road, otherwise stop and report an open end.
// Corridor carriageways and ramps are skipped here (corridors get their own edges),
// and touching a corridor at an unpicked vertex is an open end: it needs a station.
function deriveEdges() {
  edges = []; openEnds = [];
  stationInfo = new Map();
  const excluded = new Set(), corrTouch = new Set();
  for (const g of corrGeo.values()) {
    g.wayIds.forEach(id => excluded.add(id));
    g.linkIds.forEach(id => excluded.add(id));
    g.touch.forEach(id => corrTouch.add(id));
  }
  const seen = new Set(), openSeen = new Set();
  const addOpen = id => { if (!openSeen.has(id)) { openSeen.add(id); openEnds.push(id); } };
  for (const [startKey, node] of nodes) {
    for (const start of node.members) {
      for (const first of adj.get(start) || []) {
        if (excluded.has(first.way.id) || memberOf.get(first.to) === startKey) continue;
        const path = [start, first.to];
        const ways = [first.way];
        const visited = new Set(path);
        let prev = start, cur = first.to, way = first.way, open = false;
        while (!memberOf.has(cur)) {
          if (corrTouch.has(cur)) { open = true; break; }
          const opts = (adj.get(cur) || []).filter(o => o.to !== prev && !excluded.has(o.way.id));
          let next = null;
          if (opts.length === 1) next = opts[0];
          else if (opts.length > 1) next = opts.find(o => o.way === way) || continuation(prev, cur, way, opts);
          if (!next || (visited.has(next.to) && !memberOf.has(next.to))) { open = true; break; }
          if (next.way !== way) ways.push(next.way);
          prev = cur; cur = next.to; way = next.way;
          path.push(cur); visited.add(cur);
        }
        const endKey = open ? null : memberOf.get(cur);
        // A road that comes back to the very junction it left (Amber Ridge Loop) is kept as a
        // loop; anything else that returns to the same node is just a link inside it.
        const loop = endKey === startKey && cur === start && path.length > 3;
        if (endKey === startKey && !loop) continue;
        const fwd = path.join(','), rev = path.slice().reverse().join(',');
        const pathKey = fwd < rev ? fwd : rev;
        if (seen.has(pathKey)) continue;
        seen.add(pathKey);
        const coords = path.map(id => data.nodes[id]);
        let len = 0;
        for (let i = 1; i < coords.length; i++) len += dist(coords[i-1], coords[i]);
        edges.push({
          from: startKey, to: endKey, open, openAt: open ? cur : null, path, coords, length: len,
          names: [...new Set(ways.map(wayLabel))], wayIds: [...new Set(ways.map(w => w.id))],
          refs: [...new Set(ways.flatMap(refsOf))], loop,
        });
        if (open) addOpen(cur);
      }
    }
  }

  // Corridor edges: stations in order along the spine, one edge between neighbors.
  corridors.forEach((c, ci) => {
    const g = corrGeo.get(c.id);
    if (!g || g.spine.length < 2) return;
    const stations = [];
    for (const [key, node] of nodes) {
      const st = analyzeStation(node, c, g);
      if (!st) continue;
      const manual = node.access?.[c.id];
      const info = { corr: c, s: st.s, auto: st.auto, access: manual || st.auto, manual: !!manual };
      stations.push({ key, ...info });
      if (!stationInfo.has(key)) stationInfo.set(key, []);
      stationInfo.get(key).push(info);
    }
    stations.sort((a, b) => a.s - b.s);
    const color = CORRIDOR_COLORS[ci % CORRIDOR_COLORS.length];
    const push = (fromKey, toKey, s1, s2, openAt) => {
      if (s2 - s1 < 1) return;
      const sl = slice(g, s1, s2);
      edges.push({
        from: fromKey, to: toKey, open: toKey == null, openAt, path: sl.osmNodes, coords: sl.coords,
        length: s2 - s1, names: [c.label], wayIds: [], refs: [c.ref], corridor: c.id, color,
      });
      if (openAt != null) addOpen(openAt);
    };
    if (!stations.length) return;
    push(stations[0].key, null, 0, stations[0].s, g.spine[0]);
    for (let i = 0; i < stations.length - 1; i++) push(stations[i].key, stations[i + 1].key, stations[i].s, stations[i + 1].s, null);
    const last = stations[stations.length - 1];
    push(last.key, null, last.s, g.length, g.spine[g.spine.length - 1]);
  });
  // The first-station-to-spine-start edge runs backwards; flip so from = the station.
  for (const e of edges) if (e.corridor && e.open && e.coords.length && e.openAt === corrGeo.get(e.corridor).spine[0]) {
    e.coords = e.coords.slice().reverse(); e.path = e.path.slice().reverse();
  }

  // Number the connections between node pairs; parallel roads give several edges.
  const pairs = new Map();
  for (const e of edges) {
    if (e.open) continue;
    const k = [e.from, e.to].sort().join('|');
    pairs.set(k, (pairs.get(k) || 0) + 1);
    e.pair = k;
  }
  for (const e of edges) e.parallel = e.pair ? pairs.get(e.pair) : 1;
}

// "NB only", "NB · SB off", … ; null when the station has full access both ways.
function accessSummary(acc, labels) {
  const part = (d, l) => acc[d].on && acc[d].off ? l : acc[d].on ? `${l} on` : acc[d].off ? `${l} off` : null;
  const f = part('fwd', labels[0]), r = part('rev', labels[1]);
  if (f === labels[0] && r === labels[1]) return null;
  if (!f && !r) return 'no access';
  if (!f || !r) return `${f || r} only`;
  return `${f} · ${r}`;
}

function junctionNames(id) {
  const names = new Set();
  for (const o of adj.get(id) || []) names.add(wayLabel(o.way));
  return [...names];
}

// Auto-name from the named roads that meet at a node's junctions, minor roads last.
function suggestName(members) {
  const rank = { major: 0, second: 1, tert: 2, minor: 3, service: 4, track: 5 };
  const best = new Map();
  for (const id of members) for (const o of adj.get(id) || []) {
    const label = o.way.name || o.way.ref;
    if (!label) continue;
    const r = rank[hwClass[o.way.hw]?.key] ?? 9;
    if (!best.has(label) || r < best.get(label)) best.set(label, r);
  }
  const names = [...best].sort((a, b) => a[1] - b[1]).map(([l]) => l);
  // Put a non-highway name first: "Summit Road / Santa Cruz Highway" reads better as a station.
  if (names.length > 1 && best.get(names[0]) === 0 && best.get(names[1]) > 0) names.unshift(names.splice(1, 1)[0]);
  return names.length ? names.slice(0, 2).join(' / ') : `Node ${members[0]}`;
}
function autoName(node) { if (node.auto) node.name = suggestName(node.members); }

// ---------- rendering ----------
function renderRoads() {
  roadLayer.clearLayers();
  for (const c of [...CLASSES].reverse()) {
    const on = enabled.has(c.key);
    for (const w of data.ways) {
      if (hwClass[w.hw] !== c) continue;
      const ll = w.nodes.map(id => data.nodes[id]).filter(Boolean);
      L.polyline(ll, {
        renderer: roadRenderer, interactive: false, color: c.color,
        weight: on ? c.weight : 1, opacity: on ? 0.9 : 0.25, dashArray: c.dash,
      }).addTo(roadLayer);
    }
  }
}

function renderOverlay() {
  overlayLayer.clearLayers();
  // Corridor spines, faint, so a corridor is visible before it has stations.
  corridors.forEach((c, ci) => {
    const g = corrGeo.get(c.id);
    if (g) L.polyline(g.coords, { renderer: overlayRenderer, color: CORRIDOR_COLORS[ci % CORRIDOR_COLORS.length], weight: 10, opacity: 0.18, interactive: false }).addTo(overlayLayer);
  });
  if (showEdges) {
    edges.forEach((e, i) => {
      let style;
      if (e.corridor) style = { color: e.open ? OPEN_COLOR : e.color, weight: e.open ? 4 : 8, opacity: e.open ? 0.9 : 0.85, dashArray: e.open ? '2 7' : null };
      else style = { color: e.open ? OPEN_COLOR : EDGE_COLORS[i % EDGE_COLORS.length], weight: e.open ? 4 : 6, opacity: e.open ? 0.9 : 0.75, dashArray: e.open ? '2 7' : null };
      L.polyline(e.coords, { renderer: overlayRenderer, lineCap: 'round', ...style })
        .bindPopup(() => edgePopup(e), { className: 'popup' })
        .addTo(overlayLayer);
    });
  }

  // Candidate markers only for the current view; there are too many to draw region-wide.
  const view = map.getBounds().pad(0.25);
  const zoomOk = map.getZoom() >= MIN_CANDIDATE_ZOOM;
  const candidate = id => zoomOk && !memberOf.has(id) && view.contains(data.nodes[id]);
  if (showDeadEnds) {
    for (const id of deadEnds) if (candidate(id)) {
      L.circleMarker(data.nodes[id], { renderer: overlayRenderer, radius: 3, color: '#777', weight: 1, fillColor: '#fff', fillOpacity: 1 })
        .on('click', ev => pick(id, ev)).bindTooltip(() => junctionNames(id).join(' · ') + ' (dead end)').addTo(overlayLayer);
    }
  }
  for (const id of junctions) if (candidate(id)) {
    L.circleMarker(data.nodes[id], { renderer: overlayRenderer, radius: 5, color: '#333', weight: 1.5, fillColor: '#fff', fillOpacity: 1 })
      .on('click', ev => pick(id, ev)).bindTooltip(() => junctionNames(id).join(' · ')).addTo(overlayLayer);
  }
  if (showEdges) {
    for (const id of openEnds) if (!memberOf.has(id)) {
      L.circleMarker(data.nodes[id], { renderer: overlayRenderer, radius: 8, color: OPEN_COLOR, weight: 2.5, fillColor: '#fff', fillOpacity: 0.01 })
        .on('click', ev => pick(id, ev))
        .bindTooltip('Open end · ' + junctionNames(id).join(' · ')).addTo(overlayLayer);
    }
  }

  for (const [key, n] of nodes) {
    const c = centroid(n);
    const isActive = key === active;
    if (n.members.length > 1) {
      for (const id of n.members) {
        L.polyline([c, data.nodes[id]], { renderer: overlayRenderer, color: '#111', weight: 1.5, dashArray: '3 3', interactive: false }).addTo(overlayLayer);
        L.circleMarker(data.nodes[id], { renderer: overlayRenderer, radius: 4, color: '#fff', weight: 1.5, fillColor: '#111', fillOpacity: 1 })
          .on('click', ev => pick(id, ev)).bindTooltip(esc(n.name) + ' (member)').addTo(overlayLayer);
      }
    }
    const m = L.circleMarker(c, { renderer: overlayRenderer, radius: isActive ? 10 : 8, color: isActive ? '#0b6bcb' : '#fff', weight: 3, fillColor: '#111', fillOpacity: 1 })
      .bindPopup(() => nodePopup(key), { className: 'popup' })
      .on('click', () => { active = key; renderSide(); })
      .addTo(overlayLayer);
    const badges = (stationInfo.get(key) || []).map(si => accessSummary(si.access, si.corr.dirLabels)).filter(Boolean);
    if (badges.length) m.bindTooltip(esc(badges.join(' / ')), { permanent: true, direction: 'right', offset: [10, 0], className: 'badge' });
    else m.bindTooltip(esc(n.name), { direction: 'top', offset: [0, -8] });
  }
}

const nodeName = key => key == null ? 'open end' : (nodes.get(key)?.name ?? key);

function edgePopup(e) {
  const par = e.parallel > 1 ? `<br>${e.parallel} parallel edges between these nodes` : '';
  const kind = e.corridor ? ' (corridor)' : '';
  return `<div><b>${esc(e.names.join(' → '))}</b>${kind}
    <div class="meta">${esc(nodeName(e.from))} ⟷ ${esc(nodeName(e.to))}<br>${fmtLen(e.length)} · ${e.path.length} OSM vertices${par}</div></div>`;
}

function nodePopup(key) {
  const n = nodes.get(key);
  const div = document.createElement('div');
  const links = n.members.map(id => `<a href="https://www.openstreetmap.org/node/${id}" target="_blank">${id}</a>`).join(', ');
  const [lat, lon] = centroid(n);
  const accessHtml = (stationInfo.get(key) || []).map(si => {
    const [f, r] = si.corr.dirLabels;
    const cb = (d, k) => `<input type="checkbox" data-c="${esc(si.corr.id)}" data-d="${d}" data-k="${k}" ${si.access[d][k] ? 'checked' : ''}>`;
    return `<div class="access"><b>${esc(si.corr.label)}</b> access
      <span class="src">${si.manual ? '· edited · <a data-reset="' + esc(si.corr.id) + '">reset to OSM</a>' : '· from OSM'}</span>
      <table><tr><th></th><th>on</th><th>off</th></tr>
      <tr><td>${esc(f)}</td><td>${cb('fwd', 'on')}</td><td>${cb('fwd', 'off')}</td></tr>
      <tr><td>${esc(r)}</td><td>${cb('rev', 'on')}</td><td>${cb('rev', 'off')}</td></tr></table></div>`;
  }).join('');
  div.innerHTML = `<input type="text" value="${esc(n.name)}">
    <div class="meta">${n.members.length > 1 ? `${n.members.length} junctions: ` : 'OSM node '}${links}<br>${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
    ${accessHtml}
    <div class="row"><button class="grp">${groupMode && active === key ? 'Done grouping' : 'Add junctions…'}</button><button class="del">Remove node</button>${shell ? '<button class="lay">Show in layout</button>' : ''}</div>`;
  const input = div.querySelector('input[type=text]');
  input.addEventListener('change', () => { pushHistory(); n.name = input.value.trim() || n.name; n.auto = false; commit(false); });
  input.addEventListener('keydown', ev => { if (ev.key === 'Enter') { input.blur(); map.closePopup(); } });
  div.querySelectorAll('.access input').forEach(cb => cb.addEventListener('change', () => {
    pushHistory();
    const cid = cb.dataset.c;
    const si = stationInfo.get(key).find(s => s.corr.id === cid);
    const acc = JSON.parse(JSON.stringify(si.access));
    acc[cb.dataset.d][cb.dataset.k] = cb.checked;
    n.access = { ...(n.access || {}), [cid]: acc };
    map.closePopup();
    commit();
  }));
  div.querySelectorAll('[data-reset]').forEach(a => a.addEventListener('click', () => {
    pushHistory();
    delete n.access[a.dataset.reset];
    map.closePopup();
    commit();
  }));
  div.querySelector('.del').addEventListener('click', () => { map.closePopup(); removeNode(key); });
  div.querySelector('.lay')?.addEventListener('click', () => { map.closePopup(); shell.show('layout', { node: key, lat, lon }); });
  div.querySelector('.grp').addEventListener('click', () => { map.closePopup(); active = key; setGroupMode(!groupMode); renderOverlay(); renderSide(); });
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return div;
}

function renderCorridors() {
  const box = document.getElementById('corridors');
  box.innerHTML = '';
  corridors.forEach((c, ci) => {
    const g = corrGeo.get(c.id);
    const nSt = [...stationInfo.values()].filter(list => list.some(si => si.corr.id === c.id)).length;
    const el = document.createElement('div');
    el.className = 'corr';
    el.innerHTML = `<span class="bar" style="background:${CORRIDOR_COLORS[ci % CORRIDOR_COLORS.length]}"></span>
      <span class="nm">${esc(c.label)} <span class="meta">${esc(c.dirLabels.join('/'))} · ${nSt} stations · ${g ? fmtLen(g.length) : ''}</span></span>
      <button class="x" title="Edit name and directions">✎</button><button class="x" title="Remove corridor">✕</button>`;
    const [edit, del] = el.querySelectorAll('button');
    edit.onclick = () => {
      const label = prompt(`Name for ${c.ref}:`, c.label);
      if (label == null) return;
      const dirs = prompt('Direction labels, forward/reverse (forward = heading away from the south end):', c.dirLabels.join('/'));
      if (dirs == null) return;
      pushHistory();
      c.label = label.trim() || c.label;
      const parts = dirs.split('/').map(s => s.trim()).filter(Boolean);
      if (parts.length === 2) c.dirLabels = parts;
      commit();
    };
    del.onclick = () => {
      if (!confirm(`Remove corridor ${c.label}? Stations stay as nodes; access edits for it are kept.`)) return;
      pushHistory();
      corridors = corridors.filter(x => x !== c);
      rebuildCorridors();
      commit();
    };
    box.appendChild(el);
  });
  const avail = corridorCandidates().filter(r => !corridors.some(c => c.ref === r));
  if (avail.length) {
    const row = document.createElement('div');
    row.className = 'row addcorr';
    for (const r of avail) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = '+ ' + r;
      b.title = `Treat ${r} as one line with stations`;
      b.onclick = () => addCorridor(r);
      row.appendChild(b);
    }
    box.appendChild(row);
  }
  if (!corridors.length && !avail.length) box.innerHTML = '<div class="empty" style="padding:0">No divided highways found.</div>';
}

function renderSide() {
  document.getElementById('sNodes').textContent = nodes.size;
  document.getElementById('sEdges').textContent = new Set(edges.filter(e => !e.open).map(e => e.pair)).size;
  document.getElementById('sOpen').textContent = openEnds.length;
  document.getElementById('sOpenWrap').classList.toggle('warn', openEnds.length > 0);
  renderCorridors();
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!nodes.size) list.innerHTML = '<div class="empty">No nodes yet. Zoom in and click a junction.</div>';
  const items = [...nodes.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
  for (const [key, n] of items) {
    const el = document.createElement('div');
    el.className = 'item' + (key === active ? ' active' : '');
    const badge = (stationInfo.get(key) || []).map(si => accessSummary(si.access, si.corr.dirLabels)).filter(Boolean).join(' / ');
    el.innerHTML = `<span class="dot"></span><span class="nm">${esc(n.name)}</span>` +
      (badge ? `<span class="acc">${esc(badge)}</span>` : '') +
      (n.members.length > 1 ? `<span class="cnt">×${n.members.length}</span>` : '') +
      `<button class="x" title="Remove">✕</button>`;
    el.addEventListener('click', () => { active = key; map.setView(centroid(n), Math.max(map.getZoom(), 15)); renderSide(); });
    el.querySelector('.x').addEventListener('click', ev => { ev.stopPropagation(); removeNode(key); });
    list.appendChild(el);
  }
  const mh = document.getElementById('modeHint');
  mh.hidden = !(groupMode || snapMode);
  mh.textContent = groupMode
    ? (active ? `Grouping into “${nodes.get(active).name}” — click junctions to add` : 'Grouping — click a junction to start a node')
    : 'Click on any road to place a node';
}

// ---------- actions ----------
const snapshot = () => JSON.stringify({ nodes: [...nodes], active, corridors });
function pushHistory() { history.push(snapshot()); if (history.length > 200) history.shift(); }
function undo() {
  if (!history.length) return;
  const j = JSON.parse(history.pop());
  const corrChanged = JSON.stringify(j.corridors) !== JSON.stringify(corridors);
  nodes = new Map(j.nodes); active = j.active; corridors = j.corridors;
  reindex();
  if (corrChanged) rebuildCorridors();
  commit();
}

// Click on an OSM vertex: select it, or with Shift/group mode add it to (or remove it from) the active node.
function pick(id, ev) {
  const grouping = groupMode || ev?.originalEvent?.shiftKey;
  const owner = memberOf.get(id);
  pushHistory();
  if (owner != null) {
    const n = nodes.get(owner);
    if (grouping && n.members.length > 1) {
      n.members = n.members.filter(m => m !== id);
      autoName(n);
      rekey(owner);
    } else if (!grouping) {
      active = owner;
      history.pop();
      renderOverlay(); renderSide();
      return;
    }
  } else if (grouping && active && nodes.has(active)) {
    const n = nodes.get(active);
    n.members.push(id);
    autoName(n);
  } else {
    const key = String(id);
    nodes.set(key, { name: suggestName([id]), members: [id], auto: true });
    active = key;
  }
  reindex();
  commit();
}

// Keep a node's key equal to its first member after membership changes.
function rekey(key) {
  const n = nodes.get(key);
  const nk = String(n.members[0]);
  if (nk === key) return;
  nodes = new Map([...nodes].map(([k, v]) => k === key ? [nk, v] : [k, v]));
  if (active === key) active = nk;
}

function removeNode(key) {
  pushHistory();
  nodes.delete(key);
  reindex();
  commit();
}

function addCorridor(ref) {
  pushHistory();
  const num = ref.replace(/^[A-Z]+\s*/, '');
  corridors.push({ id: ref.replace(/\s+/g, '-'), ref, label: /^\d+$/.test(num) ? `Hwy ${num}` : ref, dirLabels: ['NB', 'SB'] });
  rebuildCorridors();
  commit();
}

function commit(redraw = true) {
  deriveEdges();
  if (redraw) renderOverlay();
  renderSide();
  markDirty();
}

// ---------- persistence ----------
// The save server (scripts/server.mjs) is the source of truth: every change is PUT to
// /api/graph after a short delay and written to data/graph.json. localStorage only
// buffers edits that haven't reached the server yet (crash, server down).
// Tells the layout editor (and preview) in other tabs or frames to pick up a new graph.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('subway') : null;
let serverMode = false, rev = 0, changeSeq = 0, savedSeq = 0, inflight = false, saveTimer = null, conflict = false;

function stateObj() {
  return {
    version: STATE_VERSION,
    enabled: [...enabled],
    corridors,
    active,
    nodes: [...nodes].map(([id, n]) => ({ id, name: n.name, auto: !!n.auto, members: n.members, ...(n.access && Object.keys(n.access).length ? { access: n.access } : {}) })),
  };
}
function applyState(s) {
  if (!s) return;
  if (s.enabled) enabled = new Set(s.enabled);
  corridors = s.corridors || [];
  active = s.active ?? null;
  const list = Array.isArray(s.nodes) && s.nodes.length && Array.isArray(s.nodes[0])
    ? s.nodes.map(([id, n]) => ({ id, ...n }))   // legacy v2 [key, node] pairs
    : (s.nodes || []);
  nodes = new Map(list.filter(n => n.members.every(id => data.nodes[id]))
    .map(n => [String(n.id), { name: n.name, auto: !!n.auto, members: n.members, ...(n.access ? { access: n.access } : {}) }]));
  reindex();
}

function setStatus(cls, text) {
  const el = document.getElementById('saveStatus');
  el.className = cls;
  el.textContent = text;
}
const clock = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function writeBuffer() {
  try { localStorage.setItem(BUFFER_KEY, JSON.stringify({ baseRev: rev, dirty: changeSeq !== savedSeq, state: stateObj() })); } catch {}
}

function markDirty() {
  if (!ready) return;
  changeSeq++;
  writeBuffer();
  if (!serverMode) { setStatus('local', 'Browser only — not saved to disk'); return; }
  if (conflict) return;
  setStatus('pending', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY);
}

async function flush() {
  if (inflight || conflict || changeSeq === savedSeq) return;
  inflight = true;
  const seq = changeSeq;
  try {
    const r = await fetch(API, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev, state: stateObj(), derived: derivedObj() }),
    });
    if (r.status === 409) {
      conflict = true;
      setStatus('conflict', 'Changed elsewhere — reload');
      alert('The saved graph was changed by another tab or window. Your edits here are kept in this browser, but not saved. Reload to pick up the other changes.');
    } else if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    } else {
      const j = await r.json();
      rev = j.rev;
      savedSeq = seq;
      writeBuffer();
      channel?.postMessage({ type: 'graph-saved', rev });
      setStatus(changeSeq === savedSeq ? 'saved' : 'pending', changeSeq === savedSeq ? `Saved ${clock(j.savedAt)}` : 'Saving…');
    }
  } catch (e) {
    setStatus('offline', 'Not saved — server unreachable');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 5000);
  } finally {
    inflight = false;
    if (!conflict && changeSeq !== savedSeq) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, SAVE_DELAY); }
  }
}

window.addEventListener('beforeunload', ev => {
  if (changeSeq !== savedSeq && serverMode) { ev.preventDefault(); ev.returnValue = ''; }
});

// Load order: server file, plus any unsaved buffered edits made on top of that same revision.
// Without the server, fall back to the browser buffer (or the old v2 browser storage).
async function loadState() {
  let buffer = null, legacy = null;
  try { buffer = JSON.parse(localStorage.getItem(BUFFER_KEY)); } catch {}
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch {}
  let server = null;
  try {
    const r = await fetch(API, { cache: 'no-store' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) server = await r.json();
  } catch {}
  serverMode = !!server;
  if (server) {
    rev = server.rev;
    if (buffer?.dirty && buffer.baseRev === server.rev) {
      applyState(buffer.state); return { pending: true, msg: 'Restored unsaved edits from this browser' };
    }
    if (buffer?.dirty && buffer.baseRev !== server.rev) {
      try { localStorage.setItem(BUFFER_KEY + '.orphaned', JSON.stringify(buffer)); } catch {}
      console.warn('Unsaved browser edits were based on an older save; kept under', BUFFER_KEY + '.orphaned');
    }
    if (server.state) { applyState(server.state); return { pending: false, savedAt: server.savedAt }; }
    // Nothing on disk yet: seed it from whatever this browser had.
    if (buffer?.state) { applyState(buffer.state); return { pending: true, msg: 'Moved browser data to disk' }; }
    if (legacy?.nodes) { applyState({ nodes: legacy.nodes, enabled: legacy.enabled, active: legacy.active }); return { pending: true, msg: 'Moved browser data to disk' }; }
    return { pending: false };
  }
  if (buffer?.state) applyState(buffer.state);
  else if (legacy?.nodes) applyState({ nodes: legacy.nodes, enabled: legacy.enabled, active: legacy.active });
  return { pending: false };
}

function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify([map.getCenter().lat, map.getCenter().lng, map.getZoom()])); } catch {}
}
function loadView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY)) || JSON.parse(localStorage.getItem(LEGACY_KEY))?.view || null; } catch { return null; }
}

// Whether the road keeps going past an open end: the way runs on through it, another way
// of the same route (or the same name, for a road with no route number) carries on from
// it, or nothing else meets it at all (the way runs off the edge of the downloaded data).
// A route that ends at a junction, like Hwy 17 at Hwy 1, doesn't.
function continuesPast(e) {
  const ws = nodeWays.get(e.openAt) || [];
  if (ws.length <= 1) return true;
  const same = e.refs?.length ? (w => refsOf(w).some(r => e.refs.includes(r))) : (w => e.names.includes(wayLabel(w)));
  const mine = ws.filter(same);
  return mine.length >= 2 || mine.some(w => w.nodes[0] !== e.openAt && w.nodes[w.nodes.length - 1] !== e.openAt);
}

// ---------- export / import ----------
function derivedObj() {
  return {
    version: DERIVED_VERSION,
    generatedAt: new Date().toISOString(),
    osmTimestamp: data.timestamp,
    roadClasses: [...enabled],
    corridors: corridors.map(c => {
      const g = corrGeo.get(c.id);
      return { ...c, lengthMeters: g ? Math.round(g.length) : null, spine: g ? { osmNodes: g.spine, coords: g.coords } : null };
    }),
    nodes: [...nodes].map(([key, n]) => {
      const [lat, lon] = centroid(n);
      const st = (stationInfo.get(key) || []).map(si => ({
        corridor: si.corr.id, chainageMeters: Math.round(si.s), access: si.access, accessSource: si.manual ? 'manual' : 'osm',
      }));
      return { id: key, name: n.name, auto: !!n.auto, lat: +lat.toFixed(6), lon: +lon.toFixed(6), osmNodes: n.members,
        ...(n.access ? { access: n.access } : {}), ...(st.length ? { corridors: st } : {}) };
    }),
    edges: edges.map((e, i) => ({
      id: `e${i + 1}`, from: e.from, to: e.to, openEndOsmNode: e.openAt ?? undefined, corridor: e.corridor,
      continues: e.open ? continuesPast(e) : undefined,
      roads: e.names, refs: e.refs?.length ? e.refs : undefined, osmWays: e.wayIds, lengthMeters: Math.round(e.length), parallel: e.parallel,
      loop: e.loop || undefined, osmNodes: e.path, coords: e.coords,
    })),
  };
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(derivedObj(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'graph-nodes.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importJSON(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const j = JSON.parse(r.result);
      pushHistory();
      nodes = new Map(j.nodes.map(n => {
        const members = n.osmNodes ?? n.members ?? [n.osmNode];
        return [String(members[0]), { name: n.name, members, auto: !!n.auto, ...(n.access ? { access: n.access } : {}) }];
      }));
      active = null;
      reindex();
      if (j.corridors) { corridors = j.corridors.map(({ id, ref, label, dirLabels }) => ({ id, ref, label, dirLabels })); rebuildCorridors(); }
      if (j.roadClasses) { enabled = new Set(j.roadClasses); buildClassUI(); buildGraph(); renderRoads(); }
      commit();
    } catch (e) { alert('Could not read that file: ' + e.message); }
  };
  r.readAsText(file);
}

// ---------- UI wiring ----------
function buildClassUI() {
  const box = document.getElementById('classes');
  box.innerHTML = '';
  for (const c of CLASSES) {
    const lab = document.createElement('label');
    lab.innerHTML = `<input type="checkbox" ${enabled.has(c.key) ? 'checked' : ''}><span class="swatch" style="background:${c.color}"></span>${c.label}`;
    lab.querySelector('input').addEventListener('change', ev => {
      ev.target.checked ? enabled.add(c.key) : enabled.delete(c.key);
      buildGraph(); renderRoads(); commit();
    });
    box.appendChild(lab);
  }
}

const setBtn = (id, on) => document.getElementById(id).classList.toggle('on', on);
function setSnapMode(on) {
  snapMode = on; setBtn('btnSnap', on);
  if (on) setGroupMode(false);
  map.getContainer().style.cursor = on ? 'crosshair' : '';
  renderSide();
}
function setGroupMode(on) {
  groupMode = on; setBtn('btnGroup', on);
  if (on && snapMode) setSnapMode(false);
  renderSide();
}
document.getElementById('btnSnap').onclick = () => setSnapMode(!snapMode);
document.getElementById('btnGroup').onclick = () => setGroupMode(!groupMode);
document.getElementById('btnDeadEnds').onclick = () => { showDeadEnds = !showDeadEnds; setBtn('btnDeadEnds', showDeadEnds); renderOverlay(); };
document.getElementById('btnEdges').onclick = () => { showEdges = !showEdges; setBtn('btnEdges', showEdges); renderOverlay(); };
document.getElementById('btnUndo').onclick = undo;
document.getElementById('btnExport').onclick = exportJSON;
document.getElementById('btnImport').onclick = () => document.getElementById('fileIn').click();
document.getElementById('fileIn').onchange = ev => { if (ev.target.files[0]) importJSON(ev.target.files[0]); ev.target.value = ''; };
document.getElementById('btnClear').onclick = () => {
  if (!nodes.size || !confirm(`Remove all ${nodes.size} nodes? (Undo can restore them.)`)) return;
  pushHistory(); nodes.clear(); reindex(); commit();
};
document.addEventListener('keydown', ev => {
  if (document.activeElement.tagName === 'INPUT') return;
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') { ev.preventDefault(); undo(); }
  if (ev.key === 'Escape') { setGroupMode(false); setSnapMode(false); }
});

function snapToRoad(latlng) {
  const pt = map.latLngToContainerPoint(latlng);
  let best = null, bestD = 18 ** 2;
  const b = map.getBounds().pad(0.05);
  for (const id of adj.keys()) {
    const c = data.nodes[id];
    if (!b.contains(c)) continue;
    const p = map.latLngToContainerPoint(c);
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

map.on('click', ev => {
  if (!(snapMode || ev.originalEvent.altKey)) return;
  const id = snapToRoad(ev.latlng);
  if (id != null && !memberOf.has(id)) pick(id, ev);
});
map.on('moveend', () => { if (ready) { renderOverlay(); renderHint(); saveView(); } });

function renderHint() {
  document.getElementById('zoomHint').hidden = map.getZoom() >= MIN_CANDIDATE_ZOOM;
}

// ---------- tools shell ----------
// In tools/index.html the picker, layout editor and preview are tabs; switching tabs
// carries the place you're looking at (and the selected node) across.
const shell = window.parent !== window ? window.parent.subwayShell : null;
const mpp = (z, lat) => 156543.03 * Math.cos(lat * rad) / 2 ** z;
// Exposed once booted (the shell waits for it).
const focusApi = {
  get() {
    const c = map.getCenter();
    return { lat: c.lat, lon: c.lng, mpp: mpp(map.getZoom(), c.lat), node: active };
  },
  set(f) {
    if (ed) shell.editor().then(x => { ed = x || ed; refreshPlaces(); });
    let ll = f.lat != null ? [f.lat, f.lon] : null;
    if (f.node && nodes.has(f.node)) { active = f.node; ll = centroid(nodes.get(f.node)); renderOverlay(); renderSide(); }
    if (!ll) return;
    const z = f.mpp ? Math.log2(156543.03 * Math.cos(ll[0] * rad) / f.mpp) : map.getZoom();
    map.setView(ll, Math.max(11, Math.min(18, Math.round(z))), { animate: false });
  },
};

// ---------- places ----------
// OpenStreetMap places (from the layout editor, which owns the map's list of places). Clicking
// one adds it to whichever layout the Layout tab has open, on the nearest road.
const PLACE_ZOOM = 15;
const placeLayer = L.layerGroup();
const placeMarks = new Map();   // osm id -> marker
let ed = null, showPlaces = true;
function placeIcon(o) {
  const on = ed.places.some(pl => pl.id === o.osm);
  return L.divIcon({ className: '', iconSize: [22, 22], html: `<div class="plMark${on ? ' on' : ''}">${esc(placeKind(o.kind)[0])}</div>` });
}
let placesOn = new Set();
function refreshPlaces() {
  if (!ed) return;
  // Only the markers whose state changed (a new icon would close an open popup).
  const now = new Set(ed.places.map(pl => pl.id));
  for (const id of new Set([...now, ...placesOn])) {
    if (now.has(id) === placesOn.has(id)) continue;
    const m = placeMarks.get(id);
    m?.getElement()?.firstElementChild?.classList.toggle('on', now.has(id));
    if (m) m.options.icon = placeIcon(m.o);
  }
  placesOn = now;
  renderPlaceLayer();
}
function renderPlaceLayer() {
  const want = ed && showPlaces && map.getZoom() >= PLACE_ZOOM;
  if (want && !map.hasLayer(placeLayer)) placeLayer.addTo(map);
  else if (!want && map.hasLayer(placeLayer)) map.removeLayer(placeLayer);
}
function placePopup(o) {
  const had = ed.places.find(pl => pl.id === o.osm), [icon, type] = placeKind(o.kind);
  const where = ed.area ? `the ${esc(ed.area.label)} map` : 'the main map';
  const off = had ? 0 : ed.placeOff(o);
  const div = document.createElement('div');
  div.className = 'popup';
  div.innerHTML = `<div class="plHead">${esc(icon)} ${esc(had ? had.name : o.name)}</div>` +
    `<div class="meta">${esc(had ? had.type : type)}${o.street ? ` · ${esc(o.street)}` : ''}</div>` +
    (had ? `<div class="meta" style="margin-top:4px">On ${where}</div><div class="row"><button data-act="show">Show in Layout</button><button data-act="remove" class="del">Remove</button></div>`
      : `<div class="row"><button data-act="add">Add to ${where}</button></div>` +
        (off > 400 ? `<div class="warn">⚠ ${(off / 1000).toFixed(1)} km from the nearest road on ${where}</div>` : ''));
  div.onclick = async (ev) => {
    const act = ev.target.dataset?.act;
    if (!act) return;
    if (act === 'add') ed.addOsmPlace(o.osm);
    else if (act === 'remove') ed.removePlace(o.osm);
    refreshPlaces();
    if (act === 'show') { map.closePopup(); await shell.show('layout'); ed.selectPlace(o.osm, true); }
    // After the click is done: Leaflet takes a click on a button that's no longer in the popup for a map click.
    else setTimeout(() => placeMarks.get(o.osm)?.setPopupContent(placePopup(o)));
  };
  return div;
}
async function loadPlaces() {
  if (!shell?.editor) return;
  ed = await shell.editor();
  if (!ed) return;
  await ed.osmLoaded;
  for (const o of ed.osmPlaces) {
    const m = L.marker([o.lat, o.lon], { icon: placeIcon(o), riseOnHover: true })
      .bindTooltip(esc(o.name), { direction: 'top', offset: [0, -10] })
      .bindPopup(() => placePopup(o))
      .addTo(placeLayer);
    m.o = o;
    placeMarks.set(o.osm, m);
  }
  placesOn = new Set(ed.places.map(pl => pl.id));
  const btn = document.getElementById('btnPlaces');
  btn.hidden = false;
  btn.onclick = () => { showPlaces = !showPlaces; btn.classList.toggle('on', showPlaces); renderPlaceLayer(); };
  document.getElementById('placesHelp').hidden = false;
  map.on('zoomend', renderPlaceLayer);
  // The Layout tab may have changed the list (or switched to a neighborhood's map) while this one was hidden.
  window.addEventListener('focus', async () => { ed = (await shell.editor()) || ed; refreshPlaces(); });
  renderPlaceLayer();
}

// ---------- boot ----------
async function fetchData() {
  for (const url of DATA_URLS) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
  }
  throw new Error('roads.json not found');
}

(async () => {
  data = await fetchData();
  indexData();
  const loaded = await loadState();
  document.getElementById('sourceLine').textContent =
    `OSM roads · ${data.ways.length.toLocaleString()} ways · data ${String(data.timestamp || '').slice(0, 10)}`;
  const boundary = L.polyline(data.boundary.map(r => [...r, r[0]]), {
    color: '#0b6bcb', weight: 2, dashArray: '6 4', opacity: 0.7, interactive: false, renderer: roadRenderer,
  }).addTo(map);
  const view = loadView();
  if (view) map.setView([view[0], view[1]], view[2]);
  else map.fitBounds(boundary.getBounds());
  buildClassUI();
  buildGraph();
  rebuildCorridors();
  renderRoads();
  deriveEdges();
  renderOverlay();
  renderSide();
  renderHint();
  ready = true;
  if (!serverMode) setStatus('local', 'Browser only — not saved to disk');
  else if (loaded.pending) { setStatus('pending', loaded.msg); markDirty(); }
  else setStatus('saved', loaded.savedAt ? `Saved ${clock(loaded.savedAt)}` : 'Nothing saved yet');
  document.getElementById('loading').remove();
  // A derived file written by an older version of this tool is rewritten in the current format.
  if (serverMode && nodes.size && !loaded.pending) {
    try {
      const d = await (await fetch('/data/graph-derived.json', { cache: 'no-store' })).json();
      if ((d.version || 0) < DERIVED_VERSION) markDirty();
    } catch {}
  }
  window.subwayFocus = focusApi;
  loadPlaces().catch(err => console.warn('places:', err));
  // Handle for poking at things from the devtools console.
  window.nodePicker = {
    map, data, pick, addCorridor, flush, resave: () => markDirty(),
    get nodes() { return nodes; }, get edges() { return edges; }, get junctions() { return junctions; },
    get corridors() { return corridors; }, get corrGeo() { return corrGeo; }, get stationInfo() { return stationInfo; },
  };
})().catch(err => {
  console.error(err);
  document.getElementById('loading').textContent = 'Failed to load: ' + err.message;
});
