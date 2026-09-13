#!/usr/bin/env bash
set -euo pipefail

# Rebuild kstunnel: replace release/kstunnel/kstunnel with a fresh build.
# Usage: ./rebuild.sh  (runnable from any directory)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/release/kstunnel"
OUT_BIN="$OUT_DIR/kstunnel"

command -v go >/dev/null 2>&1 || { echo "error: go not found in PATH" >&2; exit 1; }

# Resolve version: prefer git tag/dirty state, fall back to library default.
VERSION=""
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
	VERSION="$(git -C "$ROOT" describe --tags --dirty --always 2>/dev/null || true)"
fi

LDFLAGS="-s -w"
if [ -n "$VERSION" ]; then
	LDFLAGS="$LDFLAGS -X github.com/kswarrior/tunnel/cli.Version=$VERSION"
fi

echo "==> build: $OUT_BIN (version: ${VERSION:-default})"
mkdir -p "$OUT_DIR"

# Build to a temp file first so a failed build never leaves a half-written binary.
TMP_BIN="$(mktemp "$OUT_DIR/.kstunnel.build.XXXXXX")"
trap 'rm -f "$TMP_BIN"' EXIT

(
	cd "$SCRIPT_DIR"
	CGO_ENABLED=0 go build -trimpath -ldflags "$LDFLAGS" -o "$TMP_BIN" ./cmd/kstunnel
)

# Only replace the binary itself; keep sibling artifacts (checksums, README).
mv -f "$TMP_BIN" "$OUT_BIN"
trap - EXIT
chmod +x "$OUT_BIN"

echo "==> done:"
ls -lh "$OUT_BIN"
"$OUT_BIN" --version
