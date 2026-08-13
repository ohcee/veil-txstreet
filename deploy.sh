#!/usr/bin/env bash
# Ship VeilStreet to a box and prove it landed.
#
#   ./deploy.sh              both targets
#   ./deploy.sh mainnet      one of them
#   ./deploy.sh --dry-run    show what would change, touch nothing
#   ./deploy.sh testnet -n   both forms work
#
# Targets live in deploy.conf (gitignored, copy deploy.conf.example). This does
# NOT push to git: deploying and publishing are separate decisions.
set -euo pipefail
cd "$(dirname "$0")"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$OFF" "$*"; }
die()  { printf '  %s✗%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

DRY=0; TARGETS=()
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY=1 ;;
    mainnet|testnet) TARGETS+=("$a") ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $a" ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(mainnet testnet)

CONF="${DEPLOY_CONF:-deploy.conf}"
[ -f "$CONF" ] || die "no $CONF — copy deploy.conf.example and fill in your boxes"
# shellcheck disable=SC1090
. "./$CONF"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/veilstreet_deploy}"
SSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15"

# Never ship files that belong to the box rather than the repo: each node keeps its
# own config, its own harvested addresses and its own history.
EXCLUDES=(--exclude=config.json --exclude='snitch-addrs*.json' --exclude='block-hist*.json'
          --exclude='*.log' --exclude=node_modules/ --exclude=.DS_Store --exclude=.claude/
          --exclude=.git/ --exclude=deploy.conf)

# ---------------------------------------------------------------------------
# Gate: the tests decide what a transaction IS, and a wrong answer there ships a
# false claim about somebody's privacy. They run before anything leaves here.
# ---------------------------------------------------------------------------
say ""; say "${DIM}tests${OFF}"
if npm test --silent >/tmp/veilstreet-test.log 2>&1; then
  ok "$(grep -Eo 'pass [0-9]+' /tmp/veilstreet-test.log | tail -1) of $(grep -Eo 'tests [0-9]+' /tmp/veilstreet-test.log | tail -1 | tr -d 'a-z ')"
else
  sed -n '/failing tests/,$p' /tmp/veilstreet-test.log | head -20
  die "tests failed — nothing deployed"
fi
node --check server.js || die "server.js does not parse"

# Informational only: deploying something uncommitted is allowed, but say so out loud.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  warn "working tree is dirty — deploying files that are not committed"
fi
if git rev-parse '@{u}' >/dev/null 2>&1; then
  n=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  [ "$n" -gt 0 ] && warn "$n commit(s) not pushed to GitHub (deploy does not push)"
fi

deploy_one() {
  local name="$1" up
  up=$(printf '%s' "$name" | tr '[:lower:]' '[:upper:]')
  eval "local host=\${${up}_SSH:-}"
  eval "local dir=\${${up}_DIR:-}"
  eval "local restart=\${${up}_RESTART:-}"
  eval "local url=\${${up}_URL:-}"
  eval "local owner=\${${up}_OWNER:-}"
  eval "local expect=\${${up}_CHAIN:-}"
  [ -n "$host" ] && [ -n "$dir" ] || die "$name is not configured in $CONF"

  say ""; say "${DIM}$name${OFF}  $host:$dir"

  if [ "$DRY" = 1 ]; then
    rsync -az --delete --itemize-changes --dry-run -e "$SSH" "${EXCLUDES[@]}" ./ "$host:$dir/" \
      | grep -vE '^\.d\.\.t' | sed 's/^/    /' || true
    ok "dry run only, nothing changed"
    return
  fi

  rsync -az --delete -e "$SSH" "${EXCLUDES[@]}" ./ "$host:$dir/" || die "rsync failed"
  ok "files copied"
  [ -n "$owner" ] && $SSH "$host" "chown -R $owner $dir" && ok "owner set to $owner"
  $SSH "$host" "$restart" >/dev/null || die "restart failed"
  ok "service restarted"

  # Prove the box is running THESE bytes. A silent stale deploy has happened here
  # before, and it looks exactly like a working one.
  local lh rh
  lh=$(shasum -a 256 server.js index.html | awk '{print $1}' | shasum -a 256 | cut -c1-16)
  rh=$($SSH "$host" "cd $dir && sha256sum server.js index.html | awk '{print \$1}' | sha256sum | cut -c1-16")
  [ "$lh" = "$rh" ] || die "deployed files differ from local ($lh vs $rh)"
  ok "bytes match local ($lh)"

  # And that it actually came back up on the chain it is supposed to serve.
  local tries=0 state=""
  while [ $tries -lt 20 ]; do
    state=$($SSH "$host" "curl -s --max-time 6 http://127.0.0.1:8790/api/state" 2>/dev/null || true)
    printf '%s' "$state" | grep -q '"height"' && break
    tries=$((tries + 1)); sleep 2
  done
  printf '%s' "$state" | grep -q '"height"' || die "service did not answer after restart"
  local chain height
  chain=$(printf '%s' "$state" | sed -n 's/.*"network":"\([a-z]*\)".*/\1/p')
  height=$(printf '%s' "$state" | sed -n 's/.*"height":\([0-9]*\).*/\1/p')
  if [ -n "$expect" ] && [ "$chain" != "$expect" ]; then
    die "wrong chain: expected $expect, node says $chain"
  fi
  ok "live on $chain at height $height"

  if [ -n "$url" ]; then
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url/" || echo 000)
    [ "$code" = "200" ] || die "$url returned $code"
    ok "$url serving 200"
  fi
}

for t in "${TARGETS[@]}"; do deploy_one "$t"; done
say ""; ok "done"
say ""
