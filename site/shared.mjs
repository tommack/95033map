// Drawing and geometry shared by the public map (site/app.js) and the layout editor
// (tools/layout-editor/editor.js), so the editor shows what the map will. Pure functions only:
// each side keeps its own data model and passes in what these need.
//
// Coordinates are map units (meters in the layout's plane, y down); k is map units per screen pixel.

// Line widths in pixels for each tier of road (1 highway, 2 main road, 3 secondary road, 4 connector,
// 5 back road, 6 local road); the first three are colored, the rest MINOR gray.
export const TIER_W = [7, 5.5, 4.2, 3, 2.6, 2.6];
export const MINOR = '#a3a29b';
// Side roads closer together than BUNCH_PX on screen are bunched into a branch BUNCH_LEN long.
export const BUNCH_PX = 24, BUNCH_LEN = 20;
// A place's badge: radius, and its gap from the line's edge, in pixels.
export const PLACE_R = 9, PLACE_GAP = 6;

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a, b, m) => [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m];
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const fmt = (n) => n.toFixed(1);
export const unit = (a, b) => { const L = dist(a, b) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; };
export const pathLen = (pts) => pts.reduce((a, q, i) => a + (i ? dist(pts[i - 1], q) : 0), 0);
// Do two boxes ({ x0, y0, x1, y1 }) overlap, or a box and any in a list?
export const overlaps = (b, list) => list.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);

// ---------- lines ----------
// Closest point to p on segment a–b: s is the fraction along it, d the distance.
export function segProject(a, b, p) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const s = L2 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2, 0, 1) : 0;
  return { s, d: Math.hypot(a[0] + s * dx - p[0], a[1] + s * dy - p[1]) };
}
// A line's schematic anchors are { x, y, t }, t the fraction along the real road. The point at t
// (linear between anchors), and back: the closest point to p, as { t, d, i } (i: segment index).
export function anchorsAt(an, t) {
  for (let i = 1; i < an.length; i++) {
    if (t <= an[i].t || i === an.length - 1) {
      const s = (t - an[i - 1].t) / ((an[i].t - an[i - 1].t) || 1);
      return lerp([an[i - 1].x, an[i - 1].y], [an[i].x, an[i].y], clamp(s, 0, 1));
    }
  }
}
export function anchorsProject(an, p) {
  let best = { t: 0, d: Infinity, i: 0 };
  for (let i = 1; i < an.length; i++) {
    const A = an[i - 1], B = an[i], r = segProject([A.x, A.y], [B.x, B.y], p);
    if (r.d < best.d) best = { t: A.t + r.s * (B.t - A.t), d: r.d, i: i - 1 };
  }
  return best;
}

// ---------- line ends ----------
// Two chevrons past the end of a line that runs off the map (or into a map exit). w: the line's
// width in pixels.
export function chevrons(w, k) {
  w *= k;
  const h = Math.max(w * 1.2, 6 * k), a = h * 0.9;
  const gap = Math.max(w * 0.6, 3.5 * k) + a, sp = Math.max(w * 1.1, 6 * k);
  return { h, a, gap, sp, sw: Math.max(w * 0.6, 2.2 * k), extent: gap + sp };
}
export function chevronSvg(x, y, ux, uy, c, col) {
  let d = '';
  for (let i = 0; i < 2; i++) {
    const cx = x + ux * (c.gap + i * c.sp), cy = y + uy * (c.gap + i * c.sp), bx = cx - ux * c.a, by = cy - uy * c.a;
    d += `<path d="M${fmt(bx - uy * c.h)} ${fmt(by + ux * c.h)}L${fmt(cx)} ${fmt(cy)}L${fmt(bx + uy * c.h)} ${fmt(by - ux * c.h)}" stroke-opacity="${i ? 0.5 : 1}"/>`;
  }
  return `<g fill="none" stroke="${col}" stroke-width="${fmt(c.sw)}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
}
// Text just past a line's end at tip, heading [dx, dy]: beside it for a line ending sideways, above or
// below for one ending up or down. lines: strings or [text, extra tspan attributes]; tw: the widest
// line's width. Returns '' (and places nothing) if it would overlap a box in placed.
export function tipText(tip, [dx, dy], gap, lines, fs, tw, placed, attrs) {
  lines = lines.map((l) => (Array.isArray(l) ? l : [l, '']));
  const lh = fs * 1.2, th = lh * lines.length;
  let x = tip[0] + dx * gap, y = tip[1] + dy * gap, anchor = 'middle', box;
  if (Math.abs(dx) > 0.38) {
    anchor = dx > 0 ? 'start' : 'end';
    box = { x0: dx > 0 ? x : x - tw, x1: dx > 0 ? x + tw : x, y0: y - th / 2, y1: y + th / 2 };
  } else {
    y += ((dy > 0 ? 1 : -1) * th) / 2;
    box = { x0: x - tw / 2, x1: x + tw / 2, y0: y - th / 2, y1: y + th / 2 };
  }
  if (overlaps(box, placed)) return '';
  placed.push(box);
  const y0 = y - th / 2 + lh / 2;
  return `<text text-anchor="${anchor}" font-size="${fs}" ${attrs}>` +
    lines.map(([l, a], i) => `<tspan x="${fmt(x)}" y="${fmt(y0 + i * lh)}" dy="0.35em"${a ? ' ' + a : ''}>${esc(l)}</tspan>`).join('') + '</text>';
}

// ---------- neighborhoods and places ----------
// A neighborhood: a big circle with three dots for its streets (left off when its name is inside).
export function areaSvg(x, y, r, k, { stroke = 'var(--node-stroke)', dots = true } = {}) {
  const d = r * 0.42, dot = (a) => `<circle cx="${fmt(x + d * Math.cos(a))}" cy="${fmt(y + d * Math.sin(a))}" r="${1.7 * k * Math.sqrt(r / (11 * k))}" fill="${stroke}"/>`;
  return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" fill="var(--node-fill)" stroke="${stroke}" stroke-width="${2.5 * k}"/>` +
    (dots ? [-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6].map(dot).join('') : '');
}
// Where a place on a line is: the point at t (pointAt(t) gives the line's drawn points), and the unit
// normal toward the side it's on (side: +1 or -1, the sign of the cross product with y down).
export function placeSpot(pointAt, t, side) {
  const a = pointAt(Math.max(0, t - 0.01)), b = pointAt(Math.min(1, t + 0.01)), L = dist(a, b) || 1;
  return { at: pointAt(t), n: [-(b[1] - a[1]) / L * side, (b[0] - a[0]) / L * side] };
}

// Its badge's center, beside the line (lineW: the line's width in pixels) on the place's side.
export function placeBadge({ at, n }, lineW, k) {
  const off = (lineW / 2 + PLACE_GAP + PLACE_R) * k;
  return { r: PLACE_R * k, c: [at[0] + n[0] * off, at[1] + n[1] * off] };
}

// ---------- side roads bunched together ----------
// A bunch's branch: from junction at, heading dir, BUNCH_LEN pixels long, ending in a bar.
export function bunchBranch(at, [ux, uy], k) {
  const x = at[0] + ux * BUNCH_LEN * k, y = at[1] + uy * BUNCH_LEN * k, w = TIER_W[3] * k, H = Math.max(w * 1.5, 6 * k);
  return {
    tip: [x, y],
    svg: `<path d="M${fmt(at[0])} ${fmt(at[1])}L${fmt(x)} ${fmt(y)}" stroke="${MINOR}" stroke-width="${w}"/>` +
      `<path d="M${fmt(x - uy * H)} ${fmt(y + ux * H)}L${fmt(x + uy * H)} ${fmt(y - ux * H)}" stroke="${MINOR}" stroke-width="${w}" stroke-linecap="round"/>`,
  };
}

// Dead ends (and collapsed branches) off one road, at junctions closer together along it than maxLen,
// are drawn as one branch each side of the road. A side with just one road keeps it as it is.
//
// live: Map junction -> { leaves: [{ e, t }], carriers: [e, e] }, the junctions to consider: each has
//   side roads (line e to tip t) and exactly two lines of the road carrying on past it.
// g: how to get around the caller's graph, for junctions n and lines e:
//   pos(n) -> [x, y];  ptsFrom(e, n) -> e's drawn points starting from n;  other(e, n) -> e's other end;
//   stop(n) -> true where a walk along the road must stop (a line end, a neighborhood…);
//   next(n, e) -> the lines out of n other than e that a walk could carry on along.
// Returns { bunches: [{ j, dir, leaves, chain, gap }], plain: Set of junctions left with nothing drawn
// off them, to draw without a circle }. j: the junction the branch comes off, dir: its direction,
// gap: the shortest distance between two of the chain's junctions.
export function bunchSideRoads(live, g, maxLen) {
  const bunches = [], plain = new Set();
  // Neighbors along the road, through junctions with nothing else drawn off them.
  const links = new Map([...live.keys()].map((j) => [j, []]));
  for (const [j, v] of live) {
    for (let c of v.carriers) {
      let n = j, pts = [];
      for (let guard = 0; guard < 500; guard++) {
        const q = g.ptsFrom(c, n);
        pts = pts.length ? pts.concat(q.slice(1)) : q;
        n = g.other(c, n);
        if (live.has(n) || g.stop(n)) break;
        const next = g.next(n, c);
        if (next.length !== 1) break;
        c = next[0];
      }
      if (live.has(n) && n !== j && pathLen(pts) < maxLen) links.get(j).push({ n, pts });
    }
  }
  const seen = new Set();
  for (const j of live.keys()) {
    if (seen.has(j) || !links.get(j).length) continue;
    // Walk to one end of the chain, then along it.
    let start = j, prev = null;
    for (const guard = new Set([j]); ;) {
      const l = links.get(start).find((x) => x.n !== prev && !guard.has(x.n));
      if (!l) break;
      prev = start; start = l.n; guard.add(start);
    }
    const chain = [start], at = [0];
    let len = 0;
    for (let cur = start, back = null; ;) {
      seen.add(cur);
      const l = links.get(cur).find((x) => x.n !== back && !seen.has(x.n));
      if (!l) break;
      len += pathLen(l.pts); at.push(len);
      back = cur; cur = l.n; chain.push(cur);
    }
    if (chain.length < 2) continue;
    // Names read along the road, left to right (top to bottom for one running up and down).
    const a = g.pos(chain[0]), z = g.pos(chain[chain.length - 1]);
    if (Math.abs(z[0] - a[0]) >= Math.abs(z[1] - a[1]) ? z[0] < a[0] : z[1] < a[1]) { chain.reverse(); at.reverse(); at.forEach((d, i) => (at[i] = len - d)); }
    // Each side of the road gets its own branch, so side roads stay on the side they leave from. It
    // comes off the junction nearest the middle of theirs.
    const P = chain.map(g.pos);
    const nrm = P.map((_, i) => { const [tx, ty] = unit(P[Math.max(0, i - 1)], P[Math.min(P.length - 1, i + 1)]); return [-ty, tx]; });
    const sideOf = (l, i) => { const q = g.ptsFrom(l.e, chain[i]), d = unit(q[0], q[1]); return d[0] * nrm[i][0] + d[1] * nrm[i][1] >= 0 ? 1 : -1; };
    const gap = Math.min(...at.slice(1).map((d, i) => Math.abs(d - at[i]))), anchors = new Set(), done = new Set();
    for (const sgn of [-1, 1]) {
      const own = chain.map((n, i) => live.get(n).leaves.filter((l) => sideOf(l, i) === sgn));
      const leaves = own.flat();
      if (leaves.length < 2) continue;
      const idx = own.map((x, i) => (x.length ? i : -1)).filter((i) => i >= 0), mid = (at[idx[0]] + at[idx[idx.length - 1]]) / 2;
      const mi = idx.reduce((b, i) => (Math.abs(at[i] - mid) < Math.abs(at[b] - mid) ? i : b));
      bunches.push({ j: chain[mi], dir: [nrm[mi][0] * sgn, nrm[mi][1] * sgn], leaves, chain, gap });
      anchors.add(chain[mi]);
      for (const l of leaves) done.add(l.e);
    }
    for (const n of chain) if (!anchors.has(n) && live.get(n).leaves.every((l) => done.has(l.e))) plain.add(n);
  }
  return { bunches, plain };
}
