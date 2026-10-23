(async function () {
  const C = window.CONFIG;
  const $ = s => document.querySelector(s);

  // ---------- Map ----------
  const map = L.map('map', { zoomControl: false, center: C.center, zoom: C.zoom, minZoom: 11, maxZoom: 19 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'basemap',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Region of Waterloo Open Data | GRT'
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const panes = { routes: 410, trails: 405, walk: 420, stops: 610, buses: 640, me: 650, pins: 660 };
  for (const [k, z] of Object.entries(panes)) map.createPane(k).style.zIndex = z;

  const layers = {
    routes: L.layerGroup(), trails: L.layerGroup(),
    stops: L.layerGroup().addTo(map), buses: L.layerGroup().addTo(map), trip: L.layerGroup().addTo(map)
  };

  // Keep planner height in a CSS var so the chips sit right under it
  const setPlannerH = () => document.documentElement.style.setProperty('--planner-h', $('#planner').offsetHeight + 'px');
  new ResizeObserver(setPlannerH).observe($('#planner')); setPlannerH();

  // ---------- Static GTFS ----------
  let stopsJ, routes;
  try {
    [stopsJ, routes] = await Promise.all([
      fetch('data/gtfs/stops.json').then(r => r.json()),
      fetch('data/gtfs/routes.json').then(r => r.json())
    ]);
  } catch (e) {
    $('#sheetBody').innerHTML = '<div class="status"><b>GRT schedule data isn\'t built yet.</b><br><span class="muted">Run the "Update GRT schedule" action (see README).</span></div>';
    $('#sheet').classList.add('open'); throw e;
  }
  const stops = stopsJ.stops.map(([code, name, lat, lon, id], i) => ({ i, code, name, lat, lon, id: id ?? code }));
  window.APP = { map, stops, routes, layers };

  // Route lines (official route colours)
  for (const r of Object.values(routes)) {
    if (!/^\d/.test(r.n)) continue; // skip charters / specials
    r.shapes.forEach(s => L.polyline(s, { pane: 'routes', color: r.c, weight: 3, opacity: .75 }).addTo(layers.routes));
  }

  // Stops: green leaf pins when zoomed in, small green dots when zoomed out
  const stopPopup = s => `<div class="pop-title">${s.name}</div><span class="muted">Stop #${s.code} · next buses</span><div class="arrivals" data-stopidx="${s.i}"></div>`;
  function drawStops() {
    const pop = map._popup; // don't wipe the stop whose popup is open (popup autopan fires moveend)
    if (pop && map.hasLayer(pop) && pop._source && layers.stops.hasLayer(pop._source)) return;
    layers.stops.clearLayers();
    const z = map.getZoom(), b = map.getBounds().pad(0.2);
    if (z < 14) return; // keep the city-wide view clean
    for (const s of stops) {
      if (!b.contains([s.lat, s.lon])) continue;
      const m = z >= 16
        ? L.marker([s.lat, s.lon], { icon: Icons.pin('stop'), pane: 'stops' })
        : L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'stop-dot', iconSize: [10, 10] }), pane: 'stops' });
      m.bindPopup(Icons.popEl(stopPopup(s))).addTo(layers.stops);
    }
  }
  map.on('zoomend moveend', drawStops); drawStops();

  // ---------- Realtime: live via Cloudflare Worker relay, snapshot as fallback ----------
  const liveBase = (new URLSearchParams(location.search).get('feed') || C.realtime.liveBase || '').replace(/\/$/, '');
  let feedTime = 0, alerts = [], isLive = false, lastOk = 0, noFeed = false;
  const busMarkers = new Map();
  async function getFeed(kind) {
    if (liveBase) {
      try {
        const r = await fetch(`${liveBase}/${kind}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        return { feed: GTFSRT.decode(await r.arrayBuffer()), live: true };
      } catch (e) { console.warn('Live feed unavailable, using snapshot', e); }
    }
    if (!C.realtime.snapshot) return { feed: { timestamp: 0, vehicles: [], alerts: [], trips: new Map() }, live: false, none: true };
    const r = await fetch(C.realtime.snapshot[kind], { cache: 'no-store' });
    if (!r.ok) throw new Error('snapshot ' + r.status);
    return { feed: GTFSRT.decode(await r.arrayBuffer()), live: false };
  }
  const busPopup = (v, r) => `<div class="pop-title"><span class="badge" style="background:${r ? r.c : '#999'};color:#fff">${r ? r.n : '?'}</span> ${r ? r.name : 'Unknown route'}</div>
    <span class="muted">Bus ${v.label || v.id}${v.speed ? ' · ' + Math.round(v.speed * 3.6) + ' km/h' : ''}<br>Position at ${fmtTime(v.timestamp, true)}</span>`;
  function glide(m, to, ms = 1200) {
    const from = m.getLatLng(), t0 = performance.now();
    if (from.distanceTo(to) > 1500) { m.setLatLng(to); return; }
    const step = now => { const k = Math.min(1, (now - t0) / ms), e = k * (2 - k);
      m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  async function loadVehicles() {
    try {
      const { feed, live, none } = await getFeed('vehicles');
      feedTime = feed.timestamp; isLive = live; noFeed = !!none; lastOk = Date.now(); APP.vehicles = feed.vehicles;
      const seen = new Set();
      for (const v of feed.vehicles) {
        const r = routes[v.routeId], key = v.id; seen.add(key);
        const sig = (r ? r.n : '?') + '|' + Math.round((v.bearing || 0) / 15);
        let m = busMarkers.get(key);
        if (!m) {
          m = L.marker([v.lat, v.lon], { icon: Icons.bus(r, v.bearing), pane: 'buses', zIndexOffset: 1000 }).addTo(layers.buses);
          busMarkers.set(key, m);
        } else {
          glide(m, [v.lat, v.lon]);
          if (m._sig !== sig) m.setIcon(Icons.bus(r, v.bearing));
        }
        m._sig = sig; m.bindPopup(busPopup(v, r));
      }
      for (const [k, m] of busMarkers) if (!seen.has(k)) { layers.buses.removeLayer(m); busMarkers.delete(k); }
      if (!APP.inTrip) status(feed.vehicles.length);
    } catch (e) { console.error(e); }
  }
  async function loadAlerts() {
    try { alerts = (await getFeed('alerts')).feed.alerts; } catch (e) { alerts = []; }
  }
  const fmtTime = (t, sec) => new Date(t * 1000).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}), timeZone: 'America/Toronto' });
  function status(n) {
    const head = noFeed ? '<b>Schedule only</b> · live bus positions are off'
      : `<b>${n} buses</b> · ${isLive ? 'live' : 'snapshot'} ${fmtTime(feedTime, isLive)}`;
    $('#sheetBody').innerHTML = `<div class="status"><span class="live-dot${isLive ? ' pulse' : ''}" style="background:${isLive ? '#2EAD5E' : '#E8A33A'}"></span>
      <div>${head}${alerts.length ? ` · <a href="#" id="alertsLink">${alerts.length} service alerts</a>` : ''}<br>
      <span class="muted">${isLive ? `Updates every ${C.realtime.refreshSeconds} s. ` : ''}Enter a start and destination to plan a trip.</span></div></div>`;
    openSheet(true);
    const a = $('#alertsLink'); if (a) a.onclick = e => { e.preventDefault(); showAlerts(); };
    $('#feedInfo').textContent = noFeed ? 'Bus times: GRT schedule (live feed not connected).'
      : `Bus positions: ${isLive ? 'live GRT feed' : 'snapshot from ' + new Date(feedTime * 1000).toLocaleString('en-CA', { timeZone: 'America/Toronto' })}.`;
  }
  function showAlerts() {
    const seen = new Set();
    const items = alerts.filter(a => !seen.has(a.header) && seen.add(a.header)).map(a => {
      const rs = a.routes.map(id => routes[id]).filter(Boolean).map(r => `<span class="badge" style="background:${r.c};color:#fff">${r.n}</span>`).join(' ');
      return `<li style="margin:8px 0">${rs} ${a.header}</li>`;
    }).join('');
    $('#sheetBody').innerHTML = `<b>Service alerts</b><ul style="padding-left:0;list-style:none">${items}</ul><button class="go-btn" id="closeAlerts">Back</button>`;
    $('#closeAlerts').onclick = () => status(layers.buses.getLayers().length);
  }
  function openSheet(on) {
    $('#sheet').classList.toggle('open', on);
    requestAnimationFrame(() => document.documentElement.style.setProperty('--sheet-h', on ? $('#sheet').offsetHeight + 'px' : '0px'));
  }
  APP.sheet = (html, collapsed) => {
    APP.inTrip = true; document.body.classList.add('trip');
    $('#sheetBody').innerHTML = html; $('#sheet').classList.toggle('collapsed', !!collapsed); openSheet(true);
    const x = $('#clearTrip'); if (x) x.onclick = APP.clearTrip;
  };
  APP.clearTrip = () => {
    APP.inTrip = false; document.body.classList.remove('trip'); layers.trip.clearLayers(); APP.departSecs = null;
    $('#fromInput').value = $('#toInput').value = ''; sel.from = sel.to = null;
    $('#sheet').classList.remove('collapsed'); status(layers.buses.getLayers().length);
  };
  // tap the handle (or swipe) to expand / collapse trip details
  const toggleSheet = () => { if (!APP.inTrip) return; $('#sheet').classList.toggle('collapsed'); openSheet(true); };
  $('.grab').onclick = toggleSheet;
  let y0 = null; $('#sheet').addEventListener('touchstart', e => y0 = e.touches[0].clientY, { passive: true });
  $('#sheet').addEventListener('touchend', e => { if (y0 === null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (Math.abs(dy) > 40 && APP.inTrip) { $('#sheet').classList.toggle('collapsed', dy > 0); openSheet(true); } });
  await loadAlerts(); await loadVehicles();
  if (liveBase && C.realtime.refreshSeconds > 0) {
    // poll while the page is visible; refresh immediately when the phone comes back to the app
    setInterval(() => { if (!document.hidden) loadVehicles(); }, C.realtime.refreshSeconds * 1000);
    setInterval(() => { if (!document.hidden) loadAlerts(); }, 120000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastOk > 5000) loadVehicles(); });
  }

  // ---------- Trails (Region of Waterloo, live service) ----------
  let trailsLoaded = false;
  async function loadTrails() {
    if (trailsLoaded) return; trailsLoaded = true;
    const gj = APP.trails || await arcgisAll(C.gis.trails, muniWhere('Municipality'), 'TrailName,SurfaceMaterial', 5);
    L.geoJSON(gj, { pane: 'trails', style: { color: '#136935', weight: 2.5, dashArray: '5 4', opacity: .9 },
      onEachFeature: (f, l) => l.bindPopup(`<div class="pop-title">${f.properties.TrailName || 'Trail'}</div><span class="muted">${f.properties.SurfaceMaterial || ''}</span>`) })
      .addTo(layers.trails);
  }

  // ---------- Layer chips ----------
  document.querySelectorAll('.chip').forEach(ch => ch.onclick = async () => {
    const k = ch.dataset.layer, on = !ch.classList.contains('on');
    ch.classList.toggle('on', on);
    if (k === 'trails' && on) await loadTrails();
    on ? layers[k].addTo(map) : map.removeLayer(layers[k]);
  });

  // ---------- Address search (Region of Waterloo Addresses layer) ----------
  const sel = { from: null, to: null };
  const sug = $('#suggest'); let activeInput = null, timer;
  // Region addresses use abbreviations ("200 King St W") — map typed words onto them
  const ABBR = { STREET: 'ST', ROAD: 'RD', AVENUE: 'AVE', DRIVE: 'DR', CRESCENT: 'CRES', COURT: 'CRT', PLACE: 'PL', BOULEVARD: 'BLVD',
    CIRCLE: 'CIR', TERRACE: 'TERR', LANE: 'LANE', TRAIL: 'TRAIL', PARKWAY: 'PKY', HIGHWAY: 'HWY', SQUARE: 'SQ', GATE: 'GATE',
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', SAINT: 'ST' };
  async function searchAddr(q) {
    const t = q.trim().toUpperCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean).map((w, i) => i > 1 && ABBR[w] ? ABBR[w] : w);
    // "…, Kitchener" / "…, Waterloo" at the end narrows the search to that city
    let muni = muniWhere('Municipality');
    const city = C.municipalities.find(m => t.length > 2 && t[t.length - 1] === m.toUpperCase());
    if (city) { t.pop(); muni = `Municipality = '${city}'`; }
    // a half-typed suffix ("200 King Stre") can't match "St" yet — leave it out until it's complete
    const last = t[t.length - 1];
    if (t.length > 2 && !ABBR[last] && Object.keys(ABBR).some(k => k.length > last.length && k.startsWith(last)) && !Object.values(ABBR).includes(last)) t.pop();
    q = t.join(' ').replace(/'/g, "''");
    if (q.length < 3) return [];
    const where = encodeURIComponent(`UPPER(FullAddress) LIKE '${q}%' AND ${muni} AND UnitNumber IS NULL AND IsPrimary = 'Yes'`);
    const url = `${C.gis.addresses}/query?where=${where}&outFields=FullAddress,Municipality&outSR=4326&orderByFields=FullAddress&resultRecordCount=8&f=json`;
    const j = await fetch(url).then(r => r.json());
    return (j.features || []).map(f => ({ ADDRESS: f.attributes.FullAddress, MUNI: f.attributes.Municipality, LAT: f.geometry.y, LONG: f.geometry.x }));
  }
  function bindInput(input, key) {
    input.addEventListener('input', () => {
      sel[key] = null; activeInput = { input, key }; clearTimeout(timer);
      timer = setTimeout(async () => {
        const res = await searchAddr(input.value).catch(() => []);
        sug.innerHTML = res.map((a, i) => `<li role="option" data-i="${i}">${a.ADDRESS}<br><small>${a.MUNI}</small></li>`).join('');
        sug.hidden = !res.length;
        sug.querySelectorAll('li').forEach(li => li.onclick = () => choose(res[+li.dataset.i]));
      }, 200);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !sug.hidden) { e.preventDefault(); sug.querySelector('li')?.click(); } });
  }
  function choose(a) {
    const { input, key } = activeInput;
    input.value = a.ADDRESS + ', ' + a.MUNI; sel[key] = { name: a.ADDRESS + ', ' + a.MUNI, lat: a.LAT, lon: a.LONG };
    sug.hidden = true; input.blur(); drawEnds();
  }
  bindInput($('#fromInput'), 'from'); bindInput($('#toInput'), 'to');

  async function resolve(key, input) {
    if (sel[key]) return sel[key];
    const r = await searchAddr(input.value); if (!r.length) return null;
    return sel[key] = { name: r[0].ADDRESS + ', ' + r[0].MUNI, lat: r[0].LAT, lon: r[0].LONG };
  }
  function drawEnds() {
    layers.trip.clearLayers();
    if (sel.from) L.marker([sel.from.lat, sel.from.lon], { icon: Icons.pin('walk'), pane: 'pins' }).bindPopup(sel.from.name).addTo(layers.trip);
    if (sel.to) L.marker([sel.to.lat, sel.to.lon], { icon: Icons.pin('dest'), pane: 'pins' }).bindPopup(sel.to.name).addTo(layers.trip);
    const pts = [sel.from, sel.to].filter(Boolean).map(p => [p.lat, p.lon]);
    if (pts.length === 2) map.fitBounds(pts, { padding: [40, 40], paddingTopLeft: [20, $('#planner').offsetHeight + 70] });
    else if (pts.length) map.setView(pts[0], 16);
  }

  $('#swapBtn').onclick = () => {
    const f = $('#fromInput').value; $('#fromInput').value = $('#toInput').value; $('#toInput').value = f;
    [sel.from, sel.to] = [sel.to, sel.from]; drawEnds();
  };
  // ---------- Live location: blue dot + accuracy ring that follows you ----------
  // Tap the locate button: start tracking, use your position as the trip start, and follow you.
  // Drag the map to stop following; tap the button again to re-centre and follow.
  const me = { watch: null, follow: false, dot: null, ring: null, last: null };
  function meIcon(heading) {
    const h = heading != null && !isNaN(heading) ? `<span class="me-head" style="transform:rotate(${heading}deg)"></span>` : '';
    return L.divIcon({ className: 'me', html: `${h}<span class="me-dot"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
  }
  function onFix(p) {
    const ll = [p.coords.latitude, p.coords.longitude], first = !me.last;
    me.last = { lat: ll[0], lon: ll[1], acc: p.coords.accuracy, t: p.timestamp };
    if (!me.dot) {
      me.ring = L.circle(ll, { pane: 'me', radius: p.coords.accuracy, color: '#3A7AEB', weight: 1, fillColor: '#3A7AEB', fillOpacity: .12, interactive: false }).addTo(map);
      me.dot = L.marker(ll, { icon: meIcon(p.coords.heading), pane: 'me', zIndexOffset: 2000, keyboard: false })
        .bindPopup(() => `<div class="pop-title">You are here</div><span class="muted">±${Math.round(me.last.acc)} m · ${fmtTime(me.last.t / 1000, true)}</span>`).addTo(map);
    } else {
      glide(me.dot, ll, 800); me.ring.setLatLng(ll).setRadius(p.coords.accuracy);
      me.dot.setIcon(meIcon(p.coords.heading));
    }
    if (first) {
      sel.from = { name: 'My location', lat: ll[0], lon: ll[1] }; $('#fromInput').value = 'My location'; drawEnds();
      map.setView(ll, Math.max(map.getZoom(), 16));
    } else if (me.follow) map.panTo(ll, { animate: true });
    if (sel.from && sel.from.name === 'My location' && !APP.inTrip) { sel.from.lat = ll[0]; sel.from.lon = ll[1]; }
  }
  function onFixError(e) {
    $('#locateBtn').classList.remove('on', 'follow');
    if (me.watch !== null) navigator.geolocation.clearWatch(me.watch); me.watch = null;
    alertSheet(e.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings, then tap the locate button again.'
      : 'Couldn\'t get your location right now. Try again in a moment.');
  }
  const setFollow = on => { me.follow = on; $('#locateBtn').classList.toggle('follow', on); };
  $('#locateBtn').onclick = () => {
    if (!('geolocation' in navigator)) return alertSheet('This browser can\'t share your location.');
    if (me.watch === null) {
      $('#locateBtn').classList.add('on');
      me.watch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } else if (me.last) {
      sel.from = { name: 'My location', lat: me.last.lat, lon: me.last.lon }; $('#fromInput').value = 'My location';
      map.setView([me.last.lat, me.last.lon], Math.max(map.getZoom(), 16));
    }
    setFollow(true);
  };
  map.on('dragstart', () => setFollow(false));
  $('#goBtn').onclick = async () => {
    const a = await resolve('from', $('#fromInput')), b = await resolve('to', $('#toInput'));
    if (!a || !b) { alertSheet(`Choose a start and a destination address in ${C.city}.`); return; }
    drawEnds();
    if (window.planTrip) window.planTrip(a, b); // routing module (next step)
  };
  function alertSheet(msg) { $('#sheetBody').innerHTML = `<div class="status">${msg}</div>`; openSheet(true); }

  // Info dialog + legend
  $('#infoBtn').onclick = () => $('#infoDlg').showModal();
  document.querySelectorAll('.lg-pin').forEach(el => el.innerHTML = Icons.svg(el.dataset.k, 22, 28));

  // Deep-link: ?from=200 King St W&to=200 University Ave W
  const qs = new URLSearchParams(location.search);
  if (qs.get('from')) $('#fromInput').value = qs.get('from');
  if (qs.get('to')) $('#toInput').value = qs.get('to');
  if (qs.get('from') && qs.get('to')) $('#goBtn').click();
})();
