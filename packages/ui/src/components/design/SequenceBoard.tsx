import { useEffect, useMemo, useRef, useState } from "react";
import { setRelationAlternate } from "@untie/core/model/commands";
import { DESCRIPTION_MAX_LENGTH } from "@untie/core/model/limits";
import { deriveSequences, sequenceAlternateLines, sequenceCallLabel, type BusinessSequence, type SequenceStep } from "@untie/core/model/sequence";
import { ALTERNATE_AFTER_LABELS, ALTERNATE_ERROR_LABELS, ALTERNATE_ERROR_TYPES, ALTERNATE_WHEN_LABELS, ALTERNATE_WHENS, COMMON_HTTP_STATUSES, HTTP_STATUS_MAX, HTTP_STATUS_MIN, stateGroupKey, type AlternateAfterType, type AlternateErrorType, type AlternateWhen, type UntieModel } from "@untie/core/model/types";
import { selectReadOnly, useUntieStore } from "../../store";
import { CommitField } from "../CommitField";

type AlternateStep = Extract<SequenceStep, { type: "alternate" }>;

// ---------------------------------------------------------------- 図の寸法

const COL = 190;
const MARGIN = 24;
const HEAD = 44;
const BOX = 150;
/** 1 行に入る文字数の目安 (幅 px から。日本語は 1 文字 12px ほど) */
const fit = (text: string, width: number): string => {
  const max = Math.max(4, Math.floor(width / 12));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

interface Row {
  step: SequenceStep;
  y: number;
  height: number;
}

function noteLines(step: Extract<SequenceStep, { type: "note" }>): string[] {
  return [step.writes.length > 0 ? `書く: ${step.writes.join("・")}` : "", step.reads.length > 0 ? `読む: ${step.reads.join("・")}` : "", step.states ? `状態: ${step.states}` : ""].filter(Boolean);
}

const HEIGHTS: Record<SequenceStep["type"], (step: SequenceStep) => number> = {
  activity: () => 34,
  call: () => 40,
  note: (step) => 12 + noteLines(step as Extract<SequenceStep, { type: "note" }>).length * 16,
  alternate: () => 58,
  event: () => 36,
};

function layout(sequence: BusinessSequence): { rows: Row[]; height: number; width: number; x: (id: string) => number } {
  const index = new Map(sequence.participants.map((p, i) => [p.id, i]));
  const x = (id: string) => MARGIN + COL / 2 + (index.get(id) ?? 0) * COL;
  let y = HEAD + 16;
  const rows: Row[] = sequence.steps.map((step) => {
    const height = HEIGHTS[step.type](step);
    const row = { step, y, height };
    y += height + 6;
    return row;
  });
  return { rows, height: y + 16, width: MARGIN * 2 + Math.max(1, sequence.participants.length) * COL, x };
}

// ---------------------------------------------------------------- 図

function Diagram({ sequence, focus, onPickAlternate }: { sequence: BusinessSequence; focus: string | null; onPickAlternate: (relationId: string) => void }) {
  const { rows, height, width, x } = useMemo(() => layout(sequence), [sequence]);
  const arrow = (from: number, to: number, y: number, dashed: boolean, label: string, tone: string) => {
    if (from === to) {
      // 自分への呼び出し: 右へふくらむ輪
      return (
        <g className={`seq-message ${tone}`}>
          <path d={`M ${from} ${y} h 34 v 14 h -28`} fill="none" strokeDasharray={dashed ? "5 4" : undefined} markerEnd="url(#seq-arrow)" />
          <text x={from + 42} y={y + 10}>
            <title>{label}</title>
            {fit(label, COL - 60)}
          </text>
        </g>
      );
    }
    const left = Math.min(from, to);
    const span = Math.abs(to - from);
    return (
      <g className={`seq-message ${tone}`}>
        <line x1={from} y1={y + 14} x2={to + (to > from ? -2 : 2)} y2={y + 14} strokeDasharray={dashed ? "5 4" : undefined} markerEnd="url(#seq-arrow)" />
        <text x={left + span / 2} y={y + 8} textAnchor="middle">
          <title>{label}</title>
          {fit(label, span - 16)}
        </text>
      </g>
    );
  };
  return (
    <svg className="seq-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${sequence.name} のシーケンス図`}>
      <defs>
        <marker id="seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      {/* 登場するものと、縦の線 */}
      {sequence.participants.map((p) => (
        <g key={p.id} className={`seq-participant is-${p.kind}${p.target ? " is-target" : ""}`} data-participant={p.id}>
          <line x1={x(p.id)} y1={HEAD} x2={x(p.id)} y2={height - 8} />
          <rect x={x(p.id) - BOX / 2} y={8} width={BOX} height={HEAD - 12} rx={6} />
          <text x={x(p.id)} y={8 + (HEAD - 12) / 2 + 4} textAnchor="middle">
            <title>{`${p.name}${p.target ? " (設計の対象)" : ""}`}</title>
            {fit(p.name, BOX - 12)}
          </text>
        </g>
      ))}
      {rows.map(({ step, y, height: h }) => {
        if (step.type === "activity") {
          const label = `作業: ${step.activity.name || "(名前なし)"}${step.actors.length > 0 ? ` (担当: ${step.actors.map((a) => a.name).join("・")})` : " (担当なし)"}`;
          return (
            <g key={step.key} className="seq-activity">
              <rect x={8} y={y} width={width - 16} height={h - 8} rx={4} />
              <text x={18} y={y + 17}>
                <title>{label}</title>
                {fit(label, width - 40)}
              </text>
            </g>
          );
        }
        if (step.type === "call") return <g key={step.key}>{arrow(x(step.from), x(step.to), y + 6, step.auto, sequenceCallLabel(step), step.auto ? "is-auto" : "is-call")}</g>;
        if (step.type === "note") {
          const lines = noteLines(step);
          return (
            <g key={step.key} className="seq-note">
              <rect x={x(step.on) - BOX / 2 + 4} y={y} width={BOX + 26} height={h} rx={3} />
              {lines.map((line, i) => (
                <text key={i} x={x(step.on) - BOX / 2 + 10} y={y + 15 + i * 16}>
                  <title>{line}</title>
                  {fit(line, BOX + 14)}
                </text>
              ))}
            </g>
          );
        }
        if (step.type === "event") {
          const label = `出来事: ${step.event.name || "(名前なし)"}`;
          if (step.to === null) {
            return (
              <g key={step.key} className="seq-message is-event">
                <line x1={x(step.from)} y1={y + 20} x2={x(step.from) + 30} y2={y + 20} strokeDasharray="5 4" markerEnd="url(#seq-arrow)" />
                <text x={x(step.from) + 38} y={y + 24}>
                  <title>{`${label} (これをきっかけにする操作はありません)`}</title>
                  {fit(label, COL - 50)}
                </text>
              </g>
            );
          }
          return <g key={step.key}>{arrow(x(step.from), x(step.to), y + 6, true, label, "is-event")}</g>;
        }
        // 分岐 (代替パターン)
        const [when, then] = sequenceAlternateLines(step);
        const left = Math.min(x(step.from), x(step.to)) - BOX / 2;
        const right = Math.max(x(step.from), x(step.to)) + BOX / 2 + 30;
        return (
          <g
            key={step.key}
            className={`seq-alternate${step.alternate && !(step.changesState && step.after === null) ? "" : " is-undecided"}${focus === step.relationId ? " is-focus" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={`分岐 ${when} ${then}`}
            data-alternate={step.relationId}
            onClick={() => onPickAlternate(step.relationId)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPickAlternate(step.relationId);
              }
            }}
          >
            <rect x={left} y={y} width={right - left} height={h - 6} rx={4} />
            <text className="seq-alternate-tag" x={left + 8} y={y + 16}>
              分岐
            </text>
            <text x={left + 44} y={y + 16}>
              <title>{when}</title>
              {fit(when, right - left - 56)}
            </text>
            <text className="seq-alternate-then" x={left + 44} y={y + 36}>
              <title>{then}</title>
              {fit(then, right - left - 56)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- 代替パターンを決める表

function AlternateRow({ step, model, readOnly, focused }: { step: AlternateStep; model: UntieModel; readOnly: boolean; focused: boolean }) {
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const ref = useRef<HTMLTableRowElement>(null);
  // まだ決めていないあいだの「いつ」は、ここで覚えておく (どうなるかを書いたときに一緒に保存する)
  const [draftWhen, setDraftWhen] = useState<AlternateWhen>("met");
  const a = step.alternate;
  const when = a?.when ?? draftWhen;
  type After = { type: AlternateAfterType; stateIds?: readonly string[] } | null;
  const save = (next: { when?: AlternateWhen; then?: string; eventId?: string | null; error?: { type: AlternateErrorType; status?: number | null } | null; after?: After }) => {
    const then = next.then ?? a?.then ?? "";
    // 起きる出来事とエラーは、どちらか一方。片方を選んだら、もう片方は外す
    const outcome = next.error ? { eventId: null, error: next.error } : next.eventId ? { eventId: next.eventId, error: null } : next.eventId === null || next.error === null ? { eventId: null, error: null } : { eventId: a?.eventId ?? null, error: a?.error ?? null };
    // そのあとの状態は、ほかを直しても残す。エラーのときは状態を変えないので、持たない (コマンドが捨てる)
    const after: After = next.after !== undefined ? next.after : (a?.after ?? null);
    const r = dispatch((m) => setRelationAlternate(m, { id: step.relationId, alternate: then.trim() === "" ? null : { when: next.when ?? when, then, ...outcome, after } }));
    if (!r.ok) pushToast(r.reason, "error");
    return r.ok;
  };
  // そのあとの状態の選択肢: 変えない・ふだんと同じ (操作が状態を変えるときだけ)・この操作が関わる状態グループの状態
  const afterStates = useMemo(() => {
    const touched = model.relations.filter((r) => (r.kind === "stateUsecase" && r.targetId === step.usecase.id) || (r.kind === "usecaseState" && r.sourceId === step.usecase.id)).map((r) => (r.kind === "stateUsecase" ? r.sourceId : r.targetId));
    const states = model.elements.filter((e): e is Extract<UntieModel["elements"][number], { kind: "state" }> => e.kind === "state");
    const keys = new Set(states.filter((e) => touched.includes(e.id)).map(stateGroupKey));
    return states.filter((e) => keys.has(stateGroupKey(e)));
  }, [model, step.usecase.id]);
  const afterValue = !a ? "" : a.error ? "unchanged" : !a.after ? "" : a.after.type === "states" ? `state:${a.after.stateIds?.[0] ?? ""}` : a.after.type;
  const pickAfter = (value: string) => {
    if (value === "") save({ after: null });
    else if (value.startsWith("state:")) save({ after: { type: "states", stateIds: [value.slice("state:".length)] } });
    else save({ after: { type: value as AlternateAfterType } });
  };
  // 操作が 2 つ以上の状態グループに関わるときは、グループごとに状態を選べるようにする (予約は取消、部屋は清掃待ち、のように)
  const afterGroups = useMemo(() => {
    const groups: { key: string; label: string; states: typeof afterStates }[] = [];
    for (const st of afterStates) {
      const key = stateGroupKey(st);
      const g = groups.find((x) => x.key === key);
      if (g) g.states.push(st);
      else groups.push({ key, label: st.group?.trim() || st.name || "(名前なし)", states: [st] });
    }
    return groups;
  }, [afterStates]);
  const multi = afterGroups.length > 1;
  // 「状態を選ぶ」を選んでから、最初の状態を選ぶまでのあいだ (状態が 1 つも無いままでは保存できない)
  const [choosing, setChoosing] = useState(false);
  const chosenIds = a?.after?.type === "states" ? (a.after.stateIds ?? []) : [];
  const chosenIn = (key: string): string => afterStates.find((st) => stateGroupKey(st) === key && chosenIds.includes(st.id))?.id ?? "";
  const multiValue = !a ? "" : a.error ? "unchanged" : a.after?.type === "states" || choosing ? "states" : (a.after?.type ?? "");
  const pickMulti = (value: string) => {
    setChoosing(value === "states");
    if (value === "states") return;
    pickAfter(value);
  };
  /** グループごとの状態を選ぶ。どのグループも「変えない」になったら、全体を「変えない」にする */
  const pickGroupState = (key: string, stateId: string) => {
    const ids = afterGroups.flatMap((g) => {
      const id = g.key === key ? stateId : chosenIn(g.key);
      return id ? [id] : [];
    });
    setChoosing(false);
    save({ after: ids.length > 0 ? { type: "states", stateIds: ids } : { type: "unchanged" } });
  };
  /** そのあとの状態が、まだ決まっていない (操作がふだん状態を変えるのに、分岐のあとの状態が無い) */
  const afterUndecided = !!a && step.changesState && step.after === null;
  /** 選択肢の値: エラーは error:<種類>、出来事はイベントの id */
  const outcomeValue = a?.error ? `error:${a.error.type}` : (a?.eventId ?? "");
  const pickOutcome = (value: string) => {
    if (value.startsWith("error:")) save({ error: { type: value.slice("error:".length) as AlternateErrorType } });
    else save({ eventId: value === "" ? null : value });
  };
  /** HTTP ステータスを確定する。空なら外す。数でない・範囲の外なら、知らせて、もとの値に戻す */
  const commitStatus = (input: HTMLInputElement) => {
    const text = input.value.trim();
    const status = text === "" ? null : Number(text);
    if (status !== null && !Number.isInteger(status)) {
      pushToast(`HTTP ステータスは ${HTTP_STATUS_MIN}〜${HTTP_STATUS_MAX} の整数にしてください: ${text}`, "error");
      input.value = a?.error?.status !== undefined ? String(a.error.status) : "";
      return;
    }
    if ((status ?? undefined) === a?.error?.status) return;
    if (!save({ error: { type: "server", status } })) input.value = a?.error?.status !== undefined ? String(a.error.status) : "";
  };
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);
  const events = model.elements.filter((e) => e.kind === "event");
  const label = `${step.usecase.name}・${step.condition.name}`;
  return (
    <tr ref={ref} className={`${a && !afterUndecided ? "" : "is-undecided"}${focused ? " is-focus" : ""}`} data-testid={`alternate-${step.relationId}`}>
      <th scope="row">{step.usecase.name || "(名前なし)"}</th>
      <td>
        {step.condition.name || "(名前なし)"}
        {step.condition.description && <span className="an-sub">{step.condition.description}</span>}
      </td>
      <td>
        <select
          aria-label={`${label} の、ふだんと違う流れになるとき`}
          value={when}
          disabled={readOnly}
          onChange={(e) => {
            const next = e.target.value as AlternateWhen;
            setDraftWhen(next);
            if (a) save({ when: next });
          }}
        >
          {ALTERNATE_WHENS.map((w) => (
            <option key={w} value={w}>
              {ALTERNATE_WHEN_LABELS[w]}
            </option>
          ))}
        </select>
      </td>
      <td className="seq-then">
        <CommitField label={`${label} のとき、どうなるか`} value={a?.then ?? ""} multiline maxLength={DESCRIPTION_MAX_LENGTH} readOnly={readOnly} placeholder="未定 (例: 受け付けずに、理由を伝える)" onCommit={(v) => v.trim() !== (a?.then ?? "") && save({ then: v })} />
      </td>
      <td>
        <select aria-label={`${label} のとき、起きる出来事`} value={outcomeValue} disabled={readOnly || !a} title={a ? undefined : "先に、どうなるかを書いてください"} onChange={(e) => pickOutcome(e.target.value)}>
          <option value="">(なし)</option>
          <optgroup label="エラー">
            {ALTERNATE_ERROR_TYPES.map((type) => (
              <option key={type} value={`error:${type}`}>
                {ALTERNATE_ERROR_LABELS[type]}
              </option>
            ))}
          </optgroup>
          {events.length > 0 && (
            <optgroup label="出来事 (分析のイベント)">
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>
                  {ev.name || "(名前なし)"}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {a?.error?.type === "server" && (
          <label className="seq-status">
            HTTP ステータス
            <input
              key={`${step.relationId}:${a.error.status ?? ""}`}
              aria-label={`${label} のとき、HTTP ステータス`}
              inputMode="numeric"
              list="seq-http-statuses"
              placeholder="例: 404"
              defaultValue={a.error.status ?? ""}
              disabled={readOnly}
              onBlur={(e) => commitStatus(e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
        )}
      </td>
      <td>
        {afterStates.length === 0 && !step.changesState ? (
          <span className="an-sub" title="この操作は、状態に関わらない">
            —
          </span>
        ) : multi ? (
          <>
            <select
              aria-label={`${label} のとき、そのあとの状態`}
              value={multiValue}
              disabled={readOnly || !a || !!a.error}
              title={!a ? "先に、どうなるかを書いてください" : a.error ? "エラーのときは、状態を変えません" : undefined}
              className={afterUndecided && !choosing ? "is-undecided" : undefined}
              onChange={(e) => pickMulti(e.target.value)}
            >
              <option value="">(未定)</option>
              <option value="unchanged">{ALTERNATE_AFTER_LABELS.unchanged}</option>
              {step.changesState && <option value="normal">{ALTERNATE_AFTER_LABELS.normal}</option>}
              <option value="states">{ALTERNATE_AFTER_LABELS.states}</option>
            </select>
            {multiValue === "states" &&
              afterGroups.map((g) => (
                <label key={g.key} className="seq-status seq-after-group">
                  {g.label}
                  <select aria-label={`${label} のとき、そのあとの「${g.label}」`} value={chosenIn(g.key)} disabled={readOnly} onChange={(e) => pickGroupState(g.key, e.target.value)}>
                    <option value="">(変えない)</option>
                    {g.states.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.name || "(名前なし)"}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
          </>
        ) : (
          <select
            aria-label={`${label} のとき、そのあとの状態`}
            value={afterValue}
            disabled={readOnly || !a || !!a.error}
            title={!a ? "先に、どうなるかを書いてください" : a.error ? "エラーのときは、状態を変えません" : undefined}
            className={afterUndecided ? "is-undecided" : undefined}
            onChange={(e) => pickAfter(e.target.value)}
          >
            <option value="">(未定)</option>
            <option value="unchanged">{ALTERNATE_AFTER_LABELS.unchanged}</option>
            {step.changesState && <option value="normal">{ALTERNATE_AFTER_LABELS.normal}</option>}
            {afterStates.length > 0 && (
              <optgroup label="この状態になる">
                {afterStates.map((st) => (
                  <option key={st.id} value={`state:${st.id}`}>
                    {st.name || "(名前なし)"}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- ボード

const SEQUENCE_KEY = "untie.design.sequenceBusiness";

/**
 * 設計モードのシーケンス図: 業務ごとに、誰が・どのシステムに・何をして・何が起きるかを、分析から導いて見せる。
 * 条件で流れが変わるところ (分岐) を並べ、そのときどうなるか (代替パターン) を決めて保存する。開発を始める前に、分岐を決め切るための画面
 */
export function SequenceBoard() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const readOnly = useUntieStore(selectReadOnly);
  const all = useMemo(() => deriveSequences(model, systemId), [model, systemId]);
  // 設計の対象のシステムが登場する業務だけを並べる
  const sequences = all.filter((s) => s.touchesSystem);
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SEQUENCE_KEY);
    } catch {
      return null;
    }
  });
  const [focus, setFocus] = useState<string | null>(null);
  const sequence = sequences.find((s) => s.id === picked) ?? sequences[0];
  const pick = (id: string) => {
    setPicked(id);
    setFocus(null);
    try {
      localStorage.setItem(SEQUENCE_KEY, id);
    } catch {
      // 覚えられなくても切り替えはできる
    }
  };
  const systemName = model.elements.find((e) => e.id === systemId)?.name || "このシステム";
  const undecided = (s: BusinessSequence) => s.gaps.filter((g) => g.type === "alternateUndecided" || g.type === "alternateAfterUndecided").length;
  if (!sequence) {
    return (
      <section className="domain-board seq-board" aria-label="設計ボード: シーケンス図">
        <div className="dsl-toolbar domain-toolbar">
          <h2 className="dsl-title">シーケンス図</h2>
        </div>
        <p className="hint domain-empty">「{systemName}」を使う業務がまだありません。分析で、作業が使う操作の対象 (このシステムか、その画面) を結ぶと、ここに業務の流れが出ます</p>
      </section>
    );
  }
  const alternates = sequence.steps.filter((s): s is AlternateStep => s.type === "alternate");
  const others = sequence.gaps.filter((g) => g.type !== "alternateUndecided" && g.type !== "alternateAfterUndecided");
  return (
    <section className="domain-board seq-board" aria-label="設計ボード: シーケンス図">
      <div className="dsl-toolbar domain-toolbar">
        <h2 className="dsl-title">シーケンス図</h2>
        <label className="seq-pick">
          業務
          <select aria-label="業務" value={sequence.id} onChange={(e) => pick(e.target.value)}>
            {sequences.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {undecided(s) > 0 ? ` (未定 ${undecided(s)})` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint domain-hint">
        業務の流れを、分析から導いています。上から順に、担当が操作し (実線)、出来事が起きて次が動きます (破線)。橙の枠は、条件で流れが変わるところ (分岐) です。赤い枠は、そのときどうなるかがまだ決まっていません。下の表で決めてください
      </p>
      <div className="domain-scroll seq-scroll">
        <div className="seq-canvas" data-testid="sequence-diagram">
          <Diagram sequence={sequence} focus={focus} onPickAlternate={setFocus} />
        </div>
        <h3 className="contextmap-title">分岐 (条件で流れが変わるところ)</h3>
        {alternates.length === 0 ? (
          <p className="hint">この業務には、条件で流れが変わるところがありません。条件があるのに出ていなければ、分析で、操作に「判断」の条件を結んでください</p>
        ) : (
          <table className="an-table seq-alternates" aria-label="分岐">
            <caption className="seq-caption">
              {/* HTTP ステータスの候補 (ほかの値も入れられる) */}
              <datalist id="seq-http-statuses">
                {COMMON_HTTP_STATUSES.map((x) => (
                  <option key={x.status} value={x.status}>
                    {x.label}
                  </option>
                ))}
              </datalist>
            </caption>
            <thead>
              <tr>
                <th>操作</th>
                <th>条件</th>
                <th>いつ</th>
                <th>どうなるか</th>
                <th>起きる出来事・エラー</th>
                <th>そのあとの状態</th>
              </tr>
            </thead>
            <tbody>
              {alternates.map((step) => (
                <AlternateRow key={step.relationId} step={step} model={model} readOnly={readOnly} focused={focus === step.relationId} />
              ))}
            </tbody>
          </table>
        )}
        {others.length > 0 && (
          <>
            <h3 className="contextmap-title">決まっていないこと</h3>
            <ul className="seq-gaps">
              {others.map((g, i) => (
                <li key={i}>{g.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}

/** 右のペイン (シーケンス図): 図の読み方 */
export function SequenceHelp() {
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">図の読み方</h2>
      <div className="editor">
        <p className="hint">開発を始める前に、業務の流れと、ふだんと違う流れ (分岐) を出し切るための図です。中身は分析から導くので、流れを変えるときは分析 (作業・操作・出来事) を直します</p>
        <dl className="contextmap-legend">
          <div>
            <dt>縦の線</dt>
            <dd>担当 (人) と、操作の対象 (システム・帳票)。青い枠が、設計の対象のシステム</dd>
          </div>
          <div>
            <dt>帯 (作業)</dt>
            <dd>作業の区切り。起点 (前の作業・出来事) の順に、上から並ぶ</dd>
          </div>
          <div>
            <dt>実線の矢印</dt>
            <dd>担当が操作する。[ ] の中は使う画面</dd>
          </div>
          <div>
            <dt>破線の矢印</dt>
            <dd>出来事が起きて、次の操作が動く。(自動) は、人が担当しない操作</dd>
          </div>
          <div>
            <dt>エラー</dt>
            <dd>分岐の結果がエラーのとき、表の「起きる出来事・エラー」で選ぶ。入力エラーは、利用者が入力を直せば進めるもの。サーバーエラーは、利用者には直せない失敗で、HTTP ステータス (404 など) を入れると、ステータス別の共通のメッセージの画面になる</dd>
          </div>
          <div>
            <dt>そのあとの状態</dt>
            <dd>操作がふだん状態を変えるなら、分岐のあとの状態も決める。変えない (受け付けない、など)・ふだんと同じ (ひと手間を足して、そのまま進む)・別の状態になる、のどれか。エラーのときは、変えない</dd>
          </div>
          <div>
            <dt>小さな枠</dt>
            <dd>その操作が書く情報・読む情報と、状態の変化</dd>
          </div>
          <div>
            <dt>分岐 (橙の枠)</dt>
            <dd>操作が判断する条件。そのときどうなるかを、下の表で決める。赤い枠は未定</dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}
