import { useState, type ReactNode } from "react";
import { adoptAggregateCandidate, adoptCommandCandidate, adoptEventCandidate, addPolicyBetween, splitCommandByActivity } from "@untie/core/model/domainAdopt";
import { cachedResolvedDomain } from "@untie/core/model/domainCache";
import {
  addAggregate,
  addBoundedContext,
  addDomainCommand,
  addDomainEvent,
  excludeInformation,
  includeInformation,
  removeAggregate,
  removeBoundedContext,
  removeDomainCommand,
  removeDomainEvent,
  removeDomainPolicy,
  setCandidateExcluded,
  updateAggregate,
  updateBoundedContext,
  updateDomainCommand,
  updateDomainEvent,
  updateDomainPolicy,
} from "@untie/core/model/domainCommands";
import { SUBDOMAIN_LABELS, SUBDOMAINS, type Subdomain } from "@untie/core/model/domain";
import { AGGREGATE_ROLE_LABELS } from "@untie/core/model/domainModel";
import { adoptDomainCandidates, candidateCommandKey, normalizeDomainSelection, type ResolvedAggregate, type ResolvedCommand, type ResolvedContext, type ResolvedDomain, type ResolvedEvent } from "@untie/core/model/domainResolve";
import { noticesAbout } from "@untie/core/model/domainScope";
import { DESCRIPTION_MAX_LENGTH, ENGLISH_MAX_LENGTH, NAME_MAX_LENGTH } from "@untie/core/model/limits";
import { describeEventTiming, type Element, type UntieModel } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { El, ElementClickContext } from "../analysis/analysisParts";
import { NoticeList } from "../analysis/StormingView";
import { CommitField } from "../CommitField";
import { ConfirmDialog } from "../ConfirmDialog";
import { revealLabel, useDomainEdit, useDomainElementClick } from "./domainElementClick";

type Edit = ReturnType<typeof useDomainEdit>;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="static-value">{children}</div>
    </div>
  );
}

/** 編集できる 1 行の項目 (閲覧専用なら読むだけ)。見出しは CommitField が出す */
function TextField({ label, value, onCommit, readOnly, multiline, maxLength = NAME_MAX_LENGTH, placeholder }: { label: string; value: string; onCommit: (v: string) => void; readOnly: boolean; multiline?: boolean; maxLength?: number; placeholder?: string }) {
  return <CommitField label={label} value={value} onCommit={onCommit} readOnly={readOnly} multiline={multiline} maxLength={maxLength} placeholder={placeholder} />;
}

function Els({ elements, empty = "なし" }: { elements: (Element | null | undefined)[]; empty?: string }) {
  const list = elements.filter((e): e is Element => !!e);
  if (list.length === 0) return <span className="hint-inline">{empty}</span>;
  return (
    <span className="an-list">
      {list.map((e) => (
        <El key={e.id} element={e} />
      ))}
    </span>
  );
}

/** 分析のその要素の固定ボードへ移る (設計モードを出る) */
function RevealButton({ element }: { element: Element }) {
  return (
    <button type="button" className="link" onClick={() => revealOnFixedBoard(element.id)}>
      {revealLabel(element)} ↗
    </button>
  );
}

function Notices({ r, ids, get }: { r: ResolvedDomain; ids: string[]; get: (id: string) => Element | undefined }) {
  const notices = [...new Set(ids.flatMap((id) => noticesAbout(r.scope, id)))];
  if (notices.length === 0) return null;
  return <NoticeList notices={notices} get={get} />;
}

/** ボードの中のもの (コマンド・イベント・集約) を選ぶリンク */
function Pick({ kind, id, label }: { kind: "command" | "event" | "aggregate" | "context"; id: string | null; label: string }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  return (
    <button type="button" className="chip-link" onClick={() => select({ kind, id } as never)}>
      {label || "(名前なし)"}
    </button>
  );
}

/** 1 行の入力と「足す」ボタン */
function AddLine({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (text: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (text.trim() === "") return;
    onAdd(text.trim());
    setText("");
  };
  return (
    <div className="domain-add-line">
      <input type="text" aria-label={label} placeholder={placeholder} value={text} maxLength={NAME_MAX_LENGTH} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && submit()} />
      <button type="button" disabled={text.trim() === ""} onClick={submit}>
        足す
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- コンテキスト

function ContextDetail({ r, ctx, model, systemId, edit, get }: { r: ResolvedDomain; ctx: ResolvedContext; model: UntieModel; systemId: string; edit: Edit; get: (id: string) => Element | undefined }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  const [confirm, setConfirm] = useState(false);
  const bc = ctx.saved;
  const analysisContexts = ctx.candidates.map((c) => c.context).filter((c): c is NonNullable<typeof c> => !!c);
  const systemName = get(systemId)?.name || "このシステム";
  if (!bc) {
    const adopt = () => {
      if (ctx.key === null) return;
      // 集約は足さず、コンテキストだけを保存する (集約は 1 つずつ採用するか、「候補から作る」でまとめて作る)
      const contextId = ctx.key;
      const added = edit.run((m) => addBoundedContext(m, { name: ctx.name, contextIds: [contextId], systemIds: [systemId] }));
      if (added) select({ kind: "context", id: added.id });
    };
    return (
      <div className="editor" data-testid="domain-context">
        <div className="kind-line">コンテキスト (候補){ctx.role === "upstream" ? " ・ 読むだけ (上流)" : ""}</div>
        <Field label="名前">{ctx.name}</Field>
        <Field label="集約の候補 (このシステムが扱う情報)">
          <Els elements={ctx.aggregates.map((a) => a.root)} />
        </Field>
        <Field label="状態グループ">{ctx.candidates.flatMap((c) => c.stateGroups).join("・") || "なし"}</Field>
        <Field label={`関わる業務 (${systemName}の操作がこのコンテキストの情報を扱う作業)`}>
          <Els elements={ctx.candidates.flatMap((c) => c.businesses)} />
        </Field>
        {!edit.readOnly && ctx.key !== null && (
          <button type="button" onClick={adopt} title="分析のコンテキストを言語の範囲にした、境界づけられたコンテキストとして保存する (実装先はこのシステム)">
            境界づけられたコンテキストとして保存する
          </button>
        )}
        {analysisContexts[0] && <RevealButton element={analysisContexts[0]} />}
        <Notices r={r} ids={analysisContexts.map((c) => c.id)} get={get} />
      </div>
    );
  }
  const patch = (p: Parameters<typeof updateBoundedContext>[1]["patch"]) => edit.run((m) => updateBoundedContext(m, { id: bc.id, patch: p }));
  const toggle = (key: "contextIds" | "systemIds", id: string) => patch({ [key]: bc[key].includes(id) ? bc[key].filter((x) => x !== id) : [...bc[key], id] });
  const freeInfos = r.aggregates.filter((a) => !a.saved && a.contextKey === ctx.key);
  const owned = model.domain.aggregates.filter((a) => a.boundedContextId === bc.id);
  return (
    <div className="editor" data-testid="domain-context">
      <div className="kind-line">境界づけられたコンテキスト{ctx.unassigned ? " ・ 未割り当て" : ""}</div>
      <TextField label="名前" value={bc.name} readOnly={edit.readOnly} onCommit={(v) => patch({ name: v })} />
      <TextField label="英語名 (コードでの名前)" value={bc.english ?? ""} readOnly={edit.readOnly} maxLength={ENGLISH_MAX_LENGTH} placeholder="例: Ordering" onCommit={(v) => patch({ english: v })} />
      <TextField label="説明 (責務)" value={bc.description ?? ""} readOnly={edit.readOnly} multiline maxLength={DESCRIPTION_MAX_LENGTH} onCommit={(v) => patch({ description: v })} />
      <div className="field">
        <span className="field-label">サブドメインの分類</span>
        <select aria-label="サブドメインの分類" value={bc.subdomain ?? ""} disabled={edit.readOnly} onChange={(e) => patch({ subdomain: e.target.value === "" ? null : (e.target.value as Subdomain) })}>
          <option value="">(未定)</option>
          {SUBDOMAINS.map((s) => (
            <option key={s} value={s}>
              {SUBDOMAIN_LABELS[s]}
            </option>
          ))}
        </select>
      </div>
      <TextField label="所有するチーム" value={bc.team ?? ""} readOnly={edit.readOnly} onCommit={(v) => patch({ team: v })} />
      <fieldset className="plain-fieldset" disabled={edit.readOnly}>
        <legend className="field-label">言語の範囲 (分析のコンテキスト)</legend>
        {model.elements
          .filter((e) => e.kind === "context")
          .map((c) => (
            <label key={c.id} className="check-row">
              <input type="checkbox" checked={bc.contextIds.includes(c.id)} onChange={() => toggle("contextIds", c.id)} />
              {c.name || "(名前なし)"}
            </label>
          ))}
      </fieldset>
      <fieldset className="plain-fieldset" disabled={edit.readOnly}>
        <legend className="field-label">実装するシステム</legend>
        {model.elements
          .filter((e) => e.kind === "system")
          .map((s) => (
            <label key={s.id} className="check-row">
              <input type="checkbox" checked={bc.systemIds.includes(s.id)} onChange={() => toggle("systemIds", s.id)} />
              {s.name || "(名前なし)"}
            </label>
          ))}
      </fieldset>
      <Field label="集約">
        {owned.length === 0 ? (
          <span className="hint-inline">なし (集約を持たなければ、中身の無い外部のコンテキスト)</span>
        ) : (
          <span className="an-list">
            {owned.map((a) => (
              <Pick key={a.id} kind="aggregate" id={a.id} label={a.name} />
            ))}
          </span>
        )}
      </Field>
      {freeInfos.length > 0 && (
        <Field label="まだ集約にしていない情報 (候補)">
          <span className="an-list">
            {freeInfos.map((a) => (
              <Pick key={a.key} kind="aggregate" id={a.key} label={a.name} />
            ))}
          </span>
        </Field>
      )}
      {!edit.readOnly && (
        <>
          <div className="field">
            <span className="field-label">情報から集約を足す</span>
            <select
              aria-label="情報から集約を足す"
              value=""
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const added = edit.run((m) => addAggregate(m, { boundedContextId: bc.id, rootInformationId: id }));
                if (added) select({ kind: "aggregate", id: added.id });
              }}
            >
              <option value="">(ルートにする情報を選ぶ)</option>
              {model.elements
                .filter((e) => e.kind === "information" && !owned.some((a) => a.rootInformationId === e.id || a.memberInformationIds.includes(e.id)))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name || "(名前なし)"}
                  </option>
                ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">あるべき姿のイベントを足す (このコンテキストが発生させる)</span>
            <AddLine
              label="あるべき姿のイベントの名前"
              placeholder="例: 入金が確認された"
              onAdd={(name) => {
                const added = edit.run((m) => addDomainEvent(m, { boundedContextId: bc.id, name }));
                if (added) select({ kind: "event", id: added.id });
              }}
            />
          </div>
          <button type="button" className="danger" onClick={() => (owned.length > 0 ? setConfirm(true) : edit.run((m) => removeBoundedContext(m, { id: bc.id })))}>
            コンテキストを消す
          </button>
        </>
      )}
      {analysisContexts.map((c) => (
        <RevealButton key={c.id} element={c} />
      ))}
      <Notices r={r} ids={analysisContexts.map((c) => c.id)} get={get} />
      {confirm && (
        <ConfirmDialog
          title="削除の確認"
          message={`コンテキスト「${bc.name}」を消すと、次のものも一緒に消えます。`}
          details={[`集約 ${owned.length} (コマンド・ポリシーも)`, "このコンテキストのイベントと、ほかのコンテキストとの関係"]}
          confirmLabel="削除する"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            edit.run((m) => removeBoundedContext(m, { id: bc.id }));
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 集約

function AggregateDetail({ r, a, model, systemId, edit, get }: { r: ResolvedDomain; a: ResolvedAggregate; model: UntieModel; systemId: string; edit: Edit; get: (id: string) => Element | undefined }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  const [confirm, setConfirm] = useState(false);
  const saved = a.saved;
  const savedContexts = model.domain.contexts;
  const commands = r.commands.filter((c) => c.aggregateKey === a.key);
  const events = r.events.filter((e) => e.aggregateKey === a.key);
  const elsewhere = a.scoped.flatMap((s) => s.commandsElsewhere);
  const stores = [...new Map(a.scoped.flatMap((s) => s.stores).map((s) => [s.id, s])).values()];
  const related = [...new Map(a.scoped.flatMap((s) => [...s.candidate.related, ...s.candidate.coWritten]).map((i) => [i.id, i])).values()].filter((i) => i.id !== a.root.id && !a.members.some((m) => m.id === i.id));
  const facts = (
    <>
      <Field label="区分">
        {!a.writtenHere ? "参照 (このシステムでは書かない)" : !a.saved ? AGGREGATE_ROLE_LABELS[a.role] : a.role === "lifecycle" ? "状態を持つ (このシステムで書く)" : "このシステムで書く"}
        {a.otherWriterSystems.length > 0 && (
          <span className="an-sub">
            {a.writtenHere ? "ほかのシステムでも書く" : "書くシステム"}: {a.otherWriterSystems.map((s) => s.name).join("・")}
          </span>
        )}
      </Field>
      <Field label="コマンド">
        {commands.length === 0 ? (
          <span className="hint-inline">なし</span>
        ) : (
          <span className="an-list">
            {commands.map((c) => (
              <Pick key={c.key} kind="command" id={c.key} label={c.name} />
            ))}
          </span>
        )}
      </Field>
      <Field label="発生させるイベント">
        {events.length === 0 ? (
          <span className="hint-inline">なし</span>
        ) : (
          <span className="an-list">
            {events.map((e) => (
              <Pick key={e.key} kind="event" id={e.key} label={e.name} />
            ))}
          </span>
        )}
      </Field>
      <Field label="ほかのところで書く操作">
        {elsewhere.length === 0 ? (
          <span className="hint-inline">なし</span>
        ) : (
          <ul className="plain-list">
            {elsewhere.map((c) => (
              <li key={c.key}>
                <El element={c.usecase} />
                <span className="an-sub">対象: {c.place?.name ?? "なし"}</span>
              </li>
            ))}
          </ul>
        )}
      </Field>
      <Field label="保存先">
        <Els elements={stores} />
      </Field>
    </>
  );
  if (!saved) {
    const ctx = r.contexts.find((c) => c.key === a.contextKey);
    const adopt = (boundedContextId?: string) => {
      const added = edit.run((m) => adoptAggregateCandidate(m, { systemId, key: a.key, ...(boundedContextId ? { boundedContextId } : {}) }));
      if (added) select({ kind: "aggregate", id: added.id });
    };
    return (
      <div className="editor" data-testid="domain-aggregate">
        <div className="kind-line">集約 (候補)</div>
        <Field label="ルートの情報">
          <El element={a.root} />
        </Field>
        <Field label="コンテキスト">
          {ctx?.name ?? "未分類"}
          {ctx && !ctx.saved ? " (候補)" : ""}
        </Field>
        <Field label="状態グループ">{a.stateGroups.length > 0 ? `${a.stateGroups.join("・")}: ${a.states.map((s) => s.name).join(" → ")}` : "なし"}</Field>
        {facts}
        <Field label="関連する情報・一緒に書かれる情報">
          <Els elements={related} />
        </Field>
        {!edit.readOnly && (
          <>
            {a.contextKey !== null && (
              <button type="button" onClick={() => adopt()} title="この情報をルートにした集約として保存する (コンテキストがまだ候補なら、一緒に保存する)">
                集約として保存する
              </button>
            )}
            {savedContexts.length > 0 && (
              <div className="field">
                <span className="field-label">コンテキストを選んで保存する</span>
                <select aria-label="コンテキストを選んで保存する" value="" onChange={(e) => e.target.value && adopt(e.target.value)}>
                  <option value="">(境界づけられたコンテキストを選ぶ)</option>
                  {savedContexts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {r.aggregates.some((x) => x.saved && x.contextKey === a.contextKey) && (
              <div className="field">
                <span className="field-label">ほかの集約の中に入れる</span>
                <select
                  aria-label="ほかの集約の中に入れる"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id && edit.run((m) => includeInformation(m, { aggregateId: id, informationId: a.root.id }))) select({ kind: "aggregate", id });
                  }}
                >
                  <option value="">(集約を選ぶ)</option>
                  {r.aggregates
                    .filter((x) => x.saved && x.contextKey === a.contextKey)
                    .map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </>
        )}
        <RevealButton element={a.root} />
        <Notices r={r} ids={[a.root.id]} get={get} />
      </div>
    );
  }
  const patch = (p: Parameters<typeof updateAggregate>[1]["patch"]) => edit.run((m) => updateAggregate(m, { id: saved.id, patch: p }));
  const groups = [...new Set(model.elements.flatMap((e) => (e.kind === "state" && e.group ? [e.group] : [])))];
  const conditions = [...new Map(commands.flatMap((c) => c.candidate?.conditions ?? []).map((c) => [c.id, c])).values()].filter((c) => !saved.invariants.some((i) => i.conditionId === c.id));
  const setInvariants = (next: { id?: string; text: string; conditionId?: string }[]) => patch({ invariants: next });
  return (
    <div className="editor" data-testid="domain-aggregate">
      <div className="kind-line">集約</div>
      <TextField label="名前" value={saved.name} readOnly={edit.readOnly} onCommit={(v) => patch({ name: v })} />
      <TextField label="英語名 (コードでの名前)" value={saved.english ?? ""} readOnly={edit.readOnly} maxLength={ENGLISH_MAX_LENGTH} placeholder="例: Order" onCommit={(v) => patch({ english: v })} />
      <div className="field">
        <span className="field-label">コンテキスト</span>
        <select aria-label="コンテキスト" value={saved.boundedContextId} disabled={edit.readOnly} onChange={(e) => patch({ boundedContextId: e.target.value })}>
          {savedContexts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <Field label="ルートの情報">
        <El element={a.root} />
      </Field>
      <div className="field">
        <span className="field-label">中の情報 (同じトランザクションで整合させるもの。ほかの関連は ID で参照する)</span>
        {a.members.length === 0 ? (
          <span className="hint-inline">なし</span>
        ) : (
          <ul className="plain-list">
            {a.members.map((m) => (
              <li key={m.id} className="domain-item-row">
                <El element={m} />
                {!edit.readOnly && (
                  <button type="button" className="icon-button" aria-label={`${m.name} を中の情報から外す`} title="中の情報から外す" onClick={() => edit.run((x) => excludeInformation(x, { aggregateId: saved.id, informationId: m.id }))}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!edit.readOnly && (
          <select aria-label="中の情報に足す" value="" onChange={(e) => e.target.value && edit.run((m) => includeInformation(m, { aggregateId: saved.id, informationId: e.target.value }))}>
            <option value="">(中に入れる情報を選ぶ)</option>
            {related.length > 0 && (
              <optgroup label="関連する情報・一緒に書かれる情報">
                {related.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="そのほかの情報">
              {model.elements
                .filter((e) => e.kind === "information" && e.id !== a.root.id && !a.members.some((m) => m.id === e.id) && !related.some((x) => x.id === e.id))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name || "(名前なし)"}
                  </option>
                ))}
            </optgroup>
          </select>
        )}
      </div>
      <div className="field">
        <span className="field-label">状態グループ (ライフサイクル)</span>
        <select aria-label="状態グループ" value={saved.stateGroup ?? ""} disabled={edit.readOnly} onChange={(e) => patch({ stateGroup: e.target.value })}>
          <option value="">(なし)</option>
          {groups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        {a.states.length > 0 && <span className="an-sub">{a.states.map((s) => s.name).join(" → ")}</span>}
      </div>
      <div className="field">
        <span className="field-label">不変条件 (集約の境界の中で、常に守るルール)</span>
        {saved.invariants.length === 0 && <span className="hint-inline">なし</span>}
        {saved.invariants.map((inv, i) => (
          <div key={inv.id} className="domain-item-row" data-invariant={inv.id}>
            <CommitField
              label={`不変条件 ${i + 1}`}
              value={inv.text}
              multiline
              maxLength={DESCRIPTION_MAX_LENGTH}
              readOnly={edit.readOnly}
              onCommit={(v) => (v.trim() === "" ? setInvariants(saved.invariants.filter((x) => x.id !== inv.id)) : setInvariants(saved.invariants.map((x) => (x.id === inv.id ? { ...x, text: v } : x))))}
            />
            {!edit.readOnly && (
              <button type="button" className="icon-button" aria-label={`不変条件 ${i + 1} を消す`} title="消す" onClick={() => setInvariants(saved.invariants.filter((x) => x.id !== inv.id))}>
                ×
              </button>
            )}
          </div>
        ))}
        {!edit.readOnly && (
          <>
            <AddLine label="不変条件を足す" placeholder="例: 引き当てる数は、棚にある数を超えない" onAdd={(text) => setInvariants([...saved.invariants, { text }])} />
            {conditions.length > 0 && (
              <select
                aria-label="分析の条件から不変条件を足す"
                value=""
                onChange={(e) => {
                  const c = conditions.find((x) => x.id === e.target.value);
                  if (c) setInvariants([...saved.invariants, { text: c.description?.trim() || c.name, conditionId: c.id }]);
                }}
              >
                <option value="">(分析の条件から足す)</option>
                {conditions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      {facts}
      {!edit.readOnly && (
        <>
          <div className="field">
            <span className="field-label">あるべき姿のコマンドを足す (分析に無いもの)</span>
            <AddLine
              label="あるべき姿のコマンドの名前"
              placeholder="例: 注文を入金済にする"
              onAdd={(name) => {
                const added = edit.run((m) => addDomainCommand(m, { aggregateId: saved.id, name }));
                if (added) select({ kind: "command", id: added.id });
              }}
            />
          </div>
          <div className="field">
            <span className="field-label">あるべき姿のイベントを足す</span>
            <AddLine
              label="あるべき姿のイベントの名前"
              placeholder="例: 在庫が足りなかった"
              onAdd={(name) => {
                const added = edit.run((m) => addDomainEvent(m, { aggregateId: saved.id, name }));
                if (added) select({ kind: "event", id: added.id });
              }}
            />
          </div>
          <button type="button" className="danger" onClick={() => setConfirm(true)}>
            集約を消す
          </button>
        </>
      )}
      <RevealButton element={a.root} />
      <Notices r={r} ids={[a.root.id, ...a.members.map((m) => m.id)]} get={get} />
      {confirm && (
        <ConfirmDialog
          title="削除の確認"
          message={`集約「${saved.name}」を消すと、保存したコマンド (とポリシー) も一緒に消えます。情報は候補に戻ります。`}
          details={[`保存したコマンド ${model.domain.commands.filter((c) => c.aggregateId === saved.id).length}`, `不変条件 ${saved.invariants.length}`]}
          confirmLabel="削除する"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            // 消すと、ルートの情報は 1 情報 1 集約の候補に戻るので、そちらを選ぶ
            if (edit.run((m) => removeAggregate(m, { id: saved.id }))) select({ kind: "aggregate", id: a.root.id });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- コマンド

function CommandDetail({ r, c, model, systemId, edit, get }: { r: ResolvedDomain; c: ResolvedCommand; model: UntieModel; systemId: string; edit: Edit; get: (id: string) => Element | undefined }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  const cand = c.candidate;
  const saved = c.saved;
  const aggregate = r.aggregates.find((a) => a.key === c.aggregateKey);
  const events = c.eventKeys.map((k) => r.events.find((e) => e.key === k)).filter((e): e is ResolvedEvent => !!e);
  const triggers = r.policies.filter((p) => p.commandKey === c.key);
  const splits = cand && !cand.activity ? r.scope.splitCommands.filter((x) => x.usecase.id === cand.usecase.id).length : 1;
  /** 保存してから変える (候補なら、まず採用する) */
  const patch = (p: { name?: string; english?: string }) => {
    if (saved) return void edit.run((m) => updateDomainCommand(m, { id: saved.id, patch: p }));
    const added = edit.run((m) => adoptCommandCandidate(m, { systemId, key: c.key, patch: p }));
    if (added) select({ kind: "command", id: added.id });
  };
  const savedEvents = model.domain.events;
  return (
    <div className="editor" data-testid="domain-command">
      <div className="kind-line">
        コマンド{saved ? "" : " (候補)"}
        {!cand ? " ・ あるべき姿" : ""}
      </div>
      <TextField label="名前 (意図の名前にする。例: 「出荷を記録する」より「出荷する」)" value={c.name} readOnly={edit.readOnly} onCommit={(v) => v.trim() !== c.name && patch({ name: v })} />
      <TextField label="英語名 (コードでの名前)" value={c.english ?? ""} readOnly={edit.readOnly} maxLength={ENGLISH_MAX_LENGTH} placeholder="例: ConfirmOrder" onCommit={(v) => v.trim() !== (c.english ?? "") && patch({ english: v })} />
      {saved ? (
        <div className="field">
          <span className="field-label">集約</span>
          <select aria-label="集約" value={saved.aggregateId} disabled={edit.readOnly} onChange={(e) => edit.run((m) => updateDomainCommand(m, { id: saved.id, patch: { aggregateId: e.target.value } }))}>
            {model.domain.aggregates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <Field label="集約 (候補)">{aggregate ? <Pick kind="aggregate" id={aggregate.key} label={aggregate.name} /> : <span className="hint-inline">決まっていません</span>}</Field>
      )}
      {cand && (
        <>
          <Field label="分析の操作">
            <El element={cand.usecase} />
            {cand.readOnly && <span className="an-role role-readonly">取得だけ</span>}
          </Field>
          <Field label="誰が">
            {cand.auto ? (
              <>
                自動 <span className="an-sub">きっかけ: {cand.triggeredBy.map((e) => e.name).join("・")}</span>
              </>
            ) : (
              <Els elements={cand.actors} empty={cand.activities.length === 0 ? "(作業なし)" : "(担当なし)"} />
            )}
          </Field>
          <Field label={splits > 1 ? `使う作業 (${splits} つ。作業ごとに意図が違えば、コマンドを分ける)` : "使う作業"}>
            <Els elements={cand.activities} />
          </Field>
          <Field label="書く情報">
            <Els elements={cand.writes} />
          </Field>
          <Field label="読む情報">
            <Els elements={cand.reads} />
          </Field>
          <Field label="実行できる状態 → 次の状態">
            {cand.preStates.length + cand.postStates.length === 0 ? "なし" : `${cand.preStates.map((s) => s.name).join("・") || "—"} → ${cand.postStates.map((s) => s.name).join("・") || "—"}`}
          </Field>
          <Field label="判断に使う条件">
            <Els elements={cand.conditions} />
          </Field>
        </>
      )}
      <Field label="発生させるイベント">
        {events.length === 0 ? (
          <span className="hint-inline">なし</span>
        ) : (
          <span className="an-list">
            {events.map((e) => (
              <Pick key={e.key} kind="event" id={e.key} label={e.name} />
            ))}
          </span>
        )}
      </Field>
      {saved && !edit.readOnly && savedEvents.length > 0 && (
        <fieldset className="plain-fieldset">
          <legend className="field-label">発生させるイベントを足す・外す (保存したイベント)</legend>
          {savedEvents.map((e) => (
            <label key={e.id} className="check-row">
              <input
                type="checkbox"
                checked={saved.emits.includes(e.id)}
                onChange={() => edit.run((m) => updateDomainCommand(m, { id: saved.id, patch: { emits: saved.emits.includes(e.id) ? saved.emits.filter((x) => x !== e.id) : [...saved.emits, e.id] } }))}
              />
              {e.name}
            </label>
          ))}
        </fieldset>
      )}
      <Field label="きっかけ (ポリシー)">
        {triggers.length === 0 ? (
          <span className="hint-inline">なし</span>
        ) : (
          <span className="an-list">
            {triggers.map((p) => (
              <Pick key={p.key} kind="event" id={p.eventKey} label={r.events.find((e) => e.key === p.eventKey)?.name ?? "?"} />
            ))}
          </span>
        )}
      </Field>
      {!edit.readOnly && (
        <div className="domain-actions">
          {cand && !saved && splits > 1 && (
            <button
              type="button"
              title="作業ごとに意図が違うとき、作業ごとのコマンドに分けて保存する"
              onClick={() => {
                const added = edit.run((m) => splitCommandByActivity(m, { systemId, usecaseId: cand.usecase.id }));
                if (added?.ids[0]) select({ kind: "command", id: added.ids[0] });
              }}
            >
              作業ごとのコマンドに分ける
            </button>
          )}
          {saved && (
            <button
              type="button"
              onClick={() => {
                if (edit.run((m) => removeDomainCommand(m, { id: saved.id }))) select(cand ? { kind: "command", id: candidateCommandKey(cand) } : undefined);
              }}
              title={cand ? "保存した名前・英語名を捨てて、分析から導いた候補に戻す" : "このあるべき姿のコマンドを消す"}>
              {cand ? "保存をやめて候補に戻す" : "コマンドを消す"}
            </button>
          )}
          {c.sourceKey !== null && !saved && (
            <button type="button" onClick={() => edit.run((m) => setCandidateExcluded(m, { key: c.sourceKey!, excluded: true }))} title="現状の手順 (転記・紙への記入など) を写しただけの候補を、あるべき姿から外す (左の「外した候補」から戻せる)">
              この候補を外す
            </button>
          )}
        </div>
      )}
      {cand && <RevealButton element={cand.usecase} />}
      {cand && <Notices r={r} ids={[cand.usecase.id]} get={get} />}
    </div>
  );
}

// ---------------------------------------------------------------- イベント

function EventDetail({ r, e, model, systemId, edit, get }: { r: ResolvedDomain; e: ResolvedEvent; model: UntieModel; systemId: string; edit: Edit; get: (id: string) => Element | undefined }) {
  const select = useUntieStore((s) => s.selectDesignDomain);
  const [auto, setAuto] = useState(true);
  const saved = e.saved;
  const scoped = e.scoped;
  const ctx = r.contexts.find((c) => c.key === e.contextKey);
  const systemName = get(systemId)?.name || "このシステム";
  const emitters = r.commands.filter((c) => c.eventKeys.includes(e.key));
  const policies = r.policies.filter((p) => p.eventKey === e.key);
  // 外のイベントで、発生元のコンテキストがまだ決まっていなければ、保存する前に選ぶ
  const needsContext = !saved && e.origin === "outside" && !ctx?.saved;
  const [contextId, setContextId] = useState("");
  const adopt = (p?: { name?: string; english?: string }) => {
    const added = edit.run((m) => adoptEventCandidate(m, { systemId, key: e.key, ...(needsContext && contextId ? { boundedContextId: contextId } : {}), ...(p ? { patch: p } : {}) }));
    if (added) select({ kind: "event", id: added.id });
    return added;
  };
  const patch = (p: { name?: string; english?: string }) => {
    if (saved) return void edit.run((m) => updateDomainEvent(m, { id: saved.id, patch: p }));
    adopt(p);
  };
  const where = !scoped
    ? `${ctx?.name ?? "?"} (あるべき姿)`
    : e.origin === "inside"
      ? `${systemName} (内)${scoped.otherSources.length > 0 ? `。ほかにも ${scoped.otherSources.map((s) => s.name).join("・")} が発生させる` : ""}`
      : `別のところ (外): ${scoped.sources.map((s) => s.name).join("・") || (scoped.row.timed ? "定期 (発生元なし)" : "発生元なし")}`;
  const candidateProps = scoped?.row.properties ?? [];
  return (
    <div className="editor" data-testid="domain-event">
      <div className="kind-line">
        ドメインイベント{saved ? "" : " (候補)"}
        {!scoped ? " ・ あるべき姿" : ""}
      </div>
      <TextField label="名前 (過去の形。記録ではなく事実の名前にする)" value={e.name} readOnly={edit.readOnly || (needsContext && !contextId)} onCommit={(v) => v.trim() !== e.name && patch({ name: v })} />
      <TextField label="英語名 (コードでの名前。過去分詞)" value={e.english ?? ""} readOnly={edit.readOnly || (needsContext && !contextId)} maxLength={ENGLISH_MAX_LENGTH} placeholder="例: OrderConfirmed" onCommit={(v) => v.trim() !== (e.english ?? "") && patch({ english: v })} />
      <Field label="どこで">{where}</Field>
      {saved ? (
        <>
          <div className="field">
            <span className="field-label">発生させるコンテキスト</span>
            <select aria-label="発生させるコンテキスト" value={saved.boundedContextId} disabled={edit.readOnly} onChange={(ev) => edit.run((m) => updateDomainEvent(m, { id: saved.id, patch: { boundedContextId: ev.target.value, aggregateId: null } }))}>
              {model.domain.contexts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">発生させる集約</span>
            <select aria-label="発生させる集約" value={saved.aggregateId ?? ""} disabled={edit.readOnly} onChange={(ev) => edit.run((m) => updateDomainEvent(m, { id: saved.id, patch: { aggregateId: ev.target.value === "" ? null : ev.target.value } }))}>
              <option value="">(なし)</option>
              {model.domain.aggregates
                .filter((a) => a.boundedContextId === saved.boundedContextId)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </div>
        </>
      ) : (
        <Field label="コンテキスト・集約 (候補)">
          {ctx?.name ?? "決まっていません"}
          {e.aggregateKey !== null && <Pick kind="aggregate" id={e.aggregateKey} label={r.aggregates.find((a) => a.key === e.aggregateKey)?.name ?? "?"} />}
        </Field>
      )}
      {needsContext && !edit.readOnly && (
        <div className="field">
          <span className="field-label">発生元のコンテキスト (別のところで発生するイベントは、保存する前に選ぶ)</span>
          <select aria-label="発生元のコンテキスト" value={contextId} onChange={(ev) => setContextId(ev.target.value)}>
            <option value="">(境界づけられたコンテキストを選ぶ)</option>
            {model.domain.contexts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {contextId && (
            <button type="button" onClick={() => adopt()}>
              このコンテキストのイベントとして保存する
            </button>
          )}
        </div>
      )}
      {scoped?.row.event.timing && <Field label="発生タイミング">{describeEventTiming(scoped.row.event.timing)}</Field>}
      <Field label="発生させるコマンド">
        {emitters.length === 0 ? (
          <span className="hint-inline">{scoped && scoped.row.systems.length > 0 ? `なし (${scoped.row.systems.map((s) => s.name).join("・")} が直接発生させる)` : "なし"}</span>
        ) : (
          <span className="an-list">
            {emitters.map((c) => (
              <Pick key={c.key} kind="command" id={c.key} label={c.name} />
            ))}
          </span>
        )}
      </Field>
      <div className="field">
        <span className="field-label">属性</span>
        {saved?.properties && saved.properties.length > 0 ? (
          <ul className="plain-list">
            {saved.properties.map((p, i) => (
              <li key={`${p.name}:${i}`} className="domain-item-row">
                {p.name}
                {!edit.readOnly && (
                  <button type="button" className="icon-button" aria-label={`属性 ${p.name} を消す`} title="消す" onClick={() => edit.run((m) => updateDomainEvent(m, { id: saved.id, patch: { properties: saved.properties!.filter((_, k) => k !== i) } }))}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <span className="hint-inline">{candidateProps.length > 0 ? `候補 (発生元が書く情報): ${candidateProps.map((p) => p.name).join("・")}` : "なし"}</span>
        )}
        {saved && !edit.readOnly && (
          <>
            <AddLine label="属性を足す" placeholder="例: 注文番号" onAdd={(name) => edit.run((m) => updateDomainEvent(m, { id: saved.id, patch: { properties: [...(saved.properties ?? []), { name }] } }))} />
            {candidateProps.length > 0 && (!saved.properties || saved.properties.length === 0) && (
              <button type="button" onClick={() => edit.run((m) => updateDomainEvent(m, { id: saved.id, patch: { properties: candidateProps.map((p) => ({ name: p.name, informationId: p.id })) } }))}>
                候補 ({candidateProps.map((p) => p.name).join("・")}) を属性にする
              </button>
            )}
          </>
        )}
      </div>
      <div className="field">
        <span className="field-label">ポリシー (このイベントが起きたら実行するコマンド)</span>
        {policies.length === 0 && <span className="hint-inline">なし{scoped && scoped.row.consumers.activities.length + scoped.outsideConsumers.length > 0 ? " (このシステムの外の受け手・作業の起点はあります)" : " (受け手の無いイベント)"}</span>}
        <ul className="plain-list">
          {policies.map((p) => {
            const target = r.commands.find((c) => c.key === p.commandKey);
            return (
              <li key={p.key} className="domain-item-row" data-policy={p.key}>
                <Pick kind="command" id={p.commandKey} label={target?.name ?? "?"} />
                {p.saved && !edit.readOnly ? (
                  <label className="check-row is-inline">
                    <input type="checkbox" checked={p.auto} onChange={() => edit.run((m) => updateDomainPolicy(m, { id: p.saved!.id, auto: !p.auto }))} />
                    自動
                  </label>
                ) : (
                  <span className={`an-role ${p.auto ? "role-auto" : "role-human"}`}>{p.auto ? "自動" : "人"}</span>
                )}
                {!edit.readOnly && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${target?.name ?? ""} へのポリシーを${p.saved ? "消す" : "外す"}`}
                    title={p.saved ? "このポリシーを消す" : "分析から導いたこのポリシーを、あるべき姿から外す"}
                    onClick={() => (p.saved ? edit.run((m) => removeDomainPolicy(m, { id: p.saved!.id })) : edit.run((m) => setCandidateExcluded(m, { key: p.key.split("@")[0]!, excluded: true })))}
                  >
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {scoped && scoped.outsideConsumers.length > 0 && (
          <span className="an-sub">
            外の受け手: {scoped.outsideConsumers.map((c) => `${c.usecase.name} (${c.place?.name ?? "対象なし"})`).join("、")}
          </span>
        )}
        {scoped && scoped.row.consumers.activities.length > 0 && (
          <span className="an-sub">
            起点にする作業: <Els elements={scoped.row.consumers.activities} />
          </span>
        )}
        {!edit.readOnly && (!needsContext || contextId) && (
          <div className="domain-add-line">
            <select
              aria-label="ポリシーを足す (実行するコマンド)"
              value=""
              onChange={(ev) => {
                const commandKey = ev.target.value;
                if (!commandKey) return;
                const added = edit.run((m) => addPolicyBetween(m, { systemId, eventKey: e.key, commandKey, auto, ...(needsContext && contextId ? { eventContextId: contextId } : {}) }));
                if (added) {
                  const savedEvent = added.model.domain.policies.find((p) => p.id === added.id)?.eventId;
                  if (savedEvent) select({ kind: "event", id: savedEvent });
                }
              }}
            >
              <option value="">(ポリシーを足す: 実行するコマンドを選ぶ)</option>
              {r.commands
                .filter((c) => !policies.some((p) => p.commandKey === c.key) && (c.saved || c.aggregateKey !== null))
                .map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
            </select>
            <label className="check-row is-inline">
              <input type="checkbox" checked={auto} onChange={() => setAuto(!auto)} />
              自動
            </label>
          </div>
        )}
      </div>
      {!edit.readOnly && (
        <div className="domain-actions">
          {saved && (
            <button
              type="button"
              onClick={() => {
                if (edit.run((m) => removeDomainEvent(m, { id: saved.id }))) select(scoped ? { kind: "event", id: scoped.row.event.id } : undefined);
              }}
              title={scoped ? "保存した名前・英語名・属性を捨てて、分析から導いた候補に戻す" : "このあるべき姿のイベントを消す"}>
              {scoped ? "保存をやめて候補に戻す" : "イベントを消す"}
            </button>
          )}
          {e.sourceKey !== null && !saved && (
            <button type="button" onClick={() => edit.run((m) => setCandidateExcluded(m, { key: e.sourceKey!, excluded: true }))} title="この候補を、あるべき姿から外す (左の「外した候補」から戻せる)">
              この候補を外す
            </button>
          )}
        </div>
      )}
      {scoped && <RevealButton element={scoped.row.event} />}
      {scoped && <Notices r={r} ids={[scoped.row.event.id]} get={get} />}
    </div>
  );
}

// ---------------------------------------------------------------- 全体

/** 右のペイン (設計モードのドメインボード): 選んだコンテキスト・集約・コマンド・イベント・問い合わせの中身と根拠を出し、保存した判断を編集する。何も選んでいないときは全体の数と気づき */
export function DomainProperties() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId) ?? "";
  const stored = useUntieStore((s) => s.ui.designDomain);
  const pushToast = useUntieStore((s) => s.pushToast);
  const r = cachedResolvedDomain(model, systemId);
  const sel = normalizeDomainSelection(r, stored);
  const click = useDomainElementClick(r);
  const edit = useDomainEdit();
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);
  const common = { r, model, systemId, edit, get };

  let body: ReactNode = null;
  if (sel?.kind === "context") {
    const ctx = r.contexts.find((x) => x.key === sel.id);
    if (ctx) body = <ContextDetail key={`context:${ctx.key}`} ctx={ctx} {...common} />;
  } else if (sel?.kind === "aggregate") {
    const a = r.aggregates.find((x) => x.key === sel.id);
    if (a) body = <AggregateDetail key={`aggregate:${a.key}`} a={a} {...common} />;
  } else if (sel?.kind === "event") {
    const e = r.events.find((x) => x.key === sel.id);
    if (e) body = <EventDetail key={`event:${e.sourceKey ?? e.key}`} e={e} {...common} />;
  } else if (sel?.kind === "command") {
    const c = r.commands.find((x) => x.key === sel.id);
    if (c) body = <CommandDetail key={`command:${c.sourceKey ?? c.key}`} c={c} {...common} />;
  } else if (sel?.kind === "query") {
    const q = r.scope.queries.find((x) => x.usecase.id === sel.id);
    if (q) {
      body = (
        <div className="editor" data-testid="domain-query">
          <div className="kind-line">問い合わせ (読み取りモデルの候補)</div>
          <Field label="操作">{q.usecase.name}</Field>
          <Field label="画面">{q.screen ? <El element={q.screen} /> : <span className="hint-inline">なし</span>}</Field>
          <Field label="読む情報">
            <Els elements={q.reads} />
          </Field>
          <Field label="使う作業">
            <Els elements={q.activities} />
          </Field>
          <RevealButton element={q.usecase} />
          <Notices r={r} ids={[q.usecase.id]} get={get} />
        </div>
      );
    }
  }

  const adoptAll = () => {
    const done = edit.run((m) => adoptDomainCandidates(m, { systemId }));
    if (done) pushToast(done.contexts + done.aggregates === 0 ? "保存できる候補はありませんでした" : `候補から、コンテキスト ${done.contexts}・集約 ${done.aggregates} を作りました`, "info");
  };
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      <ElementClickContext.Provider value={click}>
        {body ?? (
          <div className="editor" data-testid="domain-overview">
            <p className="hint">左の一覧か図で、コンテキスト・集約・コマンド・問い合わせ・イベントを選ぶと、ここに中身と根拠が出ます。「候補」の印のものは分析から導いただけで、まだ保存していません</p>
            <ul className="plain-list">
              <li>
                コンテキスト {r.contexts.length} (保存 {r.contexts.filter((c) => c.saved).length}・読むだけ {r.contexts.filter((c) => c.role === "upstream").length})
              </li>
              <li>
                集約 {r.aggregates.length} (保存 {r.aggregates.filter((a) => a.saved).length})
              </li>
              <li>
                コマンド {r.commands.length} (保存 {r.commands.filter((c) => c.saved).length})
              </li>
              <li>問い合わせ (読み取りモデル) {r.scope.queries.length}</li>
              <li>
                イベント {r.events.length} (内 {r.events.filter((e) => e.origin === "inside").length}・外 {r.events.filter((e) => e.origin === "outside").length})
              </li>
              <li>ポリシー {r.policies.length}</li>
            </ul>
            {!edit.readOnly && r.unadopted.contexts + r.unadopted.aggregates > 0 && (
              <div className="field">
                <button type="button" onClick={adoptAll} title="このシステムが書く情報のある分析のコンテキストを境界づけられたコンテキストに、書く情報を 1 情報 1 集約にして保存する (AI は使わない)">
                  候補から作る (コンテキスト {r.unadopted.contexts}・集約 {r.unadopted.aggregates})
                </button>
                <p className="hint">作ったあとで、集約をまとめる・名前を直す・不変条件を足す、を進めます。コンテキストに属していない情報は作りません</p>
              </div>
            )}
            <NoticeList notices={r.scope.notices} get={get} />
          </div>
        )}
      </ElementClickContext.Provider>
    </aside>
  );
}
