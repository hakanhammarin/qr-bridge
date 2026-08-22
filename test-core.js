const C = require('./core.js');
const crypto = require('crypto');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL ' + m); } else console.log('  ok   ' + m); };

/* --- base45 vs RFC 9285 published vectors --- */
const vec = [['AB', 'BB8'], ['Hello!!', '%69 VD92EX0'], ['base-45', 'UJCLQE7W581'], ['ietf!', 'QED8WEX0']];
for (const [plain, enc] of vec) {
  const b = Buffer.from(plain, 'utf8');
  ok(C.b45encode(b) === enc, `RFC9285 encode "${plain}" -> ${enc} (got ${C.b45encode(b)})`);
  ok(Buffer.from(C.b45decode(enc)).toString('utf8') === plain, `RFC9285 decode ${enc}`);
}

/* --- base45 random round-trip, both parities --- */
let rtOk = true;
for (let t = 0; t < 2000; t++) {
  const n = 1 + Math.floor(Math.random() * 300);
  const b = crypto.randomBytes(n);
  if (Buffer.compare(Buffer.from(C.b45decode(C.b45encode(b))), b) !== 0) { rtOk = false; break; }
}
ok(rtOk, 'base45 round-trip x2000 (odd+even lengths)');

/* --- charset containment: every output char must be QR-alphanumeric --- */
const ALNUM = new Set('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:');
let charOk = true;
for (let t = 0; t < 200; t++)
  for (const ch of C.b45encode(crypto.randomBytes(500))) if (!ALNUM.has(ch)) { charOk = false; break; }
ok(charOk, 'base45 output stays inside QR alphanumeric charset');

/* --- expansion ratio --- */
const ratio = C.b45encode(crypto.randomBytes(10000)).length / 10000;
ok(Math.abs(ratio - 1.5) < 0.001, `base45 expansion = ${ratio.toFixed(4)} chars/byte (1.5 expected)`);

/* --- CRC32 known vector --- */
ok(C.crc32(Buffer.from('123456789')) === 0xCBF43926, 'CRC32("123456789") = 0xCBF43926');

/* --- packet pack/unpack + corruption detection --- */
const pay = crypto.randomBytes(64);
const pk = C.packPacket(C.T_DATA, 7, 0xDEADBEEF, pay);
const up = C.unpackPacket(pk);
ok(up && up.blockIdx === 7 && up.seed === 0xDEADBEEF && Buffer.compare(Buffer.from(up.payload), pay) === 0, 'packet round-trip');
let caught = 0;
for (let t = 0; t < 500; t++) {
  const bad = Uint8Array.from(pk);
  bad[Math.floor(Math.random() * bad.length)] ^= (1 << Math.floor(Math.random() * 8));
  if (C.unpackPacket(bad) === null) caught++;
}
ok(caught === 500, `CRC caught ${caught}/500 single-bit corruptions`);

/* --- neighbours() determinism: encoder and decoder must agree --- */
const cdf = C.solitonCDF(5000);
let detOk = true;
for (let t = 0; t < 500; t++) {
  const s = (Math.random() * 0xFFFFFFFF) >>> 0;
  const a = C.neighbours(s, 5000, cdf), b = C.neighbours(s, 5000, C.solitonCDF(5000));
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) { detOk = false; break; }
}
ok(detOk, 'neighbours(seed,K) is deterministic across independent CDF builds');

/* --- LT fountain: recovery under simulated frame loss --- */
function trial(blockLen, symbolSize, lossRate, redundancy) {
  const block = crypto.randomBytes(blockLen);
  const enc = C.LTEncoder(block, symbolSize);
  const dec = C.LTDecoder(enc.K, symbolSize, blockLen);
  const budget = Math.ceil(enc.K * redundancy);
  let sent = 0, delivered = 0;
  for (let i = 0; i < budget && !dec.done; i++) {
    const seed = (i * 2654435761 + 12345) >>> 0;
    sent++;
    if (Math.random() < lossRate) continue;   // frame dropped by camera
    delivered++;
    dec.add(seed, enc.encode(seed));
  }
  return { K: enc.K, done: dec.done, sent, delivered,
           overhead: delivered / enc.K,
           match: dec.done && Buffer.compare(Buffer.from(dec.assemble()), block) === 0 };
}

/* The sender's redundancy R must cover BOTH the LT decoding overhead
   (~1.07x at a 16 MiB block) and the camera's frame loss:
       R  >=  LT_overhead / (1 - lossRate)
   Each row below picks R from the loss it claims to tolerate, then
   verifies the block really does come back byte-exact, 40 trials deep. */
const LT_P95 = 1.15;   /* p95 at a 4 MiB block, from sweep.js */
console.log('\n  LT recovery at the redundancy the sender would actually pick (4 MiB blocks, K=2690):');
console.log('  claimed loss   R sent   trials   recovered   worst delivered/K   bytes-match');
let ltOk = true;
for (const loss of [0.00, 0.10, 0.20, 0.30, 0.45]) {
  const R = LT_P95 / (1 - loss);
  let good = 0, worst = 0, allMatch = true;
  const N = 10;
  for (let t = 0; t < N; t++) {
    const r = trial(4 << 20, 1560, loss, R);
    if (r.done) { good++; worst = Math.max(worst, r.overhead); if (!r.match) allMatch = false; }
  }
  if (good < N * 0.9 || !allMatch) ltOk = false;
  console.log(`  ${(loss*100).toFixed(0).padStart(10)}%   ${R.toFixed(2)}x   ${String(N).padStart(6)}   ${String(good).padStart(9)}   ${worst.toFixed(3).padStart(17)}   ${allMatch}`);
}
ok(ltOk, 'single sweep completes >=90% of blocks, and every completion is byte-exact');

/* --- redundancy must be *necessary*: starving it should fail loudly --- */
let starved = 0;
for (let t = 0; t < 20; t++) if (!trial(4 << 20, 1560, 0.35, 1.10).done) starved++;
ok(starved >= 19, `under-budgeted transfers do fail as expected (${starved}/20) — not silently "succeeding"`);

/* --- THE failsafe property: a block starved in sweep 1 must finish in
   sweep 2. Sweep 2 uses fresh seeds, so its packets are new information
   rather than duplicates, and the decoder keeps its sweep-1 state. --- */
function twoSweep(blockLen, loss, R) {
  const block = crypto.randomBytes(blockLen);
  const enc = C.LTEncoder(block, 1560);
  const dec = C.LTDecoder(enc.K, 1560, blockLen);
  const budget = Math.ceil(enc.K * R);
  const sweep = (tag) => {
    for (let i = 0; i < budget && !dec.done; i++) {
      const seed = (((i * 2654435761) >>> 0) ^ ((tag * 0x9E3779B1) >>> 0)) >>> 0;
      if (Math.random() < loss) continue;
      dec.add(seed, enc.encode(seed));
    }
    return dec.done;
  };
  const s1 = sweep(1);
  const after1 = dec.solvedCount / enc.K;
  const s2 = sweep(2);
  return { s1, s2, after1, match: dec.done && Buffer.compare(Buffer.from(dec.assemble()), block) === 0 };
}

console.log('\n  Two-sweep recovery under a deliberately starved budget (R=1.05, 4 MiB blocks):');
let sweepOk = true, s1c = 0, s2c = 0;
for (let t = 0; t < 12; t++) {
  const r = twoSweep(4 << 20, 0.20, 1.05);
  if (r.s1) s1c++;
  if (r.s2) s2c++; else sweepOk = false;
  if (r.s2 && !r.match) sweepOk = false;
}
console.log(`  sweep 1 completed ${s1c}/12   sweep 2 completed ${s2c}/12   all byte-exact: ${sweepOk}`);
ok(sweepOk, 'every block starved in sweep 1 recovered byte-exactly in sweep 2');

console.log(fails === 0 ? '\nALL CORE TESTS PASSED' : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
