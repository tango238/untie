import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ANALYSIS_LABELS,
  LOCATION_FLAG_LABELS,
  businessContextMatrix,
  contextCoupling,
  informationLocations,
  issueDistribution,
  pairKey,
  performerWorkList,
  usecasesOfActivity,
  workFlow,
  type ActivitySection,
  type AnalysisKind,
  type BridgePath,
  type BusinessUnit,
} from "../../model/analysis";
import { relationLabel } from "../../model/relations";
import { ELEMENT_KIND_LABELS, type Element, type Link, type Relation, type UntieModel } from "../../model/types";
import { useUntieStore } from "../../store";
import { openExternalUrl } from "../../io/file";
import { canvasApi } from "../canvas/canvasApi";
import { HoursLabel } from "../Hours";

/** 分析ボードの見出しに出す説明 */
const DESCRIPTIONS: Record<AnalysisKind, string> = {
  people:
    "担い手 (アクター・外部アクター・システム) ごとに、受け持つ作業を業務・活動の順に並べます。作業や操作をクリックすると、プロパティ欄でリンク (マニュアルなど) を編集できます。",
  businessContext:
    "業務 (または活動) から 作業 → 操作 → 情報 と辿り、どのコンテキストを扱うかを数えます。半分以上の行から使われる列をリソース系、それより少ない列をトランザクション系として目安を出します。数をクリックすると元の道筋を出します。",
  contextCoupling:
    "コンテキストに属する要素 (情報・状態・条件・バリエーション) どうしの関係を数えます。対角はコンテキストの中で閉じた関係 (凝集)、それ以外はコンテキストどうしの結合です。数をクリックすると元の関係を出します。",
  informationLocation:
    "情報ごとに、取得元・保存先のシステム・帳票を並べます。置き場所の無い情報、紙だけの情報、保存先が複数ある情報 (二重管理の可能性) に印を付けます。",
  workFlow: "活動ごとに、作業の担当と、使う操作・扱う情報・判断に使う条件・状態の遷移を並べます。",
  issues: "業務ごとに、業務・その作業・作業が使う操作に付いた課題を集めます。課題の多い業務、重要度の高い業務がわかります。",
};

const attrOf = (id: string) => `[data-analysis-el="${CSS.escape(id)}"]`;

/** 分析ボード: 2〜3 レイヤーをまたいで見渡す表。モデルから毎回組み立てる */
export function AnalysisBoard({ kind }: { kind: AnalysisKind }) {
  const model = useUntieStore((s) => s.model);

  // 要素一覧・検証パネルなどからの選択で、その要素へスクロールする
  useEffect(() => {
    canvasApi.focus = (elementId) => {
      document.querySelector(attrOf(elementId))?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };
    return () => {
      canvasApi.focus = undefined;
    };
  }, []);

  return (
    <div className="fixed-board analysis-board" data-testid="analysis-board">
      <div className="fixed-head">
        <h2 className="fixed-title">{ANALYSIS_LABELS[kind]}</h2>
        <span className="fixed-hint">{DESCRIPTIONS[kind]}</span>
      </div>
      {kind === "people" && <PeopleView model={model} />}
      {kind === "businessContext" && <BusinessContextView model={model} />}
      {kind === "contextCoupling" && <ContextCouplingView model={model} />}
      {kind === "informationLocation" && <InformationLocationView model={model} />}
      {kind === "workFlow" && <WorkFlowView model={model} />}
      {kind === "issues" && <IssuesView model={model} />}
    </div>
  );
}

// ---------------------------------------------------------------- 共通の部品

/** 要素名。クリックで選択してプロパティ欄に出す */
function El({ element, plain }: { element: Element | undefined; plain?: boolean }) {
  const select = useUntieStore((s) => s.select);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const selected = useUntieStore((s) => s.ui.selection?.type === "element" && s.ui.selection.id === element?.id);
  if (!element) return null;
  return (
    <button
      type="button"
      className={`an-el kind-${element.kind}${plain ? " is-plain" : ""}${selected ? " is-selected" : ""}`}
      data-analysis-el={element.id}
      title={`${ELEMENT_KIND_LABELS[element.kind]}: ${element.name}`}
      onClick={() => {
        select({ type: "element", id: element.id });
        setRightPanel("properties");
      }}
    >
      {!plain && <span className="kind-dot" />}
      {element.name || "(名前なし)"}
    </button>
  );
}

function Els({ elements, empty = "—" }: { elements: (Element | undefined)[]; empty?: string }) {
  const list = elements.filter((e): e is Element => !!e);
  if (list.length === 0) return <span className="an-empty">{empty}</span>;
  return (
    <span className="an-els">
      {list.map((e) => (
        <El key={e.id} element={e} />
      ))}
    </span>
  );
}

function Links({ links }: { links: Link[] | undefined }) {
  if (!links || links.length === 0) return <span className="an-empty">—</span>;
  return (
    <span className="an-links">
      {links.map((l, i) => (
        <button key={i} type="button" className="link" title={l.url} onClick={() => void openExternalUrl(l.url)}>
          🔗 {l.title}
        </button>
      ))}
    </span>
  );
}

function sectionTitle(section: ActivitySection): ReactNode {
  if (!section.business) return <span className="an-section-title">未所属の作業</span>;
  return (
    <span className="an-section-title">
      <El element={section.business} plain />
      {section.buc ? (
        <>
          <span className="an-sep">/</span>
          <El element={section.buc} plain />
        </>
      ) : (
        <span className="an-sub">(活動なし)</span>
      )}
    </span>
  );
}

function useById(model: UntieModel) {
  return useMemo(() => new Map(model.elements.map((e) => [e.id, e])), [model]);
}

// ---------------------------------------------------------------- 1. 担当別の作業一覧

function PeopleView({ model }: { model: UntieModel }) {
  const data = useMemo(() => performerWorkList(model), [model]);
  const [filter, setFilter] = useState("");
  const performers = data.performers.filter((p) => !filter || p.performer.id === filter);
  return (
    <>
      <div className="an-toolbar">
        <label className="toolbar-label">
          担い手
          <select aria-label="担い手" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">すべて</option>
            {data.performers.map((p) => (
              <option key={p.performer.id} value={p.performer.id}>
                {ELEMENT_KIND_LABELS[p.performer.kind]}: {p.performer.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {performers.map(({ performer, sections }) => (
        <section key={performer.id} className={`an-block kind-${performer.kind}`} aria-label={performer.name}>
          <h3 className="an-block-title">
            <span className="relation-kind">{ELEMENT_KIND_LABELS[performer.kind]}</span>
            <El element={performer} plain />
            <span className="an-count">{sections.reduce((n, s) => n + s.activities.length, 0)} 件の作業</span>
          </h3>
          {sections.length === 0 ? <p className="hint">担当する作業はありません。</p> : <ActivityTable model={model} sections={sections} />}
        </section>
      ))}
      {!filter && data.unassigned.length > 0 && (
        <section className="an-block is-warning" aria-label="担当のいない作業">
          <h3 className="an-block-title">担当のいない作業</h3>
          <ActivityTable model={model} sections={data.unassigned} />
        </section>
      )}
    </>
  );
}

function ActivityTable({ model, sections }: { model: UntieModel; sections: ActivitySection[] }) {
  return (
    <table className="an-table">
      <thead>
        <tr>
          <th>業務 / 活動</th>
          <th>作業</th>
          <th>時間</th>
          <th>作業のリンク</th>
          <th>使う操作とそのリンク</th>
        </tr>
      </thead>
      <tbody>
        {sections.map((section) =>
          section.activities.map((a, i) => {
            const ucs = usecasesOfActivity(model, a.id);
            return (
              <tr key={`${section.buc?.id ?? section.business?.id ?? "none"}-${a.id}`}>
                {i === 0 && <td rowSpan={section.activities.length}>{sectionTitle(section)}</td>}
                <td>
                  <El element={a} />
                </td>
                <td>
                  <HoursLabel element={a} model={model} className="hours-label is-block" />
                </td>
                <td>
                  <Links links={a.links} />
                </td>
                <td>
                  {ucs.length === 0 ? (
                    <span className="an-empty">—</span>
                  ) : (
                    <ul className="an-sublist">
                      {ucs.map((u) => (
                        <li key={u.id}>
                          <El element={u} />
                          <HoursLabel element={u} model={model} />
                          {u.links && u.links.length > 0 && <Links links={u.links} />}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          }),
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------- 2. 業務とコンテキストの結合

function BusinessContextView({ model }: { model: UntieModel }) {
  const [unit, setUnit] = useState<BusinessUnit>("business");
  const data = useMemo(() => businessContextMatrix(model, unit), [model, unit]);
  const byId = useById(model);
  const [picked, setPicked] = useState<string | null>(null);
  const paths = picked ? (data.cells.get(picked) ?? []) : [];
  const [rowId, colId] = picked ? picked.split("|") : [];
  return (
    <>
      <div className="an-toolbar" role="radiogroup" aria-label="行の単位">
        {(["business", "buc"] as const).map((u) => (
          <button
            key={u}
            type="button"
            role="radio"
            aria-checked={unit === u}
            className={unit === u ? "active" : ""}
            onClick={() => {
              setUnit(u);
              setPicked(null);
            }}
          >
            {u === "business" ? "業務ごと" : "活動ごと"}
          </button>
        ))}
      </div>
      {data.columns.length === 0 ? (
        <p className="hint">コンテキストがありません。コンテキストの固定ボードで作り、情報を属させてください。</p>
      ) : (
        <div className="an-scroll">
          <table className="an-table an-matrix">
            <thead>
              <tr>
                <th>{unit === "business" ? "業務" : "業務 / 活動"}</th>
                {data.columns.map((c) => (
                  <th key={c.id} scope="col">
                    {c.id === "__none" ? c.label : <El element={byId.get(c.id)} plain />}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <th scope="row">
                    <El element={byId.get(r.elementId)} plain />
                    {r.sub && <span className="an-sub">{r.sub}</span>}
                  </th>
                  {data.columns.map((c) => {
                    const key = `${r.id}|${c.id}`;
                    const cell = data.cells.get(key);
                    const n = cell ? new Set(cell.map((p) => p.usecaseId)).size : 0;
                    return (
                      <td key={c.id} className={`an-cell${n > 0 ? " has-value" : ""}${picked === key ? " is-picked" : ""}`} style={heat(n, 4)}>
                        {n > 0 && (
                          <button type="button" className="an-cell-button" aria-label={`${r.label} と ${c.label}: 操作 ${n} 件`} onClick={() => setPicked(picked === key ? null : key)}>
                            {n}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">つながる行の数</th>
                {data.columns.map((c) => {
                  const reach = data.columnReach.get(c.id) ?? 0;
                  return (
                    <td key={c.id} className="an-reach">
                      {reach}
                      <span className="an-sub">{reach >= Math.max(2, data.rows.length / 2) ? "リソース系" : reach > 0 ? "トランザクション系" : ""}</span>
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {picked && (
        <section className="an-detail" aria-label="元の道筋">
          <h3 className="an-block-title">
            元の道筋: {data.rows.find((r) => r.id === rowId)?.label} × {data.columns.find((c) => c.id === colId)?.label}
          </h3>
          <PathList paths={paths} byId={byId} />
        </section>
      )}
    </>
  );
}

function PathList({ paths, byId }: { paths: BridgePath[]; byId: Map<string, Element> }) {
  return (
    <ul className="an-paths">
      {paths.map((p, i) => (
        <li key={i}>
          <El element={byId.get(p.activityId)} />
          <span className="an-arrow">→</span>
          <El element={byId.get(p.usecaseId)} />
          <span className="an-arrow">→</span>
          <El element={byId.get(p.informationId)} />
        </li>
      ))}
    </ul>
  );
}

/** 数に応じた背景色 (0 は無色) */
function heat(n: number, max: number) {
  if (n <= 0) return undefined;
  const ratio = Math.min(1, n / max);
  return { background: `color-mix(in srgb, var(--accent) ${Math.round(10 + ratio * 35)}%, #fff)` };
}

// ---------------------------------------------------------------- 3. コンテキストの結合

function ContextCouplingView({ model }: { model: UntieModel }) {
  const data = useMemo(() => contextCoupling(model), [model]);
  const byId = useById(model);
  const [picked, setPicked] = useState<string | null>(null);
  const relations = picked ? (data.pairs.get(picked) ?? []) : [];
  if (data.contexts.length === 0) return <p className="hint">コンテキストがありません。</p>;
  return (
    <>
      <div className="an-scroll">
        <table className="an-table an-matrix">
          <thead>
            <tr>
              <th />
              {data.contexts.map((c) => (
                <th key={c.id} scope="col">
                  <El element={byId.get(c.id)} plain />
                </th>
              ))}
              <th scope="col">中で閉じた関係</th>
              <th scope="col">外へ出る関係</th>
              <th scope="col">凝集の割合</th>
            </tr>
          </thead>
          <tbody>
            {data.contexts.map((row) => {
              const c = data.cohesion.get(row.id)!;
              const total = c.internal + c.external;
              return (
                <tr key={row.id}>
                  <th scope="row">
                    <El element={byId.get(row.id)} plain />
                  </th>
                  {data.contexts.map((col) => {
                    const key = pairKey(row.id, col.id);
                    const n = data.pairs.get(key)?.length ?? 0;
                    const diag = row.id === col.id;
                    return (
                      <td key={col.id} className={`an-cell${diag ? " is-diag" : ""}${picked === key ? " is-picked" : ""}`} style={diag ? undefined : heat(n, 4)}>
                        {n > 0 && (
                          <button type="button" className="an-cell-button" aria-label={`${row.label} と ${col.label}: 関係 ${n} 件`} onClick={() => setPicked(picked === key ? null : key)}>
                            {n}
                          </button>
                        )}
                      </td>
                    );
                  })}
                  <td className="an-num">{c.internal}</td>
                  <td className="an-num">{c.external}</td>
                  <td className="an-num">{total === 0 ? "—" : `${Math.round((c.internal / total) * 100)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {picked && (
        <section className="an-detail" aria-label="元の関係">
          <h3 className="an-block-title">元の関係</h3>
          <RelationList relations={relations} byId={byId} />
        </section>
      )}
    </>
  );
}

function RelationList({ relations, byId }: { relations: Relation[]; byId: Map<string, Element> }) {
  return (
    <ul className="an-paths">
      {relations.map((r) => (
        <li key={r.id}>
          <El element={byId.get(r.sourceId)} />
          <span className="relation-kind">{relationLabel(r.kind)}</span>
          <El element={byId.get(r.targetId)} />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 4. 情報の所在

function InformationLocationView({ model }: { model: UntieModel }) {
  const data = useMemo(() => informationLocations(model), [model]);
  const byId = useById(model);
  return (
    <div className="an-scroll">
      <table className="an-table an-matrix">
        <thead>
          <tr>
            <th>情報</th>
            {data.places.map((p) => (
              <th key={p.id} scope="col" className={`kind-${p.kind}`}>
                <El element={p} plain />
                <span className="an-sub">{ELEMENT_KIND_LABELS[p.kind]}</span>
              </th>
            ))}
            <th scope="col">扱う操作</th>
            <th scope="col">気をつけること</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.information.id}>
              <th scope="row">
                <El element={row.information} />
                {"contextId" in row.information && row.information.contextId && (
                  <span className="an-sub">{byId.get(row.information.contextId)?.name}</span>
                )}
              </th>
              {data.places.map((p) => {
                const roles = row.places.get(p.id) ?? [];
                return (
                  <td key={p.id} className={`an-cell${roles.length > 0 ? " has-value" : ""}`}>
                    {roles.map((r) => (
                      <span key={r} className={`an-role role-${r}`}>
                        {r === "source" ? "取得" : "保存"}
                      </span>
                    ))}
                  </td>
                );
              })}
              <td className="an-num">{row.usecaseCount}</td>
              <td>
                {row.flags.map((f) => (
                  <span key={f} className="an-flag">
                    {LOCATION_FLAG_LABELS[f]}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 5. 作業の流れ

function WorkFlowView({ model }: { model: UntieModel }) {
  const data = useMemo(() => workFlow(model), [model]);
  return (
    <>
      {data.map(({ section, rows }) => (
        <section key={section.buc?.id ?? section.business?.id ?? "none"} className="an-block" aria-label={section.buc?.name ?? section.business?.name ?? "未所属の作業"}>
          <h3 className="an-block-title">{sectionTitle(section)}</h3>
          <table className="an-table">
            <thead>
              <tr>
                <th>作業</th>
                <th>担当</th>
                <th>操作</th>
                <th>扱う情報</th>
                <th>判断に使う条件</th>
                <th>状態の遷移</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ucs = row.usecases.length > 0 ? row.usecases : [null];
                return ucs.map((u, i) => (
                  <tr key={`${row.activity.id}-${u?.usecase.id ?? "none"}`}>
                    {i === 0 && (
                      <>
                        <td rowSpan={ucs.length}>
                          <El element={row.activity} />
                          <HoursLabel element={row.activity} model={model} className="hours-label is-block" />
                        </td>
                        <td rowSpan={ucs.length}>
                          <Els elements={row.performers} empty="担当なし" />
                        </td>
                      </>
                    )}
                    <td>
                      {u ? (
                        <>
                          <El element={u.usecase} />
                          <HoursLabel element={u.usecase} model={model} />
                        </>
                      ) : (
                        <span className="an-empty">—</span>
                      )}
                    </td>
                    <td>{u && <Els elements={u.informations} />}</td>
                    <td>{u && <Els elements={u.conditions} />}</td>
                    <td>
                      {u && (u.fromStates.length > 0 || u.toStates.length > 0) ? (
                        <span className="an-els">
                          <Els elements={u.fromStates} empty="(どこからでも)" />
                          <span className="an-arrow">→</span>
                          <Els elements={u.toStates} empty="(変わらない)" />
                        </span>
                      ) : (
                        <span className="an-empty">—</span>
                      )}
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- 6. 課題の分布

function IssuesView({ model }: { model: UntieModel }) {
  const data = useMemo(() => issueDistribution(model), [model]);
  const maxCount = Math.max(1, ...data.map((d) => d.issues.length));
  return (
    <table className="an-table">
      <thead>
        <tr>
          <th>業務</th>
          <th>課題の数</th>
          <th>課題 (重要度の高い順)</th>
          <th>どこに付いているか</th>
        </tr>
      </thead>
      <tbody>
        {data.map((d) => (
          <tr key={d.business?.id ?? "none"}>
            <th scope="row">{d.business ? <El element={d.business} plain /> : "どの業務にも辿れない課題"}</th>
            <td>
              <span className="an-bar">
                <span className={`an-bar-fill sev-${d.maxSeverity}`} style={{ width: `${(d.issues.length / maxCount) * 100}%` }} />
              </span>
              <span className="an-num">{d.issues.length}</span>
            </td>
            <td>
              {d.issues.length === 0 ? (
                <span className="an-empty">—</span>
              ) : (
                <ul className="an-sublist">
                  {d.issues.map((i) => (
                    <li key={i.id}>
                      <span className={`sev-chip sev-${i.severity}`} aria-label={`重要度 ${i.severity}`}>
                        {i.severity}
                      </span>
                      <El element={i} plain />
                    </li>
                  ))}
                </ul>
              )}
            </td>
            <td>
              {d.spots.length === 0 ? (
                <span className="an-empty">—</span>
              ) : (
                <ul className="an-sublist">
                  {d.spots.map((s) => (
                    <li key={s.element.id}>
                      <span className="relation-kind">{ELEMENT_KIND_LABELS[s.element.kind]}</span>
                      <El element={s.element} />
                      <span className="an-sub">{s.issues.length} 件</span>
                    </li>
                  ))}
                </ul>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
