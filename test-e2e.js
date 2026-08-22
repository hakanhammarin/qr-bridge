/* End-to-end: real file -> sender's exact packet+render path -> a simulated
   camera (affine resample, defocus blur, sensor noise, dropped frames) ->
   receiver's exact tile-crop + jsQR + LT path -> byte-for-byte comparison
   and root-hash verification. No browser, no camera, fully deterministic. */
const qrcode = require('qrcode-generator');
const jsQR = require('jsqr').default || require('jsqr');
const crypto = require('crypto');
const C = require('./core.js');

const ALNUM_CAP = { 27:{L:2132,M:1637,Q:1179}, 33:{L:3009,M:2369,Q:1663}, 40:{L:4296,M:3391,Q:2420} };

/* deterministic RNG so a failure is reproducible */
let _s = 12345;
const rnd = () => { _s ^= _s << 13; _s >>>= 0; _s ^= _s >>> 17; _s ^= _s << 5; _s >>>= 0; return _s / 4294967296; };

/* ---------- sender side ---------- */
function plan(fileSize, ver, ec, gx, gy, hz, fpc, R) {
  const maxBytes = Math.floor(ALNUM_CAP[ver][ec] / 3) * 2;
  let sym = maxBytes - C.OVERHEAD; sym -= sym % 2;
  const MAX_BLOCK = 4 << 20;
  const blocks = Math.max(1, Math.ceil(fileSize / MAX_BLOCK));
  const bsize = Math.ceil(fileSize / blocks);
  const K = Math.ceil(bsize / sym);
  return { ver, ec, gx, gy, cells: gx*gy, sym, blocks, bsize, K,
           perBlock: Math.ceil(K * R), fps: hz/fpc, R };
}
function mkSeed(sweep, block, n) {
  let h = (sweep * 0x9E3779B1) ^ (block * 0x85EBCA77) ^ (n * 0xC2B2AE3D);
  h ^= h >>> 15; h = Math.imul(h, 0x2545F491); h ^= h >>> 13;
  return h >>> 0;
}

/* ---------- rendering (mirrors sender blit(): quiet zone 4, integer scale) ---------- */
function qrBits(pktBytes, ver, ec) {
  const q = qrcode(ver, ec);
  q.addData(C.b45encode(pktBytes), 'Alphanumeric');
  q.make();
  return q;
}
function renderFrame(qrs, gx, gy, W, H) {
  const img = new Uint8Array(W * H).fill(255);       /* 8-bit grey display buffer */
  const cellW = Math.floor(W / gx), cellH = Math.floor(H / gy);
  for (let i = 0; i < qrs.length; i++) {
    const q = qrs[i], n = q.getModuleCount(), quiet = 4, full = n + quiet*2;
    const scale = Math.max(1, Math.floor(Math.min(cellW, cellH) / full));
    const size = scale * full;
    const ox = (i % gx) * cellW + ((cellW - size) >> 1);
    const oy = ((i / gx) | 0) * cellH + ((cellH - size) >> 1);
    for (let r = 0; r < full; r++) for (let c = 0; c < full; c++) {
      const dark = (r >= quiet && c >= quiet && r < quiet+n && c < quiet+n) && q.isDark(r-quiet, c-quiet);
      if (!dark) continue;
      for (let y = 0; y < scale; y++) {
        const row = (oy + r*scale + y) * W + ox + c*scale;
        for (let x = 0; x < scale; x++) img[row + x] = 0;
      }
    }
  }
  return img;
}

/* ---------- camera simulation ----------
   Nothing in a real capture is pixel-aligned: the phone sits at a slight
   angle, the lens is never perfectly focused, and the sensor adds noise.
   All three are applied here so a "passes in theory" geometry cannot pass
   this test by accident. */
function capture(src, W, H, cw, ch, opt) {
  const { rotDeg, scale, dx, dy, blur, noise, gamma } = opt;
  const th = rotDeg * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
  const out = new Uint8Array(cw * ch);
  const cx = cw/2, cy = ch/2, sx0 = W/2 + dx, sy0 = H/2 + dy;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    /* inverse map camera pixel -> display pixel, bilinear */
    const ux = (x - cx) / scale, uy = (y - cy) / scale;
    const sxf = sx0 + ux*cos - uy*sin, syf = sy0 + ux*sin + uy*cos;
    const ix = Math.floor(sxf), iy = Math.floor(syf);
    let v = 255;
    if (ix >= 0 && iy >= 0 && ix < W-1 && iy < H-1) {
      const fx = sxf - ix, fy = syf - iy;
      const a = src[iy*W+ix], b = src[iy*W+ix+1], c2 = src[(iy+1)*W+ix], d = src[(iy+1)*W+ix+1];
      v = a*(1-fx)*(1-fy) + b*fx*(1-fy) + c2*(1-fx)*fy + d*fx*fy;
    }
    out[y*cw+x] = v;
  }
  /* separable box blur ~ defocus */
  if (blur > 0) {
    const tmp = new Uint8Array(cw*ch), r = blur;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const xx = x+k; if (xx>=0&&xx<cw){s+=out[y*cw+xx];n++;} }
      tmp[y*cw+x] = s/n;
    }
    for (let x = 0; x < cw; x++) for (let y = 0; y < ch; y++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y+k; if (yy>=0&&yy<ch){s+=tmp[yy*cw+x];n++;} }
      out[y*cw+x] = s/n;
    }
  }
  for (let i = 0; i < out.length; i++) {
    let v = out[i] / 255;
    if (gamma !== 1) v = Math.pow(v, gamma);
    v = v * 255 + (rnd() - 0.5) * 2 * noise;
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/* grey -> RGBA for jsQR */
function rgba(grey, w, h) {
  const d = new Uint8ClampedArray(w*h*4);
  for (let i = 0; i < w*h; i++) { d[i*4]=d[i*4+1]=d[i*4+2]=grey[i]; d[i*4+3]=255; }
  return d;
}
function cropTile(src, W, H, gx, gy, tx, ty, ov) {
  const tw = W/gx, th = H/gy;
  const x0 = Math.max(0, Math.floor(tx*tw - tw*ov)), y0 = Math.max(0, Math.floor(ty*th - th*ov));
  const x1 = Math.min(W, Math.ceil((tx+1)*tw + tw*ov)), y1 = Math.min(H, Math.ceil((ty+1)*th + th*ov));
  const w = x1-x0, h = y1-y0, out = new Uint8Array(w*h);
  for (let y = 0; y < h; y++) out.set(src.subarray((y0+y)*W + x0, (y0+y)*W + x1), y*w);
  return { buf: out, w, h };
}

const sha = b => crypto.createHash('sha256').update(b).digest();

/* ---------- the run ---------- */
async function run(cfg) {
  const { fileSize, ver, ec, gx, gy, dispW, dispH, camW, camH, lossRate, optics, label } = cfg;
  const p = plan(fileSize, ver, ec, gx, gy, 60, 5, cfg.R);
  const file = crypto.randomBytes(fileSize);

  /* sender: root hash over per-block digests */
  const digests = Buffer.alloc(p.blocks * 32);
  for (let i = 0; i < p.blocks; i++) {
    const off = i*p.bsize, len = Math.min(p.bsize, fileSize - off);
    sha(file.subarray(off, off+len)).copy(digests, i*32);
  }
  const root = sha(digests).toString('hex');

  /* receiver state */
  const decoders = [], parts = new Array(p.blocks).fill(null);
  for (let i = 0; i < p.blocks; i++) {
    const len = Math.min(p.bsize, fileSize - i*p.bsize);
    decoders.push(C.LTDecoder(Math.ceil(len/p.sym), p.sym, len));
  }

  const encoders = [];
  for (let i = 0; i < p.blocks; i++) {
    const off = i*p.bsize, len = Math.min(p.bsize, fileSize - off);
    encoders.push(C.LTEncoder(file.subarray(off, off+len), p.sym));
  }

  let frames = 0, dropped = 0, attempts = 0, decoded = 0, useful = 0, crcRejects = 0;
  let sweep = 1, block = 0, n = 0, doneBlocks = 0;
  const maxFrames = Math.ceil(p.perBlock * p.blocks / p.cells) * 2 + 20;

  while (doneBlocks < p.blocks && frames < maxFrames) {
    /* --- sender builds one frame --- */
    const qrs = [], metas = [];
    for (let c = 0; c < p.cells; c++) {
      if (n >= p.perBlock) { block++; n = 0; if (block >= p.blocks) { block = 0; sweep++; } }
      const seed = mkSeed(sweep, block, n++);
      const pkt = C.packPacket(C.T_DATA, block, seed, encoders[block].encode(seed));
      qrs.push(qrBits(pkt, ver, ec)); metas.push({block, seed});
    }
    frames++;
    const disp = renderFrame(qrs, gx, gy, dispW, dispH);

    /* --- camera --- */
    if (rnd() < lossRate) { dropped++; continue; }
    const cam = capture(disp, dispW, dispH, camW, camH, optics);

    /* --- receiver --- */
    for (let ty = 0; ty < gy; ty++) for (let tx = 0; tx < gx; tx++) {
      const t = cropTile(cam, camW, camH, gx, gy, tx, ty, p.cells > 1 ? 0.06 : 0);
      attempts++;
      const res = jsQR(rgba(t.buf, t.w, t.h), t.w, t.h, {inversionAttempts: 'dontInvert'});
      if (!res) continue;
      decoded++;
      let pkt;
      try { pkt = C.unpackPacket(C.b45decode(res.data)); } catch (e) { crcRejects++; continue; }
      if (!pkt) { crcRejects++; continue; }
      const d = decoders[pkt.blockIdx];
      if (!d || parts[pkt.blockIdx]) continue;
      if (d.add(pkt.seed, pkt.payload)) useful++;
      if (d.done) { parts[pkt.blockIdx] = Buffer.from(d.assemble()); decoders[pkt.blockIdx] = null; doneBlocks++; }
    }
  }

  const complete = doneBlocks === p.blocks;
  let match = false, rootOk = false;
  if (complete) {
    const rebuilt = Buffer.concat(parts);
    match = Buffer.compare(rebuilt, file) === 0;
    const d2 = Buffer.alloc(p.blocks*32);
    parts.forEach((b, i) => sha(b).copy(d2, i*32));
    rootOk = sha(d2).toString('hex') === root;
  }
  const full = (4*ver+17) + 8;
  const cellW = Math.floor(camW/gx), cellH = Math.floor(camH/gy);
  const pxMod = Math.max(1, Math.floor(Math.min(Math.floor(dispW/gx), Math.floor(dispH/gy)) / full))
                * (camW/dispW);
  return { label, p, frames, dropped, attempts, decoded, useful, crcRejects, complete, match, rootOk,
           pxMod, readRate: decoded/attempts };
}

/* ---------- scenarios ---------- */
const OPTICS_GOOD  = { rotDeg: 0.35, scale: 1.0,  dx: 0.4, dy: -0.3, blur: 0, noise: 3,  gamma: 1.0 };
const OPTICS_REAL  = { rotDeg: 0.9,  scale: 0.98, dx: 1.7, dy: 1.1,  blur: 1, noise: 8,  gamma: 1.1 };
const OPTICS_ROUGH = { rotDeg: 1.8,  scale: 0.95, dx: 3.0, dy: -2.5, blur: 1, noise: 16, gamma: 1.25 };

(async () => {
  const scenarios = [
    { label: '1x1 v33-M  1080p  clean',   fileSize: 120*1024, ver:33, ec:'M', gx:1, gy:1,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.00, R:1.45, optics:OPTICS_GOOD },
    { label: '2x2 v33-M  1080p  realistic',fileSize: 180*1024, ver:33, ec:'M', gx:2, gy:2,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.10, R:1.45, optics:OPTICS_REAL },
    { label: '2x2 v33-M  1080p  rough',   fileSize: 140*1024, ver:33, ec:'M', gx:2, gy:2,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.20, R:1.75, optics:OPTICS_ROUGH },
    { label: '2x2 v40-M  4K disp/4K cam', fileSize: 110*1024, ver:40, ec:'M', gx:2, gy:2,
      dispW:3840, dispH:2160, camW:3840, camH:2160, lossRate:0.10, R:1.45, optics:OPTICS_REAL },
    { label: '3x2 v33-M  4K disp/4K cam', fileSize: 110*1024, ver:33, ec:'M', gx:3, gy:2,
      dispW:3840, dispH:2160, camW:3840, camH:2160, lossRate:0.10, R:1.45, optics:OPTICS_REAL },
    { label: '2x2 v40-M  4K disp/1080 cam',fileSize: 90*1024, ver:40, ec:'M', gx:2, gy:2,
      dispW:3840, dispH:2160, camW:1920, camH:1080, lossRate:0.05, R:1.60, optics:OPTICS_REAL },
    { label: '2x2 v33-M  1080p  no-defocus', fileSize: 140*1024, ver:33, ec:'M', gx:2, gy:2,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.10, R:1.45, optics:OPTICS_GOOD },
    { label: '2x2 v27-M  1080p  realistic',  fileSize: 140*1024, ver:27, ec:'M', gx:2, gy:2,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.10, R:1.45, optics:OPTICS_REAL },
    { label: '2x1 v33-M  1080p  realistic',  fileSize: 140*1024, ver:33, ec:'M', gx:2, gy:1,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.10, R:1.45, optics:OPTICS_REAL },
    { label: '2x2 v27-M  1080p  rough',      fileSize: 140*1024, ver:27, ec:'M', gx:2, gy:2,
      dispW:1920, dispH:1080, camW:1920, camH:1080, lossRate:0.20, R:1.75, optics:OPTICS_ROUGH },
  ];

  const only = process.argv[2] !== undefined ? [scenarios[+process.argv[2]]] : scenarios;
  let fails = 0;
  for (const s of only) {
    const r = await run(s);
    const good = r.complete ? (r.match && r.rootOk) : false;
    if (!good) fails++;
    console.log(
      (good ? 'PASS ' : 'FAIL ') + s.label.padEnd(30) +
      String(r.frames).padStart(7) +
      (100*r.dropped/r.frames).toFixed(0).padStart(6) + '%' +
      (100*r.readRate).toFixed(0).padStart(6) + '%' +
      r.pxMod.toFixed(1).padStart(7) +
      String(r.crcRejects).padStart(8) +
      String(r.complete).padStart(10) +
      String(r.match).padStart(13) +
      String(r.rootOk).padStart(9) +
      '');
  }
  process.exit(fails ? 1 : 0);
})();
