#!/usr/bin/env bash
set -e

# Rebuild kstunnel: rm old release/kstunnel, build new one.
# Usage: ./rebuild.sh  (run from cli/ or repo root)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/release/kstunnel"
OUT_BIN="$OUT_DIR/kstunnel"

echo "==> rm old: $OUT_DIR"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "==> build new: $OUT_BIN"
cd "$SCRIPT_DIR"
go build -o "$OUT_BIN" ./cmd/kstunnel

echo "==> done:"
ls -lh "$OUT_BIN"
"$OUT_BIN"
