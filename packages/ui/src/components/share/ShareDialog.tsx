import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { can, ROLE_LABELS, type FileDetail, type InviteRole, type Member } from "@untie/api";
import { getApi } from "../../cloud/api";
import { useFilesStore } from "../../cloud/files";
import { copyText } from "../../io/clipboard";
import { useUntieStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";

const INVITE_ROLES: readonly InviteRole[] = ["editor", "viewer"];

/** 確認を待っている操作 */
type Pending =
  | { kind: "transfer"; member: Member }
  | { kind: "regenerate" }
  | { kind: "disableLink" }
  | null;

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const label = (m: { name: string; email: string }) => m.name || m.email;
const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 共有ダイアログ (設計書 8.1)。owner だけが開ける: メンバーの役割・外す・所有者を譲る、メールでの招待、
 * 未承諾の招待の取り消し、「リンクを知っている人が閲覧できる」の切り替え。
 * 表示は見せ方だけで、判定の正本はサーバー (権限が無ければ 403 の文言をトーストに出す)
 */
export function ShareDialog({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const titleId = useId();
  const pushToast = useUntieStore((s) => s.pushToast);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("editor");
  /** 招待の結果 (メンバーに加えた、など)。次の操作まで残す */
  const [notice, setNotice] = useState<string | null>(null);
  /** まだユーザーでない人への招待の URL。作ったときにしか出せない */
  const [invite, setInvite] = useState<{ id: string; email: string; url: string } | null>(null);
  /** リンク閲覧の URL。有効にした・作り直したときにしか出せない (サーバーはトークンを持たない) */
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [pending, setPending] = useState<Pending>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);

  // 開いた時に「閉じる」へフォーカスし、閉じたら元の場所へ戻す
  useEffect(() => {
    alive.current = true;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      alive.current = false;
      before?.focus?.();
    };
  }, []);

  // 操作のあと、フォーカスのあったボタンが消えた・無効になって外れたら、ダイアログに戻す
  // (フォーカスが body に落ちると、Escape がダイアログに届かず、閉じられなくなる)
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const active = document.activeElement;
    if (!active || !dialogRef.current?.contains(active)) dialogRef.current?.focus();
  }, [busy]);

  // 確認ダイアログを閉じたら、このダイアログへフォーカスを戻す (Escape が効き続けるように)
  const hadPending = useRef(false);
  useEffect(() => {
    if (pending === null && hadPending.current) closeRef.current?.focus();
    hadPending.current = pending !== null;
  }, [pending]);

  /** 取り直して、取れた中身を返す (取れなければ null)。失敗は、初めてなら読み込み失敗として出し、2 回目以降はトーストにする */
  const loadedOnce = useRef(false);
  const reload = useCallback(async (): Promise<FileDetail | null> => {
    try {
      const next = await getApi().files.get(fileId);
      if (!alive.current) return next;
      loadedOnce.current = true;
      setDetail(next);
      setLoadError(null);
      return next;
    } catch (e) {
      if (!alive.current) return null;
      if (loadedOnce.current) pushToast(messageOf(e), "error");
      else setLoadError(messageOf(e));
      return null;
    }
  }, [fileId, pushToast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * 変更の操作。二重に押せないようにし、失敗はトーストに出し、終わったら取り直してホームの一覧も更新する。
   * 操作の中で取り直し済みなら "reloaded" を返す (もう一度は取らない)
   */
  const run = async (action: () => Promise<void | "reloaded">) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let reloaded = false;
    try {
      reloaded = (await action()) === "reloaded";
    } catch (e) {
      pushToast(messageOf(e), "error");
    } finally {
      if (!reloaded) await reload();
      void useFilesStore.getState().refresh();
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    // フォーカスはダイアログの中を回す
    if (e.key !== "Tab" || !dialogRef.current) return;
    const nodes = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await copyText(text);
      pushToast(`${what}を写しました`);
    } catch {
      pushToast(`${what}を写せませんでした。表示している URL を選んで写してください`, "error");
    }
  };

  const isOwner = detail !== null && can(detail.role, "manageMembers");
  const members = detail?.members ?? [];
  const invitations = detail?.invitations ?? [];
  const linkEnabled = detail?.link?.enabled ?? false;
  const transferable = members.filter((m) => m.role !== "owner");
  const now = Date.now();

  const changeRole = (m: Member, role: InviteRole) =>
    m.role === role ? Promise.resolve() : run(() => getApi().files.members.put(fileId, m.userId, role).then(() => undefined));

  const removeMember = (m: Member) =>
    run(async () => {
      await getApi().files.members.remove(fileId, m.userId);
      setNotice(null);
      // 譲る相手に選んでいた人を外したら、選びを空に戻す
      setTransferTo((to) => (to === m.userId ? "" : to));
    });

  const transfer = (m: Member) =>
    run(async () => {
      await getApi().files.transfer(fileId, m.userId);
      pushToast(`所有者を${label(m)}さんに譲りました`);
      // もう所有者ではないので、このダイアログは閉じる
      onClose();
    });

  const submitInvite = () => {
    const address = email.trim();
    if (!address) {
      pushToast("メールアドレスを入力してください", "error");
      return Promise.resolve();
    }
    return run(async () => {
      const result = await getApi().files.invitations.create(fileId, address, inviteRole);
      setEmail("");
      if (result.kind === "member") {
        // すでにユーザーの人はその場でメンバーになる (すでにメンバーなら役割が変わるだけ)。名前は取り直したメンバー一覧から引く
        const already = members.some((m) => m.userId === result.userId);
        const fresh = await reload();
        const added = fresh?.members?.find((m) => m.userId === result.userId);
        setNotice(`${added ? label(added) : address}さん${already ? "の役割を変えました" : "をメンバーに加えました"}`);
        setInvite(null);
        return "reloaded";
      }
      setNotice(null);
      setInvite({ id: result.invitationId, email: address, url: result.url });
    });
  };

  const cancelInvitation = (id: string) =>
    run(async () => {
      await getApi().files.invitations.remove(fileId, id);
      if (invite?.id === id) setInvite(null);
    });

  const enableLink = () =>
    run(async () => {
      const result = await getApi().files.link.enable(fileId);
      if (result.url) setLinkUrl(result.url);
      else pushToast("リンクはすでに有効です。URL は「リンクを作り直す」で出せます");
    });

  const regenerateLink = () =>
    run(async () => {
      const result = await getApi().files.link.enable(fileId, { regenerate: true });
      setLinkUrl(result.url ?? null);
    });

  const disableLink = () =>
    run(async () => {
      await getApi().files.link.disable(fileId);
      setLinkUrl(null);
    });

  const confirmPending = () => {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === "transfer") void transfer(p.member);
    else if (p.kind === "regenerate") void regenerateLink();
    else void disableLink();
  };

  const name = detail?.name;
  return (
    <>
      <div className="dialog-backdrop" onKeyDown={onKeyDown}>
        <div ref={dialogRef} className="dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy} tabIndex={-1}>
          <h2 id={titleId}>{name ? `「${name}」を共有` : "共有"}</h2>

          {!detail && !loadError && <p className="home-note">読み込み中…</p>}
          {loadError && !detail && <p className="field-error">共有の設定を読めませんでした: {loadError}</p>}
          {detail && !isOwner && <p className="home-note">共有を設定できるのは所有者だけです。</p>}

          {detail && isOwner && (
            <>
              <section className="share-section" aria-label="メンバー">
                <h3>メンバー</h3>
                <ul className="share-list">
                  {members.map((m) => (
                    <li key={m.userId} className="share-row">
                      <span className="share-who">
                        <span className="share-name">{label(m)}</span>
                        {m.name && <span className="share-sub">{m.email}</span>}
                      </span>
                      {m.role === "owner" ? (
                        <span className="share-role">{ROLE_LABELS.owner}</span>
                      ) : (
                        <>
                          <select
                            aria-label={`${label(m)} の役割`}
                            value={m.role}
                            disabled={busy}
                            onChange={(e) => void changeRole(m, e.target.value as InviteRole)}
                          >
                            {INVITE_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </option>
                            ))}
                          </select>
                          <button type="button" aria-label={`${label(m)} を外す`} disabled={busy} onClick={() => void removeMember(m)}>
                            外す
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                {transferable.length > 0 && (
                  <div className="share-inline">
                    <label>
                      所有者を譲る相手
                      <select value={transferable.some((m) => m.userId === transferTo) ? transferTo : ""} disabled={busy} onChange={(e) => setTransferTo(e.target.value)}>
                        <option value="">選んでください</option>
                        {transferable.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {label(m)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy || !transferTo}
                      onClick={() => {
                        const member = transferable.find((m) => m.userId === transferTo);
                        if (member) setPending({ kind: "transfer", member });
                      }}
                    >
                      所有者を譲る…
                    </button>
                  </div>
                )}
              </section>

              <section className="share-section" aria-label="招待">
                <h3>メールで招待</h3>
                <form
                  className="share-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitInvite();
                  }}
                >
                  <input
                    type="email"
                    aria-label="招待するメールアドレス"
                    placeholder="name@example.com"
                    value={email}
                    disabled={busy}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <select aria-label="招待する役割" value={inviteRole} disabled={busy} onChange={(e) => setInviteRole(e.target.value as InviteRole)}>
                    {INVITE_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="primary" disabled={busy}>
                    招待
                  </button>
                </form>
                {notice && (
                  <p className="share-notice" role="status">
                    {notice}
                  </p>
                )}
                {invite && (
                  <div className="share-url" role="group" aria-label="招待のリンク">
                    <p className="hint">{invite.email}さんはまだ登録していません。このリンクを送ってください (14 日間有効)。</p>
                    <div className="share-inline">
                      <input readOnly aria-label="招待リンク" value={invite.url} onFocus={(e) => e.currentTarget.select()} />
                      <button type="button" aria-label="招待リンクを写す" onClick={() => void copy(invite.url, "招待リンク")}>
                        リンクを写す
                      </button>
                    </div>
                  </div>
                )}
                {invitations.length > 0 && (
                  <>
                    <h4>未承諾の招待</h4>
                    <ul className="share-list">
                      {invitations.map((inv) => {
                        const expired = inv.expiresAt <= now;
                        return (
                          <li key={inv.id} className="share-row">
                            <span className="share-who">
                              <span className="share-name">{inv.email}</span>
                              <span className={`share-sub${expired ? " is-expired" : ""}`}>
                                {ROLE_LABELS[inv.role]} · {expired ? "期限切れ" : `期限 ${new Date(inv.expiresAt).toLocaleDateString("ja-JP")}`}
                              </span>
                            </span>
                            <button type="button" aria-label={`${inv.email} の招待を取り消す`} disabled={busy} onClick={() => void cancelInvitation(inv.id)}>
                              取り消す
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>

              <section className="share-section" aria-label="リンク閲覧">
                <h3>リンクで閲覧</h3>
                <label className="share-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={linkEnabled}
                    disabled={busy}
                    onChange={() => (linkEnabled ? setPending({ kind: "disableLink" }) : void enableLink())}
                  />
                  <span>リンクを知っている人が閲覧できる</span>
                </label>
                {linkEnabled && (
                  <div className="share-url">
                    {linkUrl ? (
                      <div className="share-inline">
                        <input readOnly aria-label="閲覧リンク" value={linkUrl} onFocus={(e) => e.currentTarget.select()} />
                        <button type="button" aria-label="閲覧リンクを写す" onClick={() => void copy(linkUrl, "閲覧リンク")}>
                          リンクを写す
                        </button>
                      </div>
                    ) : (
                      <p className="hint">リンクの URL は作ったときにしか表示できません。必要なら作り直してください。</p>
                    )}
                    <button type="button" disabled={busy} onClick={() => setPending({ kind: "regenerate" })}>
                      リンクを作り直す
                    </button>
                  </div>
                )}
                <p className="hint">リンクを開いた人は、ログインしなくても閲覧だけできます (編集はできません)。</p>
              </section>
            </>
          )}

          <div className="dialog-actions">
            <button type="button" ref={closeRef} onClick={onClose}>
              閉じる
            </button>
          </div>
        </div>
      </div>

      {pending?.kind === "transfer" && (
        <ConfirmDialog
          title="所有者を譲る"
          message={`「${name ?? ""}」の所有者を${label(pending.member)}さんに譲ります。あなたは編集者になり、メンバーの管理や共有の設定はできなくなります。`}
          confirmLabel="譲る"
          danger
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        />
      )}
      {pending?.kind === "regenerate" && (
        <ConfirmDialog
          title="リンクを作り直す"
          message="古いリンクは使えなくなり、リンクで開いている人は閉じられます。新しいリンクを知らせ直してください。"
          confirmLabel="作り直す"
          danger
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        />
      )}
      {pending?.kind === "disableLink" && (
        <ConfirmDialog
          title="リンク閲覧をやめる"
          message="リンクを知っている人は開けなくなり、リンクで開いている人は閉じられます。"
          confirmLabel="無効にする"
          danger
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        />
      )}
    </>
  );
}
