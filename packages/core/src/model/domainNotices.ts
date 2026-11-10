// ドメインモデルの候補 (domainModel.ts) から見つかる気づき。モデルには保存せず、毎回組み立てる純粋関数だけを置く。
// 分析の検証 (trace.ts の途切れ・エラー・警告) とは別の枠で、ほとんどは分析の誤りではなく「境界」や「あるべき姿」の判断を示すものなので、
// 区分は「問い」(人が答えを決める) と「情報」(知っておくこと) の 2 つにし、警告にはしない (サンプルの検証の警告は空のまま)。
// 候補の一覧は索引 (Map) にしてから引き、操作や情報の数に対して線形で済ませる。
import { deriveDomainModel, type CommandCandidate, type DomainDerivation } from "./domainModel";
import { informationPlaces } from "./placement";
import type { Element, Information, Issue, UntieModel } from "./types";

export type DomainNoticeLevel = "question" | "info";

export const DOMAIN_NOTICE_LEVEL_LABELS: Record<DomainNoticeLevel, string> = { question: "問い", info: "情報" };

export type DomainNoticeType =
  | "boundaryStateChange"
  | "readOnlyChangesState"
  | "readOnlyEmitsEvent"
  | "ambiguousTransition"
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
  /** 関わる要素 (先頭が主役。メッセージに出る名前の要素も含める) */
  elementIds: string[];
  /** コマンド候補に付くなら、そのキー */
  commandKey?: string;
}

export const DOMAIN_NOTICE_LEVELS: Record<DomainNoticeType, DomainNoticeLevel> = {
  boundaryStateChange: "question",
  readOnlyChangesState: "question",
  readOnlyEmitsEvent: "question",
  ambiguousTransition: "question",
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
  "ambiguousTransition",
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
  ambiguousTransition: "状態の遷移の組み合わせが曖昧",
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
    "その情報を保存しないシステムの操作が、状態を変えています。別のコンテキストの出来事として、イベントで受けてから自分の操作で状態を変える形 (イベント + ポリシー) にしますか。操作が扱う情報の取得・保存の区別は変えなくてよい。",
  readOnlyChangesState: "取得だけの操作が状態を変えています。状態を変えるなら、扱い方を「取得・保存」(省略) にするか、記録の操作と出来事を分けるかを決める。",
  readOnlyEmitsEvent: "取得だけの操作がイベントを発生させています。人の「出す・報告する」をドメインの出来事にするか、それとも通知だけにするかを決める。",
  ambiguousTransition: "実行できる状態と次の状態がどちらも複数あり、どの状態からどの状態へ移るかの組み合わせが読めません。操作を分けるか、組み合わせを決める。",
  sharedCommand: "同じ操作を複数の作業が使っています。作業ごとに意図が違うなら、コマンドは作業ごとに分ける (表では作業ごとの行にしてある)。",
  issueOnCommand: "課題の付いた操作をそのままコマンドにすると、現状の手順 (転記や紙への記入) を写すことになります。あるべき姿では取り込みや自動化に置き換えるかを決める。",
  stateGroupOwnerUnknown: "どの情報の状態かが決まりません。遷移させる操作が書く情報が同数で分かれているか、遷移させる操作が情報を書いていません。集約のルートを決めるときに人が選ぶ。",
  stateOwnerMismatch: "状態グループの持ち主 (最も多く書かれる情報) と、この操作が書く情報が違います。どの情報の状態が変わるのかを決める。",
  contextWithManyStateGroups: "状態グループが複数あるコンテキストは、別の集約やコンテキストに分かれる候補です。",
  conditionWithoutFailureEvent: "条件はあるのに、結果のイベントが 1 つだけです。条件を満たさなかったときに何が起きるか (失敗のイベント) を決める。",
  coWritten: "同じ操作で一緒に書く情報は、同じ集約にするか、イベントで結果整合にするか、別のプロセスにするかを決める。",
  homonym: "情報の名前と同じ語が、別のコンテキストの要素の名前にも出ています。同じ意味か、別の意味 (別の用語) かを決める。状態やイベントが情報を指しているだけのこともある。",
  eventWithoutConsumer: "きっかけにする操作も作業も無いイベントです。出す意味があるか、受け手を書き足すかを見直す。",
  commandWithoutEvent: "情報を書くのにイベントを発生させない操作です。結果をイベントで表すと、ポリシーや別のコンテキストへの連携を導けます (帳票への記入は除く)。",
  fewEvents: "情報を書く操作の多くがイベントを発生させていません。操作が発生させるイベントを書き足すと、ポリシーやコンテキスト間の連携を導けます (帳票への記入は除く)。",
  noEvents: "イベントが無いので、ドメインイベント・ポリシー・コンテキスト間の連携は導けません。操作が発生させるイベントを書き足すと候補が出ます。",
};

const nameOf = (e: Element | undefined) => (e ? e.name || "(名前なし)" : "?");
const quote = (xs: { name: string }[]) => xs.map((x) => `「${x.name}」`).join("");

/** 気づきを組み立てる。derivation を渡せば使い回す */
export function domainNotices(model: UntieModel, derivation: DomainDerivation = deriveDomainModel(model)): DomainNotice[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);
  const places = informationPlaces(model);
  const storesOf = (informationId: string) => (places.get(informationId) ?? []).filter((d) => d.roles.includes("store")).map((d) => d.id);
  const ownerOfGroup = new Map(derivation.stateGroups.map((g) => [g.group, g]));
  // 索引: 操作 id → その操作のコマンド候補 (作業で分けたものは複数)、課題の対象 id → 課題
  const commandsOf = new Map<string, CommandCandidate[]>();
  for (const c of derivation.commands) {
    const list = commandsOf.get(c.usecase.id);
    if (list) list.push(c);
    else commandsOf.set(c.usecase.id, [c]);
  }
  const issuesOn = new Map<string, Issue[]>();
  for (const e of model.elements) {
    if (e.kind !== "issue") continue;
    for (const id of e.targetIds) {
      const list = issuesOn.get(id);
      if (list) list.push(e);
      else issuesOn.set(id, [e]);
    }
  }
  const out: DomainNotice[] = [];
  const push = (type: DomainNoticeType, message: string, elementIds: string[], commandKey?: string) =>
    out.push({ type, level: DOMAIN_NOTICE_LEVELS[type], message, elementIds: [...new Set(elementIds)], ...(commandKey ? { commandKey } : {}) });

  // 状態を変える操作について: 境界か、読むだけか、持ち主を書いているか (操作ごとに 1 回)
  const boundary = new Set<string>();
  for (const [usecaseId, cs] of commandsOf) {
    const c = cs[0]!;
    if (c.postStates.length === 0) continue;
    const groups = [...new Set(c.postStates.map((s) => s.group).filter((g): g is string => !!g))];
    for (const group of groups) {
      const owner = ownerOfGroup.get(group)?.owner ?? null;
      const stateNames = c.postStates
        .filter((s) => s.group === group)
        .map((s) => s.name)
        .join("・");
      const stateIds = c.postStates.filter((s) => s.group === group).map((s) => s.id);
      if (owner && c.place?.kind === "system") {
        const stores = storesOf(owner.id);
        if (stores.length > 0 && !stores.includes(c.place.id)) {
          push(
            "boundaryStateChange",
            `「${c.usecase.name}」(対象: ${c.place.name}) は「${group}」を「${stateNames}」へ変えますが、${c.place.name} は「${owner.name}」の保存先ではありません`,
            [usecaseId, c.place.id, owner.id, ...stateIds],
            c.key,
          );
          boundary.add(usecaseId);
          continue;
        }
      }
      if (c.readOnly) {
        push("readOnlyChangesState", `「${c.usecase.name}」は情報を取得するだけですが、「${group}」を「${stateNames}」へ変えます`, [usecaseId, ...(owner ? [owner.id] : []), ...stateIds], c.key);
        continue;
      }
      if (owner && !c.writes.some((w) => w.id === owner.id)) {
        push(
          "stateOwnerMismatch",
          `「${c.usecase.name}」は「${group}」を「${stateNames}」へ変えますが、書くのは${quote(c.writes)}で、持ち主の「${owner.name}」は書きません`,
          [usecaseId, owner.id, ...c.writes.map((w) => w.id), ...stateIds],
          c.key,
        );
      }
    }
  }

  // 読むだけでイベントを出す (境界の問いが出ている操作には重ねない)
  for (const [usecaseId, cs] of commandsOf) {
    const c = cs[0]!;
    if (!c.readOnly || c.events.length === 0 || boundary.has(usecaseId)) continue;
    push("readOnlyEmitsEvent", `「${c.usecase.name}」は情報を取得するだけですが、${quote(c.events)}を発生させます`, [usecaseId, ...c.events.map((e) => e.id)], c.key);
  }

  // 実行できる状態と次の状態がどちらも複数 (同じ状態グループ) で、組み合わせが曖昧
  for (const [usecaseId, cs] of commandsOf) {
    const c = cs[0]!;
    const groups = [...new Set(c.postStates.map((s) => s.group).filter((g): g is string => !!g))];
    for (const group of groups) {
      const pre = c.preStates.filter((s) => s.group === group);
      const post = c.postStates.filter((s) => s.group === group);
      if (pre.length < 2 || post.length < 2) continue;
      push(
        "ambiguousTransition",
        `「${c.usecase.name}」は「${group}」の${quote(pre)}で実行でき、${quote(post)}へ変えますが、どの組み合わせかが決まりません`,
        [usecaseId, ...pre.map((s) => s.id), ...post.map((s) => s.id)],
        c.key,
      );
    }
  }

  // 複数の作業が使う書く操作 (作業ごとに分けた候補)
  for (const [usecaseId, cs] of commandsOf) {
    if (cs.length < 2 || cs[0]!.readOnly) continue;
    push("sharedCommand", `「${nameOf(get(usecaseId))}」を ${cs.length} つの作業 (${quote(cs.map((c) => c.activity!))}) が使っています`, [usecaseId, ...cs.map((c) => c.activity!.id)], cs[0]!.key);
  }

  // 課題の対象の操作 (操作ごとに 1 件)
  for (const [usecaseId, cs] of commandsOf) {
    const on = issuesOn.get(usecaseId) ?? [];
    if (on.length === 0) continue;
    push("issueOnCommand", `「${cs[0]!.usecase.name}」には課題${quote(on)}が付いています`, [usecaseId, ...on.map((i) => i.id)], cs[0]!.key);
  }

  // 状態グループの持ち主が決まらない (候補が同数で分かれる、または遷移させる操作が情報を書いていない)
  for (const g of derivation.stateGroups) {
    if (g.owner || g.usecases.length === 0) continue;
    const message =
      g.candidates.length > 0
        ? `「${g.group}」を遷移させる操作が書く情報が${quote(g.candidates.map((c) => c.information))}に分かれ、持ち主が決まりません`
        : `「${g.group}」を遷移させる操作${quote(g.usecases)}が情報を書いておらず、持ち主が決まりません`;
    push("stateGroupOwnerUnknown", message, [...g.usecases.map((u) => u.id), ...g.candidates.map((c) => c.information.id), ...g.states.map((s) => s.id)]);
  }

  // コンテキストに状態グループが複数
  for (const c of derivation.contexts) {
    if (!c.context || c.stateGroups.length < 2) continue;
    push("contextWithManyStateGroups", `コンテキスト「${c.context.name}」に状態グループが ${c.stateGroups.length} つあります (${c.stateGroups.map((g) => `「${g}」`).join("")})`, [
      c.context.id,
      ...c.states.map((s) => s.id),
    ]);
  }

  // 条件はあるが失敗のイベントが無い (結果のイベントがちょうど 1 つ。無いものは「イベントを発生させない書く操作」で見る)
  for (const [usecaseId, cs] of commandsOf) {
    const c = cs[0]!;
    if (c.conditions.length === 0 || c.events.length !== 1) continue;
    push(
      "conditionWithoutFailureEvent",
      `「${c.usecase.name}」は条件${quote(c.conditions)}で判断しますが、結果のイベントは「${c.events[0]!.name}」だけです`,
      [usecaseId, ...c.conditions.map((x) => x.id), ...c.events.map((e) => e.id)],
      c.key,
    );
  }

  // 同じ操作で一緒に書く情報 (組ごとに 1 件。組 → 書く操作の索引を先に作る)
  const pairWriters = new Map<string, { a: Information; b: Information; usecases: Map<string, string> }>();
  for (const [usecaseId, cs] of commandsOf) {
    const writes = cs[0]!.writes;
    for (let i = 0; i < writes.length; i++) {
      for (let j = i + 1; j < writes.length; j++) {
        const [a, b] = writes[i]!.id < writes[j]!.id ? [writes[i]!, writes[j]!] : [writes[j]!, writes[i]!];
        const key = `${a.id}|${b.id}`;
        let entry = pairWriters.get(key);
        if (!entry) {
          entry = { a: writes[i]!, b: writes[j]!, usecases: new Map() };
          pairWriters.set(key, entry);
        }
        entry.usecases.set(usecaseId, cs[0]!.usecase.name);
      }
    }
  }
  for (const { a, b, usecases } of pairWriters.values()) {
    push("coWritten", `「${a.name}」と「${b.name}」を${[...usecases.values()].map((n) => `「${n}」`).join("")}が一緒に書きます`, [a.id, b.id, ...usecases.keys()]);
  }

  // 同じ語が別のコンテキストに (情報の名前が、別のコンテキストの要素の名前に含まれる。組は 1 回だけ)
  const members = model.elements.filter(
    (e): e is Element & { contextId: string | null } =>
      (e.kind === "information" || e.kind === "state" || e.kind === "condition" || e.kind === "variation" || e.kind === "event") && "contextId" in e && !!e.contextId,
  );
  const reported = new Set<string>();
  for (const info of model.elements.filter((e): e is Information => e.kind === "information")) {
    const name = info.name.trim();
    if (name.length < 2 || !info.contextId) continue;
    const hits = members.filter((m) => m.id !== info.id && m.contextId !== info.contextId && m.name.includes(name) && !reported.has(`${m.id}|${info.id}`));
    if (hits.length === 0) continue;
    for (const h of hits) reported.add(`${info.id}|${h.id}`);
    push("homonym", `「${name}」(${nameOf(get(info.contextId))}) の語が、別のコンテキストの${hits.map((h) => `「${h.name}」(${nameOf(get(h.contextId!))})`).join("")}にも出ています`, [
      info.id,
      ...hits.map((h) => h.id),
    ]);
  }

  // イベントまわりの情報 (帳票への記入は数えない)
  const writers = [...commandsOf.values()].map((cs) => cs[0]!).filter((c) => !c.readOnly && c.place?.kind !== "ledger");
  if (derivation.events.length === 0) {
    if (writers.length > 0) push("noEvents", `イベントが無く、情報を書く操作が ${writers.length} 件あります`, writers.map((c) => c.usecase.id));
  } else {
    for (const e of derivation.events) {
      if (e.consumers.usecases.length > 0 || e.consumers.activities.length > 0) continue;
      push("eventWithoutConsumer", `「${e.event.name}」をきっかけにする操作も作業もありません`, [e.event.id]);
    }
    const silent = writers.filter((c) => c.events.length === 0);
    if (silent.length >= 5 && silent.length * 2 >= writers.length) {
      // イベントがまだ少ないモデル (書く操作の半分以上がイベントを出さない) では、操作ごとに出さず 1 件にまとめる
      push("fewEvents", `情報を書く操作 ${writers.length} 件のうち ${silent.length} 件がイベントを発生させません`, silent.map((c) => c.usecase.id));
    } else {
      for (const c of silent) push("commandWithoutEvent", `「${c.usecase.name}」は${quote(c.writes)}を書きますが、イベントを発生させません`, [c.usecase.id, ...c.writes.map((w) => w.id)], c.key);
    }
  }

  return out.sort((a, b) => DOMAIN_NOTICE_ORDER.indexOf(a.type) - DOMAIN_NOTICE_ORDER.indexOf(b.type));
}

/** 種類ごとにまとめる (出す順) */
export function groupDomainNotices(notices: DomainNotice[]): { type: DomainNoticeType; level: DomainNoticeLevel; notices: DomainNotice[] }[] {
  const by = new Map<DomainNoticeType, DomainNotice[]>();
  for (const n of notices) {
    const list = by.get(n.type);
    if (list) list.push(n);
    else by.set(n.type, [n]);
  }
  return DOMAIN_NOTICE_ORDER.filter((type) => by.has(type)).map((type) => ({ type, level: DOMAIN_NOTICE_LEVELS[type], notices: by.get(type)! }));
}
