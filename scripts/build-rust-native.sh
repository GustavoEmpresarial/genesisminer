#!/usr/bin/env bash
# Build genesis-node native addon → repo-root native/genesis.node
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/rust"
cargo build --release -p genesis-node
mkdir -p "$ROOT/native"
SO="$ROOT/rust/target/release/libgenesis_node.so"
if [[ ! -f "$SO" ]]; then
  echo "expected $SO after cargo build" >&2
  exit 1
fi
cp "$SO" "$ROOT/native/genesis.node"
echo "built native/genesis.node"
