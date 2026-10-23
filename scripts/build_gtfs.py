"""Build compact GTFS JSON for the KW (Grand River Transit) web app.
Usage: python3 scripts/build_gtfs.py <path-to-unzipped-gtfs> <out-dir>
"""
import csv, json, sys, os, collections
src, out = sys.argv[1], sys.argv[2]
rd = lambda n: list(csv.DictReader(open(os.path.join(src, n), encoding='utf-8-sig'))) if os.path.exists(os.path.join(src, n)) else []
def secs(t):
    t = (t or '').strip()
    if not t: return None
    h, m, s = t.split(':'); return int(h)*3600+int(m)*60+int(s)

routes = rd('routes.txt'); trips = rd('trips.txt'); stops = rd('stops.txt')
# --- stops
stop_idx = {}; S = []
for s in stops:
    if s.get('location_type', '') not in ('', '0'): continue
    stop_idx[s['stop_id']] = len(S)
    S.append([s.get('stop_code') or s['stop_id'], s['stop_name'], round(float(s['stop_lat']), 6), round(float(s['stop_lon']), 6), s['stop_id']])
# --- shapes (Douglas-Peucker, ~3 m)
shp = collections.defaultdict(list)
for r in rd('shapes.txt'):
    shp[r['shape_id']].append((int(r['shape_pt_sequence']), float(r['shape_pt_lat']), float(r['shape_pt_lon'])))
def dp(pts, eps=0.00003):
    if len(pts) < 3: return pts
    (y1, x1), (y2, x2) = pts[0], pts[-1]
    dx, dy = x2-x1, y2-y1; L = (dx*dx+dy*dy) or 1e-18
    best, bi = 0, 0
    for i in range(1, len(pts)-1):
        y, x = pts[i]; t = max(0, min(1, ((x-x1)*dx+(y-y1)*dy)/L))
        d = ((x1+t*dx-x)**2+(y1+t*dy-y)**2)**.5
        if d > best: best, bi = d, i
    if best > eps: return dp(pts[:bi+1], eps)[:-1]+dp(pts[bi:], eps)
    return [pts[0], pts[-1]]
sys.setrecursionlimit(10000)
# --- routes + their shapes (only shapes used by trips)
route_shapes = collections.defaultdict(set)
for t in trips:
    if t.get('shape_id') and t['shape_id'] in shp: route_shapes[t['route_id']].add(t['shape_id'])
R = {}
for r in routes:
    lines = []
    for sid in sorted(route_shapes.get(r['route_id'], [])):
        pts = [(round(a, 5), round(b, 5)) for _, a, b in sorted(shp[sid])]
        lines.append(dp(pts))
    R[r['route_id']] = {'n': r['route_short_name'], 'name': r['route_long_name'],
                       'c': '#'+(r.get('route_color') or '0F6EB4'), 't': '#'+(r.get('route_text_color') or 'FFFFFF'),
                       'shapes': lines}
# --- services
svc = {}
for c in rd('calendar.txt'):
    svc[c['service_id']] = {'days': [int(c[d]) for d in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')],
                            'start': c['start_date'], 'end': c['end_date'], 'add': [], 'rem': []}
for c in rd('calendar_dates.txt'):
    s = svc.setdefault(c['service_id'], {'days': [0]*7, 'start': '', 'end': '', 'add': [], 'rem': []})
    s['add' if c['exception_type'] == '1' else 'rem'].append(c['date'])
# --- schedule: patterns + trips
trip_info = {t['trip_id']: t for t in trips}
st = collections.defaultdict(list)
for r in rd('stop_times.txt'):
    if r['stop_id'] not in stop_idx: continue
    a, d = secs(r['arrival_time']), secs(r['departure_time'])
    st[r['trip_id']].append((int(r['stop_sequence']), r['stop_id'], a if a is not None else d, d if d is not None else a))
pat_idx = {}; P = []; T = []
heads = []; head_idx = {}
for tid, rows in st.items():
    rows.sort(); ti = trip_info.get(tid)
    if not ti or len(rows) < 2 or rows[0][3] is None or rows[-1][2] is None: continue
    # interpolate untimed stops between timepoints
    i = 0
    while i < len(rows):
        if rows[i][3] is None:
            j = i
            while rows[j][3] is None: j += 1
            t0, t1, n = rows[i-1][3], rows[j][2], j - i + 1
            for k in range(i, j):
                v = round(t0 + (t1 - t0) * (k - i + 1) / n); rows[k] = (rows[k][0], rows[k][1], v, v)
            i = j
        i += 1
    seq = tuple(stop_idx[s] for _, s, _, _ in rows)
    key = (ti['route_id'], seq)
    if key not in pat_idx:
        shapes_sorted = sorted(route_shapes.get(ti['route_id'], []))
        sh = shapes_sorted.index(ti.get('shape_id')) if ti.get('shape_id') in shapes_sorted else -1
        pat_idx[key] = len(P); P.append({'r': ti['route_id'], 's': list(seq), 'sh': sh})
    h = ti.get('trip_headsign') or ''
    if h not in head_idx: head_idx[h] = len(heads); heads.append(h)
    t0 = rows[0][3]; times = [t0] + [rows[i][3]-rows[i-1][3] for i in range(1, len(rows))]
    T.append([pat_idx[key], ti['service_id'], head_idx[h], tid, times])
os.makedirs(out, exist_ok=True)
json.dump({'stops': S}, open(os.path.join(out, 'stops.json'), 'w'), separators=(',', ':'))
json.dump(R, open(os.path.join(out, 'routes.json'), 'w'), separators=(',', ':'))
json.dump({'services': svc, 'patterns': P, 'headsigns': heads, 'trips': T}, open(os.path.join(out, 'schedule.json'), 'w'), separators=(',', ':'))
print(len(S), 'stops', len(R), 'routes', len(P), 'patterns', len(T), 'trips')
