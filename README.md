# QR Bridge v2

One-way file transfer over a screen-to-camera optical link. A Mac mini drives a
display with a grid of QR codes; an iPhone on a stand watches and reassembles the
file. No network, no pairing, no back-channel.

Two self-contained pages, no build step needed to use them, no CDN at runtime:

| File | Runs on | Purpose |
|---|---|---|
| `qr-bridge-v2.html` | Mac mini → Samsung display | Picks the file, plans the transfer, paints the QR stream |
| `qr-bridge-v2-rx.html` | iPhone (Safari) | Captures, decodes, verifies, saves |

---

## What changed from v1

v1 sent one base64 QR every 200 ms and topped out around 500 KB before it became
impractical. v2 changes four things, in descending order of how much they matter.

**1 — base45 + alphanumeric mode instead of base64 + byte mode (+29%).**
Base64 in QR *byte* mode pays a 33% expansion tax. Base45 ([RFC 9285](https://www.rfc-editor.org/rfc/rfc9285))
packs 2 bytes into 3 characters drawn from exactly the 45-character set that QR
*alphanumeric* mode encodes at 5.5 bits/char — so the payload costs 8.25 bits per
byte instead of 10.67. Raw binary in byte mode would be 3% better still, but it is
the option that breaks: both JS QR libraries and iOS Vision round-trip payloads as
strings, and arbitrary bytes get mangled by encoding assumptions. Base45 is the
failsafe choice *and* nearly the fast one.

**2 — LT fountain coding instead of numbered chunks.**
With sequential chunks every frame is mandatory, and a missed frame needs a retry
request — over a link with no back-channel that means re-sending everything.
Recovering all N chunks by repetition alone is the coupon-collector problem: at 15%
loss it takes about six full passes.

Instead each packet is the XOR of a pseudo-random subset of the block's symbols,
with the subset derived from a 32-bit seed the packet carries. The receiver
regenerates the same subset from the same seed, so no index list is transmitted.
Any ~1.15 × K packets reconstruct the block, *regardless of which ones arrived*.
No handshake, no ordering, no retry logic.

**3 — Refresh-locked frame timing.**
80 ms is 4.8 refreshes at 60 Hz. Codes displayed for a non-integer number of
refreshes tear on swap, and a torn frame does not decode. Frame timing is specified
in whole refreshes: **5 refreshes = 83.3 ms = 12 fps**. Costs 4% throughput versus
80 ms and removes an entire failure mode.

**4 — Density is capped by the camera, not the QR spec.** See below — this one
turned out to be the opposite of what it looks like.

---

## The measured result: more tiles beats denser codes

Version 40 holds 44% more than version 33, so packing the screen with v40 codes
looks like the obvious win. It is not. In an offline optical simulation — affine
tilt of roughly one degree, slight defocus, sensor noise, decoded with jsQR — v40
reads back **less than half as often** as v27/v33 at the same pixel density,
because geometric error accumulates across 177 modules instead of 125.

What actually governs the link is **delivered pixels per module**, and it is worth
computing carefully: modules are drawn at an *integer* pixel scale, so a layout
that looks like 3.44 px/module on paper delivers 3.0 after flooring.

Measured read rates:

| px/module | QR version | codes read |
|---|---|---|
| 6.0 | 33 | 99% |
| 5.0 | **40** | **32%** |
| 4.0 | 27 | 80% |
| 3.0 | 33 | 25% |
| 3.0 | 33 (no defocus) | 60% |
| 2.5 | 40 | 0% |

Effective throughput once read rate is folded in, at 12 fps:

| Layout | Capture | px/mod | read | gross | net | in 30 min |
|---|---|---|---|---|---|---|
| 1×1 v33-M | 1080p | 6.0 | 100% | 18.4 KiB/s | 16.0 KiB/s | 28 MiB |
| 2×1 v33-M | 1080p | 6.0 | 99% | 36.7 KiB/s | 31.6 KiB/s | 56 MiB |
| **2×2 v27-M** | **1080p** | **4.0** | **80%** | 50.5 KiB/s | **35.2 KiB/s** | **62 MiB** |
| 2×2 v33-M | 1080p | 3.0 | 25% | 73.4 KiB/s | 16.0 KiB/s | 28 MiB |
| **3×2 v33-M** | **4K** | **6.0** | **81%** | 110.1 KiB/s | **77.6 KiB/s** | **136 MiB** |
| 2×2 v40-M | 4K | 5.0 | 32% | 105.4 KiB/s | 29.3 KiB/s | 52 MiB |

Note the two traps. `2×2 v33-M @1080p` puts the most data on screen of any 1080p
row and delivers the *least*, because it reads a quarter of the time. And
`2×2 v40-M @4K` is beaten by `3×2 v33-M @4K` despite similar gross rates.

**Safari on iOS caps `getUserMedia` at 1080p in practice.** That is the binding
constraint on the whole system: the 4K rows need a native receiver using
`AVCaptureSession` and the Vision framework. The protocol section below documents
the wire format so that receiver can be written.

These numbers come from jsQR, which is decent but not best-in-class. Apple's Vision
framework handles marginal codes better, so treat the read rates as a conservative
floor.

---

## Redundancy, and why one sweep is not the whole story

The sender's redundancy `R` must cover both the fountain code's own decoding
overhead and the camera's frame loss:

```
R  ≥  LT_overhead / (1 − lossRate)
```

`LT_overhead` is ~1.15 at a 4 MiB block. The slider maps directly to loss
tolerance: 1.45× tolerates 21%, 1.75× tolerates 34%.

The sender does not stop when a sweep ends — it loops, deriving fresh seeds by
mixing the sweep number in. Sweep 2 therefore carries *new* information rather than
duplicates the decoder would discard, and the receiver keeps its sweep-1 state. In
testing, blocks deliberately starved at R=1.05 completed 0/12 times in sweep 1 and
**12/12 in sweep 2**, byte-exact. Under-budgeting costs time, not correctness.

Blocks are 4 MiB. Larger blocks lower fountain overhead (16 MiB reaches 1.07×) but
raise the receiver's working set; 4 MiB keeps decoder memory bounded and lets each
completed block be flushed straight to a `Blob`, so RAM does not scale with file
size.

---

## Integrity

Three independent layers:

- **CRC32 per packet.** Every symbol is verified before it enters the decoder, so
  the assembled block is correct by construction. Caught 500/500 injected single-bit
  corruptions in testing.
- **SHA-256 per block**, hashed together into a 32-byte root carried in the
  manifest. `crypto.subtle` has no streaming API, so hashing a 1 GiB file in one
  call would mean holding it all in memory; the hash-of-hashes keeps it bounded.
- **Root comparison** on the receiver before the file is offered for saving. A
  mismatch is reported as a failure, not a completed transfer.

---

## Wire protocol

Every QR code carries one packet: `base45( header ‖ payload ‖ crc32 )`, encoded in
QR **alphanumeric** mode.

```
offset  size  field
     0     1  magic, 0x51
     1     1  type — 0 = data symbol, 1 = manifest
     2     2  block index, big-endian uint16
     4     4  seed, big-endian uint32   (0 for manifest)
     8     n  payload — symbolSize bytes, or manifest JSON
   8+n     4  CRC32 (big-endian) over bytes [0, 8+n)
```

Header + trailer is 12 bytes. `symbolSize` = the version's alphanumeric capacity
converted to bytes (`floor(chars/3)*2`), minus 12, rounded down to even.

Manifest JSON:

```json
{ "v":2, "name":"deck.pptx", "size":157286400, "mime":"...",
  "ver":27, "ec":"M", "sym":1078, "blocks":38, "bsize":4194304,
  "K":3889, "grid":"2x2", "R":1.45, "root":"<64 hex chars>" }
```

Sent as the first frame and re-sent every 240 frames, so a receiver that starts
late loses at most one sweep.

**Seed derivation** (both sides must match exactly):

```js
h = (sweep * 0x9E3779B1) ^ (block * 0x85EBCA77) ^ (n * 0xC2B2AE3D)
h ^= h >>> 15;  h = imul(h, 0x2545F491);  h ^= h >>> 13;  seed = h >>> 0
```

**Neighbour selection** from a seed: xorshift32 PRNG seeded with it, first draw
picks a degree from a robust-soliton CDF (`c=0.03`, `delta=0.05`, built for that
block's K), subsequent draws pick that many distinct source indices modulo K. See
`core.js` — it is the normative implementation.

---

## Operating notes

Set up in this order:

1. Mount the phone on the stand and frame the display so the grid fills the
   viewfinder. Get this right before anything else — it sets px/module.
2. Open the receiver, **start capture first**, tap once to lock focus.
3. Open the sender, choose the file, run **Benchmark encoder**. QR generation costs
   tens of milliseconds per code; the sender needs `fps × cells` codes per second
   sustained across its worker pool. If the benchmark says "too slow", drop the
   frame rate rather than letting the buffer stall.
4. Start transmission. The HUD reports buffer depth — `REBUFFERING` means the
   encoder is not keeping up.

The receiver's tile guides flash green on every successful decode. If a tile never
greens, the framing is off or that region is out of focus. The **decode rate** stat
is the number to watch: below ~50% the redundancy setting is being outrun and the
transfer will need extra sweeps.

Avoid: auto-brightness, True Tone, Night Shift, screen savers, and anything that
can raise a notification over the sender's display.

---

## Build

The pages in the repo root are prebuilt and committed. To rebuild after editing
anything under `src/`:

```
npm install
node build.js          # inlines core.js + libraries into build/
```

`build.js` inlines `qrcode-generator` and `jsQR` directly into the HTML — an
air-gapped transfer tool must not need a CDN — and fails loudly on any
unsubstituted template token.

### Tests

```
node test-core.js        # base45 RFC vectors, CRC32, fountain recovery, two-sweep
node test-qr-roundtrip.js # bytes -> QR -> pixels -> jsQR -> bytes, all versions
./run-e2e.sh             # full optical simulation across 10 layout scenarios
node test-browser.js     # built pages in headless Chromium, live canvas decoded
```

`test-e2e.js` is where the read-rate table above comes from. It renders through the
sender's exact geometry, applies an affine transform plus defocus plus noise, crops
tiles the way the receiver does, and decodes with jsQR — so a layout that only works
when pixel-aligned cannot pass it by accident.

---

## Known limits

- **1 GiB is not a 30-minute transfer.** At the best 1080p layout it is ~8 hours; at
  the best 4K layout, ~3.8 hours. Thirty minutes buys roughly 60 MiB (1080p) or
  135 MiB (4K). A .pptx is already a zip container, so re-zipping it gains nothing —
  the gigabyte is embedded media, and recompressing it is worth far more than any
  further tuning of this transport.
- Safari's 1080p capture cap is the single biggest limit; a native receiver roughly
  doubles throughput.
- The receiver holds completed blocks as `Blob`s, which the browser backs with disk,
  but the final assembled file still passes through memory on save.
- Tiles are cropped on a fixed grid with 6% overlap. Severe keystone (phone far
  off-axis) will break the outer tiles first.
