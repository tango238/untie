// ドメインモデルの候補 (domainModel.ts) から見つかる気づき。モデルには保存せず、毎回組み立てる純粋関数だけを置く。
// 分析の検証 (trace.ts の途切れ・エラー・警告) とは別の枠で、ほとんどは分析の誤りではなく「境界」や「あるべき姿」の判断を示すものなので、
// 区分は「問い」(人が答えを決める) と「情報」(知っておくこと) の 2 つにし、警告にはしない (サンプルの検証の警告は空のまま)。
import { deriveDomainModel, type CommandCandidate, type DomainDerivation } from "./domainModel";
import { informationPlaces } from "./placement";
import type { Element, Information, Issue, UntieModel } from "./types";

export type DomainNoticeLevel = "question" | "info";

export const DOMAIN_NOTICE_LEVEL_LABELS: Record<DomainNoticeLevel, string> = { question: "問い", info: "情報" };

export type DomainNoticeType =
  | "boundaryStateChange"
  | "readOnlyChangesState"
  | "readOnlyEmitsEvent"
  | "sharedCommand"
  | "issueOnCommand"
  | "stateGroupOwnerUnknown"
  | "stateOwnerMismatch"
  | "contextWithManyStateGroups"
  | "conditionWithoutFailureEvent"
  | "coWritten"
  | "homonym"
  | "eventWithoutConsumer"
  | "commandWithoutEvent"
  | "fewEvents"
  | "noEvents";

export interface DomainNotice {
  type: DomainNoticeType;
  level: DomainNoticeLevel;
  /** 1 行の説明 (要素名を含む) */
  message: string;
  /** 関わる要素 (先頭が主役) */
  elementIds: string[];
  /** コマンド候補に付くなら、そのキー */
  commandKey?: string;
}

export const DOMAIN_NOTICE_LEVELS: Record<DomainNoticeType, DomainNoticeLevel> = {
  boundaryStateChange: "question",
  readOnlyChangesState: "question",
  readOnlyEmitsEvent: "question",
  sharedCommand: "question",
  issueOnCommand: "question",
  stateGroupOwnerUnknown: "question",
  stateOwnerMismatch: "question",
  contextWithManyStateGroups: "question",
  conditionWithoutFailureEvent: "question",
  coWritten: "question",
  homonym: "question",
  eventWithoutConsumer: "info",
  commandWithoutEvent: "info",
  fewEvents: "info",
  noEvents: "info",
};

/** 出す順 (問い → 情報。問いは境界に関わるものから) */
export const DOMAIN_NOTICE_ORDER: readonly DomainNoticeType[] = [
  "boundaryStateChange",
  "stateOwnerMismatch",
  "stateGroupOwnerUnknown",
  "contextWithManyStateGroups",
  "readOnlyChangesState",
  "readOnlyEmitsEvent",
  "sharedCommand",
  "issueOnCommand",
  "coWritten",
  "conditionWithoutFailureEvent",
  "homonym",
  "eventWithoutConsumer",
  "commandWithoutEvent",
  "fewEvents",
  "noEvents",
];

export const DOMAIN_NOTICE_TITLES: Record<DomainNoticeType, string> = {
  boundaryStateChange: "別のシステムの操作が状態を変えている",
  readOnlyChangesState: "読むだけの操作が状態を変えている",
  readOnlyEmitsEvent: "読むだけの操作がイベントを発生させている",
  sharedCommand: "複数の作業が同じ書く操作を使っている",
  issueOnCommand: "課題の対象の操作がコマンド候補になっている",
  stateGroupOwnerUnknown: "状態グループの持ち主が決まらない",
  stateOwnerMismatch: "状態を変える操作が、その持ち主の情報を書いていない",
  contextWithManyStateGroups: "1 つのコンテキストに状態グループが複数ある",
  conditionWithoutFailureEvent: "条件を満たさないときの結果が無い",
  coWritten: "同じ操作で一緒に書く情報がある",
  homonym: "同じ語が別のコンテキストに出ている",
  eventWithoutConsumer: "受け手の無いイベント",
  commandWithoutEvent: "イベントを発生させない書く操作",
  fewEvents: "イベントがまだ少ない",
  noEvents: "イベントがまだ無い",
};

/** 問いの説明 (何を決めるか) と、情報の説明 */
export const DOMAIN_NOTICE_HINTS: Record<DomainNoticeType, string> = {
  boundaryStateChange:
    "その情報を保存しないシステムの操作が、状態を変えています。別のコンテキストの出来事として、イベントで受けてから自分の操作で状態を変える形 (イベント + ポリシー) にしますか。分析の access は変えなくてよい",
  readOnlyChangesState: "取得だけの操作が状態を変えています。状態を変えるなら、扱い方を「取得・保存」(省略) にするか、記録の操作と出来事を分けるかを決める",
  readOnlyEmitsEvent: "取得だけの操作がイベントを発生させています。人の「出す・報告する」をドメインの出来事にするか、それとも通知だけにするかを決める",
  sharedCommand: "同じ操作を複数の作業が使っています。作業ごとに意図が違うなら、コマンドは作業ごとに分ける (表では作業ごとの行にしてある)",
  issueOnCommand: "課題の付いた操作をそのままコマンドにすると、現状の手順 (転記や紙への記入) を写すことになります。あるべき姿では取り込みや自動化に置き換えるかを決める",
  stateGroupOwnerUnknown: "遷移させる操作が書く情報が複数あり、どの情報の状態かが決まりません。集約のルートを決めるときに人が選ぶ",
  stateOwnerMismatch: "状態グループの持ち主 (最も多く書かれる情報) と、この操作が書く情報が違います。どの情報の状態が変わるのかを決める",
  contextWithManyStateGroups: "状態グループが複数あるコンテキストは、別の集約やコンテキストに分かれる候補です",
  conditionWithoutFailureEvent: "条件はあるのに、結果のイベントが 1 つだけです。条件を満たさなかったときに何が起きるか (失敗のイベント) を決める",
  coWritten: "同じ操作で一緒に書く情報は、同じ集約にするか、イベントで結果整合にするか、別のプロセスにするかを決める",
  homonym: "情報の名前と同じ語が、別のコンテキストの要素の名前にも出ています。同じ意味か、別の意味 (別の用語) かを決める",
  eventWithoutConsumer: "きっかけにする操作も作業も無いイベントです。出す意味があるか、受け手を書き足すかを見直す",
  commandWithoutEvent: "情報を書くのにイベントを発生させない操作です。結果をイベントで表すと、ポリシーや別のコンテキストへの連携を導けます (帳票への記入は除く)",
  fewEvents: "情報を書く操作の多くがイベントを発生させていません。操作が発生させるイベントを書き足すと、ポリシーやコンテキスト間の連携を導けます (帳票への記入は除く)",
  noEvents: "イベントが無いので、ドメインイベント・ポリシー・コンテキスト間の連携は導けません。操作が発生させるイベントを書き足すと候補が出ます",
};

const nameOf = (e: Element | undefined) => (e ? e.name || "(名前なし)" : "?");

/** 気づきを組み立てる。derivation を渡せば使い回す */
export function domainNotices(model: UntieModel, derivation: DomainDerivation = deriveDomainModel(model)): DomainNotice[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);
  const places = informationPlaces(model);
  const storesOf = (informationId: string) => (places.get(informationId) ?? []).filter((d) => d.roles.includes("store")).map((d) => d.id);
  const ownerOfGroup = new Map(derivation.stateGroups.map((g) => [g.group, g]));
  const issues = model.elements.filter((e): e is Issue => e.kind === "issue");
  const out: DomainNotice[] = [];
  const push = (type: DomainNoticeType, message: string, elementIds: string[], commandKey?: string) =>
    out.push({ type, level: DOMAIN_NOTICE_LEVELS[type], message, elementIds, ...(commandKey ? { commandKey } : {}) });

  // 状態を変える操作 (コマンド候補・クエリ候補の両方) について、境界か・持ち主か・読むだけか
  const stateChangers: { usecaseId: string; writes: Information[]; postStateIds: string[]; readOnly: boolean; commandKeys: string[] }[] = [];
  const seen = new Set<string>();
  for (const c of derivation.commands) {
    if (seen.has(c.usecase.id)) continue;
    seen.add(c.usecase.id);
    stateChangers.push({
      usecaseId: c.usecase.id,
      writes: c.writes,
      postStateIds: c.postStates.map((s) => s.id),
      readOnly: false,
      commandKeys: derivation.commands.filter((x) => x.usecase.id === c.usecase.id).map((x) => x.key),
    });
  }
  for (const q of derivation.queries) stateChangers.push({ usecaseId: q.usecase.id, writes: [], postStateIds: q.postStates.map((s) => s.id), readOnly: true, commandKeys: [] });
  const placeOfUsecase = (usecaseId: string) => derivation.commands.find((c) => c.usecase.id === usecaseId)?.place ?? queryPlace(model, usecaseId);
  const boundary = new Set<string>();

  for (const u of stateChangers) {
    const usecase = get(u.usecaseId);
    if (u.postStateIds.length === 0) continue;
    const groups = [...new Set(u.postStateIds.map((id) => (get(id) as { group?: string } | undefined)?.group).filter((g): g is string => !!g))];
    for (const group of groups) {
      const owner = ownerOfGroup.get(group)?.owner;
      if (!owner) continue; // 持ち主が決まらないのは別の気づき
      const place = placeOfUsecase(u.usecaseId);
      const stores = storesOf(owner.id);
      const stateNames = u.postStateIds
        .map((id) => get(id))
        .filter((s) => (s as { group?: string } | undefined)?.group === group)
        .map(nameOf)
        .join("・");
      if (place && place.kind === "system" && stores.length > 0 && !stores.includes(place.id)) {
        push(
          "boundaryStateChange",
          `「${nameOf(usecase)}」(対象: ${nameOf(place)}) は「${group}」を「${stateNames}」へ変えますが、${nameOf(place)} は「${owner.name}」の保存先ではありません`,
          [u.usecaseId, place.id, owner.id, ...u.postStateIds],
          u.commandKeys[0],
        );
        boundary.add(u.usecaseId);
        continue;
      }
      if (u.readOnly) {
        push("readOnlyChangesState", `「${nameOf(usecase)}」は情報を取得するだけですが、「${group}」を「${stateNames}」へ変えます`, [u.usecaseId, owner.id, ...u.postStateIds]);
        continue;
      }
      if (!u.writes.some((w) => w.id === owner.id)) {
        push(
          "stateOwnerMismatch",
          `「${nameOf(usecase)}」は「${group}」を「${stateNames}」へ変えますが、書くのは ${u.writes.map((w) => `「${w.name}」`).join("")} で、持ち主の「${owner.name}」は書きません`,
          [u.usecaseId, owner.id, ...u.writes.map((w) => w.id), ...u.postStateIds],
          u.commandKeys[0],
        );
      }
    }
  }

  // 読むだけでイベントを出す
  for (const q of derivation.queries) {
    if (q.events.length === 0 || boundary.has(q.usecase.id)) continue; // 境界の問いが出ている操作には重ねない
    push("readOnlyEmitsEvent", `「${q.usecase.name}」は情報を取得するだけですが、${q.events.map((e) => `「${e.name}」`).join("")} を発生させます`, [q.usecase.id, ...q.events.map((e) => e.id)]);
  }

  // 複数の作業が使う書く操作 (作業ごとに分けた候補)
  const shared = new Map<string, CommandCandidate[]>();
  for (const c of derivation.commands) if (c.activity) shared.set(c.usecase.id, [...(shared.get(c.usecase.id) ?? []), c]);
  for (const [usecaseId, cs] of shared) {
    push(
      "sharedCommand",
      `「${nameOf(get(usecaseId))}」を ${cs.length} つの作業 (${cs.map((c) => `「${c.activity!.name}」`).join("")}) が使っています`,
      [usecaseId, ...cs.map((c) => c.activity!.id)],
      cs[0]!.key,
    );
  }

  // 課題の対象の操作 (操作ごとに 1 件)
  seen.clear();
  for (const c of derivation.commands) {
    if (seen.has(c.usecase.id)) continue;
    seen.add(c.usecase.id);
    const on = issues.filter((i) => i.targetIds.includes(c.usecase.id));
    if (on.length === 0) continue;
    push("issueOnCommand", `「${c.usecase.name}」には課題 ${on.map((i) => `「${i.name}」`).join("")} が付いています`, [c.usecase.id, ...on.map((i) => i.id)], c.key);
  }

  // 状態グループの持ち主
  for (const g of derivation.stateGroups) {
    if (g.owner || g.candidates.length === 0) continue;
    push(
      "stateGroupOwnerUnknown",
      `「${g.group}」を遷移させる操作が書く情報が ${g.candidates.map((c) => `「${c.information.name}」`).join("")} に分かれ、持ち主が決まりません`,
      [...g.candidates.map((c) => c.information.id), ...g.states.map((s) => s.id)],
    );
  }

  // コンテキストに状態グループが複数
  for (const c of derivation.contexts) {
    if (!c.context || c.stateGroups.length < 2) continue;
    push("contextWithManyStateGroups", `コンテキスト「${c.context.name}」に状態グループが ${c.stateGroups.length} つあります (${c.stateGroups.map((g) => `「${g}」`).join("")})`, [
      c.context.id,
      ...c.states.map((s) => s.id),
    ]);
  }

  // 条件はあるが失敗のイベントが無い (結果のイベントが 1 つ以下)
  seen.clear();
  for (const c of derivation.commands) {
    if (seen.has(c.usecase.id) || c.conditions.length === 0 || c.events.length !== 1) continue; // イベントが無いものは「イベントを発生させない書く操作」で見る
    seen.add(c.usecase.id);
    push(
      "conditionWithoutFailureEvent",
      `「${c.usecase.name}」は条件 ${c.conditions.map((x) => `「${x.name}」`).join("")} で判断しますが、結果のイベントは「${c.events[0]!.name}」だけです`,
      [c.usecase.id, ...c.conditions.map((x) => x.id), ...c.events.map((e) => e.id)],
      c.key,
    );
  }

  // 同じ操作で一緒に書く情報 (組ごとに 1 件)
  const pairs = new Set<string>();
  for (const c of derivation.commands) {
    if (c.writes.length < 2) continue;
    for (let i = 0; i < c.writes.length; i++) {
      for (let j = i + 1; j < c.writes.length; j++) {
        const a = c.writes[i]!;
        const b = c.writes[j]!;
        const key = [a.id, b.id].sort().join("|");
        if (pairs.has(key)) continue;
        pairs.add(key);
        const writers = [...new Set(derivation.commands.filter((x) => x.writes.some((w) => w.id === a.id) && x.writes.some((w) => w.id === b.id)).map((x) => x.usecase.id))];
        push("coWritten", `「${a.name}」と「${b.name}」を ${writers.map((id) => `「${nameOf(get(id))}」`).join("")} が一緒に書きます`, [a.id, b.id, ...writers]);
      }
    }
  }

  // 同じ語が別のコンテキストに (情報の名前が、別のコンテキストの要素の名前に含まれる)
  const members = model.elements.filter(
    (e): e is Element & { contextId: string | null } => (e.kind === "information" || e.kind === "state" || e.kind === "condition" || e.kind === "variation" || e.kind === "event") && "contextId" in e,
  );
  for (const info of model.elements.filter((e): e is Information => e.kind === "information")) {
    const name = info.name.trim();
    if (name.length < 2 || !info.contextId) continue;
    const hits = members.filter((m) => m.id !== info.id && m.contextId && m.contextId !== info.contextId && m.name.includes(name));
    if (hits.length === 0) continue;
    push("homonym", `「${name}」(${nameOf(get(info.contextId))}) の語が、別のコンテキストの ${hits.map((h) => `「${h.name}」(${nameOf(get(h.contextId!))})`).join("")} にも出ています`, [
      info.id,
      ...hits.map((h) => h.id),
    ]);
  }

  // イベントまわりの情報
  if (derivation.events.length === 0) {
    const writers = [...new Set(derivation.commands.map((c) => c.usecase.id))];
    if (writers.length > 0) push("noEvents", `イベントが無く、情報を書く操作が ${writers.length} 件あります`, writers);
  } else {
    for (const e of derivation.events) {
      if (e.consumers.usecases.length > 0 || e.consumers.activities.length > 0) continue;
      push("eventWithoutConsumer", `「${e.event.name}」をきっかけにする操作も作業もありません`, [e.event.id]);
    }
    seen.clear();
    const silent: CommandCandidate[] = [];
    for (const c of derivation.commands) {
      if (seen.has(c.usecase.id) || c.events.length > 0 || c.place?.kind === "ledger") continue;
      seen.add(c.usecase.id);
      silent.push(c);
    }
    const total = new Set(derivation.commands.filter((c) => c.place?.kind !== "ledger").map((c) => c.usecase.id)).size;
    if (silent.length >= 5 && silent.length * 2 > total) {
      // イベントがまだ少ないモデルでは、操作ごとに出さず 1 件にまとめる
      push("fewEvents", `情報を書く操作 ${total} 件のうち ${silent.length} 件がイベントを発生させません`, silent.map((c) => c.usecase.id));
    } else {
      for (const c of silent) push("commandWithoutEvent", `「${c.usecase.name}」は ${c.writes.map((w) => `「${w.name}」`).join("")} を書きますが、イベントを発生させません`, [c.usecase.id, ...c.writes.map((w) => w.id)], c.key);
    }
  }

  return out.sort((a, b) => DOMAIN_NOTICE_ORDER.indexOf(a.type) - DOMAIN_NOTICE_ORDER.indexOf(b.type));
}

/** クエリ候補の操作の対象 (システム・帳票。画面ならそのシステム) */
function queryPlace(model: UntieModel, usecaseId: string): Element | null {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  for (const r of model.relations) {
    if (r.sourceId !== usecaseId) continue;
    if (r.kind === "usecaseSystem") return byId.get(r.targetId) ?? null;
    if (r.kind === "usecaseScreen") {
      const screen = byId.get(r.targetId);
      return screen && screen.kind === "screen" ? (byId.get(screen.systemId) ?? null) : null;
    }
  }
  return null;
}

/** 種類ごとにまとめる (出す順) */
export function groupDomainNotices(notices: DomainNotice[]): { type: DomainNoticeType; level: DomainNoticeLevel; notices: DomainNotice[] }[] {
  return DOMAIN_NOTICE_ORDER.map((type) => ({ type, level: DOMAIN_NOTICE_LEVELS[type], notices: notices.filter((n) => n.type === type) })).filter((g) => g.notices.length > 0);
}
