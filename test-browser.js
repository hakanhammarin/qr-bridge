/* Browser smoke test of the BUILT pages: no unsubstituted tokens, no console
   errors, workers actually spin up, and — the part that matters — the frames
   the sender paints to its canvas decode back into valid packets. */
const { chromium } = require('playwright');
const path = require('path');
const C = require('./core.js');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL ' + m); } else console.log('  ok   ' + m); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: {width: 1920, height: 1080} });

  /* ---------------- sender ---------------- */
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('file://' + path.resolve('build/qr-bridge-v2.html'));
  await page.waitForTimeout(400);
  ok(errors.length === 0, 'sender loads with no console/page errors' + (errors.length ? ': ' + errors[0] : ''));

  /* attach a synthetic file the same way a drop would */
  await page.evaluate(() => {
    const bytes = new Uint8Array(300 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xFF;
    const f = new File([bytes], 'payload.bin', {type: 'application/octet-stream'});
    const dt = new DataTransfer(); dt.items.add(f);
    document.getElementById('file').files = dt.files;
    document.getElementById('file').dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(200);

  const planText = await page.textContent('#plan');
  ok(/payload\.bin/.test(planText), 'plan table populates from the selected file');
  ok(/px\/module/.test(planText) || /read rate/.test(planText), 'plan reports pixel density and read rate');
  ok(!(await page.locator('#go').isDisabled()), 'start button enables');

  /* worker pool + inlined QR library */
  await page.click('#calib');
  await page.waitForFunction(() => /ms\/code/.test(document.getElementById('calibout').textContent), null, {timeout: 30000});
  const calib = await page.textContent('#calibout');
  ok(/ms\/code/.test(calib), 'encoder benchmark runs in workers: ' + calib.replace(/<[^>]*>/g,'').trim().slice(0, 70));

  /* ---- start a real transmission and decode what lands on the canvas ---- */
  await page.addScriptTag({ path: path.resolve('node_modules/jsqr/dist/jsQR.js') });
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('stage').style.display === 'block', null, {timeout: 60000});

  /* The transmission opens with a burst of full-screen manifest frames, so poll
     until a data frame is on screen rather than sampling a fixed moment. */
  const sampleOnce = () => page.evaluate(() => {
    const cv = document.getElementById('cv');
    const ctx = cv.getContext('2d');
    const g = window.jsQR || window.JSQR;
    const gx = 2, gy = 2;                    /* 'safe' preset */
    const out = [];
    for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
      const w = Math.floor(cv.width / gx), h = Math.floor(cv.height / gy);
      const img = ctx.getImageData(x*w, y*h, w, h);
      const r = g(img.data, w, h, {inversionAttempts: 'dontInvert'});
      out.push(r ? r.data : null);
    }
    return {texts: out, w: cv.width, h: cv.height,
            frame: document.getElementById('h-frame').textContent,
            fps: document.getElementById('h-fps').textContent,
            buf: document.getElementById('h-buf').textContent};
  });

  /* The opening burst must be manifest frames — a receiver that starts with the
     sender should sync immediately rather than waiting for a periodic repeat. */
  const readFull = () => page.evaluate(() => {
    const cv = document.getElementById('cv'), c = cv.getContext('2d');
    const g = window.jsQR || window.JSQR;
    const img = c.getImageData(0, 0, cv.width, cv.height);
    const r = g(img.data, cv.width, cv.height, {inversionAttempts: 'dontInvert'});
    return r ? r.data : null;
  });
  let openingIsManifest = false, firstPaint = Date.now();
  const openDeadline = Date.now() + 12000;
  while (Date.now() < openDeadline && !openingIsManifest) {
    const t = await readFull();
    if (t) {
      firstPaint = Date.now();
      try {
        const pkt = C.unpackPacket(C.b45decode(t));
        openingIsManifest = !!pkt && pkt.type === C.T_MANIFEST &&
          JSON.parse(new TextDecoder().decode(pkt.payload)).v === 2;
      } catch (e) {}
      if (!openingIsManifest) break;      /* already past the burst */
    }
    await page.waitForTimeout(100);
  }
  ok(openingIsManifest, 'transmission opens with a full-screen manifest burst (instant receiver sync)');

  let sample = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const s = await sampleOnce();
    if (s.texts.every(t => t !== null)) { sample = s; break; }
    sample = s;
    await page.waitForTimeout(120);
  }

  ok(sample.texts.every(t => t !== null),
     `all ${sample.texts.length} tiles of a live data frame decoded (${sample.w}×${sample.h})`);

  let valid = 0, blocks = new Set();
  for (const t of sample.texts) {
    if (!t) continue;
    try {
      const pkt = C.unpackPacket(C.b45decode(t));
      if (pkt && (pkt.type === C.T_DATA || pkt.type === C.T_MANIFEST)) { valid++; blocks.add(pkt.blockIdx); }
    } catch (e) {}
  }
  ok(valid === sample.texts.filter(Boolean).length,
     `every decoded tile is a CRC-valid packet (${valid}/${sample.texts.filter(Boolean).length})`);
  ok(+sample.frame.replace(/,/g,'') > 5, `frames are advancing (frame ${sample.frame}, ${sample.fps} fps)`);
  ok(!/REBUFFER/.test(sample.buf), `lookahead buffer is holding (${sample.buf})`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.getElementById('stage').style.display === 'none'),
     'Escape stops transmission and leaves the stage');

  /* ---------------- ultrawide geometry ---------------- */
  const uw = await ctx.newPage();
  const uwErrors = [];
  uw.on('pageerror', e => uwErrors.push(String(e)));
  await uw.setViewportSize({width: 1600, height: 450});     /* 32:9 proportions */
  await uw.goto('file://' + path.resolve('build/qr-bridge-v2.html'));
  await uw.waitForTimeout(300);

  const geo = await uw.evaluate(() => {
    document.getElementById('scrw').value = 5120;
    document.getElementById('scrh').value = 1440;
    document.getElementById('cam').value = '1920x1080';
    document.getElementById('grid').value = '2x2';
    document.getElementById('ver').value = '27';
    /* geometry() is independent of any selected file */
    const measure = area => {
      document.getElementById('area').value = area;
      const g = geometry(27, 2, 2);
      return {area, px: g.pxPerModule, region: g.rW + 'x' + g.rH, scale: g.scale};
    };
    const full = measure('full'), wide = measure('16:9');
    const best = optimize();
    return {full, wide, best: {gx: best.safe.gx, gy: best.safe.gy, ver: best.safe.ver,
                               px: best.safe.px, read: best.safe.read}};
  });

  ok(uwErrors.length === 0, 'sender loads on an ultrawide viewport without errors');
  ok(geo.full.px < 2.5,
     `full-screen on 5120×1440 delivers only ${geo.full.px} px/module — reproduces the reported failure`);
  ok(geo.wide.px > geo.full.px * 1.7,
     `16:9 region lifts it to ${geo.wide.px} px/module (region ${geo.wide.region})`);
  ok(geo.best.read >= 0.90,
     `optimiser picks ${geo.best.gx}×${geo.best.gy} v${geo.best.ver} at ${geo.best.px} px/module (${(geo.best.read*100).toFixed(0)}% read)`);

  /* link test paints a single code and never advances state */
  await uw.evaluate(() => document.getElementById('linktest').click());
  await uw.waitForTimeout(1500);
  const lt = await uw.evaluate(() => {
    const cv = document.getElementById('cv'), c = cv.getContext('2d');
    /* the region must be letterboxed: corners black, centre white */
    const corner = c.getImageData(2, 2, 1, 1).data;
    const mid = c.getImageData(cv.width >> 1, 10, 1, 1).data;
    return {hud: document.getElementById('h-block').textContent,
            corner: corner[0], mid: mid[0],
            frames: document.getElementById('h-frame').textContent};
  });
  ok(lt.hud === 'LINK TEST', 'link test mode runs without a file selected');
  ok(lt.corner > 90 && lt.corner < 170 && lt.mid > 200,
     `transmit region is letterboxed with a NEUTRAL surround (outside ${lt.corner}, inside ${lt.mid}) — ` +
     'a black surround would drag auto-exposure toward the bright block');
  await uw.keyboard.press('Escape');
  await uw.close();

  /* ---------------- receiver ---------------- */
  const rx = await ctx.newPage();
  const rxErrors = [];
  rx.on('pageerror', e => rxErrors.push(String(e)));
  rx.on('console', m => { if (m.type() === 'error') rxErrors.push(m.text()); });
  await rx.goto('file://' + path.resolve('build/qr-bridge-v2-rx.html'));
  await rx.waitForTimeout(400);
  ok(rxErrors.length === 0, 'receiver loads with no console/page errors' + (rxErrors.length ? ': ' + rxErrors[0] : ''));

  /* drive the receiver's ingest path directly with packets the sender would emit */
  const rxResult = await rx.evaluate(async () => {
    const C = QRBCore;
    window.__newSession();
    const size = 40 * 1024, sym = 1078;                 /* v27-M symbol size */
    const file = new Uint8Array(size);
    for (let i = 0; i < size; i++) file[i] = (i * 40503) & 0xFF;
    const enc = C.LTEncoder(file, sym);

    const dg = new Uint8Array(32);
    dg.set(new Uint8Array(await crypto.subtle.digest('SHA-256', file)));
    const rootBuf = await crypto.subtle.digest('SHA-256', dg);
    const root = [...new Uint8Array(rootBuf)].map(b => b.toString(16).padStart(2,'0')).join('');

    const manifest = {v:2, name:'t.bin', size, mime:'application/octet-stream', ver:27, ec:'M',
                      sym, blocks:1, bsize:size, K:enc.K, grid:'2x2', R:1.45, root};
    /* the receiver's own entry point, exactly as a camera read would call it */
    window.__ingest(C.b45encode(C.packPacket(C.T_MANIFEST, 0, 0,
      new TextEncoder().encode(JSON.stringify(manifest)))));
    const synced = !!window.__S().manifest;

    let n = 0;
    while (!window.__S().blobs[0] && n < enc.K * 3) {
      const seed = (n * 2654435761 + 7) >>> 0; n++;
      if (n % 7 === 0) continue;                        /* simulate 14% frame loss */
      window.__ingest(C.b45encode(C.packPacket(C.T_DATA, 0, seed, enc.encode(seed))));
    }
    const S = window.__S();
    const blob = S.blobs[0];
    let match = false;
    if (blob) {
      const back = new Uint8Array(await blob.arrayBuffer());
      match = back.length === size && back.every((v, i) => v === file[i]);
    }
    return {synced, complete: !!blob, match, sent: n, K: enc.K};
  });

  ok(rxResult.synced, 'receiver syncs on a manifest packet and builds its decoders');
  ok(rxResult.complete, `receiver completed the block from ${rxResult.sent} packets (K=${rxResult.K})`);
  ok(rxResult.match, 'receiver reassembled the block byte-for-byte through its own ingest path');

  /* ---- optical diagnostics must name the right fault ----
     Synthesise frames with one known defect each and check the verdict picks it
     out. A diagnostic that fires on everything is worse than none at all. */
  const diagRes = await rx.evaluate(() => {
    const g = window.__grab, c = g.getContext('2d');
    g.width = 640; g.height = 360;

    /* Paint a black/white grid — a stand-in for a well-exposed code — then
       apply one physically-motivated defect: blur (focus), offset (exposure
       or backlight level), lift (glare raising the blacks), gain (contrast). */
    const paint = ({blur = 0, offset = 0, lift = 0, gain = 1}) => {
      c.filter = 'none';
      c.fillStyle = '#7f7f7f'; c.fillRect(0, 0, 640, 360);
      c.filter = blur ? `blur(${blur}px)` : 'none';
      for (let y = 0; y < 360; y += 16) for (let x = 0; x < 640; x += 16) {
        const on = ((x/16 + y/16) % 2) === 0;
        let v = on ? 255 : lift;
        v = (v - 128) * gain + 128 + offset;
        v = Math.max(0, Math.min(255, v));
        c.fillStyle = `rgb(${v},${v},${v})`;
        c.fillRect(x, y, 16, 16);
      }
      c.filter = 'none';
    };

    const run = frames => {
      window.__newSession();
      for (const f of frames) { paint(f); window.__pushDiag(window.__diagnose()); }
      const v = window.__verdict();
      return {causes: v ? v.causes.map(x => x[1]) : []};
    };

    const good = {};
    const alt = (a, b) => [a,b,a,b,a,b,a,b,a,b];

    return {
      clean:   run(Array(10).fill(good)),
      hunting: run(alt({blur: 0}, {blur: 6})),
      flicker: run(alt({offset: -55}, {offset: 55})),
      glare:   run(Array(10).fill({lift: 150})),
      flat:    run(Array(10).fill({gain: 0.15}))
    };
  });

  const only = (r, name) => r.causes.length === 1 && r.causes[0] === name;
  ok(diagRes.clean.causes.length === 0,
     `a steady, well-exposed capture raises no fault (got: ${diagRes.clean.causes.join(', ') || 'none'})`);
  ok(only(diagRes.hunting, 'autofocus hunting'),
     `alternating focus is diagnosed as autofocus hunting, and nothing else (got: ${diagRes.hunting.causes.join(', ')})`);
  ok(only(diagRes.flicker, 'exposure or backlight flicker'),
     `alternating brightness is diagnosed as exposure flicker, and nothing else (got: ${diagRes.flicker.causes.join(', ')})`);
  ok(diagRes.glare.causes.includes('blacks are washed out'),
     `lifted blacks are diagnosed as glare (got: ${diagRes.glare.causes.join(', ')})`);
  ok(diagRes.flat.causes.includes('low contrast'),
     `a flat image is diagnosed as low contrast (got: ${diagRes.flat.causes.join(', ')})`);

  await browser.close();
  console.log(fails === 0 ? '\nALL BROWSER TESTS PASSED' : `\n${fails} FAILURE(S)`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
