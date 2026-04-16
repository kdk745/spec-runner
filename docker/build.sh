#!/usr/bin/env bash
# Build the spec-runner candidate environment image.
# Run from anywhere — resolves Dockerfile relative to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="spec-runner-env:latest"

echo "Building $IMAGE from $SCRIPT_DIR/Dockerfile ..."
docker build -t "$IMAGE" "$SCRIPT_DIR"
echo "Done: $IMAGE"
