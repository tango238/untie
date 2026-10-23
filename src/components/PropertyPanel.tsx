import { useEffect, useRef, useState } from "react";
import {
  addElement,
  addRelation,
  moveActivity,
  moveBuc,
  moveToContext,
  removeElement,
  removeFromBoard,
  removeRelation,
  setIssueTargets,
  updateElement,
} from "../model/commands";
import { relationKindFor, relationLabel, relationRule, sameRelation } from "../model/relations";
import { suggestContext } from "../model/contexts";
import { defaultBucOf, issuesTargeting } from "../model/selectors";
import {
  ELEMENT_KIND_LABELS,
  isContextMemberKind,
  isIssueTargetKind,
  type Activity,
  type Buc,
  type Element,
  type Issue,
  type Link,
  type Relation,
  type UntieModel,
  type Variation,
} from "../model/types";
import { isFixedBoard, useUntieStore } from "../store";
import { selectAndReveal } from "./actions";
import { openExternalUrl } from "../io/file";
import { CommitField } from "./CommitField";
import { GRANULARITY, isGuideKind } from "./granularity";

export function PropertyPanel() {
  const model = useUntieStore((s) => s.model);
  const selection = useUntieStore((s) => s.ui.selection);

  if (!selection) {
    return (
      <aside className="property-panel" aria-label="プロパティ">
        <h2 className="panel-title">プロパティ</h2>
        <p className="hint">要素や線を選ぶと、ここで内容を編集できます。</p>
      </aside>
    );
  }
  if (selection.type === "relation") {
    const relation = model.relations.find((r) => r.id === selection.id);
    return (
      <aside className="property-panel" aria-label="プロパティ">
        <h2 className="panel-title">プロパティ</h2>
        {relation ? <RelationEditor relation={relation} model={model} /> : null}
      </aside>
    );
  }
  const element = model.elements.find((e) => e.id === selection.id);
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      {element ? <ElementEditor key={element.id} element={element} model={model} /> : null}
    </aside>
  );
}

// ---------------------------------------------------------------- 線

function RelationEditor({ relation, model }: { relation: Relation; model: UntieModel }) {
  const source = model.elements.find((e) => e.id === relation.sourceId);
  const target = model.elements.find((e) => e.id === relation.targetId);
  const rule = relationRule(relation.kind);
  return (
    <div className="editor" data-testid="relation-editor">
      <div className="kind-line">関係</div>
      <div className="field">
        <span className="field-label">関係名</span>
        <div className="static-value">{relationLabel(relation.kind)}</div>
      </div>
      <div className="field">
        <span className="field-label">{rule.undirected ? "両端" : "始点"}</span>
        {source && (
          <button type="button" className="link" onClick={() => selectAndReveal(source.id)}>
            {source.name}
          </button>
        )}
      </div>
      <div className="field">
        <span className="field-label">{rule.undirected ? "もう一方" : "終点"}</span>
        {target && (
          <button type="button" className="link" onClick={() => selectAndReveal(target.id)}>
            {target.name}
          </button>
        )}
      </div>
      <p className="hint">関係の追加・削除は固定ボードで、要素を選んで行います。</p>
    </div>
  );
}

// ---------------------------------------------------------------- 要素

function ElementEditor({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const select = useUntieStore((s) => s.select);
  const boardId = useUntieStore((s) => s.ui.currentBoardId);
  const nameFocusNonce = useUntieStore((s) => s.ui.nameFocusNonce);
  const pushToast = useUntieStore((s) => s.pushToast);
  const requestNameFocus = useUntieStore((s) => s.requestNameFocus);
  const setRightPanel = useUntieStore((s) => s.setRightPanel);
  const nameRef = useRef<HTMLInputElement>(null);
  // 所属・関係・要素の作成と削除は固定ボードだけで変えられる。自由ボードでは名前と説明だけ
  const structural = isFixedBoard(boardId);

  // 「追加」直後に名前欄へフォーカスする。新しい要素の編集欄はマウントと同時にここへ来るので、
  // 処理済みの番号をモジュールに持ち、増えているときだけ発火する
  useEffect(() => {
    if (nameFocusNonce !== handledFocus.nonce) {
      handledFocus.nonce = nameFocusNonce;
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [nameFocusNonce]);

  const update = (patch: Parameters<typeof updateElement>[1]["patch"]) => {
    const r = dispatch((m) => updateElement(m, { id: element.id, patch }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  const onBoard = !!model.boards.find((b) => b.id === boardId)?.nodes.some((n) => n.elementId === element.id);
  const relations = model.relations.filter((r) => r.sourceId === element.id || r.targetId === element.id);
  const issues = isIssueTargetKind(element.kind) ? issuesTargeting(model, element.id) : [];

  const addIssue = () => {
    const r = dispatch((m) => addElement(m, { kind: "issue", name: "新しい課題", init: { targetIds: [element.id] } }));
    if (!r.ok) {
      pushToast(r.reason, "error");
      return;
    }
    select({ type: "element", id: r.id });
    setRightPanel("properties");
    requestNameFocus();
  };

  return (
    <div className={`editor kind-${element.kind}`} data-testid="element-editor">
      <div className="kind-line">
        <span className="kind-dot" />
        {ELEMENT_KIND_LABELS[element.kind]}
      </div>
      <CommitField label="名前" value={element.name} inputRef={nameRef} onCommit={(name) => update({ name })} />
      {isGuideKind(element.kind) && !(element.kind === "buc" && element.isDefault) && (
        <p className="hint name-hint">{GRANULARITY[element.kind].nameHint}</p>
      )}
      <CommitField
        label="説明"
        multiline
        value={element.description ?? ""}
        onCommit={(description) => update({ description })}
      />
      {(element.kind === "activity" || element.kind === "usecase") && (
        <LinksEditor links={element.links ?? []} onChange={(links) => update({ links })} />
      )}

      {!structural && (
        <p className="hint">自由ボードでは名前・説明・リンクだけを変えられます。所属・関係・削除は固定ボードで行います。</p>
      )}
      <fieldset className="plain-fieldset" disabled={!structural}>
        {element.kind === "activity" && <ActivityFields activity={element} model={model} />}
        {element.kind === "buc" && !element.isDefault && <BucFields buc={element} model={model} />}
        {isContextMemberKind(element.kind) && <ContextField element={element} model={model} />}
        {element.kind === "state" && (
          <CommitField label="状態グループ" value={element.group ?? ""} onCommit={(group) => update({ group })} />
        )}
        {element.kind === "variation" && (
          <VariationValues variation={element} onChange={(values) => update({ values })} />
        )}
        {element.kind === "issue" && <IssueFields issue={element} model={model} />}
      </fieldset>

      <section className="subsection">
        <h3>関係</h3>
        {structural && <RelationAdder element={element} model={model} />}
        {relations.length === 0 ? (
          <p className="hint">この要素につながる線はありません。</p>
        ) : (
          <ul className="relation-list">
            {relations.map((r) => {
              const outgoing = r.sourceId === element.id;
              const otherId = outgoing ? r.targetId : r.sourceId;
              const other = model.elements.find((e) => e.id === otherId);
              return (
                <li key={r.id}>
                  <span className="relation-kind">{relationLabel(r.kind)}</span>
                  <span className="relation-dir" aria-hidden="true">
                    {relationRule(r.kind).undirected ? "↔" : outgoing ? "→" : "←"}
                  </span>
                  <button type="button" className="link" onClick={() => other && selectAndReveal(other.id)}>
                    {other?.name || "(名前なし)"}
                  </button>
                  {structural && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`関係「${relationLabel(r.kind)} ${other?.name ?? ""}」を削除`}
                      onClick={() => dispatch((m) => removeRelation(m, { id: r.id }))}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {isIssueTargetKind(element.kind) && (
        <section className="subsection">
          <h3>課題</h3>
          {issues.length === 0 ? (
            <p className="hint">この要素を対象にした課題はありません。</p>
          ) : (
            <ul className="issue-link-list">
              {issues.map((i) => (
                <li key={i.id}>
                  <span className={`sev-chip sev-${i.severity}`}>{i.severity}</span>
                  <button type="button" className="link" onClick={() => selectAndReveal(i.id)}>
                    {i.name || "(名前なし)"}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {structural && (
            <button type="button" onClick={addIssue}>
              課題を追加
            </button>
          )}
        </section>
      )}

      <div className="actions">
        {!structural && onBoard && (
          <button
            type="button"
            onClick={() => dispatch((m) => removeFromBoard(m, { boardId, elementId: element.id }))}
          >
            ボードから外す
          </button>
        )}
        {structural && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              const r = dispatch((m) => removeElement(m, { id: element.id }));
              if (!r.ok) pushToast(r.reason, "error");
            }}
          >
            削除
          </button>
        )}
      </div>
    </div>
  );
}

const handledFocus = { nonce: 0 };

// ---------------------------------------------------------------- 種類固有

/** この要素と結べる要素を選んで関係を足す (両端の種類から関係が決まる)。固定ボードだけで出す */
function RelationAdder({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const options: { value: string; group: string; label: string }[] = [];
  for (const other of model.elements) {
    if (other.id === element.id || (other.kind === "buc" && other.isDefault)) continue;
    // 自分が始点 → 相手が始点の順に調べ、同じ相手は 1 回だけ出す (無向の関連)
    for (const [sourceId, targetId, kind] of [
      [element.id, other.id, relationKindFor(element.kind, other.kind)],
      [other.id, element.id, relationKindFor(other.kind, element.kind)],
    ] as const) {
      if (!kind) continue;
      if (model.relations.some((r) => sameRelation(r, { kind, sourceId, targetId }))) break;
      const dir = relationRule(kind).undirected ? "↔" : sourceId === element.id ? "→" : "←";
      options.push({
        value: `${sourceId}>${targetId}`,
        group: `${relationLabel(kind)} ${dir} ${ELEMENT_KIND_LABELS[other.kind]}`,
        label: other.name || "(名前なし)",
      });
      break;
    }
  }
  if (options.length === 0) return null;
  const groups = [...new Set(options.map((o) => o.group))];
  return (
    <select
      aria-label="関係を追加"
      value=""
      onChange={(ev) => {
        const [sourceId, targetId] = ev.target.value.split(">");
        if (!sourceId || !targetId) return;
        const r = dispatch((m) => addRelation(m, { sourceId, targetId }));
        if (!r.ok) pushToast(r.reason, "error");
      }}
    >
      <option value="">関係を追加…</option>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {options
            .filter((o) => o.group === g)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function ActivityFields({ activity, model }: { activity: Activity; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const buc = activity.bucId ? (model.elements.find((e) => e.id === activity.bucId) as Buc | undefined) : undefined;
  const businessId = buc?.businessId ?? "";
  const businesses = model.elements.filter((e) => e.kind === "business");
  const bucs = model.elements.filter((e): e is Buc => e.kind === "buc" && e.businessId === businessId);

  const move = (bucId: string | null) => {
    const r = dispatch((m) => moveActivity(m, { activityId: activity.id, bucId }));
    if (!r.ok) pushToast(r.reason, "error");
  };

  return (
    <>
      <label className="field">
        <span className="field-label">業務</span>
        <select
          aria-label="業務"
          value={businessId}
          onChange={(e) => move(e.target.value ? (defaultBucOf(model, e.target.value)?.id ?? null) : null)}
        >
          <option value="">未所属</option>
          {businesses.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">活動</span>
        <select
          aria-label="活動"
          value={activity.bucId ?? ""}
          disabled={!businessId}
          onChange={(e) => move(e.target.value || null)}
        >
          {!businessId && <option value="">(業務を選ぶ)</option>}
          {bucs.map((b) => (
            <option key={b.id} value={b.id}>
              {b.isDefault ? "(業務に直接)" : b.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function BucFields({ buc, model }: { buc: Buc; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const businesses = model.elements.filter((e) => e.kind === "business");
  return (
    <label className="field">
      <span className="field-label">業務</span>
      <select
        aria-label="業務"
        value={buc.businessId}
        onChange={(e) => {
          const r = dispatch((m) => moveBuc(m, { bucId: buc.id, businessId: e.target.value }));
          if (!r.ok) pushToast(r.reason, "error");
        }}
      >
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 情報・状態・条件・バリエーションの所属コンテキスト。関係から見た候補も出す */
function ContextField({ element, model }: { element: Element; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const contexts = model.elements.filter((e) => e.kind === "context");
  const current = "contextId" in element ? element.contextId : null;
  const suggested = suggestContext(model, element.id);
  const suggestedName = suggested ? model.elements.find((e) => e.id === suggested)?.name || "(名前なし)" : "";
  const move = (contextId: string | null) => {
    const r = dispatch((m) => moveToContext(m, { elementId: element.id, contextId }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  const byGroup = element.kind === "state" && element.group;
  return (
    <div className="field">
      <label className="field">
        <span className="field-label">コンテキスト{byGroup ? " (状態グループごと)" : ""}</span>
        <select aria-label="コンテキスト" value={current ?? ""} onChange={(e) => move(e.target.value || null)}>
          <option value="">未分類</option>
          {contexts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name || "(名前なし)"}
            </option>
          ))}
        </select>
      </label>
      {suggested && suggested !== current && (
        <p className="hint context-suggest">
          つながりから見ると「{suggestedName}」が候補です。
          <button type="button" className="link-plain context-apply" onClick={() => move(suggested)}>
            「{suggestedName}」にする
          </button>
        </p>
      )}
    </div>
  );
}

/** マニュアルなどへのリンク (作業・操作)。名前をクリックすると既定のブラウザで開く */
function LinksEditor({ links, onChange }: { links: Link[]; onChange: (links: Link[]) => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const pushToast = useUntieStore((s) => s.pushToast);
  const add = () => {
    const u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//.test(u)) {
      pushToast("URL は http:// か https:// で始めてください", "error");
      return;
    }
    onChange([...links, { title: title.trim() || u, url: u }]);
    setTitle("");
    setUrl("");
  };
  const move = (i: number, j: number) => {
    const next = [...links];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <section className="subsection">
      <h3>リンク</h3>
      {links.length === 0 ? (
        <p className="hint">マニュアルなどへのリンクはまだありません。</p>
      ) : (
        <ul className="link-list">
          {links.map((l, i) => (
            <li key={i}>
              <button type="button" className="link" title={l.url} onClick={() => void openExternalUrl(l.url)}>
                {l.title}
              </button>
              <button type="button" className="icon-button" aria-label={`リンク「${l.title}」を上へ`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                ↑
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`リンク「${l.title}」を下へ`}
                disabled={i === links.length - 1}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`リンク「${l.title}」を削除`}
                onClick={() => onChange(links.filter((_, k) => k !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="link-add">
        <input aria-label="リンクの表示名" placeholder="表示名 (例: 鍵の受け渡しマニュアル)" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="inline-add">
          <input
            aria-label="リンクの URL"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button type="button" onClick={add}>
            追加
          </button>
        </div>
      </div>
    </section>
  );
}

function VariationValues({ variation, onChange }: { variation: Variation; onChange: (values: string[]) => void }) {
  const [adding, setAdding] = useState("");
  const values = variation.values;
  const swap = (i: number, j: number) => {
    const next = [...values];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = () => {
    const v = adding.trim();
    if (!v) return;
    onChange([...values, v]);
    setAdding("");
  };
  return (
    <section className="subsection">
      <h3>値の一覧</h3>
      <ul className="value-list">
        {values.map((v, i) => (
          <li key={i}>
            <CommitField
              label={`値 ${i + 1}`}
              value={v}
              onCommit={(nv) => {
                const t = nv.trim();
                if (t === v) return;
                onChange(values.map((x, k) => (k === i ? t : x)));
              }}
            />
            <button type="button" className="icon-button" aria-label={`値「${v}」を上へ`} disabled={i === 0} onClick={() => swap(i, i - 1)}>
              ↑
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`値「${v}」を下へ`}
              disabled={i === values.length - 1}
              onClick={() => swap(i, i + 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`値「${v}」を削除`}
              onClick={() => onChange(values.filter((_, k) => k !== i))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="inline-add">
        <input
          aria-label="追加する値"
          value={adding}
          placeholder="新しい値"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button type="button" onClick={add}>
          追加
        </button>
      </div>
    </section>
  );
}

function IssueFields({ issue, model }: { issue: Issue; model: UntieModel }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const candidates = model.elements.filter((e) => isIssueTargetKind(e.kind) && !issue.targetIds.includes(e.id));
  const setTargets = (targetIds: string[]) => {
    const r = dispatch((m) => setIssueTargets(m, { issueId: issue.id, targetIds }));
    if (!r.ok) pushToast(r.reason, "error");
  };
  return (
    <>
      <label className="field">
        <span className="field-label">重要度</span>
        <select
          aria-label="重要度"
          value={issue.severity}
          onChange={(e) => {
            const severity = Number(e.target.value);
            const r = dispatch((m) => updateElement(m, { id: issue.id, patch: { severity } }));
            if (!r.ok) pushToast(r.reason, "error");
          }}
        >
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 1 ? " (低)" : n === 5 ? " (高)" : ""}
            </option>
          ))}
        </select>
      </label>
      <section className="subsection">
        <h3>対象</h3>
        {issue.targetIds.length === 0 ? (
          <p className="hint">対象はまだありません。</p>
        ) : (
          <ul className="target-list">
            {issue.targetIds.map((id) => {
              const t = model.elements.find((e) => e.id === id);
              return (
                <li key={id}>
                  <span className="relation-kind">{t ? ELEMENT_KIND_LABELS[t.kind] : ""}</span>
                  <button type="button" className="link" onClick={() => t && selectAndReveal(t.id)}>
                    {t?.name || "(名前なし)"}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`対象「${t?.name ?? ""}」を外す`}
                    onClick={() => setTargets(issue.targetIds.filter((x) => x !== id))}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <label className="field">
          <span className="field-label">対象を追加</span>
          <select
            aria-label="対象を追加"
            value=""
            onChange={(e) => {
              if (e.target.value) setTargets([...issue.targetIds, e.target.value]);
            }}
          >
            <option value="">選んで追加…</option>
            {(["business", "activity", "usecase"] as const).map((kind) => (
              <optgroup key={kind} label={ELEMENT_KIND_LABELS[kind]}>
                {candidates
                  .filter((c) => c.kind === kind)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      </section>
    </>
  );
}
