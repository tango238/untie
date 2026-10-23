import { useMemo } from "react";
import { sortedIssues } from "../model/selectors";
import { useUntieStore } from "../store";
import { selectAndReveal } from "./actions";

export function IssuePanel() {
  const model = useUntieStore((s) => s.model);
  const selection = useUntieStore((s) => s.ui.selection);
  const issues = useMemo(() => sortedIssues(model), [model]);
  const nameOf = (id: string) => model.elements.find((e) => e.id === id)?.name ?? "";

  return (
    <aside className="issue-panel" aria-label="課題一覧">
      <h2 className="panel-title">課題一覧 ({issues.length})</h2>
      {issues.length === 0 ? (
        <p className="hint">課題はありません。プロパティ欄の「課題を追加」か、「＋追加」から作れます。</p>
      ) : (
        <ul className="issue-rows">
          {issues.map((i) => {
            const selected = selection?.type === "element" && selection.id === i.id;
            return (
              <li key={i.id} className={`issue-row${selected ? " is-selected" : ""}`} data-testid={`issue-${i.id}`}>
                <button
                  type="button"
                  className="issue-main"
                  onClick={() => selectAndReveal(i.id, { showProperties: true })}
                >
                  <span className={`sev-chip sev-${i.severity}`} aria-label={`重要度 ${i.severity}`}>
                    {i.severity}
                  </span>
                  <span className="issue-name">{i.name || "(名前なし)"}</span>
                </button>
                <div className="issue-targets">
                  {i.targetIds.length === 0 ? (
                    <span className="hint">対象なし</span>
                  ) : (
                    i.targetIds.map((id) => (
                      <button key={id} type="button" className="chip-link" onClick={() => selectAndReveal(id)}>
                        {nameOf(id) || "(名前なし)"}
                      </button>
                    ))
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
