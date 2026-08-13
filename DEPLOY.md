# Deploying VeilStreet

VeilStreet is a static page plus a zero dependency Node backend that reads a local
`veild` over JSON-RPC. To put it online you need a box already running a synced Veil
node, Node.js, and Caddy for TLS.

It is live on both chains:

* mainnet: https://street.veil-info.org (on the Veil Academy box, alongside the faucet)
* testnet: https://testnet-street.veil-info.org

The two are the same code. Each points at its local node; the only per box
differences are the RPC port and, on testnet, turning USD off.

## 1. Get the code onto the box

Either clone it:

```bash
cd /home/veil
git clone https://github.com/ohcee/veil-txstreet.git
```

or rsync your working copy up (handy before the code is pushed):

```bash
rsync -az --exclude='.git' --exclude='config.json' --exclude='snitch-addrs*.json' \
  ./ USER@HOST:/home/USER/veil-txstreet/
```

Node 18 from the distro is fine (the backend has no dependencies):

```bash
sudo apt-get install -y nodejs
node --check server.js
```

## 2. RPC settings in a root only env file

The node needs RPC on in `veil.conf` (either `rpcuser`/`rpcpassword`, or a cookie in
the datadir). Put the app's settings in `/etc/veilstreet.env`, owned by root, mode
600, so nothing secret lands in the repo:

```ini
BIND=127.0.0.1
PORT=8790
VEIL_RPC_PORT=58812        # 58812 mainnet, 58813 testnet
VEIL_RPC_USER=veilrpc      # match veil.conf
VEIL_RPC_PASS=YOUR_SECRET
```

If your node writes a cookie instead of user/pass, skip those two and point at it:

```ini
VEIL_RPC_COOKIE=/home/USER/.veil/.cookie
```

The cookie is read fresh on every call, so a veild restart that rotates it is picked
up on its own.

On testnet, add one line so the page drops dollar figures that mean nothing there:

```ini
VEIL_NO_USD=1
```

## 3. Run it as a service

Copy the unit, set `User` and `WorkingDirectory` to the checkout, then start it:

```bash
sudo cp deploy/veilstreet.service /etc/systemd/system/
sudoedit /etc/systemd/system/veilstreet.service   # User + WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now veilstreet
curl -s localhost:8790/api/state | head -c 120     # expect "network":"main" (or "test")
```

It binds `127.0.0.1:8790`, so the raw port is never public. Give the first poll a few
seconds on mainnet: `getblockchaininfo` is heavy and the app reads `offline` until the
first one returns, then flips to `live`.

## 4. TLS and reverse proxy (Caddy)

Install Caddy (the official cloudsmith repo, or your distro), point a DNS **A record**
at the box (grey cloud / DNS only on Cloudflare, so the ACME challenge reaches the
origin), then add the block from `deploy/Caddyfile`. If the box already runs Caddy for
another site, append the block to the existing `/etc/caddy/Caddyfile` instead of
replacing it. Validate before reloading so a bad edit can't drop the running config:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

Caddy fetches the certificate on its own once DNS resolves and proxies
`443 -> 127.0.0.1:8790`.

Do not add a `log { output file ... }` block. The distro Caddy sandbox cannot write
`/var/log/caddy`, and a file log makes the reload fail with HTTP 400 (the old config
keeps running, so a live site survives the bad reload). Access logs go to
`journalctl -u caddy`.

## 5. Testnet mirror

Same steps on the testnet box: `VEIL_RPC_PORT=58813`, `VEIL_NO_USD=1`, and a name like
`testnet-street.veil-info.org` (the commented block in the Caddyfile).

## Deploying changes

```bash
cp deploy.conf.example deploy.conf     # once: point it at your boxes
./deploy.sh                            # both targets
./deploy.sh mainnet                    # one
./deploy.sh --dry-run                  # show what would change, touch nothing
```

It runs `npm test` first and **deploys nothing if a test fails**, since those tests
decide what a transaction is and a wrong answer there ships a false claim about
somebody's privacy. Then per target it rsyncs, hands ownership over if the service
runs as a different user, restarts, and proves the result three ways: the deployed
bytes hash the same as local, the node answers on the chain it was supposed to serve,
and the public URL returns 200. Any of those failing exits non-zero.

It never touches git. Deploying and publishing are separate decisions, and it warns
if the tree is dirty or commits are unpushed rather than doing anything about it.

`config.json`, the harvested addresses and the block history are excluded: those
belong to the box, not the repo. That is also why the two nodes can be tuned
differently, and why reading the source tells you less about a running box than
reading its `config.json` does.

## Notes

* **Snitch harvest** builds over time; the first backfill runs in the background and
  persists to `snitch-addrs.json` (per chain), so it survives restarts.
* **Rate limiting** is per IP in the app, keyed off Caddy's `X-Forwarded-For`. The
  address endpoint (a full UTXO scan) costs more and results are cached about 60s.
* **Updating**: rsync or `git pull`, then `sudo systemctl restart veilstreet`. HTML is
  served no cache, so browsers pick up new code on the next load.
* **USD** comes from NonKYC. Leave it on for mainnet; set `VEIL_NO_USD=1` on testnet.
