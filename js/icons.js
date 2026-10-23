// Pin symbology copied from the reference screenshots:
//  green teardrop + white leaf  (bus stop)       body #2EAD5E, mint halo #C8F6D9
//  dark-green teardrop + tree   (trail)          body #136935, halo #D8F0E0
//  blue teardrop + walker       (start / you)    body #3A7AEB, halo #D0E6FF
(function (g) {
  const PIN = 'M17 2.5C8.7 2.5 2.5 8.9 2.5 17c0 6.2 3.9 10.6 8.4 14.6L17 41.5l6.1-9.9C27.6 27.6 31.5 23.2 31.5 17 31.5 8.9 25.3 2.5 17 2.5z';
  const GLYPH = {
    leaf: '<path d="M10.5 22.5c0-7 5-11.8 13-12-0.2 8-5 13-12 13-.4 0-.7-.4-1-1z" fill="#fff"/><path d="M11.5 22.5c3.2-4.1 6.6-7.2 10.5-10.3" stroke="VAR" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
    tree: '<path d="M17 8.5l-5 6h2.8l-3.8 4.8h3.4L10.5 24h5.3v3h2.4v-3h5.3l-3.9-4.7h3.4l-3.8-4.8h2.8z" fill="#fff"/>',
    walk: '<circle cx="17.6" cy="9.6" r="2.2" fill="#fff"/><path d="M15.4 12.8l-2.6 1.5-.9 4 1.7.4.7-2.9 1-.5-1.2 5.6-.9 5.3h2l.8-4.3 1.6 2v4.3h1.9v-5.3l-1.8-2.4.5-2.7.6 1.3 2.6 1.6.9-1.4-2.3-1.5-1.1-2.6c-.4-.9-1.2-1.4-2.1-1.4-.4 0-.7.1-1.2.3z" fill="#fff"/>',
    flag: '<path d="M12.5 8.5v18h2v-7h7.5l-1.8-3.6L22 12.4h-7.5V8.5z" fill="#fff"/>'
  };
  const STYLE = {
    stop:  { hi: '#3EC36D', mid: '#2EAD5E', lo: '#1A9546', halo: '#C8F6D9', glyph: 'leaf' },
    dest:  { hi: '#3EC36D', mid: '#2EAD5E', lo: '#1A9546', halo: '#C8F6D9', glyph: 'flag' },
    trail: { hi: '#1C7A42', mid: '#136935', lo: '#0C5A2D', halo: '#D8F0E0', glyph: 'tree' },
    walk:  { hi: '#4A88F2', mid: '#3A7AEB', lo: '#2F6AD8', halo: '#D0E6FF', glyph: 'walk' }
  };
  let n = 0;
  function svg(kind, w = 34, h = 44) {
    const s = STYLE[kind], id = 'pg' + (n++);
    return `<svg viewBox="0 0 34 44" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${s.hi}"/><stop offset=".55" stop-color="${s.mid}"/><stop offset="1" stop-color="${s.lo}"/></linearGradient></defs>
      <path d="${PIN}" fill="url(#${id})" stroke="${s.halo}" stroke-width="3" stroke-linejoin="round"/>
      ${GLYPH[s.glyph].replace('VAR', s.mid)}</svg>`;
  }
  function pin(kind) {
    return L.divIcon({ className: 'pin', html: svg(kind), iconSize: [34, 44], iconAnchor: [17, 42], popupAnchor: [0, -38] });
  }
  function bus(route, bearing) {
    const c = route ? route.c : '#4F832E', t = route ? route.t : '#000';
    const txt = (route ? route.n : '?').replace(/\s*U$/, 'U');
    const fg = luminance(c) > 0.55 ? '#1b1b1b' : '#fff';
    const head = bearing != null ? `<span class="h" style="transform:rotate(${bearing}deg);--c:${c}"><i></i></span>` : '';
    return L.divIcon({ className: 'busmk', html: `${head}<span class="b" style="background:${c};color:${fg}">${txt}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
  }
  function luminance(hex) {
    const v = parseInt(hex.slice(1), 16), r = v >> 16, gg = (v >> 8) & 255, b = v & 255;
    return (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
  }
  // popup content as a DOM node, so Leaflet's popup.update() keeps live content injected later
  const popEl = html => { const d = document.createElement('div'); d.innerHTML = html; return d; };
  g.Icons = { pin, bus, svg, popEl };
})(window);
