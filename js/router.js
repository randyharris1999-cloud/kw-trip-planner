// Trip planner: walking network (Region of Waterloo streets + trails) + transit (GTFS, RAPTOR up to 2 transfers)
(function () {
  const C = window.CONFIG;
  const WALK = C.walkSpeedKmh / 3.6;          // m/s
  const SHED_M = C.walkshedMinutes * 60 * WALK; // 10 min ≈ 800 m
  const MAX_ACCESS_M = 1200;                  // max walk to/from a stop (~15 min)
  const MAX_XFER_M = 400;                     // max walking transfer between stops
  const BOARD_SLACK = 30;                     // s buffer before boarding
  const LAT0 = 43.46, LON0 = -80.50, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110540;
  const toXY = (lat, lon) => [(lon - LON0) * KX, (lat - LAT0) * KY];
  const $ = s => document.querySelector(s);

  // ------------------------------------------------------------ walking graph
  const G = { x: [], y: [], ll: [], adj: [], edges: [], grid: new Map(), key: new Map() };
  const CELL = 100;
  function node(lat, lon) {
    const k = lat.toFixed(5) + ',' + lon.toFixed(5);
    let id = G.key.get(k);
    if (id === undefined) {
      id = G.x.length; G.key.set(k, id);
      const [x, y] = toXY(lat, lon); G.x.push(x); G.y.push(y); G.ll.push([lat, lon]); G.adj.push([]);
    }
    return id;
  }
  function addNode(lat, lon) { const id = G.x.length; const [x, y] = toXY(lat, lon); G.x.push(x); G.y.push(y); G.ll.push([lat, lon]); G.adj.push([]); return id; }
  const dist = (a, b) => Math.hypot(G.x[a] - G.x[b], G.y[a] - G.y[b]);
  function link(a, b, kind, index = true) {
    if (a === b) return; const w = dist(a, b);
    G.adj[a].push(b, w); G.adj[b].push(a, w);
    if (!index) return;
    const e = G.edges.length; G.edges.push([a, b, kind]);
    const x0 = Math.floor(Math.min(G.x[a], G.x[b]) / CELL), x1 = Math.floor(Math.max(G.x[a], G.x[b]) / CELL);
    const y0 = Math.floor(Math.min(G.y[a], G.y[b]) / CELL), y1 = Math.floor(Math.max(G.y[a], G.y[b]) / CELL);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) {
      const k = i + ':' + j; if (!G.grid.has(k)) G.grid.set(k, []); G.grid.get(k).push(e);
    }
  }
  // nearest edge to a point (meters); returns {e, t, d, px, py}
  function nearestEdge(x, y, maxD, skip) {
    let best = null; const r = Math.ceil(maxD / CELL), ci = Math.floor(x / CELL), cj = Math.floor(y / CELL);
    for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
      const list = G.grid.get(i + ':' + j); if (!list) continue;
      for (const e of list) {
        const [a, b] = G.edges[e]; if (skip && (a === skip || b === skip)) continue;
        const dx = G.x[b] - G.x[a], dy = G.y[b] - G.y[a], L = dx * dx + dy * dy || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - G.x[a]) * dx + (y - G.y[a]) * dy) / L));
        const px = G.x[a] + t * dx, py = G.y[a] + t * dy, d = Math.hypot(px - x, py - y);
        if (d <= maxD && (!best || d < best.d)) best = { e, t, d, px, py };
      }
    }
    return best;
  }
  // attach a lat/lon to the network: new node on the nearest edge + connector
  function snap(lat, lon, maxD = 300) {
    const [x, y] = toXY(lat, lon); const ne = nearestEdge(x, y, maxD);
    const p = addNode(lat, lon);
    if (!ne) return p;
    const [a, b] = G.edges[ne.e];
    const m = addNode(lat + (ne.py - y) / KY, lon + (ne.px - x) / KX);
    link(m, a, 'split', false); link(m, b, 'split', false); link(p, m, 'snap', false);
    return p;
  }
  let graphReady = null;
  function loadGraph() {
    if (graphReady) return graphReady;
    graphReady = (async () => {
      while (!window.APP || !APP.stops) await new Promise(r => setTimeout(r, 100));
      // walkable roads in Kitchener + Waterloo (no freeways, ramps, ION track, closed or unbuilt roads)
      const roadWhere = `(${muniWhere('LeftMunicipality')} OR ${muniWhere('RightMunicipality')}) AND LifeStatus = 'Active'`
        + ` AND (CartoClass IS NULL OR CartoClass NOT IN ('Freeway','Ramp','Rapid Transit'))`
        + ` AND (PublicAccess IS NULL OR PublicAccess NOT IN ('Closed','Future or planned road','Emergency Access Only','Private gated road'))`;
      const [streets, trails] = await Promise.all([
        arcgisAll(C.gis.streets, roadWhere, 'CartoClass'),
        arcgisAll(C.gis.trails, muniWhere('Municipality'), 'TrailName,SurfaceMaterial')]);
      const ends = [];
      const add = (gj, kind, skip) => {
        for (const f of gj.features) {
          if (!f.geometry || skip(f.properties)) continue;
          const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
          for (const l of lines) {
            let prev = null;
            for (const [lon, lat] of l) { const n = node(lat, lon); if (prev !== null) link(prev, n, kind); prev = n; }
            ends.push([node(l[0][1], l[0][0]), kind], [prev, kind]);
          }
        }
      };
      add(streets, 'street', () => false);
      add(trails, 'trail', () => false);
      // connect dangling ends (trail ↔ street, T-junctions not split in the source data)
      for (const [n, kind] of ends) {
        if (G.adj[n].length > 2) continue; // already connected to >1 neighbour
        const ne = nearestEdge(G.x[n], G.y[n], kind === 'trail' ? 30 : 12, n);
        if (!ne) continue;
        const [a, b] = G.edges[ne.e];
        if (G.adj[n].includes(a) && G.adj[n].includes(b)) continue;
        const m = addNode(G.ll[a][0] + (G.ll[b][0] - G.ll[a][0]) * ne.t, G.ll[a][1] + (G.ll[b][1] - G.ll[a][1]) * ne.t);
        link(m, a, 'split', false); link(m, b, 'split', false); link(n, m, 'connector', false);
      }
      // snap every bus stop once
      APP.stops.forEach(s => s.node = snap(s.lat, s.lon, 150));
      window.APP.trails = trails;
      return G;
    })();
    return graphReady;
  }

  // Dijkstra with binary heap, bounded by maxD metres
  function dijkstra(src, maxD) {
    const n = G.x.length, d = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const h = [[0, src]]; d[src] = 0;
    const push = v => { h.push(v); let i = h.length - 1; while (i) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } };
    const pop = () => { const t = h[0], l = h.pop(); if (h.length) { h[0] = l; let i = 0; for (;;) { let m = i; const a = 2 * i + 1, b = a + 1; if (a < h.length && h[a][0] < h[m][0]) m = a; if (b < h.length && h[b][0] < h[m][0]) m = b; if (m === i) break; [h[m], h[i]] = [h[i], h[m]]; i = m; } } return t; };
    while (h.length) {
      const [du, u] = pop(); if (du > d[u]) continue; if (du > maxD) break;
      const a = G.adj[u];
      for (let k = 0; k < a.length; k += 2) { const v = a[k], nd = du + a[k + 1]; if (nd < d[v]) { d[v] = nd; prev[v] = u; push([nd, v]); } }
    }
    return { d, prev };
  }
  const pathTo = (res, t) => { const p = []; for (let v = t; v !== -1; v = res.prev[v]) p.push(G.ll[v]); return p.reverse(); };

  // ------------------------------------------------------------ transit (RAPTOR)
  let sched = null;
  async function loadSchedule() {
    if (sched) return sched;
    const j = APP.noSchedule ? { services: {}, patterns: [], headsigns: [], trips: [] }
      : await fetch('data/gtfs/schedule.json').then(r => r.ok ? r.json() : { services: {}, patterns: [], headsigns: [], trips: [] });
    j.trips.forEach(t => { let acc = 0; t.abs = t[4].map((d, i) => (acc = i ? acc + d : d)); });
    // stop → [pattern, index]
    j.stopPats = APP.stops.map(() => []);
    j.patterns.forEach((p, pi) => p.s.forEach((s, i) => j.stopPats[s].push([pi, i])));
    // footpath transfers (straight line × 1.25)
    j.xfer = APP.stops.map(() => []);
    const S = APP.stops.map(s => toXY(s.lat, s.lon));
    for (let a = 0; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
      const m = Math.hypot(S[a][0] - S[b][0], S[a][1] - S[b][1]) * 1.25;
      if (m <= MAX_XFER_M) { j.xfer[a].push(b, m / WALK); j.xfer[b].push(a, m / WALK); }
    }
    return sched = j;
  }
  function torontoNow() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' })
      .formatToParts(new Date()).map(x => [x.type, x.value]));
    return { ymd: p.year + p.month + p.day, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), secs: +p.hour * 3600 + +p.minute * 60 + +p.second };
  }
  function activeServices(ymd, dow) {
    const on = new Set();
    for (const [id, s] of Object.entries(sched.services)) {
      let a = s.start && ymd >= s.start && ymd <= s.end && s.days[dow] === 1;
      if (s.add.includes(ymd)) a = true; if (s.rem.includes(ymd)) a = false;
      if (a) on.add(id);
    }
    return on;
  }
  // live trip updates can mark stops as skipped (detours / closures) — never board or alight there
  const skipped = (trip, stopIdx) => !!preds.trips.get(trip[3])?.stops.get(APP.stops[stopIdx].id)?.skip;
  function raptor(access, egress, t0, day) {
    const svc = activeServices(day.ymd, day.dow);
    const N = APP.stops.length, K = 3;
    const patTrips = sched.patterns.map(() => []);
    sched.trips.forEach(t => { if (svc.has(t[1])) patTrips[t[0]].push(t); });
    patTrips.forEach(l => l.sort((a, b) => a.abs[0] - b.abs[0]));
    const best = new Float64Array(N).fill(Infinity);
    const tau = [new Float64Array(N).fill(Infinity)], par = [new Array(N)];
    let marked = new Set();
    for (const [s, sec] of access) { tau[0][s] = best[s] = t0 + sec; par[0][s] = { type: 'access', sec }; marked.add(s); }
    for (let k = 1; k <= K; k++) {
      tau[k] = new Float64Array(N).fill(Infinity); par[k] = new Array(N);
      const Q = new Map();
      for (const s of marked) for (const [p, i] of sched.stopPats[s]) if (!Q.has(p) || Q.get(p) > i) Q.set(p, i);
      const newly = new Set();
      for (const [p, start] of Q) {
        const stops = sched.patterns[p].s; let trip = null, bIdx = -1;
        for (let i = start; i < stops.length; i++) {
          const s = stops[i];
          if (trip) {
            const arr = trip.abs[i];
            if (arr < best[s] && arr < tau[k][s] && !skipped(trip, s)) { tau[k][s] = best[s] = arr; par[k][s] = { type: 'ride', p, trip, b: bIdx, a: i }; newly.add(s); }
          }
          const ready = tau[k - 1][s] + BOARD_SLACK;
          if (ready < Infinity && (!trip || ready <= trip.abs[i])) {
            const t = patTrips[p].find(t => t.abs[i] >= ready && i < stops.length - 1 && !skipped(t, s));
            if (t && t !== trip) { trip = t; bIdx = i; }
          }
        }
      }
      // walking transfers
      for (const s of [...newly]) {
        const x = sched.xfer[s];
        for (let j = 0; j < x.length; j += 2) {
          const n = x[j], t = tau[k][s] + x[j + 1];
          if (t < best[n] && t < tau[k][n]) { tau[k][n] = best[n] = t; par[k][n] = { type: 'walk', from: s, sec: x[j + 1] }; newly.add(n); }
        }
      }
      marked = newly; if (!marked.size) break;
    }
    // best arrival at destination for each number of rides; prefer fewer transfers unless ≥5 min faster
    let pick = null;
    for (let k = 1; k < tau.length; k++) for (const [s, sec] of egress) {
      const arr = tau[k][s] + sec;
      if (arr < Infinity && (!pick || arr < pick.arr - (k > pick.k ? 300 : 0))) pick = { k, s, arr, egress: sec };
    }
    if (!pick) return null;
    // reconstruct
    const legs = []; let s = pick.s, k = pick.k;
    while (k > 0) {
      const pr = par[k][s];
      if (pr.type === 'walk') { legs.unshift({ type: 'xfer', from: pr.from, to: s, sec: pr.sec }); s = pr.from; continue; }
      const st = sched.patterns[pr.p].s;
      legs.unshift({ type: 'ride', p: pr.p, trip: pr.trip, from: st[pr.b], to: st[pr.a], b: pr.b, a: pr.a, dep: pr.trip.abs[pr.b], arr: pr.trip.abs[pr.a] });
      s = st[pr.b]; k--;
    }
    return { legs, firstStop: s, accessSec: par[0][s].sec, arr: pick.arr, lastStop: pick.s, egressSec: pick.egress };
  }

  // ------------------------------------------------------------ drawing helpers
  const fmt = sec => { sec = Math.round(sec); let h = Math.floor(sec / 3600) % 24, m = Math.floor(sec % 3600 / 60); const ap = h < 12 ? 'a.m.' : 'p.m.'; h = h % 12 || 12; return `${h}:${String(m).padStart(2, '0')} ${ap}`; };
  const mins = sec => Math.max(1, Math.round(sec / 60));
  function shapeSlice(p, fromStop, toStop) {
    const pat = sched.patterns[p], r = APP.routes[pat.r], sh = r.shapes[pat.sh];
    const A = APP.stops[fromStop], B = APP.stops[toStop];
    if (!sh) return [[A.lat, A.lon], [B.lat, B.lon]];
    const near = (pt, from) => { let bi = from, bd = Infinity; for (let i = from; i < sh.length; i++) { const d = (sh[i][0] - pt.lat) ** 2 + (sh[i][1] - pt.lon) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; };
    const i = near(A, 0), j = near(B, i);
    return [[A.lat, A.lon], ...sh.slice(i, j + 1), [B.lat, B.lon]];
  }
  // 10-minute walkshed: every street/trail piece reachable within SHED_M, buffered into one area
  function walkshedPolygon(res) {
    const lines = [];
    for (const [a, b] of G.edges) {
      const da = res.d[a], db = res.d[b];
      if (da > SHED_M && db > SHED_M) continue;
      const [u, v, du] = da <= db ? [a, b, da] : [b, a, db];
      const reach = Math.min(1, (SHED_M - du) / (dist(u, v) || 1));
      lines.push([[G.ll[u][1], G.ll[u][0]], [G.ll[u][1] + (G.ll[v][1] - G.ll[u][1]) * reach, G.ll[u][0] + (G.ll[v][0] - G.ll[u][0]) * reach]]);
    }
    if (!lines.length) return null;
    try {
      const poly = turf.buffer(turf.multiLineString(lines), 55, { units: 'meters', steps: 4 });
      return turf.simplify(poly, { tolerance: 0.00008, highQuality: false });
    } catch (e) { console.error(e); return null; }
  }

  // ------------------------------------------------------------ main entry
  window.planTrip = async function (from, to) {
    const L_ = APP.layers.trip, map = APP.map;
    APP.sheet(`<div class="status"><span class="spinner"></span><div><b>Planning your trip…</b><br><span class="muted">Loading City streets &amp; trails</span></div></div>`);
    await Promise.all([loadGraph(), loadSchedule(), getPreds()]);
    const o = snap(from.lat, from.lon), d = snap(to.lat, to.lon);
    const fromRes = dijkstra(o, Math.max(MAX_ACCESS_M, SHED_M) + 50);
    const toRes = dijkstra(d, MAX_ACCESS_M);
    const access = [], egress = [];
    APP.stops.forEach((s, i) => {
      if (fromRes.d[s.node] <= MAX_ACCESS_M) access.push([i, fromRes.d[s.node] / WALK]);
      if (toRes.d[s.node] <= MAX_ACCESS_M) egress.push([i, toRes.d[s.node] / WALK]);
    });
    const closest = access.slice().sort((a, b) => a[1] - b[1])[0];
    const now = torontoNow(), t0 = APP.departSecs ?? now.secs;
    const plan = access.length && egress.length ? raptor(access, egress, t0, now) : null;
    // compare with walking the whole way
    const direct = dijkstra(o, 12000); const walkSec = direct.d[d] / WALK;
    if (!plan && !isFinite(walkSec)) {
      APP.sheet(`<div class="status"><div><b>No trip found</b><br><span class="muted">No bus connects these addresses right now (service may have ended for the day), and they're too far apart to walk.</span></div></div><button class="go-btn ghost" id="clearTrip">Clear trip</button>`);
      return;
    }

    L_.clearLayers();
    // 10-minute walkshed
    const shed = walkshedPolygon(fromRes);
    if (shed) L.geoJSON(shed, { pane: 'walk', style: { color: '#3A7AEB', weight: 1.5, dashArray: '4 4', fillColor: '#3A7AEB', fillOpacity: .10 } })
      .bindTooltip(`${C.walkshedMinutes}-minute walk`, { sticky: true }).addTo(L_);

    const walkLine = ll => L.polyline(ll, { pane: 'walk', color: '#3A7AEB', weight: 5, opacity: .95, dashArray: '1 9', lineCap: 'round' }).addTo(L_);
    let steps = [], bounds = L.latLngBounds([[from.lat, from.lon], [to.lat, to.lon]]);
    const useTransit = plan && plan.arr - t0 < walkSec - 120;
    if (useTransit) {
      const fs = APP.stops[plan.firstStop], ls = APP.stops[plan.lastStop];
      const p1 = pathTo(fromRes, fs.node); walkLine(p1); p1.forEach(x => bounds.extend(x));
      const p2 = pathTo(toRes, ls.node).reverse(); walkLine(p2); p2.forEach(x => bounds.extend(x));
      steps.push(stepWalk(`Walk to <b>${fs.name}</b> <span class="muted">#${fs.code}</span>`, plan.accessSec, fmt(t0)));
      for (const leg of plan.legs) {
        if (leg.type === 'xfer') { const a = APP.stops[leg.from], b = APP.stops[leg.to]; walkLine([[a.lat, a.lon], [b.lat, b.lon]]); steps.push(stepWalk(`Walk to <b>${b.name}</b> <span class="muted">#${b.code}</span>`, leg.sec)); continue; }
        const pat = sched.patterns[leg.p], r = APP.routes[pat.r];
        const line = shapeSlice(leg.p, leg.from, leg.to);
        L.polyline(line, { pane: 'walk', color: '#fff', weight: 9, opacity: .9 }).addTo(L_);
        L.polyline(line, { pane: 'walk', color: r.c, weight: 6 }).addTo(L_);
        line.forEach(x => bounds.extend(x));
        for (const sidx of [leg.from, leg.to]) { const s = APP.stops[sidx]; L.marker([s.lat, s.lon], { icon: Icons.pin('stop'), pane: 'pins' }).bindPopup(Icons.popEl(`<div class="pop-title">${s.name}</div><span class="muted">Stop #${s.code} · next buses</span><div class="arrivals" data-stopidx="${sidx}"></div>`)).addTo(L_); }
        const live = APP.vehicles?.find(v => v.tripId === leg.trip[3]);
        steps.push(`<li class="step ride"><span class="badge" style="background:${r.c};color:#fff">${r.n}</span>
          <div><b>${sched.headsigns[leg.trip[2]]}</b><br><span class="muted">Board ${fmt(leg.dep)} at ${APP.stops[leg.from].name} · ${leg.a - leg.b} stops · get off ${fmt(leg.arr)} at ${APP.stops[leg.to].name}</span>
          ${live ? `<br><span class="live">● Bus ${live.label || live.id} on this trip</span>` : ''}
          <div class="eta" data-trip="${leg.trip[3]}" data-stop="${APP.stops[leg.from].id}" data-sched="${leg.dep}"></div></div></li>`);
      }
      steps.push(stepWalk(`Walk to <b>${to.name}</b>`, plan.egressSec, fmt(plan.arr)));
    } else {
      const p = pathTo(direct, d); walkLine(p); p.forEach(x => bounds.extend(x));
      steps.push(stepWalk(`Walk to <b>${to.name}</b>${plan ? ' — faster than the bus right now' : ''}`, walkSec, fmt(t0 + walkSec)));
    }
    // closest stop highlight
    if (closest) {
      const s = APP.stops[closest[0]];
      L.marker([s.lat, s.lon], { icon: Icons.pin('stop'), pane: 'pins', zIndexOffset: 500 })
        .bindTooltip(`Closest stop · ${mins(closest[1])} min`, { permanent: true, direction: 'right', offset: [14, -22], className: 'tip' })
        .bindPopup(Icons.popEl(`<div class="pop-title">${s.name}</div><span class="muted">Stop #${s.code} · ${mins(closest[1])} min walk</span><div class="arrivals" data-stopidx="${closest[0]}"></div>`)).addTo(L_);
    }
    L.marker([from.lat, from.lon], { icon: Icons.pin('walk'), pane: 'pins', zIndexOffset: 900 }).bindPopup(from.name).addTo(L_);
    L.marker([to.lat, to.lon], { icon: Icons.pin('dest'), pane: 'pins', zIndexOffset: 900 }).bindPopup(to.name).addTo(L_);

    const arr = useTransit ? plan.arr : t0 + walkSec;
    const cs = closest && APP.stops[closest[0]];
    const legsBadges = useTransit ? plan.legs.filter(l => l.type === 'ride').map(l => { const r = APP.routes[sched.patterns[l.p].r]; return `<span class="badge" style="background:${r.c};color:#fff">${r.n}</span>`; }).join('<span class="chev">›</span>') : '<span class="muted">Walk only</span>';
    APP.sheet(`<div class="sum"><div><div class="big">${mins(arr - t0)} min <span class="legs">${legsBadges}</span></div><span class="muted">${fmt(t0)} → ${fmt(arr)}</span></div>
      <label class="dep">Leave at <input type="time" id="depTime" value="${new Date((t0 % 86400) * 1000).toISOString().slice(11, 16)}"></label></div>
      ${cs ? `<div class="closest"><span class="lg-pin">${Icons.svg('stop', 18, 23)}</span><div>Closest stop: <b>${cs.name}</b> #${cs.code} · ${mins(closest[1])} min walk<div class="arrivals compact" data-stopidx="${closest[0]}" data-n="2"></div></div></div>` : ''}
      <ol class="steps">${steps.join('')}</ol>
      <div class="muted shed-note"><span class="shed-swatch"></span>Shaded area = everywhere within a ${C.walkshedMinutes}-minute walk of your start (streets + trails).</div>
      <button class="go-btn ghost" id="clearTrip">Clear trip</button>`, true);
    $('#depTime').onchange = e => { const [h, m] = e.target.value.split(':'); APP.departSecs = +h * 3600 + +m * 60; window.planTrip(from, to); };
    map.fitBounds(bounds, { paddingTopLeft: [20, $('#planner').offsetHeight + 60], paddingBottomRight: [60, $('#sheet').offsetHeight + 20] });
    refreshArrivals(true);
  };
  function stepWalk(html, sec, time) {
    return `<li class="step walk"><span class="walk-ico">${Icons.svg('walk', 20, 26)}</span><div>${html}<br><span class="muted">${mins(sec)} min walk${time ? ' · ' + time : ''}</span></div></li>`;
  }

  // ------------------------------------------------------------ live arrivals ("bus in N min")
  const liveBase = (new URLSearchParams(location.search).get('feed') || C.realtime.liveBase || '').replace(/\/$/, '');
  let preds = { trips: new Map(), at: 0 }, dayCache = null;
  async function getPreds(force) {
    if (!liveBase || (!force && Date.now() - preds.at < 20000)) return preds;
    try {
      const f = GTFSRT.decode(await fetch(liveBase + '/tripupdates', { cache: 'no-store' }).then(r => { if (!r.ok) throw r.status; return r.arrayBuffer(); }));
      preds = { trips: f.trips, at: Date.now() };
    } catch (e) { console.warn('Trip updates unavailable', e); }
    return preds;
  }
  function tripsByPattern(day) {
    if (dayCache && dayCache.ymd === day.ymd) return dayCache.byPat;
    const svc = activeServices(day.ymd, day.dow), byPat = sched.patterns.map(() => []);
    sched.trips.forEach(t => { if (svc.has(t[1])) byPat[t[0]].push(t); });
    dayCache = { ymd: day.ymd, byPat }; return byPat;
  }
  async function arrivalsAt(stopIdx, n = 4, horizonMin = 90) {
    await loadSchedule(); await getPreds();
    const day = torontoNow(), nowE = Date.now() / 1000, midnight = nowE - day.secs, code = APP.stops[stopIdx].id;
    const byPat = tripsByPattern(day), out = []; out.skipped = new Set();
    for (const [p, i] of sched.stopPats[stopIdx]) {
      const pat = sched.patterns[p]; if (i === pat.s.length - 1) continue; // terminus: bus ends here
      for (const t of byPat[p]) {
        const schedE = midnight + t.abs[i];
        if (schedE < nowE - 1800 || schedE > nowE + horizonMin * 60 + 1800) continue;
        const pr = preds.trips.get(t[3])?.stops.get(code);
        if (pr?.skip) { if (schedE >= nowE - 60 && schedE <= nowE + horizonMin * 60) out.skipped.add(APP.routes[pat.r]); continue; }
        const when = pr?.time || schedE, eta = (when - nowE) / 60;
        if (eta < -0.5 || eta > horizonMin) continue;
        out.push({ r: APP.routes[pat.r], head: sched.headsigns[t[2]], eta, live: !!pr?.time, late: pr?.time ? (pr.time - schedE) / 60 : 0, when });
      }
    }
    const res = out.sort((a, b) => a.eta - b.eta).slice(0, n); res.skipped = out.skipped; return res;
  }
  // drop a leading route number from the headsign ("7 King - Conestoga" → "King - Conestoga")
  const headTxt = a => (a.head.startsWith(a.r.n + ' ') ? a.head.slice(a.r.n.length + 1) : a.head).trim() || a.r.name;
  const etaTxt = m => m < 1 ? 'Now' : Math.round(m) + ' min';
  const lateTxt = l => Math.abs(l) < 1 ? 'on time' : Math.round(Math.abs(l)) + ' min ' + (l > 0 ? 'late' : 'early');
  function arrivalRows(list) {
    const sk = list.skipped && list.skipped.size ? `<div class="skip-note">⚠ ${[...list.skipped].map(r => `<span class="badge" style="background:${r.c};color:#fff">${r.n}</span>`).join(' ')} buses are skipping this stop right now (detour / closure)</div>` : '';
    if (!list.length) return sk || '<div class="muted">No buses in the next 90 min</div>';
    return sk + list.map(a => `<div class="arr"><span class="badge" style="background:${a.r.c};color:#fff">${a.r.n}</span>
      <span class="arr-h">${headTxt(a)}</span>
      <span class="arr-t"><b>${etaTxt(a.eta)}</b><small class="${a.live ? 'is-live' : ''}">${a.live ? '● live · ' + lateTxt(a.late) : 'scheduled'}</small></span></div>`).join('');
  }
  async function refreshArrivals(force) {
    const boxes = document.querySelectorAll('.arrivals[data-stopidx], .eta[data-trip]');
    if (!boxes.length) return;
    await loadSchedule(); await getPreds(force);
    const day = torontoNow(), nowE = Date.now() / 1000, midnight = nowE - day.secs;
    for (const el of boxes) {
      if (el.classList.contains('eta')) {
        const schedE = midnight + +el.dataset.sched, pr = preds.trips.get(el.dataset.trip)?.stops.get(el.dataset.stop);
        const when = pr?.time || schedE, eta = (when - nowE) / 60;
        el.innerHTML = eta < -1 ? '<span class="muted">This bus has left — re-plan for the next one</span>'
          : `<span class="eta-pill${pr?.time ? ' live' : ''}">🚌 ${eta < 1 ? 'Bus arriving now' : 'Bus arrives in ' + Math.round(eta) + ' min'}</span>
             <small class="${pr?.time ? 'is-live' : 'muted'}">${pr?.time ? '● live · ' + lateTxt((pr.time - schedE) / 60) : 'scheduled time'}</small>`;
      } else {
        el.innerHTML = arrivalRows(await arrivalsAt(+el.dataset.stopidx, +(el.dataset.n || 4)));
      }
    }
  }
  // tapping any stop shows its next buses
  (async () => {
    while (!window.APP || !APP.map || !APP.stops) await new Promise(r => setTimeout(r, 100)); // app.js loads data async
    APP.map.on('popupopen', e => {
      const el = e.popup.getElement()?.querySelector('.arrivals'); if (!el) return;
      el.innerHTML = '<div class="muted">Loading next buses…</div>';
      refreshArrivals().then(() => e.popup.update()).catch(console.error);
    });
    APP.arrivalsAt = arrivalsAt;
  })();
  setInterval(() => { if (!document.hidden) refreshArrivals(true).catch(console.error); }, 30000);

  // warm up the network in the background so the first trip is quick
  window.addEventListener('load', () => setTimeout(() => { loadGraph().catch(console.error); }, 1500));
})();
