window.CONFIG = {
  city: 'Kitchener-Waterloo',
  center: [43.4609, -80.5070],   // between Uptown Waterloo and Downtown Kitchener
  zoom: 14,
  // Region of Waterloo open data (ArcGIS REST, region-wide layers, 1,000 records per request).
  // Only features in these municipalities are loaded / searched.
  municipalities: ['Kitchener', 'Waterloo'],
  gis: {
    addresses: 'https://utility.arcgis.com/usrsvcs/servers/d4d0c6dedec14e59930688f3830776c6/rest/services/OpenData/OpenData/MapServer/1',
    streets:   'https://utility.arcgis.com/usrsvcs/servers/ab85e142e5de445aa75a678b049048dd/rest/services/OpenData/OpenData/MapServer/2',
    trails:    'https://utility.arcgis.com/usrsvcs/servers/32365c5c24d240fb9a5aed926a5d7a9f/rest/services/OpenData/OpenData/MapServer/8'
  },
  // GTFS-Realtime. GRT's live feed blocks browsers (no CORS header), so it is read through a tiny
  // Cloudflare Worker relay (see worker/). Paste the Worker's address into liveBase, e.g.
  // 'https://kw-trip-planner.yourname.workers.dev'. Leave it empty for schedule-only mode.
  // A ?feed=<url> query parameter overrides liveBase for testing.
  realtime: {
    liveBase: '',
    snapshot: null,   // optional: { vehicles: 'data/realtime/vehiclepositions.pb', alerts: 'data/realtime/alerts.pb' }
    refreshSeconds: 15
  },
  walkSpeedKmh: 4.8,
  walkshedMinutes: 5
};

// Fetch every feature of an ArcGIS layer as GeoJSON, paging past the 1,000-record limit.
window.arcgisAll = async function (url, where, fields, precision = 6) {
  const base = `${url}/query?where=${encodeURIComponent(where)}`;
  const { count } = await fetch(`${base}&returnCountOnly=true&f=json`).then(r => r.json());
  const page = 1000, pages = [];
  for (let off = 0; off < count; off += page) {
    pages.push(fetch(`${base}&outFields=${fields}&outSR=4326&geometryPrecision=${precision}&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=${page}&f=geojson`)
      .then(r => r.json()));
  }
  const all = await Promise.all(pages);
  return { type: 'FeatureCollection', features: all.flatMap(g => g.features || []) };
};
window.muniWhere = (field) => `${field} IN (${CONFIG.municipalities.map(m => `'${m}'`).join(',')})`;
