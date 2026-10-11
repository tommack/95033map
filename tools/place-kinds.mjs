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

// Icon and label for each kind; others get a pin and their tag value ("Ice cream" for amenity=ice_cream).
export const PLACE_KINDS = {
  'shop=supermarket': ['🛒', 'Grocery store'], 'shop=convenience': ['🛒', 'Store'], 'shop=general': ['🛒', 'Store'],
  'amenity=school': ['🏫', 'School'], 'building=school': ['🏫', 'School'], 'building=kindergarten': ['🏫', 'Preschool'],
  'building=church': ['⛪', 'Church'], 'building=chapel': ['⛪', 'Chapel'], 'building=fire_station': ['🚒', 'Fire station'], 'amenity=kindergarten': ['🏫', 'Preschool'], 'amenity=fire_station': ['🚒', 'Fire station'],
  'amenity=restaurant': ['🍽️', 'Restaurant'], 'amenity=cafe': ['☕', 'Café'], 'amenity=fast_food': ['🍔', 'Fast food'],
  'amenity=bar': ['🍺', 'Bar'], 'amenity=pub': ['🍺', 'Pub'], 'amenity=place_of_worship': ['⛪', 'Church'],
  'amenity=post_office': ['🏤', 'Post office'], 'amenity=library': ['📚', 'Library'], 'amenity=fuel': ['⛽', 'Gas station'],
  'amenity=community_centre': ['🏛️', 'Community center'], 'amenity=townhall': ['🏛️', 'Town hall'], 'amenity=pharmacy': ['💊', 'Pharmacy'],
  'amenity=theatre': ['🎭', 'Theater'], 'amenity=bank': ['🏦', 'Bank'],
  'amenity=doctors': ['🩺', 'Doctor'], 'amenity=clinic': ['🩺', 'Clinic'], 'amenity=police': ['🚓', 'Police'],
  'leisure=park': ['🌳', 'Park'], 'leisure=nature_reserve': ['🌲', 'Nature reserve'], 'leisure=playground': ['🛝', 'Playground'],
  'tourism=camp_site': ['⛺', 'Campground'], 'tourism=viewpoint': ['🔭', 'Viewpoint'], 'tourism=picnic_site': ['🧺', 'Picnic area'],
  'tourism=information': ['ℹ️', 'Information'], 'tourism=winery': ['🍷', 'Winery'], 'shop=alcohol': ['🍷', 'Wine shop'],
  'craft=winery': ['🍷', 'Winery'], 'shop=hardware': ['🔧', 'Hardware store'], 'shop=car_repair': ['🔧', 'Auto repair'],
};
export function placeKind(kind = '') {
  if (PLACE_KINDS[kind]) return PLACE_KINDS[kind];
  const v = kind.split('=')[1] || '';
  return ['📍', !v || v === 'yes' ? 'Place' : v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())];
}
