/* --- worker: raw tile pixels -> jsQR -> decoded alphanumeric string --- */
var decode = (typeof jsQR === 'function') ? jsQR : (self.jsQR && self.jsQR.default) || self.jsQR;

/* Stretch the luminance histogram between its 2nd and 98th percentiles.
   jsQR binarizes adaptively already, but on a low-contrast frame — panel
   dimming, glare, slight overexposure — the local windows it uses can all sit
   inside a narrow band and threshold badly. Renormalising first costs about a
   millisecond and recovers frames that would otherwise be thrown away. */
function stretch(buf, w, h) {
  var n = w * h, hist = new Uint32Array(256), i, p, v;
  for (i = 0, p = 0; i < n; i++, p += 4) hist[(buf[p]*0.299 + buf[p+1]*0.587 + buf[p+2]*0.114) | 0]++;
  var lo = 0, hi = 255, acc = 0, loT = n * 0.02, hiT = n * 0.98;
  for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= loT) { lo = i; break; } }
  acc = 0;
  for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= hiT) { hi = i; break; } }
  if (hi - lo < 8 || (lo < 12 && hi > 243)) return null;      /* nothing to gain */
  var out = new Uint8ClampedArray(buf.length), k = 255 / (hi - lo);
  for (i = 0, p = 0; i < n; i++, p += 4) {
    v = (buf[p]*0.299 + buf[p+1]*0.587 + buf[p+2]*0.114 - lo) * k;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    out[p] = out[p+1] = out[p+2] = v; out[p+3] = 255;
  }
  return out;
}

self.onmessage = function (e) {
  var d = e.data;
  var res = null;
  var raw = new Uint8ClampedArray(d.buf);
  try {
    res = decode(raw, d.w, d.h, { inversionAttempts: 'dontInvert' });
  } catch (err) { res = null; }
  if (!res) {
    try {
      var st = stretch(raw, d.w, d.h);
      if (st) res = decode(st, d.w, d.h, { inversionAttempts: 'dontInvert' });
    } catch (err2) {}
  }
  /* Return the code's corner points too. Their spacing against a known module
     count is a direct measurement of pixels-per-module at the sensor — the one
     number that decides whether this link works at all. */
  var loc = null;
  if (res && res.location) {
    var L = res.location;
    var dx = L.topRightCorner.x - L.topLeftCorner.x;
    var dy = L.topRightCorner.y - L.topLeftCorner.y;
    var dx2 = L.bottomLeftCorner.x - L.topLeftCorner.x;
    var dy2 = L.bottomLeftCorner.y - L.topLeftCorner.y;
    loc = { w: Math.sqrt(dx*dx + dy*dy), h: Math.sqrt(dx2*dx2 + dy2*dy2),
            tilt: Math.atan2(dy, dx) * 180 / Math.PI };
  }
  self.postMessage({ id: d.id, tile: d.tile, text: res ? res.data : null, loc: loc, scan: d.scan || 1 });
};
