// The public map: a schematic of the 95033 roads that you can pan and zoom, tap for links,
// and that shows where you are.
//
// Links (the part after #):
//   s=summit-rd-3&t=0.42   a point on a line (t = fraction along it); t is optional
//   n=summit-rd-soquel-san-jose-rd   a junction
//   ll=37.1234,-121.9876   a real position, shown on the nearest road
//   s=summit-rd-3,morrell-rd-1   several lines highlighted (a detour, say)
//   n=a,b                  several junctions
//   p=🪵,summit-rd-3,0.42   an emoji placed on a line (a tree down, a crash...); one p= for each
// They combine: s=summit-rd-3,morrell-rd-1&p=🪵,morrell-rd-1,0.42
//   a=redwood-estates&...   on a neighborhood's own map (the rest is on that map)
//
// Data: data/map.json, built by scripts/build-site.mjs. With ?live (the tools' Preview tab)
// it's built in the browser from the editors' files instead, and reloads when they save.

import { buildAll, shortName } from './build-map.mjs';
import {
  esc, dist, lerp, clamp, fmt, unit, pathLen, overlaps, segHitsBox, segProject, anchorsAt, anchorsProject,
  chevrons as chevronSize, chevronSvg, tipText, areaSvg, placeFit, bunchSideRoads, bunchBranch,
  TIER_W, MINOR, BUNCH_PX, PLACE_R, BACK_ROAD,
} from './shared.mjs';

const LIVE = new URLSearchParams(location.search).has('live');
const MI = 1609.34;

const $ = (id) => document.getElementById(id);
const svg = $('map');

let M = null;              // the map, prepared (see prepare)
let view = { x: 0, y: 0, w: 1000, h: 1000 };
let sel = null;            // what the card shows: { type: 'edge', e, t } | { type: 'node', n } | { type: 'pin', pin } | { type: 'me' }
let picks = [];            // the highlighted lines and junctions (shift-click adds); t is where a line was tapped, not in the link
let pins = [];             // emoji placed on the map: { emoji, e, t }
let adding = false;        // "Add another road": taps add to picks (for phones, which have no shift key)
// Putting an emoji on the map: sel is { type: 'place', at } (see startPlacing).
let me = null;             // { lat, lon, acc, loc } while location is on
let morph = 1;             // 1 = the schematic, 0 = real geography (the slider)

// ---------- data ----------
async function fetchJSON(url) {
  const r = await fetch(url, { cache: LIVE ? 'no-store' : 'default' });
  if (!r.ok) { r.body?.cancel(); throw new Error(`${url}: HTTP ${r.status}`); }
  return r.json();
}

let areaMaps = {};   // neighborhood maps (see openSub) loaded so far, by slug
async function loadData() {
  if (!LIVE) return fetchJSON('data/map.json');
  const [g, l, s] = await Promise.all([
    fetchJSON('../data/graph-derived.json'), fetchJSON('../data/layout-derived.json'),
    fetchJSON('../data/slugs.json').catch(() => null),
  ]);
  // The layout editor's map of each neighborhood that has one (?area=g35 writes layout-g35-derived.json).
  const al = {};
  await Promise.all((l.groups || []).filter((x) => x.kind === 'area').map(async (x) => {
    try { al[x.id] = await fetchJSON(`../data/layout-${x.id}-derived.json`); } catch {}
  }));
  const { map, areas, warnings } = buildAll(g, l, al, s);
  warnings.forEach((w) => console.warn(w));
  areaMaps = areas;
  return map;
}
async function loadArea(slug) {
  if (!areaMaps[slug]) areaMaps[slug] = await fetchJSON(`data/areas/${encodeURIComponent(slug)}.json`);
  return areaMaps[slug];
}

const triples = (a) => { const out = []; for (let i = 0; i < a.length; i += 3) out.push([a[i], a[i + 1], a[i + 2]]); return out; };

function prepare(m) {
  const nodes = m.nodes.map((n) => ({ ...n, edges: [] }));
  const edges = m.edges.map((e, i) => {
    const E = {
      ...e, i, A: nodes[e.a], B: nodes[e.b],
      an: triples(e.an).map(([t, x, y]) => ({ t, x, y })), real: triples(e.real),
      style: m.roads[e.road] || { color: MINOR, major: false },
    };
    E.A.edges.push(E); if (E.B !== E.A) E.B.edges.push(E);
    return E;
  });
  standIns(nodes, edges);
  uRoads(nodes, edges);
  const { lat0, lon0, kx, ky } = m.proj;
  const P = (lat, lon) => [(lon - lon0) * kx, -(lat - lat0) * ky];
  // Schematic and real positions, for the geography <-> schematic slider (see applyMorph).
  for (const E of edges) E.an0 = E.an;
  for (const n of nodes) {
    n.sx = n.x; n.sy = n.y;
    const e = n.edges[0];
    [n.rx, n.ry] = n.lat != null ? P(n.lat, n.lon) : e ? realAt(e.real, e.A === n ? 0 : 1) : [n.x, n.y];
  }
  return {
    ...m, nodes, edges, bounds0: m.bounds,
    hidden: m.hidden.map((h) => ({ ...h, real: triples(h.real), tips: h.tips.map((i) => nodes[i]) })),
    retired: Object.fromEntries(Object.entries(m.retired || {}).map(([s, a]) => [s, triples(a)])),
    bySlug: new Map(edges.filter((e) => e.slug).map((e) => [e.slug, e])),
    byKey: new Map(edges.map((e) => [e.key, e])),
    nodeBySlug: new Map(nodes.filter((n) => n.slug).map((n) => [n.slug, n])),
    places: (m.places || []).map((q) => ({ ...q, e: edges[q.e] })),
    P,
    U: ([x, y]) => [lat0 - y / ky, lon0 + x / kx],
  };
}

// A neighborhood whose roads in are left off (zoomed out, or with local roads hidden) would float on
// its own. Instead it gets one line to each road they lead to (Chemeketa Park's three roads all come off
// the same road), shown only while the real ones to that road aren't. It's drawn along the real road nearest the
// middle of the ones it stands in for, or the one picked for it in the editor (main); tapping it opens the
// neighborhood.
function standIns(nodes, edges) {
  for (const n of nodes) {
    if (n.kind !== 'area') continue;
    const real = [...n.edges], groups = new Map();
    for (const e of real) {
      const o = e.A === n ? e.B : e.A;
      const via = o === n ? [] : o.edges.filter((x) => !real.includes(x));
      if (!via.length) continue;
      const key = [...new Set(via.map((x) => x.road))].sort().join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ e, o, via });
    }
    for (const g of groups.values()) {
      const cx = g.reduce((a, m) => a + m.o.x, 0) / g.length, cy = g.reduce((a, m) => a + m.o.y, 0) / g.length;
      const { e, o } = g.find((m) => m.e.road === n.main) ||   // the road picked in the editor
        g.reduce((a, m) => (Math.hypot(m.o.x - cx, m.o.y - cy) < Math.hypot(a.o.x - cx, a.o.y - cy) ? m : a));
      const fwd = e.A === n;
      const V = {
        ...e, i: edges.length, key: `v:${n.id}:${o.id}`, slug: undefined, A: n, B: o, kind: undefined, lod: 0, local: 0,
        an: fwd ? e.an : e.an.map((a) => ({ ...a, t: 1 - a.t })).reverse(),
        real: fwd ? e.real : e.real.map(([x, y, t]) => [x, y, 1 - t]).reverse(),
        road: `(${n.label})`, roads: [], style: { color: MINOR, major: false }, tier: 4,   // solid: it's the way in
        virtual: true, area: n, stands: g.map((m) => m.e), via: g.flatMap((m) => m.via), names: [...new Set(g.map((m) => m.e.road))],
      };
      edges.push(V); n.edges.push(V); o.edges.push(V);
      (o.virt ||= []).push(V);
    }
  }
}

// A local road with both ends on the same road and nothing else on it (Timber Lodge Rd, a U off Soquel
// San Jose Rd) is drawn as a stub off its first junction, named like any side road, until it's big enough
// on screen to be worth drawing as it is (U_ROAD_PX between its ends). The stub gets a tip of its own.
const U_ROAD_PX = 110;
function uRoads(nodes, edges) {
  const stubs = edges.filter((e) => e.kind === 'stub').map((e) => pathLen(e.an.map((a) => [a.x, a.y]))).sort((a, b) => a - b);
  const L = stubs[stubs.length >> 1] || 240;
  for (const e of [...edges]) {
    if (e.kind || e.virtual || e.A === e.B || e.A.kind || e.B.kind || !(e.tier > BACK_ROAD)) continue;
    const on = (n) => n.edges.filter((x) => x !== e && !x.virtual);
    const roads = new Set([...on(e.A), ...on(e.B)].map((x) => x.road));
    if (on(e.A).length !== 2 || on(e.B).length !== 2 || roads.size !== 1 || roads.has(e.road)) continue;
    // Out from the first junction, square to the road, on the side the U is.
    const a = [e.A.x, e.A.y], b = [e.B.x, e.B.y], c = unit(a, b), mid = lerp(a, b, 0.5);
    const far = e.an.reduce((f, q) => (dist([q.x, q.y], mid) > dist(f, mid) ? [q.x, q.y] : f), mid);
    let nrm = [-c[1], c[0]];
    if ((far[0] - mid[0]) * nrm[0] + (far[1] - mid[1]) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]];
    const T = { id: `u:${e.key}`, kind: 'open', x: a[0] + nrm[0] * L, y: a[1] + nrm[1] * L, edges: [], lod: e.A.lod, local: e.A.local };
    const V = { ...e, i: edges.length, key: `u:${e.key}`, slug: undefined, A: e.A, B: T, kind: 'stub', full: undefined, uFor: e,
      an: [{ t: 0, x: a[0], y: a[1] }, { t: 1, x: T.x, y: T.y }] };
    e.uStub = V;
    T.edges.push(V); e.A.edges.push(V);
    nodes.push(T); edges.push(V);
  }
}
let uOpen = new Set();   // the U roads drawn as they are at this zoom
function updateURoads(k) {
  const open = new Set(M.edges.filter((e) => e.uStub && (morph < 1 || dist([e.A.x, e.A.y], [e.B.x, e.B.y]) / k >= U_ROAD_PX)));
  const changed = open.size !== uOpen.size || [...open].some((e) => !uOpen.has(e));
  uOpen = open;
  return changed;
}

// ---------- geometry ----------
// Schematic point at fraction t of the real road (linear between anchors), and back.
const schemAt = (e, t) => anchorsAt(e.an, t);
const schemProject = (e, p) => anchorsProject(e.an, p);
// Real geometry is [x, y, t] points.
function realAt(pts, t) {
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][2] || i === pts.length - 1) {
      const s = (t - pts[i - 1][2]) / ((pts[i][2] - pts[i - 1][2]) || 1);
      return lerp(pts[i - 1], pts[i], clamp(s, 0, 1));
    }
  }
  return [pts[0][0], pts[0][1]];
}
function realProject(pts, p) {
  let best = { t: 0, d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const r = segProject(pts[i - 1], pts[i], p);
    if (r.d < best.d) best = { t: pts[i - 1][2] + r.s * (pts[i][2] - pts[i - 1][2]), d: r.d };
  }
  return best;
}
const endT = (e, n) => (e.A === n ? 0 : 1);
// Where a node is in the real world: junctions carry it; line ends take it from their line.
function nodeLatLon(n) {
  if (n.lat != null) return [n.lat, n.lon];
  const e = n.edges[0];
  return M.U(realAt(e.real, endT(e, n)));
}

// A real position -> the nearest road -> the schematic. Positions on a collapsed part of the
// map (hidden roads) come out at that part's nearest tip.
function locate(lat, lon) {
  const p = M.P(lat, lon);
  let best = null;
  for (const e of M.edges) {
    if (e.virtual) continue;
    const r = realProject(e.real, p);
    if (!best || r.d < best.d) best = { e, t: r.t, d: r.d };
  }
  for (const h of M.hidden) {
    const r = realProject(h.real, p);
    if (best && r.d >= best.d) continue;
    const tips = h.tips.filter((n) => n.edges.length).sort((u, v) => dist(M.P(...nodeLatLon(u)), p) - dist(M.P(...nodeLatLon(v)), p));
    if (!tips.length) continue;
    const n = tips[0], e = n.edges[0];
    best = { e, t: endT(e, n), d: r.d, beyond: n, hiddenRoad: h.road };
  }
  if (best) best.at = schemAt(best.e, best.t);
  return best;
}

// The slider morphs each line from its real road to its schematic shape: a point at fraction t
// of the road sits between its real and schematic positions. Both are linear in t between
// breakpoints (real vertices, schematic anchors), so the morphed line is exact with anchors at
// all of them, and everything that goes through the anchors (taps, links, your location)
// follows the morph by itself. With keep, the road nearest the middle of the screen stays where it
// is, so the slider morphs the map around what you're looking at.
function applyMorph(m, keep) {
  let pin = null;
  if (keep) {
    const [W, H] = size(), c = toMap(W / 2, H / 2);
    for (const e of M.edges) {
      if (e.virtual || !shown(e)) continue;
      const pr = schemProject(e, c);
      if (!pin || pr.d < pin.d) pin = { e, ...pr };
    }
    if (pin) pin.at = schemAt(pin.e, pin.t);
  }
  morph = m;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const e of M.edges) {
    if (m === 1) { e.an = e.an0; continue; }
    const ts = [...new Set([...e.an0.map((a) => a.t), ...e.real.map((r) => r[2])])].sort((a, b) => a - b);
    const s0 = { an: e.an0 };
    e.an = ts.map((t) => { const [x, y] = lerp(realAt(e.real, t), schemAt(s0, t), m); grow(x, y); return { t, x, y }; });
  }
  for (const n of M.nodes) {
    [n.x, n.y] = m === 1 ? [n.sx, n.sy] : lerp([n.rx, n.ry], [n.sx, n.sy], m);
    grow(n.x, n.y);
  }
  M.bounds = m === 1 ? M.bounds0 : [x0, y0, x1, y1];
  if (me?.loc) me.loc.at = schemAt(me.loc.e, me.loc.t);
  if (pin) {
    const [x, y] = schemAt(pin.e, pin.t);
    view.x += x - pin.at[0]; view.y += y - pin.at[1];
  }
  drawLines(); drawn.k = null; draw();
}

// ---------- view ----------
function size() { const r = svg.getBoundingClientRect(); return [r.width || 1, r.height || 1]; }
const upp = () => view.w / size()[0];   // map meters per screen pixel
function toMap(cx, cy) { const k = upp(); return [view.x + cx * k, view.y + cy * k]; }

// Fit a box between the title and search at the top and the card at the bottom. extraTop: screen
// pixels the box needs above it (an emoji's bubble).
// How much of the bottom of the map the card covers, in screen pixels.
function cardCover() {
  if (!document.body.classList.contains('has-card')) return 0;
  return Math.max(0, svg.getBoundingClientRect().bottom - $('card').getBoundingClientRect().top) + 8;
}
function fitTo(b, pad = 0.08, extraTop = 0) {
  const [W, H] = size();
  const cardH = cardCover(), r = svg.getBoundingClientRect();
  const ui = Math.max(...['title', 'subBar', 'search'].map((id) => $(id).getBoundingClientRect().bottom));
  const top = Math.min(Math.max(0, ui - r.top) + 8 + extraTop, H * 0.3);
  const Hh = Math.max(H - cardH - top, H * 0.35);
  const w = Math.max(b[2] - b[0], ((b[3] - b[1]) * W) / Hh, 600) * (1 + 2 * pad);
  view.w = clamp(w, minW(), maxW());
  const k = view.w / W;
  view.x = (b[0] + b[2]) / 2 - view.w / 2;
  view.y = (b[1] + b[3]) / 2 - (top + Hh / 2) * k;
  draw();
}
const minW = () => 250;
const maxW = () => (M ? Math.max(M.bounds[2] - M.bounds[0], M.bounds[3] - M.bounds[1]) * 3 : 1e6);
function zoomAt(f, cx, cy) {
  const p = toMap(cx, cy), w = clamp(view.w * f, minW(), maxW()), s = w / view.w;
  view.x = p[0] - (p[0] - view.x) * s;
  view.y = p[1] - (p[1] - view.y) * s;
  view.w = w;
  draw();
}
// Pan so a map point is visible above the card.
function reveal(p, zoomTo) {
  const [W, H] = size();
  if (zoomTo && view.w > zoomTo) view.w = zoomTo;
  const k = upp(), cardH = cardCover();
  const sx = (p[0] - view.x) / k, sy = (p[1] - view.y) / k;
  if (zoomTo || sx < 40 || sx > W - 40 || sy < 60 || sy > H - cardH - 40) {
    view.x = p[0] - (W / 2) * k;
    view.y = p[1] - ((H - cardH) / 2) * k;
  }
  draw();
}

// ---------- drawing ----------
// Lines are drawn once, with strokes that keep their width on screen; markers and labels
// depend on the zoom and are redrawn when it changes.
// Each tier of road (1 highway, 2 main road, 3 secondary road, 4 connector, 5 back road, 6 local road) has its
// own width; the first three are colored.
// Back roads (through, but only just: narrow, Morrell Rd) are gray dashes; local roads are
// dotted like stubs (dotted: it goes nowhere).
// Drawn and described as a highway: tier 1 (older data without tiers: a corridor). A corridor
// moved down a tier in the editor (CA 17 Business as Mount Hermon Rd) is an ordinary road.
const isHighway = (e) => (e.tier ? e.tier === 1 : !!e.corridor);
function lineWidth(e) {
  if ((e.kind === 'stub' && !e.full) || e.kind === 'branch') return e.tier <= 3 ? TIER_W[e.tier - 1] * 0.6 : 1.8;
  if (e.tier) return TIER_W[e.tier - 1];
  return e.corridor ? 7 : e.style.major ? 5.5 : 3;
}
const pathD = (pts) => 'M' + pts.map((p) => fmt(p[0]) + ' ' + fmt(p[1])).join('L');
const anchorPts = (e) => e.an.map((a) => [a.x, a.y]);

// Zoomed out past the dead-end level, roads that don't go anywhere (and their junction
// circles) are left off; the editor marks them with lod 1.
let coarse = false;
// "Hide local roads": leaves off the roads that are no use for getting anywhere (local roads and
// what only leads to them) at any zoom, keeping back roads, which might be a way out.
let hideLocal = false;
try { hideLocal = localStorage.getItem('hideLocal') === '1'; } catch {}
// Neighborhoods are left off too, and the roads into them: drawn that small, their circles only cover
// the main roads.
const isArea = (x) => x.kind === 'area' || x.A?.kind === 'area' || x.B?.kind === 'area';
const shownLod = (x) => !(coarse && (x.lod || isArea(x))) && !(hideLocal && x.local);
const shownBase = (x) => shownLod(x) && !bunchHide.has(x) && (stubShow.has(x) || !stubEdges().has(x)) &&
  (x.kind !== 'branch' || !x.edges || stubShow.has(realEdges(x)[0])) &&
  (x.uStub ? uOpen.has(x) : x.uFor ? !uOpen.has(x.uFor) : true);
// A neighborhood's stand-in line (see standIns) shows when none of its real roads in do; the junction
// it ends at shows with it.
const shown = (x) => (x.virtual ? !coarse && x.stands.every((s) => !shownBase(s)) && x.via.some(shownBase) : shownBase(x) || !!x.virt?.some(shown));

// Side roads bunched together: dead ends and collapsed branches off one road whose junctions are
// closer than BUNCH_PX on screen are drawn, zoomed out, as one branch each side of the road with all
// their names at its end. The other junctions lose their circles. Tapping the
// branch zooms in until they come apart.
let bunches = [], bunchHide = new Set(), bunchPlain = new Set(), bunchSig = '';
// Like a stub, a bunch is drawn only once its names are placed (see drawLabels): a bracket with no
// names says nothing. Keyed by its junction and side, which stay the same as the zoom changes.
let bunchShow = new Set();
const bunchKey = (b) => `${b.j.id}:${b.dir.map((v) => Math.round(v * 4)).join()}`;
const bunchesShown = () => bunches.filter((b) => bunchShow.has(bunchKey(b)));
// Dead-end stubs (and branches collapsed by hand) are drawn only once their name has been placed (a short line with no name says
// nothing), and the circle of a junction that's then just a bend is left off. The labels decide, once
// the zoom settles: until then a stub that wasn't there stays off, so nothing flashes on and off again.
let stubShow = new Set(), stubPlain = new Set(), stubGen = 0;
const stubEdges = () => (M.stubEdges ??= new Set(M.nodes.filter((n) => (n.kind === 'open' || n.kind === 'branch') && realEdges(n).length)
  .map((n) => realEdges(n)[0])));
const plainNow = (n) => n.plain || bunchPlain.has(n) || stubPlain.has(n) || clusterPlain.has(n);
// Junction circles that would touch at this zoom: only the most important keeps its circle, the others
// are drawn as plain bends (they come back as you zoom in). Most important: on the biggest road, then
// the most roads. A back road counts for least here, below local roads: it's the sketchiest.
let clusterPlain = new Set();
const junctionR = (n) => (n.edges.some(isHighway) ? 6.2 : 4.6);
function updateClusters(k) {
  clusterPlain = new Set();
  const rank = (t) => (t === BACK_ROAD ? 7 : t || 4);
  const weight = (n) => {
    const ts = n.edges.filter((e) => shownBase(e) && !e.virtual).map((e) => rank(e.tier)).sort((a, b) => a - b);
    return [ts[0] ?? 9, ts[1] ?? 9, -ts.length, ts[2] ?? 9];
  };
  const kept = M.nodes.filter((n) => (n.kind === 'closed' || n.kind === 'area') && n.edges.length && shown(n))
    .map((n) => ({ c: [n.x, n.y], r: n.kind === 'area' ? areaR(n, k) / k : 8.5 }));
  const js = M.nodes.filter((n) => !n.kind && n.edges.length && shown(n) && !plainNow(n)).map((n) => ({ n, w: weight(n) }))
    .sort((a, b) => a.w.reduce((d, v, i) => d || v - b.w[i], 0));
  for (const { n } of js) {
    const c = [n.x, n.y], r = junctionR(n);
    if (kept.some((o) => dist(c, o.c) / k < r + o.r + 4)) clusterPlain.add(n);   // outlines touching, or nearly
    else kept.push({ c, r });
  }
}
function updateStubPlain() {
  stubPlain = new Set();
  for (const e of M.edges) {
    if (!e.uStub || shownBase(e)) continue;
    for (const j of [e.A, e.B]) if (realEdges(j).filter(shownBase).length === 2) stubPlain.add(j);
  }
  for (const e of stubEdges()) {
    if (shownBase(e) || !shownLod(e) || bunchHide.has(e)) continue;
    const j = e.A.kind === 'open' || e.A.kind === 'branch' ? e.B : e.A;
    if (!j.kind && realEdges(j).filter(shownBase).length === 2) stubPlain.add(j);
  }
}
const realEdges = (n) => n.edges.filter((x) => !x.virtual);
const otherEnd = (e, n) => (e.A === n ? e.B : e.A);
// A line's points starting from node n.
const ptsFrom = (e, n) => (e.A === n ? anchorPts(e) : anchorPts(e).reverse());
function sideJunctions() {
  if (M.sideJ) return M.sideJ;
  const J = new Map();
  for (const e of M.edges) {
    if (e.virtual || e.A === e.B) continue;
    const t = [e.A, e.B].find((n) => (n.kind === 'open' || n.kind === 'branch') && realEdges(n).length === 1);
    const j = t && otherEnd(e, t);
    if (!t || j.kind) continue;
    if (!J.has(j)) J.set(j, { j, leaves: [] });
    J.get(j).leaves.push({ e, t });
  }
  // Only where one road carries on past them (or turns a corner).
  for (const [j, v] of J) {
    v.carriers = realEdges(j).filter((x) => !v.leaves.some((l) => l.e === x) && !x.uStub);
    if (v.carriers.length !== 2) J.delete(j);
  }
  return (M.sideJ = J);
}
function updateBunches(k) {
  const out = [], hide = new Set();
  const J = morph === 1 ? sideJunctions() : new Map(), live = new Map();
  for (const [j, v] of J) {
    const leaves = v.leaves.filter((l) => shownLod(l.e));
    if (leaves.length && shownLod(j) && v.carriers.every(shownLod)) live.set(j, { ...v, leaves });
  }
  const { bunches: found, plain } = bunchSideRoads(live, {
    pos: (n) => [n.x, n.y], ptsFrom, other: otherEnd, stop: (n) => !!n.kind,
    next: (n, e) => n.edges.filter((x) => x !== e && shownLod(x) && !x.virtual && !x.uStub),
  }, BUNCH_PX * k);
  for (const b of found) {
    const names = [...new Set(b.leaves.flatMap((l) => (l.t.kind === 'branch' ? (l.t.label || '').split(/\s*,\s*/).filter(Boolean).map(shortName)
      : isPlaceholder(l.e.road) ? [] : [roadText(l.e.road)])))];
    const pts = b.leaves.flatMap((l) => anchorPts(l.e)).concat(b.chain.map((j) => [j.x, j.y]));
    const bounds = [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
    out.push({ ...b, names, bounds });
    for (const l of b.leaves) { hide.add(l.e); hide.add(l.t); }
  }
  const sig = out.map((b) => `${b.j.x},${b.j.y},${b.dir}:${b.leaves.length}`).join('|');
  bunches = out; bunchHide = hide; bunchPlain = plain;
  if (sig === bunchSig) return false;
  bunchSig = sig;
  return true;
}
// A bunch's branch: from its junction across the road, ending in a bar.
const bunchTip = (b, k) => bunchBranch([b.j.x, b.j.y], b.dir, k).tip;
const bunchSvg = (b, k) => bunchBranch([b.j.x, b.j.y], b.dir, k).svg;

// Places (shops, schools…): a badge with an icon beside the road, on the side the place is, joined to
// it by a tick, with the name past it. Left off with their road.
const PLACE_NAME_K = 8;   // meters per pixel: zoomed in past this, places get their names; zoomed out, just the icon
// In light mode just the icon; in dark mode a gray circle behind it, which the icons need there.
const DARK = matchMedia('(prefers-color-scheme: dark)');
// Each badge where it was put, or slid along its line off the lines, junctions and other badges it would
// cover (see placeFit). Worked out for all the places at once, again when the zoom or what's drawn changes.
let placeFits = null;
function placeGeom(q, k) {
  const key = [k, morph, hideLocal, bunchSig, stubGen].join();
  if (placeFits?.M !== M || placeFits.key !== key) placeFits = { M, key, at: fitPlaces(k) };
  return placeFits.at.get(q) || fitPlaces(k, [q]).get(q);
}
function fitPlaces(k, list = M.places.filter(placeShown)) {
  const lines = M.edges.filter((e) => shown(e) && !e.virtual).map((e) => {
    const pts = anchorPts(e), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { e, pts, w: lineWidth(e) * k / 2, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  const dots = M.nodes.filter((n) => (!n.kind || n.kind === 'closed' || n.kind === 'area') && n.edges.length && shown(n) && !plainNow(n))
    .map((n) => ({ c: [n.x, n.y], r: n.kind === 'area' ? areaR(n, k) : 6.5 * k }));
  const out = new Map(), badges = [], pad = 2 * k;
  const blocked = (c, r) => badges.some((b) => dist(c, b.c) < r + b.r + pad) || dots.some((d) => dist(c, d.c) < r + d.r + pad) ||
    lines.some(({ pts, w, box }) => {
      const m = r + w + pad;
      if (c[0] < box[0] - m || c[0] > box[2] + m || c[1] < box[1] - m || c[1] > box[3] + m) return false;
      for (let i = 1; i < pts.length; i++) if (segProject(pts[i - 1], pts[i], c).d < m) return true;
      return false;
    });
  for (const q of list) {
    const g = placeFit((t) => schemAt(q.e, t), q.t, q.side, lineWidth(q.e), k, pathLen(anchorPts(q.e)), blocked);
    out.set(q, g);
    badges.push(g);
  }
  return out;
}
const placeShown = (q) => shown(q.e);
function placeSvg(q, k) {
  const { at, n, r, c: [x, y] } = placeGeom(q, k), bare = !DARK.matches, end = bare ? r * 0.75 : r;
  return `<path d="M${fmt(at[0])} ${fmt(at[1])}L${fmt(x - n[0] * end)} ${fmt(y - n[1] * end)}" stroke="var(--muted)" stroke-width="${1.5 * k}"/>` +
    (bare ? '' : `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="var(--poi-fill)"/>`) +
    `<text x="${fmt(x)}" y="${fmt(y)}" dy="0.35em" text-anchor="middle" font-size="${(bare ? 14 : 11) * k}">${esc(q.icon)}</text>`;
}
DARK.addEventListener('change', () => { if (M) { drawn.k = null; draw(); } });

const PRIVATE = '#d93025';
function drawLines() {
  const layers = [[], [], []];
  for (const e of M.edges) {
    if (!shown(e)) continue;
    const d = pathD(anchorPts(e)), w = lineWidth(e);
    const common = `d="${d}" fill="none" vector-effect="non-scaling-stroke" stroke-linejoin="round"`;
    if (e.style.private && e.kind !== 'stub') {
      // Private road (not open to the public): red dashes at its usual width.
      layers[0].push(`<path ${common} stroke="${PRIVATE}" stroke-width="${Math.max(w, 3)}" stroke-dasharray="${Math.max(w * 2, 6)} ${Math.max(w * 1.3, 4)}" stroke-linecap="butt"/>`);
    } else if (e.kind === 'branch') {
      // Side roads collapsed by hand into one: drawn like a stub of the most important of them, no
      // heavier than any of them alone (dotted if they're all local roads, dashed for a back road).
      const dash = e.tier > BACK_ROAD ? `stroke-dasharray="0 ${Math.max(w * 2, 4).toFixed(1)}" stroke-linecap="round"`
        : e.tier === BACK_ROAD ? `stroke-dasharray="${(w * 2.2).toFixed(1)} ${(w * 1.5).toFixed(1)}" stroke-linecap="butt"` : 'stroke-linecap="butt"';
      layers[0].push(`<path ${common} stroke="${e.style.color}" stroke-width="${w}" ${dash} opacity=".8"/>`);
    } else if (e.tier === BACK_ROAD && !e.kind) {
      layers[0].push(`<path ${common} stroke="${e.style.color}" stroke-width="${w}" stroke-dasharray="${(w * 2.2).toFixed(1)} ${(w * 1.5).toFixed(1)}" stroke-linecap="butt"/>`);
    } else if (e.tier > BACK_ROAD && (!e.kind || e.full)) {
      layers[0].push(`<path ${common} stroke="${e.style.color}" stroke-width="${w}" stroke-dasharray="0 ${Math.max(w * 2, 4).toFixed(1)}" stroke-linecap="round"/>`);
    } else if (e.kind === 'stub') {
      layers[0].push(`<path ${common} stroke="${e.style.color}" stroke-width="${w}" stroke-dasharray="0 ${Math.max(w * 2, 4).toFixed(1)}" stroke-linecap="round" opacity=".8"/>`);
    } else if (isHighway(e)) {
      layers[2].push(`<path ${common} stroke="${e.style.color}" stroke-width="${w}" stroke-linecap="${e.kind ? 'butt' : 'round'}"/>` +
        `<path ${common} stroke="var(--bg)" stroke-width="1.6" stroke-linecap="butt"/>`);
    } else {
      layers[e.style.major ? 1 : 0].push(`<path ${common} stroke="${e.style.color}" stroke-width="${w}" stroke-linecap="${e.kind ? 'butt' : 'round'}"/>`);
    }
  }
  $('gLines').innerHTML = layers.flat().join('');
}

let drawn = { k: null };
let pending = false, labelTimer = null;
function draw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!M) return;
    const [W, H] = size();
    view.h = (view.w * H) / W;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    const k = view.w / W;
    const c = M.zoom?.deadEnds != null && k > M.zoom.deadEnds;
    let lines = c !== coarse;
    coarse = c;
    if ((k !== drawn.k || lines) && updateURoads(k)) lines = true;
    if ((k !== drawn.k || lines) && updateBunches(k)) lines = true;
    if (k !== drawn.k || lines) { updateStubPlain(); updateClusters(k); }
    if (lines) drawLines();
    if (k !== drawn.k || lines) {
      drawn.k = k;
      drawNodes(k);
      drawMarks(k);
      // Labels are placed once the zoom settles; until then the old ones scale along.
      clearTimeout(labelTimer);
      labelTimer = setTimeout(() => drawLabels(upp()), drawn.labels ? 120 : 0);
    } else drawMarks(k);
  });
}

function tipDir(n) {
  const e = n.edges[0], pts = anchorPts(e);
  const tip = [n.x, n.y], prev = e.A === n ? pts[1] : pts[pts.length - 2];
  const L = dist(tip, prev) || 1;
  return [(tip[0] - prev[0]) / L, (tip[1] - prev[1]) / L];
}

// A road that keeps going after the map stops ends in two chevrons.
const chevrons = (e, k) => chevronSize(lineWidth(e), k);

// A neighborhood: a big circle with a few dots for its streets. Its radius is Size × 70 m on the
// map (Size is set in the layout editor), so it zooms with the roads, but it's never smaller than a
// big junction circle.
const areaR = (n, k) => Math.max(11 * k, 70 * (n.size || 1));
const AREA_FS = 10.5;
const areaTextW = (t) => textWidth(t, AREA_FS, 600) + t.length * AREA_FS * 0.08;
// The name in lines that fit inside the circle (null if it doesn't fit).
function areaInside(n, k) {
  if (!n.label) return null;
  const r = areaR(n, k) / k, maxW = r * 1.55, lines = [];
  for (const w of n.label.toUpperCase().split(/\s+/)) {
    const cur = lines.length ? `${lines[lines.length - 1]} ${w}` : null;
    if (cur && areaTextW(cur) <= maxW) lines[lines.length - 1] = cur; else lines.push(w);
  }
  if (lines.some((t) => areaTextW(t) > maxW) || lines.length * AREA_FS * 1.2 > r * 1.3) return null;
  return lines;
}

function drawNodes(k) {
  let s = bunchesShown().map((b) => bunchSvg(b, k)).join('');
  for (const n of M.nodes) {
    if (n.kind === 'open' || !n.edges.length || !shown(n) || plainNow(n)) continue;
    const { x, y } = n;
    if (n.kind) {
      const e = n.edges[0], [ux, uy] = tipDir(n), w = lineWidth(e) * k, col = e.style.color;
      if (n.kind === 'area') {
        s += areaSvg(x, y, areaR(n, k), k, { dots: !areaInside(n, k) });
        continue;
      }
      if (n.kind === 'closed' && n.gap) {
        // Not connected (the road once went through): the line breaks, each side ending in a squiggle.
        const g = GAP_R * k;
        s += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${g}" fill="var(--bg)"/>`;
        for (const f of realEdges(n).filter(shown)) {
          const pts = ptsFrom(f, n), [vx, vy] = unit(pts[0], pts[1]), fw = lineWidth(f) * k, H = Math.max(fw * 1.5, 5 * k);
          // A squiggle across the line's end (an S, like a break mark), not a bar: bars end branches.
          const bx = x + vx * g, by = y + vy * g, A = H * 0.6;
          s += `<path d="M${fmt(bx - vy * H)} ${fmt(by + vx * H)}Q${fmt(bx - vy * H / 2 + vx * A)} ${fmt(by + vx * H / 2 + vy * A)} ${fmt(bx)} ${fmt(by)}` +
            `Q${fmt(bx + vy * H / 2 - vx * A)} ${fmt(by - vx * H / 2 - vy * A)} ${fmt(bx + vy * H)} ${fmt(by - vx * H)}" fill="none" stroke="${f.style.color}" stroke-width="${Math.max(fw, 1.5 * k)}" stroke-linecap="round"/>`;
        }
      } else if (n.kind === 'closed') {
        // Road closed (a washed-out bridge): a no-entry sign, red disc with a white bar.
        const r = 8.5 * k, h = r * 0.62;
        s += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="#d93025" stroke="var(--node-fill)" stroke-width="${1.5 * k}"/>` +
          `<path d="M${fmt(x - h)} ${fmt(y)}L${fmt(x + h)} ${fmt(y)}" stroke="#fff" stroke-width="${2.6 * k}"/>`;
      } else if (n.kind === 'through' || n.kind === 'exit') {
        // A map exit (the line cut short, "to Los Gatos") is drawn like a road that runs off the map.
        s += chevronSvg(x, y, ux, uy, chevrons(e, k), col);
      } else if (n.kind === 'exit') {
        const L = Math.max(w * 2.2, 10 * k), H = Math.max(w * 1.6, 7 * k);
        s += `<path d="M${fmt(x + ux * L)} ${fmt(y + uy * L)}L${fmt(x - uy * H)} ${fmt(y + ux * H)}L${fmt(x + uy * H)} ${fmt(y - ux * H)}Z" fill="${col}"/>`;
      } else {
        const H = Math.max(w * 1.5, 6 * k);
        s += `<path d="M${fmt(x - uy * H)} ${fmt(y + ux * H)}L${fmt(x + uy * H)} ${fmt(y - ux * H)}" stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>`;
      }
      continue;
    }
    const big = n.edges.some(isHighway);
    const r = junctionR(n) * k;
    s += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="var(--node-fill)" stroke="var(--node-stroke)" stroke-width="${(big ? 2.6 : 2) * k}"/>`;
  }
  for (const q of M.places) if (placeShown(q)) s += placeSvg(q, k);
  $('gNodes').innerHTML = s;
}

// Highlighted roads, emoji pins and the "you are here" dot.
const pickPos = (p) => (p.type === 'edge' ? schemAt(p.e, p.t) : [p.n.x, p.n.y]);
const samePick = (a, b) => a.type === b.type && (a.type === 'edge' ? a.e === b.e : a.n === b.n);
// An emoji sits in a bubble just above its spot (above the circle, for a neighborhood).
function pinNode(q) { const n = q.t <= 0 ? q.e.A : q.t >= 1 ? q.e.B : null; return n?.kind === 'area' ? n : null; }
const pinSpot = (q) => (pinNode(q) ? [pinNode(q).x, pinNode(q).y] : schemAt(q.e, q.t));
function pinAt(q, k) {
  const [x, y] = pinSpot(q), a = pinNode(q);
  return [x, y - (a ? areaR(a, k) : 0) - 24 * k];
}
function pinSvg(q, k) {
  const [x, y] = pinAt(q, k), on = sel?.pin === q, r = 15 * k, [px, py] = pinSpot(q);
  return (pinNode(q) ? '' : `<circle cx="${fmt(px)}" cy="${fmt(py)}" r="${3.5 * k}" fill="${on ? 'var(--accent)' : 'var(--node-stroke)'}" stroke="var(--card)" stroke-width="${1.5 * k}"/>`) +
    `<path d="M${fmt(x - 6 * k)} ${fmt(y + r - 3 * k)}L${fmt(x)} ${fmt(y + r + 7 * k)}L${fmt(x + 6 * k)} ${fmt(y + r - 3 * k)}Z" fill="${on ? 'var(--accent)' : 'var(--node-stroke)'}"/>` +
    `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="var(--card)" stroke="${on ? 'var(--accent)' : 'var(--node-stroke)'}" stroke-width="${2 * k}"/>` +
    `<text x="${fmt(x)}" y="${fmt(y)}" dy="0.36em" text-anchor="middle" font-size="${17 * k}" class="emo">${esc(q.emoji)}</text>`;
}
function drawMarks(k = upp()) {
  // Lines are highlighted in two groups, each see-through as a whole, so they don't darken where they meet.
  let halo = '', haloOn = '', marks = '';
  for (const p of picks) {
    const on = sel === p || !!sel?.run?.edges.includes(p.e);
    if (p.type === 'edge') {
      const h = `<path d="${pathD(anchorPts(p.e))}" vector-effect="non-scaling-stroke" stroke-width="${lineWidth(p.e) + 12}"/>`;
      if (on) haloOn += h; else halo += h;
    } else {
      marks += `<circle cx="${fmt(p.n.x)}" cy="${fmt(p.n.y)}" r="${13 * k}" fill="var(--accent)" fill-opacity="${on ? 0.25 : 0.15}" stroke="var(--accent)" stroke-width="${2 * k}"/>`;
    }
  }
  if (me?.loc && !me.loc.far) {
    const [x, y] = me.loc.at;
    const rr = clamp(me.acc * me.loc.scale, 9 * k, 70 * k);
    marks += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${rr}" fill="var(--me)" fill-opacity=".15"/>` +
      `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${6.5 * k}" fill="var(--me)" stroke="#fff" stroke-width="${2.5 * k}"/>`;
  }
  // The card's pin last, so it's on top.
  for (const q of [...pins.filter((q) => sel?.pin !== q), ...pins.filter((q) => sel?.pin === q)]) marks += pinSvg(q, k);
  if (sel?.type === 'poi') {
    const { c: [x, y], r } = placeGeom(sel.q, k);
    marks += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r + 4 * k}" fill="none" stroke="var(--accent)" stroke-width="${3 * k}"/>`;
  }
  // Where the emoji being placed goes.
  if (sel?.type === 'place' && sel.at) {
    const [x, y] = schemAt(sel.at.e, sel.at.t);
    marks += `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${9 * k}" fill="var(--accent)" fill-opacity=".2" stroke="var(--accent)" stroke-width="${2 * k}"/>` +
      `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${3 * k}" fill="var(--accent)"/>`;
  }
  placeEmojiPop(k);
  const g = (paths, o) => (paths ? `<g fill="none" stroke="var(--accent)" stroke-linecap="round" stroke-linejoin="round" opacity="${o}">${paths}</g>` : '');
  $('gHalo').innerHTML = g(halo, 0.22) + g(haloOn, 0.32);
  $('gMarks').innerHTML = marks;
}

// ---------- labels ----------
const ctx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
function textWidth(text, px, weight = 400) {
  const key = `${weight}|${px}|${text}`;
  if (!widthCache.has(key)) {
    ctx.font = `${weight} ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    widthCache.set(key, ctx.measureText(text).width);
  }
  return widthCache.get(key);
}
const roadText = (road) => shortName(M.roads[road]?.label || road);
const isPlaceholder = (road) => !road || /^\(.*\)$/.test(road);
// A branch's line whose road is one of the names listed at the branch's end needs no label of its own.
function namedAtBranch(e) {
  if (e.kind !== 'branch') return false;
  const tip = e.A.kind === 'branch' ? e.A : e.B;
  const names = (tip.label || '').split(/\s*,\s*/).map((x) => shortName(x).toLowerCase());
  return [roadText(e.road), shortName(e.road)].some((x) => names.includes(x.toLowerCase()));
}

// Road names along their lines (major roads first, bigger and in color), one per straight
// run; then what's at the end of each exit, branch and open-ended stub.
function drawLabels(k) {
  drawn.labels = true;
  const placed = M.nodes.filter((n) => (!n.kind || n.kind === 'closed' || n.kind === 'area') && shown(n) && !plainNow(n)).map((n) => {
    const r = n.kind === 'area' ? areaR(n, k) : 4 * k;
    return { x0: n.x - r, y0: n.y - r, x1: n.x + r, y1: n.y + r };
  });
  const shownPlaces = M.places.filter(placeShown).map((q) => ({ q, ...placeGeom(q, k) }));
  for (const { c: [x, y], r } of shownPlaces) placed.push({ x0: x - r, y0: y - r, x1: x + r, y1: y + r });
  let out = '';
  const halo = (w) => `stroke="var(--halo)" stroke-width="${w * k}" stroke-linejoin="round" paint-order="stroke"`;
  // Side roads' names, at a stub's tip or listed at a collapsed branch's: small, gray, italic.
  const stubText = `font-style="italic" fill="var(--muted)" ${halo(2.5)}`;

  // Exits, branches and roads that continue off the map first: they say where a line goes.
  for (const n of M.nodes) {
    if ((n.kind !== 'through' && n.kind !== 'exit') || !n.edges.length || !shown(n)) continue;
    const e = n.edges[0], name = isPlaceholder(e.road) ? null : roadText(e.road);
    const lines = [...(name ? [name] : []), ...(n.label ? [[n.label, `font-weight="400" font-size="${10.5 * k}" fill="var(--muted)"`]] : [])];
    if (lines.length) out += tipLabel(n, lines, 12, 600, k, placed, `font-weight="600" fill="${e.style.color}" ${halo(3)}`);
  }
  for (const n of M.nodes) {
    // A closure's label ("No More Bridge") only once you're zoomed in past the local roads.
    if (n.kind !== 'closed' || !n.label || !n.edges.length || coarse || !shown(n)) continue;
    const [ux] = tipDir(n), r = 8.5 * k, fs = 11 * k, tw = textWidth(n.label, 11, 600) * k, above = Math.abs(ux) > 0.7;
    const tx = above ? n.x : n.x + r + 10 * k, ty = above ? n.y - r - 13 * k : n.y;
    const box = above ? { x0: tx - tw / 2, x1: tx + tw / 2, y0: ty - fs * 0.6, y1: ty + fs * 0.6 } : { x0: tx, x1: tx + tw, y0: ty - fs * 0.6, y1: ty + fs * 0.6 };
    if (overlaps(box, placed)) continue;
    placed.push(box);
    out += `<text x="${fmt(tx)}" y="${fmt(ty)}" dy="0.35em" text-anchor="${above ? 'middle' : 'start'}" font-size="${fs}" font-weight="600" fill="#d93025" ${halo(3)}>${esc(n.label)}</text>`;
  }
  // Neighborhood names, in small spaced capitals like area names on a map: inside the circle when
  // it's big enough, otherwise on the free side furthest from its roads, and left off if there's no room.
  for (const n of M.nodes) {
    // Named only once its circle is drawn at its real size, so bigger neighborhoods get named first as
    // you zoom in, and none while they're all shrunk to the smallest marker.
    if (n.kind !== 'area' || !n.label || !shown(n) || 70 * (n.size || 1) < 11 * k) continue;
    const r = areaR(n, k), inside = areaInside(n, k), fs = AREA_FS * k, lh = fs * 1.2;
    const style = `font-size="${fs}" font-weight="600" letter-spacing="${(AREA_FS * 0.08).toFixed(2)}" fill="var(--muted)" ${halo(3)}`;
    if (inside) {
      const y0 = n.y - ((inside.length - 1) * lh) / 2;
      out += inside.map((t, i) => `<text x="${fmt(n.x)}" y="${fmt(y0 + i * lh)}" dy="0.35em" text-anchor="middle" ${style}>${esc(t)}</text>`).join('');
      continue;
    }
    const text = n.label.toUpperCase(), tw = areaTextW(text) * k;
    const angs = n.edges.map((e) => { const p = anchorPts(e), q = e.A === n ? p[1] : p[p.length - 2]; return Math.atan2(q[1] - n.y, q[0] - n.x); });
    const away = (a) => Math.min(Math.PI, ...angs.map((b) => Math.abs(((a - b) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)));
    const sides = [[0, 'start'], [Math.PI, 'end'], [Math.PI / 2, 'middle'], [-Math.PI / 2, 'middle']].sort((u, v) => away(v[0]) - away(u[0]));
    for (const [a, anchor] of sides) {
      if (away(a) < 0.5) break;   // right on top of one of its roads
      const gap = r + 5 * k, tx = n.x + Math.cos(a) * gap, ty = n.y + Math.sin(a) * (gap + fs * 0.3);
      const x0 = anchor === 'start' ? tx : anchor === 'end' ? tx - tw : tx - tw / 2;
      const box = { x0, x1: x0 + tw, y0: ty - fs * 0.6, y1: ty + fs * 0.6 };
      if (overlaps(box, placed)) continue;
      placed.push(box);
      out += `<text x="${fmt(tx)}" y="${fmt(ty)}" dy="0.35em" text-anchor="${anchor}" ${style}>${esc(text)}</text>`;
      break;
    }
  }
  const named = new Set();
  for (const b of bunches) {
    // A long list is cut short: the rest are found by zooming in.
    const lines = b.names.length > 6 ? [...b.names.slice(0, 5), `+ ${b.names.length - 5} more`] : b.names;
    const [x, y] = bunchTip(b, k);
    const label = lines.length ? tipLabel({ x, y, kind: 'branch', dir: b.dir }, lines, 10, 400, k, placed, stubText) : '';
    if (label) { out += label; named.add(bunchKey(b)); }
  }

  // Dead-end stubs: the road's name, small, past the tip; with no room for it, no stub. Before the names
  // along the lines, which move about as you zoom, so that a stub, once there, stays as you zoom in.
  // A stub that's the end of a road named along its own line is named there instead (below).
  const show = new Set(), fullStubs = [];
  const drawable = (x) => shownLod(x) && !bunchHide.has(x) && (x.uStub ? uOpen.has(x) : x.uFor ? !uOpen.has(x.uFor) : true);
  // ...and not across another line.
  const lineBoxes = M.edges.filter((x) => drawable(x) && !x.virtual).map((x) => {
    const pts = anchorPts(x), xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return { e: x, pts, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
  });
  const acrossLine = (own) => (box) => lineBoxes.some(({ e, pts, box: b }) => e !== own && (show.has(e) || !stubEdges().has(e)) && overlaps(box, [b]) &&
    pts.some((q, i) => i && segHitsBox(pts[i - 1], q, box)));
  // Side roads collapsed by hand into one branch: the same, with their names listed at its tip.
  for (const n of M.nodes) {
    if (n.kind !== 'branch' || !n.edges.length) continue;
    const e = realEdges(n)[0];
    if (!e || !drawable(e)) continue;
    const lines = (n.label || '').split(/\s*,\s*/).filter(Boolean).map(shortName);
    const label = lines.length ? tipLabel(n, lines, 10, 400, k, placed, stubText, acrossLine(e)) : '';
    if (label) { out += label; show.add(e); }
  }
  for (const n of M.nodes) {
    if (n.kind !== 'open' || !n.edges.length) continue;
    const e = n.edges[0];
    if (!drawable(e)) continue;
    if (e.full) { fullStubs.push(n); continue; }
    const label = isPlaceholder(e.road) ? '' : tipLabel(n, [roadText(e.road)], 10, 400, k, placed, stubText, acrossLine(e));
    if (label) { out += label; show.add(e); }
  }

  // Straight runs: collinear segments of one road joined through junctions. Not while the map
  // is morphing toward geography: roads are curvy there and the names would jump about.
  const segs = [];
  for (const e of morph < 1 ? [] : M.edges) {
    if (isPlaceholder(e.road) || (e.kind === 'stub' && !e.full) || e.A === e.B || !shown(e) || namedAtBranch(e)) continue;
    const pts = anchorPts(e);
    for (let j = 1; j < pts.length; j++) {
      const a = pts[j - 1], b = pts[j];
      if (dist(a, b) > 1e-6) segs.push({ e, a, b, ang: (Math.atan2(b[1] - a[1], b[0] - a[0]) + 2 * Math.PI) % Math.PI });
    }
  }
  const parent = segs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const at = new Map();
  segs.forEach((sg, i) => [sg.a, sg.b].forEach((p) => {
    const key = `${sg.e.road}|${Math.round(p[0])},${Math.round(p[1])}`;
    if (!at.has(key)) at.set(key, []);
    at.get(key).push(i);
  }));
  for (const list of at.values()) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const d = Math.abs(segs[list[x]].ang - segs[list[y]].ang);
      if (Math.min(d, Math.PI - d) < 0.02) parent[find(list[x])] = find(list[y]);
    }
  }
  const runs = new Map();
  segs.forEach((sg, i) => {
    const r = find(i);
    if (!runs.has(r)) runs.set(r, { e: sg.e, ux: Math.cos(sg.ang), uy: Math.sin(sg.ang), o: sg.a, lo: Infinity, hi: -Infinity });
    const run = runs.get(r);
    for (const p of [sg.a, sg.b]) {
      const t = (p[0] - run.o[0]) * run.ux + (p[1] - run.o[1]) * run.uy;
      run.lo = Math.min(run.lo, t); run.hi = Math.max(run.hi, t);
    }
  });
  const cands = [...runs.values()].map((r) => ({
    e: r.e, major: !!(r.e.style.major || isHighway(r.e)), len: r.hi - r.lo,
    a: [r.o[0] + r.ux * r.lo, r.o[1] + r.uy * r.lo], b: [r.o[0] + r.ux * r.hi, r.o[1] + r.uy * r.hi],
  }));
  cands.sort((u, v) => (v.major - u.major) || (v.len - u.len));
  const byName = new Map();
  for (const c of cands) {
    const px = c.major ? 13 : 11, fs = px * k, weight = c.major ? 600 : 400;
    const text = roadText(c.e.road), tw = textWidth(text, px, weight) * k;
    if (c.len < tw + 24 * k) continue;
    const mid = lerp(c.a, c.b, 0.5);
    if ((byName.get(c.e.road) || []).some((q) => dist(q, mid) < 320 * k)) continue;
    let ang = Math.atan2(c.b[1] - c.a[1], c.b[0] - c.a[0]);
    if (ang > Math.PI / 2 + 1e-6) ang -= Math.PI;
    if (ang <= -Math.PI / 2 + 1e-6) ang += Math.PI;
    const nx = -Math.sin(ang), ny = Math.cos(ang);
    const off = (lineWidth(c.e) / 2 + 2.5) * k + fs * 0.55;
    const cos = Math.abs(Math.cos(ang)), sin = Math.abs(Math.sin(ang));
    const hw = (tw * cos + fs * sin) / 2, hh = (tw * sin + fs * cos) / 2;
    let spot = null;
    for (const side of [-1, 1]) {
      const cx = mid[0] + nx * off * side, cy = mid[1] + ny * off * side;
      const box = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
      if (!overlaps(box, placed)) { spot = { cx, cy, box }; break; }
    }
    if (!spot) continue;
    placed.push(spot.box);
    if (!byName.has(c.e.road)) byName.set(c.e.road, []);
    byName.get(c.e.road).push(mid);
    out += `<text transform="translate(${fmt(spot.cx)} ${fmt(spot.cy)}) rotate(${((ang * 180) / Math.PI).toFixed(1)})" text-anchor="middle" dy="0.35em" font-size="${fs}"` +
      `${c.major ? ' font-weight="600"' : ''} fill="${c.major ? c.e.style.color : 'var(--muted)'}" ${halo(3)}>${esc(text)}</text>`;
  }

  // Places: the name past the badge, away from the road, if there's room. Zoomed out, no label: the
  // icon says what kind of place it is, and some names are very long.
  for (const { q, n, r, c: [x, y] } of shownPlaces) {
    if (k >= PLACE_NAME_K) break;
    const name = q.name;
    const fs = 10.5 * k, tw = textWidth(name, 10.5, 600) * k, gap = r + 4 * k, side = Math.abs(n[0]) >= 0.5;
    const tx = side ? x + Math.sign(n[0]) * gap : x, ty = side ? y : y + Math.sign(n[1] || 1) * (gap + fs * 0.5);
    const anchor = side ? (n[0] > 0 ? 'start' : 'end') : 'middle';
    const x0 = anchor === 'start' ? tx : anchor === 'end' ? tx - tw : tx - tw / 2;
    const box = { x0, x1: x0 + tw, y0: ty - fs * 0.6, y1: ty + fs * 0.6 };
    if (overlaps(box, placed)) continue;
    placed.push(box);
    out += `<text x="${fmt(tx)}" y="${fmt(ty)}" dy="0.35em" text-anchor="${anchor}" font-size="${fs}" font-weight="600" fill="var(--text)" ${halo(3)}>${esc(name)}</text>`;
  }

  // A U road drawn as it is: its name past its far point, unless its line got one.
  for (const e of uOpen) {
    if (!shown(e) || byName.has(e.road) || isPlaceholder(e.road)) continue;
    // Its far point: furthest out from the line between its ends, and the name past it, square to that line.
    const a = [e.A.x, e.A.y], c = unit(a, [e.B.x, e.B.y]), out_ = (q) => (q[0] - a[0]) * -c[1] + (q[1] - a[1]) * c[0];
    const far = anchorPts(e).reduce((f, q) => (Math.abs(out_(q)) > Math.abs(out_(f)) ? q : f), a), side = Math.sign(out_(far));
    const name = roadText(e.road);
    if (side) out += tipText(far, [-c[1] * side, c[0] * side], 6 * k, [name], 11 * k, textWidth(name, 11, 400) * k, placed, `fill="var(--muted)" ${halo(3)}`);
  }
  for (const n of fullStubs) {
    const e = n.edges[0];
    // Carrying straight on from its road's line, already named along it: no name of its own. Turning
    // off it (the road goes one way, the line carries on as another road), it's named at its tip,
    // since nobody would follow the road round the corner.
    const onLine = byName.has(e.road) && carriesOn(e);
    const label = onLine || isPlaceholder(e.road) ? '' : tipLabel(n, [roadText(e.road)], 10, 400, k, placed, stubText, acrossLine(e));
    if (label) out += label;
    if (label || onLine) show.add(e);
  }
  $('gLabels').innerHTML = out;
  const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const stubsChanged = !same(show, stubShow), bunchesChanged = !same(named, bunchShow);
  bunchShow = named;
  if (stubsChanged) {
    stubShow = show; stubGen++;
    updateStubPlain(); updateClusters(k);
    drawLines();
  }
  if (stubsChanged || bunchesChanged) drawNodes(k);
}

function tipLabel(n, lines, px, weight, k, placed, attrs, blocked) {
  const tw = Math.max(...lines.map((l) => textWidth(Array.isArray(l) ? l[0] : l, px, weight))) * k;
  const gap = n.kind === 'through' || n.kind === 'exit' ? chevrons(n.edges[0], k).extent + 5 * k : (n.kind === 'branch' ? 9 : 5) * k;
  return tipText([n.x, n.y], n.dir || tipDir(n), gap, lines, px * k, tw, placed, attrs, blocked);
}

// Whether stub e carries straight on from its road at the junction it starts from: the straightest way on
// from a line of the same road, within 30°.
function carriesOn(e) {
  const j = e.A.kind === 'open' ? e.B : e.A, out = (x) => { const p = ptsFrom(x, j); return unit(p[0], p[1]); };
  const a = out(e);
  return realEdges(j).some((s) => {
    if (s === e || s.road !== e.road) return false;
    const b = out(s), along = (d) => -(b[0] * d[0] + b[1] * d[1]);   // 1: straight on from s
    return along(a) > Math.cos(Math.PI / 6) && realEdges(j).every((x) => x === s || x === e || along(out(x)) <= along(a));
  });
}

// ---------- selection card ----------
const mapsLinks = ([lat, lon], label) => {
  const ll = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${ll}`,
    apple: `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(label)}`,
    googleDir: `https://www.google.com/maps/dir/?api=1&destination=${ll}`,
    appleDir: `https://maps.apple.com/?daddr=${ll}&q=${encodeURIComponent(label)}`,
  };
};
const nodeName = (n) => (n.kind === 'open' || n.kind === 'through' ? null : n.kind ? n.label : shortName(n.name));
const miles = (m) => (m < 0.25 * MI ? `${Math.round(m * 3.281 / 10) * 10} ft` : `${(m / MI).toFixed(m < 10 * MI ? 1 : 0)} mi`);
const chip = (road) => `<span class="road"><i style="background:${(M.roads[road] || {}).color || MINOR}"></i>${esc(roadText(road))}</span>`;

function actionsHtml(ll, label) {
  const L = mapsLinks(ll, label);
  return `<div class="actions">
      <a href="${L.google}" target="_blank" rel="noopener">Google Maps</a>
      <a href="${L.apple}" target="_blank" rel="noopener">Apple Maps</a>
    </div>
    <div class="directions">Directions: <a href="${L.googleDir}" target="_blank" rel="noopener">Google</a> · <a href="${L.appleDir}" target="_blank" rel="noopener">Apple</a></div>`;
}

function shareUrl(hash) { return `${location.origin}${location.pathname}#${hash}`; }
const tStr = (t) => String(Math.round(t * 1000) / 1000);

const WINDING = 2.25, WINDING_MIN = 500;   // real length ÷ straight line, and the shortest stretch (m) flagged
function edgeCard(e, t, kicker = null) {
  const ll = M.U(realAt(e.real, t));
  // Tapped zoomed out: the stretch between the junctions you can see.
  const run = sel?.e === e && sel.run?.edges.length > 1 ? sel.run : null;
  const ends = (run ? run.ends : [e.A, e.B]).map(nodeName).filter(Boolean);
  const len = run ? run.edges.reduce((a, x) => a + x.len, 0) : e.len;
  const where = run ? (ends.length === 2 ? `Between ${esc(ends[0])} and ${esc(ends[1])}` : ends.length ? `From ${esc(ends[0])}` : '')
    : e.kind === 'exit' || e.kind === 'branch'
    ? `From ${esc(nodeName(e.A.kind ? e.B : e.A))}`
    : e.A === e.B ? "A loop"
    : ends.length === 2 ? `Between ${esc(ends[0])} and ${esc(ends[1])}` : ends.length ? `From ${esc(ends[0])}` : '';
  const others = (e.roads || []).filter((r) => r && r !== e.road && !isPlaceholder(r) && !/^(CA|US|I|SR)[ -]?\d/.test(r));
  const back = e.tier === BACK_ROAD;
  // Winding: the road is much longer than the straight line between its ends, so the trip takes
  // longer than the map makes it look.
  const endAt = (n, list) => { const x = list.find((y) => y.A === n || y.B === n) || list[0]; return x.A === n ? x.real[0] : x.real[x.real.length - 1]; };
  const [p0, p1] = run ? run.ends.map((n) => endAt(n, run.edges)) : [e.real[0], e.real[e.real.length - 1]];
  const wind = e.A === e.B ? 0 : len / Math.max(1, dist(p0, p1));
  const winding = len >= WINDING_MIN && wind >= WINDING ? ` <span class="flag" title="${miles(len)} of road for ${miles(len / wind)} as the crow flies">winding road</span>` : '';
  return `<div class="kicker">${kicker || (e.style.private ? 'Private road' : back ? 'Back road' : isHighway(e) ? 'Highway' : e.tier > BACK_ROAD ? 'Local road' : 'Road')}</div>
    <h2><span class="chip" style="background:${e.style.private ? PRIVATE : e.style.color}"></span>${esc(roadText(e.road) || 'Unnamed road')}</h2>
    <div class="meta">${e.style.private ? '<b>Not open to the public.</b><br>' : back ? 'Narrow. Mainly for people who live along it, and a way out in an emergency.<br>' : ''}${where}${where ? ' · ' : ''}${miles(len)} of road${winding}${others.length ? `<br>Also signed ${others.map((r) => esc(shortName(r))).join(', ')}` : ''}</div>
    ${actionsHtml(ll, roadText(e.road))}`;
}

// A road found by search inside a neighborhood or down a collapsed branch: say where it went.
function foundHere(n) {
  if (sel?.n !== n || !sel.road) return '';
  const where = n.kind === 'area' ? 'is in this neighborhood' : n.kind === 'exit' ? 'is past this edge of the map' : 'is one of these side roads';
  return `<b>${esc(shortName(sel.road))}</b> ${where}.<br>`;
}

const GAP_R = 10.5;   // half the break where a road doesn't connect any more, in px
const gapText = (n) => [...new Set(n.edges.map((e) => roadText(e.road)).filter(Boolean))].join(' / ');
function nodeCard(n) {
  const ll = nodeLatLon(n);
  const roads = [...new Set(n.edges.map((e) => e.road).filter((r) => !isPlaceholder(r)))];
  if (n.kind === 'closed' && n.gap) {
    return `<div class="kicker">Not connected</div>
      <h2>${esc(n.label || gapText(n) || 'Not connected')}</h2>
      <div class="meta">${gapText(n) ? esc(gapText(n)) + ' doesn’t' : 'The road doesn’t'} go through here any more: its two ends aren’t connected.</div>
      ${actionsHtml(ll, n.label || gapText(n) || 'Not connected')}`;
  }
  if (n.kind === 'closed') {
    const roads = [...new Set(n.edges.map((e) => roadText(e.road)).filter(Boolean))];
    return `<div class="kicker">Road closed</div>
      <h2><span class="chip" style="background:#d93025"></span>${esc(n.label || 'Road closed')}</h2>
      <div class="meta">${roads.length ? esc(roads.join(' / ')) + ' doesn’t' : 'The road doesn’t'} go through here.</div>
      ${actionsHtml(ll, n.label || 'Road closed')}`;
  }
  if (n.kind === 'area') {
    const ways = [...new Set(n.edges.filter((e) => !e.virtual).map((e) => roadText(e.road)).filter(Boolean))];
    const inside = (n.roads || []).map((r) => shortName(r));
    return `<div class="kicker">Neighborhood</div>
      <h2>${esc(n.label)}</h2>
      <div class="meta">${foundHere(n)}${ways.length ? `Roads in and out: ${esc(ways.join(', '))}` : ''}${inside.length && !n.sub ? `<br>${inside.length} roads in it, not drawn on this map: ${esc(inside.join(', '))}` : ''}</div>
      ${n.sub ? `<button class="openSub" data-sub="${esc(n.sub)}">Open the map of ${esc(n.label)}</button>` : ''}
      ${actionsHtml(ll, n.label)}`;
  }
  if (n.kind === 'through') {
    const e = n.edges[0], name = roadText(e.road) || 'This road';
    return `<div class="kicker">Edge of the map</div>
      <h2><span class="chip" style="background:${e.style.color}"></span>${esc(name)}${n.label ? ` <span style="font-weight:400;color:var(--muted)">${esc(n.label)}</span>` : ''}</h2>
      <div class="meta">${esc(name)} continues beyond this map.</div>
      ${actionsHtml(ll, name)}`;
  }
  if (n.kind) {
    const e = n.edges[0];
    return `<div class="kicker">${n.kind === 'exit' ? 'Edge of the map' : 'Side roads'}</div>
      <h2>${esc(n.label)}</h2>
      <div class="meta">${foundHere(n)}${n.kind === 'exit' ? `${esc(roadText(e.road))} continues off this map.` : 'Drawn as one line on this map.'}</div>
      ${sub && n.kind === 'exit' ? '<button class="openSub back" data-back>Back to the 95033 map</button>' : ''}
      ${actionsHtml(ll, n.label)}`;
  }
  const kind = n.edges.some(isHighway) ? 'Interchange' : 'Junction';
  return `<div class="kicker">${kind}</div>
    <h2>${esc(shortName(n.name))}</h2>
    <div class="roads">${roads.map(chip).join('')}</div>
    ${actionsHtml(ll, shortName(n.name))}`;
}

function meCard() {
  const l = me?.loc;
  if (!l) return `<div class="kicker">Your location</div><h2>Finding you…</h2><div class="meta">Allow location access if your browser asks.</div>`;
  const acc = `±${miles(me.acc)}`;
  if (l.far) {
    return `<div class="kicker">Your location</div><h2>You're off this map</h2>
      <div class="meta">The nearest road on it is ${esc(roadText(l.e.road))}, ${miles(l.d)} away.</div>`;
  }
  const road = roadText(l.e.road);
  const inArea = l.beyond?.kind === 'area';
  const head = inArea ? `In ${esc(l.beyond.label)}` : l.beyond ? `Past “${esc(l.beyond.label)}”` : l.d < 40 ? `On ${esc(road)}` : `Near ${esc(road)}`;
  const meta = inArea ? `${l.hiddenRoad && !isPlaceholder(l.hiddenRoad) && l.d < 40 ? `On ${esc(roadText(l.hiddenRoad))}. ` : ''}${l.beyond.sub ? 'Its streets are on a map of their own.' : 'The streets in it aren\'t drawn on this map.'}`
    : l.beyond ? 'You\'re in a part of the area this map doesn\'t draw; the dot is where it leaves the map.' : l.d < 40 ? `GPS accuracy ${acc}` : `${miles(l.d)} from the road · GPS ${acc}`;
  const open = inArea && l.beyond.sub ? `<button class="openSub" data-sub="${esc(l.beyond.sub)}">Open the map of ${esc(l.beyond.label)}</button>` : '';
  return `<div class="kicker">Your location</div><h2>${head}</h2><div class="meta">${meta}</div>${open}
    ${actionsHtml([me.lat, me.lon], 'My location')}`;
}

// Emoji for marking a spot. Anything else can be typed into "Other".
const EMOJI = [['🪵', 'Tree down'], ['💥', 'Crash'], ['🚧', 'Road closed'], ['⚡', 'Power line down'],
  ['🌊', 'Flooding'], ['🪨', 'Rocks or slide'], ['🔥', 'Fire'], ['⚠️', 'Hazard']];
// One emoji (one grapheme, which may be several code points: ⚠️, flags, 🧑‍🚒), or null.
function cleanEmoji(v) {
  v = String(v ?? '').trim();
  if (!v) return null;
  const g = 'Segmenter' in Intl ? [...new Intl.Segmenter().segment(v)][0]?.segment : [...v][0];
  return g && g.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) ? g : null;
}
const pickName = (p) => (p.type === 'edge' ? roadText(p.e.road) || 'Unnamed road'
  : p.n.kind ? p.n.label || roadText(p.n.edges[0]?.road) || 'Edge of the map' : shortName(p.n.name));
const emojiName = (e) => EMOJI.find(([x]) => x === e)?.[1];
function stateTitle() {
  const roads = [...new Set(picks.map(pickName))], marks = pins.map((q) => `${q.emoji} ${roadText(q.e.road) || 'Unnamed road'}`);
  return [...roads, ...marks].join(', ') || '95033 Road Map';
}

// One chip for each road highlighted (a road found by search is highlighted in all its lines).
function picksHtml() {
  if (!picks.includes(sel)) return '';
  const names = [...new Set(picks.map(pickName))];
  if (names.length < 2) return '';
  return `<div class="picks">${names.map((nm) => `<span class="pick${pickName(sel) === nm ? ' on' : ''}" data-pick="${esc(nm)}">${esc(nm)}<button data-unpick="${esc(nm)}" aria-label="Remove ${esc(nm)}">×</button></span>`).join('')}</div>`;
}
// Where an emoji picked in this card goes: where the line was tapped, the junction, or you.
function spotFor(s) {
  if (s?.type === 'edge') return { e: s.e, t: s.t };
  if (s?.type === 'node' && s.n.edges.length) return { e: s.n.edges[0], t: endT(s.n.edges[0], s.n) };
  if (s?.type === 'me' && me?.loc && !me.loc.far) return { e: me.loc.e, t: me.loc.t };
  if (s?.type === 'pin') return s.pin;
  return null;
}
function emojiRow(current) {
  const custom = current && !EMOJI.some(([e]) => e === current);
  return `<div class="mark" role="group" aria-label="Emoji">${EMOJI.map(([e, t]) =>
    `<button data-emoji="${e}" title="${t}" aria-label="${t}"${current === e ? ' class="on" aria-pressed="true"' : ''}>${e}</button>`).join('')}
    <input class="other" placeholder="${custom ? esc(current) : 'Other'}" aria-label="Another emoji" enterkeyhint="done"${custom ? ' data-on' : ''}></div>`;
}
function markHtml() {
  if (sel.type === 'me') return spotFor(sel) ? `<div class="markLabel">Put an emoji where you are</div>${emojiRow(null)}` : '';
  return `<button class="addMore${adding ? ' on' : ''}" title="Or shift-click roads">${adding ? 'Done adding' : '＋ Highlight more roads'}</button>${adding ? '<span class="hint">Tap roads to add or remove them</span>' : ''}`;
}
// The emoji button: tap a road, then pick the emoji in a popup right there. sel is { type: 'place' }
// until the road is tapped, then also has `at` ({ e, t }), until an emoji is picked.
function startPlacing() {
  if (sel?.type === 'place') return endPlacing();
  sel = { type: 'place', at: null };
  document.body.classList.add('placing');
  showCard(); drawMarks();
  toast('Tap the road where the emoji goes', 4000);
}
function endPlacing() {
  document.body.classList.remove('placing');
  $('emojiPop').hidden = true;
  if (sel?.type === 'place') sel = null;
  showCard(); drawMarks();
}
// The popup sits just above the spot (below it, near the top of the screen), and follows it as the map moves.
function placeEmojiPop(k) {
  const pop = $('emojiPop');
  if (sel?.type !== 'place' || !sel.at) { pop.hidden = true; return; }
  const [x, y] = schemAt(sel.at.e, sel.at.t), r = svg.getBoundingClientRect();
  const sx = r.left + (x - view.x) / k, sy = r.top + (y - view.y) / k;
  if (pop.hidden) $('emojiRow').innerHTML = emojiRow(null);
  pop.hidden = false;
  const w = pop.offsetWidth, h = pop.offsetHeight, below = sy - h - 20 < 8;
  const left = clamp(sx - w / 2, 8, innerWidth - w - 8);
  pop.classList.toggle('below', below);
  pop.style.left = `${left}px`;
  pop.style.top = `${below ? sy + 20 : sy - h - 20}px`;
  pop.style.setProperty('--tail', `${clamp(sx - left, 16, w - 16)}px`);
}
function pinCard(q) {
  const ll = M.U(realAt(q.e.real, q.t)), road = roadText(q.e.road) || 'Unnamed road', a = pinNode(q);
  const title = `${q.emoji} ${emojiName(q.emoji) || 'Marked'}`;
  return `<div class="kicker">Marked spot</div>
    <h2><span class="pinEmo">${esc(q.emoji)}</span>${esc(emojiName(q.emoji) || 'Marked spot')}</h2>
    <div class="meta">${a ? `In ${esc(a.label)}` : `On ${esc(road)}`}</div>
    ${actionsHtml(ll, `${title} on ${a ? a.label : road}`)}
    <div class="markLabel">Change it</div>${emojiRow(q.emoji)}
    <button class="removePin">Remove this emoji</button>`;
}

function poiCard(q) {
  const road = roadText(q.e.road) || 'an unnamed road';
  return `<div class="kicker">${esc(q.type || 'Place')}</div>
    <h2><span class="pinEmo">${esc(q.icon)}</span>${esc(q.name)}</h2>
    <div class="meta">On ${esc(road)}</div>
    ${actionsHtml([q.lat, q.lon], q.name)}`;
}

function showCard() {
  const body = $('cardBody');
  if (!sel) { $('card').hidden = true; document.body.classList.remove('has-card'); return; }
  if (sel.type !== 'place') { document.body.classList.remove('placing'); $('emojiPop').hidden = true; }
  else { $('card').hidden = true; document.body.classList.remove('has-card'); return; }
  body.innerHTML = sel.type === 'pin' ? pinCard(sel.pin) : sel.type === 'poi' ? poiCard(sel.q)
    : picksHtml() + (sel.type === 'edge' ? edgeCard(sel.e, sel.t) : sel.type === 'node' ? nodeCard(sel.n) : meCard()) + markHtml();
  $('card').hidden = false;
  document.body.classList.add('has-card');
  document.documentElement.style.setProperty('--card-h', `${$('card').offsetHeight + 12}px`);
}

// The share button: a link to the map as it is, with everything highlighted and every emoji (not your location).
async function share() {
  const h = stateHash(), url = h ? shareUrl(h) : `${location.origin}${location.pathname}`, title = stateTitle();
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link:', url); }
}

// The link: the highlighted lines and junctions, then each emoji. Line ends have no link of their own,
// so they link to their line; a neighborhood links to where it is.
function stateHash() {
  const lines = [], nodes = [], places = [];
  for (const p of picks) {
    if (p.type === 'edge') lines.push(p.e.slug);
    else if (!p.n.kind) nodes.push(p.n.slug);
    else if (p.n.kind === 'area') places.push(nodeLatLon(p.n).map((v) => v.toFixed(5)).join(','));
    else lines.push(p.n.edges[0].slug);
  }
  const h = sub ? [`a=${sub.slug}`] : [];
  if (lines.length) h.push(`s=${[...new Set(lines)].join(',')}`);
  if (nodes.length) h.push(`n=${nodes.join(',')}`);
  for (const ll of places) h.push(`ll=${ll}`);
  for (const q of pins) h.push(`p=${encodeURIComponent(q.emoji)},${q.e.slug},${tStr(q.t)}`);
  if (sel?.type === 'poi') h.push(`f=${sel.q.slug}`);
  return h.join('&');
}
function writeHash() {
  const h = stateHash();
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
}

// Show something in the card. A line or junction is highlighted: on its own, or with add, along with
// what's highlighted already (again with add: no longer highlighted). null clears the highlights.
// Emoji stay until they're removed from their card.
function select(s, { hash = true, reveal: rv = true, add = false } = {}) {
  if (!s || s.type === 'edge' || s.type === 'node') {
    const had = s && picks.find((p) => samePick(p, s));
    if (add && had) { unpick(had); return; }
    if (add && s) picks.push(s); else picks = s ? [s] : [];
    if (!picks.length) adding = false;
  }
  sel = s;
  if (hash) writeHash();
  showCard();
  drawMarks();
  if (rv && s) reveal(s.type === 'me' ? me?.loc?.at : s.type === 'pin' ? pinSpot(s.pin) : s.type === 'poi' ? schemAt(s.q.e, s.q.t) : pickPos(s));
}
function focusPick(p) {
  sel = p;
  showCard(); drawMarks();
  reveal(pickPos(p));
}
function unpick(p) {
  picks = picks.filter((x) => x !== p);
  if (!picks.length) adding = false;
  if (sel === p) sel = picks[picks.length - 1] || null;
  writeHash(); showCard(); drawMarks();
}
// An emoji picked in a card: a new pin there, or (in a pin's card) a different emoji.
function pickEmoji(e) {
  if (sel?.type === 'place') {
    if (!sel.at) return;
    pins.push({ emoji: e, ...sel.at });
    endPlacing(); writeHash();
    return toast('Tap the emoji to change or remove it');
  }
  if (sel?.type === 'pin') sel.pin.emoji = e;
  else {
    const at = spotFor(sel);
    if (!at) return;
    const q = { emoji: e, e: at.e, t: at.t };
    pins.push(q);
    sel = { type: 'pin', pin: q };
  }
  writeHash(); showCard(); drawMarks();
}
function removePin(q) {
  pins = pins.filter((x) => x !== q);
  if (sel?.pin === q) sel = null;
  writeHash(); showCard(); drawMarks();
}
$('cardBody').addEventListener('click', (ev) => {
  const b = ev.target.closest('button, .pick');
  if (!b) return;
  if (b.dataset.unpick != null) { ev.stopPropagation(); return picks.filter((p) => pickName(p) === b.dataset.unpick).forEach(unpick); }
  if (b.dataset.pick != null) return focusPick(picks.filter((p) => pickName(p) === b.dataset.pick).reduce((a, p) => (p.e && a.e && p.e.len > a.e.len ? p : a)));
  if (b.dataset.sub) return openSub(b.dataset.sub);
  if (b.dataset.back != null) return leaveSub();
  if (b.dataset.emoji) return pickEmoji(b.dataset.emoji);
  if (b.classList.contains('removePin')) return removePin(sel.pin);
  if (b.classList.contains('addMore')) { adding = !adding; showCard(); }
});
$('emojiPop').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (b?.dataset.emoji) pickEmoji(b.dataset.emoji);
  else if (b?.id === 'emojiClose') endPlacing();
});
// "Other": the first emoji typed (an emoji keyboard, or the system picker).
const otherInput = (ev) => {
  if (!ev.target.classList.contains('other')) return;
  const e = cleanEmoji(ev.target.value);
  if (e) pickEmoji(e);
  else if (ev.target.value.trim() && !/\p{Extended_Pictographic}/u.test(ev.target.value)) { ev.target.value = ''; toast('Only an emoji can go here'); }
};
$('cardBody').addEventListener('input', otherInput);
$('emojiPop').addEventListener('input', otherInput);

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- links ----------
function edgeBounds(e) {
  const pts = anchorPts(e);
  return [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
}
// A line by its link name, or (retired) the closest line today. -> { e, t } or null.
function lineFor(slug, t, notes) {
  const e = M.bySlug.get(slug);
  if (e) return { e, t };
  // A link to a road that has since changed: the closest spot on today's roads.
  const old = M.retired[slug];
  const r = old && locate(...M.U(realAt(old, t)));
  if (r) { notes.changed = true; return { e: r.e, t: r.t }; }
  notes.missing = true;
  return null;
}
// A link to a neighborhood's map opens it first; the rest of the link is on that map.
function openHash() {
  const h = new URLSearchParams(location.hash.slice(1)), a = h.get('a');
  if (a && sub?.slug !== a) { openSub(a, { push: false }).then((ok) => ok && applyHash(h)); return true; }
  if (!a && sub) closeSub({ quiet: true });
  return applyHash(h);
}
function applyHash(h) {
  const list = (k) => h.getAll(k).flatMap((v) => v.split(',')).filter(Boolean);
  // Older links point at one spot on one line (s=...&t=0.42).
  let t0 = parseFloat(h.get('t'));
  t0 = Number.isFinite(t0) ? clamp(t0, 0, 1) : 0.5;
  const notes = {}, newPicks = [], newPins = [], boxes = [];
  for (const slug of list('s')) {
    const r = lineFor(slug, t0, notes);
    if (r && !newPicks.some((p) => p.e === r.e)) { newPicks.push({ type: 'edge', e: r.e, t: r.t }); boxes.push(edgeBounds(r.e)); }
  }
  for (const slug of list('n')) {
    const n = M.nodeBySlug.get(slug);
    if (n) { newPicks.push({ type: 'node', n }); boxes.push([n.x, n.y, n.x, n.y]); } else notes.missing = true;
  }
  for (const v of h.getAll('ll')) {
    const [lat, lon] = v.split(',').map(Number);
    const r = Number.isFinite(lat) && Number.isFinite(lon) ? locate(lat, lon) : null;
    if (!r) { notes.missing = true; continue; }
    // A spot inside a neighborhood opens the neighborhood.
    const p = r.beyond?.kind === 'area' ? { type: 'node', n: r.beyond } : { type: 'edge', e: r.e, t: r.t };
    if (p.type === 'edge') notes.moved = true;
    newPicks.push(p);
    boxes.push(p.type === 'node' ? [p.n.x, p.n.y, p.n.x, p.n.y] : edgeBounds(p.e));
  }
  for (const v of h.getAll('p')) {
    const [emo, slug, tv] = v.split(','), emoji = cleanEmoji(emo), t = clamp(parseFloat(tv) || 0, 0, 1);
    const r = emoji && slug && lineFor(slug, t, notes);
    if (!r) { if (!emoji) notes.missing = true; continue; }
    const q = { emoji, e: r.e, t: r.t };
    newPins.push(q);
    const [x, y] = pinSpot(q);
    boxes.push([x, y, x, y]);
  }
  let poi = null;
  for (const slug of list('f')) {
    const q = M.places.find((x) => x.slug === slug);
    if (!q) { notes.missing = true; continue; }
    poi = { type: 'poi', q };
    const [x, y] = schemAt(q.e, q.t);
    boxes.push([x, y, x, y]);
  }
  if (notes.changed) toast('This road has changed since the link was made');
  else if (notes.missing) toast(boxes.length ? 'Part of that link isn\'t on this map' : 'That link isn\'t on this map');
  if (!boxes.length) return false;
  // A local road with "Hide local roads" on: show local roads again.
  if (hideLocal && [...newPicks.map((p) => p.e || p.n), ...newPins.map((q) => q.e)].some((x) => x?.local)) setHideLocal(false);
  picks = newPicks; pins = newPins; adding = false;
  sel = poi || picks[0] || { type: 'pin', pin: pins[0] };
  writeHash();
  showCard(); drawMarks();
  if (boxes.length === 1) {
    const b = boxes[0];
    return sel.type === 'edge' ? focusOn(schemAt(sel.e, sel.t), b) : focusOn([b[0], b[1]]);
  }
  // Several things: show them all.
  fitTo([Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))], 0.12, newPins.length ? 44 : 0);
  return true;
}
function focusOn(p, b) {
  const R = 1500;
  const box = b ? [Math.min(b[0], p[0] - R), Math.min(b[1], p[1] - R), Math.max(b[2], p[0] + R), Math.max(b[3], p[1] + R)] : [p[0] - R, p[1] - R, p[0] + R, p[1] + R];
  // Keep the linked point in the middle, wide enough to show the whole line (within reason).
  const span = Math.min(Math.max(box[2] - box[0], box[3] - box[1]), 9000);
  fitTo([p[0] - span / 2, p[1] - span / 2, p[0] + span / 2, p[1] + span / 2], 0.05);
  return true;
}

// ---------- location ----------
let watchId = null, firstFix = false;
function startLocating() {
  if (!navigator.geolocation) { toast('Location isn\'t available in this browser'); return; }
  if (watchId !== null) { if (me?.loc) select({ type: 'me' }); if (me?.loc && !me.loc.far) reveal(me.loc.at, 6000); return; }
  $('btnLocate').classList.add('busy');
  firstFix = true;
  me = { acc: 0, loc: null };
  select({ type: 'me' }, { hash: false, reveal: false });
  watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    stopLocating();
    toast(err.code === 1 ? deniedHelp() : 'Couldn\'t get your location', err.code === 1 ? 7000 : 2200);
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
}
// Denied without asking means the browser or the phone has location turned off for it.
function deniedHelp() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return 'Location is off for this site. Turn it on in Settings › Privacy & Security › Location Services › ' +
      (/CriOS/.test(ua) ? 'Chrome' : 'Safari Websites') + ', then reload';
  }
  if (/Android/.test(ua)) return 'Location is off for this site. Allow it in the browser\'s site settings (the icon left of the address), then reload';
  return 'Location is off for this site. Allow it from the icon left of the address (and for the browser in your system\'s privacy settings), then reload';
}
function stopLocating() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; me = null;
  $('btnLocate').classList.remove('busy', 'on');
  if (sel?.type === 'me') { sel = picks[picks.length - 1] || null; showCard(); }
  drawMarks();
}
function onFix(g) {
  const { latitude: lat, longitude: lon, accuracy } = g.coords;
  const r = locate(lat, lon);
  me = { lat, lon, acc: accuracy || 30, loc: r };
  if (r) {
    r.far = r.d > 3000;
    // How many map units a real meter is around here (lines are stretched or squeezed).
    const e = r.e, i = Math.max(1, e.an.findIndex((a) => a.t >= r.t)), A = e.an[i - 1], B = e.an[i];
    r.scale = clamp(dist([A.x, A.y], [B.x, B.y]) / Math.max(1, (B.t - A.t) * e.len), 0.05, 5);
  }
  $('btnLocate').classList.remove('busy');
  $('btnLocate').classList.add('on');
  if (sel?.type === 'me') showCard();
  drawMarks();
  if (firstFix) {
    firstFix = false;
    if (r && !r.far) reveal(r.at, 6000);
  }
}

// ---------- input ----------
// One finger (or mouse) pans, two pinch; a tap selects; a double tap zooms in.
const ptrs = new Map();
let gesture = null, lastTap = null;
svg.addEventListener('pointerdown', (ev) => {
  if (!M) return;
  svg.setPointerCapture(ev.pointerId);
  ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
  if (ptrs.size === 1) gesture = { kind: 'pan', start: [ev.clientX, ev.clientY], view: { ...view }, t0: performance.now(), moved: false };
  else if (ptrs.size === 2) {
    const [p, q] = [...ptrs.values()];
    gesture = { kind: 'pinch', d0: dist(p, q), w0: view.w, mid: toMap((p[0] + q[0]) / 2, (p[1] + q[1]) / 2), moved: true };
  }
});
svg.addEventListener('pointermove', (ev) => {
  if (!ptrs.has(ev.pointerId)) return;
  ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]);
  const k = upp();
  if (gesture?.kind === 'pan' && ptrs.size === 1) {
    const dx = ev.clientX - gesture.start[0], dy = ev.clientY - gesture.start[1];
    if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
    gesture.moved = true;
    svg.classList.add('dragging');
    view.x = gesture.view.x - dx * k; view.y = gesture.view.y - dy * k;
    draw();
  } else if (gesture?.kind === 'pinch' && ptrs.size === 2) {
    const [p, q] = [...ptrs.values()];
    const w = clamp(gesture.w0 * gesture.d0 / Math.max(dist(p, q), 1), minW(), maxW());
    const [W] = size(), k2 = w / W;
    const cx = (p[0] + q[0]) / 2, cy = (p[1] + q[1]) / 2;
    view.w = w;
    view.x = gesture.mid[0] - cx * k2; view.y = gesture.mid[1] - cy * k2;
    draw();
  }
});
function endPointer(ev) {
  if (!ptrs.has(ev.pointerId)) return;
  ptrs.delete(ev.pointerId);
  svg.classList.remove('dragging');
  scheduleHover(ev);
  if (gesture?.kind === 'pan' && !gesture.moved && ptrs.size === 0 && ev.type === 'pointerup' && performance.now() - gesture.t0 < 600) tap(ev);
  if (ptrs.size === 1) {
    const [p] = [...ptrs.values()];
    gesture = { kind: 'pan', start: p, view: { ...view }, t0: 0, moved: true };
  } else if (!ptrs.size) gesture = null;
}
svg.addEventListener('pointerup', endPointer);
svg.addEventListener('pointercancel', endPointer);
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect();
  zoomAt(Math.exp(ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), ev.clientX - r.left, ev.clientY - r.top);
  scheduleHover(ev);
}, { passive: false });

function tap(ev) {
  const r = svg.getBoundingClientRect(), cx = ev.clientX - r.left, cy = ev.clientY - r.top;
  const now = performance.now();
  if (lastTap && now - lastTap.time < 320 && Math.hypot(cx - lastTap.x, cy - lastTap.y) < 24) {
    lastTap = null;
    zoomAt(0.5, cx, cy);
    return;
  }
  lastTap = { time: now, x: cx, y: cy };
  const p = toMap(cx, cy), k = upp(), tol = (ev.pointerType === 'touch' ? 22 : 12) * k;
  const add = ev.shiftKey || adding;
  if (sel?.type === 'place') return placeAt(p, tol);
  const h = hitAt(p, k, tol);
  if (h?.type === 'pin') return select({ type: 'pin', pin: h.pin }, { reveal: false });
  if (h?.type === 'me') return select({ type: 'me' }, { reveal: false });
  if (h?.type === 'poi') return select({ type: 'poi', q: h.q }, { reveal: false });
  if (h?.type === 'bunch') {
    // Side roads bunched together: zoom in on them until they come apart.
    const { b } = h, c = [(b.bounds[0] + b.bounds[2]) / 2, (b.bounds[1] + b.bounds[3]) / 2], [W, H] = size();
    view.x = c[0] - W / 2 * k; view.y = c[1] - H / 2 * k;
    return zoomAt(Math.min(0.6, b.gap / (BUNCH_PX * 1.5 * k)), W / 2, H / 2);
  }
  if (h?.type === 'node') return select({ type: 'node', n: h.n }, { reveal: false, add });
  if (h?.type === 'edge' && h.e.uFor) return pickRun({ edges: [h.e.uFor], ends: [h.e.uFor.A, h.e.uFor.B] }, h.e.uFor, 0.5, add);
  if (h?.type === 'edge') return pickRun(runOf(h.e), h.e, h.t, add);
  if (!add && sel?.type !== 'me') select(null);
}
// What's at map point p (k: map units per pixel, tol: how near counts), topmost first: an emoji, your
// location, a place, a bunch of side roads, a junction or neighborhood, a line. Taps and the tooltip.
function hitAt(p, k, tol) {
  const pin = [...pins].reverse().find((q) => dist(p, pinAt(q, k)) < 16 * k);
  if (pin) return { type: 'pin', pin };
  if (me?.loc && !me.loc.far && dist(p, me.loc.at) < tol) return { type: 'me' };
  const poi = M.places.filter(placeShown).map((q) => ({ q, d: dist(p, placeGeom(q, k).c) })).filter((x) => x.d < Math.max(tol, (PLACE_R + 3) * k)).sort((a, b) => a.d - b.d)[0];
  if (poi) return { type: 'poi', q: poi.q };
  const b = bunchesShown().find((b) => segProject([b.j.x, b.j.y], bunchTip(b, k), p).d <= tol);
  if (b) return { type: 'bunch', b };
  let node = null;
  for (const n of M.nodes) {
    if (n.kind === 'open' || !n.edges.length || !shown(n) || plainNow(n)) continue;
    const d = dist(p, [n.x, n.y]);
    if (d < (n.kind === 'area' ? Math.max(tol * 0.8, areaR(n, k)) : tol * 0.8) && (!node || d < node.d)) node = { n, d };
  }
  if (node) return { type: 'node', n: node.n };
  let best = null;
  for (const e of M.edges) {
    if (!shown(e)) continue;
    const pr = schemProject(e, p);
    if (pr.d < tol && (!best || pr.d < best.d)) best = { e, ...pr };
  }
  if (best?.e.virtual) return { type: 'node', n: best.e.area };
  return best ? { type: 'edge', e: best.e, t: best.t } : null;
}

// With a mouse: a pointing hand where a click does something, and for what isn't named on the map
// (places zoomed out, emoji, bunched side roads…) a tooltip.
// Phones have the card only.
let hoverEv = null, hoverRaf = 0;
function tipFor(h) {
  if (h.type === 'pin') return [`${h.pin.emoji} ${emojiName(h.pin.emoji) || 'Marked spot'}`];
  if (h.type === 'me') return ['Your location'];
  if (h.type === 'poi') return [`${h.q.icon} ${h.q.name}`, h.q.type];
  if (h.type === 'bunch') {
    const names = [...new Set(h.b.names || [])];
    return [`${Math.max(names.length, h.b.leaves.length)} side roads`, names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '') : 'Click to zoom in'];
  }
  if (h.type === 'node') {
    const n = h.n;
    if (n.kind === 'area') return [n.label, n.sub ? 'Neighborhood · click to open its map' : 'Neighborhood'];
    if (n.kind === 'closed' && n.gap) return [n.label || gapText(n) || 'Not connected', 'Not connected: doesn’t go through'];
    if (n.kind === 'closed') return [n.label || 'Road closed', 'Road closed'];
    if (n.kind) return [pickName({ n }), n.kind === 'branch' ? 'Side roads' : 'Edge of the map'];
  }
  return null;   // roads and junctions: their names are on the map, the hand says they can be clicked
}
function hover() {
  hoverRaf = 0;
  const ev = hoverEv, tip = $('tip');
  const h = ev && M && !ptrs.size && sel?.type !== 'place' ? (() => {
    const r = svg.getBoundingClientRect(), k = upp();
    return hitAt(toMap(ev.clientX - r.left, ev.clientY - r.top), k, 10 * k);
  })() : null;
  svg.classList.toggle('hot', !!h);
  const t = h && tipFor(h);
  if (!t) { tip.hidden = true; return; }
  const [title, sub] = t;
  tip.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}`;
  tip.hidden = false;
  const w = tip.offsetWidth, ht = tip.offsetHeight;
  const x = ev.clientX + 14 + w > innerWidth - 8 ? ev.clientX - 10 - w : ev.clientX + 14;
  const y = ev.clientY + 20 + ht > innerHeight - 8 ? ev.clientY - 12 - ht : ev.clientY + 20;
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function scheduleHover(ev) {
  if (ev) hoverEv = ev.pointerType === 'mouse' || ev.type === 'wheel' ? ev : null;
  if (!hoverRaf) hoverRaf = requestAnimationFrame(hover);
}
svg.addEventListener('pointermove', scheduleHover);
svg.addEventListener('pointerleave', () => { hoverEv = null; scheduleHover(); });
// A line and the lines it runs on into, through junctions that aren't drawn at this zoom (zoomed
// out, or with local roads hidden): what looks like one stretch of road is selected as one.
function runOf(e) {
  const edges = [e], ends = [];
  for (const start of [e.A, e.B]) {
    let cur = e, n = start;
    while (!n.kind && (!shown(n) || plainNow(n))) {
      const next = n.edges.filter((x) => x !== cur && shown(x));
      if (next.length !== 1 || edges.includes(next[0])) break;
      cur = next[0]; edges.push(cur);
      n = cur.A === n ? cur.B : cur.A;
    }
    ends.push(n);
  }
  return { edges, ends };
}
// Tapped a line: highlight its stretch, instead of what was highlighted (with add: along with it, or
// if it's highlighted already, take it out).
function pickRun(run, e, t, add) {
  const picked = (x) => picks.find((p) => p.type === 'edge' && p.e === x);
  if (add && picked(e)) {
    picks = picks.filter((p) => p.type !== 'edge' || !run.edges.includes(p.e));
    if (!picks.length) adding = false;
    if (!picks.includes(sel)) sel = picks[picks.length - 1] || null;
  } else {
    if (!add) picks = [];
    for (const x of run.edges) if (!picked(x)) picks.push({ type: 'edge', e: x, t: 0.5 });
    sel = picked(e);
    Object.assign(sel, { t, run });
  }
  writeHash(); showCard(); drawMarks();
}
// Putting an emoji on the map: it goes on the nearest road, where it was tapped; the emoji is picked
// in a popup there. Tapping somewhere else moves the spot.
function placeAt(p, tol) {
  let best = null;
  for (const e of M.edges) {
    if (!shown(e) || e.virtual) continue;
    const pr = schemProject(e, p);
    if (pr.d < tol * 1.5 && (!best || pr.d < best.d)) best = { e, ...pr };
  }
  if (!best) return toast('Tap on a road');
  sel.at = { e: best.e, t: best.t };
  drawMarks();
}

$('btnIn').onclick = () => { const [W, H] = size(); zoomAt(0.6, W / 2, H / 2); };
$('btnOut').onclick = () => { const [W, H] = size(); zoomAt(1 / 0.6, W / 2, H / 2); };
$('btnFit').onclick = () => (sub ? fitWithTips() : fitTo(M.bounds));
// Geography <-> schematic. Redraws are coalesced to one per frame while dragging.
let morphQueued = null;
$('morph').oninput = (ev) => {
  const v = ev.target.value / 1000;
  if (morphQueued === null) requestAnimationFrame(() => { const m = morphQueued; morphQueued = null; if (M) applyMorph(m, true); });
  morphQueued = v;
};
// ---------- road search ----------
// Every road name people might look for: roads on the map (and their other names, River St on Hwy 9),
// neighborhoods and the roads in them, and roads tucked away in collapsed branches and map exits.
let searchIndex = null;
const norm = (s) => shortName(String(s)).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// On a neighborhood's map: its roads, then the main map's (picking one goes back to it).
function buildSearch() {
  const own = buildSearchFor(M);
  if (!sub) return own;
  const names = new Set(own.map((it) => it.n));
  sub.main.searchIndex ||= buildSearchFor(sub.main.M);
  return [...own, ...sub.main.searchIndex.filter((it) => !names.has(it.n)).map((it) => ({ ...it, main: true, rank: it.rank + 5, sub: `${it.sub} · 95033 map` }))];
}
// The helpers it uses read M, so it's pointed at the map being indexed.
function buildSearchFor(m) {
  const was = M;
  M = m;
  try { return buildSearchIndex(); } finally { M = was; }
}
function buildSearchIndex() {
  const out = [], seen = new Set();
  const add = (name, item) => {
    if (!name || isPlaceholder(name)) return;
    const key = `${norm(name)}|${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: shortName(name), n: norm(name), ...item });
  };
  const byRoad = new Map();
  for (const e of M.edges) {
    if (isPlaceholder(e.road)) continue;
    if (!byRoad.has(e.road)) byRoad.set(e.road, []);
    byRoad.get(e.road).push(e);
  }
  for (const [road, es] of byRoad) {
    const len = es.reduce((s, e) => s + e.len, 0), e0 = es[0];
    const top = Math.min(...es.map((e) => e.tier || 4));   // its most important stretch
    const kind = e0.style.private ? 'Private road' : isHighway(e0) ? 'Highway' : top === BACK_ROAD ? 'Back road' : top > BACK_ROAD ? 'Local road' : 'Road';
    add(roadText(road), { id: `r:${road}`, type: 'road', road, edges: es, sub: `${kind} · ${miles(len)}`, color: e0.style.private ? PRIVATE : e0.style.color, rank: 0 });
    if (roadText(road) !== shortName(road)) add(road, { id: `r:${road}`, type: 'road', road, edges: es, sub: `${kind} · shown as ${roadText(road)}`, color: e0.style.color, rank: 0 });
    for (const other of new Set(es.flatMap((e) => e.roads || []))) {
      if (other === road || /^(CA|US|I|SR)[ -]?\d/.test(other)) continue;
      add(other, { id: `r:${road}`, type: 'road', road, edges: es.filter((e) => e.roads?.includes(other)), sub: `Part of ${roadText(road)}`, color: e0.style.color, rank: 1 });
    }
  }
  for (const n of M.nodes) {
    if (n.kind !== 'area') continue;
    add(n.label, { id: `n:${n.id}`, type: 'node', node: n, sub: `Neighborhood · ${(n.roads || []).length} roads`, rank: 0 });
    for (const r of n.roads || []) if (!byRoad.has(r)) add(r, { id: `n:${n.id}`, type: 'node', node: n, road: r, sub: `In ${n.label}`, rank: 1 });
  }
  for (const q of M.places) add(q.name, { id: `f:${q.slug}`, type: 'poi', q, sub: `${q.type || 'Place'} · on ${roadText(q.e.road) || 'an unnamed road'}`, icon: q.icon, rank: 0 });
  for (const n of M.nodes) for (const name of n.places || []) add(name, { id: `n:${n.id}`, type: 'node', node: n, place: name, sub: `In ${n.label}`, icon: '📍', rank: 1 });
  for (const h of M.hidden) {
    const tip = h.tips.find((n) => n.edges.length);
    if (!h.road || !tip || tip.kind === 'area' || byRoad.has(h.road)) continue;
    add(h.road, { id: `n:${tip.id}`, type: 'node', node: tip, road: h.road,
      sub: tip.kind === 'exit' ? `Off the map, ${tip.label}` : `Side road off ${roadText(tip.edges[0].road)}`, rank: 1 });
  }
  return out;
}
// Every word typed has to start a word of the name; names that start with the query come first.
function searchRoads(q) {
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  searchIndex ||= buildSearch();
  const hits = [];
  for (const it of searchIndex) {
    const nameWords = it.n.split(' ');
    if (!words.every((w) => nameWords.some((x) => x.startsWith(w)))) continue;
    const score = (it.n.startsWith(words.join(' ')) ? 0 : nameWords[0].startsWith(words[0]) ? 1 : 2) * 10 + it.rank;
    hits.push({ it, score });
  }
  hits.sort((a, b) => a.score - b.score || a.it.name.localeCompare(b.it.name));
  return hits.slice(0, 8).map((h) => h.it);
}
let results = [], resultOn = -1;
function showResults() {
  const q = $('q').value, ul = $('results');
  results = q.trim() ? searchRoads(q) : [];
  resultOn = results.length ? 0 : -1;
  if (!q.trim()) { ul.hidden = true; return; }
  ul.innerHTML = results.length ? results.map((it, i) => `<li role="option" data-i="${i}"${i === resultOn ? ' class="on"' : ''}>
      ${it.icon ? `<span class="chip ico">${esc(it.icon)}</span>` : it.color ? `<span class="chip" style="background:${it.color}"></span>` : '<span class="chip" style="background:var(--node-stroke)"></span>'}
      <span><div class="nm">${esc(it.name)}</div><div class="sub">${esc(it.sub)}</div></span></li>`).join('')
    : '<li class="empty">Nothing by that name on this map</li>';
  ul.hidden = false;
}
function markResult() { [...$('results').children].forEach((li, i) => li.classList.toggle('on', i === resultOn)); }
async function goTo(it) {
  $('results').hidden = true;
  $('q').blur();
  // A road on the main map, from a neighborhood's: back to the main map first.
  if (it.main) { closeSub(); return goTo({ ...it, main: false }); }
  // A place in a neighborhood with its own map: that map, with the place's card.
  if (it.type === 'node' && it.node.sub && it.place) {
    if (!(await openSub(it.node.sub))) return;
    searchIndex ||= buildSearch();
    const found = searchIndex.find((x) => !x.main && x.type === 'poi' && x.q.name === it.place);
    if (found) return goTo(found);
    return;
  }
  if (it.type === 'poi') {
    if (hideLocal && it.q.e.local) setHideLocal(false);
    select({ type: 'poi', q: it.q }, { reveal: false });
    const [x, y] = schemAt(it.q.e, it.q.t);
    return fitTo([x - 500, y - 500, x + 500, y + 500], 0.05);
  }
  // A street in a neighborhood with its own map: that map, with the street highlighted.
  if (it.type === 'node' && it.node.sub && it.road) {
    if (!(await openSub(it.node.sub))) return;
    searchIndex ||= buildSearch();
    const found = searchIndex.find((x) => !x.main && x.type === 'road' && (x.road === it.road || x.edges.some((e) => e.roads?.includes(it.road))));
    if (found) return goTo(found);
    return;
  }
  if (it.type === 'road') {
    // A local road that "Hide local roads" leaves off: show local roads again.
    if (hideLocal && it.edges.some((e) => e.local)) setHideLocal(false);
    // The whole road is highlighted; the card is for its longest line.
    const pts = it.edges.flatMap(anchorPts);
    const e = it.edges.reduce((a, b) => (b.len > a.len ? b : a));
    if (!adding) picks = [];
    for (const x of it.edges) if (x !== e && !picks.some((p) => p.e === x)) picks.push({ type: 'edge', e: x, t: 0.5 });
    const had = picks.find((p) => p.e === e);
    if (had) { sel = had; writeHash(); showCard(); drawMarks(); } else select({ type: 'edge', e, t: 0.5 }, { reveal: false, add: true });
    fitTo([Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))], 0.15);
  } else {
    const had = adding && picks.find((p) => p.n === it.node);
    if (had) { had.road = it.road; sel = had; showCard(); drawMarks(); } else select({ type: 'node', n: it.node, road: it.road }, { reveal: false, add: adding });
    const r = it.node.kind === 'area' ? areaR(it.node, upp()) : 0;
    fitTo([it.node.x - r - 600, it.node.y - r - 600, it.node.x + r + 600, it.node.y + r + 600], 0.05);
  }
}
$('q').addEventListener('input', showResults);
$('q').addEventListener('focus', () => { if ($('q').value.trim()) showResults(); });
$('q').addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (!results.length) return;
    ev.preventDefault();
    resultOn = (resultOn + (ev.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
    markResult();
  } else if (ev.key === 'Enter') {
    if (results[resultOn]) goTo(results[resultOn]);
  } else if (ev.key === 'Escape') {
    ev.stopPropagation();
    $('q').value = ''; $('results').hidden = true; $('q').blur();
  }
});
// pointerdown, not click: the input's blur would hide the list before a click lands.
$('results').addEventListener('pointerdown', (ev) => {
  const li = ev.target.closest('li[data-i]');
  if (!li) return;
  ev.preventDefault();
  goTo(results[+li.dataset.i]);
});
$('q').addEventListener('blur', () => setTimeout(() => { $('results').hidden = true; }, 150));

$('hideLocal').checked = hideLocal;
function setHideLocal(v) {
  hideLocal = v;
  $('hideLocal').checked = v;
  try { localStorage.setItem('hideLocal', hideLocal ? '1' : '0'); } catch {}
  if (picks.some((p) => p.type === 'edge' && !shown(p.e))) {
    picks = picks.filter((p) => p.type !== 'edge' || shown(p.e));
    if ((sel?.type === 'edge' || sel?.type === 'node') && !picks.includes(sel)) sel = picks[0] || null;
    writeHash(); showCard();
  }
  if (M) { drawLines(); drawn.k = null; draw(); }
}
$('hideLocal').onchange = (ev) => setHideLocal(ev.target.checked);
$('btnLocate').onclick = startLocating;
// Closing a road's card clears the highlights; closing an emoji's card leaves it on the map.
$('cardClose').onclick = () => {
  if (sel?.type === 'me') stopLocating();
  else if (sel?.type === 'place') endPlacing();
  else if (sel?.type === 'pin') { sel = null; showCard(); drawMarks(); }
  else if (sel?.type === 'poi') { sel = null; writeHash(); showCard(); drawMarks(); }
  else select(null);
};
$('btnEmoji').onclick = startPlacing;
$('btnShare').onclick = share;
// About this map: the (i) by the OpenStreetMap credit. Closes on ×, Escape or a tap anywhere else.
function showInfo(on) {
  $('info').hidden = !on;
  $('btnInfo').setAttribute('aria-expanded', on);
}
$('btnInfo').onclick = () => showInfo($('info').hidden);
$('infoClose').onclick = () => showInfo(false);
document.addEventListener('pointerdown', (ev) => {
  if (!$('info').hidden && !ev.target.closest('#info, #btnInfo')) showInfo(false);
});
window.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || ev.target.matches?.('input')) return;
  if (!$('info').hidden) return showInfo(false);
  if (adding) { adding = false; showCard(); } else if (sel || !sub) $('cardClose').onclick(); else leaveSub();
});
window.addEventListener('resize', () => { drawn.k = null; draw(); });
window.addEventListener('hashchange', () => {
  if (!M) return;
  // Back from a neighborhood's map: the main map as it was.
  if (sub && !new URLSearchParams(location.hash.slice(1)).get('a')) return closeSub({ quiet: true });
  openHash();
});

// ---------- neighborhood maps ----------
// A neighborhood with a map of its own (laid out in the layout editor's ?area=) opens it over the main
// map: a panel on a wide screen, the whole screen on a phone. It's the same map code with the map, the
// view, the highlights and the emoji swapped for the neighborhood's; the main map's are kept to go back to.
let sub = null;   // { slug, label, main: the main map's state, pushed: opened with a history entry }
const ctxNow = () => ({ M, view: { ...view }, sel, picks, pins, adding, coarse, drawn, searchIndex });
function useCtx(c) {
  ({ M, sel, picks, pins, adding, coarse, drawn, searchIndex } = c);
  view = { ...c.view };
}
// The main map as it was, dimmed behind the panel (a copy: the live map is the panel).
function snapshot() {
  const b = $('backdrop');
  b.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.w * size()[1] / size()[0]}`);
  b.innerHTML = [...svg.children].map((g) => `<g>${g.innerHTML}</g>`).join('');
}
// The whole map, with room for the names past the arrows of the roads out ("to Hwy 17"). Their size on
// the map depends on the zoom, so it settles in a few rounds.
function fitWithTips() {
  fitTo(M.bounds, 0.05);
  for (let i = 0; i < 3; i++) {
    const k = upp();
    let [x0, y0, x1, y1] = M.bounds;
    for (const n of M.nodes) {
      if (n.kind !== 'exit' || !n.edges.length) continue;
      const [dx, dy] = tipDir(n), L = (textWidth(n.label || '', 12, 600) + 30) * k;
      x0 = Math.min(x0, n.x + dx * L); x1 = Math.max(x1, n.x + dx * L); y0 = Math.min(y0, n.y + dy * L); y1 = Math.max(y1, n.y + dy * L);
    }
    fitTo([x0, y0, x1, y1], 0.04);
  }
}
async function openSub(slug, { push = true } = {}) {
  if (sub?.slug === slug) return true;
  let m;
  try { m = prepare(await loadArea(slug)); } catch { toast('That neighborhood\'s map isn\'t available'); return false; }
  if (sub) closeSub({ quiet: true });
  if (sel?.type === 'place') endPlacing();
  $('results').hidden = true;
  snapshot();
  sub = { slug, label: m.area?.label || slug, main: ctxNow(), pushed: push };
  useCtx({ M: m, view, sel: null, picks: [], pins: [], adding: false, coarse: false, drawn: { k: null }, searchIndex: null });
  document.body.classList.add('sub');
  $('subName').textContent = sub.label;
  showCard();
  applyMorph(morph);
  fitWithTips();
  if (push) history.pushState({ sub: slug }, '', `#a=${slug}`); else writeHash();
  relocate();
  return true;
}
function closeSub({ quiet = false } = {}) {
  if (!sub) return;
  if (sel?.type === 'place') endPlacing();
  const main = sub.main;
  sub = null;
  document.body.classList.remove('sub');
  $('backdrop').innerHTML = '';
  useCtx(main);
  applyMorph(morph);
  showCard();
  if (!quiet) writeHash();
  relocate();
}
// The back button, ×, Escape and a click on the main map behind: like the browser's back button when the
// neighborhood was opened from here, so that and the phone's back gesture agree.
function leaveSub() {
  if (!sub) return;
  if (sub.pushed && history.state?.sub === sub.slug) history.back();
  else closeSub();
}
$('subBack').onclick = leaveSub;
$('subClose').onclick = leaveSub;
$('backdrop').addEventListener('click', leaveSub);
// Your location, on whichever map is showing.
function relocate() {
  if (me?.lat != null) onFix({ coords: { latitude: me.lat, longitude: me.lon, accuracy: me.acc } });
  else drawMarks();
}

// ---------- tools shell ----------
// In tools/index.html this page is the Preview tab: it follows where you are in the editors
// and reloads when they save.
const focusApi = {
  get() {
    if (!M) return null;
    const c = [view.x + view.w / 2, view.y + view.h / 2];
    let best = null;
    for (const e of M.edges) { const r = schemProject(e, c); if (!best || r.d < best.d) best = { e, ...r }; }
    const [lat, lon] = best ? M.U(realAt(best.e.real, best.t)) : M.U(c);
    return { lat, lon, mpp: upp(), node: sel?.type === 'node' && !sel.n.kind ? sel.n.id : null };
  },
  set(f) {
    if (!M || !f) return;
    let at = null;
    const n = f.node && M.nodes.find((x) => x.id === f.node);
    if (n) { at = [n.x, n.y]; select({ type: 'node', n }, { reveal: false }); }
    else if (f.lat != null) at = locate(f.lat, f.lon)?.at;
    if (!at) return;
    const [W, H] = size();
    if (f.mpp) view.w = clamp(W * f.mpp, minW(), maxW());
    view.x = at[0] - view.w / 2; view.y = at[1] - (view.w * H / W) / 2;
    draw();
  },
};

// A map's state carried over to a rebuilt map: the same lines, junctions and emoji, where they still exist.
function remapped(c, m) {
  const again = (p) => {
    if (p.type === 'edge') { const e = m.byKey.get(p.e.key); return e && { ...p, e }; }
    const n = m.nodes.find((x) => x.id === p.n.id);
    return n && { ...p, n };
  };
  const picks2 = c.picks.map(again).filter(Boolean);
  const pins2 = c.pins.map((q) => { const e = m.byKey.get(q.e.key); return e && Object.assign(q, { e }); }).filter(Boolean);
  const s = c.sel;
  const at = s?.type === 'place' && s.at && m.byKey.get(s.at.e.key);
  const poi2 = s?.type === 'poi' && m.places.find((q) => q.slug === s.q.slug);
  const sel2 = s?.type === 'poi' ? (poi2 ? { type: 'poi', q: poi2 } : null) : s?.type === 'me' ? s : s?.type === 'place' ? { type: 'place', at: at ? { ...s.at, e: at } : null } : s?.type === 'pin' ? (pins2.includes(s.pin) ? s : null)
    : picks2[Math.max(0, c.picks.indexOf(s))] || picks2[0] || null;
  return { ...c, M: m, picks: picks2, pins: pins2, sel: sel2, adding: picks2.length ? c.adding : false, searchIndex: null, drawn: { k: null } };
}
async function reload() {
  try {
    const main = prepare(await loadData());
    if (sub) {
      sub.main = remapped(sub.main, main);
      if (!areaMaps[sub.slug]) { closeSub(); return; }
      useCtx(remapped(ctxNow(), prepare(areaMaps[sub.slug])));
    } else useCtx(remapped(ctxNow(), main));
    applyMorph(morph);
    writeHash(); showCard(); drawMarks();
    relocate();
  } catch (e) { console.warn('reload failed', e); }
}
if (LIVE && 'BroadcastChannel' in window) {
  let t;
  new BroadcastChannel('subway').onmessage = (ev) => {
    if (ev.data?.type === 'layout-saved' || ev.data?.type === 'graph-saved') { clearTimeout(t); t = setTimeout(reload, 400); }
  };
}

// ---------- boot ----------
(async () => {
  try {
    M = prepare(await loadData());
  } catch (e) {
    $('loading').textContent = `Couldn't load the map: ${e.message}`;
    return;
  }
  $('loading').remove();
  applyMorph(1);
  // A link to a neighborhood's map: the main map behind it, whole.
  if (new URLSearchParams(location.hash.slice(1)).has('a')) fitTo(M.bounds);
  if (!openHash()) fitTo(M.bounds);
  window.subwayFocus = focusApi;   // the tools shell waits for this
  window.subwayMap = { get M() { return M; }, locate, select, get view() { return view; }, get hidden() { return { stubs: new Set([...stubEdges()].filter((e) => !stubShow.has(e))), bunched: bunchHide }; } };
})();
