import { useState } from "react";
import { useFilesStore } from "../../cloud/files";
import { useSessionStore } from "../../cloud/session";
import { formatRoute, navigate } from "../../router";
import { PROVIDER_LABELS } from "../home/LoginPanel";

/**
 * リンクで閲覧しているゲストの帯に添える案内 (設計書 3.6)。
 * ログインしていなければログインの導線 (ログイン後はこのリンクへ戻る)、ログイン済みなら複製のボタン
 */
export function LinkGuestNotice({ token }: { token: string }) {
  const status = useSessionStore((s) => s.status);
  const providers = useSessionStore((s) => s.providers);
  const [busy, setBusy] = useState(false);

  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const copy = await useFilesStore.getState().duplicateFromLink(token);
      if (copy) navigate({ name: "file", fileId: copy.id });
    } finally {
      setBusy(false);
    }
  };

  if (status === "signedIn") {
    return (
      <span className="link-guest">
        <span>リンクで閲覧中です。</span>
        <button type="button" disabled={busy} onClick={() => void duplicate()}>
          複製して自分のファイルにする
        </button>
      </span>
    );
  }
  const returnTo = formatRoute({ name: "link", token });
  return (
    <span className="link-guest">
      <span>リンクで閲覧中。ログインすると複製できます</span>
      {providers
        .filter((p) => p in PROVIDER_LABELS)
        .map((p) => (
          <button key={p} type="button" onClick={() => void useSessionStore.getState().login(p, returnTo)}>
            {PROVIDER_LABELS[p]}
          </button>
        ))}
    </span>
  );
}
