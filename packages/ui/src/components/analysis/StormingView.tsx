// 分析ボード「イベントストーミング」: 分析からドメインモデル (DDD) の候補を導いて見せる。モデルには保存しない (段階 1a: 読むだけ)
import { useMemo } from "react";
import { cachedDomainModel } from "@untie/core/model/domainCache";
import { AGGREGATE_ROLE_LABELS, type AggregateCandidate, type CommandCandidate, type DomainDerivation, type DomainEventRow } from "@untie/core/model/domainModel";
import {
  DOMAIN_NOTICE_HINTS,
  DOMAIN_NOTICE_LEVEL_LABELS,
  DOMAIN_NOTICE_LEVELS,
  DOMAIN_NOTICE_TITLES,
  groupDomainNotices,
  type DomainNotice,
  type DomainNoticeType,
} from "@untie/core/model/domainNotices";
import { describeEventTiming, type Element, type UntieModel } from "@untie/core/model/types";
import { El } from "./analysisParts";

export function StormingView({ model }: { model: UntieModel }) {
  const { derivation, notices } = cachedDomainModel(model);
  const byId = useMemo(() => new Map(model.elements.map((e) => [e.id, e])), [model]);
  const get = (id: string) => byId.get(id);
  return (
    <div className="an-scroll an-storming">
      <NoticeList notices={notices} get={get} />
      <StormingTable commands={derivation.commands} events={derivation.events} notices={notices} />
      <AggregateTable derivation={derivation} />
      <PolicyTable derivation={derivation} />
      <QueryTable derivation={derivation} />
    </div>
  );
}

// ---------------------------------------------------------------- 気づき

/** 気づきの一覧 (種類ごとに畳む。問いは開いて出す)。設計モードのドメインボードの右のペインでも使う */
export function NoticeList({ notices, get }: { notices: DomainNotice[]; get: (id: string) => Element | undefined }) {
  const groups = useMemo(() => groupDomainNotices(notices), [notices]);
  const questions = notices.filter((n) => n.level === "question").length;
  return (
    <section className="an-notices" aria-label="気づき">
      <h3 className="an-subtitle">
        気づき
        <span className="an-count">問い {questions} 件・情報 {notices.length - questions} 件</span>
      </h3>
      {groups.length === 0 ? (
        <p className="hint">気づきはありません。</p>
      ) : (
        groups.map((g) => (
          <details key={g.type} className={`an-notice-group level-${g.level}`} open={g.level === "question"} data-testid={`notice-${g.type}`}>
            <summary>
              <span className={`an-note level-${g.level}`}>{DOMAIN_NOTICE_LEVEL_LABELS[g.level]}</span>
              {DOMAIN_NOTICE_TITLES[g.type]}
              <span className="an-count">{g.notices.length} 件</span>
            </summary>
            <p className="hint an-notice-hint">{DOMAIN_NOTICE_HINTS[g.type]}</p>
            <ul className="an-sublist an-notice-items">
              {g.notices.map((n, i) => (
                <li key={`${n.elementIds[0] ?? ""}-${i}`}>
                  <span className="an-notice-message">{n.message}</span>
                  <NoticeElements notice={n} get={get} />
                </li>
              ))}
            </ul>
          </details>
        ))
      )}
    </section>
  );
}

/** 気づきの要素のボタン。主役 (先頭) と、メッセージに名前が出ていない要素だけを出し、多ければ畳む */
const MAX_NOTICE_ELEMENTS = 6;
function NoticeElements({ notice, get }: { notice: DomainNotice; get: (id: string) => Element | undefined }) {
  const elements = notice.elementIds.map((id, i) => ({ id, element: get(id), i })).filter(({ element, i }) => element && (i === 0 || !notice.message.includes(element.name)));
  const shown = elements.slice(0, MAX_NOTICE_ELEMENTS);
  return (
    <span className="an-list">
      {shown.map(({ id, element }) => (
        <El key={id} element={element} />
      ))}
      {elements.length > shown.length && <span className="an-sub">ほか {elements.length - shown.length} 件</span>}
    </span>
  );
}

// ---------------------------------------------------------------- イベントストーミングの表

function Actors({ c }: { c: CommandCandidate }) {
  if (c.auto) {
    return (
      <span className="an-list">
        <span className="an-role role-auto">自動</span>
        {c.triggeredBy.length > 0 && (
          <span className="an-sub">
            きっかけ:{" "}
            {c.triggeredBy.map((e) => (
              <El key={e.id} element={e} plain />
            ))}
          </span>
        )}
      </span>
    );
  }
  if (c.actors.length === 0) return <span className="an-sub">{c.activities.length === 0 ? "(作業なし)" : "(担当なし)"}</span>;
  return (
    <span className="an-list">
      {c.actors.map((a) => (
        <El key={a.id} element={a} plain />
      ))}
    </span>
  );
}

/** 担い手 | コマンド | 集約 | イベント | 備考 の表。設計モードのドメインボードは、対象のシステムにしぼった候補を渡す */
export function StormingTable({ commands, events, notices }: { commands: CommandCandidate[]; events: DomainEventRow[]; notices: DomainNotice[] }) {
  // コマンド候補のキー → 気づきの種類 (行ごとに一覧を回さない)
  const notesByKey = useMemo(() => {
    const map = new Map<string, DomainNoticeType[]>();
    for (const n of notices) {
      if (!n.commandKey) continue;
      const list = map.get(n.commandKey) ?? [];
      if (!list.includes(n.type)) list.push(n.type);
      map.set(n.commandKey, list);
    }
    return map;
  }, [notices]);
  const notesOf = (key: string) => notesByKey.get(key) ?? [];
  // 操作から出ないイベント (システムが直接出す・時間のイベント) は、コマンド無しの行にする
  const systemRows = events.filter((e) => e.usecases.length === 0 && (e.systems.length > 0 || e.timed));
  return (
    <section aria-label="イベントストーミングの表">
      <h3 className="an-subtitle">
        イベントストーミングの表
        <span className="an-count">コマンド候補 {commands.length} 件・イベント {events.length} 件</span>
      </h3>
      {commands.length === 0 && systemRows.length === 0 ? (
        <p className="hint">情報を書く操作がまだありません。操作に扱う情報 (保存) を結ぶと、コマンドの候補が出ます。</p>
      ) : (
        <table className="an-table an-storming-table">
          <thead>
            <tr>
              <th>担い手 (Actor)</th>
              <th>コマンド (候補)</th>
              <th>集約 (候補)</th>
              <th>イベント</th>
              <th>備考</th>
            </tr>
          </thead>
          <tbody>
            {commands.map((c) => (
              <tr key={c.key} data-testid={`storming-${c.key}`}>
                <td>
                  <Actors c={c} />
                </td>
                <td>
                  <El element={c.usecase} />
                  {c.readOnly && <span className="an-role role-readonly">取得だけ</span>}
                  {c.activity && (
                    <span className="an-sub">
                      作業: <El element={c.activity} plain />
                    </span>
                  )}
                  {c.place && <span className="an-sub">対象: {c.place.name}</span>}
                </td>
                <td>
                  {c.aggregate ? <El element={c.aggregate} /> : <span className="an-empty">—</span>}
                  {c.writes.length > 1 && (
                    <span className="an-sub">
                      書く: {c.writes.map((w) => w.name).join("・")}
                    </span>
                  )}
                  {c.postStates.length > 0 && <span className="an-sub">→ {c.postStates.map((s) => s.name).join("・")}</span>}
                </td>
                <td>
                  {c.events.length === 0 ? (
                    <span className="an-empty">—</span>
                  ) : (
                    <span className="an-list">
                      {c.events.map((e) => (
                        <El key={e.id} element={e} />
                      ))}
                    </span>
                  )}
                </td>
                <td>
                  <span className="an-list">
                    {notesOf(c.key).map((t) => (
                      <span key={t} className={`an-note level-${DOMAIN_NOTICE_LEVELS[t]}`} title={DOMAIN_NOTICE_HINTS[t]}>
                        {DOMAIN_NOTICE_TITLES[t]}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
            {systemRows.map((e) => (
              <tr key={e.event.id} data-testid={`storming-event-${e.event.id}`}>
                <td>
                  <span className="an-list">
                    {e.systems.map((s) => (
                      <El key={s.id} element={s} plain />
                    ))}
                    {e.timed && <span className="an-role role-timed">時間</span>}
                  </span>
                </td>
                <td>
                  <span className="an-empty">— (コマンド無し)</span>
                </td>
                <td>
                  <span className="an-empty">—</span>
                </td>
                <td>
                  <El element={e.event} />
                  {e.event.timing && <span className="an-sub">{describeEventTiming(e.event.timing)}</span>}
                </td>
                <td>
                  <span className="an-sub">{e.timed ? "時間のイベント (コマンド無し、発生元はシステム)" : "システムが直接発生させる"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 集約候補

function AggregateRow({ a }: { a: AggregateCandidate }) {
  const commands = [...new Map(a.commands.map((c) => [c.usecase.id, c.usecase])).values()];
  return (
    <tr data-testid={`aggregate-${a.information.id}`}>
      <th scope="row">
        <El element={a.information} />
      </th>
      <td>
        <span className={`an-role role-agg-${a.role}`}>{AGGREGATE_ROLE_LABELS[a.role]}</span>
      </td>
      <td>
        {a.stateGroups.length > 0 ? (
          <>
            {a.stateGroups.join("・")}
            <span className="an-sub">{a.states.map((s) => s.name).join(" → ")}</span>
          </>
        ) : (
          <span className="an-empty">—</span>
        )}
      </td>
      <td>
        {commands.length === 0 ? (
          <span className="an-empty">—</span>
        ) : (
          <span className="an-list">
            {commands.map((u) => (
              <El key={u.id} element={u} />
            ))}
          </span>
        )}
      </td>
      <td>
        {a.related.length === 0 ? (
          <span className="an-empty">—</span>
        ) : (
          <span className="an-list">
            {a.related.map((i) => (
              <El key={i.id} element={i} plain />
            ))}
          </span>
        )}
      </td>
      <td>
        {a.coWritten.length === 0 ? (
          <span className="an-empty">—</span>
        ) : (
          <span className="an-list">
            {a.coWritten.map((i) => (
              <El key={i.id} element={i} plain />
            ))}
          </span>
        )}
      </td>
    </tr>
  );
}

function AggregateTable({ derivation }: { derivation: DomainDerivation }) {
  if (derivation.aggregates.length === 0) return null;
  return (
    <section aria-label="集約の候補">
      <h3 className="an-subtitle">
        集約の候補 (コンテキストごと)
        <span className="an-count">情報 {derivation.aggregates.length} 件</span>
      </h3>
      <p className="hint">
        状態グループの持ち主の情報をルートの候補にします。関連する情報は ID で参照するものとみなし、同じ操作で一緒に書かれる情報だけを「同じ集約か」の問いにします。参照データは書く操作の無い情報です。
      </p>
      {derivation.contexts.map((c) => (
        <div key={c.context?.id ?? "none"} className="an-screen-table" data-testid={`context-${c.context?.id ?? "none"}`}>
          <h4 className="an-block-title">
            {c.context ? <El element={c.context} /> : "未分類"}
            {c.businesses.length > 0 && (
              <span className="an-sub">
                関わる業務:{" "}
                {c.businesses.map((b, i) => (
                  <span key={b.id}>
                    {i > 0 && "、"}
                    <El element={b} plain />
                  </span>
                ))}
              </span>
            )}
          </h4>
          {c.aggregates.length === 0 ? (
            <p className="hint">情報はありません。</p>
          ) : (
            <table className="an-table">
              <thead>
                <tr>
                  <th>情報</th>
                  <th>区分</th>
                  <th>状態グループ</th>
                  <th>書くコマンド (候補)</th>
                  <th>関連する情報 (ID 参照)</th>
                  <th>一緒に書かれる情報</th>
                </tr>
              </thead>
              <tbody>
                {c.aggregates.map((a) => (
                  <AggregateRow key={a.information.id} a={a} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- ポリシー候補・読み取りモデル候補

function PolicyTable({ derivation }: { derivation: DomainDerivation }) {
  return (
    <section aria-label="ポリシーの候補">
      <h3 className="an-subtitle">
        ポリシーの候補 (イベント → 操作)
        <span className="an-count">{derivation.policies.length} 件</span>
      </h3>
      {derivation.policies.length === 0 ? (
        <p className="hint">イベントをきっかけにする操作がまだありません。</p>
      ) : (
        <table className="an-table">
          <thead>
            <tr>
              <th>イベント</th>
              <th>操作</th>
              <th>誰が</th>
              <th>備考</th>
            </tr>
          </thead>
          <tbody>
            {derivation.policies.map((p) => (
              <tr key={p.key} data-testid={`policy-${p.key}`}>
                <td>
                  <El element={p.event} />
                </td>
                <td>
                  <El element={p.usecase} />
                </td>
                <td>
                  {p.auto ? (
                    <span className="an-role role-auto">自動</span>
                  ) : (
                    <span className="an-list">
                      <span className="an-role role-human">人</span>
                      {p.activities.map((a) => (
                        <El key={a.id} element={a} plain />
                      ))}
                    </span>
                  )}
                </td>
                <td>{p.crossesContext && <span className="an-flag">コンテキストをまたぐ</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function QueryTable({ derivation }: { derivation: DomainDerivation }) {
  if (derivation.queries.length === 0) return null;
  return (
    <section aria-label="読み取りモデルの候補">
      <h3 className="an-subtitle">
        読み取りモデルの候補 (取得だけの操作)
        <span className="an-count">{derivation.queries.length} 件</span>
      </h3>
      <table className="an-table">
        <thead>
          <tr>
            <th>操作</th>
            <th>画面</th>
            <th>情報</th>
            <th>使う作業</th>
          </tr>
        </thead>
        <tbody>
          {derivation.queries.map((q) => (
            <tr key={q.usecase.id} data-testid={`query-${q.usecase.id}`}>
              <td>
                <El element={q.usecase} />
              </td>
              <td>{q.screen ? <El element={q.screen} plain /> : <span className="an-empty">—</span>}</td>
              <td>
                <span className="an-list">
                  {q.reads.map((i) => (
                    <El key={i.id} element={i} plain />
                  ))}
                </span>
              </td>
              <td>
                {q.activities.length === 0 ? (
                  <span className="an-sub">(作業なし)</span>
                ) : (
                  <span className="an-list">
                    {q.activities.map((a) => (
                      <El key={a.id} element={a} plain />
                    ))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
