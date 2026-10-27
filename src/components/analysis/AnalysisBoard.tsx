import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ANALYSIS_LABELS,
  LOCATION_FLAG_LABELS,
  informationLocations,
  issueDistribution,
  performerWorkList,
  usecasesOfActivity,
  type ActivitySection,
  type AnalysisKind,
} from "../../model/analysis";
import { issueBoardSections } from "../../model/selectors";
import { ELEMENT_KIND_LABELS, type Element, type Link, type UntieModel } from "../../model/types";
import { useUntieStore } from "../../store";
import { openExternalUrl } from "../../io/file";
import { canvasApi } from "../canvas/canvasApi";
import { HoursLabel } from "../Hours";

/** 分析ボードの見出しに出す説明 */
const DESCRIPTIONS: Record<AnalysisKind, string> = {
  people:
    "担い手 (アクター・外部アクター・システム) ごとに、受け持つ作業を業務・活動の順に並べます。作業や操作をクリックすると、プロパティ欄でリンク (マニュアルなど) を編集できます。",
  informationLocation:
    "情報ごとに、取得元・保存先のシステム・帳票を並べます。置き場所の無い情報、紙だけの情報、保存先が複数ある情報 (二重管理の可能性) に印を付けます。",
  issues: "業務ごとに、業務・その作業・作業が使う操作に付いた課題 (具体的な課題) を集めます。課題の多い業務、重要度の高い業務がわかります。登場人物に付いた課題 (全体的な課題) は下の表に分けて出します。",
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
      {kind === "informationLocation" && <InformationLocationView model={model} />}
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

// ---------------------------------------------------------------- 2. 情報の所在

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

// ---------------------------------------------------------------- 3. 課題の分布

function IssuesView({ model }: { model: UntieModel }) {
  const data = useMemo(() => issueDistribution(model), [model]);
  const overall = useMemo(() => issueBoardSections(model).find((s) => s.scope === "overall")!, [model]);
  const maxCount = Math.max(1, ...data.map((d) => d.issues.length));
  return (
    <>
      <h3 className="an-subtitle">具体的な課題 (業務ごと)</h3>
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
              <th scope="row">{d.business ? <El element={d.business} plain /> : "どの業務にも辿れない課題 (未整理を含む)"}</th>
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
      <h3 className="an-subtitle">全体的な課題 (登場人物ごと)</h3>
      {overall.groups.length === 0 ? (
        <p className="hint">登場人物を対象にした課題はありません。</p>
      ) : (
        <table className="an-table">
          <thead>
            <tr>
              <th>登場人物</th>
              <th>課題の数</th>
              <th>課題 (重要度の高い順)</th>
            </tr>
          </thead>
          <tbody>
            {overall.groups.map((g) => (
              <tr key={g.target!.id}>
                <th scope="row">
                  <span className="relation-kind">{ELEMENT_KIND_LABELS[g.target!.kind]}</span>
                  <El element={g.target!} plain />
                </th>
                <td>
                  <span className="an-num">{g.issues.length}</span>
                </td>
                <td>
                  <ul className="an-sublist">
                    {g.issues.map((i) => (
                      <li key={i.id}>
                        <span className={`sev-chip sev-${i.severity}`} aria-label={`重要度 ${i.severity}`}>
                          {i.severity}
                        </span>
                        <El element={i} plain />
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
