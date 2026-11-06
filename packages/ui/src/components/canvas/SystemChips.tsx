import type { SystemLabel } from "./toFlow";

const ROLE_LABELS: Record<SystemLabel["role"], string> = { source: "取得元", store: "保存先", target: "対象" };

/** 情報の取得元・保存先、操作の対象のシステム・帳票。帳票は破線で出す。対象で画面を使うときは、画面名を隣に出す */
export function SystemChips({ systems }: { systems: SystemLabel[] }) {
  const text = (s: SystemLabel) => `${ROLE_LABELS[s.role]}: ${s.name}${s.screens?.length ? ` (画面: ${s.screens.join("、")})` : ""}`;
  return (
    <span className="actor-chips system-chips" aria-label={systems.map(text).join("、")}>
      {systems.map((s, i) => (
        <span key={i} className={`actor-chip kind-${s.kind}`} title={text(s)}>
          <span className="system-chip-role">{ROLE_LABELS[s.role]}</span>
          {s.name}
          {s.screens && s.screens.length > 0 && <span className="system-chip-screen">{s.screens.join("、")}</span>}
        </span>
      ))}
    </span>
  );
}
