import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FIXED_LAYER_LABELS,
  addToGroup,
  emptyLayerHint,
  filterGroups,
  scopeGroups,
  fixedGroups,
  linkCandidates,
  linkToGroup,
  unlinkFromGroup,
  type FixedGroup,
  type FixedLayer,
  type FixedSection,
} from "../model/fixedBoards";
import { issueSummaries } from "../model/selectors";
import { ELEMENT_KIND_LABELS, isIssueTargetKind, type Element, type ElementKind, type UntieModel } from "../model/types";
import { addElement, updateElement } from "../model/commands";
import { useUntieStore } from "../store";
import { ActorChips } from "./canvas/ActorChips";
import { canvasApi } from "./canvas/canvasApi";
import { SystemChips } from "./canvas/SystemChips";
import { actorLabels, systemLabels, type SystemLabel } from "./canvas/toFlow";
import { GRANULARITY, LAYER_GUIDES, type GranularityGuide, type GuideKind } from "./granularity";
import { HoursLabel } from "./Hours";
import { GlobalFilterBar } from "./GlobalFilterBar";
import { IssueBadge } from "./IssueBadge";
import { globalFilterScope } from "../model/lineage";

/** 固定ボードの見出しに出す、上位レイヤーの説明 */
const LAYER_HINTS: Record<FixedLayer, string> = {
  actor: "作業の担い手 (アクター・外部アクター・システム) と、情報の置き場所 (システム・帳票) を並べます。",
  business: "アクターごとに、主担当の業務を並べます。業務 = 部門や担当で分かれる仕事の大きなまとまり。",
  buc: "業務ごとに活動を並べます。活動 = 1 つの目的を果たす作業のまとまり。",
  activity: "活動ごとに (活動の無い業務は業務ごとに) 作業を並べます。作業 = 1 人 (または 1 つのシステム) が一続きでやり終える手順。",
  usecase: "活動ごとに区切り、作業ごとに使う操作を並べます。操作 = システムや帳票に対して行う 1 回の操作。",
  context: "コンテキストごとに、属する情報・条件・状態・バリエーションを並べます。枠から足したり、別のコンテキストから移したりできます。",
  information: "コンテキストごとに情報を並べます。カードには取得元・保存先のシステム・帳票を出します。情報 = 記録や書類に当たる情報のまとまり。",
  condition: "操作ごとに、判断に使う条件を並べます。条件 = はい・いいえで答えられる判断 1 つ分。",
  state: "状態グループごとに状態を並べます。状態 = 情報やモノがたどる段階。",
  variation: "情報ごとに、種別 (バリエーション) を並べます。バリエーション = 情報や条件を分ける種別と値の一覧。",
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
  const globalFilter = useUntieStore((s) => s.ui.globalFilter);
  const scope = useMemo(() => globalFilterScope(model, globalFilter), [model, globalFilter]);
  const groups = useMemo(() => filterGroups(scopeGroups(allGroups, scope), query), [allGroups, scope, query]);
  const summaries = useMemo(() => issueSummaries(model), [model]);
  const actors = useMemo(() => actorLabels(model), [model]);
  const systems = useMemo(() => systemLabels(model), [model]);
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
      <GlobalFilterBar />
      <div className="fixed-head">
        <h2 className="fixed-title">{FIXED_LAYER_LABELS[layer]}</h2>
        <span className="fixed-hint">{LAYER_HINTS[layer]}</span>
        {layer === "context" && <AddContextButton />}
        <input
          type="search"
          className="fixed-filter"
          aria-label="絞り込み"
          placeholder="名前で絞り込み"
          value={query}
          onChange={(e) => setFixedFilter(layer, e.target.value)}
        />
      </div>
      <GuidePanel {...LAYER_GUIDES[layer]} />
      {hint && <p className="hint">{hint}</p>}
      {query.trim() !== "" && groups.length === 0 && <p className="hint">「{query.trim()}」に一致する要素はありません。</p>}
      {scope && query.trim() === "" && groups.length === 0 && <p className="hint">グローバルフィルターに合う要素はありません。</p>}
      {splitSections(groups).map(({ section, groups: gs }) => {
        const grid = (
          <div className="fixed-groups">
            {gs.map((g) => (
              <GroupView
                key={g.key}
                group={g}
                fullGroup={allGroups.find((x) => x.key === g.key) ?? g}
                model={model}
                selectedId={selectedId}
                summaries={summaries}
                actors={actors}
                systems={systems}
              />
            ))}
          </div>
        );
        return section ? (
          <SectionView key={section.key} section={section} model={model}>
            {grid}
          </SectionView>
        ) : (
          <div key="__plain">{grid}</div>
        );
      })}
    </div>
  );
}

/** コンテキストを作って選び、名前の入力へ移る (コンテキストは枠の見出しなので、ボードの見出しから作る) */
function AddContextButton() {
  const onClick = () => {
    const st = useUntieStore.getState();
    const r = st.dispatch((m) => addElement(m, { kind: "context", name: "新しいコンテキスト" }));
    if (!r.ok) {
      st.pushToast(r.reason, "error");
      return;
    }
    st.select({ type: "element", id: r.id });
    st.setRightPanel("properties");
    st.requestNameFocus();
    setTimeout(() => document.querySelector(`[data-fixed-group="${CSS.escape(r.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
  };
  return (
    <button type="button" className="fixed-head-add" onClick={onClick}>
      ＋コンテキスト
    </button>
  );
}

const GUIDE_ROWS: { key: keyof GranularityGuide; label: string }[] = [
  { key: "what", label: "何を書くか" },
  { key: "size", label: "粒度の目安" },
  { key: "naming", label: "書き方" },
  { key: "examples", label: "例" },
  { key: "tooBig", label: "大きすぎる例" },
  { key: "tooSmall", label: "細かすぎる例" },
];

/** ボードで扱う要素と、取り違えやすい要素の書き方と粒度を並べて見せる。今のボードの種類を強調する */
function GuidePanel({ kinds, current }: { kinds: GuideKind[]; current?: GuideKind }) {
  const open = useUntieStore((s) => s.ui.guideOpen ?? false);
  const setGuideOpen = useUntieStore((s) => s.setGuideOpen);
  return (
    <details
      className={`fixed-guide${current ? "" : " no-current"}`}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) setGuideOpen(next);
      }}
    >
      <summary>書き方のヒント ({kinds.map((k) => ELEMENT_KIND_LABELS[k]).join("・")}の粒度)</summary>
      <table className="guide-table">
        <thead>
          <tr>
            <th scope="col" />
            {kinds.map((k) => (
              <th key={k} scope="col" className={k === current ? "is-current" : undefined}>
                {ELEMENT_KIND_LABELS[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GUIDE_ROWS.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {kinds.map((k) => (
                <td key={k} className={k === current ? "is-current" : undefined}>
                  {GRANULARITY[k][row.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="guide-questions">
        {kinds.map((k) => (
          <li key={k} className={k === current ? "is-current" : undefined}>
            <b>{ELEMENT_KIND_LABELS[k]}</b>: {GRANULARITY[k].question}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** 続きの枠を段落ごとにまとめる (段落の無い枠は 1 つにまとめる) */
function splitSections(groups: FixedGroup[]): { section?: FixedSection; groups: FixedGroup[] }[] {
  const out: { section?: FixedSection; groups: FixedGroup[] }[] = [];
  for (const g of groups) {
    const last = out[out.length - 1];
    if (last && last.section?.key === g.section?.key) last.groups.push(g);
    else out.push({ ...(g.section ? { section: g.section } : {}), groups: [g] });
  }
  return out;
}

function SectionView({ section, model, children }: { section: FixedSection; model: UntieModel; children: ReactNode }) {
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const parent = section.parentId ? model.elements.find((e) => e.id === section.parentId) : undefined;
  const selected = useUntieStore((s) => !!parent && s.ui.selection?.type === "element" && s.ui.selection.id === parent.id);
  return (
    <section
      className={`fixed-section${parent ? ` kind-${parent.kind}` : ""}${selected ? " is-selected" : ""}`}
      aria-label={section.title}
      data-fixed-group={section.key}
    >
      <h3 className="fixed-section-head">
        {parent ? (
          <button
            type="button"
            className="fixed-section-title link-plain"
            onClick={() => {
              select({ type: "element", id: parent.id });
              setRightPanel("properties");
            }}
          >
            {section.title}
          </button>
        ) : (
          <span className="fixed-section-title">{section.title}</span>
        )}
        {section.subtitle && <span className="fixed-section-sub">{section.subtitle}</span>}
      </h3>
      {children}
    </section>
  );
}

function GroupView({
  group,
  fullGroup,
  model,
  selectedId,
  summaries,
  actors,
  systems,
}: {
  group: FixedGroup;
  /** 絞り込み前の枠 (既存の要素を足す候補はこちらで決める) */
  fullGroup: FixedGroup;
  model: UntieModel;
  selectedId: string | null;
  summaries: ReturnType<typeof issueSummaries>;
  actors: ReturnType<typeof actorLabels>;
  systems: Map<string, SystemLabel[]>;
}) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const requestNameFocus = useUntieStore((s) => s.requestNameFocus);
  const pushToast = useUntieStore((s) => s.pushToast);

  const parent = group.parentId ? model.elements.find((e) => e.id === group.parentId) : undefined;
  const parentKind = parent?.kind ?? (group.link.type === "none" && group.parentId === null && group.key === group.childKind ? group.childKind : undefined);
  const contextMembers = group.link.type === "contextMembers";
  const canUnlink = group.link.type === "relation" || (contextMembers && group.parentId !== null);
  const candidates = linkCandidates(model, fullGroup);
  const kindLabel = ELEMENT_KIND_LABELS[group.childKind];
  const addKinds = group.addKinds ?? [group.childKind];
  const nameOf = (id: string | null) => (id ? model.elements.find((x) => x.id === id)?.name || "(名前なし)" : "未分類");

  const choose = (id: string) => {
    select({ type: "element", id });
    setRightPanel("properties");
  };

  const add = (kind: ElementKind) => {
    const r = dispatch((m) => addToGroup(m, fullGroup, undefined, kind));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    choose(r.id);
    requestNameFocus();
    setTimeout(() => canvasApi.focus?.(r.id), 50);
  };

  return (
    <section
      className={`fixed-group${parentKind ? ` kind-${parentKind}` : ""}${parent && selectedId === parent.id ? " is-selected" : ""}`}
      aria-label={group.title}
      data-fixed-group={group.key}
    >
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
      {group.warning && <p className="fixed-group-warning">{group.warning}</p>}
      <ul className="fixed-cards">
        {group.items.map((e) => (
          <li key={e.id} className="fixed-card-row">
            <FixedCard
              element={e}
              model={model}
              selected={selectedId === e.id}
              summary={isIssueTargetKind(e.kind) ? summaries.get(e.id) : undefined}
              actors={actors.get(e.id)}
              systems={systems.get(e.id)}
              showStateGroup={contextMembers}
              onClick={() => choose(e.id)}
            />
            {canUnlink && (
              <button
                type="button"
                className="icon-button fixed-unlink"
                title={contextMembers ? "このコンテキストから外して未分類にする (要素は残る)" : "この枠から外す (要素は残る)"}
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
      {!group.noAdd && <div className="fixed-add">
        {addKinds.map((kind) => (
          <button key={kind} type="button" onClick={() => add(kind)} aria-label={`「${group.title}」に${ELEMENT_KIND_LABELS[kind]}を追加`}>
            ＋{ELEMENT_KIND_LABELS[kind]}
          </button>
        ))}
        {contextMembers && candidates.length > 0 && (
          <select
            className="fixed-move"
            aria-label={`「${group.title}」へ別のコンテキストから移す`}
            value=""
            onChange={(ev) => {
              const id = ev.target.value;
              if (!id) return;
              const r = dispatch((m) => linkToGroup(m, fullGroup, id));
              if (!r.ok) pushToast(r.reason, "error");
            }}
          >
            <option value="">別のコンテキストから移す…</option>
            {addKinds.map((kind) => (
              <optgroup key={kind} label={ELEMENT_KIND_LABELS[kind]}>
                {candidates
                  .filter((c) => c.kind === kind)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || "(名前なし)"}
                      {c.kind === "state" && c.group ? ` (状態グループ「${c.group}」ごと)` : ""}
                      {` ← ${nameOf("contextId" in c ? c.contextId : null)}`}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        )}
        {!contextMembers && candidates.length > 0 && (
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
      </div>}
    </section>
  );
}

function FixedCard({
  element,
  model,
  selected,
  summary,
  actors,
  systems,
  showStateGroup,
  onClick,
}: {
  element: Element;
  model: UntieModel;
  selected: boolean;
  summary?: { count: number; maxSeverity: number };
  actors?: ReturnType<typeof actorLabels> extends Map<string, infer V> ? V : never;
  systems?: SystemLabel[];
  /** 状態に状態グループ名を添える (コンテキストの枠では、複数のグループが同じ枠に並ぶので) */
  showStateGroup?: boolean;
  onClick: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // 既定の活動の名前は業務の名前と同じで、直接は変えられない
  const renamable = !(element.kind === "buc" && element.isDefault);
  const className = `fixed-card kind-${element.kind}${selected ? " is-selected" : ""}`;

  const top = (
    <span className="fixed-card-top">
      <span className="card-kind-inline">{ELEMENT_KIND_LABELS[element.kind]}</span>
      <span className="fixed-card-badges">
        {"links" in element && element.links && element.links.length > 0 && (
          <span className="card-links" title={element.links.map((l) => l.title).join("、")} aria-label={`リンク ${element.links.length} 件`}>
            🔗{element.links.length}
          </span>
        )}
        {summary && <IssueBadge count={summary.count} maxSeverity={summary.maxSeverity} />}
      </span>
    </span>
  );
  const rest = (
    <>
      {showStateGroup && element.kind === "state" && element.group && <span className="fixed-card-sub">状態グループ: {element.group}</span>}
      <HoursLabel element={element} model={model} />
      {actors && <ActorChips actors={actors} />}
      {systems && <SystemChips systems={systems} />}
    </>
  );

  // 入力欄はボタンの中に置けないので、編集中はカードを div にする
  if (editing) {
    return (
      <div className={className} data-fixed-card={element.id}>
        {top}
        <NameForm element={element} onDone={() => setEditing(false)} />
        {rest}
      </div>
    );
  }

  return (
    <button type="button" className={className} data-fixed-card={element.id} aria-pressed={selected} onClick={onClick}>
      {top}
      <span
        className={`fixed-card-name${renamable ? " is-renamable" : ""}`}
        title={renamable ? "クリックで名前を変える" : undefined}
        onClick={renamable ? () => setEditing(true) : undefined}
      >
        {element.name || "(名前なし)"}
      </span>
      {rest}
    </button>
  );
}

/** カードの名前をその場で変える。Enter・保存で確定し、Esc・フォーカスが外れたら取り消す */
function NameForm({ element, onDone }: { element: Element; onDone: () => void }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const [value, setValue] = useState(element.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = () => {
    if (value.trim() !== element.name) {
      const r = dispatch((m) => updateElement(m, { id: element.id, patch: { name: value } }));
      if (!r.ok) {
        pushToast(r.reason, "error");
        return;
      }
    }
    onDone();
  };

  return (
    <form
      className="fixed-card-rename"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onBlur={(e) => {
        // フォーム内 (入力欄と保存ボタンの間) の移動では取り消さない
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDone();
      }}
    >
      <input
        ref={inputRef}
        aria-label={`${ELEMENT_KIND_LABELS[element.kind]}の名前`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // 変換確定の Enter / Esc では確定・取り消しをしない
          // WebKit は変換確定の Enter を compositionend の後に isComposing=false, keyCode=229 で送ることがある
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
            if (e.key === "Enter") e.preventDefault();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone();
          }
        }}
      />
      {/* 押したときに入力欄からフォーカスが外れて取り消しにならないよう、mousedown の既定動作を止める */}
      <button type="submit" onMouseDown={(e) => e.preventDefault()}>
        保存
      </button>
    </form>
  );
}
