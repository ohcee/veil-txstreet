// What a Veil transaction IS, tested against the shapes a real node returns.
//
// Every costly bug in this project has been a data bug wearing a visual costume:
// the scene looked fine and told a lie about somebody's privacy. Each case below
// is one that actually shipped, or one that would have caught it.
//
//   node --test test/
//
// No dependencies, no network, no node required: these are pure functions fed
// fixtures copied from real getblock / getrawtransaction output on mainnet.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const V = require("../server.js");

// ---------------------------------------------------------------------------
// Fixtures. The field layouts here are the whole point, so they are verbatim.
// ---------------------------------------------------------------------------

// A blinded (CT) output. Veil gives it BOTH its own type AND an ordinary
// pubkeyhash script, which is exactly how it got mistaken for transparent.
const VOUT_BLIND = { "vout.n": 1, type: "blind", valueCommitment: "08b59e596bc404ff112233",
                     scriptPubKey: { type: "pubkeyhash", addresses: ["bv1qexample"] } };
// A zerocoin mint. v.type says "standard"; only the script admits what it is.
const VOUT_MINT = { "vout.n": 2, type: "standard", value: 1000,
                    scriptPubKey: { type: "zerocoinmint" } };
const VOUT_RINGCT = { "vout.n": 1, type: "ringct", valueCommitment: "099f6c9ab69bd72a0011" };
const VOUT_DATA = { "vout.n": 0, type: "data", ct_fee: 0.01 };
const VOUT_PLAIN = { "vout.n": 0, type: "standard", value: 16.099631,
                     scriptPubKey: { type: "pubkeyhash", addresses: ["VHU81LE2bTUe5AWSHSrDHcocqRWCK4dCRo"] } };
const VOUT_STAKE_MARKER = { "vout.n": 0, type: "standard", scriptPubKey: { type: "nonstandard" } };

// A zerocoin spend carries a NULL outpoint: 64 zeros and index 0xffffffff. It
// still has a txid field, which is why a naive prevout lookup chased it.
const VIN_ZEROCOINSPEND = { type: "zerocoinspend", denomination: "10.00",
                            txid: "0".repeat(64), vout: 4294967295 };
const VIN_ANON_11 = { type: "anon", num_inputs: 1, ring_size: 11, key_images: ["ki0"],
                      ringct_inputs: Array.from({ length: 11 }, (_, i) => ({ txid: "a".repeat(64), "vout.n": i })) };
const VIN_ANON_5 = { type: "anon", num_inputs: 1, ring_size: 5, key_images: ["ki0"],
                     ringct_inputs: Array.from({ length: 5 }, (_, i) => ({ txid: "b".repeat(64), "vout.n": i })) };
const VIN_PLAIN = { txid: "c".repeat(64), vout: 3 };
const VIN_COINBASE = { coinbase: "03a1b2c3", sequence: 0 };

const tx = (vin, vout) => ({ txid: "d".repeat(64), vin, vout, vsize: 900, size: 900, locktime: 0 });

// ---------------------------------------------------------------------------
// Output typing. Neither type field is trustworthy on its own.
// ---------------------------------------------------------------------------

test("a blinded output is not reported as transparent", () => {
  // SHIPPED BUG: scriptPubKey.type was read first, so every CT output on the
  // chain came back "pubkeyhash" and was never marked hidden.
  assert.equal(V.voutKind(VOUT_BLIND), "blind");
  assert.equal(V.shapeVout(VOUT_BLIND).hidden, true);
});

test("a zerocoin mint is found even though v.type says standard", () => {
  // SHIPPED BUG: only v.type was checked, so mints were invisible. They are the
  // most common output on the chain.
  assert.equal(V.voutKind(VOUT_MINT), "zerocoinmint");
  assert.equal(V.writesMint(tx([VIN_PLAIN], [VOUT_DATA, VOUT_MINT])), true);
  assert.equal(V.mintTotal(tx([VIN_PLAIN], [VOUT_DATA, VOUT_MINT])), 1000);
});

test("ringct outputs are hidden, plain ones stay readable", () => {
  assert.equal(V.voutKind(VOUT_RINGCT), "ringct");
  assert.equal(V.shapeVout(VOUT_RINGCT).hidden, true);
  const plain = V.shapeVout(VOUT_PLAIN);
  assert.equal(plain.hidden, undefined);
  assert.equal(plain.value, 16.099631);
  assert.equal(plain.address, "VHU81LE2bTUe5AWSHSrDHcocqRWCK4dCRo");
});

test("the fee marker and the stake marker keep their own identities", () => {
  assert.equal(V.voutKind(VOUT_DATA), "data");
  assert.equal(V.shapeVout(VOUT_DATA).ctFee, 0.01);
  assert.equal(V.voutKind(VOUT_STAKE_MARKER), "nonstandard");
});

test("vout index is read from Veil's own key name", () => {
  assert.equal(V.voutIndex(VOUT_MINT), 2);          // "vout.n", not "n"
  assert.equal(V.voutIndex({ n: 7 }), 7);           // and the ordinary spelling still works
});

// ---------------------------------------------------------------------------
// Classification: what a transaction WROTE.
// ---------------------------------------------------------------------------

test("classify reads outputs, most private wins", () => {
  assert.equal(V.classify(tx([VIN_PLAIN], [VOUT_PLAIN])), "base");
  assert.equal(V.classify(tx([VIN_PLAIN], [VOUT_DATA, VOUT_BLIND])), "stealth");
  assert.equal(V.classify(tx([VIN_ANON_11], [VOUT_DATA, VOUT_RINGCT])), "ringct");
});

test("a mint does not masquerade as a plain payment", () => {
  // SHIPPED BUG: a mint counted as a "public output", so every mint was flagged
  // as a shielded tx that had leaked change.
  const mintFromRing = tx([VIN_ANON_11], [VOUT_DATA, VOUT_RINGCT, VOUT_MINT]);
  assert.equal(V.writesMixed(mintFromRing), false);
  // but a genuine public payout alongside a hidden one still counts
  assert.equal(V.writesMixed(tx([VIN_PLAIN], [VOUT_RINGCT, VOUT_PLAIN])), true);
});

// ---------------------------------------------------------------------------
// Ring signatures: what a transaction SPENT, and how well it hid it.
// ---------------------------------------------------------------------------

test("spending a ring is not the same as writing a hidden output", () => {
  // The distinction the whole scene rests on: a stealth-to-RingCT send writes
  // nothing but hidden outputs and builds no ring at all.
  const ringSpend = tx([VIN_ANON_11], [VOUT_DATA, VOUT_RINGCT]);
  const outputsOnly = tx([VIN_PLAIN, VIN_PLAIN], [VOUT_DATA, VOUT_RINGCT]);
  assert.equal(V.spendsRing(ringSpend), true);
  assert.equal(V.spendsRing(outputsOnly), false);
  assert.equal(V.classify(outputsOnly), "ringct");     // it still WRITES ringct
});

test("ring size is read per input, not from the first one", () => {
  // SHIPPED BUG: `vin[0].type === "anon"` missed a ring on any later input.
  const secondInputIsTheRing = tx([VIN_PLAIN, VIN_ANON_5], [VOUT_DATA, VOUT_RINGCT]);
  assert.equal(V.spendsRing(secondInputIsTheRing), true);
  assert.equal(V.firstRingSize(secondInputIsTheRing), 5);
  assert.deepEqual(V.ringSizes(tx([VIN_ANON_11, VIN_ANON_5], [VOUT_RINGCT])), [11, 5]);
});

test("the ring is listed in full, decoys included", () => {
  // SHIPPED BUG: ring members were deduped by txid, undercounting the ring.
  // Members are OUTPUTS; two of them may legitimately share a funding tx.
  const shared = { type: "anon", num_inputs: 1, ring_size: 3, key_images: ["k"],
                   ringct_inputs: [{ txid: "e".repeat(64), "vout.n": 0 },
                                   { txid: "e".repeat(64), "vout.n": 1 },
                                   { txid: "f".repeat(64), "vout.n": 2 }] };
  const shaped = V.shapeVin(shared);
  assert.equal(shaped.kind, "anon");
  assert.equal(shaped.ringSize, 3);
  assert.equal(shaped.ring.length, 3);                 // not 2
  assert.deepEqual(shaped.ring[1], { txid: "e".repeat(64), n: 1 });
});

test("a zerocoin spend has no outpoint worth chasing", () => {
  // SHIPPED BUG: the null outpoint has a txid field, so every zerocoin spend
  // fired a doomed RPC. On testnet that was ~71 failed calls per 60 blocks.
  assert.equal(V.realPrevout(VIN_ZEROCOINSPEND), false);
  assert.equal(V.realPrevout(VIN_COINBASE), false);
  assert.equal(V.realPrevout(VIN_PLAIN), true);
});

test("summarising a block's tx reports the ring across all inputs", () => {
  const s = V.summarizeTx(tx([VIN_PLAIN, VIN_ANON_5], [VOUT_DATA, VOUT_RINGCT]), 2, false);
  assert.equal(s.anon, true);
  assert.deepEqual(s.rings, [5]);
  assert.equal(s.hidden, true);
  assert.equal(s.kind, "tx");
});

test("coinbase and coinstake are named by position", () => {
  const cb = V.summarizeTx(tx([VIN_COINBASE], [VOUT_PLAIN]), 0, true);
  const cs = V.summarizeTx(tx([VIN_ZEROCOINSPEND], [VOUT_STAKE_MARKER, VOUT_MINT]), 1, true);
  assert.equal(cb.kind, "coinbase");
  assert.equal(cs.kind, "coinstake");
});

// ---------------------------------------------------------------------------
// Consensus and time.
// ---------------------------------------------------------------------------

test("a staked block is detected from Veil's own flags wording", () => {
  // Veil says "proof-of-stake" in flags; matching the whole phrase rather than
  // "stake" is how a coinstake gets mistaken for user traffic.
  assert.equal(V.detectAlgo({ flags: "proof-of-stake" }), "pos");
  assert.equal(V.detectAlgo({ proofofstakehash: "abc" }), "pos");
  assert.equal(V.detectAlgo({ flags: "proof-of-work", algo: "progpow" }), "progpow");
  assert.equal(V.detectAlgo({ flags: "proof-of-work", algo: "randomx" }), "randomx");
  assert.equal(V.detectAlgo({ flags: "proof-of-work", algo: "sha256d" }), "sha256d");
  assert.equal(V.detectAlgo({}), "unknown");
});

test("superblocks land on the interval and nowhere else", () => {
  assert.equal(V.SUPERBLOCK_INTERVAL, 43200);
  assert.equal(V.isSuperblock(43200 * 92), true);
  assert.equal(V.isSuperblock(43200 * 92 + 1), false);
  assert.equal(V.isSuperblock(0), false);              // genesis is not a payout
});

// ---------------------------------------------------------------------------
// History buckets: a chart must not invent a shape it does not have.
// ---------------------------------------------------------------------------

test("buckets average a window and ignore what falls outside it", () => {
  // 24 buckets across 24h means one bucket per hour, so samples are placed at
  // least two hours apart. An earlier version of this test put two of them 59
  // minutes apart, which shares a bucket or not depending on the time of day:
  // it passed on one machine and failed on another for no reason at all.
  const now = Date.now() / 1000, HOUR = 3600;
  const series = [[now - 30 * HOUR, 999],        // older than the day window
                  [now - 6 * HOUR, 60],
                  [now - 0.25 * HOUR, 120]];     // comfortably inside the last bucket
  const day = V.bucket(series, 24, 24 * HOUR);
  assert.ok(!day.includes(999), "a sample outside the window must not appear");
  assert.ok(day.length > 0);
  assert.equal(day[day.length - 1], 120, "the newest bucket holds the newest value");
  // a week-wide view of the same data does include the older sample
  assert.ok(V.bucket(series, 60, 7 * 24 * HOUR).includes(999));
});

test("samples inside one bucket are averaged, not overwritten", () => {
  const now = Date.now() / 1000, HOUR = 3600;
  // both land in the final hour bucket, so the bucket reports their mean
  const out = V.bucket([[now - 0.33 * HOUR, 60], [now - 0.17 * HOUR, 80]], 24, 24 * HOUR);
  assert.equal(out[out.length - 1], 70);
});

test("a gap carries the last value forward rather than dropping to zero", () => {
  const now = Date.now() / 1000;
  const out = V.bucket([[now - 20 * 3600, 55], [now - 60, 70]], 24, 24 * 3600);
  assert.ok(out.every(v => v > 0), "no bucket may read zero just because nothing was sampled");
});

test("an empty series produces no line at all", () => {
  assert.deepEqual(V.bucket([], 60, 3600), []);
  assert.equal(V.spanHours([]), 0);
  assert.equal(V.spanHours([[1, 1]]), 0);              // one sample spans nothing
});

test("span reports the hours actually covered, never more", () => {
  const now = Date.now() / 1000;
  assert.equal(V.spanHours([[now - 7200, 1], [now, 2]]), 2);
});

// ---------------------------------------------------------------------------
// The size heuristic, used only when the node cannot answer.
// ---------------------------------------------------------------------------

test("the size guess is a fallback and says so by being coarse", () => {
  assert.equal(V.heuristicType(300), "base");
  assert.equal(V.heuristicType(1500), "stealth");
  assert.equal(V.heuristicType(4000), "ringct");
});
