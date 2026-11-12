#!/usr/bin/env bash
# untie が書き出した業務ルール (Souther のソース) を、Souther で確かめて WebAssembly にし、TypeScript の呼び出しコードを作る。
# JDK 25 と souther 0.4.1 が要る (souther は SOUTHER_BIN で指す。CI と同じ取得の仕方は scripts/souther-check.sh)。
#   ./build-model.sh                                  … workspace/design/sys_pms.sou → workspace/model/pms.wasm・pms.ts
#   ./build-model.sh <ソース.sou> <出力.wasm> <出力.ts> [souther-wasm-bindings のパス]
set -euo pipefail
abs() { realpath -m "$1"; }
SRC=$(abs "${1:-$(dirname "$0")/workspace/design/sys_pms.sou}")
WASM=$(abs "${2:-$(dirname "$0")/workspace/model/pms.wasm}")
TS=$(abs "${3:-$(dirname "$0")/workspace/model/pms.ts}")
BINDINGS="${4:-}"
[ -n "$BINDINGS" ] && BINDINGS=$(abs "$BINDINGS")
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

mkdir -p "$(dirname "$WASM")" "$(dirname "$TS")"
# 例の行が成り立つか。答え待ちの行 (設計で決まっていない組み合わせ) があると satisfied にならないが、コンパイルはできる
"$SOUTHER" examples "$SRC" --lang ja --color never | tail -3 || true
"$SOUTHER" compile --target wasm "$SRC" -o "$WASM"

# TypeScript の呼び出しコード (JVM は要らない)
if [ -n "$BINDINGS" ]; then
  "$BINDINGS" "$WASM" -o "$TS"
else
  tmp=$(mktemp -d)
  (cd "$tmp" && npm init -y >/dev/null && npm install --silent @souther-lang/wasm@$VERSION @raoh/core@0.9.0)
  "$tmp/node_modules/.bin/souther-wasm-bindings" "$WASM" -o "$TS"
  rm -rf "$tmp"
fi
