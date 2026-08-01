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
  snitchBackfill: 20000,     // blocks to walk back once, seeding the snitch list
  snitchEveryMs: 90000,      // how often to re-price the harvested addresses
  port: +(process.env.PORT || fileCfg.port || 8790),
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
};

// ---------------------------------------------------------------------------
// VEIL/USD price (for dollar fee estimates) — pinned, or polled from NonKYC
// ---------------------------------------------------------------------------
let usdPrice = CFG.veilUsd;                 // 0 until known
const priceAuto = !CFG.veilUsd;             // only auto-fetch when not pinned
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
// mainnet's 58812 first, then testnet's 58813 — and lock onto it.
let rpcPortLocked = CFG.rpcPort > 0;
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
function rpc(method, params = []) {
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
      timeout: 8000,
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
function enqueueTx(txid, mp) { txQ.push({ txid, mp }); pumpTx(); }
function pumpTx() {
  while (inflight < 4 && txQ.length) {
    const { txid, mp } = txQ.shift();
    const vsize = mp.vsize || mp.size || 500;
    const fee = mp.fee != null ? mp.fee : (mp.fees && mp.fees.base) || 0;
    const time = mp.time || Date.now() / 1000;
    if (txQ.length > 30) { // backlog: skip detail lookup, use size heuristic
      push({ kind: "tx", txid, vsize, fee, type: heuristicType(vsize), time });
      continue;
    }
    inflight++;
    rpc("getrawtransaction", [txid, true])
      .then(tx => push({ kind: "tx", txid, vsize, fee, type: classify(tx), time }))
      .catch(() => push({ kind: "tx", txid, vsize, fee, type: heuristicType(vsize), time }))
      .finally(() => { inflight--; pumpTx(); });
  }
}

// ---------------------------------------------------------------------------
// RPC poller
// ---------------------------------------------------------------------------
const known = new Set();
let lastHeight = null;
let tipTime = null;                       // unix time of the tip block (for "time since block")
let warned = false;

async function poll() {
  try {
    if (!rpcPortLocked && !(await detectPort())) {
      stats = { ...stats, mode: "offline", updated: Date.now() };
      return;                                // neither node answered; try again next poll
    }
    const info = await rpc("getblockchaininfo");
    const mining = await rpc("getmininginfo").catch(() => null);
    const mem = await rpc("getmempoolinfo").catch(() => ({ size: 0 }));
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
          txs.forEach((tx, idx) => {
            const tid = full ? (tx.txid || tx) : tx;
            if (idx >= rewardTxs && !known.has(tid)) {
              if (full) push({ kind: "tx", txid: tid, vsize: tx.vsize || tx.size || 500, fee: 0, type: classify(tx), time: blk.time || Date.now() / 1000 });
              else push({ kind: "tx", txid: tid, vsize: 800, fee: 0, type: heuristicType(800), time: blk.time || Date.now() / 1000 });
            }
            known.delete(tid);
          });
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
      updated: Date.now(),
    };

    // mempool diff
    const mp = await rpc("getrawmempool", [true]);
    const cur = Object.keys(mp);
    const curSet = new Set(cur);
    for (const tid of [...known]) if (!curSet.has(tid)) known.delete(tid);
    const fresh = cur.filter(t => !known.has(t));
    const CAP = 120;                      // classify (via RPC) up to CAP new tx per poll
    fresh.slice(0, CAP).forEach(tid => { known.add(tid); enqueueTx(tid, mp[tid]); });
    fresh.slice(CAP).forEach(tid => {     // overflow: still surface it (size heuristic, no RPC)
      known.add(tid);
      const mpx = mp[tid], vsize = mpx.vsize || mpx.size || 500;
      push({ kind: "tx", txid: tid, vsize, fee: mpx.fee != null ? mpx.fee : (mpx.fees && mpx.fees.base) || 0, type: heuristicType(vsize), time: mpx.time || Date.now() / 1000 });
    });
    warned = false;
  } catch (e) {
    stats = { ...stats, mode: "offline", updated: Date.now() };
    if (!warned) { console.warn("[veilstreet] RPC unreachable (" + e.message + ") — serving in OFFLINE/sim mode."); warned = true; }
  }
}

// ---------------------------------------------------------------------------
// mock feed
// ---------------------------------------------------------------------------
function randHex(n) { let s = ""; const h = "0123456789abcdef"; for (let i = 0; i < n; i++) s += h[(Math.random() * 16) | 0]; return s; }
function startMock() {
  let h = 3_200_000 + ((Math.random() * 5000) | 0);
  stats = { mode: "live", network: "mock", height: h, difficulty: 230000, hashrate: 400e6, mempool: 0, usd: usdPrice || 0.0016, updated: Date.now() };
  setInterval(() => {
    stats.hashrate = Math.max(2e8, stats.hashrate + (Math.random() - 0.5) * 3e7);
    stats.difficulty = Math.max(1e5, stats.difficulty + (Math.random() - 0.5) * 8000);
    stats.updated = Date.now();
    const n = 1 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const r = Math.random();
      const type = r < 0.2 ? "base" : r < 0.55 ? "stealth" : "ringct";
      const vsize = Math.round(type === "ringct" ? 2200 + Math.random() * 3200 : type === "stealth" ? 900 + Math.random() * 1400 : 240 + Math.random() * 420);
      push({ kind: "tx", txid: randHex(64), vsize, fee: +(Math.random() * 0.001).toFixed(6), type, time: Date.now() / 1000 });
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
const SNITCH_BATCH = 600;                  // descriptors per scantxoutset pass
let snitchSeen = new Map();                // address -> scriptPubKey hex
let snitchList = [];                       // ranked [{ addr, amount, outs }]
let snitchAt = 0;                          // when the ranking was last refreshed
let snitchScanning = false;
let snitchScanned = 0;                     // addresses priced in the last pass
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
      try { r = await rpc("scantxoutset", ["start", batch.map(a => `addr(${a})`)]); }
      catch (_) { continue; }                      // a bad descriptor kills the batch, not the pass
      if (!r || !r.success) continue;
      for (const u of (r.unspents || [])){
        const a = byHex.get(u.scriptPubKey);        // this build returns no desc — map via the script
        if (!a) continue;
        const t = totals.get(a) || { amount: 0, outs: 0, sb: 0 };
        t.amount += u.amount || 0; t.outs++;
        // Veil pays its budget on superblocks (every 43200). A large payout landing on
        // one of those exact heights marks the treasury, not somebody's exposed stash.
        // Requiring a big amount too, so an ordinary tx that happens to confirm in a
        // superblock (1-in-43200) isn't mislabelled.
        if (u.height && u.height % SUPERBLOCK_INTERVAL === 0 && (u.amount || 0) >= 1000) t.sb++;
        totals.set(a, t);
      }
    }
    snitchList = [...totals.entries()]
      .map(([addr, t]) => ({ addr, amount: +t.amount.toFixed(8), outs: t.outs,
                             label: SNITCH_LABELS[addr] || (t.sb > 0 ? "budget" : "") }))
      .filter(x => x.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 15);
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
// HTTP server (static + /api/state)
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/state") {
    const from = +(u.searchParams.get("since") || -1);
    // computed per request so the clock advances smoothly instead of in 2.5s steps
    const liveStats = { ...stats, sinceBlock: tipTime ? Math.max(0, Date.now() / 1000 - tipTime) : 0 };
    const payload = { mode: stats.mode, seq, stats: liveStats, events: from < 0 ? [] : since(from) };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
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
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
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
server.listen(CFG.port, () => {
  console.log(`\n  VeilStreet  →  http://localhost:${CFG.port}`);
  console.log(`  feed: ${CFG.feed.toUpperCase()}` + (CFG.feed === "rpc" ? `  (veild ${CFG.rpcHost}:${CFG.rpcPort || "auto-detect"})` : "") + "\n");
  if (CFG.feed === "mock") startMock();
  else {
    poll(); setInterval(poll, CFG.pollMs);
    setTimeout(rankSnitch, 8000); setInterval(rankSnitch, CFG.snitchEveryMs);
    setInterval(backfillSnitch, 2000);        // trickle the backfill in behind the live feed
  }
});
