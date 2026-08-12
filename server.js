#!/usr/bin/env node
/**
 * VeilStreet backend — zero-dependency Node server.
 *
 *   • Serves the static visualizer (index.html).
 *   • Reads a Veil node's JSON-RPC and exposes a live delta feed at /api/state.
 *   • Modes:
 *       FEED=rpc  (default) — poll a real veild over RPC. If unreachable, the
 *                             feed reports mode "offline" and the frontend
 *                             animates its own simulation.
 *       FEED=mock          — emit a synthetic live feed (for demos / testing the
 *                             full pipeline without a node).
 *
 * Configure the node via env (or a config.json next to this file):
 *   VEIL_RPC_HOST   default 127.0.0.1
 *   VEIL_RPC_PORT   default 58812        (Veil mainnet RPC)
 *   VEIL_RPC_USER / VEIL_RPC_PASS        rpcuser / rpcpassword
 *   VEIL_RPC_COOKIE path to datadir/.cookie   (alternative to user/pass)
 *   PORT            default 8790
 *   FEED            rpc | mock
 *   MOCK_BLOCK_MS   mock block interval (default 60000)
 */
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (_) {}
const CFG = {
  // how far back to walk once, seeding the list. Wider finds older (dormant) holders
  // but grows the set that gets re-priced, so raise SNITCH_BATCH / SNITCH_EVERY_MS with it.
  snitchBackfill: +(process.env.SNITCH_BACKFILL || fileCfg.snitchBackfill || 20000),
  snitchEveryMs: +(process.env.SNITCH_EVERY_MS || fileCfg.snitchEveryMs || 90000),   // re-price cadence
  port: +(process.env.PORT || fileCfg.port || 8790),
  host: process.env.BIND || fileCfg.host || "0.0.0.0",   // set BIND=127.0.0.1 behind a proxy
  feed: (process.env.FEED || fileCfg.feed || "rpc").toLowerCase(),
  rpcHost: process.env.VEIL_RPC_HOST || fileCfg.rpcHost || "127.0.0.1",
  rpcPort: +(process.env.VEIL_RPC_PORT || fileCfg.rpcPort || 0) || 0,   // 0 = auto-detect mainnet/testnet
  rpcUser: process.env.VEIL_RPC_USER || fileCfg.rpcUser || "",
  rpcPass: process.env.VEIL_RPC_PASS || fileCfg.rpcPass || "",
  rpcCookie: process.env.VEIL_RPC_COOKIE || fileCfg.rpcCookie || "",
  pollMs: +(process.env.POLL_MS || fileCfg.pollMs || 2500),
  mockBlockMs: +(process.env.MOCK_BLOCK_MS || fileCfg.mockBlockMs || 60000),
  // VEIL→USD price for fee estimates. Pin VEIL_USD / config.veilUsd to override
  // the auto price (NonKYC market); veilMarket points at another NonKYC pair.
  veilUsd: +(process.env.VEIL_USD || fileCfg.veilUsd || 0),
  veilMarket: process.env.VEIL_MARKET || fileCfg.veilMarket || "VEIL_USDT",
  // testnet coins have no market value, so set VEIL_NO_USD=1 to drop all dollar
  // figures (the UI falls back to VEIL amounts everywhere).
  noUsd: /^(1|true|yes|on)$/i.test(process.env.VEIL_NO_USD || "") || !!fileCfg.noUsd,
};

// ---------------------------------------------------------------------------
// VEIL/USD price (for dollar fee estimates) — pinned, or polled from NonKYC
// ---------------------------------------------------------------------------
let usdPrice = CFG.veilUsd;                 // 0 until known
const priceAuto = !CFG.veilUsd && !CFG.noUsd;   // don't fetch when pinned or USD is off
function fetchPrice() {
  if (!priceAuto) return;
  const url = `https://api.nonkyc.io/api/v2/market/getbysymbol/${encodeURIComponent(CFG.veilMarket)}`;
  https.get(url, { headers: { accept: "application/json", "user-agent": "veilstreet/1.0" }, timeout: 8000 }, res => {
    let d = ""; res.on("data", c => (d += c));
    res.on("end", () => { try {
      const j = JSON.parse(d);
      const p = parseFloat(j.primaryUsdValue) || j.lastPriceNumber || parseFloat(j.lastPrice);
      if (p > 0) usdPrice = p;
    } catch (_) {} });
  }).on("error", () => {}).on("timeout", function () { this.destroy(); });
}
if (priceAuto) { fetchPrice(); setInterval(fetchPrice, 300000); }   // refresh every 5 min
function checkSeed(){
  if (SEED_HOST === "off"){ seedInfo = null; return; }
  dns.resolve4(SEED_HOST, (err, addrs) => {
    // keep the addresses themselves: a DNS seeder exists so people can find a peer,
    // and a bare count helps nobody who actually needs one
    seedInfo = err ? { host: SEED_HOST, up: false, count: 0, ips: [] }
                   : { host: SEED_HOST, up: (addrs || []).length > 0,
                       count: (addrs || []).length, ips: (addrs || []).slice(0, 25) };
  });
}

// Veil pays its monthly budget on a superblock every 43200 blocks (~30d at 60s).
// There is no RPC for it — block explorers derive it from this same constant.
const SUPERBLOCK_INTERVAL = 43200;
const isSuperblock = h => h > 0 && h % SUPERBLOCK_INTERVAL === 0;

// ---------------------------------------------------------------------------
// shared state: an append-only ring buffer of {seq, kind, ...} events
// ---------------------------------------------------------------------------
let seq = 0;
const MAX_EVENTS = 3000;
const events = [];
let avgBlockSec = 0;      // chain-wide mean block spacing, from getchainalgostats
let stats = { mode: "offline", network: "veil", height: 0, difficulty: 0, hashrate: 0, mempool: 0, usd: 0, updated: Date.now() };
const dns = require("dns");
let netInfo = null;                          // peer count / versions from getpeerinfo
let seedInfo = null;                         // DNS seeder liveness (seed.veil-info.org)
const SEED_HOST = process.env.VEIL_SEED_HOST || fileCfg.seedHost || "seed.veil-info.org";
let lastArrival = null;
let prevBlockTime = null;                    // previous block's own timestamp
let memSampleCtr = 0;

// ---------------------------------------------------------------------------
// A day of history. Both series are timestamped, kept to a rolling 24h, and
// written to disk, so a restart does not throw the chart away and the server
// only has to fetch whatever happened while it was down.
//   blkHist   [unixTime, secondsSincePreviousBlock]   seedable from the chain
//   memSeries [unixTime, txInMempool]                 cannot be, no history exists
// ---------------------------------------------------------------------------
const DAY = 24 * 3600, WEEK = 7 * DAY;
const HIST_WINDOW = WEEK;                    // raw samples kept; charts slice it
let blkHist = [], memSeries = [];
let histFile = null, histDirty = false, histSavedAt = 0;
function loadHist(){
  // per chain, like the snitch harvest: testnet spacings must not pollute mainnet
  histFile = path.join(__dirname, CFG.rpcPort === 58812 ? "block-hist.json" : `block-hist-${CFG.rpcPort}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(histFile, "utf8"));
    if (Array.isArray(raw.blocks)) blkHist = raw.blocks;
    if (Array.isArray(raw.mem)) memSeries = raw.mem;
    pruneHist();
    console.log(`  history: ${blkHist.length} block samples, ${memSeries.length} mempool samples restored`);
  } catch (_) {}
}
function saveHist(force){
  if (!histFile || (!histDirty && !force)) return;
  const now = Date.now();
  if (!force && now - histSavedAt < 60000) return;      // at most once a minute
  histSavedAt = now; histDirty = false;
  try { fs.writeFileSync(histFile, JSON.stringify({ blocks: blkHist, mem: memSeries, saved: now })); } catch (_) {}
}
function pruneHist(){
  const floor = Date.now() / 1000 - HIST_WINDOW;
  blkHist = blkHist.filter(e => e && e[0] >= floor);
  memSeries = memSeries.filter(e => e && e[0] >= floor);
}
// Average into n buckets across the whole window, so the line is a day rather
// than the last few dozen samples. Gaps carry the previous value forward, since
// a break in sampling is not a drop to zero.
function bucket(series, n, win){
  if (!series.length) return [];
  const W = win || HIST_WINDOW;
  const t0 = Date.now() / 1000 - W, w = W / n;
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0);
  for (const e of series){
    if (e[0] < t0) continue;                 // outside this view, though still stored
    let i = Math.floor((e[0] - t0) / w);
    if (i < 0) i = 0; else if (i >= n) i = n - 1;
    sum[i] += e[1]; cnt[i]++;
  }
  const out = []; let last = null;
  for (let i = 0; i < n; i++){
    if (cnt[i]) last = sum[i] / cnt[i];
    if (last != null) out.push(+last.toFixed(1));
  }
  return out;
}
function spanHours(series){
  if (series.length < 2) return 0;
  return +((series[series.length - 1][0] - series[0][0]) / 3600).toFixed(1);
}
// Walk block headers backwards until a day is covered. One RPC per block via
// previousblockhash, roughly 1440 of them on a 60s chain, so it runs in the
// background after the server is already serving and pauses every so often to
// let the node do its real job. A restart only refetches what it missed.
let seedingHist = false;
async function seedBlockHistory(fromHeight){
  // fromHeight is passed in: this runs from the first poll, which happens BEFORE
  // stats is rebuilt, so reading stats.height there walks back from genesis and
  // finds nothing at all.
  if (seedingHist || !rpcPortLocked || !(fromHeight > 0)) return;
  seedingHist = true;
  try {
    // Two different jobs. If the restored file already reaches back a full day,
    // we only need the gap since its newest sample. If it does not (first run, or
    // the server was off for a while), walk all the way back to fill the window.
    // Stopping at "newest" in both cases meant a fresh file never grew a past: it
    // had one recent sample, so the walk ended after a single header.
    const target = Date.now() / 1000 - HIST_WINDOW;
    const newest = blkHist.length ? blkHist[blkHist.length - 1][0] : 0;
    const oldest = blkHist.length ? blkHist[0][0] : Infinity;
    const stopAt = oldest <= target + 120 ? newest : target;
    let cur = await rpc("getblockhash", [fromHeight]);
    const found = [];
    let prev = null, walked = 0;
    while (cur && walked < 11000){
      const hd = await rpc("getblockheader", [cur]);
      if (prev != null && prev - hd.time >= 0 && prev - hd.time < 3600)
        found.push([Math.round(prev), Math.round(prev - hd.time)]);
      prev = hd.time;
      if (hd.time <= stopAt) break;
      cur = hd.previousblockhash;
      if (++walked % 40 === 0) await new Promise(r => setTimeout(r, 110));
    }
    if (found.length){
      const seen = new Set(blkHist.map(e => e[0]));
      for (const e of found) if (!seen.has(e[0])){ blkHist.push(e); seen.add(e[0]); }
      blkHist.sort((a, b) => a[0] - b[0]);
      pruneHist(); histDirty = true; saveHist(true);
      console.log(`  history: walked ${walked} headers, ${blkHist.length} block samples covering ${spanHours(blkHist)}h`);
    }
  } catch (_) {} finally { seedingHist = false; }
}
function addBlockSample(t, gap){
  if (!(gap >= 0 && gap < 3600)) return;               // Veil stamps are not monotonic
  blkHist.push([Math.round(t), Math.round(gap)]);
  histDirty = true;
}
checkSeed(); setInterval(checkSeed, 120000);   // seeder liveness, after SEED_HOST exists

for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => { try { saveHist(true); } catch (_) {} process.exit(0); });

function push(ev) {
  ev.seq = ++seq;
  events.push(ev);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}
function since(n) { return events.filter(e => e.seq > n).slice(-800); }

// ---------------------------------------------------------------------------
// JSON-RPC client (built-in http, basic auth, short timeout)
// ---------------------------------------------------------------------------
function rpcAuth() {
  if (CFG.rpcCookie) {
    try { return fs.readFileSync(CFG.rpcCookie, "utf8").trim(); } catch (_) {}
  }
  if (CFG.rpcUser) return `${CFG.rpcUser}:${CFG.rpcPass}`;
  return "";
}
// When no port is pinned (env/config), find whichever chain's node is up —
// mainnet's 58812 first, then testnet's 58813 — and lock onto it. The lock is only
// as durable as the node behind it: if the chain we detected stops answering for a
// few polls in a row (say the user swapped testnet for mainnet), release the lock
// and probe again. A pinned port never re-detects — a pin is a promise.
const rpcPinned = CFG.rpcPort > 0;
let rpcPortLocked = rpcPinned;
let rpcMisses = 0;
async function detectPort() {
  for (const p of [58812, 58813]) {
    CFG.rpcPort = p;
    try {
      const info = await rpc("getblockchaininfo");
      rpcPortLocked = true;
      initSnitch();                          // the harvest file is per-chain, so only now
      console.log(`  auto-detected ${info.chain} chain  (RPC ${p})`);
      return true;
    } catch (_) {}
  }
  CFG.rpcPort = 0;
  return false;
}

let rpcId = 0;
function rpc(method, params = [], timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: "1.0", id: ++rpcId, method, params });
    const auth = rpcAuth();
    const req = http.request({
      host: CFG.rpcHost, port: CFG.rpcPort, method: "POST", path: "/",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...(auth ? { "Authorization": "Basic " + Buffer.from(auth).toString("base64") } : {}),
      },
      timeout: timeoutMs,
    }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error.message || JSON.stringify(j.error)));
          else resolve(j.result);
        } catch (e) { reject(new Error("bad rpc response: " + data.slice(0, 120))); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("rpc timeout")));
    req.on("error", reject);
    req.write(body); req.end();
  });
}

// ---------------------------------------------------------------------------
// tx privacy classification (base / stealth / ringct)
// ---------------------------------------------------------------------------
function classify(tx) {
  let ring = false, ct = false;
  for (const v of (tx.vout || [])) {
    const t = String(v.type || v.scriptPubKey?.type || "").toLowerCase();
    if (t.includes("anon") || t.includes("ringct")) ring = true;
    else if (t.includes("ct") || t.includes("blind")) ct = true;
  }
  return ring ? "ringct" : ct ? "stealth" : "base";
}
// Creating RingCT outputs and SPENDING RingCT are different things, and only the
// spending side builds a ring signature — that is where the anonymity set lives.
// A stealth to RingCT send makes hidden outputs with ordinary inputs and has no
// ring at all, so classify() alone (which reads outputs) must not be read as
// "this transaction hid its source". Ring size is per input, so check every vin.
function spendsRing(tx) { return (tx.vin || []).some(v => v.type === "anon"); }
// A transaction can write a shielded output AND a plain one in the same breath,
// usually change. The being can only be one creature and it shows the most private
// output, so without this flag a ghost would silently be carrying a public payment.
// (The "data" output is Veil's fee marker, not a payment.)
// A zerocoin mint is the easiest thing on Veil to miss: Veil's own v.type says
// "standard" and only scriptPubKey.type admits it is a zerocoinmint. They are the
// most common output on the chain, because every stake spends a zerocoin and mints
// fresh ones, and the pool holds the majority of the money supply.
function mintOuts(tx) {
  return (tx.vout || []).filter(v =>
    String((v.scriptPubKey || {}).type || "").toLowerCase().includes("zerocoinmint") ||
    String(v.type || "").toLowerCase().includes("zerocoinmint"));
}
function writesMint(tx) { return mintOuts(tx).length > 0; }
function mintTotal(tx) {
  return +mintOuts(tx).reduce((a, v) => a + (typeof v.value === "number" ? v.value : 0), 0).toFixed(8);
}
function writesMixed(tx) {
  let shielded = false, plain = false;
  for (const v of (tx.vout || [])) {
    const t = String(v.type || (v.scriptPubKey || {}).type || "").toLowerCase();
    if (t === "data") continue;
    // a zerocoin mint publishes its denomination but is not a public payment, and it
    // has its own note. Counting it as "plain" made every mint look like leaked change.
    if (String((v.scriptPubKey || {}).type || "").toLowerCase().includes("zerocoinmint")) continue;
    if (t.includes("anon") || t.includes("ringct") || t.includes("blind") || t === "ct") shielded = true;
    else plain = true;
  }
  return shielded && plain;
}
// What a transaction SPENT, which is the only truthful basis for showing where it
// came from. Output type will not do: a stealth to RingCT send writes hidden
// outputs while spending blinded ones, and calling that a transparent origin
// (or a ring) is a lie in either direction.
//   ring    — an anon input: the source is one of a ring and cannot be pinned
//   stealth — a blinded/CT prevout: you can name the outpoint, not its value
//   base    — a plain prevout: outpoint and value both public
const KIND_CACHE = new Map();                    // "txid:n" -> kind
function kindOfVout(v){
  const t = String(v.type || (v.scriptPubKey || {}).type || "").toLowerCase();
  if (t.includes("anon") || t.includes("ringct")) return "ring";
  if (t.includes("blind") || t === "ct") return "stealth";
  return "base";
}
// a zerocoin spend and a coinbase both carry a NULL outpoint (all-zero txid, index
// 0xffffffff). There is no previous output to look up, and asking for one is a
// guaranteed RPC failure, so recognise them before spending a lookup on it.
const NULL_TXID = /^0{64}$/;
function realPrevout(v){
  return v.txid && !NULL_TXID.test(v.txid) &&
         (v["vout.n"] != null ? v["vout.n"] : v.vout) !== 0xffffffff;
}
let kindLookups = 0;                             // budget, reset each poll
async function sourceKind(tx, force){
  if (spendsRing(tx)) return "ring";
  // legacy zerocoin: the coin comes out of the accumulator, so the denomination is
  // public but the mint it came from is not. No outpoint exists to trace.
  if ((tx.vin || []).some(v => v.type === "zerocoinspend")) return "zerocoin";
  const vin = (tx.vin || []).find(realPrevout);
  if (!vin) return null;                         // coinbase, coinstake, nothing to trace
  const n = vin["vout.n"] != null ? vin["vout.n"] : vin.vout;
  const key = vin.txid + ":" + n;
  if (KIND_CACHE.has(key)) return KIND_CACHE.get(key);
  // the cap protects the node while it chews through a block. A page someone is
  // actually looking at is one cached lookup, so it is never rationed.
  if (!force && kindLookups >= 12) return null;
  kindLookups++;
  try {
    const prev = await rpc("getrawtransaction", [vin.txid, true]);
    let mine = null;
    for (const v of (prev.vout || [])){
      const idx = voutIndex(v), k = kindOfVout(v);
      const ck = vin.txid + ":" + idx;
      if (KIND_CACHE.size < 5000) KIND_CACHE.set(ck, k);
      if (idx === n) mine = k;
    }
    return mine;
  } catch (_) { return null; }
}
function ringSizes(tx) {
  return (tx.vin || []).filter(v => v.type === "anon")
                       .map(v => v.ring_size).filter(n => n != null);
}
function heuristicType(vsize) { return vsize > 2200 ? "ringct" : vsize > 900 ? "stealth" : "base"; }

// Which of Veil's algorithms mined a block: pos | progpow | randomx | sha256d | unknown.
// Field names vary by node version, so probe several; refine once confirmed against a node.
function detectAlgo(blk) {
  const flags = String(blk.flags || "").toLowerCase();
  if (flags.includes("stake") || blk.proofofstakehash || blk.posproofhash || blk.is_pos || blk.proof_of_stake) return "pos";
  const a = String(blk.algo || blk.pow_algo || blk.proof_algo || blk.powalgo || blk.proof_type || blk.mining_algo || "").toLowerCase();
  if (a.includes("progpow")) return "progpow";
  if (a.includes("randomx")) return "randomx";
  if (a.includes("sha256")) return "sha256d";
  if (a.includes("stake") || a.includes("pos")) return "pos";
  return "unknown";
}
function mockAlgo() { const w = { pos:0.50, progpow:0.32, randomx:0.10, sha256d:0.08 }; let r = Math.random();
  for (const k of ["pos","progpow","randomx","sha256d"]) { r -= w[k]; if (r <= 0) return k; } return "progpow"; }

// classification queue (limits concurrent getrawtransaction calls)
const txQ = [];
let inflight = 0;
// the CURRENT mempool with its classifications — so a page that just loaded can pull
// the real pending set instead of trusting whatever its last snapshot remembered
const memNow = new Map();                  // txid -> { txid, vsize, fee, type, time }
function enqueueTx(txid, mp) { txQ.push({ txid, mp }); pumpTx(); }
function pumpTx() {
  while (inflight < 4 && txQ.length) {
    const { txid, mp } = txQ.shift();
    const vsize = mp.vsize || mp.size || 500;
    const fee = mp.fee != null ? mp.fee : (mp.fees && mp.fees.base) || 0;
    const time = mp.time || Date.now() / 1000;
    if (txQ.length > 30) { // backlog: skip detail lookup, use size heuristic
      memNow.set(txid, { txid, vsize, fee, type: heuristicType(vsize), time });
      push({ kind: "tx", txid, vsize, fee, type: heuristicType(vsize), time });
      continue;
    }
    inflight++;
    rpc("getrawtransaction", [txid, true])
      .then(async tx => { const t = classify(tx), ri = spendsRing(tx), src = await sourceKind(tx),
                          mx = writesMixed(tx), mint = writesMint(tx), mv = mint ? mintTotal(tx) : 0;
                    const ev = { txid, vsize, fee, type: t, time, ringIn: ri, src, mixed: mx, mint, mintValue: mv };
                    memNow.set(txid, ev);
                    push({ kind: "tx", ...ev }); })
      .catch(() => { const t = heuristicType(vsize); memNow.set(txid, { txid, vsize, fee, type: t, time });
                     push({ kind: "tx", txid, vsize, fee, type: t, time }); })
      .finally(() => { inflight--; pumpTx(); });
  }
}

// ---------------------------------------------------------------------------
// RPC poller
// ---------------------------------------------------------------------------
const known = new Set();
// which block a txid landed in — getrawtransaction can't look up confirmed txs
// without txindex, but getblock(hash,2) can, if we remember where the tx went
const txWhere = new Map();
function rememberTx(tid, h, hash){
  txWhere.set(tid, { h, hash });
  if (txWhere.size > 9000){                      // FIFO cap; Maps iterate in insertion order
    for (const k of txWhere.keys()){ txWhere.delete(k); if (txWhere.size <= 8000) break; }
  }
}
let lastHeight = null;
let tipTime = null;                       // unix time of the tip block (for "time since block")
let warned = false;

let polling = false;
async function poll() {
  // a slow poll must not overlap the next tick: two walkers reading the same stale
  // lastHeight would each push the new block, and every block prints twice
  if (polling) return;
  polling = true;
  kindLookups = 0;                       // fresh prevout-lookup budget for this pass
  try {
    if (!rpcPortLocked && !(await detectPort())) {
      stats = { ...stats, mode: "offline", updated: Date.now() };
      return;                                // neither node answered; try again next poll
    }
    const info = await rpc("getblockchaininfo");
    const mining = await rpc("getmininginfo").catch(() => null);
    const mem = await rpc("getmempoolinfo").catch(() => ({ size: 0 }));
    const peers = await rpc("getpeerinfo").catch(() => null);
    if (Array.isArray(peers)){
      const vers = {}; let inb = 0, outb = 0;
      for (const pr of peers){ (pr.inbound ? inb++ : outb++);
        const v = (pr.subver || "?").replace(/[/]/g, "").replace(/^Veil:?/i, "") || "?";
        vers[v] = (vers[v] || 0) + 1; }
      netInfo = { peers: peers.length, inbound: inb, outbound: outb,
                  versions: Object.entries(vers).sort((a,b) => b[1]-a[1]).slice(0, 5) };
    }
    // mempool depth history, downsampled to ~every 15s for a ~15min window
    if (++memSampleCtr >= Math.max(1, Math.round(60000 / CFG.pollMs))){
      memSampleCtr = 0;
      memSeries.push([Math.round(Date.now() / 1000), mem.size || 0]);
      pruneHist(); histDirty = true; saveHist();
    }
    const height = info.blocks;
    // Veil ships a chain-wide algo/timing summary — a far better average than timing
    // arrivals ourselves (that measure drifts with poll latency and closed tabs)
    let algoStats = null;
    try { algoStats = await rpc("getchainalgostats", []); } catch (_) {}
    if (algoStats && algoStats.endblock > algoStats.startblock && algoStats.finish > algoStats.start)
      avgBlockSec = (algoStats.finish - algoStats.start) / (algoStats.endblock - algoStats.startblock);

    // first poll: learn the tip block time so "time since block" survives a refresh
    if (lastHeight === null) {
      try { const th = await rpc("getblockhash", [height]); const tb = await rpc("getblock", [th]);
             const nowSec = Date.now()/1000; tipTime = Math.min(tb.time || nowSec, nowSec); } catch (_) {}
      // and preload the last few blocks into the event ring: the page seeds its
      // recent strip from this backlog, and a freshly restarted server should
      // not hand every visitor an empty history until new blocks trickle in
      for (let h = Math.max(1, height - 7); h <= height; h++) {
        try {
          const bh2 = await rpc("getblockhash", [h]);
          const blk = await rpc("getblock", [bh2]);          // verbosity 1: txids as strings
          const tids = (blk.tx || []).slice(0, 500);
          for (const tid of tids) rememberTx(tid, h, bh2);
          push({ kind: "block", height: h, hash: bh2, txcount: (blk.tx || []).length,
                 size: blk.size || 0, algo: detectAlgo(blk),
                 time: blk.time || Date.now() / 1000, txids: tids, superblock: isSuperblock(h) });
        } catch (_) {}
      }
      // history: restore what we already had, then fill the rest in the background
      // so the first pageview is not waiting on a day of headers
      loadHist();
      prevBlockTime = null;
      seedBlockHistory(height);
    }

    // new blocks
    if (lastHeight != null && height > lastHeight) {
      for (let h = lastHeight + 1; h <= height; h++) {
        try {
          const hash = await rpc("getblockhash", [h]);
          let blk, full = true;
          try { blk = await rpc("getblock", [hash, 2]); } catch (_) { blk = await rpc("getblock", [hash]); full = false; }
          const txs = blk.tx || [];
          // txids let the UI group the feed's transactions under the block that confirmed them
          const txids = txs.slice(0, 500).map(t => (full ? (t.txid || t) : t));  // complete list = the UI can reject boarded txs the block didn't take
          // anchor to when we SAW the block, not its self-reported timestamp: Veil stamps
          // can sit in the future (pinning the clock at 0) or lag arrival by ~a minute
          // (so it would never appear to reset). Arrival matches the ship launching.
          tipTime = Date.now() / 1000;
          // surface confirmed txs we never saw in the mempool, so the feed matches the explorer.
          // these go out BEFORE the block event, so the block can group them on arrival.
          // idx 0 is the coinbase; on a PoS block idx 1 is the coinstake (the staking
          // reward). Both are block-reward machinery, not user traffic, so neither
          // should walk the street — the astronaut represents them.
          if (full) harvestSnitch(blk);          // note any transparent addresses this block exposed
          const rewardTxs = detectAlgo(blk) === "pos" ? 2 : 1;
          for (let idx = 0; idx < txs.length; idx++) {
            const tx = txs[idx], tid = full ? (tx.txid || tx) : tx;
            if (idx >= rewardTxs && !known.has(tid)) {
              if (full) push({ kind: "tx", txid: tid, vsize: tx.vsize || tx.size || 500, fee: 0,
                               type: classify(tx), ringIn: spendsRing(tx), src: await sourceKind(tx),
                               mixed: writesMixed(tx), mint: writesMint(tx), mintValue: writesMint(tx) ? mintTotal(tx) : 0,
                               time: blk.time || Date.now() / 1000 });
              else push({ kind: "tx", txid: tid, vsize: 800, fee: 0, type: heuristicType(800), time: blk.time || Date.now() / 1000 });
            }
            known.delete(tid);
          }
          for (const tid of txids) rememberTx(tid, h, hash);
          const nowS = Date.now() / 1000;
          // on-chain spacing, matching the seeded history. Arrival deltas would drift
          // with poll latency and mix two different measurements in one chart.
          const bt = blk.time || nowS;
          if (prevBlockTime != null) addBlockSample(bt, bt - prevBlockTime);
          prevBlockTime = bt;
          pruneHist(); saveHist();
          lastArrival = nowS;
          push({ kind: "block", height: h, hash, txcount: txs.length, size: blk.size || 0, algo: detectAlgo(blk), time: blk.time || Date.now() / 1000, txids, superblock: isSuperblock(h) });
        } catch (_) {}
      }
    }
    lastHeight = height;

    stats = {
      mode: "live", network: info.chain || "main", height,
      difficulty: info.difficulty || 0,
      hashrate: mining ? (mining.networkhashps || 0) : 0,
      mempool: mem.size || 0, usd: usdPrice,
      nextSuperblock: Math.ceil((height + 1) / SUPERBLOCK_INTERVAL) * SUPERBLOCK_INTERVAL,
      bestHash: info.bestblockhash || "",   // the tip the next block builds on
      avgBlock: avgBlockSec,
      // per-algorithm block counts over the same window, plus each algo's difficulty
      algoMix: algoStats ? { pos: algoStats.pos || 0, progpow: algoStats.progpow || 0,
                             randomx: algoStats.randomx || 0, sha256d: algoStats.sha256d || 0,
                             blocks: (algoStats.endblock || 0) - (algoStats.startblock || 0),
                             hours: (algoStats.finish - algoStats.start) / 3600 } : null,
      diffs: { pos: info.difficulty_pos || 0, progpow: info.difficulty_progpow || 0,
               randomx: info.difficulty_randomx || 0, sha256d: info.difficulty_sha256d || 0 },
      net: netInfo, seed: seedInfo,
      blockGaps: bucket(blkHist, 60, DAY), memHist: bucket(memSeries, 60, DAY),
      blockGaps7: bucket(blkHist, 60, WEEK), memHist7: bucket(memSeries, 60, WEEK),
      histHours: { blocks: spanHours(blkHist), mem: spanHours(memSeries) },
      updated: Date.now(),
    };

    // mempool diff
    const mp = await rpc("getrawmempool", [true]);
    const cur = Object.keys(mp);
    const curSet = new Set(cur);
    for (const tid of [...known]) if (!curSet.has(tid)) known.delete(tid);
    for (const tid of [...memNow.keys()]) if (!curSet.has(tid)) memNow.delete(tid);
    const fresh = cur.filter(t => !known.has(t));
    const CAP = 120;                      // classify (via RPC) up to CAP new tx per poll
    fresh.slice(0, CAP).forEach(tid => { known.add(tid); enqueueTx(tid, mp[tid]); });
    fresh.slice(CAP).forEach(tid => {     // overflow: still surface it (size heuristic, no RPC)
      known.add(tid);
      const mpx = mp[tid], vsize = mpx.vsize || mpx.size || 500;
      const ev = { txid: tid, vsize, fee: mpx.fee != null ? mpx.fee : (mpx.fees && mpx.fees.base) || 0, type: heuristicType(vsize), time: mpx.time || Date.now() / 1000 };
      memNow.set(tid, ev);
      push({ kind: "tx", ...ev });
    });
    warned = false; rpcMisses = 0;
  } catch (e) {
    rpcMisses++;
    // one slow reply isn't an outage — the badge only drops to OFFLINE on the second
    // consecutive miss, so a busy node doesn't flap the page into sim and back
    if (rpcMisses >= 2) {
      stats = { ...stats, mode: "offline", updated: Date.now() };
      if (!warned) { console.warn("[veilstreet] RPC unreachable (" + e.message + ") — serving in OFFLINE/sim mode."); warned = true; }
    }
    if (!rpcPinned && rpcPortLocked && rpcMisses >= 4) {
      console.log("  chain on RPC " + CFG.rpcPort + " went away — re-detecting");
      rpcPortLocked = false; rpcMisses = 0; lastHeight = null; known.clear();
    }
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// mock feed
// ---------------------------------------------------------------------------
function randHex(n) { let s = ""; const h = "0123456789abcdef"; for (let i = 0; i < n; i++) s += h[(Math.random() * 16) | 0]; return s; }
// The mock feed invents transactions, so it has to invent their provenance too.
// Without a src the page has no node to ask, and its honest fallback is to never
// claim the veil, which left the demo with no ring spends at all: the portals
// never lit and nobody ever walked out from under the cloth. Weighted to match
// what mainnet actually does, measured over 400 blocks.
function mockSource(type){
  const r = Math.random();
  if (type === "base") return { src: "base", ringIn: false };
  // zerocoin to stealth is the single most common real conversion
  if (type === "stealth") return { src: r < 0.6 ? "zerocoin" : "base", ringIn: false };
  // ringct is fed about equally by real ring spends and by blinded coin
  return r < 0.5 ? { src: "ring", ringIn: true } : { src: "stealth", ringIn: false };
}
const MOCK_DENOMS = [10, 100, 1000, 10000];       // the real zerocoin denominations
function mockMint(){
  if (Math.random() >= 0.07) return { mint: false };
  return { mint: true, mintValue: MOCK_DENOMS[(Math.random() * MOCK_DENOMS.length) | 0] };
}
function startMock() {
  let h = 3_200_000 + ((Math.random() * 5000) | 0);
  stats = { mode: "live", network: "mock", height: h, difficulty: 230000, hashrate: 400e6, mempool: 0, usd: CFG.noUsd ? 0 : (usdPrice || 0.0016), updated: Date.now() };
  setInterval(() => {
    stats.hashrate = Math.max(2e8, stats.hashrate + (Math.random() - 0.5) * 3e7);
    stats.difficulty = Math.max(1e5, stats.difficulty + (Math.random() - 0.5) * 8000);
    stats.updated = Date.now();
    const n = 1 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      const type = r < 0.2 ? "base" : r < 0.55 ? "stealth" : "ringct";
      const vsize = Math.round(type === "ringct" ? 2200 + Math.random() * 3200 : type === "stealth" ? 900 + Math.random() * 1400 : 240 + Math.random() * 420);
      const prov = mockSource(type);
      push({ kind: "tx", txid: randHex(64), vsize, fee: +(Math.random() * 0.001).toFixed(6), type,
             ...prov, ...mockMint(),
             time: Date.now() / 1000 });
      stats.mempool++;
    }
  }, 550);
  setInterval(() => {
    h++; const txcount = 6 + ((Math.random() * 45) | 0);
    push({ kind: "block", height: h, hash: randHex(64), txcount, size: txcount * 1600, algo: mockAlgo(), time: Date.now() / 1000 });
    stats.height = h; stats.mempool = Math.max(0, stats.mempool - txcount);
  }, CFG.mockBlockMs);
}

// ---------------------------------------------------------------------------
// Snitch list — the biggest TRANSPARENT (basecoin) addresses.
//
// Veil's node keeps no address index, and scantxoutset is a filter rather than an
// enumerator: it can price an address you already know, but it cannot discover one.
// So we harvest addresses from blocks as they stream past (free — we already fetch
// every block), then periodically hand the whole harvested set to scantxoutset in
// one pass to get real balances straight out of the UTXO set.
//
// That makes the balances exact, and the *coverage* honest-but-partial: these are
// the biggest transparent addresses we have SEEN, not a chain-wide rich list. The
// UI must label it that way.
// ---------------------------------------------------------------------------
// per-chain harvest file: testnet addresses must not pollute the mainnet set.
// Mainnet keeps the legacy name so an existing harvest carries over. Resolved only
// once the RPC port is known — it may have been auto-detected.
let snitchFile = null;
function initSnitch(){
  snitchFile = path.join(__dirname,
    CFG.rpcPort === 58812 ? "snitch-addrs.json" : `snitch-addrs-${CFG.rpcPort}.json`);
  // start clean: on a chain flip the previous chain's harvest must not carry over
  snitchSeen = new Map(); snitchList = []; snitchAt = 0; snitchScanned = 0; backfillAt = null;
  try {                                     // survive restarts so the set keeps growing
    const raw = JSON.parse(fs.readFileSync(snitchFile, "utf8"));
    if (raw && raw.addrs) { snitchSeen = new Map(Object.entries(raw.addrs)); backfillAt = raw.backfillAt || null; }
  } catch (_) {}
}
// Known operators, so the list doesn't read as if these were private stashes.
// Edit snitch-labels.json to name more pools/exchanges; config.json may override with
// { "snitchLabels": { "<address>": "name" } }. Pools that pay to stealth (sv...)
// addresses never reach this list — shielded outputs carry no address to label.
let labelFile = {};
try { labelFile = (JSON.parse(fs.readFileSync(path.join(__dirname, "snitch-labels.json"), "utf8")) || {}).labels || {}; } catch (_) {}
const SNITCH_LABELS = Object.assign({}, labelFile, fileCfg.snitchLabels || {});
// descriptors per scantxoutset pass. Scan time is dominated by walking the UTXO set,
// not the descriptor count (measured: 600 and 10k cost the same ~3s), so bigger
// batches mean fewer scans for the same coverage.
const SNITCH_BATCH = +(process.env.SNITCH_BATCH || fileCfg.snitchBatch || 600);

// The node runs at most ONE scantxoutset at a time ("Scan already in progress"), so
// every scan in the process — the snitch ranker's batches and the address pages —
// must share one queue or they knock each other over.
let addrScanChain = Promise.resolve();
function scanUtxos(descs){
  // a full UTXO walk takes seconds; give it far more than the default rpc timeout
  const run = addrScanChain.then(() => rpc("scantxoutset", ["start", descs], 60000));
  addrScanChain = run.catch(() => {});       // keep the chain alive even if one fails
  return run;
}
let snitchSeen = new Map();                // address -> scriptPubKey hex
let snitchList = [];                       // ranked [{ addr, amount, outs }]
let snitchAt = 0;                          // when the ranking was last refreshed
let snitchScanning = false;
let snitchScanned = 0;                     // addresses priced in the last pass
const heightTime = new Map();              // block height -> unix time (immutable, cache freely)
let backfillAt = null;                     // height the backfill has walked down to

if (rpcPortLocked) initSnitch();            // pinned port: load the harvest right away
function saveSnitch(){
  if (!snitchFile) return;
  try { fs.writeFileSync(snitchFile, JSON.stringify({
    addrs: Object.fromEntries(snitchSeen), backfillAt, saved: Date.now() })); } catch (_) {}
}

// pull every transparent output's address out of a block. Shielded outputs (RingCT,
// CT, zerocoin) carry no address at all, so they simply never show up here.
function harvestSnitch(blk){
  let added = 0;
  for (const tx of (blk.tx || [])){
    if (typeof tx === "string") continue;
    for (const v of (tx.vout || [])){
      const spk = v.scriptPubKey || {};
      const addr = (spk.addresses && spk.addresses[0]) || spk.address;
      if (!addr || !spk.hex) continue;
      if (!snitchSeen.has(addr)){ snitchSeen.set(addr, spk.hex); added++; }
    }
  }
  return added;
}

// price every harvested address against the live UTXO set
async function rankSnitch(){
  if (snitchScanning || !rpcPortLocked || !snitchSeen.size) return;
  snitchScanning = true;
  try {
    const byHex = new Map();                       // hex -> address
    for (const [a, hx] of snitchSeen) byHex.set(hx, a);
    const addrs = [...snitchSeen.keys()];
    const totals = new Map();                      // address -> { amount, outs }
    for (let i = 0; i < addrs.length; i += SNITCH_BATCH){
      const batch = addrs.slice(i, i + SNITCH_BATCH);
      let r;
      try { r = await scanUtxos(batch.map(a => `addr(${a})`)); }
      catch (_) { continue; }                      // a bad descriptor kills the batch, not the pass
      if (!r || !r.success) continue;
      for (const u of (r.unspents || [])){
        const a = byHex.get(u.scriptPubKey);        // this build returns no desc — map via the script
        if (!a) continue;
        const t = totals.get(a) || { amount: 0, outs: 0, sb: 0, last: 0 };
        t.amount += u.amount || 0; t.outs++;
        if (u.height > t.last) t.last = u.height;   // newest coin it still holds
        // Veil pays its budget on superblocks (every 43200). A large payout landing on
        // one of those exact heights marks the treasury, not somebody's exposed stash.
        // Requiring a big amount too, so an ordinary tx that happens to confirm in a
        // superblock (1-in-43200) isn't mislabelled.
        if (u.height && u.height % SUPERBLOCK_INTERVAL === 0 && (u.amount || 0) >= 1000) t.sb++;
        totals.set(a, t);
      }
    }
    snitchList = [...totals.entries()]
      .map(([addr, t]) => ({ addr, amount: +t.amount.toFixed(8), outs: t.outs, lastHeight: t.last,
                             label: SNITCH_LABELS[addr] || (t.sb > 0 ? "budget" : "") }))
      .filter(x => x.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 15);
    // Date the newest coin each address still holds. scantxoutset only ever returns
    // UNSPENT outputs, so a spend erases its own evidence: this is when an address
    // last RECEIVED, which is not the same as when it last moved anything. Heights
    // are immutable, so one lookup each and they are cached for good.
    for (const row of snitchList){
      if (!row.lastHeight) continue;
      if (heightTime.has(row.lastHeight)){ row.lastTime = heightTime.get(row.lastHeight); continue; }
      try {
        const hd = await rpc("getblockheader", [await rpc("getblockhash", [row.lastHeight])]);
        if (hd && hd.time){ heightTime.set(row.lastHeight, hd.time); row.lastTime = hd.time; }
      } catch (_) {}
    }
    snitchScanned = addrs.length;
    snitchAt = Date.now();
    saveSnitch();
  } finally { snitchScanning = false; }
}

// walk backwards from the tip so the list has substance on day one. Deliberately slow
// and gap-filled so it never competes with the live poll for the node.
let backfilling = false;
async function backfillSnitch(){
  if (backfilling || !rpcPortLocked || CFG.snitchBackfill <= 0) return;   // a pass outlives its interval; don't overlap
  backfilling = true;
  try { await backfillPass(); } finally { backfilling = false; }
}
async function backfillPass(){
  if (backfillAt == null) backfillAt = stats.height || 0;
  const floor = Math.max(1, (stats.height || 0) - CFG.snitchBackfill);
  let done = 0;
  while (backfillAt > floor && done < 150){
    const h = backfillAt - 1;
    try {
      const blk = await rpc("getblock", [await rpc("getblockhash", [h]), 2]);
      harvestSnitch(blk);
    } catch (_) {}
    backfillAt = h; done++;
  }
  if (backfillAt <= floor) saveSnitch();
}

// ---------------------------------------------------------------------------
// Explorer pages — our own block and transaction screens, straight off the node.
// getblock verbosity 2 carries every tx in full, so no txindex is needed: a tx is
// findable whenever we know its block (txWhere remembers, or the client says), and
// mempool txs come from getrawtransaction directly.
// ---------------------------------------------------------------------------
const HEX64 = /^[0-9a-fA-F]{64}$/;
const blockCache = new Map();                   // hash -> payload (LRU-ish, small)
// Veil's own v.type is the authority on what an output IS. A blinded (CT) output
// still carries an ordinary scriptPubKey of type pubkeyhash, so reading the script
// first reported every CT output as a plain transparent one, which is the most
// common output on the chain. Ask Veil first, and only fall back to the script for
// transparent outputs, where pubkeyhash / nonstandard is the more useful answer.
function voutKind(v){
  const t = String(v.type || "").toLowerCase();
  if (t.includes("anon") || t.includes("ringct")) return "ringct";
  if (t.includes("blind") || t === "ct") return "blind";
  if (t === "zerocoinmint" || t === "data") return t;
  return (v.scriptPubKey || {}).type || t || "unknown";
}
function voutIndex(v){ const n = v["vout.n"]; return n != null ? n : v.n; }   // Veil names it "vout.n"
function summarizeTx(tx, idx, isPos){
  let out = 0, nHidden = 0, ctFee = null;
  for (const v of (tx.vout || [])){
    const k = voutKind(v);
    if (typeof v.value === "number" && v.value > 0) out += v.value;
    if (k === "ringct" || k === "ct" || k === "blind") nHidden++;
    if (k === "data" && v.ct_fee != null) ctFee = +v.ct_fee;
  }
  const kind = idx === 0 ? "coinbase"
             : (isPos && idx === 1) ? "coinstake"
             : "tx";
  // ring size is per input, so ask every vin, not just the first one
  return { txid: tx.txid, type: classify(tx), vsize: tx.vsize || tx.size || 0,
           out: +out.toFixed(8), hidden: nHidden > 0, ctFee,
           nvin: (tx.vin || []).length, nvout: (tx.vout || []).length, kind,
           anon: spendsRing(tx), rings: ringSizes(tx) };
}
async function apiBlock(id){
  let hash = null;
  if (/^\d+$/.test(id)) hash = await rpc("getblockhash", [+id]);
  else if (HEX64.test(id)) hash = id;
  if (!hash) throw new Error("not a height or block hash");
  if (blockCache.has(hash)) return blockCache.get(hash);
  const b = await rpc("getblock", [hash, 2]);
  const isPos = detectAlgo(b) === "pos";
  // how long this block took: its timestamp minus its parent's
  let interval = null;
  if (b.previousblockhash){
    const ph = await rpc("getblockheader", [b.previousblockhash]).catch(() => null);
    if (ph && ph.time) interval = Math.max(0, b.time - ph.time);
  }
  const payload = {
    ok: true, height: b.height, hash: b.hash,
    prev: b.previousblockhash || null, next: b.nextblockhash || null,
    time: b.time, mediantime: b.mediantime, size: b.size, weight: b.weight,
    versionHex: b.versionHex, merkleroot: b.merkleroot, nonce: b.nonce64 || b.nonce,
    difficulty: b.difficulty, proofType: b.proof_type || "", algo: detectAlgo(b),
    powHash: b.progproofofworkhash || b.randomxproofofworkhash || b.sha256dproofofworkhash || null,
    superblock: isSuperblock(b.height), confirmations: b.confirmations,
    txcount: (b.tx || []).length, interval,
    txs: (b.tx || []).map((t, i) => summarizeTx(t, i, isPos)),
  };
  // roll up what the block moved in the clear, and its type mix
  let vol = 0, fees = 0; const mix = {};
  for (const t of payload.txs){
    if (t.kind === "tx"){ vol += t.out; mix[t.type] = (mix[t.type] || 0) + 1; }
    if (t.ctFee != null) fees += t.ctFee;
  }
  payload.visibleOut = +vol.toFixed(8); payload.feesVisible = +fees.toFixed(8);
  payload.typeMix = mix; payload.usd = usdPrice;
  blockCache.set(hash, payload);
  if (blockCache.size > 40){ for (const k of blockCache.keys()){ blockCache.delete(k); break; } }
  return payload;
}
function shapeVin(vin){
  if (vin.coinbase != null) return { kind: "coinbase" };
  if (vin.type === "zerocoinspend") return { kind: "zerocoinspend", denomination: vin.denomination };
  if (vin.type === "anon"){
    // the ring, in full: ring_size output references, each {txid, vout} — the real
    // source is one of them and the rest are decoys. No dedup: members are OUTPUTS,
    // and two members may legitimately share a txid.
    const ring = (vin.ringct_inputs || []).map(r => ({ txid: r.txid, n: r["vout.n"] != null ? r["vout.n"] : r.n }));
    return { kind: "anon", ringSize: vin.ring_size, inputs: vin.num_inputs,
             keyImages: (vin.key_images || []).length, ring };
  }
  return { kind: "standard", txid: vin.txid, vout: vin.vout };
}
function shapeVout(v){
  const k = voutKind(v);
  const o = { n: voutIndex(v), kind: k };
  if (typeof v.value === "number") o.value = v.value;
  const addrs = (v.scriptPubKey || {}).addresses;
  if (addrs && addrs.length){
    o.address = addrs[0];
    if (SNITCH_LABELS[o.address]) o.label = SNITCH_LABELS[o.address];   // fastpool, budget…
  }
  if (k === "ringct" || k === "ct" || k === "blind"){
    o.hidden = true;
    if (v.valueCommitment) o.commitment = String(v.valueCommitment).slice(0, 16);
  }
  if (k === "data" && v.ct_fee != null) o.ctFee = +v.ct_fee;
  return o;
}
async function apiTx(id, blockHint){
  if (!HEX64.test(id)) throw new Error("not a txid");
  let tx = null, ctx = null;
  let where = txWhere.get(id) || null;
  if (blockHint && HEX64.test(blockHint)) where = { hash: blockHint, h: null };
  else if (blockHint && /^\d+$/.test(blockHint)){
    const hh = await rpc("getblockhash", [+blockHint]).catch(() => null);
    if (hh) where = { hash: hh, h: +blockHint };
  }
  if (where){
    const b = await rpc("getblock", [where.hash, 2]);
    const idx = (b.tx || []).findIndex(t => t.txid === id);
    if (idx >= 0){
      tx = b.tx[idx];
      ctx = { height: b.height, blockhash: b.hash, time: b.time,
              confirmations: b.confirmations, algo: detectAlgo(b), pending: false,
              index: idx, of: (b.tx || []).length };
    }
  }
  if (!tx){
    // not in a block we know — the mempool can answer for pending txs
    tx = await rpc("getrawtransaction", [id, true]).catch(() => null);
    if (tx) ctx = { pending: true };
  }
  if (!tx) throw new Error("transaction not found — not in the mempool, and its block isn't known here. Open it from a block page or the feed.");
  let out = 0, ctFee = null;
  for (const v of (tx.vout || [])){
    if (typeof v.value === "number" && v.value > 0) out += v.value;
    if (voutKind(v) === "data" && v.ct_fee != null) ctFee = +v.ct_fee;
  }
  // src is what it actually SPENT, resolved from the prevout. The page needs it to
  // say where a mint came from, which is the part Veil's guidance is about.
  return { ok: true, txid: tx.txid, type: classify(tx), src: await sourceKind(tx, true),
           size: tx.size, vsize: tx.vsize || tx.size, locktime: tx.locktime,
           context: ctx, valueOut: +out.toFixed(8), ctFee,
           vin: (tx.vin || []).map(shapeVin), vout: (tx.vout || []).map(shapeVout) };
}

// ---------------------------------------------------------------------------
// Address page — no address index on the node, but scantxoutset gives an exact
// balance and UTXO set for one address. It scans the whole UTXO set (~seconds), so
// results are cached briefly and scans are serialized: a crowd clicking addresses
// can't stampede the node.
// ---------------------------------------------------------------------------
const addrCache = new Map();                 // address -> { at, payload }
async function apiAddress(addr){
  if (!addr || addr.length < 20 || addr.length > 120) throw new Error("not an address");
  const cached = addrCache.get(addr);
  if (cached && Date.now() - cached.at < 60000) return cached.payload;
  const vi = await rpc("validateaddress", [addr]).catch(() => null);
  if (!vi || !vi.isvalid) throw new Error("not a valid Veil address");
  const r = await scanUtxos([`addr(${addr})`]);   // shares the one-scan-at-a-time queue
  const utxos = (r && r.unspents) || [];
  let total = 0, sb = 0;
  const list = utxos.map(u => { total += u.amount || 0;
      if (u.height && u.height % SUPERBLOCK_INTERVAL === 0 && (u.amount || 0) >= 1000) sb++;
      return { amount: u.amount, height: u.height }; })
    .sort((a, b) => b.amount - a.amount);
  const payload = { ok: true, address: addr, valid: true,
    label: SNITCH_LABELS[addr] || (sb > 0 ? "budget" : ""),
    balance: +total.toFixed(8), utxos: utxos.length, usd: usdPrice,
    top: list.slice(0, 12), scannedAt: Date.now() };
  addrCache.set(addr, { at: Date.now(), payload });
  if (addrCache.size > 60){ for (const k of addrCache.keys()){ addrCache.delete(k); break; } }
  return payload;
}
// resolve a search box query to the right page
async function apiSearch(q){
  q = (q || "").trim();
  if (!q) return { kind: "none" };
  if (/^\d+$/.test(q)){
    const n = +q;
    const h = await rpc("getblockhash", [n]).catch(() => null);
    return h ? { kind: "block", id: String(n) } : { kind: "none" };
  }
  if (HEX64.test(q)){
    const hdr = await rpc("getblockheader", [q]).catch(() => null);
    return hdr ? { kind: "block", id: q } : { kind: "tx", id: q };  // hash that isn't a block -> try tx
  }
  const vi = await rpc("validateaddress", [q]).catch(() => null);
  if (vi && vi.isvalid) return { kind: "address", id: q };
  return { kind: "none" };
}

// crude per-IP token bucket — enough to stop one client hammering the RPC-backed
// endpoints when this is public. Cheap calls cost 1, an address scan costs 6.
const buckets = new Map();
function rateOk(ip, cost){
  const now = Date.now(), CAP = 40, REFILL = 40 / 10000;   // 40 tokens / 10s
  let b = buckets.get(ip);
  if (!b){ b = { t: CAP, ts: now }; buckets.set(ip, b); }
  b.t = Math.min(CAP, b.t + (now - b.ts) * REFILL); b.ts = now;
  if (buckets.size > 5000){ for (const k of buckets.keys()){ buckets.delete(k); break; } }
  if (b.t < cost) return false;
  b.t -= cost; return true;
}

// ---------------------------------------------------------------------------
// HTTP server (static + /api/state)
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  // public-facing basics: GET only, sane URL length, and a per-IP rate limit on /api
  if (req.method !== "GET" && req.method !== "HEAD"){ res.writeHead(405); res.end("method not allowed"); return; }
  if (req.url.length > 1024){ res.writeHead(414); res.end("uri too long"); return; }
  const u = new URL(req.url, "http://localhost");
  if (u.pathname.startsWith("/api/")){
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    const cost = u.pathname === "/api/address" ? 6 : 1;
    if (!rateOk(ip, cost)){ res.writeHead(429, { "Retry-After": "3" }); res.end('{"ok":false,"error":"slow down"}'); return; }
  }
  if (u.pathname === "/api/state") {
    const from = +(u.searchParams.get("since") || -1);
    // computed per request so the clock advances smoothly instead of in 2.5s steps
    const liveStats = { ...stats, sinceBlock: tipTime ? Math.max(0, Date.now() / 1000 - tipTime) : 0 };
    const payload = { mode: stats.mode, seq, stats: liveStats, events: from < 0 ? [] : since(from) };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
    return;
  }
  if (u.pathname === "/api/address") {
    apiAddress((u.searchParams.get("id") || "").trim())
      .then(payload => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
                         res.end(JSON.stringify(payload)); })
      .catch(e => { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (u.pathname === "/api/search") {
    apiSearch((u.searchParams.get("q") || "").slice(0, 120))
      .then(r => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
                   res.end(JSON.stringify(r)); })
      .catch(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"kind":"none"}'); });
    return;
  }
  if (u.pathname === "/api/block" || u.pathname === "/api/tx") {
    const wants = u.pathname === "/api/block";
    const id = (u.searchParams.get("id") || "").slice(0, 80).trim();
    const hint = (u.searchParams.get("block") || "").slice(0, 70).trim();
    (wants ? apiBlock(id) : apiTx(id, hint))
      .then(payload => { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
                         res.end(JSON.stringify(payload)); })
      .catch(e => { res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ ok: false, error: e.message })); });
    return;
  }
  if (u.pathname === "/api/mempool") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, txs: [...memNow.values()].slice(0, 200) }));
    return;
  }
  if (u.pathname === "/api/snitch") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ list: snitchList, seen: snitchSeen.size, priced: snitchScanned,
                             updated: snitchAt, scanning: snitchScanning,
                             backfillAt, usd: usdPrice }));
    return;
  }
  // static
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  const file = path.join(__dirname, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream",
      // the page itself must never be stale — a refresh should always pick up new code
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300" });
    res.end(data);
  });
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`\n  Port ${CFG.port} is already in use — VeilStreet may already be running there.`);
    console.error(`  Open http://localhost:${CFG.port}, or start on another port:  PORT=8791 node server.js\n`);
    process.exit(1);
  }
  throw e;
});
server.listen(CFG.port, CFG.host, () => {
  console.log(`\n  VeilStreet  →  http://${CFG.host === "0.0.0.0" ? "localhost" : CFG.host}:${CFG.port}`);
  console.log(`  feed: ${CFG.feed.toUpperCase()}` + (CFG.feed === "rpc" ? `  (veild ${CFG.rpcHost}:${CFG.rpcPort || "auto-detect"})` : "") + "\n");
  if (CFG.feed === "mock") startMock();
  else {
    poll(); setInterval(poll, CFG.pollMs);
    setTimeout(rankSnitch, 8000); setInterval(rankSnitch, CFG.snitchEveryMs);
    setInterval(backfillSnitch, 2000);        // trickle the backfill in behind the live feed
  }
});
