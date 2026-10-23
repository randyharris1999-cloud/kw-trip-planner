// Minimal GTFS-Realtime protobuf decoder (VehiclePositions + Alerts) — no dependencies.
// Swap the URL in config to a live feed (via CORS proxy) later; the decoder stays the same.
(function (global) {
  function reader(buf) {
    const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let i = 0;
    function varint() {
      let r = 0, s = 0, c;
      do { c = b[i++]; r += (c & 0x7f) * Math.pow(2, s); s += 7; } while (c & 0x80);
      return r;
    }
    function fields(start, end) {
      const out = []; i = start;
      while (i < end) {
        const k = varint(), f = Math.floor(k / 8), t = k & 7; let v;
        if (t === 0) v = varint();
        else if (t === 1) { v = dv.getFloat64(i, true); i += 8; }
        else if (t === 5) { v = dv.getFloat32(i, true); i += 4; }
        else if (t === 2) { const n = varint(); v = [i, i + n]; i += n; }
        else throw new Error('wire type ' + t);
        out.push([f, t, v]);
      }
      return out;
    }
    const str = r => new TextDecoder().decode(b.subarray(r[0], r[1]));
    const msg = r => { const save = i; const o = fields(r[0], r[1]); i = save; return o; };
    return { fields, str, msg, len: b.length };
  }
  const get = (fs, n) => fs.filter(x => x[0] === n).map(x => x[2]);

  function decode(buf) {
    const R = reader(buf);
    const top = R.fields(0, R.len);
    const header = R.msg(get(top, 1)[0] || [0, 0]);
    const feed = { timestamp: get(header, 3)[0] || 0, vehicles: [], alerts: [], trips: new Map() };
    for (const er of get(top, 2)) {
      const e = R.msg(er);
      const vp = get(e, 4)[0];
      if (vp) {
        const v = R.msg(vp), o = { id: R.str(get(e, 1)[0]) };
        const trip = get(v, 1)[0];
        if (trip) { const t = R.msg(trip); o.tripId = get(t, 1)[0] && R.str(get(t, 1)[0]); o.routeId = get(t, 5)[0] && R.str(get(t, 5)[0]); }
        const pos = get(v, 2)[0];
        if (pos) { const p = R.msg(pos); o.lat = get(p, 1)[0]; o.lon = get(p, 2)[0]; o.bearing = get(p, 3)[0]; o.speed = get(p, 5)[0]; }
        o.timestamp = get(v, 5)[0];
        o.stopId = get(v, 7)[0] && R.str(get(v, 7)[0]);
        const veh = get(v, 8)[0];
        if (veh) { const d = R.msg(veh); o.label = get(d, 2)[0] && R.str(get(d, 2)[0]); }
        if (o.lat) feed.vehicles.push(o);
      }
      const tu = get(e, 3)[0];
      if (tu) {
        const t = R.msg(tu), td = R.msg(get(t, 1)[0] || [0, 0]);
        const tripId = get(td, 1)[0] && R.str(get(td, 1)[0]);
        if (tripId) {
          const stops = new Map();
          for (const su of get(t, 2)) {
            const u = R.msg(su), sid = get(u, 4)[0] && R.str(get(u, 4)[0]);
            if (!sid) continue;
            const ev = get(u, 2)[0] || get(u, 3)[0]; // arrival, else departure
            const evf = ev ? R.msg(ev) : [];
            stops.set(sid, { time: get(evf, 2)[0] || null, delay: get(evf, 1)[0], skip: get(u, 5)[0] === 1 });
          }
          feed.trips.set(tripId, { routeId: get(td, 5)[0] && R.str(get(td, 5)[0]), stops });
        }
      }
      const al = get(e, 5)[0];
      if (al) {
        const a = R.msg(al);
        const ts = r => { const t = get(R.msg(r), 1)[0]; return t ? R.str(get(R.msg(t), 1)[0]) : ''; };
        const routes = get(a, 5).map(ie => get(R.msg(ie), 2)[0]).filter(Boolean).map(R.str);
        feed.alerts.push({ header: get(a, 10)[0] ? ts(get(a, 10)[0]) : '', text: get(a, 11)[0] ? ts(get(a, 11)[0]) : '', routes });
      }
    }
    return feed;
  }
  global.GTFSRT = { decode };
})(window);
