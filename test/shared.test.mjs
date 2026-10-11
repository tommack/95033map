// The drawing and geometry shared by the public map and the layout editor (site/shared.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  segProject, anchorsAt, anchorsProject, chevrons, tipText, placeSpot, placeBadge, bunchSideRoads, PLACE_R, PLACE_GAP,
} from '../site/shared.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('segProject clamps to the segment', () => {
  assert.deepEqual(segProject([0, 0], [10, 0], [5, 3]), { s: 0.5, d: 3 });
  assert.deepEqual(segProject([0, 0], [10, 0], [-4, 3]), { s: 0, d: 5 });
  assert.deepEqual(segProject([2, 2], [2, 2], [2, 5]), { s: 0, d: 3 });   // a point
});

test('anchorsAt and anchorsProject are inverses along a bent line', () => {
  // t isn't proportional to drawn length: the first leg covers a quarter of the real road.
  const an = [{ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 0.25 }, { x: 100, y: 100, t: 1 }];
  assert.deepEqual(anchorsAt(an, 0.125), [50, 0]);
  assert.deepEqual(anchorsAt(an, 0.625), [100, 50]);
  for (const t of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
    const r = anchorsProject(an, anchorsAt(an, t));
    near(r.t, t); near(r.d, 0);
  }
  assert.equal(anchorsProject(an, [120, 60]).i, 1);
});

test('chevrons scale with the zoom', () => {
  const a = chevrons(4, 1), b = chevrons(4, 2);
  near(b.extent, a.extent * 2);
  assert.ok(chevrons(7, 1).extent > a.extent, 'wider lines get bigger chevrons');
});

test('tipText places a label beside or past a line end, unless it would overlap', () => {
  const placed = [];
  const right = tipText([0, 0], [1, 0], 5, ['Hwy 9', ['to Saratoga', 'fill="gray"']], 10, 50, placed, 'fill="red"');
  assert.match(right, /text-anchor="start"/);
  assert.match(right, /<tspan[^>]*>Hwy 9<\/tspan><tspan[^>]* fill="gray">to Saratoga<\/tspan>/);
  assert.equal(placed.length, 1);
  assert.equal(tipText([0, 0], [1, 0], 5, ['Again'], 10, 50, placed, ''), '', 'overlaps the first');
  assert.match(tipText([0, 100], [0, -1], 5, ['Up'], 10, 20, placed, ''), /text-anchor="middle"/);
});

test('escapes text in labels', () => {
  assert.match(tipText([0, 0], [1, 0], 5, ['<b>&'], 10, 10, [], ''), /&lt;b&gt;&amp;/);
});

test('placeSpot: the normal points to the place\'s side', () => {
  const line = (t) => [t * 100, 0];   // left to right, y down
  assert.deepEqual(placeSpot(line, 0.5, 1).at, [50, 0]);
  near(placeSpot(line, 0.5, 1).n[1], 1);    // side 1: below (left of the direction of travel, y down)
  near(placeSpot(line, 0.5, -1).n[1], -1);
  const { r, c } = placeBadge(placeSpot(line, 0.5, 1), 4, 2);
  assert.equal(r, PLACE_R * 2);
  near(c[1], (4 / 2 + PLACE_GAP + PLACE_R) * 2);
});

// A straight road along y = 0 through junctions 0..n-1, 10 apart, each with side roads given as
// [junction, side] (side -1: up, 1: down).
function road(n, sides) {
  const J = Array.from({ length: n }, (_, i) => ({ id: i, x: i * 10, y: 0 }));
  const edges = [];
  for (let i = 1; i < n; i++) edges.push({ a: J[i - 1], b: J[i] });
  const live = new Map();
  for (const [i, s] of sides) {
    const t = { id: `t${i}${s}`, x: i * 10, y: s * 10 }, e = { a: J[i], b: t };
    if (!live.has(J[i])) live.set(J[i], { leaves: [] });
    live.get(J[i]).leaves.push({ e, t });
  }
  for (const [j, v] of live) v.carriers = edges.filter((e) => e.a === j || e.b === j);
  for (const [j, v] of live) if (v.carriers.length !== 2) live.delete(j);
  const g = {
    pos: (n) => [n.x, n.y],
    other: (e, n) => (e.a === n ? e.b : e.a),
    ptsFrom: (e, n) => (e.a === n ? [[e.a.x, e.a.y], [e.b.x, e.b.y]] : [[e.b.x, e.b.y], [e.a.x, e.a.y]]),
    stop: () => false,
    next: (n, e) => edges.filter((x) => x !== e && (x.a === n || x.b === n)),
  };
  return { J, live, g };
}

test('bunchSideRoads: close side roads on one side become one branch', () => {
  const { J, live, g } = road(6, [[1, 1], [2, 1], [3, 1]]);
  const { bunches, plain } = bunchSideRoads(live, g, 15);
  assert.equal(bunches.length, 1);
  assert.equal(bunches[0].j, J[2], 'off the middle junction');
  assert.deepEqual(bunches[0].dir.map((v) => Math.round(v) + 0), [0, 1], 'on their side');
  assert.equal(bunches[0].leaves.length, 3);
  assert.deepEqual([...plain], [J[1], J[3]]);
});

test('bunchSideRoads: each side gets its own branch; a lone side road stays', () => {
  const { live, g } = road(6, [[1, 1], [2, 1], [3, -1]]);
  const { bunches } = bunchSideRoads(live, g, 15);
  assert.equal(bunches.length, 1);
  assert.deepEqual(bunches[0].dir.map((v) => Math.round(v) + 0), [0, 1]);
  assert.equal(bunches[0].leaves.length, 2);
});

test('bunchSideRoads: nothing bunches when the junctions are far apart on screen', () => {
  const { live, g } = road(6, [[1, 1], [2, 1], [3, 1]]);
  assert.equal(bunchSideRoads(live, g, 9).bunches.length, 0);
});
