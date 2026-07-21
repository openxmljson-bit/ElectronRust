#!/bin/bash
# OPENJSONXML — one-shot build & run
set -e
cd "$(dirname "$0")"

if ! command -v cargo >/dev/null; then
  echo "Rust is required. Install it with:"
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

echo "==> Building Rust engine (release)…"
(cd rust-engine && cargo build --release)

echo "==> Installing npm dependencies…"
npm install

echo "==> Starting OPENJSONXML…"
npm start
