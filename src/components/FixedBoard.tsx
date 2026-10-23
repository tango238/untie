import { useEffect, useMemo } from "react";
import {
  FIXED_LAYER_LABELS,
  addToGroup,
  emptyLayerHint,
  filterGroups,
  fixedGroups,
  linkCandidates,
  linkToGroup,
  unlinkFromGroup,
  type FixedGroup,
  type FixedLayer,
} from "../model/fixedBoards";
import { issueSummaries } from "../model/selectors";
import { ELEMENT_KIND_LABELS, isIssueTargetKind, type Element, type UntieModel } from "../model/types";
import { useUntieStore } from "../store";
import { ActorChips } from "./canvas/ActorChips";
import { canvasApi } from "./canvas/canvasApi";
import { actorLabels } from "./canvas/toFlow";
import { IssueBadge } from "./IssueBadge";

/** 固定ボードの見出しに出す、上位レイヤーの説明 */
const LAYER_HINTS: Record<FixedLayer, string> = {
  actor: "アクターと外部アクターを並べます。",
  business: "アクターごとに、主担当の業務を並べます。",
  buc: "業務ごとに BUC を並べます。",
  activity: "BUC ごとに (BUC の無い業務は業務ごとに) アクティビティを並べます。",
  usecase: "アクティビティごとに、使うユースケースを並べます。",
  information: "ユースケースごとに、扱う情報を並べます。",
  condition: "ユースケースごとに、判断に使う条件を並べます。",
  state: "状態グループごとに状態を並べます。",
  variation: "情報ごとに、種別 (バリエーション) を並べます。",
};

function cardSelector(id: string) {
  return `[data-fixed-card="${CSS.escape(id)}"]`;
}

/** 固定ボード: 上位の要素を枠にして、下位の要素を自動で並べる。位置は動かせない */
export function FixedBoard({ layer }: { layer: FixedLayer }) {
  const model = useUntieStore((s) => s.model);
  const selection = useUntieStore((s) => s.ui.selection);
  const query = useUntieStore((s) => s.ui.fixedFilters?.[layer] ?? "");
  const setFixedFilter = useUntieStore((s) => s.setFixedFilter);

  const allGroups = useMemo(() => fixedGroups(model, layer), [model, layer]);
  const groups = useMemo(() => filterGroups(allGroups, query), [allGroups, query]);
  const summaries = useMemo(() => issueSummaries(model), [model]);
  const actors = useMemo(() => actorLabels(model), [model]);
  const selectedId = selection?.type === "element" ? selection.id : null;

  // 要素一覧からのクリックで、そのカードへスクロールする
  useEffect(() => {
    canvasApi.focus = (elementId) => {
      document.querySelector(cardSelector(elementId))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return () => {
      canvasApi.focus = undefined;
    };
  }, []);

  const hint = allGroups.length === 0 ? emptyLayerHint(layer) : null;

  return (
    <div className="fixed-board" data-testid="fixed-board">
      <div className="fixed-head">
        <h2 className="fixed-title">{FIXED_LAYER_LABELS[layer]}</h2>
        <span className="fixed-hint">{LAYER_HINTS[layer]}</span>
        <input
          type="search"
          className="fixed-filter"
          aria-label="絞り込み"
          placeholder="名前で絞り込み"
          value={query}
          onChange={(e) => setFixedFilter(layer, e.target.value)}
        />
      </div>
      {hint && <p className="hint">{hint}</p>}
      {query.trim() !== "" && groups.length === 0 && <p className="hint">「{query.trim()}」に一致する要素はありません。</p>}
      <div className="fixed-groups">
        {groups.map((g) => (
          <GroupView
            key={g.key}
            group={g}
            fullGroup={allGroups.find((x) => x.key === g.key) ?? g}
            model={model}
            selectedId={selectedId}
            summaries={summaries}
            actors={actors}
          />
        ))}
      </div>
    </div>
  );
}

function GroupView({
  group,
  fullGroup,
  model,
  selectedId,
  summaries,
  actors,
}: {
  group: FixedGroup;
  /** 絞り込み前の枠 (既存の要素を足す候補はこちらで決める) */
  fullGroup: FixedGroup;
  model: UntieModel;
  selectedId: string | null;
  summaries: ReturnType<typeof issueSummaries>;
  actors: ReturnType<typeof actorLabels>;
}) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const requestNameFocus = useUntieStore((s) => s.requestNameFocus);
  const pushToast = useUntieStore((s) => s.pushToast);

  const parent = group.parentId ? model.elements.find((e) => e.id === group.parentId) : undefined;
  const parentKind = parent?.kind ?? (group.childKind === "actor" || group.childKind === "externalActor" ? group.childKind : undefined);
  const canUnlink = group.link.type === "relation";
  const candidates = linkCandidates(model, fullGroup);
  const kindLabel = ELEMENT_KIND_LABELS[group.childKind];

  const choose = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
  };

  const add = () => {
    const r = dispatch((m) => addToGroup(m, fullGroup));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    choose(r.id);
    requestNameFocus();
    setTimeout(() => canvasApi.focus?.(r.id), 50);
  };

  return (
    <section className={`fixed-group${parentKind ? ` kind-${parentKind}` : ""}`} aria-label={group.title}>
      <header className="fixed-group-head">
        {parent ? (
          <button type="button" className="fixed-group-title link-plain" onClick={() => choose(parent.id)}>
            {group.title}
          </button>
        ) : (
          <span className="fixed-group-title">{group.title}</span>
        )}
        {group.subtitle && <span className="fixed-group-sub">{group.subtitle}</span>}
        <span className="fixed-group-count">{group.items.length}</span>
      </header>
      <ul className="fixed-cards">
        {group.items.map((e) => (
          <li key={e.id} className="fixed-card-row">
            <FixedCard
              element={e}
              selected={selectedId === e.id}
              summary={isIssueTargetKind(e.kind) ? summaries.get(e.id) : undefined}
              actors={actors.get(e.id)}
              onClick={() => choose(e.id)}
            />
            {canUnlink && (
              <button
                type="button"
                className="icon-button fixed-unlink"
                title="この枠から外す (要素は残る)"
                aria-label={`${e.name || "要素"}を「${group.title}」から外す`}
                onClick={() => {
                  const r = dispatch((m) => unlinkFromGroup(m, fullGroup, e.id));
                  if (!r.ok) pushToast(r.reason, "error");
                }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="fixed-add">
        <button type="button" onClick={add} aria-label={`「${group.title}」に${kindLabel}を追加`}>
          ＋{kindLabel}
        </button>
        {candidates.length > 0 && (
          <select
            aria-label={`「${group.title}」に既存の${kindLabel}を足す`}
            value=""
            onChange={(ev) => {
              const id = ev.target.value;
              if (!id) return;
              const r = dispatch((m) => linkToGroup(m, fullGroup, id));
              if (!r.ok) pushToast(r.reason, "error");
            }}
          >
            <option value="">既存から足す…</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || "(名前なし)"}
              </option>
            ))}
          </select>
        )}
      </div>
    </section>
  );
}

function FixedCard({
  element,
  selected,
  summary,
  actors,
  onClick,
}: {
  element: Element;
  selected: boolean;
  summary?: { count: number; maxSeverity: number };
  actors?: ReturnType<typeof actorLabels> extends Map<string, infer V> ? V : never;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`fixed-card kind-${element.kind}${selected ? " is-selected" : ""}`}
      data-fixed-card={element.id}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="fixed-card-top">
        <span className="card-kind-inline">{ELEMENT_KIND_LABELS[element.kind]}</span>
        {summary && <IssueBadge count={summary.count} maxSeverity={summary.maxSeverity} />}
      </span>
      <span className="fixed-card-name">{element.name || "(名前なし)"}</span>
      {actors && <ActorChips actors={actors} />}
    </button>
  );
}
