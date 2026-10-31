import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../cloud/session";

/** ホーム上部の右端: ログイン済みなら名前とメニュー (ログアウト)、未ログインなら「ログイン」 */
export function AccountMenu() {
  const status = useSessionStore((s) => s.status);
  const user = useSessionStore((s) => s.user);
  const providers = useSessionStore((s) => s.providers);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (status === "unknown") return <span className="home-account-status">確認中…</span>;

  if (status === "anonymous") {
    // ログインの方法は画面の中のログイン欄にある。ここはそこへ案内する
    return (
      <button
        type="button"
        className="primary"
        disabled={providers.length === 0}
        title={providers.length === 0 ? "使えるログイン方法がありません" : undefined}
        onClick={() => {
          const first = document.querySelector<HTMLButtonElement>(".home-login-buttons button");
          first?.scrollIntoView?.({ block: "center" });
          first?.focus();
        }}
      >
        ログイン
      </button>
    );
  }

  const run = (action: () => Promise<void>) => () => {
    setOpen(false);
    void action();
  };
  return (
    <div className="menu" ref={ref} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {user?.name || user?.email} ▾
      </button>
      {open && (
        <div className="menu-list menu-list-right" role="menu" aria-label="アカウント">
          {user?.email && <span className="menu-empty">{user.email}</span>}
          <button type="button" role="menuitem" className="menu-item" onClick={run(() => useSessionStore.getState().logout())}>
            <span>ログアウト</span>
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={run(() => useSessionStore.getState().logoutAll())}>
            <span>すべての端末からログアウト</span>
          </button>
        </div>
      )}
    </div>
  );
}
