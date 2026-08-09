# Deploying VeilStreet

VeilStreet is a static page plus a zero-dependency Node backend that reads a local
`veild` over JSON-RPC. To put it online you need a box already running a synced Veil
node, Node.js, and a reverse proxy for TLS.

The mainnet site and the testnet mirror are the same code on two boxes — each auto-
detects the node it finds locally, so nothing chain-specific is configured.

## 1. On the VPS

```bash
# node (v18+)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# the app
cd /home/veil
git clone https://github.com/ohcee/veil-txstreet.git
cd veil-txstreet
node --check server.js     # sanity
```

The box's `veild` needs RPC enabled in `veil.conf`:

```ini
server=1
rpcuser=veilrpc
rpcpassword=A_STRONG_SECRET
rpcallowip=127.0.0.1
```

## 2. Run it as a service

```bash
sudo cp deploy/veilstreet.service /etc/systemd/system/
sudoedit /etc/systemd/system/veilstreet.service   # set User, WorkingDirectory, and the RPC creds
sudo systemctl daemon-reload
sudo systemctl enable --now veilstreet
systemctl status veilstreet
```

It binds `127.0.0.1:8790` (via `BIND=127.0.0.1`), so the raw port is never public —
Caddy is the only thing exposed.

## 3. TLS + reverse proxy (Caddy)

```bash
sudo apt-get install -y caddy       # or the official Caddy install
```

Point a DNS **A record** (e.g. `street.veil-info.org`) at the VPS, then add the block
from `deploy/Caddyfile` to `/etc/caddy/Caddyfile` and:

```bash
sudo systemctl reload caddy
```

Caddy fetches a certificate automatically and proxies `443 → 127.0.0.1:8790`.

## 4. Testnet mirror

Same steps on the testnet VPS (its `veild` runs with `-testnet`, RPC 58813). The app
auto-detects it. Use a separate name like `testnet-street.veil-info.org` (the second,
commented block in the Caddyfile).

## Notes

- **Snitch harvest** builds over time; the first backfill (~20k blocks) runs in the
  background and persists to `snitch-addrs.json`, so it survives restarts.
- **Rate limiting** is per-IP in the app, keyed off Caddy's `X-Forwarded-For`. The
  address endpoint (a full UTXO scan) costs more tokens and results are cached ~60s.
- **Updating**: `git pull && sudo systemctl restart veilstreet`. HTML is served
  `no-cache`, so browsers pick up new code on the next load.
- **Price/USD** comes from NonKYC; if the box can't reach it, fees just show in VEIL.
