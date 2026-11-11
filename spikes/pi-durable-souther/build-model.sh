#!/usr/bin/env bash
# untie が書き出した業務ルール (workspace/design/sys_pms.sou) を、Souther で確かめて WebAssembly にし、TypeScript の呼び出しコードを作る。
# JDK 25 と souther 0.4.1 が要る (souther は SOUTHER_BIN で指す。CI と同じ取得の仕方は scripts/souther-check.sh)。
set -euo pipefail
cd "$(dirname "$0")"
SOUTHER="${SOUTHER_BIN:-souther}"
VERSION=0.4.1
BACKEND="souther-wasm-compiler-$VERSION-cli.jar"
BASE="https://repo.maven.apache.org/maven2/org/souther-lang/souther-wasm-compiler/$VERSION"

# WebAssembly 向けのバックエンド (Maven Central)。SOUTHER_HOME/backends に置くと、souther compile --target wasm が見つける
export SOUTHER_HOME="$PWD/.souther-home"
mkdir -p "$SOUTHER_HOME/backends"
if [ ! -f "$SOUTHER_HOME/backends/$BACKEND" ]; then
  curl -fsSL -o "$SOUTHER_HOME/backends/$BACKEND" "$BASE/$BACKEND"
  echo "$(curl -fsSL "$BASE/$BACKEND.sha256")  $SOUTHER_HOME/backends/$BACKEND" | sha256sum -c -
fi

"$SOUTHER" examples workspace/design/sys_pms.sou --lang ja --color never | tail -3
"$SOUTHER" compile --target wasm workspace/design/sys_pms.sou -o workspace/model/pms.wasm

# TypeScript の呼び出しコード (JVM は要らない)
tmp=$(mktemp -d)
(cd "$tmp" && npm init -y >/dev/null && npm install --silent @souther-lang/wasm@$VERSION @raoh/core@0.9.0)
"$tmp/node_modules/.bin/souther-wasm-bindings" workspace/model/pms.wasm -o workspace/model/pms.ts
rm -rf "$tmp"
