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

# "./start.sh testnet" forces testnet, "./start.sh mainnet" forces mainnet.
# With no argument it auto-detects: if a node is already running it uses whichever
# chain answers (mainnet first); if none is running it starts mainnet.
CHAIN_FLAG=""
RPC_PORT=""
case "${1:-}" in
  testnet) CHAIN_FLAG="-testnet"; RPC_PORT=58813; echo "  chain: TESTNET" ;;
  mainnet) RPC_PORT=58812 ;;
esac

rpc() {  # $1 = method, $2 = port
  curl -s --max-time 5 --user "$RPC_USER:$RPC_PASS" \
    --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"s\",\"method\":\"$1\",\"params\":[]}" \
    -H 'content-type: text/plain;' "http://$RPC_HOST:$2/"
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
  [ -z "$RPC_PORT" ] && RPC_PORT=58812      # nothing was running, so we started mainnet
fi

# ---- 2. wait for the RPC to answer -----------------------------------------
# after a reboot the node re-verifies blocks, so this can take a couple of minutes
echo -n "  waiting for RPC"
for i in $(seq 1 180); do
  if [ -n "$RPC_PORT" ]; then
    out="$(rpc getblockchaininfo "$RPC_PORT")"
  else
    # auto-detect: a node is already up on one of the two chains — find it
    out="$(rpc getblockchaininfo 58812)"
    if echo "$out" | grep -q '"blocks"'; then RPC_PORT=58812
    else
      out="$(rpc getblockchaininfo 58813)"
      echo "$out" | grep -q '"blocks"' && RPC_PORT=58813
    fi
  fi
  if echo "$out" | grep -q '"blocks"'; then
    h=$(echo "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["blocks"])' 2>/dev/null)
    ch=$(echo "$out" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["chain"])' 2>/dev/null)
    echo "  ready ($ch, height $h)"
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
  # only pin the chain when it was forced on the command line — otherwise let the
  # server auto-detect, so swapping nodes later doesn't strand it on a dead port
  if [ -n "${1:-}" ]; then
    VEIL_RPC_PORT=$RPC_PORT nohup node server.js > /tmp/veilstreet.log 2>&1 &
  else
    nohup node server.js > /tmp/veilstreet.log 2>&1 &
  fi
  sleep 2
fi

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo
echo "  VeilStreet  →  http://localhost:$PORT"
[ -n "${IP:-}" ] && echo "  on your phone →  http://$IP:$PORT"
echo "  logs: tail -f /tmp/veilstreet.log"
echo
