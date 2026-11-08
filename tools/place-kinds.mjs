// Which OpenStreetMap places the layout editor offers, and how they're shown: used by
// scripts/fetch-places.mjs (what to download) and the layout editor (icons and labels).
// A place's kind is its main tag, like "shop=supermarket".

// The tags looked at, in order: a place's kind is the first of these it has.
export const KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'historic', 'office', 'emergency', 'craft', 'healthcare', 'building'];
// Named buildings count only as these (some places, like a school, are mapped as just a building).
export const BUILDINGS = 'school|kindergarten|college|church|chapel|temple|mosque|synagogue|fire_station|hospital|civic|public|government|library|museum|retail|supermarket|hotel|stadium';

// Too small or too many to be worth a marker.
export const SKIP = new Set(['amenity=toilets', 'amenity=parking', 'amenity=parking_entrance', 'amenity=parking_space', 'amenity=recycling',
  'amenity=bench', 'amenity=bicycle_rental', 'amenity=bicycle_parking', 'amenity=waste_basket', 'amenity=waste_disposal',
  'amenity=drinking_water', 'amenity=charging_station', 'amenity=vending_machine', 'amenity=atm', 'amenity=telephone',
  'amenity=post_box', 'amenity=fountain', 'amenity=bbq', 'amenity=hunting_stand', 'emergency=fire_hydrant', 'emergency=phone']);

// Icon (a Maki name, see site/place-icons.mjs) and label for each kind; others get the plain marker and their
// tag value ("Ice cream" for amenity=ice_cream).
export const PLACE_KINDS = {
  'shop=supermarket': ['grocery', 'Grocery store'], 'shop=convenience': ['convenience', 'Store'], 'shop=general': ['convenience', 'Store'],
  'amenity=school': ['school', 'School'], 'building=school': ['school', 'School'], 'building=kindergarten': ['school', 'Preschool'],
  'building=church': ['religious-christian', 'Church'], 'building=chapel': ['religious-christian', 'Chapel'], 'building=fire_station': ['fire-station', 'Fire station'], 'amenity=kindergarten': ['school', 'Preschool'], 'amenity=fire_station': ['fire-station', 'Fire station'],
  'amenity=restaurant': ['restaurant', 'Restaurant'], 'amenity=cafe': ['cafe', 'Café'], 'amenity=fast_food': ['fast-food', 'Fast food'],
  'amenity=bar': ['beer', 'Bar'], 'amenity=pub': ['beer', 'Pub'], 'amenity=place_of_worship': ['religious-christian', 'Church'],
  'amenity=post_office': ['post', 'Post office'], 'amenity=library': ['library', 'Library'], 'amenity=fuel': ['fuel', 'Gas station'],
  'amenity=community_centre': ['town-hall', 'Community center'], 'amenity=townhall': ['town-hall', 'Town hall'], 'amenity=pharmacy': ['pharmacy', 'Pharmacy'],
  'amenity=theatre': ['theatre', 'Theater'], 'amenity=bank': ['bank', 'Bank'],
  'amenity=doctors': ['doctor', 'Doctor'], 'amenity=clinic': ['doctor', 'Clinic'], 'amenity=police': ['police', 'Police'],
  'leisure=park': ['park', 'Park'], 'leisure=nature_reserve': ['park-alt1', 'Nature reserve'], 'leisure=playground': ['playground', 'Playground'],
  'tourism=camp_site': ['campsite', 'Campground'], 'tourism=viewpoint': ['viewpoint', 'Viewpoint'], 'tourism=picnic_site': ['picnic-site', 'Picnic area'],
  'tourism=information': ['information', 'Information'], 'tourism=winery': ['alcohol-shop', 'Winery'], 'shop=alcohol': ['alcohol-shop', 'Wine shop'],
  'craft=winery': ['alcohol-shop', 'Winery'], 'shop=hardware': ['hardware', 'Hardware store'], 'shop=car_repair': ['car-repair', 'Auto repair'],
};
export function placeKind(kind = '') {
  if (PLACE_KINDS[kind]) return PLACE_KINDS[kind];
  const v = kind.split('=')[1] || '';
  return ['marker', !v || v === 'yes' ? 'Place' : v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())];
}
