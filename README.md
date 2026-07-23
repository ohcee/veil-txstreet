# VeilStreet

A live, TxStreet-style privacy-transaction visualizer for **Veil (VEIL)**. Transactions
walk down the street as hooded figures (grey = Basecoin, cyan = Stealth, magenta =
RingCT), board the block-bus, and ride off when a block is found. Figure size tracks
transaction **vSize** (amounts are hidden on a privacy chain, exactly like TxStreet's
Monero street), and walking speed tracks fee priority.

Built with a zero-dependency Node backend (`server.js`) and a single self-contained
`index.html` (pure Canvas 2D — no build step, no npm install).

- Studied from the MIT-licensed [TxStreet](https://github.com/txstreet/txstreet) /
  [processor](https://github.com/txstreet/processor); all art and code here are original.

---

## Quick start

**See it immediately (mock live feed):**

```bash
FEED=mock node server.js
```

Open http://localhost:8790 — the badge reads **LIVE · MOCK** and a synthetic feed drives
the street. (No node required; good for demos and development.)

**Static only (no backend):** just open `index.html` in a browser. With no `/api/state`
to reach, the badge shows **OFFLINE · SIM** and the built-in simulation runs.

---

## Real data (point it at your Veil node)

The backend reads a `veild` over JSON-RPC and serves a live delta feed the page consumes.

1. In your `veil.conf` enable the RPC server:

   ```ini
   server=1
   rpcuser=veilrpc
   rpcpassword=CHANGE_ME
   rpcallowip=127.0.0.1
   # txindex=1   # optional — only needed to resolve non-mempool txs
   ```

2. Start `veild`, then run the backend against it:

   ```bash
   VEIL_RPC_HOST=127.0.0.1 \
   VEIL_RPC_PORT=58812 \
   VEIL_RPC_USER=veilrpc \
   VEIL_RPC_PASS=CHANGE_ME \
   node server.js
   ```

   …or copy `config.example.json` → `config.json`, fill it in, and just run `node server.js`.
   (Cookie auth: set `VEIL_RPC_COOKIE=/path/to/datadir/.cookie` instead of user/pass.)

3. Open http://localhost:8790 — the badge reads **LIVE**. New mempool transactions appear
   as walkers; each new block departs the bus with its real height / hash / tx count.

If the node is unreachable the feed reports **OFFLINE** and the page falls back to the
simulation, so it never breaks.

### What it reads

| RPC call | Used for |
|---|---|
| `getblockchaininfo` | height, difficulty, chain |
| `getmininginfo` | network hashrate |
| `getmempoolinfo` | mempool size |
| `getrawmempool true` | new transactions (vSize, fee, time) |
| `getrawtransaction <txid> true` | classify Basecoin / Stealth / RingCT by output type |
| `getblockhash` / `getblock` | new blocks (hash, tx count, size) |

Transactions link out to the [Veil explorer](https://explorer.veil-project.com/main):
click a walker or a sidebar row to open `/main/tx/<txid>`, or the bus to open `/main/blocks`.

---

## Configuration

All optional. Env var overrides `config.json` overrides the built-in default.

| Env | config.json | Default | Meaning |
|---|---|---|---|
| `PORT` | `port` | `8790` | HTTP port |
| `FEED` | `feed` | `rpc` | `rpc` (real node) or `mock` (synthetic) |
| `VEIL_RPC_HOST` | `rpcHost` | `127.0.0.1` | node host |
| `VEIL_RPC_PORT` | `rpcPort` | `58812` | node RPC port (Veil mainnet) |
| `VEIL_RPC_USER` / `VEIL_RPC_PASS` | `rpcUser` / `rpcPass` | — | RPC credentials |
| `VEIL_RPC_COOKIE` | `rpcCookie` | — | path to `.cookie` (instead of user/pass) |
| `POLL_MS` | `pollMs` | `2500` | RPC poll interval |
| `MOCK_BLOCK_MS` | `mockBlockMs` | `60000` | mock block interval |

---

## Files

- `index.html` — the whole front-end (Canvas 2D scene, HUD, sidebar).
- `server.js` — zero-dependency backend: RPC poller + mock feed + static server + `/api/state`.
- `config.example.json` — copy to `config.json` to configure without env vars.

## Notes

- Veil is multi-algorithm; `getblockchaininfo.difficulty` reports a single value, so the
  difficulty stat is indicative — refine per-algo if you need it exact.
- `getrawtransaction` works on mempool transactions without `txindex`; enable `txindex`
  only if you also want to resolve confirmed/historical txs.
