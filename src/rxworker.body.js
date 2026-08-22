/* --- worker: raw tile pixels -> jsQR -> decoded alphanumeric string --- */
var decode = (typeof jsQR === 'function') ? jsQR : (self.jsQR && self.jsQR.default) || self.jsQR;

self.onmessage = function (e) {
  var d = e.data;
  var res = null;
  try {
    res = decode(new Uint8ClampedArray(d.buf), d.w, d.h, { inversionAttempts: 'dontInvert' });
  } catch (err) { res = null; }
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
