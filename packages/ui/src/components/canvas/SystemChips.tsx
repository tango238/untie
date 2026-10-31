import type { SystemLabel } from "./toFlow";

const ROLE_LABELS: Record<SystemLabel["role"], string> = { source: "取得元", store: "保存先" };

/** 情報の取得元・保存先のシステム・帳票。帳票は破線で出す */
export function SystemChips({ systems }: { systems: SystemLabel[] }) {
  return (
    <span className="actor-chips system-chips" aria-label={systems.map((s) => `${ROLE_LABELS[s.role]}: ${s.name}`).join("、")}>
      {systems.map((s, i) => (
        <span key={i} className={`actor-chip kind-${s.kind}`} title={`${ROLE_LABELS[s.role]}: ${s.name}`}>
          <span className="system-chip-role">{ROLE_LABELS[s.role]}</span>
          {s.name}
        </span>
      ))}
    </span>
  );
}
