#!/usr/bin/env bash
# Start VeilStreet: brings up the Veil node if it isn't already, waits for its RPC to
# answer, then starts the visualizer. Safe to re-run — it never starts a second copy.
set -uo pipefail
cd "$(dirname "$0")"

VEIL_DIR="${VEIL_DIR:-$HOME/Downloads/macosx-binaries}"
RPC_HOST=127.0.0.1
RPC_USER=veil
RPC_PASS=veil
PORT="${PORT:-8790}"

# "./start.sh testnet" runs everything against the testnet chain (RPC 58813)
CHAIN_FLAG=""
RPC_PORT=58812
if [ "${1:-}" = "testnet" ]; then
  CHAIN_FLAG="-testnet"
  RPC_PORT=58813
  echo "  chain: TESTNET"
fi

rpc() {
  curl -s --max-time 5 --user "$RPC_USER:$RPC_PASS" \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"s\",\"method\":\"$1\",\"params\":[]}" \
    -H 'content-type: text/plain;' "http://$RPC_HOST:$RPC_PORT/"
}

# ---- 1. the Veil node -------------------------------------------------------
if pgrep -x veild >/dev/null 2>&1; then
  echo "  veild: already running"
else
  if [ ! -x "$VEIL_DIR/veild" ]; then
    echo "  !! veild not found at $VEIL_DIR/veild"
    echo "     set VEIL_DIR=/path/to/binaries and re-run"
    exit 1
  fi
  echo "  veild: starting from $VEIL_DIR"
  ( cd "$VEIL_DIR" && ./veild $CHAIN_FLAG -daemon >/dev/null 2>&1 )
fi

# ---- 2. wait for the RPC to answer -----------------------------------------
# after a reboot the node re-verifies blocks, so this can take a couple of minutes
echo -n "  waiting for RPC"
for i in $(seq 1 180); do
  out="$(rpc getblockchaininfo)"
  if echo "$out" | grep -q '"blocks"'; then
    h=$(echo "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["blocks"])' 2>/dev/null)
    echo "  ready (height $h)"
    break
  fi
  # surface the node's own progress message instead of spinning silently
  msg=$(echo "$out" | python3 -c 'import sys,json;print((json.load(sys.stdin).get("error") or {}).get("message",""))' 2>/dev/null)
  [ -n "${msg:-}" ] && printf "\r  waiting for RPC: %-52s" "$msg" || printf "."
  sleep 2
  if [ "$i" = 180 ]; then echo; echo "  !! RPC never answered — check $VEIL_DIR/debug.log"; exit 1; fi
done

# ---- 3. the visualizer ------------------------------------------------------
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "  VeilStreet: already listening on $PORT"
else
  VEIL_RPC_PORT=$RPC_PORT nohup node server.js > /tmp/veilstreet.log 2>&1 &
  sleep 2
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo
echo "  VeilStreet  →  http://localhost:$PORT"
[ -n "${IP:-}" ] && echo "  on your phone →  http://$IP:$PORT"
echo "  logs: tail -f /tmp/veilstreet.log"
echo
