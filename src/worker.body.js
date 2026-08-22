/* --- worker: packet bytes -> base45 -> QR (alphanumeric) -> packed module bits --- */
var B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function b45encode(bytes) {
  var out = [], i = 0, v, c, d;
  for (; i + 1 < bytes.length; i += 2) {
    v = bytes[i] * 256 + bytes[i + 1];
    c = v % 45; v = (v - c) / 45;
    d = v % 45; v = (v - d) / 45;
    out.push(B45[c], B45[d], B45[v]);
  }
  if (i < bytes.length) { v = bytes[i]; c = v % 45; v = (v - c) / 45; out.push(B45[c], B45[v]); }
  return out.join('');
}

self.onmessage = function (e) {
  var d = e.data;
  var str = b45encode(d.bytes);
  var qr = qrcode(d.ver, d.ec);
  qr.addData(str, 'Alphanumeric');
  qr.make();
  var n = qr.getModuleCount();
  var bits = new Uint8Array(Math.ceil(n * n / 8));
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) { var k = r * n + c; bits[k >> 3] |= (1 << (k & 7)); }
    }
  }
  self.postMessage({ id: d.id, n: n, bits: bits }, [bits.buffer]);
};
