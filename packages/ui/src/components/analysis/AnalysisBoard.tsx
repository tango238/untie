import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ANALYSIS_LABELS,
  LOCATION_FLAG_LABELS,
  informationLocations,
  issueDistribution,
  performerWorkList,
  screenInformationTables,
  systemEventLists,
  usecasesOfActivity,
  type ActivitySection,
  type AnalysisKind,
} from "@untie/core/model/analysis";
import { issueBoardSections } from "@untie/core/model/selectors";
import { ELEMENT_KIND_LABELS, type Link, type UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { El } from "./analysisParts";
import { StormingView } from "./StormingView";
import { getPlatform } from "../../platform";
import { canvasApi } from "../canvas/canvasApi";
import { HoursLabel } from "../Hours";

/** 分析ボードの見出しに出す説明 */
const DESCRIPTIONS: Record<AnalysisKind, string> = {
  people:
    "担い手 (アクター・外部アクター) ごとに、受け持つ作業を業務・活動の順に並べます。作業や操作をクリックすると、プロパティ欄でリンク (マニュアルなど) を編集できます。",
  informationLocation:
    "情報ごとに、取得元・保存先のシステム・帳票を並べます。置き場所の無い情報、紙だけの情報、保存先が複数ある情報 (二重管理の可能性) に印を付けます。下の表では、システムごとに画面が扱う情報を並べます。",
  issues: "業務ごとに、業務・その作業・作業が使う操作に付いた課題 (具体的な課題) を集めます。課題の多い業務、重要度の高い業務がわかります。登場人物に付いた課題 (全体的な課題) と、対象のない課題 (未整理) は下の表に分けて出します。",
  storming:
    "分析からドメインモデル (DDD) の候補を導きます。情報を書く操作をコマンド、分析のイベントをドメインイベント、イベントをきっかけにした操作をポリシー、状態を持つ情報を集約のルートの候補にします。候補と根拠を出すだけで、決めるのは人です。導く途中で見つかる問い (境界やあるべき姿の判断) と情報を、上の「気づき」に出します。",
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
      {kind === "storming" && <StormingView model={model} />}
    </div>
  );
}

// ---------------------------------------------------------------- 共通の部品

function Links({ links }: { links: Link[] | undefined }) {
  if (!links || links.length === 0) return <span className="an-empty">—</span>;
  return (
    <span className="an-links">
      {links.map((l, i) => (
        <button key={i} type="button" className="link" title={l.url} onClick={() => void getPlatform().openExternalUrl(l.url)}>
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
      <ScreenInformationView model={model} />
      <SystemEventView model={model} />
    </div>
  );
}

/** システムごとの、画面 × 情報の表。画面が扱う情報は、その画面を使う操作が扱う情報 (取得・保存) から導く */
function ScreenInformationView({ model }: { model: UntieModel }) {
  const data = useMemo(() => screenInformationTables(model), [model]);
  if (data.tables.length === 0 && data.systemsWithoutScreens.length === 0) return null;
  return (
    <section className="an-screens" aria-label="画面と情報">
      <h3 className="an-subtitle">画面と情報</h3>
      {data.tables.length === 0 && <p className="hint">画面がまだありません。「画面」の固定ボードで、システムごとに画面を作れます。画面が扱う情報は、その画面を使う操作が扱う情報から導きます。</p>}
      {data.tables.map((t) => (
        <div key={t.system.id} className="an-screen-table" data-testid={`screen-table-${t.system.id}`}>
          <h4 className="an-block-title">
            <El element={t.system} />
          </h4>
          <table className="an-table an-matrix">
            <thead>
              <tr>
                <th>画面</th>
                {t.informations.map((i) => (
                  <th key={i.id} scope="col" className="kind-information">
                    <El element={i} plain />
                  </th>
                ))}
                <th scope="col">使う操作</th>
                <th scope="col">気をつけること</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row) => (
                <tr key={row.screen.id}>
                  <th scope="row">
                    <El element={row.screen} />
                  </th>
                  {t.informations.map((i) => {
                    const roles = row.cells.get(i.id) ?? [];
                    return (
                      <td key={i.id} className={`an-cell${roles.length > 0 ? " has-value" : ""}`}>
                        {roles.map((r) => (
                          <span key={r} className={`an-role role-${r}`}>
                            {r === "source" ? "取得" : "保存"}
                          </span>
                        ))}
                      </td>
                    );
                  })}
                  <td>
                    {row.usecases.length > 0 ? (
                      <span className="an-list">
                        {row.usecases.map((u) => (
                          <El key={u.id} element={u} />
                        ))}
                      </span>
                    ) : (
                      <span className="an-sub">なし</span>
                    )}
                  </td>
                  <td>{row.noInformation && <span className="an-flag">扱う情報なし</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {data.systemsWithoutScreens.length > 0 && (
        <p className="hint an-no-screens">
          画面の無いシステム:{" "}
          {data.systemsWithoutScreens.map((sys, i) => (
            <span key={sys.id}>
              {i > 0 && "、"}
              <El element={sys} plain />
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

/** システムごとの、そのシステムから発生するイベントの一覧。直接か、操作からかを分けて出す */
function SystemEventView({ model }: { model: UntieModel }) {
  const data = useMemo(() => systemEventLists(model), [model]);
  if (data.lists.length === 0 && data.eventsWithoutSystem.length === 0) return null;
  return (
    <section className="an-screens" aria-label="システムのイベント">
      <h3 className="an-subtitle">システムのイベント</h3>
      {data.lists.length === 0 && <p className="hint">システムから発生するイベントがまだありません。</p>}
      {data.lists.map((l) => (
        <div key={l.system.id} className="an-screen-table" data-testid={`event-list-${l.system.id}`}>
          <h4 className="an-block-title">
            <El element={l.system} />
          </h4>
          <table className="an-table an-event-table">
            <thead>
              <tr>
                <th>イベント</th>
                <th scope="col">発生のしかた</th>
                <th scope="col">きっかけにする操作</th>
              </tr>
            </thead>
            <tbody>
              {l.rows.map((row) => (
                <tr key={row.event.id}>
                  <th scope="row">
                    <El element={row.event} />
                  </th>
                  <td>
                    <span className="an-list">
                      {row.direct && <span className="an-role role-direct">直接</span>}
                      {row.usecases.length > 0 && (
                        <span className="an-via">
                          <span className="an-role role-usecase">操作から</span>
                          {row.usecases.map((u) => (
                            <El key={u.id} element={u} />
                          ))}
                        </span>
                      )}
                    </span>
                  </td>
                  <td>
                    {row.triggers.length > 0 ? (
                      <span className="an-list">
                        {row.triggers.map((t) => (
                          <span key={t.usecase.id} className="an-trigger">
                            <El element={t.usecase} />
                            {t.activities.length > 0 ? (
                              <span className="an-sub">
                                (
                                {t.activities.map((a, i) => (
                                  <span key={a.id}>
                                    {i > 0 && "、"}
                                    <El element={a} plain />
                                  </span>
                                ))}
                                )
                              </span>
                            ) : (
                              <span className="an-sub">(作業なし)</span>
                            )}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="an-sub">なし</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {data.systemsWithoutEvents.length > 0 && (
        <p className="hint an-no-screens">
          イベントの無いシステム:{" "}
          {data.systemsWithoutEvents.map((sys, i) => (
            <span key={sys.id}>
              {i > 0 && "、"}
              <El element={sys} plain />
            </span>
          ))}
        </p>
      )}
      {data.eventsWithoutSystem.length > 0 && (
        <p className="hint an-no-screens" data-testid="events-without-system">
          システムにつながらないイベント:{" "}
          {data.eventsWithoutSystem.map((ev, i) => (
            <span key={ev.id}>
              {i > 0 && "、"}
              <El element={ev} plain />
            </span>
          ))}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 3. 課題の分布

function IssuesView({ model }: { model: UntieModel }) {
  const data = useMemo(() => issueDistribution(model), [model]);
  const sections = useMemo(() => issueBoardSections(model), [model]);
  const overall = sections.find((s) => s.scope === "overall")!;
  const unsorted = sections.find((s) => s.scope === "unsorted")!.groups[0]?.issues ?? [];
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
      <h3 className="an-subtitle">未整理の課題 (対象なし)</h3>
      {unsorted.length === 0 ? (
        <p className="hint">対象のない課題はありません。</p>
      ) : (
        <table className="an-table">
          <thead>
            <tr>
              <th>課題 (重要度の高い順)</th>
            </tr>
          </thead>
          <tbody>
            {unsorted.map((i) => (
              <tr key={i.id}>
                <td>
                  <span className={`sev-chip sev-${i.severity}`} aria-label={`重要度 ${i.severity}`}>
                    {i.severity}
                  </span>{" "}
                  <El element={i} plain />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
