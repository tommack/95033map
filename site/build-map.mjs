// Builds the public map's data (site/data/map.json) from the two editors' derived files.
// Shared by scripts/build-site.mjs (Node) and the live preview (site/?live in the browser),
// so it uses nothing but plain JS.
//
//   buildMap(graph, layout, slugs) -> { map, slugs, warnings }
//     graph:  data/graph-derived.json   (node picker: real geometry)
//     layout: data/layout-derived.json  (layout editor, version 2+: schematic anchors, styles)
//     slugs:  data/slugs.json or null   (link names handed out so far; returned updated)
//
//   buildAll(graph, layout, areaLayouts, slugs) -> { map, areas, slugs, warnings }
//     The main map and a map of each neighborhood that has one: areaLayouts is { g35: the
//     layout editor's data/layout-g35-derived.json, ... }; areas is { 'redwood-estates': map }.
//     The main map's neighborhood node says which (sub: 'redwood-estates').
//
// Links: every edge gets a readable, permanent slug like "summit-rd-3", and every junction
// one like "summit-rd-soquel-san-jose-rd". Once handed out a slug never changes or gets
// reused. If the graph changes so an edge disappears, its slug is "retired" with a copy of
// its real geometry, and old links resolve to the same spot on whatever road is there now.

export const MAP_VERSION = 1;

// The layout editor's stable edge key (see buildGraph in tools/layout-editor): each end is
// "node/next OSM node", stored in the direction whose key sorts first.
export function edgeKeys(graph) {
  const seen = new Map();
  return graph.edges.map((e) => {
    if (!e.coords || e.coords.length < 2) return null;
    const on = e.osmNodes || [];
    const b = e.to ?? `open:${e.openEndOsmNode}`;
    let da = `${e.from}/${on[1] ?? e.corridor ?? ''}`, db = `${b}/${on[on.length - 2] ?? e.corridor ?? ''}`;
    const rev = da > db;
    if (rev) [da, db] = [db, da];
    let key = `${da}|${db}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (n) key += `#${n}`;
    return { key, rev };
  });
}

export function shortName(name) {
  return String(name || '').replace(/\b(Road|Rd)\b/g, 'Rd').replace(/\bAvenue\b/g, 'Ave').replace(/\bStreet\b/g, 'St').replace(/\bDrive\b/g, 'Dr');
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Douglas-Peucker on [x, y, t] points, keeping each point's t (fraction of the full road).
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const [ax, ay] = pts[i], [bx, by] = pts[j];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bd = tol;
    for (let k = i + 1; k < j; k++) {
      const [px, py] = pts[k];
      const s = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(ax + s * dx - px, ay + s * dy - py);
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = 1; stack.push([i, best], [best, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r1 = (v) => Math.round(v * 10) / 10;

export function buildMap(graph, layout, slugsIn = null, { live: liveElsewhere = null } = {}) {
  const warnings = [];
  if (!layout || (layout.version || 0) < 2 || !layout.proj) {
    throw new Error('data/layout-derived.json was written by an older layout editor. Open the layout editor once to update it.');
  }
  if (layout.graphGeneratedAt !== graph.generatedAt) {
    warnings.push('The graph changed after the layout was last saved; open the layout editor to bring the layout up to date (it updates the neighborhood maps too).');
  }
  const { lat0, lon0, kx, ky } = layout.proj;
  const P = (lat, lon) => [(lon - lon0) * kx, -(lat - lat0) * ky];
  const U = ([x, y]) => [r5(lat0 - y / ky), r5(lon0 + x / kx)];

  const keys = edgeKeys(graph);
  const byKey = new Map();
  graph.edges.forEach((e, i) => { if (keys[i]) byKey.set(keys[i].key, { e, rev: keys[i].rev }); });

  // Real geometry in the layout's plane, canonical direction, as flat [x, y, t, ...].
  function real(key) {
    const g = byKey.get(key);
    if (!g) return null;
    const pts = g.e.coords.map((c) => P(c[0], c[1]));
    if (g.rev) pts.reverse();
    let len = 0;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push((len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
    const withT = pts.map((p, i) => [p[0], p[1], len ? cum[i] / len : i / (pts.length - 1)]);
    const flat = [];
    for (const [x, y, t] of simplify(withT, 3)) flat.push(r1(x), r1(y), r5(t));
    return { flat, len };
  }

  const graphNode = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes = layout.nodes.map((n) => {
    const g = graphNode.get(n.id);
    const out = { id: n.id, x: n.x, y: n.y };
    if (n.kind) out.kind = n.kind;
    if (n.label) out.label = n.label;
    if (g) { out.name = n.name || g.name; out.lat = g.lat; out.lon = g.lon; }
    if (n.ll) [out.lat, out.lon] = n.ll;   // a neighborhood: the middle of its junctions
    if (n.roads) out.roads = n.roads;
    if (n.size) out.size = n.size;
    if (n.main) out.main = n.main;   // a neighborhood: the road its stand-in line is drawn along
    if (n.stations) out.stations = n.stations;
    if (n.lod) out.lod = n.lod;
    if (n.local) out.local = 1;   // left off by "Hide local roads"
    if (n.plain) out.plain = 1;
    if (n.gap) out.gap = 1;   // a closure drawn as a break in the line: the road doesn't connect here any more   // no circle: one road just carries on through it
    return out;
  });
  const nodeIdx = new Map(nodes.map((n, i) => [n.id, i]));

  const edges = [];
  for (const e of layout.edges) {
    const r = real(e.key);
    if (!r) { warnings.push(`Edge ${e.key} isn't in the graph any more; skipped.`); continue; }
    const out = {
      key: e.key, a: nodeIdx.get(e.a), b: nodeIdx.get(e.b), road: e.road || '', len: Math.round(r.len),
      an: e.anchors.flat(), real: r.flat,
    };
    if (e.roads?.length > 1 || (e.roads?.[0] && e.roads[0] !== e.road)) out.roads = e.roads;
    if (e.kind) out.kind = e.kind;
    if (e.full) out.full = 1;   // a stub drawn at its road's weight: it carries the road on
    if (e.corridor) out.corridor = e.corridor;
    if (e.tier) out.tier = e.tier;
    if (e.lod) out.lod = e.lod;
    if (e.local) out.local = 1;
    edges.push(out);
  }
  const hidden = [];
  for (const h of layout.hidden || []) {
    const r = real(h.key);
    if (!r) continue;
    const tips = nodes.map((n, i) => (n.id === `x:${h.group}` || n.id.startsWith(`x:${h.group}:`) ? i : -1)).filter((i) => i >= 0);
    hidden.push({ group: h.group, tips, real: r.flat, ...(h.road ? { road: h.road } : {}) });
  }

  // ---- slugs ----
  const slugs = {
    version: 1,
    edges: { ...(slugsIn?.edges || {}) },
    nodes: { ...(slugsIn?.nodes || {}) },
  };
  const keyToSlug = new Map(Object.entries(slugs.edges).map(([s, v]) => [v.key, s]));
  const roadText = (road) => shortName(layout.roads?.[road]?.label || road);
  const fresh = [];
  for (const e of edges) {
    const s = keyToSlug.get(e.key);
    if (s) e.slug = s; else fresh.push(e);
  }
  // New edges are numbered along their road (west to east, or north to south if the road
  // runs that way), after any numbers the road already has.
  const byBase = new Map();
  for (const e of fresh) {
    const base = slugify(/^\(.*\)$/.test(e.road) || !e.road ? 'road' : roadText(e.road)) || 'road';
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(e);
  }
  const mid = (e) => { const n = e.real.length / 3, i = 3 * Math.floor(n / 2); return [e.real[i], e.real[i + 1]]; };
  for (const [base, list] of byBase) {
    const ms = list.map(mid);
    const wide = Math.max(...ms.map((m) => m[0])) - Math.min(...ms.map((m) => m[0])) >= Math.max(...ms.map((m) => m[1])) - Math.min(...ms.map((m) => m[1]));
    list.sort((u, v) => (wide ? mid(u)[0] - mid(v)[0] : mid(u)[1] - mid(v)[1]));
    const re = new RegExp(`^${base}-(\\d+)$`);
    let n = Math.max(0, ...Object.keys(slugs.edges).map((s) => Number(s.match(re)?.[1] || 0)));
    for (const e of list) e.slug = `${base}-${++n}`;
  }
  // Every live slug keeps a coarse copy of its real geometry, for when it retires.
  const live = new Set();
  for (const e of edges) {
    live.add(e.slug);
    const pts = [];
    const n = e.real.length / 3, step = Math.max(1, Math.ceil(n / 12));
    for (let i = 0; i < n; i += step) pts.push([...U([e.real[3 * i], e.real[3 * i + 1]]), e.real[3 * i + 2]]);
    if ((n - 1) % step) pts.push([...U([e.real[3 * (n - 1)], e.real[3 * (n - 1) + 1]]), 1]);
    slugs.edges[e.slug] = { key: e.key, ll: pts };
  }
  const retired = {};
  for (const [s, v] of Object.entries(slugs.edges)) {
    if (live.has(s) || liveElsewhere?.has(s) || !v.ll) continue;   // on another of the maps: not retired
    retired[s] = v.ll.flatMap(([lat, lon, t]) => { const [x, y] = P(lat, lon); return [r1(x), r1(y), t]; });
  }

  const idToSlug = new Map(Object.entries(slugs.nodes).map(([s, id]) => [id, s]));
  const taken = new Set(Object.keys(slugs.nodes));
  for (const n of nodes) {
    if (n.kind) continue;
    let s = idToSlug.get(n.id);
    if (!s) {
      const base = slugify(shortName(n.name)) || 'junction';
      s = base;
      for (let i = 2; taken.has(s); i++) s = `${base}-${i}`;
      taken.add(s);
      slugs.nodes[s] = n.id;
    }
    n.slug = s;
  }

  // Roads actually drawn, with their resolved style.
  const roads = {};
  for (const e of edges) {
    if (!e.road || roads[e.road]) continue;
    const st = layout.roads?.[e.road] || {};
    roads[e.road] = { major: !!st.major, ...(st.tier ? { tier: st.tier } : {}), ...(st.label ? { label: st.label } : {}), ...(st.corridor ? { corridor: true } : {}), ...(st.private ? { private: true } : {}) };
  }

  // Places (shops, schools…) on drawn lines: e is the line's index, t how far along its real road, side
  // 1 or -1 (left or right, going the way t grows). Each is linked by its name, made unique on this map.
  const edgeAt = new Map(edges.map((e, i) => [e.key, i])), placeSlugs = new Set(), places = [];
  for (const p of layout.places || []) {
    const i = edgeAt.get(p.key);
    if (i == null) { warnings.push(`Place ${p.name} isn't on a drawn line; skipped.`); continue; }
    const base = slugify(p.name) || 'place';
    let slug = base;
    for (let n = 2; placeSlugs.has(slug); n++) slug = `${base}-${n}`;
    placeSlugs.add(slug);
    places.push({ slug, name: p.name, icon: p.icon, type: p.type, e: i, t: p.t, side: p.side, lat: p.lat, lon: p.lon, ...(p.osm ? { osm: p.osm } : {}) });
  }

  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const map = {
    version: MAP_VERSION,
    builtAt: new Date().toISOString(),
    graphGeneratedAt: graph.generatedAt,
    layoutGeneratedAt: layout.generatedAt,
    osmTimestamp: graph.osmTimestamp,
    proj: { lat0, lon0, kx, ky },
    bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    // Zoom levels (meters per screen pixel): zoomed out past deadEnds, lod 1 edges and nodes are hidden.
    zoom: { deadEnds: layout.zoom?.deadEnds ?? null },
    roads, nodes, edges, hidden, retired,
    ...(places.length ? { places } : {}),
  };
  if (layout.area) map.area = { id: layout.area.id, label: layout.area.label };
  return { map, slugs, warnings, live };
}

export const areaSlug = (label) => slugify(label) || 'neighborhood';

// Every map shares one set of link names (a road into a neighborhood is the same line on both maps).
// A name is retired only if it's on none of them, so the maps are built twice: once to hand out
// names, then again knowing which are live where.
export function buildAll(graph, layout, areaLayouts = {}, slugsIn = null) {
  const areaGroups = (layout.groups || []).filter((g) => g.kind === 'area' && areaLayouts[g.id]);
  const order = [['main', layout], ...areaGroups.map((g) => [g.id, { ...areaLayouts[g.id], area: { id: g.id, label: g.label } }])];
  let slugs = slugsIn;
  const live = new Map();
  for (const [id, l] of order) { const r = buildMap(graph, l, slugs); slugs = r.slugs; live.set(id, r.live); }
  const warnings = [], maps = new Map();
  // A neighborhood map records which junctions the neighborhood had when it was saved (the layout
  // editor updates it in the background whenever the main layout changes them).
  for (const g of areaGroups) {
    const had = areaLayouts[g.id].area?.nodes;
    if (had && had.join() !== [...g.nodes].sort().join()) {
      warnings.push(`${g.label}: The neighborhood's junctions changed after its map was last saved; open the main layout editor to update it.`);
    }
  }
  for (const [id, l] of order) {
    const elsewhere = new Set([...live].filter(([k]) => k !== id).flatMap(([, v]) => [...v]));
    const r = buildMap(graph, l, slugs, { live: elsewhere });
    warnings.push(...r.warnings.map((w) => (id === 'main' ? w : `${l.area.label}: ${w}`)));
    maps.set(id, r.map);
  }
  const map = maps.get('main'), areas = {};
  for (const g of areaGroups) {
    const slug = areaSlug(g.label);
    areas[slug] = maps.get(g.id);
    areas[slug].area.slug = slug;
    const n = map.nodes.find((x) => x.id === `x:${g.id}`);
    if (n) n.sub = slug;
    // Its places, so the main map's search finds them too.
    if (n && areas[slug].places) n.places = areas[slug].places.map((p) => p.name);
  }
  return { map, areas, slugs, warnings };
}
