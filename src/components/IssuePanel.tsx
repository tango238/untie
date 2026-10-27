import { useMemo, useState } from "react";
import { addElement } from "../model/commands";
import { issueBoardSections, issuesByScope, type IssueTargetGroup } from "../model/selectors";
import {
  ELEMENT_KIND_LABELS,
  ISSUE_SCOPES,
  ISSUE_SCOPE_LABELS,
  ISSUE_SCOPE_TARGETS,
  type Element,
  type Issue,
  type IssueScope,
} from "../model/types";
import { useUntieStore } from "../store";
import { revealOnFixedBoard, selectAndReveal } from "./actions";

type View = "issues" | "targets";

const SCOPE_HINTS: Record<IssueScope, string> = {
  unsorted: "対象をまだ決めていない課題です。課題を選び、プロパティ欄の「対象を追加」で登場人物か業務・作業・操作に付けます。",
  overall: "登場人物ごとの、全体にかかわる課題です。",
  specific: "特定の業務・作業・操作で起きている課題です。",
};

/** 課題を作って選び、名前の入力へ移る。対象を渡すと、その要素を対象にして作る */
function createIssue(targetId?: string) {
  const st = useUntieStore.getState();
  const r = st.dispatch((m) => addElement(m, { kind: "issue", name: "新しい課題", init: { targetIds: targetId ? [targetId] : [] } }));
  if (!r.ok) {
    st.pushToast(r.reason, "error");
    return;
  }
  st.select({ type: "element", id: r.id });
  st.setRightPanel("properties");
  st.requestNameFocus();
}

/**
 * 課題一覧: 課題を先に書き出し、あとから対象を付けて紐解く場所。
 * 未整理 (対象なし)・全体的な課題 (登場人物が対象)・具体的な課題 (業務・作業・操作が対象) に分けて並べる。
 * 「課題ごと」は重要度の高い順、「対象ごと」は対象の要素ごとにまとめる
 */
export function IssuePanel() {
  const model = useUntieStore((s) => s.model);
  const selection = useUntieStore((s) => s.ui.selection);
  const [view, setView] = useState<View>("issues");
  const byScope = useMemo(() => issuesByScope(model), [model]);
  const sections = useMemo(() => issueBoardSections(model), [model]);
  const byId = useMemo(() => new Map(model.elements.map((e) => [e.id, e])), [model]);
  const total = ISSUE_SCOPES.reduce((n, s) => n + byScope[s].length, 0);
  const selectedId = selection?.type === "element" ? selection.id : null;

  return (
    <aside className="issue-panel" aria-label="課題一覧">
      <div className="issue-panel-head">
        <h2 className="panel-title">課題一覧 ({total})</h2>
        <button type="button" className="issue-add" onClick={() => createIssue()}>
          ＋課題
        </button>
      </div>
      <p className="hint">現場で困っていることを先に書き出し、あとから対象を付けて紐解きます。対象は付け替えられます。</p>
      <div className="segmented issue-view" role="group" aria-label="並べ方">
        {(
          [
            ["issues", "課題ごと"],
            ["targets", "対象ごと"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} type="button" aria-pressed={view === v} className={view === v ? "is-active" : ""} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>
      {total === 0 && <p className="hint">課題はまだありません。「＋課題」で書き出しましょう。</p>}
      {sections.map((sec) => (
        <section key={sec.scope} className={`issue-scope issue-scope-${sec.scope}`} aria-label={ISSUE_SCOPE_LABELS[sec.scope]}>
          <h3 className="issue-scope-title" title={ISSUE_SCOPE_TARGETS[sec.scope]}>
            {ISSUE_SCOPE_LABELS[sec.scope]} ({sec.count})
          </h3>
          {sec.count === 0 ? (
            <p className="hint issue-scope-empty">{SCOPE_HINTS[sec.scope]}</p>
          ) : view === "issues" || sec.scope === "unsorted" ? (
            <ul className="issue-rows">
              {byScope[sec.scope].map((i) => (
                <IssueRow key={i.id} issue={i} selected={selectedId === i.id} byId={byId} />
              ))}
            </ul>
          ) : (
            sec.groups.map((g) => <TargetGroup key={g.target!.id} group={g} selectedId={selectedId} />)
          )}
        </section>
      ))}
    </aside>
  );
}

function SevChip({ issue }: { issue: Issue }) {
  return (
    <span className={`sev-chip sev-${issue.severity}`} aria-label={`重要度 ${issue.severity}`}>
      {issue.severity}
    </span>
  );
}

function IssueRow({ issue, selected, byId }: { issue: Issue; selected: boolean; byId: Map<string, Element> }) {
  return (
    <li className={`issue-row${selected ? " is-selected" : ""}`} data-testid={`issue-${issue.id}`}>
      <button type="button" className="issue-main" onClick={() => selectAndReveal(issue.id, { showProperties: true })}>
        <SevChip issue={issue} />
        <span className="issue-name">{issue.name || "(名前なし)"}</span>
      </button>
      <div className="issue-targets">
        {issue.targetIds.length === 0 ? (
          <span className="hint">対象なし</span>
        ) : (
          issue.targetIds.map((id) => {
            const t = byId.get(id);
            return (
              <button key={id} type="button" className={`chip-link${t ? ` kind-${t.kind}` : ""}`} onClick={() => selectAndReveal(id)}>
                {t && <span className="chip-kind">{ELEMENT_KIND_LABELS[t.kind]}</span>}
                {t?.name || "(名前なし)"}
              </button>
            );
          })
        )}
      </div>
    </li>
  );
}

/** 対象ごとのまとまり: 対象の種類・名前、そのレイヤーの固定ボードへの「移動」、その対象の課題を足す「＋課題」 */
function TargetGroup({ group, selectedId }: { group: IssueTargetGroup; selectedId: string | null }) {
  const target = group.target!;
  return (
    <div className={`issue-target-group kind-${target.kind}`} data-testid={`issue-target-${target.id}`}>
      <div className="issue-target-head">
        <span className="chip-kind">{ELEMENT_KIND_LABELS[target.kind]}</span>
        <button type="button" className="link issue-target-name" onClick={() => selectAndReveal(target.id)}>
          {target.name || "(名前なし)"}
        </button>
        <button
          type="button"
          className="link issue-target-action"
          title={`${ELEMENT_KIND_LABELS[target.kind]}の固定ボードへ移る`}
          aria-label={`「${target.name}」の固定ボードへ移る`}
          onClick={() => revealOnFixedBoard(target.id)}
        >
          移動
        </button>
        <button
          type="button"
          className="link issue-target-action"
          aria-label={`「${target.name}」を対象に課題を追加`}
          onClick={() => createIssue(target.id)}
        >
          ＋課題
        </button>
      </div>
      <ul className="issue-rows">
        {group.issues.map((i) => (
          <li key={i.id} className={`issue-row${selectedId === i.id ? " is-selected" : ""}`}>
            <button type="button" className="issue-main" onClick={() => selectAndReveal(i.id, { showProperties: true })}>
              <SevChip issue={i} />
              <span className="issue-name">{i.name || "(名前なし)"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
