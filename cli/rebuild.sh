#!/usr/bin/env bash
set -euo pipefail

# Rebuild the kstunnel release binary.
# Usage: ./cli/rebuild.sh  (from the repository root or cli/)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/release"
OUT_BIN="$OUT_DIR/kstunnel"

echo "==> clean: $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cd "$SCRIPT_DIR"

echo "==> vet"
go vet ./...

echo "==> build: $OUT_BIN"
CGO_ENABLED=0 go build \
  -trimpath \
  -buildvcs=false \
  -ldflags="-s -w" \
  -o "$OUT_BIN" \
  ./cmd/kstunnel

chmod +x "$OUT_BIN"

echo "==> done"
ls -lh "$OUT_BIN"
"$OUT_BIN" -version
