# Subway map of 95033

A simplified "subway style" map of the 95033 area (Santa Cruz Mountains), with a
reversible mapping back to real OpenStreetMap geometry.

## Map region

The 95033 ZCTA (Census boundary), extended south so that Hwy 1 is the map's
southern edge, plus a ~1 km margin so through roads aren't cut at notches in the
zip outline. See `scripts/prep.mjs` (`EXT_WEST` / `EXT_EAST` narrow the southern
extension, which currently spans the ZCTA's full width, Felton to Aptos).

## Data

| File | What |
|---|---|
| `data/zcta95033.geojson` | ZCTA boundary from Census TIGERweb |
| `data/osm_raw.json`, `data/osm_raw_south.json` | Raw Overpass road extracts (ZCTA bbox, and the strip down to Hwy 1). Not in git (80 MB): only needed to rebuild `roads.json`, from an Overpass `highway` query for each area with `out body; >; out skel qt;` |
| `data/roads.json` | Clipped, compact road network used by the tools (`node scripts/prep.mjs`) |
| `data/places-osm.json` | Named places (shops, schools, fire stations, parks…, and named school, church and other civic buildings; not toilets, parking and the like) inside the map region, for the layout editor's *Places* search (`node scripts/fetch-places.mjs`; Overpass is often busy, and some mirrors are months behind, so it reports each server's data date and keeps the freshest; `--from saved.json` takes a response saved earlier) |

## Getting started

Needs Node 22 or later. Nothing needs installing to run the tools or build the map; `npm install` brings
in ESLint, for `npm run lint`.

```sh
npm run dev      # node scripts/server.mjs, then open http://localhost:8765/tools/
npm run build    # node scripts/build-site.mjs: the public map's data, into site/data/
npm test         # unit tests, and a build of the committed data (test/)
npm run lint     # ESLint
npm run deploy   # build, then npx wrangler deploy (Cloudflare; see wrangler.jsonc)
```

### Code layout

| Where | What |
|---|---|
| `tools/index.html` | The tools shell: the tabs |
| `tools/node-picker/` | Node picker: `index.html`, `picker.js`, `style.css` (and Leaflet in `vendor/`) |
| `tools/layout-editor/` | Layout editor: `index.html`, `editor.js`, `style.css` |
| `tools/place-kinds.mjs` | Which OpenStreetMap places are offered, and their icons and labels |
| `site/` | The public map: `index.html`, `app.js`, `style.css` |
| `site/build-map.mjs` | Builds the public map's data from the editors' files (in Node and, for the preview, the browser) |
| `site/shared.mjs` | Drawing and geometry the public map and the layout editor share, so the editor shows what the map will |
| `scripts/` | Dev server, build, and data prep and download |
| `test/` | `node --test` tests |

The editing state (`data/graph.json`, `data/layout*.json`) and what the tools derive from it are
committed, so a fresh clone opens on the current map. `site/data/` is built, not committed.

## Tools

```sh
node scripts/server.mjs
open http://localhost:8765/tools/
```

`tools/` shows the node picker, the layout editor and a preview of the public map as tabs.
Switching tabs keeps your place: the same spot (and the selected junction) is shown in the
tab you switch to. <kbd>`</kbd> flips between the last two tabs, <kbd>Alt</kbd>+<kbd>1</kbd>–<kbd>3</kbd>
picks one. All three zoom the same way with the scroll wheel, the usual way round for maps. When the picker saves, the layout editor and preview reload the graph by
themselves. Each tool also works on its own (`tools/node-picker/`, `tools/layout-editor/`).

## Node picker

A tool for choosing which real junctions become nodes of the subway graph.

- Click a junction to make it a node. Shift-click more junctions to add them to the
  same node (interchanges).
- Edges are derived automatically by walking the roads between nodes. Magenta
  dotted roads end at a junction you haven't picked yet. A walk follows a road through
  unpicked junctions while it keeps its name *or its route number*, so CA 9 carries on
  where it becomes River St.
- **Corridors**: divided highways (Hwy 17, Hwy 1) are two one-way roads in OSM.
  Adding one as a corridor (`+ CA 17`) draws it as a single line; any node that
  touches it, directly or through ramps, becomes a station on it. Per-direction
  access (on/off, NB/SB) is inferred from OSM one-way tags and can be overridden in
  the node's popup. Stations that aren't full access get a badge ("NB only").

## Layout editor

Arranges the picked graph into a schematic. Reads `data/graph-derived.json`, which
the node picker rewrites on every save (an open editor picks up the change by itself).

- The first time it opens, it starts from real geography, adds bends at obvious
  hairpins, and runs **Straighten**: lines are pulled onto 0°/45°/90° directions and
  toward more even lengths (the *True lengths ↔ Even* slider).
- Drag nodes to arrange them. Drags snap to 45° lines through neighboring nodes,
  then to the grid (`Alt` = no snapping). Set *Angles* to 22.5° to snap to the in-between
  directions too; *Show off-22.5°* and the count then check against those. Straighten still
  pulls unpinned lines to 45°, but leaves dragged (pinned) nodes where they are. A dragged node is **pinned** and Straighten
  leaves it where you put it, so you can alternate hand-placing and straightening.
- **Moving a region**: click *Select area* (top left of the map) and drag a box, or Shift-drag at
  any time. The selected junctions get a shaded area; drag it (or any of them) to move them all,
  along with the bends between them.
- **Options popup**: click any junction, line, stub end, map exit or bend and its options
  open in a popup beside it (pin, hide tails, map exit, branch, major road, color, label,
  bends). Shift-click several junctions for the group options. `Esc` or × closes it.
- **Bends**: double-click a line to add one. It's tied to a specific point on the
  real road (the sharpest turn in that stretch), so a hairpin can be drawn as a V.
  Double-click a bend or press `Delete` to remove it.
- **Loops**: a road that comes back round to the junction it left (Amber Ridge Loop) is drawn as a
  ring hanging off that junction, going round the same way as the real road. The node picker finds
  these by itself. Click the ring to choose which side of the junction it's on and how big it is, or to draw it as
  *a road* instead: a straight line out from the junction, like any other dead end.
- **Round bends**: tick *Round the bends* on a line to draw each of its bends as a curve instead of a
  corner, as big as fits. Two bends close together, with the line doubling back between them, make a
  horseshoe (the hairpin on Hwy 17 between Summit Rd and Idylwild Rd). Ticking it pins the line's bends
  so Straighten leaves the curve alone.
- **Labels** (Roads / Junctions / Both): road names run along the lines, one per
  straight run (consecutive segments continuing in the same direction through junctions).
  Roads that end at an unpicked junction are short dotted stubs with a small label at
  the tip; **Shorten stubs** redraws them all at the standard length.
- **Lines**: an edge is drawn as the road it shares with the most other edges. An edge on a
  numbered route whose street name changes along the way is named after the route (CA 9:
  Highway 9 → River St is "Hwy 9"); where a route has one street name it keeps it (CA 35 is
  still Summit Rd and Skyline Blvd). To draw a road as part of another line anyway (Central Ave
  as Hwy 9 through Boulder Creek), click it and pick the line under *Draw as part of another line*,
  either for *Just this stretch* (River St north of Hwy 1 as Hwy 9, south of it still River St)
  or for *All of* the road.
- **Tiers**: every road is in one of six tiers, each with its own line width:
  1. *Highway* (thickest): corridors (Hwy 17, Hwy 1) by default
  2. *Main road*: colored, thicker, larger labels. By default a road spanning 3+ edges and 5+ km
  3. *Secondary road*: colored, a little thinner. Only roads you put there
  4. *Connector*: thin gray roads that go somewhere
  5. *Back road*: roads that go through, but only in the literal sense (sketchy, but maybe a way out;
     local roads are no use in an emergency): narrow and winding, for the
     people who live along them and as a way out in an emergency (Morrell Rd, Jarvis Rd). Only set by
     hand. The public map's card says so
  6. *Local road*: roads only the people who live on them use. Automatically, stretches
     that don't go anywhere (dead ends, and loops back to the same junction, see *Zoom levels*);
     put others here by hand (Timber Lodge Rd)

  Tiers 1–3 are the colored lines; 4 is a thin gray line; 5 (back roads) are gray dashes and 6 (local
  roads) gray dots, like stubs: dotted means it goes nowhere. Both hide when zoomed out. Click a line to put its road in another tier (or back to
  *Automatic*), and set its color and the label shown on the map. The *Lines* list in the sidebar
  shows the highways, main roads and anything set by hand: ✕ moves a colored road down to a
  connector, or puts a hand-set road back to automatic; *Make another road a main road…* promotes one.
  A single stretch can have its own tier (*Tier, for just this stretch* in the line's popup), for a road
  that matters on one side of a junction and not the other: Aldercroft Heights Rd is a connector into
  Lexington Hills from Old Santa Cruz Hwy, and a local road on the far side.
- **Private roads**: tick *Private road* on a line for a road that's drawn but not open to the public
  (Ida Dr). It keeps its tier, so its width and zoom behavior stay the same, but it's drawn as red dashes
  (at least connector width). On the public map, its card says "Private road · Not open to the public".
  They're listed under *Lines*, and ✕ there opens one up again. OpenStreetMap's access tags aren't
  used: they mark dozens of drawn roads private, and they mark Ida Dr as permissive.
- **Map exits**: select a junction and *Make it a map exit* (or select several and
  *Collapse into map exit*). Those junctions disappear, and every road into them ends the way a road
  that runs off the map does: chevrons, the road's name and a label ("to Hwy 1"; click the chevrons
  to edit it). Use it for
  areas you don't want to map, like Scotts Valley, Santa Cruz or Hwy 1 itself.
- **Roads that continue off the map**: an open end on a highway or major road whose route
  carries on past it (Hwy 1 both ways, Hwy 17 north, CA 9 to Saratoga) is drawn solid,
  ending in two chevrons and the road's name. The node picker works out whether a route
  carries on from the OSM data, so Hwy 17 stops at Hwy 1. Click an end to turn this on
  or off by hand and to add where it goes ("to Santa Cruz"). Other open ends stay thin
  dotted stubs.
- **Hidden tails**: click a junction and *Hide* any of the tails listed in its popup (or
  click the stub itself and *Hide this tail*) to stop drawing a
  side street that's only there because of a junction you picked (Plymouth St at Hwy 17 /
  Ocean St). Hidden tails are listed under *Lines*, with *Show* to bring one back. A
  location on a hidden tail shows on the nearest road that is drawn.
- **Junction circles**: a junction where one road just carries on (the same road both ways, e.g.
  once its side roads are hidden tails) is drawn as a plain point on the road, with no circle. Where
  the road changes name (Soquel San Jose Rd to Porter St) the circle stays. A junction's popup can
  show or hide its circle by hand.
- **Road closures**: two dead ends that are really one road that doesn't go through (the
  washed-out Redwood Lodge Rd bridge) can be joined into one junction drawn as a no-entry
  sign. Click one dead end and *Road closed between here and the … end* (offered when
  another dead end is within 300 m), or Shift-click both and *Join as a road closure*.
  Click the sign to change its label ("Bridge out") or *Remove closure*.
  The public map shows the label only when zoomed in past the local roads, and leaves the sign off when
  all its roads are.
- **Branches**: a cluster of side roads drawn as one stub off the main road, labeled with
  their names. Click one of its lines, *Select the branch beyond here* (it selects the
  cluster up to the nearest major roads; Shift-click to adjust), then *Collapse into branch*.
- **Neighborhoods**: a tangle of streets with several ways through (Redwood Estates) can be drawn
  as one junction. Select its junctions (*Select area*), then *Collapse into neighborhood* and give it
  a name. It's drawn as a large circle with three dots, and the name goes on the side away from its roads.
  *Size* in its popup sets how big the circle is on the map, 70 m of radius per step (Redwood Estates is
  6×, 420 m). It zooms with the roads, so it shrinks when you zoom out, but it never gets smaller than a
  big junction circle.
  Every road in or out of it stays a line ending at the circle (one per road per neighboring junction),
  so you can still see the way from Hwy 17 to Summit Rd. The roads inside aren't drawn, but they're
  listed in its popup and on the public map's card, ready for a road search. On the public map, a
  location inside it shows at the circle as "In Redwood Estates", with the street you're on.
  Its name is in small spaced capitals, inside the circle when it fits, otherwise on a free side, and
  left off when there's no room. It's named only once the circle is drawn at its real size, so as you
  zoom in, bigger neighborhoods are named first.
  Junction order is checked by where each road leads. To add junctions to one, select it and Shift-click
  them (or Shift-drag a box), then *Add … to Redwood Estates*; it keeps its name, size and place. *Expand*
  brings the junctions back.
  A junction picked later inside the outline of a neighborhood's junctions joins it by itself (not one on a
  highway, or in another group). Its popup lists them under *Junctions inside it, added automatically*, each
  with *Leave out*.
- **Neighborhood maps**: *Edit its own map* in a neighborhood's popup opens this editor on just its
  streets (`?area=g35`): its junctions and the roads between them, each road out ending in a map exit named
  after the road it leads to ("to Hwy 17"). Everything works as on the main map, and it's saved on its own
  (`data/layout-g35.json`), so the main layout is never touched; the first time, it starts from the
  geography with the roads' styles and the settings from the main map. *← Main layout* goes back. On the
  public map, the neighborhood's card then opens it. A neighborhood's map depends on the graph and on
  which junctions the neighborhood has, so whenever the main layout is saved after either changes, the
  editor updates each neighborhood map in the background ("Updating the Redwood Estates map…" in the
  status): it's opened out of sight, brought up to date (new junctions placed, nothing moved) and saved.
- **Places** (sidebar): shops, schools and the like, each on a road. Search the OpenStreetMap places by
  name and click one to add it: it goes on the road its address names if that's near, otherwise the
  nearest drawn road, on the side the real place is. *Place by hand*, then click a road, adds one that
  isn't in OpenStreetMap. Drag a place's badge along its road or onto another one. Its popup changes the
  name, icon and type, moves it to the *Other side* of the road, puts an OpenStreetMap place back on its nearest road, or removes it (or press
  <kbd>Delete</kbd>). Places are saved with the layout they're added in, so a neighborhood's own map has
  its own. In the tools shell, the **Nodes** tab also shows the OpenStreetMap places on the real map
  (zoomed in; the *Places* button hides them): click one to add it to whichever map the Layout tab has
  open, or to show or remove it once it's on (blue ring).
- Collapsed parts keep their real geometry: a location on a hidden road shows at the map exit
  or stub it's behind. Select a map exit or stub and click *Expand* to bring them back.
- **Zoom levels**: the public map leaves out tiers 5 and 6 (back roads and local roads) when it's zoomed out
  (set under *Zoom levels* in the sidebar; *Use this zoom* takes the current view). That's open
  stubs, collapsed branches, and minor roads whose far end has only dead ends, along with their
  junction circles and the circle of any junction left joining just two lines of the same road (where the
  name changes, East Zayante Rd to Upper Zayante Rd, it stays), or a highway interchange
  left with no side road (Santa Cruz Ridge Rd at Hwy 17). Roads set to
  *Back road* or *Local road* by hand go too, and roads set by hand to a higher tier stay, as do roads that continue
  off the map, exits and closures. Zoomed out past that point, the
  editor draws them faintly so you can see what goes.
  Connector roads straight into a neighborhood go too (Bayview Dr and Virdelle Dr into Redwood Estates).
  A neighborhood's roads in that go (Chemeketa Park's three, which all come off Old Santa Cruz Hwy)
  get one solid gray line instead, to the road they lead to (one line for each road they lead to),
  along the real road nearest the middle of them. It shows on the public map whenever the
  real ones to that road don't (zoomed out, or with *Hide local roads*); tapping it opens the neighborhood.
  The editor doesn't draw it.
- **Side roads bunched together**: before that, as you zoom out, dead ends and collapsed branches off
  one road whose junctions come closer than 24 px on screen are drawn as one branch each side of the
  road, listing their names (up to six; then "+ N more"), off the junction nearest the middle of them.
  The other junctions lose their circles; a side with only one road keeps it. On the public map, tapping
  the branch zooms in until they come apart. The editor draws the side roads faintly underneath.
- **Sides of the road**: a branch must stay on the same side of a road as in reality.
  Two checks enforce that, listed in the sidebar and circled in red on the map:
  - *Junction order*: the lines at each junction must leave in the same circular order
    as the real roads (measured where each road leaves a ~60 m circle round the junction).
    Two lines from one junction that cross each other on a real bridge (Hwy 1 hooking over
    Hwy 17 at the Fishhook) can go either way round, so they're left out of this check.
  - *Crossings*: lines mustn't cross unless the real roads do (bridges/tunnels are found
    from the real geometry and allowed).

  Drags that would create a new problem are refused (*Block moves that swap sides*).
  Straighten keeps the real order at every junction, never moves a line across another,
  and adds a bend where a line's two ends need different directions. **Fix with bends**
  repairs existing problems where it can (a misplaced stub is redrawn on the right side).
- The *Geography ↔ Schematic* slider morphs between the real map and the layout. The
  small map shows the same spot on both as you hover, and **Show my location**
  snaps your GPS position onto the schematic.

How the transform works: every edge keeps its real road geometry. A bend records `t`, the
fraction of the way along the real road, plus its schematic position. A point at `t` on
the real road maps linearly between the anchors either side of it (node, bends, node),
and the inverse does the same in reverse. `data/layout-derived.json` has those anchors
per edge, with `t` measured along the edge's `coords` in `graph-derived.json`.

### Saving

`scripts/server.mjs` (no dependencies) serves the project and autosaves every edit
in both tools:

| File | What |
|---|---|
| `data/graph.json` | Editing state, the source of truth. Small and diff-friendly. |
| `data/graph-derived.json` | Derived nodes, edges, corridor spines and station access, rewritten on every save |
| `data/layout.json` | Layout editor state: node positions, pins, bends, road colors |
| `data/layout-derived.json` | Per-edge anchors for the real ↔ schematic transform, styles, exits and branches |
| `data/layout-g35.json`, `-derived.json` | The same for a neighborhood's own map (the area group `g35`) |
| `data/slugs.json` | Every link name the public map has handed out (written by `scripts/build-site.mjs`) |
| `data/backups/` | Copies of `graph.json` / `layout.json` at most every 5 minutes, newest 200 of each kept |

The status in the tool's header says "Saved 9:02 AM" once a change is on disk. If the
server is down, edits are buffered in the browser, the status turns amber, and they're
saved when it comes back. Opening the tool in two tabs is safe: a stale tab gets a
"changed elsewhere" warning instead of overwriting.

Keep the port at 8765: the browser buffer is tied to that origin.

## Public map

`site/` is the map people will use: a static page you can pan and zoom, with a card for
whatever you tap (a road or a junction) with buttons to open the spot in Google Maps or Apple
Maps (and get directions), and a share button (box with an arrow, top of the buttons on the right),
always there, for a link to the map as it is. The location button shows where you are on
the schematic, using the same real ↔ schematic transform as the editor. If location is blocked
(by the browser, or for the browser in the phone's settings), it says where to turn it back on.

The *Real ↔ Subway* slider (top right) morphs the map between the real roads and the schematic.

The search box (top middle on a wide screen, under the title on a phone) finds roads by name as you type: roads on the map (and their other
names, River St on Hwy 9), neighborhoods and the roads in them, and roads in collapsed branches and map
exits. Picking one zooms to it and opens its card (for a road inside a neighborhood or branch, that part's
card, saying it's there; for a street in a neighborhood with its own map, that map, with the street
highlighted). A local road hidden by *Hide local roads* turns them back on.

A neighborhood with its own map (see *Neighborhood maps* in the layout editor) has *Open the map of …* in
its card. On a wide screen it opens as a panel over the main map, which stays dimmed behind it; on a phone
it fills the screen. Its name and *‹ 95033* (back to the main map) are where the title was; the browser's
back button, the phone's back gesture, Esc, × and a click on the main map behind all go back too, to the
main map as you left it. Everything else works the same on it: tapping, highlighting, emoji, links, your
location and the slider. Search finds its streets first, then the main map's roads (picking one goes back).

*Hide local roads* (under the slider) leaves off, at any zoom, the roads that are no use for getting
anywhere: local roads, stubs, and stretches that only lead to them. Back roads stay, since they might be a
way out. The setting is remembered in that browser.
Tapping, links and your location work at any position, because a point on a road is drawn between
its real and schematic positions using the same transform.

Links (the part after `#`):

| Link | Shows |
|---|---|
| `#s=soquel-san-jose-rd-14&t=0.4` | a point 40% of the way along that line (`t` is optional) |
| `#n=soquel-san-jose-rd-hester-creek-rd` | a junction |
| `#ll=37.0811,-121.9459` | a real position, on the nearest road |
| `#s=morrell-rd-1,summit-rd-3` | several lines highlighted (a detour, say) |
| `#n=a,b` | several junctions highlighted |
| `#p=🪵,morrell-rd-1,0.42` | an emoji placed 42% of the way along that line; one `p` for each |
| `#a=redwood-estates&s=oak-dr-1` | a neighborhood's own map; the rest of the link is on that map |
| `#f=summit-store` | a place (shop, school…), with its card open |

These combine, so one link can show a detour and what's blocking the usual way:
`#s=morrell-rd-1,summit-rd-3&p=🪵,bear-creek-rd-3,0.3`. Older links with `t` still open; `t` now
only says where to center.

The address bar always holds the link to what's on the map, so it can be copied as you go.

- **Highlighting roads:** tap a road to highlight it from one drawn junction to the next. Zoomed out
  (or with local roads hidden), junctions that aren't drawn don't split it, so it's the whole stretch
  you can see. Shift-click (or *＋ Highlight more roads* in the card, on a phone) adds stretches, or
  takes out one that's already highlighted. Picking a road in search highlights all of it. With
  several roads, the card has a chip for each: tap to show it, × to take it out. Tapping the empty
  map, Esc or the card's × clears the highlights.
- **Places:** shops, schools and the like are drawn as a small icon beside their road, on the side the
  place is (on a gray circle in dark mode), with the name next to it where there's room once zoomed in;
  zoomed out, just the icon. Tap one for its card (type, name, the road it's
  on, and Google or Apple Maps). Search finds them too, including ones on a neighborhood's own map.
- **With a mouse**, the pointer turns into a hand over anything that can be clicked, and places, emoji,
  bunched side roads, neighborhoods and the map's edges get a tooltip with their name.
- **Emoji:** the pin button (above the location button) puts an emoji on the map: tap it, tap the road
  where it goes, and pick one in the popup that opens right there (tree down, crash, road closed, power
  line down, flooding, rocks or slide, fire, hazard, or any emoji typed into *Other*). Tapping another
  spot first moves it; ×, Esc or the pin button again cancels. Your location's card can also put one where you are.
  Emoji stay when the highlights are cleared; tap one to change it or remove it.
- Nothing is stored on a server: it's all in the link. The share button shares everything on the map
  (on a phone with the system share sheet; elsewhere it copies the link).
  Your location is never put in the address bar.

Line and junction names are handed out once and never reused (`data/slugs.json`). All the maps share
them: a road into a neighborhood has the same name on both, and a name is only retired once it's on none. If an
edge disappears after a graph change, its old links still work: they open the closest spot
on whatever road is there now.

Preview it in the tools' *Preview* tab (built live from the editors' files).

### Publishing

Every push to `main` goes live: Cloudflare's Workers Builds watches the repo, runs
`npm run build -- --strict` and then `npx wrangler deploy`. So the publishing routine is:

1. Edit in the tools (`npm run dev`), as now.
2. `npm run build` and `npm test`. The build updates `data/slugs.json`, which keeps old links working,
   and it has to be committed along with the edits that changed it.
3. Commit and push to `main`.

Pushes to other branches get a preview build on their own `*.workers.dev` address instead. To deploy
by hand without git, `npm run deploy` still builds and runs `npx wrangler deploy` (it asks you to log
in to Cloudflare the first time). Location needs HTTPS, which `workers.dev` and custom domains have.

Setting up Workers Builds (once, in the Cloudflare dashboard): Workers & Pages → `subway-95033` →
Settings → Builds → Connect, pick the GitHub repo, branch `main`, build command
`npm run build -- --strict`, deploy command `npx wrangler deploy`. Node comes from `.node-version`.

## GitHub Actions

**Check** (every push and pull request): lint and tests. The tests build the public map from the
committed data, so it fails on any warning (such as a neighborhood map that's out of date), and check
`data/slugs.json` is committed up to date. It doesn't block a deploy, since Cloudflare deploys from the
push itself, but a strict build with warnings fails on Cloudflare's side and the old site stays up.

## License

The code is under the MIT license (`LICENSE`). The map data is under the ODbL; see below.

## Data sources and licenses

- Roads and places: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, under the
  [Open Database License](https://opendatacommons.org/licenses/odbl/). `data/roads.json`,
  `data/places-osm.json` and the files derived from them (the graph, layouts and `site/data/`) are
  derived databases and fall under the ODbL too.
- ZCTA boundary (`data/zcta95033.geojson`): U.S. Census Bureau TIGERweb, public domain.
- [Leaflet](https://leafletjs.com) 1.9.4 (`tools/node-picker/vendor/`): BSD 2-Clause license, in `vendor/LICENSE-leaflet.txt`.
