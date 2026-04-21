#!/usr/bin/env bash
# docker/run-local.sh — standalone demo for the Docker environment lifecycle
#
# Provisions 3 isolated spec-runner containers, shows their status, then tears
# them all down. No pipeline — just the infrastructure layer.
#
# Usage:
#   bash docker/run-local.sh
#
# Prerequisites:
#   docker build -t spec-runner-env:latest docker/   (run once)

set -euo pipefail

IMAGE="spec-runner-env:latest"
WORKSPACE_BASE="$(pwd)/runs/.demo-$(date +%s)"
CONTAINERS=()

cleanup() {
  echo ""
  echo "=== Teardown ==="
  for cid in "${CONTAINERS[@]:-}"; do
    if [[ -n "$cid" ]]; then
      echo "  Stopping $cid ..."
      docker stop --time 5 "$cid" 2>/dev/null || true
      docker rm   -f      "$cid" 2>/dev/null || true
      echo "  Removed  $cid"
    fi
  done
  rm -rf "$WORKSPACE_BASE"
  echo "  Workspace cleaned."
  echo ""
}

trap cleanup EXIT

echo ""
echo "=== spec-runner Docker environment demo ==="
echo "Image     : $IMAGE"
echo "Workspace : $WORKSPACE_BASE"
echo ""

# ── Provision 3 containers ────────────────────────────────────────────────────

for i in 1 2 3; do
  WS="$WORKSPACE_BASE/candidate-$i"
  mkdir -p "$WS"

  # Pick a free port by letting the OS assign one via a one-shot socat trick,
  # then close it immediately (good enough for a demo).
  PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()" 2>/dev/null \
    || node -e "const n=require('net').createServer(); n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})")

  NAME="spec-runner-demo-$i"
  RUN_ID="demo-run-00000000"
  CAND_ID="demo-cand-0000000$i"
  ENV_ID="demo-env-000000-$i"

  echo "  [candidate $i] provisioning → port $PORT workspace $WS"

  CID=$(docker run -d \
    --name "$NAME" \
    -v "$(echo "$WS" | sed 's|\\|/|g'):/workspace" \
    -p "${PORT}:3000" \
    --label "spec-runner=1" \
    --label "spec-runner.run-id=$RUN_ID" \
    --label "spec-runner.candidate-id=$CAND_ID" \
    --label "spec-runner.env-id=$ENV_ID" \
    "$IMAGE")

  CONTAINERS+=("$CID")
  echo "  [candidate $i] started → container ${CID:0:12}"
done

echo ""
echo "=== Live status ==="
printf "  %-14s %-14s %-12s %-10s\n" "CONTAINER" "NAME" "STATUS" "PORT"
printf "  %-14s %-14s %-12s %-10s\n" "─────────────" "─────────────" "───────────" "────────"

for i in "${!CONTAINERS[@]}"; do
  CID="${CONTAINERS[$i]}"
  NAME="spec-runner-demo-$((i+1))"
  STATE=$(docker inspect --format "{{.State.Status}}" "$CID" 2>/dev/null || echo "unknown")
  PORT=$(docker inspect --format "{{range \$p, \$b := .NetworkSettings.Ports}}{{range \$b}}{{.HostPort}}{{end}}{{end}}" "$CID" 2>/dev/null || echo "-")
  printf "  %-14s %-14s %-12s %-10s\n" "${CID:0:12}" "$NAME" "$STATE" "$PORT"
done

echo ""
echo "Containers are running. Press Ctrl-C or wait 5 seconds to teardown."
sleep 5
