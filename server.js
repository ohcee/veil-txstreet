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
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); } catch (_) {}
const CFG = {
  port: +(process.env.PORT || fileCfg.port || 8790),
  feed: (process.env.FEED || fileCfg.feed || "rpc").toLowerCase(),
  rpcHost: process.env.VEIL_RPC_HOST || fileCfg.rpcHost || "127.0.0.1",
  rpcPort: +(process.env.VEIL_RPC_PORT || fileCfg.rpcPort || 58812),
  rpcUser: process.env.VEIL_RPC_USER || fileCfg.rpcUser || "",
  rpcPass: process.env.VEIL_RPC_PASS || fileCfg.rpcPass || "",
  rpcCookie: process.env.VEIL_RPC_COOKIE || fileCfg.rpcCookie || "",
  pollMs: +(process.env.POLL_MS || fileCfg.pollMs || 2500),
  mockBlockMs: +(process.env.MOCK_BLOCK_MS || fileCfg.mockBlockMs || 60000),
};

// ---------------------------------------------------------------------------
// shared state: an append-only ring buffer of {seq, kind, ...} events
// ---------------------------------------------------------------------------
let seq = 0;
const MAX_EVENTS = 3000;
const events = [];
let stats = { mode: "offline", network: "veil", height: 0, difficulty: 0, hashrate: 0, mempool: 0, updated: Date.now() };

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
let warned = false;

async function poll() {
  try {
    const info = await rpc("getblockchaininfo");
    const mining = await rpc("getmininginfo").catch(() => null);
    const mem = await rpc("getmempoolinfo").catch(() => ({ size: 0 }));
    const height = info.blocks;
    stats = {
      mode: "live", network: info.chain || "main", height,
      difficulty: info.difficulty || 0,
      hashrate: mining ? (mining.networkhashps || 0) : 0,
      mempool: mem.size || 0, updated: Date.now(),
    };

    // new blocks
    if (lastHeight != null && height > lastHeight) {
      for (let h = lastHeight + 1; h <= height; h++) {
        try {
          const hash = await rpc("getblockhash", [h]);
          const blk = await rpc("getblock", [hash]);
          push({ kind: "block", height: h, hash, txcount: (blk.tx || []).length, size: blk.size || 0, time: blk.time || Date.now() / 1000 });
          for (const tid of (blk.tx || [])) known.delete(tid);
        } catch (_) {}
      }
    }
    lastHeight = height;

    // mempool diff
    const mp = await rpc("getrawmempool", [true]);
    const cur = Object.keys(mp);
    const curSet = new Set(cur);
    for (const tid of [...known]) if (!curSet.has(tid)) known.delete(tid);
    const fresh = cur.filter(t => !known.has(t));
    const CAP = 40;                       // animate at most CAP new tx per poll
    fresh.slice(0, CAP).forEach(tid => { known.add(tid); enqueueTx(tid, mp[tid]); });
    fresh.slice(CAP).forEach(tid => known.add(tid));  // absorb the rest silently
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
  stats = { mode: "live", network: "mock", height: h, difficulty: 230000, hashrate: 400e6, mempool: 0, updated: Date.now() };
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
    push({ kind: "block", height: h, hash: randHex(64), txcount, size: txcount * 1600, time: Date.now() / 1000 });
    stats.height = h; stats.mempool = Math.max(0, stats.mempool - txcount);
  }, CFG.mockBlockMs);
}

// ---------------------------------------------------------------------------
// HTTP server (static + /api/state)
// ---------------------------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname === "/api/state") {
    const from = +(u.searchParams.get("since") || -1);
    const payload = { mode: stats.mode, seq, stats, events: from < 0 ? [] : since(from) };
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
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
  console.log(`  feed: ${CFG.feed.toUpperCase()}` + (CFG.feed === "rpc" ? `  (veild ${CFG.rpcHost}:${CFG.rpcPort})` : "") + "\n");
  if (CFG.feed === "mock") startMock();
  else { poll(); setInterval(poll, CFG.pollMs); }
});
