#!/usr/bin/env bash
# untie が書き出した業務ルールの骨組み (.sou) を、Souther のコンパイラに通す。CI (.github/workflows/ci.yml) から呼ぶ。
# Souther (https://github.com/souther-lang/souther) は JDK 25 で動く。手元で流すときは、JDK 25 を PATH に置くか、
# 入れてある souther を SOUTHER_BIN で指す (例: SOUTHER_BIN=$(command -v souther) scripts/souther-check.sh)。
#
# 確かめること: 書き出したソースがコンパイルできる・example の行 (ふだんの流れと代替パターン) が成り立つ。
# 行の無い組み合わせ (まだ決まっていないパターン) は報告に出るだけで、失敗にはしない。
set -euo pipefail

# 使う版と、その配布物 (launcher 付きの jar) の SHA-256。版を上げるときは、リリースの SHA256SUMS の値に合わせて両方を直す
VERSION=0.4.1
SHA256=bdfc17b11c2eeecd706a67d1bb7a6ae54fc935052c021f5f690b4fd81ceb5b14

ROOT=$(cd "$(dirname "$0")/.." && pwd)
FIXTURES="$ROOT/packages/core/src/model/__tests__/__fixtures__/souther"

BIN="${SOUTHER_BIN:-}"
if [ -z "$BIN" ]; then
  dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/souther-$VERSION"
  BIN="$dir/souther"
  if [ ! -x "$BIN" ]; then
    mkdir -p "$dir"
    curl -fsSL -o "$BIN" "https://github.com/souther-lang/souther/releases/download/v$VERSION/souther"
    # 取得したものが、決めた版のものか。違えば動かさない
    echo "$SHA256  $BIN" | sha256sum -c -
    chmod +x "$BIN"
  fi
fi

"$BIN" --version

failed=0
count=0
while IFS= read -r file; do
  count=$((count + 1))
  name=${file#"$ROOT/"}
  echo "::group::$name"
  if ! "$BIN" examples "$file" --lang ja --color never; then
    failed=1
    echo "::error file=$name::Souther のコンパイルか、example の行が通りませんでした"
  fi
  echo "::endgroup::"
done < <(find "$FIXTURES" -name '*.sou' | sort)

if [ "$count" -eq 0 ]; then
  echo "::error::確かめる .sou がありません ($FIXTURES)"
  exit 1
fi
echo "$count 個のファイルを確かめました"
exit "$failed"
