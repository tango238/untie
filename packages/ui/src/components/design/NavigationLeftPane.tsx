import { setDesignLayout } from "@untie/core/model/commands";
import { LIMITS } from "@untie/core/model/limits";
import type { SystemDesign } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { CommitField } from "../CommitField";

const SHELLS = [
  { value: "shell", label: "shell", description: "ヘッダー + グローバルナビ + パンくず" },
  { value: "plain", label: "plain", description: "ヘッダーのみ" },
] as const;

type HeaderKey = "systemName" | "userName" | "tenantName";
const HEADER_FIELDS: { key: HeaderKey; label: string }[] = [
  { key: "systemName", label: "システム名" },
  { key: "userName", label: "利用者名" },
  { key: "tenantName", label: "テナント名" },
];

/** 設計モードのナビゲーションボードの左ペイン: 共通の枠 (shell / plain) の選択と、ヘッダーの項目 */
export function NavigationLeftPane() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const design: SystemDesign | undefined = model.designs.find((d) => d.systemId === systemId);
  const shell = design?.layout.shell ?? "shell";
  const systemName = model.elements.find((e) => e.id === systemId)?.name || "(名前なし)";

  const run = (payload: { shell?: "shell" | "plain"; header?: Partial<Record<HeaderKey, string>> }) => {
    if (!systemId) return;
    const r = dispatch((m) => setDesignLayout(m, { systemId, ...payload }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  return (
    <aside className="sitemap-tree navigation-left" aria-label="レイアウトの設定">
      <h2 className="panel-title">レイアウト</h2>
      <fieldset className="navigation-shells">
        <legend className="visually-hidden">レイアウト</legend>
        {SHELLS.map((s) => (
          <label key={s.value} className="navigation-shell-option">
            <input type="radio" name="navigation-shell" value={s.value} checked={shell === s.value} disabled={readOnly || !systemId} onChange={() => run({ shell: s.value })} />
            <span>
              <strong>{s.label}</strong>
              <small className="hint-inline">{s.description}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <h2 className="panel-title">ヘッダー</h2>
      <div className="navigation-header-fields">
        {HEADER_FIELDS.map(({ key, label }) => (
          <CommitField
            key={`${systemId}:${key}`}
            label={label}
            value={design?.layout.header?.[key] ?? ""}
            placeholder={key === "systemName" ? systemName : undefined}
            maxLength={LIMITS.name.max}
            readOnly={readOnly || !systemId}
            onCommit={(v) => run({ header: { [key]: v } })}
          />
        ))}
        <p className="hint">システム名が空のときは、対象のシステムの名前を出します。</p>
      </div>
    </aside>
  );
}
