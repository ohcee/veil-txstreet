# VeilStreet

A live, TxStreet-style visualizer for **Veil (VEIL)** set in space, because Veil's
community used to call themselves **Veilians**. Every mempool transaction is a Veilian
walking to the mothership (the forming block), boarding as they arrive. When the
network finds a block, the BLOCK FOUND sign flickers on and the ship lifts off with
everyone the block accepted anyone it turned away steps off, sits out a few seconds
by the stairs, and catches the next ship.

How private a transaction is decides what its Veilian looks like **and how it
arrives** — the arrival is a picture of its traceability:

| Type | Being | Arrival |
|---|---|---|
| **Basecoin** (grey) | human | walks out the front door of **The Transparent House** origin in plain sight |
| **Stealth** (cyan) | full alien | surfaces through a ground portal you see the point, not the source |
| **RingCT** (magenta) | hybrid, cloaked to a faint ghost | arrives under **the veil** a dark curtain hiding twelve portals (one per ring in the signature). The field only lights up *through* the cloth when a transaction lands, every portal flashing at once, and the Veilian walks out from under the sign no telling which door |

The block's **coinbase** is an astronaut who climbs out of the mine carrying a gold
coin (on a superblock he gets an armed escort that's the monthly budget payout), and
the coin rides in the ship's cockpit. Figure size tracks transaction **vSize** (amounts
are hidden on a privacy chain, like TxStreet's Monero street); walking speed tracks fee
priority.

Reading the ship: the dome is a glass viewport into the cabin, and the **portholes are
a load gauge** one light per ten transactions waiting or aboard, all yellow at 90,
all red past 100. Anyone waiting by the stairs stands still while the chain is healthy
and starts fidgeting when the block runs late; the marquee clock heats up with it.

Built with a zero-dependency Node backend (`server.js`) and a single self-contained
`index.html` (pure Canvas 2D no build step, no npm install).

- Studied from the MIT-licensed [TxStreet](https://github.com/txstreet/txstreet) /
  [processor](https://github.com/txstreet/processor); all art and code here are original.

---

## Live

Running on both chains, each reading its own node:

* mainnet: **https://street.veil-info.org**
* testnet: **https://testnet-street.veil-info.org**

To host your own, see [DEPLOY.md](DEPLOY.md): a systemd service bound to localhost
behind Caddy for TLS, reading a local `veild`.

---

## Quick start

**With a local Veil node (the real thing):**

```bash
./start.sh
```

Starts `veild` if it isn't running (set `VEIL_DIR` if your binaries aren't in
`~/Downloads/macosx-binaries`), waits for the RPC to answer, then serves the
visualizer at http://localhost:8790 and prints the LAN URL for your phone.

The chain is **auto-detected**: it probes mainnet's RPC port (58812) first, then
testnet's (58813), and locks onto whichever node answers. Force one with:

```bash
./start.sh testnet     # or: ./start.sh mainnet
```

**See it immediately (no node):**

```bash
FEED=mock node server.js
```

The badge reads **LIVE · MOCK** and a synthetic feed drives the street.

**Static only:** open `index.html` in a browser — with no backend the badge shows
**OFFLINE · SIM** and a built-in simulation runs.

---

## Real data (what it reads from veild)

The backend polls a `veild` over JSON-RPC and serves a delta feed the page consumes.
If the node is unreachable the feed reports **OFFLINE** and the page falls back to the
simulation, so it never breaks.

| RPC call | Used for |
|---|---|
| `getblockchaininfo` | height, chain, best block hash (shown on the waiting ship), per-algo difficulty |
| `getchainalgostats` | true average block time and the algorithm mix (~25h window) |
| `getmininginfo` | network hashrate |
| `getmempoolinfo` | mempool size |
| `getrawmempool true` | new transactions (vSize, fee, time) |
| `getrawtransaction <txid> true` | classify Basecoin / Stealth / RingCT by output type |
| `getblockhash` / `getblock` | new blocks (hash, tx count, algorithm, txids), and the in-app block/tx pages |
| `scantxoutset` | exact balances for the Snitch List and the address page |
| `validateaddress` | resolve a search query or address page |
| `getpeerinfo` | peer count and versions for the network panel |

Node config (`veil.conf`):

```ini
server=1
rpcuser=veilrpc
rpcpassword=CHANGE_ME
rpcallowip=127.0.0.1
```

Copy `config.example.json` → `config.json` with your credentials, or pass them as env
vars.

Clicking any block or transaction in the feed, the recent-blocks strip, or the scene
itself opens **its own data page in-app**, served off your node: block pages with
header fields, per-algo detail and the tx list; transaction pages with type, ring size,
commitments, and the RingCT fee (which Veil keeps in the clear even when amounts are
hidden); and address pages with the transparent balance, its USD value, and the top
UTXOs (with the honest caveat that only transparent coin is countable). The **search
box** up top jumps straight to any block height, block hash, txid, or address. Pages
are deep-linkable (`#/block/<height>`, `#/tx/<txid>`, `#/address/<addr>`), with the
[Veil explorer](https://explorer.veil-project.com/main) one click away in the footer.

The algorithm panel also carries a small **network health** readout: peer count (in and
out), the `seed.veil-info.org` seeder's status, and two sparklines tracking recent block
arrivals and mempool depth.

### The Snitch List

Instead of a rich list, a **snitch list**: the largest **transparent** (basecoin)
addresses the ones anyone can read. The node keeps no address index, so the server
harvests addresses from blocks as they stream past (plus a one-time ~20k-block
backfill) and prices the whole set against the UTXO set with `scantxoutset` every 90s.
Balances are exact; coverage is the addresses it has *seen*, and the panel says so.

Stealth and RingCT outputs carry no address at all, so they can never appear which
is the point. Addresses paid on superblock heights are tagged **budget** (that's
Veil's treasury, not somebody's stash); name pools and services in
`snitch-labels.json`. The harvest persists per chain (`snitch-addrs.json` for mainnet,
`snitch-addrs-<port>.json` otherwise) and is gitignored.

### Superblocks

Veil pays its budget on a superblock every **43,200 blocks** (~monthly). There's no
RPC for it the server derives it from the interval, same as the explorers. The
marquee counts down to the next one, and on the superblock itself the coinbase
astronaut walks out of the mine under armed escort with the payout in a hover-crate.
Preview it any time with `?superblock=1`.

---

## Configuration

All optional. Env var overrides `config.json` overrides the built-in default.

| Env | config.json | Default | Meaning |
|---|---|---|---|
| `PORT` | `port` | `8790` | HTTP port |
| `FEED` | `feed` | `rpc` | `rpc` (real node) or `mock` (synthetic) |
| `VEIL_RPC_HOST` | `rpcHost` | `127.0.0.1` | node host |
| `VEIL_RPC_PORT` | `rpcPort` | *auto* | RPC port; unset = probe 58812 then 58813 |
| `VEIL_RPC_USER` / `VEIL_RPC_PASS` | `rpcUser` / `rpcPass` | — | RPC credentials |
| `VEIL_RPC_COOKIE` | `rpcCookie` | — | path to `.cookie` (instead of user/pass) |
| `POLL_MS` | `pollMs` | `2500` | RPC poll interval |
| `MOCK_BLOCK_MS` | `mockBlockMs` | `60000` | mock block interval |
| `VEIL_USD` | `veilUsd` | *auto* | pin the VEIL→USD price; unset = live NonKYC price |
| `VEIL_MARKET` | `veilMarket` | `VEIL_USDT` | NonKYC market for the auto price |
| `VEIL_NO_USD` | `noUsd` | `false` | drop all USD figures (the live testnet mirror sets this) |
| — | `snitchLabels` | — | extra `{ "<address>": "name" }` labels for the Snitch List |

---

## Files

- `index.html` — the whole front-end (Canvas 2D scene, HUD, feed, snitch list).
- `server.js` — zero-dependency backend: RPC poller, chain auto-detect, snitch
  harvester, mock feed, static server, `/api/state` + `/api/snitch`.
- `start.sh` — one-command startup: node + RPC wait + visualizer, `testnet`/`mainnet` aware.
- `config.example.json` — copy to `config.json` to configure without env vars.
- `snitch-labels.json` — names for known transparent addresses (pools, treasury).
- `veil-mark.svg` — the Veil brand mark (from the official presskit), used on the ship
  and worn as the "V" on every Veilian's face.

## Notes

- On phones the scene strips down to the essentials: the lane, the ship, and the
  walkers. Open it from another device via the LAN URL `start.sh` prints.
- USD figures come from the mainnet market price. Set `VEIL_NO_USD=1` (as the live
  testnet mirror does) to drop them, since testnet coins have no market value.
- Rejection is honest: a transaction that boards but isn't in the found block steps
  off, sits out a few seconds by the stairs, and boards the next ship. The reverse
  holds too a walker whose tx made the block beams aboard as it lifts off, never
  left behind to ride a ship its transaction isn't in.
- The scene keeps simulating in a background tab, so tabbing away and back never
  leaves stacked ships or a lost astronaut. Blocks that land while you're gone play
  out the same as ones you watched.
