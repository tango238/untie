import type { ReactNode } from "react";
import { cachedDomainScope } from "@untie/core/model/domainCache";
import { AGGREGATE_ROLE_LABELS, type CommandCandidate } from "@untie/core/model/domainModel";
import { noticesAbout, type DomainScope } from "@untie/core/model/domainScope";
import { describeEventTiming, type Element } from "@untie/core/model/types";
import { useUntieStore } from "../../store";
import { revealOnFixedBoard } from "../actions";
import { El, ElementClickContext } from "../analysis/analysisParts";
import { NoticeList } from "../analysis/StormingView";
import { useDomainElementClick } from "./DomainBoard";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="static-value">{children}</div>
    </div>
  );
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

function RevealButton({ id, label }: { id: string; label: string }) {
  return (
    <button type="button" className="link" onClick={() => revealOnFixedBoard(id)}>
      {label}
    </button>
  );
}

function Notices({ scope, id, get }: { scope: DomainScope; id: string; get: (id: string) => Element | undefined }) {
  const notices = noticesAbout(scope, id);
  if (notices.length === 0) return null;
  return <NoticeList notices={notices} get={get} />;
}

/** 右のペイン (設計モードのドメインボード): 選んだコンテキスト・集約・イベント・コマンドの中身と根拠。何も選んでいないときは全体の数と気づき */
export function DomainProperties() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const sel = useUntieStore((s) => s.ui.designDomain);
  const scope = cachedDomainScope(model, systemId);
  const onElementClick = useDomainElementClick(scope);
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);

  let body: ReactNode;
  if (sel?.kind === "context") {
    const c = scope.contexts.find((x) => (x.context?.id ?? null) === sel.id);
    body = c ? (
      <div className="editor" data-testid="domain-context">
        <div className="kind-line">コンテキスト (候補)</div>
        <Field label="名前">{c.context?.name ?? "未分類"}</Field>
        <Field label="説明">{c.context?.description || "—"}</Field>
        <Field label="集約の候補">
          <Els elements={c.aggregates.map((a) => a.candidate.information)} />
        </Field>
        <Field label="状態グループ">{c.stateGroups.length > 0 ? c.stateGroups.join("・") : "なし"}</Field>
        <Field label="このシステムが発生させるイベント">
          <Els elements={c.events} />
        </Field>
        <Field label="関わる業務">
          <Els elements={c.businesses} />
        </Field>
        {c.context && <RevealButton id={c.context.id} label="分析のコンテキストボードで見る" />}
        {c.context && <Notices scope={scope} id={c.context.id} get={get} />}
      </div>
    ) : null;
  } else if (sel?.kind === "aggregate") {
    const a = scope.contexts.flatMap((c) => c.aggregates).find((x) => x.candidate.information.id === sel.id);
    body = a ? (
      <div className="editor" data-testid="domain-aggregate">
        <div className="kind-line">集約 (候補)</div>
        <Field label="ルートの情報">{a.candidate.information.name}</Field>
        <Field label="区分">
          {AGGREGATE_ROLE_LABELS[a.candidate.role]}
          {!a.writtenHere && <span className="an-sub">このシステムでは書かない (ほかのところが書く情報を読む)</span>}
        </Field>
        <Field label="コンテキスト">{a.candidate.context?.name ?? "未分類"}</Field>
        <Field label="状態グループ">{a.candidate.stateGroups.length > 0 ? `${a.candidate.stateGroups.join("・")}: ${a.candidate.states.map((s) => s.name).join(" → ")}` : "なし"}</Field>
        <Field label="このシステムで書くコマンド">
          <Els elements={a.commandsHere.map((c) => c.usecase)} />
        </Field>
        <Field label="ほかのところで書く操作">
          {a.commandsElsewhere.length === 0 ? (
            <span className="hint-inline">なし</span>
          ) : (
            <ul className="plain-list">
              {a.commandsElsewhere.map((c) => (
                <li key={c.usecase.id}>
                  <El element={c.usecase} />
                  <span className="an-sub">対象: {c.place?.name ?? "なし"}</span>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="保存先">
          <Els elements={a.stores} />
        </Field>
        <Field label="関連する情報 (ID で参照)">
          <Els elements={a.candidate.related} />
        </Field>
        <Field label="一緒に書かれる情報">
          <Els elements={a.candidate.coWritten} />
        </Field>
        <RevealButton id={a.candidate.information.id} label="分析の情報ボードで見る" />
        <Notices scope={scope} id={a.candidate.information.id} get={get} />
      </div>
    ) : null;
  } else if (sel?.kind === "event") {
    const e = scope.events.find((x) => x.row.event.id === sel.id);
    body = e ? (
      <div className="editor" data-testid="domain-event">
        <div className="kind-line">ドメインイベント (候補)</div>
        <Field label="名前">{e.row.event.name}</Field>
        <Field label="どこで">{e.origin === "inside" ? "このシステム (内)" : `別のところ (外): ${e.sources.map((s) => s.name).join("・") || "?"}`}</Field>
        {e.row.event.timing && <Field label="発生タイミング">{describeEventTiming(e.row.event.timing)}</Field>}
        <Field label="発生させる操作">
          <Els elements={e.row.usecases} />
        </Field>
        <Field label="直接発生させるシステム">
          <Els elements={e.row.systems} />
        </Field>
        <Field label="属性の候補 (発生元が書く情報)">
          <Els elements={e.row.properties} />
        </Field>
        <Field label="受け手">
          <Els elements={[...e.row.consumers.usecases, ...e.row.consumers.activities]} empty="なし (受け手の無いイベント)" />
        </Field>
        <Field label="コンテキスト">{e.row.context?.name ?? "未分類"}</Field>
        <RevealButton id={e.row.event.id} label="分析のイベントボードで見る" />
        <Notices scope={scope} id={e.row.event.id} get={get} />
      </div>
    ) : null;
  } else if (sel?.kind === "command") {
    const split: CommandCandidate[] = scope.splitCommands.filter((c) => c.usecase.id === sel.id);
    const c = split[0];
    body = c ? (
      <div className="editor" data-testid="domain-command">
        <div className="kind-line">コマンド (候補)</div>
        <Field label="操作">
          {c.usecase.name}
          {c.readOnly && <span className="an-role role-readonly">取得だけ</span>}
        </Field>
        <Field label="誰が">
          {c.auto ? (
            <>
              自動 <span className="an-sub">きっかけ: {c.triggeredBy.map((e) => e.name).join("・")}</span>
            </>
          ) : (
            <Els elements={c.actors} empty={c.activities.length === 0 ? "(作業なし)" : "(担当なし)"} />
          )}
        </Field>
        <Field label={split.length > 1 ? `使う作業 (${split.length} つ。作業ごとに意図が違えば、コマンドを分ける候補)` : "使う作業"}>
          <Els elements={split.flatMap((x) => x.activities)} />
        </Field>
        <Field label="集約 (候補)">
          <Els elements={[c.aggregate]} />
        </Field>
        <Field label="書く情報">
          <Els elements={c.writes} />
        </Field>
        <Field label="読む情報">
          <Els elements={c.reads} />
        </Field>
        <Field label="実行できる状態 → 次の状態">
          {c.preStates.length + c.postStates.length === 0 ? "なし" : `${c.preStates.map((s) => s.name).join("・") || "—"} → ${c.postStates.map((s) => s.name).join("・") || "—"}`}
        </Field>
        <Field label="判断に使う条件">
          <Els elements={c.conditions} />
        </Field>
        <Field label="発生させるイベント">
          <Els elements={c.events} />
        </Field>
        <Field label="きっかけのイベント">
          <Els elements={c.triggeredBy} />
        </Field>
        <RevealButton id={c.usecase.id} label="分析の操作ボードで見る" />
        <Notices scope={scope} id={c.usecase.id} get={get} />
      </div>
    ) : null;
  }

  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">プロパティ</h2>
      <ElementClickContext.Provider value={onElementClick}>
        {body ?? (
          <div className="editor" data-testid="domain-overview">
            <p className="hint">左の一覧か図で、コンテキスト・集約・コマンド・イベントを選ぶと、ここに中身と根拠が出ます</p>
            <ul className="plain-list">
              <li>コンテキスト {scope.contexts.length}</li>
              <li>集約の候補 {scope.contexts.reduce((n, c) => n + c.aggregates.length, 0)}</li>
              <li>コマンドの候補 {scope.commands.length}</li>
              <li>問い合わせ (読み取りモデル) {scope.queries.length}</li>
              <li>イベント {scope.events.length} (内 {scope.events.filter((e) => e.origin === "inside").length}・外 {scope.events.filter((e) => e.origin === "outside").length})</li>
            </ul>
            <NoticeList notices={scope.notices} get={get} />
          </div>
        )}
      </ElementClickContext.Provider>
    </aside>
  );
}
