import { useState } from "react";
import { cachedContextMap } from "@untie/core/model/domainCache";
import { addContextRelation, removeContextRelation, updateContextRelation } from "@untie/core/model/domainCommands";
import {
  CONTEXT_RELATION_KINDS,
  CONTEXT_RELATION_LABELS,
  INTEGRATIONS,
  INTEGRATION_LABELS,
  SUBDOMAIN_LABELS,
  type ContextRelationKind,
  type Integration,
} from "@untie/core/model/domain";
import type { ContextFlow } from "@untie/core/model/domainMap";
import { DESCRIPTION_MAX_LENGTH } from "@untie/core/model/limits";
import type { BoundedContext, ContextRelation } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { CommitField } from "../CommitField";
import { revealDomainSelection, useDomainEdit } from "./domainElementClick";

type Edit = ReturnType<typeof useDomainEdit>;

const nameOf = (c: BoundedContext | undefined) => c?.name || "(名前なし)";

/** 関係の種類の選択。未決の行では、選ぶと関係を足す */
function KindSelect({ label, value, disabled, onChange }: { label: string; value: ContextRelationKind | ""; disabled: boolean; onChange: (kind: ContextRelationKind) => void }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => e.target.value && onChange(e.target.value as ContextRelationKind)}>
      {value === "" && <option value="">(種類を選ぶ)</option>}
      {CONTEXT_RELATION_KINDS.map((k) => (
        <option key={k} value={k}>
          {CONTEXT_RELATION_LABELS[k]}
        </option>
      ))}
    </select>
  );
}

/** 保存した関係の、統合の方式・補足・削除 */
function RelationCells({ relation, pair, edit }: { relation: ContextRelation; pair: string; edit: Edit }) {
  return (
    <>
      <td>
        <select
          aria-label={`${pair} の統合の方式`}
          value={relation.integration ?? ""}
          disabled={edit.readOnly}
          onChange={(e) => edit.run((m) => updateContextRelation(m, { id: relation.id, patch: { integration: e.target.value === "" ? null : (e.target.value as Integration) } }))}
        >
          <option value="">(未定)</option>
          {INTEGRATIONS.map((i) => (
            <option key={i} value={i}>
              {INTEGRATION_LABELS[i]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <CommitField label={`${pair} の補足`} value={relation.note ?? ""} multiline maxLength={DESCRIPTION_MAX_LENGTH} readOnly={edit.readOnly} onCommit={(v) => v.trim() !== (relation.note ?? "") && edit.run((m) => updateContextRelation(m, { id: relation.id, patch: { note: v } }))} />
      </td>
      <td>
        {!edit.readOnly && (
          <button type="button" className="icon-button" aria-label={`${pair} の関係を消す`} title="関係を消す (導いたつながりは、未決として残ります)" onClick={() => edit.run((m) => removeContextRelation(m, { id: relation.id }))}>
            ×
          </button>
        )}
      </td>
    </>
  );
}

function Evidence({ flow }: { flow: ContextFlow }) {
  return (
    <>
      {flow.events.length > 0 && <div>イベント: {flow.events.join("・")}</div>}
      {flow.reads.length > 0 && <div>取得: {flow.reads.join("・")}</div>}
    </>
  );
}

/**
 * 設計モードのコンテキストマップ: 保存した境界づけられたコンテキスト (すべてのシステムの分) と、そのあいだの関係を表で見せて決める。
 * つながり (イベントがきっかけになる・情報を取得する) は分析と保存した判断から導き、関係の種類と統合の方式は人が決めて保存する
 */
export function ContextMapBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const edit = useDomainEdit();
  const map = cachedContextMap(model);
  const byId = new Map(map.contexts.map((c) => [c.id, c]));
  const systemName = (id: string) => model.elements.find((e) => e.id === id)?.name || "(名前なし)";
  const [upstreamId, setUpstreamId] = useState("");
  const [downstreamId, setDownstreamId] = useState("");
  const [kind, setKind] = useState<ContextRelationKind>("customerSupplier");
  const aggregateCount = (id: string) => model.domain.aggregates.filter((a) => a.boundedContextId === id).length;
  const open = (c: BoundedContext) => revealDomainSelection({ kind: "context", id: c.id }, c.systemIds.includes(systemId ?? "") ? undefined : c.systemIds[0]);
  const add = () => {
    if (edit.run((m) => addContextRelation(m, { upstreamId, downstreamId, kind }))) {
      setUpstreamId("");
      setDownstreamId("");
    }
  };
  return (
    <section className="domain-board contextmap-board" aria-label="設計ボード: コンテキストマップ">
      <div className="dsl-toolbar domain-toolbar">
        <h2 className="dsl-title">コンテキストマップ</h2>
      </div>
      <p className="hint domain-hint">境界づけられたコンテキスト (すべてのシステムの分) と、そのあいだの関係です。つながりは分析から導き、関係の種類と統合の方式はここで決めて保存します</p>
      <div className="domain-scroll">
        {map.contexts.length === 0 ? (
          <p className="hint domain-empty">境界づけられたコンテキストがまだありません。ドメインボードで「候補から作る」か「＋コンテキスト」で作ると、ここに出ます</p>
        ) : (
          <>
            <h3 className="contextmap-title">境界づけられたコンテキスト</h3>
            <table className="an-table" aria-label="境界づけられたコンテキスト">
              <thead>
                <tr>
                  <th>名前</th>
                  <th>英語名</th>
                  <th>分類</th>
                  <th>チーム</th>
                  <th>実装するシステム</th>
                  <th>集約</th>
                </tr>
              </thead>
              <tbody>
                {map.contexts.map((c) => (
                  <tr key={c.id} data-testid={`contextmap-context-${c.id}`}>
                    <th scope="row">
                      <button type="button" className="link" onClick={() => open(c)} title="ドメインボードで、このコンテキストを選ぶ">
                        {nameOf(c)}
                      </button>
                    </th>
                    <td>{c.english ?? <span className="an-empty">—</span>}</td>
                    <td>{c.subdomain ? SUBDOMAIN_LABELS[c.subdomain] : <span className="an-empty">— (未定)</span>}</td>
                    <td>{c.team ?? <span className="an-empty">—</span>}</td>
                    <td>{c.systemIds.length > 0 ? c.systemIds.map(systemName).join("・") : <span className="an-note level-question">未割り当て</span>}</td>
                    <td>{aggregateCount(c.id) > 0 ? aggregateCount(c.id) : <span className="an-sub">なし (外部)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3 className="contextmap-title">関係</h3>
            {map.flows.length + map.relationsWithoutFlow.length === 0 ? (
              <p className="hint">コンテキストのあいだのつながりも、保存した関係もありません。</p>
            ) : (
              <table className="an-table contextmap-relations" aria-label="コンテキストの関係">
                <thead>
                  <tr>
                    <th>上流 → 下流</th>
                    <th>根拠 (導いたつながり)</th>
                    <th>関係の種類</th>
                    <th>統合の方式</th>
                    <th>補足</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {map.flows.map((f) => {
                    const pair = `${nameOf(byId.get(f.upstreamId))} → ${nameOf(byId.get(f.downstreamId))}`;
                    const relation = f.relation;
                    const reverse = f.reverseRelation;
                    // 逆向きに関係があり、その向きのつながりは無い (保存した向きが、導いた向きと合っていない)
                    const mismatched = !!reverse && !map.flows.some((x) => x.upstreamId === f.downstreamId && x.downstreamId === f.upstreamId);
                    return (
                      <tr key={`${f.upstreamId}:${f.downstreamId}`} data-testid={`contextmap-flow-${f.upstreamId}-${f.downstreamId}`} className={relation || reverse ? undefined : "is-undecided"}>
                        <th scope="row">{pair}</th>
                        <td>
                          <Evidence flow={f} />
                        </td>
                        <td>
                          {!relation && reverse && (
                            <div className="an-sub">
                              逆向きに「{CONTEXT_RELATION_LABELS[reverse.kind]}」があります
                              {mismatched && !edit.readOnly && (
                                <button type="button" className="link" title="保存した関係の上流と下流を入れ替えて、このつながりの向きに合わせる" onClick={() => edit.run((m) => updateContextRelation(m, { id: reverse.id, patch: { upstreamId: reverse.downstreamId, downstreamId: reverse.upstreamId } }))}>
                                  向きを合わせる
                                </button>
                              )}
                            </div>
                          )}
                          <KindSelect
                            label={`${pair} の関係の種類`}
                            value={relation?.kind ?? ""}
                            disabled={edit.readOnly}
                            onChange={(k) =>
                              relation ? edit.run((m) => updateContextRelation(m, { id: relation.id, patch: { kind: k } })) : edit.run((m) => addContextRelation(m, { upstreamId: f.upstreamId, downstreamId: f.downstreamId, kind: k }))
                            }
                          />
                        </td>
                        {relation ? (
                          <RelationCells relation={relation} pair={pair} edit={edit} />
                        ) : (
                          <td colSpan={3}>
                            <span className="an-sub">{reverse ? "この向きの関係も決めるなら、種類を選びます" : "関係の種類を選ぶと保存します"}</span>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {map.relationsWithoutFlow.map((r) => {
                    const pair = `${nameOf(byId.get(r.upstreamId))} → ${nameOf(byId.get(r.downstreamId))}`;
                    return (
                      <tr key={r.id} data-testid={`contextmap-relation-${r.id}`}>
                        <th scope="row">{pair}</th>
                        <td>
                          <span className="an-sub">導いたつながりはありません (人が決めた関係)</span>
                        </td>
                        <td>
                          <KindSelect label={`${pair} の関係の種類`} value={r.kind} disabled={edit.readOnly} onChange={(k) => edit.run((m) => updateContextRelation(m, { id: r.id, patch: { kind: k } }))} />
                        </td>
                        <RelationCells relation={r} pair={pair} edit={edit} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {!edit.readOnly && map.contexts.length > 1 && (
              <div className="contextmap-add" role="group" aria-label="関係を足す">
                <span className="field-label">関係を足す</span>
                <select aria-label="上流のコンテキスト" value={upstreamId} onChange={(e) => setUpstreamId(e.target.value)}>
                  <option value="">(上流)</option>
                  {map.contexts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {nameOf(c)}
                    </option>
                  ))}
                </select>
                <span aria-hidden="true">→</span>
                <select aria-label="下流のコンテキスト" value={downstreamId} onChange={(e) => setDownstreamId(e.target.value)}>
                  <option value="">(下流)</option>
                  {map.contexts
                    .filter((c) => c.id !== upstreamId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {nameOf(c)}
                      </option>
                    ))}
                </select>
                <select aria-label="足す関係の種類" value={kind} onChange={(e) => setKind(e.target.value as ContextRelationKind)}>
                  {CONTEXT_RELATION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {CONTEXT_RELATION_LABELS[k]}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={upstreamId === "" || downstreamId === ""} onClick={add}>
                  足す
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

const KIND_HINTS: Record<ContextRelationKind, string> = {
  partnership: "両方のチームが一緒に成功するか失敗するかで、計画を合わせて進める (対等)",
  sharedKernel: "モデルの一部を共有する。変えるときは両方の合意が要る (対等)",
  customerSupplier: "下流 (顧客) の要望を、上流 (供給者) が計画に入れる",
  conformist: "下流が、上流のモデルにそのまま従う (上流は下流に合わせない)",
  acl: "下流が、上流のモデルを自分の言葉に訳す層を置いて、自分のモデルを守る",
  ohs: "上流が、多くの下流のために決まった窓口 (プロトコル) を公開する",
  publishedLanguage: "やり取りに、文書にした共通の言語 (形式) を使う",
  separateWays: "つながずに、それぞれが自分で済ませる (対等)",
  bigBallOfMud: "境界のはっきりしない大きな塊。中のモデルを外へ広げない",
};

/** 右のペイン (コンテキストマップ): 関係の種類の説明 */
export function ContextMapLegend() {
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">関係の種類</h2>
      <div className="editor">
        <p className="hint">上流は、下流に影響を与える側 (イベントを発生させる・情報を持つ) です。つながりの向きは分析から導きますが、どう付き合うか (種類) は、チームの力関係や方針で決まるので、人が決めます</p>
        <dl className="contextmap-legend">
          {CONTEXT_RELATION_KINDS.map((k) => (
            <div key={k}>
              <dt>{CONTEXT_RELATION_LABELS[k]}</dt>
              <dd>{KIND_HINTS[k]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </aside>
  );
}
