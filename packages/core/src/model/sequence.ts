// 設計モードのシーケンス図 (5.7) の材料: 業務ごとに、誰が・どのシステム (帳票) に・何をして・何が起きるかを、分析から導く。純粋関数だけを置く。
// 保存するのは、条件で流れが変わるときの中身 (代替パターン。操作 → 条件 の関係の alternate。0.6.1) だけで、ほかは毎回導く。
//   並び:     業務の作業を、起点 (作業 → 作業、出来事 → 作業) の順に。作業の中は、使う操作を「次に」の順に
//   呼び出し: 担当 → 操作の対象 (システム・帳票。画面を使う操作は、その画面のシステム)
//   分岐:     操作が判断する条件ごとに 1 つ。代替パターンが決まっていなければ「未定」(開発を始める前に決めること)
//   出来事:   操作が発生させる出来事 → それをきっかけに動く操作の対象へ。人が担当しない操作 (自動) は、その場で続けて書く
import type { Activity, Business, Condition, Element, EventElement, RelationAlternate, Screen, UntieModel, Usecase } from "./types";
import { ALTERNATE_AFTER_LABELS, ALTERNATE_WHEN_LABELS, alternateErrorLabel } from "./types";

/** 図の縦の線 (登場するもの) */
export interface SequenceParticipant {
  /** 要素の id。担当の無い作業は NOBODY、対象の無い操作は NOWHERE */
  id: string;
  kind: "actor" | "system" | "ledger" | "missing";
  name: string;
  /** 設計の対象のシステム */
  target: boolean;
}

export const SEQUENCE_NOBODY = "@nobody";
export const SEQUENCE_NOWHERE = "@nowhere";

export type SequenceStep =
  /** 作業の区切り */
  | { type: "activity"; key: string; activity: Activity; actors: Element[] }
  /** 操作: from (担当。自動なら、きっかけの出来事が起きたところ) → to (操作の対象) */
  | { type: "call"; key: string; from: string; to: string; usecase: Usecase; screen: Screen | null; auto: boolean; via: EventElement | null }
  /** 操作が扱う情報と、状態の変化 */
  | { type: "note"; key: string; on: string; usecase: Usecase; writes: string[]; reads: string[]; states: string | null }
  /** 分岐 (代替パターン)。alternate が null なら未定 */
  | {
      type: "alternate";
      key: string;
      from: string;
      to: string;
      usecase: Usecase;
      condition: Condition;
      relationId: string;
      alternate: RelationAlternate | null;
      event: EventElement | null;
      /** 操作がふだん変える状態 (次の状態) があるか。あれば、分岐のあとの状態も決める */
      changesState: boolean;
      /** そのあとの状態の表示 (変えない / ふだんと同じ / 状態の名前)。まだ決めていなければ null。エラーのときは「変えない」 */
      after: string | null;
    }
  /** 出来事: from (発生させた操作の対象) → to (きっかけにする操作の対象。無ければ null) */
  | { type: "event"; key: string; from: string; to: string | null; event: EventElement; consumers: Usecase[] };

export type SequenceGapType = "alternateUndecided" | "alternateAfterUndecided" | "noPlace" | "noActor";

/**
 * 代替パターンの、そのあとの状態の表示。決めていなければ null。エラーのときは、状態を変えない。
 * stateName が null を返した状態 (名前を引けない id) は除き、1 つも残らなければ決めていない (null) 扱い
 */
export function alternateAfterLabel(alternate: RelationAlternate | null, stateName: (id: string) => string | null): string | null {
  if (!alternate) return null;
  if (alternate.error) return ALTERNATE_AFTER_LABELS.unchanged;
  const after = alternate.after;
  if (!after) return null;
  if (after.type !== "states") return ALTERNATE_AFTER_LABELS[after.type];
  const names = (after.stateIds ?? []).map(stateName).filter((n): n is string => n !== null);
  return names.length > 0 ? names.join("・") : null;
}

/** 開発を始める前に決めておくこと */
export interface SequenceGap {
  type: SequenceGapType;
  message: string;
  usecaseId?: string;
  activityId?: string;
  /** 代替パターンが未定の、操作 → 条件 の関係 */
  relationId?: string;
}

export interface BusinessSequence {
  /** 業務の id。業務に属さない自動の処理をまとめたものは SEQUENCE_AUTO */
  id: string;
  /** 業務。業務に属さない自動の処理をまとめたものは null */
  business: Business | null;
  name: string;
  /** 設計の対象のシステムが登場する */
  touchesSystem: boolean;
  participants: SequenceParticipant[];
  steps: SequenceStep[];
  gaps: SequenceGap[];
}

export const SEQUENCE_AUTO = "@auto";

const nameOf = (e: { name: string } | undefined | null) => e?.name || "(名前なし)";

/** 並びを保ったまま、前後の関係 (before → after) に合わせて並べ直す。輪になっているところは、もとの並びのまま */
function orderBy<T>(items: readonly T[], idOf: (t: T) => string, edges: readonly (readonly [string, string])[]): T[] {
  const ids = new Set(items.map(idOf));
  const incoming = new Map<string, Set<string>>(items.map((t) => [idOf(t), new Set<string>()]));
  for (const [before, after] of edges) if (ids.has(before) && ids.has(after) && before !== after) incoming.get(after)!.add(before);
  const done = new Set<string>();
  const out: T[] = [];
  while (out.length < items.length) {
    // 前に来るものがすべて済んだ、最初のもの。無ければ (輪)、残りの最初のもの
    const next = items.find((t) => !done.has(idOf(t)) && [...incoming.get(idOf(t))!].every((b) => done.has(b))) ?? items.find((t) => !done.has(idOf(t)))!;
    done.add(idOf(next));
    out.push(next);
  }
  return out;
}

/** 業務ごとのシーケンス。systemId を渡すと、そのシステムを設計の対象として印を付ける */
export function deriveSequences(model: UntieModel, systemId?: string): BusinessSequence[] {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const position = new Map(model.elements.map((e, i) => [e.id, i]));
  const rel = (kind: string) => model.relations.filter((r) => r.kind === kind);
  const targetsOf = (kind: string) => {
    const map = new Map<string, string[]>();
    for (const r of rel(kind)) map.set(r.sourceId, [...(map.get(r.sourceId) ?? []), r.targetId]);
    return map;
  };
  const sourcesOf = (kind: string) => {
    const map = new Map<string, string[]>();
    for (const r of rel(kind)) map.set(r.targetId, [...(map.get(r.targetId) ?? []), r.sourceId]);
    return map;
  };
  const usecasesOfActivity = targetsOf("activityUsecase");
  const activitiesOfUsecase = sourcesOf("activityUsecase");
  const actorsOfActivity = sourcesOf("actorActivity");
  const informationOf = rel("usecaseInformation");
  const conditionsOf = rel("usecaseCondition");
  const preStates = sourcesOf("stateUsecase");
  const postStates = targetsOf("usecaseState");
  const eventsOfUsecase = targetsOf("usecaseEvent");
  const consumersOfEvent = targetsOf("eventUsecase");
  const triggersOfUsecase = sourcesOf("eventUsecase");
  const systemsOfEvent = sourcesOf("systemEvent");
  const screenOf = targetsOf("usecaseScreen");
  const systemOf = targetsOf("usecaseSystem");
  const nextEdges = rel("usecaseNext").map((r) => [r.sourceId, r.targetId] as const);
  const element = <K extends Element["kind"]>(id: string | undefined, kind: K): Extract<Element, { kind: K }> | undefined => {
    const e = id === undefined ? undefined : byId.get(id);
    return e && e.kind === kind ? (e as Extract<Element, { kind: K }>) : undefined;
  };

  /** 操作の対象 (システム・帳票。画面を使う操作は、その画面のシステム) と、使う画面 */
  const placeOf = (usecaseId: string): { place: Element | null; screen: Screen | null } => {
    const screen = element(screenOf.get(usecaseId)?.[0], "screen") ?? null;
    if (screen) return { place: (screen.systemId ? byId.get(screen.systemId) : undefined) ?? null, screen };
    return { place: byId.get(systemOf.get(usecaseId)?.[0] ?? "") ?? null, screen: null };
  };

  const businesses = model.elements.filter((e): e is Business => e.kind === "business");
  const activitiesOfBusiness = new Map<string, Activity[]>();
  for (const a of model.elements) {
    if (a.kind !== "activity" || !a.bucId) continue;
    const buc = element(a.bucId, "buc");
    if (!buc) continue;
    activitiesOfBusiness.set(buc.businessId, [...(activitiesOfBusiness.get(buc.businessId) ?? []), a]);
  }
  // 作業の前後: 起点の作業 → 後続の作業、出来事が起点の作業は、その出来事を発生させる操作を使う作業のあと
  const activityEdges: [string, string][] = rel("activityTrigger").map((r) => [r.sourceId, r.targetId]);
  for (const r of rel("eventActivity")) {
    for (const usecaseId of sourcesOf("usecaseEvent").get(r.sourceId) ?? []) for (const activityId of activitiesOfUsecase.get(usecaseId) ?? []) activityEdges.push([activityId, r.targetId]);
  }

  /** 業務の流れから辿り着いた、自動の操作 (どの業務にも入らなかったものを、最後にまとめる) */
  const reachedAuto = new Set<string>();

  const build = (id: string, business: Business | null, name: string, fill: (ctx: Builder) => void): BusinessSequence => {
    const participants = new Map<string, SequenceParticipant>();
    const steps: SequenceStep[] = [];
    const gaps: SequenceGap[] = [];
    const participant = (e: Element | null, missing: typeof SEQUENCE_NOBODY | typeof SEQUENCE_NOWHERE): string => {
      const pid = e?.id ?? missing;
      if (!participants.has(pid)) {
        participants.set(
          pid,
          e
            ? { id: pid, kind: e.kind === "system" ? "system" : e.kind === "ledger" ? "ledger" : "actor", name: nameOf(e), target: e.id === systemId }
            : { id: pid, kind: "missing", name: missing === SEQUENCE_NOBODY ? "(担当なし)" : "(対象なし)", target: false },
        );
      }
      return pid;
    };
    let seq = 0;
    const key = (prefix: string) => `${prefix}:${seq++}`;
    const visited = new Set<string>();

    /** 操作 1 つ分: 呼び出し → 扱う情報と状態 → 分岐 → 出来事 (自動の操作は続けて書く) */
    const emit = (usecase: Usecase, from: string, auto: boolean, via: EventElement | null): void => {
      const { place, screen } = placeOf(usecase.id);
      const to = participant(place, SEQUENCE_NOWHERE);
      if (!place && !gaps.some((g) => g.type === "noPlace" && g.usecaseId === usecase.id)) {
        gaps.push({ type: "noPlace", usecaseId: usecase.id, message: `操作「${nameOf(usecase)}」の対象 (システム・帳票・画面) が決まっていません` });
      }
      steps.push({ type: "call", key: key("call"), from, to, usecase, screen, auto, via });
      const infos = informationOf.filter((r) => r.sourceId === usecase.id);
      // 書く = 保存する (取得も保存もするものを含む)、読む = 取得するだけ
      const names = (access: "read" | "write") => infos.filter((r) => (access === "write" ? r.access !== "read" : r.access === "read")).map((r) => nameOf(byId.get(r.targetId)));
      const pre = (preStates.get(usecase.id) ?? []).map((s) => nameOf(byId.get(s)));
      const post = (postStates.get(usecase.id) ?? []).map((s) => nameOf(byId.get(s)));
      const states = pre.length + post.length > 0 ? `${pre.join("・") || "—"} → ${post.join("・") || "—"}` : null;
      if (infos.length > 0 || states) steps.push({ type: "note", key: key("note"), on: to, usecase, writes: names("write"), reads: names("read"), states });
      for (const r of conditionsOf.filter((x) => x.sourceId === usecase.id)) {
        const condition = element(r.targetId, "condition");
        if (!condition) continue;
        const alternate = r.alternate ?? null;
        const changesState = (postStates.get(usecase.id) ?? []).length > 0;
        const after = alternateAfterLabel(alternate, (id) => nameOf(byId.get(id)));
        steps.push({ type: "alternate", key: key("alt"), from, to, usecase, condition, relationId: r.id, alternate, event: element(alternate?.eventId, "event") ?? null, changesState, after });
        if (!alternate) gaps.push({ type: "alternateUndecided", usecaseId: usecase.id, relationId: r.id, message: `操作「${nameOf(usecase)}」で、条件「${nameOf(condition)}」のときにどうなるかが決まっていません` });
        // 操作がふだん状態を変えるなら、分岐のあとの状態 (変えないのか、ふだんと同じか、別の状態か) も決める
        else if (changesState && after === null) gaps.push({ type: "alternateAfterUndecided", usecaseId: usecase.id, relationId: r.id, message: `操作「${nameOf(usecase)}」で、条件「${nameOf(condition)}」のときに、そのあとの状態がどうなるかが決まっていません` });
      }
      for (const eventId of eventsOfUsecase.get(usecase.id) ?? []) {
        const event = element(eventId, "event");
        if (!event) continue;
        const consumers = (consumersOfEvent.get(eventId) ?? []).map((u) => element(u, "usecase")).filter((u): u is Usecase => !!u);
        if (consumers.length === 0) {
          steps.push({ type: "event", key: key("event"), from: to, to: null, event, consumers: [] });
          continue;
        }
        for (const consumer of consumers) {
          const target = participant(placeOf(consumer.id).place, SEQUENCE_NOWHERE);
          const isAuto = (activitiesOfUsecase.get(consumer.id) ?? []).length === 0;
          // 自動の操作は、出来事の線をそのまま呼び出しにする (続けて中身を書く)。人が担当する操作は、出来事が届いたことだけを書く (中身は、その作業のところ)
          if (isAuto && !visited.has(consumer.id)) {
            visited.add(consumer.id);
            reachedAuto.add(consumer.id);
            emit(consumer, to, true, event);
          } else steps.push({ type: "event", key: key("event"), from: to, to: target, event, consumers: [consumer] });
        }
      }
    };
    fill({ participant, steps, gaps, emit, key, visited });
    // 並び: 人 (担当) を左、システム・帳票を右 (それぞれ、出てきた順)
    const list = [...participants.values()];
    const ordered = [...list.filter((p) => p.kind === "actor" || p.id === SEQUENCE_NOBODY), ...list.filter((p) => p.kind !== "actor" && p.id !== SEQUENCE_NOBODY)];
    return { id, business, name, touchesSystem: systemId !== undefined && participants.has(systemId), participants: ordered, steps, gaps };
  };

  const out: BusinessSequence[] = [];
  for (const business of businesses) {
    const activities = orderBy(activitiesOfBusiness.get(business.id) ?? [], (a) => a.id, activityEdges);
    if (activities.length === 0) continue;
    out.push(
      build(business.id, business, nameOf(business), ({ participant, steps, gaps, emit, key }) => {
        for (const activity of activities) {
          const actors = (actorsOfActivity.get(activity.id) ?? []).map((a) => byId.get(a)).filter((a): a is Element => !!a);
          steps.push({ type: "activity", key: key("activity"), activity, actors });
          if (actors.length === 0) gaps.push({ type: "noActor", activityId: activity.id, message: `作業「${nameOf(activity)}」の担当が決まっていません` });
          const from = participant(actors[0] ?? null, SEQUENCE_NOBODY);
          const usecases = (usecasesOfActivity.get(activity.id) ?? []).map((u) => element(u, "usecase")).filter((u): u is Usecase => !!u);
          for (const usecase of orderBy(usecases, (u) => u.id, nextEdges)) emit(usecase, from, false, null);
        }
      }),
    );
  }
  // どの業務からも辿り着かない自動の操作 (時間の出来事や、システムが自分で発生させる出来事がきっかけのもの)
  const loose = model.elements
    .filter((u): u is Usecase => u.kind === "usecase" && (activitiesOfUsecase.get(u.id) ?? []).length === 0 && (triggersOfUsecase.get(u.id) ?? []).length > 0 && !reachedAuto.has(u.id))
    .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  if (loose.length > 0) {
    out.push(
      build(SEQUENCE_AUTO, null, "自動の処理 (業務に属さないもの)", ({ participant, emit, visited }) => {
        for (const usecase of loose) {
          if (visited.has(usecase.id)) continue;
          visited.add(usecase.id);
          const event = element(triggersOfUsecase.get(usecase.id)![0], "event") ?? null;
          // きっかけの出来事を発生させるシステム (無ければ、操作の対象が自分で始める)
          const source = event ? (byId.get(systemsOfEvent.get(event.id)?.[0] ?? "") ?? null) : null;
          const from = participant(source ?? placeOf(usecase.id).place, SEQUENCE_NOWHERE);
          emit(usecase, from, true, event);
        }
      }),
    );
  }
  return out;
}

interface Builder {
  participant: (e: Element | null, missing: typeof SEQUENCE_NOBODY | typeof SEQUENCE_NOWHERE) => string;
  steps: SequenceStep[];
  gaps: SequenceGap[];
  emit: (usecase: Usecase, from: string, auto: boolean, via: EventElement | null) => void;
  key: (prefix: string) => string;
  visited: Set<string>;
}

/** 図に出す、操作の呼び出しの文言 (画面を使うなら、画面の名前を添える。自動なら、きっかけの出来事を添える) */
export function sequenceCallLabel(step: Extract<SequenceStep, { type: "call" }>): string {
  const base = `${nameOf(step.usecase)}${step.screen ? ` [${nameOf(step.screen)}]` : ""}`;
  return step.auto ? `${step.via ? `${nameOf(step.via)} → ` : ""}${base} (自動)` : base;
}

/** 代替パターンで起きること (出来事か、エラー) の添え書き。どちらも無ければ空 */
export function sequenceAlternateOutcome(step: Extract<SequenceStep, { type: "alternate" }>): string {
  const error = step.alternate?.error;
  if (error) return ` (${alternateErrorLabel(error)})`;
  return step.event ? ` (出来事: ${nameOf(step.event)})` : "";
}

/** 図に出す、分岐の文言 (2 行: いつ・どうなるか) */
export function sequenceAlternateLines(step: Extract<SequenceStep, { type: "alternate" }>): [string, string] {
  const a = step.alternate;
  const when = a ? (a.when === "met" ? "のとき" : "でないとき") : "のとき / でないとき";
  // そのあとの状態は、1 行目に添える (2 行目の文は長いと切れるので)。操作が状態を変えないなら、書かない
  const after = !a || (!step.changesState && step.after === null) ? "" : ` (そのあと: ${step.after ?? "未定"})`;
  return [`［${nameOf(step.condition)}］${when}${after}`, a ? `→ ${a.then}${sequenceAlternateOutcome(step)}` : "→ 未定 (どうなるかを決める)"];
}

/** 設計の対象のシステムが登場する業務の、開発を始める前に決めておくこと */
export function sequenceGaps(model: UntieModel, systemId: string): { sequence: BusinessSequence; gap: SequenceGap }[] {
  return deriveSequences(model, systemId)
    .filter((s) => s.touchesSystem)
    .flatMap((sequence) => sequence.gaps.map((gap) => ({ sequence, gap })));
}

const mermaidText = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/[;#]/g, " ").trim() || "-";

/**
 * Mermaid の sequenceDiagram にする (実装を生成する側へ渡す・ドキュメントに貼る)。
 * 分岐は、条件のときの流れを alt で書く (未定なら、その旨)
 */
export function sequenceToMermaid(sequence: BusinessSequence): string {
  const alias = new Map(sequence.participants.map((p, i) => [p.id, `p${i}`]));
  const lines = ["sequenceDiagram", ...sequence.participants.map((p) => `  ${p.kind === "actor" ? "actor" : "participant"} ${alias.get(p.id)} as ${mermaidText(p.name)}`)];
  for (const step of sequence.steps) {
    if (step.type === "activity") {
      const ids = [...alias.values()];
      lines.push(`  Note over ${ids[0]},${ids[ids.length - 1]}: 作業 ${mermaidText(nameOf(step.activity))}`);
    } else if (step.type === "call") {
      lines.push(`  ${alias.get(step.from)}${step.auto ? "-)" : "->>"}${alias.get(step.to)}: ${mermaidText(sequenceCallLabel(step))}`);
    } else if (step.type === "note") {
      const parts = [step.writes.length > 0 ? `書く ${step.writes.join("・")}` : "", step.reads.length > 0 ? `読む ${step.reads.join("・")}` : "", step.states ? `状態 ${step.states}` : ""].filter(Boolean);
      lines.push(`  Note right of ${alias.get(step.on)}: ${mermaidText(parts.join(" / "))}`);
    } else if (step.type === "alternate") {
      const a = step.alternate;
      lines.push(`  alt ${mermaidText(`${nameOf(step.condition)} (${a ? ALTERNATE_WHEN_LABELS[a.when] : "未定"})`)}`);
      lines.push(`    ${alias.get(step.to)}-->>${alias.get(step.from)}: ${mermaidText(a ? a.then : "未定")}`);
      if (a && (step.changesState || step.after !== null)) lines.push(`    Note right of ${alias.get(step.to)}: そのあとの状態 ${mermaidText(step.after ?? "未定")}`);
      if (a?.error) lines.push(`    Note right of ${alias.get(step.to)}: ${mermaidText(alternateErrorLabel(a.error))}`);
      else if (step.event) lines.push(`    Note right of ${alias.get(step.to)}: 出来事 ${mermaidText(nameOf(step.event))}`);
      lines.push("  end");
    } else {
      lines.push(step.to === null ? `  Note right of ${alias.get(step.from)}: 出来事 ${mermaidText(nameOf(step.event))}` : `  ${alias.get(step.from)}-)${alias.get(step.to)}: ${mermaidText(nameOf(step.event))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
