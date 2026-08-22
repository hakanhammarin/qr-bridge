/* QR-Bridge v2 core codec — base45 (RFC 9285), CRC32, LT fountain code.
   Shared verbatim by sender and receiver. No dependencies. */
(function (root) {
'use strict';

/* ---------- base45 (RFC 9285) ----------
   Charset is exactly the QR alphanumeric-mode set, so encoded output
   packs at 5.5 bits/char instead of byte mode's 8. 2 bytes -> 3 chars. */
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const B45R = (() => { const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B45.length; i++) m[B45.charCodeAt(i)] = i; return m; })();

function b45encode(bytes) {
  const out = [];
  let i = 0;
  for (; i + 1 < bytes.length; i += 2) {
    let v = bytes[i] * 256 + bytes[i + 1];
    const c = v % 45; v = (v - c) / 45;
    const d = v % 45; v = (v - d) / 45;
    out.push(B45[c], B45[d], B45[v]);
  }
  if (i < bytes.length) {
    let v = bytes[i];
    const c = v % 45; v = (v - c) / 45;
    out.push(B45[c], B45[v]);
  }
  return out.join('');
}

function b45decode(str) {
  const n = str.length;
  if (n % 3 === 1) throw new Error('base45: bad length');
  const outLen = ((n / 3) | 0) * 2 + (n % 3 === 2 ? 1 : 0);
  const out = new Uint8Array(outLen);
  let o = 0, i = 0;
  for (; i + 2 < n; i += 3) {
    const a = B45R[str.charCodeAt(i)], b = B45R[str.charCodeAt(i + 1)], c = B45R[str.charCodeAt(i + 2)];
    if (a < 0 || b < 0 || c < 0) throw new Error('base45: bad char');
    const v = a + b * 45 + c * 45 * 45;
    if (v > 0xFFFF) throw new Error('base45: overflow');
    out[o++] = v >> 8; out[o++] = v & 0xFF;
  }
  if (i < n) {
    const a = B45R[str.charCodeAt(i)], b = B45R[str.charCodeAt(i + 1)];
    if (a < 0 || b < 0) throw new Error('base45: bad char');
    const v = a + b * 45;
    if (v > 0xFF) throw new Error('base45: overflow');
    out[o++] = v;
  }
  return out;
}

/* ---------- CRC32 ---------- */
const CRCT = (() => { const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0; } return t; })();

function crc32(buf, start, end) {
  start = start || 0; end = end === undefined ? buf.length : end;
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRCT[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------- deterministic PRNG (xorshift32) ----------
   The receiver must regenerate a packet's exact degree and source-index
   set from the 32-bit seed alone, so the packet never carries an index
   list. Same seed -> same neighbours on both sides. */
function xs32(seed) {
  let s = seed >>> 0; if (s === 0) s = 0x9E3779B9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/* ---------- Robust soliton degree distribution ----------
   Precomputed CDF for a given K. c and delta tune the spike position;
   c=0.03 / delta=0.05 is a standard well-behaved pairing for K in the
   thousands and lands decoding overhead around 1.05-1.10x. */
function solitonCDF(K, c, delta) {
  c = c || 0.03; delta = delta || 0.05;
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1));
  const tau = new Float64Array(K + 1);
  const pivot = Math.max(1, Math.round(K / R));
  for (let d = 1; d < pivot; d++) tau[d] = R / (d * K);
  if (pivot <= K) tau[pivot] = R * Math.log(R / delta) / K;
  let Z = 0;
  for (let d = 1; d <= K; d++) Z += rho[d] + tau[d];
  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) { acc += (rho[d] + tau[d]) / Z; cdf[d] = acc; }
  cdf[K] = 1;
  return cdf;
}

function pickDegree(cdf, K, u) {
  let lo = 1, hi = K;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (u <= cdf[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

/* Neighbour set for a packet — pure function of (seed, K). */
function neighbours(seed, K, cdf) {
  const rnd = xs32(seed);
  const d = Math.min(K, pickDegree(cdf, K, rnd()));
  if (d >= K) { const all = new Int32Array(K); for (let i = 0; i < K; i++) all[i] = i; return all; }
  const set = new Set();
  let guard = 0;
  while (set.size < d && guard++ < d * 40) set.add(Math.floor(rnd() * K) % K);
  return Int32Array.from(set);
}

/* ---------- packet wire format ----------
   off 0  : u8   magic 0xQB -> 0x51
   off 1  : u8   type (0 = data symbol, 1 = manifest JSON)
   off 2  : u16  block index (BE)
   off 4  : u32  seed (BE)          [manifest: 0]
   off 8  : payload (symbolSize bytes, or JSON bytes for manifest)
   end-4  : u32  CRC32 (BE) over bytes [0, end-4)                        */
const MAGIC = 0x51, T_DATA = 0, T_MANIFEST = 1, HDR = 8, TAIL = 4;
const OVERHEAD = HDR + TAIL; // 12 bytes

function packPacket(type, blockIdx, seed, payload) {
  const buf = new Uint8Array(HDR + payload.length + TAIL);
  const dv = new DataView(buf.buffer);
  buf[0] = MAGIC; buf[1] = type;
  dv.setUint16(2, blockIdx, false);
  dv.setUint32(4, seed >>> 0, false);
  buf.set(payload, HDR);
  dv.setUint32(HDR + payload.length, crc32(buf, 0, HDR + payload.length), false);
  return buf;
}

function unpackPacket(buf) {
  if (buf.length < OVERHEAD || buf[0] !== MAGIC) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = buf.length - TAIL;
  if (dv.getUint32(end, false) !== crc32(buf, 0, end)) return null;
  return {
    type: buf[1],
    blockIdx: dv.getUint16(2, false),
    seed: dv.getUint32(4, false),
    payload: buf.subarray(HDR, end)
  };
}

/* ---------- LT encoder over one block ---------- */
function LTEncoder(blockBytes, symbolSize) {
  const K = Math.ceil(blockBytes.length / symbolSize);
  const cdf = solitonCDF(K);
  return {
    K: K,
    symbolSize: symbolSize,
    // seed is supplied by the caller so the stream is reproducible
    encode: function (seed) {
      const idx = neighbours(seed, K, cdf);
      const out = new Uint8Array(symbolSize);
      for (let n = 0; n < idx.length; n++) {
        const base = idx[n] * symbolSize;
        const lim = Math.min(symbolSize, blockBytes.length - base);
        for (let j = 0; j < lim; j++) out[j] ^= blockBytes[base + j];
      }
      return out;
    }
  };
}

/* ---------- LT decoder (peeling) over one block ---------- */
function LTDecoder(K, symbolSize, blockLength) {
  const cdf = solitonCDF(K);
  const solved = new Array(K).fill(null);
  let solvedCount = 0;
  const seenSeeds = new Set();
  /* adjacency: source index -> Set of live packets still referencing it.
     Avoids an O(pending) scan on every settle. */
  const adj = new Map();
  const ripple = [];            // [srcIndex, data] pairs waiting to propagate

  function attach(p) { for (const i of p.rem) {
    let s = adj.get(i); if (!s) { s = new Set(); adj.set(i, s); } s.add(p); } }
  function detach(p, i) { const s = adj.get(i); if (s) { s.delete(p); if (!s.size) adj.delete(i); } }

  /* XOR every already-solved neighbour out of p, in place. */
  function reduce(p) {
    for (const i of Array.from(p.rem)) {
      const s = solved[i];
      if (s) { for (let j = 0; j < symbolSize; j++) p.data[j] ^= s[j]; p.rem.delete(i); }
    }
  }

  /* Iterative peeling. Never mutates a collection it is iterating:
     newly-solved symbols go on the ripple queue, and packets are
     retired by a dead flag rather than by splicing. */
  function drain() {
    while (ripple.length) {
      const [i, data] = ripple.pop();
      if (solved[i]) continue;
      solved[i] = data; solvedCount++;
      const set = adj.get(i);
      if (!set) continue;
      adj.delete(i);
      for (const p of set) {
        if (p.dead || !p.rem.has(i)) continue;
        for (let j = 0; j < symbolSize; j++) p.data[j] ^= data[j];
        p.rem.delete(i);
        if (p.rem.size === 1) {
          const only = p.rem.values().next().value;
          p.dead = true; detach(p, only);
          ripple.push([only, p.data]);
        } else if (p.rem.size === 0) {
          p.dead = true;
        }
      }
    }
  }

  return {
    K: K,
    get solvedCount() { return solvedCount; },
    get done() { return solvedCount === K; },
    /* returns true if this packet was new and useful */
    add: function (seed, data) {
      if (seenSeeds.has(seed)) return false;
      seenSeeds.add(seed);
      const p = { data: Uint8Array.from(data), rem: new Set(neighbours(seed, K, cdf)), dead: false };
      reduce(p);
      if (p.rem.size === 0) return false;
      if (p.rem.size === 1) {
        p.dead = true;
        ripple.push([p.rem.values().next().value, p.data]);
      } else {
        attach(p);
      }
      drain();
      return true;
    },
    assemble: function () {
      if (solvedCount !== K) return null;
      const out = new Uint8Array(blockLength);
      for (let i = 0; i < K; i++) {
        const off = i * symbolSize;
        const lim = Math.min(symbolSize, blockLength - off);
        out.set(solved[i].subarray(0, lim), off);
      }
      return out;
    }
  };
}

const api = { b45encode, b45decode, crc32, xs32, solitonCDF, neighbours,
              packPacket, unpackPacket, LTEncoder, LTDecoder,
              MAGIC, T_DATA, T_MANIFEST, HDR, TAIL, OVERHEAD };

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.QRBCore = api;

})(typeof self !== 'undefined' ? self : this);
