import type { ActorLabel } from "./toFlow";

/** 担当アクターのラベル。アクターからの線の代わりに出す */
export function ActorChips({ actors }: { actors: ActorLabel[] }) {
  return (
    <span className="actor-chips" aria-label={`担当: ${actors.map((a) => a.name).join("、")}`}>
      {actors.map((a, i) => (
        <span key={i} className={`actor-chip kind-${a.kind}`} title={a.name}>
          {a.name}
        </span>
      ))}
    </span>
  );
}
