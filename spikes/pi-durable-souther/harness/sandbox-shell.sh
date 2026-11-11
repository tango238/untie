#!/bin/bash
# エージェントのシェルを、Linux の名前空間で隔離して動かす (bash の代わりに呼ばれる。引数は bash にそのまま渡す)。
# 見えるのは、作業フォルダと、システムのプログラムだけ。
#   - /tmp・/home・/root・/mnt・/run は空にする (作業フォルダだけを、同じパスに戻す)。この機械の設定・記録・資格情報は見えない
#   - ほかのプロセスは見えない (/proc を付け替える。実行基盤の環境変数を /proc から読めない)
#   - ネットワークは無い (自分自身 (127.0.0.1) だけ)。依存のパッケージは、作業フォルダに前もって入れておく
#   - 環境変数は、PATH など決まったものだけ (呼び出した側の API キーやトークンは渡らない)
#   - 隠したものを、中から外せない (もう 1 段、名前空間を重ねて、付け替えたものを固定する)
# 検証のためのもので、本番の隔離 (会話ごとのコンテナ) の代わりではない。read・write・edit のツールは、このシェルを通らない (run.ts の歯止めで断る)。
W="${UNTIE_SANDBOX_WORKSPACE:?UNTIE_SANDBOX_WORKSPACE が要ります}"
export W
exec unshare --user --map-root-user --mount --pid --net --fork --mount-proc /bin/bash -c '
  set -e
  mount --bind "$W" /media
  mount -t tmpfs tmpfs /tmp
  for d in /home /root /mnt /run; do mount -t tmpfs tmpfs "$d"; done
  mkdir -p "$W"
  mount --move /media "$W"
  # 自分自身への通信 (テストがサーバーを起こして呼ぶ) だけ、できるようにする
  python3 -c "
import fcntl, socket, struct
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
flags = struct.unpack(\"16sH\", fcntl.ioctl(s, 0x8913, struct.pack(\"16sH\", b\"lo\", 0)))[1]
fcntl.ioctl(s, 0x8914, struct.pack(\"16sH\", b\"lo\", flags | 1))
"
  cd "$W"
  mkdir -p "$W/.home"
  exec unshare --user --map-root-user --mount env -i PATH="$PATH" HOME="$W/.home" LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" npm_config_offline=true /bin/bash "$@"
' sandbox-shell "$@"
