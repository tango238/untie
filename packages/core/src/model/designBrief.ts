// 実装に渡す設計書 (6.1)。対象のシステムについて、分析と設計で決めたことを、実装する側 (AI のエージェント) が読む 1 つの Markdown にまとめる。
// 作る側は、ここに無いことを自分で決めてしまう。だから、このシステムの操作だけでなく、その前提を作っているもの
// (ほかのシステムの操作・状態がどの情報のものか・情報どうしの結びつき・条件を何で判断するか) も載せ、決まっていないことは、決まっていないと書く。
// 業務の言葉だけで書く (内部のドメインモデルの言葉は使わない)。純粋関数だけを置く。
import { effectiveDatabaseIds } from "./design";
import { systemInformationIds } from "./designData";
import { stateGroupOwners } from "./domainModel";
import { usecasePlaces } from "./placement";
import { checkReadiness } from "./readiness";
import { alternateAfterLabel, deriveSequences, sequenceToMermaid } from "./sequence";
import { designScreenName } from "./sitemap";
import { ALTERNATE_WHEN_LABELS, INFORMATION_ACCESS_LABELS, alternateErrorLabel, describeEventTiming, type Element, type Relation, type UntieModel } from "./types";

export interface DesignBrief {
  systemId: string;
  /** 書き出すファイルの名前 (<システムの id>.design.md) */
  fileName: string;
  text: string;
  /** このシステムで行う操作の数 */
  usecases: number;
  /** まだ決まっていないことの数 (実装を始める準備の残り) */
  remaining: number;
}

/** 書き出す設計書のファイルの名前 */
export function designBriefFileName(systemId: string): string {
  return `${systemId}.design.md`;
}

const nameOf = (e: { name: string } | undefined): string => e?.name?.trim() || "(名前なし)";
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];
/** 説明の文を、箇条書きの 1 行に収める */
const oneLine = (text: string | undefined): string => (text ?? "").trim().replace(/\s*\n\s*/g, " ");

/** そのシステムの設計書を書き出す */
export function exportDesignBrief(model: UntieModel, systemId: string): DesignBrief {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const name = (id: string): string => nameOf(byId.get(id));
  const system = byId.get(systemId);
  const places = usecasePlaces(model);
  const order = new Map(model.elements.map((e, i) => [e.id, i]));
  const sorted = (ids: Iterable<string>): string[] => uniq([...ids]).filter((id) => byId.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
  const targets = (kind: Relation["kind"], sourceId: string): Relation[] => model.relations.filter((r) => r.kind === kind && r.sourceId === sourceId);
  const sources = (kind: Relation["kind"], targetId: string): Relation[] => model.relations.filter((r) => r.kind === kind && r.targetId === targetId);

  const usecases = model.elements.filter((e) => e.kind === "usecase" && places.get(e.id) === systemId);
  const mine = new Set(usecases.map((u) => u.id));
  /** 操作の名前。このシステムのものでなければ、どこで行うかを添える (作る側が、自分の作るものと取り違えないように) */
  const usecaseLabel = (id: string): string => {
    if (mine.has(id)) return `「${name(id)}」`;
    const place = byId.get(places.get(id) ?? "");
    const where = !place ? "対象が決まっていない" : place.kind === "ledger" ? `帳票「${nameOf(place)}」` : `ほかのシステム「${nameOf(place)}」`;
    return `「${name(id)}」(${where})`;
  };
  const usecaseList = (ids: Iterable<string>): string => sorted(ids).map(usecaseLabel).join("、") || "無い";

  const groupOf = (stateId: string): string => {
    const s = byId.get(stateId);
    return s?.kind === "state" && s.group?.trim() ? s.group.trim() : "";
  };
  /** 状態を、グループの名前付きで言う (例: 予約の状態 = 確定) */
  const stateLabel = (stateId: string): string => (groupOf(stateId) ? `${groupOf(stateId)} = ${name(stateId)}` : `状態「${name(stateId)}」`);

  const lines: string[] = [];
  const push = (...xs: string[]) => lines.push(...xs);

  push(`# ${nameOf(system)} の設計`, "");
  push("untie が、分析と設計から書き出したもの (自動生成。手で直しても、書き出し直すと消える)。", "");
  if (system && oneLine(system.description)) push(oneLine(system.description), "");
  push(
    "## 読み方",
    "",
    "- **操作** が、このシステムで作る機能の単位。ここに無い操作は、作らない。",
    "- 「ほかのシステム」「帳票」と書いてある操作は、このシステムでは作らない。このシステムの操作の前提 (状態・情報・出来事) を、外で作っているもの。",
    "- **決まっていない** と書いてあることは、勝手に決めない。「まだ決まっていないこと」に挙がっているあいだは、実装を始めない。",
    "",
  );

  // ---- 操作
  push("## 操作", "");
  if (usecases.length === 0) push("このシステムを対象にした操作がありません。", "");
  for (const u of usecases) {
    push(`### ${nameOf(u)}`, "");
    if (oneLine(u.description)) push(oneLine(u.description), "");
    for (const r of sources("activityUsecase", u.id)) {
      const actors = sorted(sources("actorActivity", r.sourceId).map((x) => x.sourceId)).map(name);
      push(`- 作業: ${name(r.sourceId)} (担当: ${actors.join("・") || "決まっていない"})`);
    }
    const triggers = sorted(sources("eventUsecase", u.id).map((r) => r.sourceId));
    if (triggers.length > 0) push(`- きっかけの出来事: ${triggers.map(name).join("・")} (人の操作ではなく、この出来事が起きたら行う)`);
    const screens = sorted(targets("usecaseScreen", u.id).map((r) => r.targetId));
    if (screens.length > 0) push(`- 画面: ${screens.map(name).join("・")}`);
    const informations = targets("usecaseInformation", u.id);
    if (informations.length === 0) push("- 情報: 決まっていない");
    for (const r of informations) push(`- 情報: ${name(r.targetId)} (${r.access ? INFORMATION_ACCESS_LABELS[r.access] : "取得・保存"})`);
    const pre = sorted(sources("stateUsecase", u.id).map((r) => r.sourceId));
    const post = sorted(targets("usecaseState", u.id).map((r) => r.targetId));
    if (pre.length > 0) push(`- 前提の状態: ${pre.map(stateLabel).join("、")} (これ以外のときは、行えない)`);
    if (post.length > 0) push(`- 次の状態: ${post.map(stateLabel).join("、")}`);
    for (const r of targets("usecaseCondition", u.id)) {
      const a = r.alternate;
      if (!a) {
        push(`- 条件「${name(r.targetId)}」を判断する (条件のときにどうなるかは、決まっていない)`);
        continue;
      }
      const after = alternateAfterLabel(a, name);
      const extras = [a.eventId ? `起きる出来事: ${name(a.eventId)}` : "", a.error ? `結果: ${alternateErrorLabel(a.error)} (状態は変えない)` : "", after ? `そのあとの状態: ${after}` : ""].filter(Boolean);
      push(`- 条件「${name(r.targetId)}」: ${ALTERNATE_WHEN_LABELS[a.when]}、${oneLine(a.then) || "(どうなるかは、決まっていない)"}${extras.length > 0 ? ` (${extras.join("。")})` : ""}`);
    }
    const events = sorted(targets("usecaseEvent", u.id).map((r) => r.targetId));
    if (events.length > 0) push(`- 起きる出来事: ${events.map(name).join("・")}`);
    const next = sorted(targets("usecaseNext", u.id).map((r) => r.targetId));
    if (next.length > 0) push(`- 続けて行う操作: ${usecaseList(next)}`);
    push("");
  }

  // ---- 状態 (このシステムの操作が関わるグループ)
  const stateIds = new Set(model.relations.flatMap((r) => (r.kind === "stateUsecase" && mine.has(r.targetId) ? [r.sourceId] : r.kind === "usecaseState" && mine.has(r.sourceId) ? [r.targetId] : [])));
  const groups = uniq(sorted(stateIds).map(groupOf).filter(Boolean));
  const owners = new Map(stateGroupOwners(model).map((g) => [g.group.trim(), g]));
  const loose = sorted(stateIds).filter((id) => !groupOf(id));
  if (groups.length > 0 || loose.length > 0) {
    push("## 状態", "");
    for (const group of groups) {
      const g = owners.get(group);
      const members = model.elements.filter((e) => e.kind === "state" && e.group?.trim() === group);
      push(`### ${group}`, "");
      push(g?.owner ? `情報「${nameOf(g.owner)}」の状態。どれか 1 つの値を取る。` : "どの情報の状態かは、**決まっていない**。", "");
      push("| 状態 | この状態にする操作 | この状態が前提の操作 |", "| --- | --- | --- |");
      for (const s of members) {
        push(`| ${nameOf(s)} | ${usecaseList(sources("usecaseState", s.id).map((r) => r.sourceId))} | ${usecaseList(targets("stateUsecase", s.id).map((r) => r.targetId))} |`);
      }
      // 作られたときの状態: 前提の状態を何も持たない操作 (新しく作る操作) が、移す先にしている状態
      const initial = members.filter((s) => sources("usecaseState", s.id).some((r) => sources("stateUsecase", r.sourceId).length === 0));
      push(
        "",
        initial.length > 0
          ? `作られたときの状態: ${initial.map(nameOf).join("・")}`
          : "作られたときの状態: 設計に無い (前提の状態なしに、このグループの状態にする操作が無い)。作る手段を足すなら、どの状態で作るかを、呼び出す側が渡す形にする。",
        "",
      );
    }
    for (const id of loose) {
      push(`- 状態「${name(id)}」(グループなし): この状態にする操作: ${usecaseList(sources("usecaseState", id).map((r) => r.sourceId))}。この状態が前提の操作: ${usecaseList(targets("stateUsecase", id).map((r) => r.targetId))}`);
    }
    if (loose.length > 0) push("");
  }

  // ---- 情報 (このシステムの操作が扱うもの)
  const informationIds = systemInformationIds(model, systemId);
  const design = model.designs.find((d) => d.systemId === systemId);
  const databases = design ? effectiveDatabaseIds(model, design).flatMap((id) => model.databases.filter((d) => d.id === id)) : [];
  if (informationIds.length > 0) {
    push("## 情報", "");
    for (const id of sorted(informationIds)) {
      const info = byId.get(id)!;
      push(`### ${nameOf(info)}`, "");
      if (oneLine(info.description)) push(oneLine(info.description), "");
      const ownedGroups = [...owners.values()].filter((g) => g.owner?.id === id).map((g) => g.group.trim());
      if (ownedGroups.length > 0) push(`- 状態: ${ownedGroups.join("・")}`);
      const related = sorted(model.relations.flatMap((r) => (r.kind !== "informationRelated" ? [] : r.sourceId === id ? [r.targetId] : r.targetId === id ? [r.sourceId] : [])));
      push(`- 結びつく情報: ${related.map(name).join("・") || "無い"}`);
      const variations = sorted(targets("informationVariation", id).map((r) => r.targetId));
      if (variations.length > 0) push(`- 区分: ${variations.map(name).join("・")}`);
      const users = sources("usecaseInformation", id);
      push(`- 保存する操作: ${usecaseList(users.filter((r) => r.access !== "read").map((r) => r.sourceId))}`);
      push(`- 取得する操作: ${usecaseList(users.filter((r) => r.access !== "write").map((r) => r.sourceId))}`);
      const tables = uniq(databases.flatMap((db) => db.tables.filter((t) => t.informationIds.includes(id)).map((t) => t.table)));
      push(`- テーブル: ${tables.join("・") || "決まっていない"}`, "");
    }
  }

  // ---- 条件 (このシステムの操作が判断するもの)
  const conditionIds = sorted(usecases.flatMap((u) => targets("usecaseCondition", u.id).map((r) => r.targetId)));
  if (conditionIds.length > 0) {
    push("## 条件", "", "条件を満たすかどうかは、下の「何で判断するか」から決める。式までは決まっていないので、判断に要る値が足りなければ、呼び出す側が渡す形にする。", "");
    for (const id of conditionIds) {
      const c = byId.get(id)!;
      push(`### ${nameOf(c)}`, "");
      const states = sorted(targets("conditionState", id).map((r) => r.targetId));
      const variations = sorted(targets("conditionVariation", id).map((r) => r.targetId));
      const basis = [oneLine(c.description).replace(/[。.]$/, ""), states.length > 0 ? `状態 (${states.map(stateLabel).join("、")}) を見る` : "", variations.length > 0 ? `区分 (${variations.map(name).join("・")}) を見る` : ""].filter(Boolean);
      push(`- 何で判断するか: ${basis.join("。") || "**決まっていない**"}`);
      push(`- 判断する操作: ${usecaseList(sources("usecaseCondition", id).map((r) => r.sourceId))}`, "");
    }
  }

  // ---- 区分 (このシステムの情報・条件に結んだもの)
  const variationIds = sorted([...informationIds.flatMap((id) => targets("informationVariation", id)), ...conditionIds.flatMap((id) => targets("conditionVariation", id))].map((r) => r.targetId));
  if (variationIds.length > 0) {
    push("## 区分", "");
    for (const id of variationIds) {
      const v = byId.get(id)!;
      const values = v.kind === "variation" ? v.values.map((x) => x.trim()).filter(Boolean) : [];
      push(`- ${nameOf(v)}: ${values.join("・") || "値が **決まっていない**"}${oneLine(v.description) ? ` (${oneLine(v.description)})` : ""}`);
    }
    push("");
  }

  // ---- 出来事 (このシステムの操作のきっかけ・起こすもの)
  const eventIds = sorted(
    usecases.flatMap((u) => [
      ...sources("eventUsecase", u.id).map((r) => r.sourceId),
      ...targets("usecaseEvent", u.id).map((r) => r.targetId),
      ...targets("usecaseCondition", u.id).flatMap((r) => (r.alternate?.eventId ? [r.alternate.eventId] : [])),
    ]),
  );
  if (eventIds.length > 0) {
    push("## 出来事", "");
    for (const id of eventIds) {
      const e = byId.get(id)!;
      const raisedBy = [...sources("usecaseEvent", id).map((r) => r.sourceId), ...model.relations.filter((r) => r.kind === "usecaseCondition" && r.alternate?.eventId === id).map((r) => r.sourceId)];
      const bySystems = sorted(sources("systemEvent", id).map((r) => r.sourceId)).map((x) => `システム「${name(x)}」`);
      const when = e.kind === "event" && e.timing ? describeEventTiming(e.timing) : "";
      const origin = [raisedBy.length > 0 ? usecaseList(raisedBy) : "", ...bySystems, when].filter(Boolean).join("、");
      push(`- ${nameOf(e)}: 起こすもの: ${origin || "**決まっていない**"}。これをきっかけに行う操作: ${usecaseList(targets("eventUsecase", id).map((r) => r.targetId))}`);
    }
    push("");
  }

  // ---- 業務の流れ
  const sequences = deriveSequences(model, systemId).filter((s) => s.touchesSystem);
  if (sequences.length > 0) {
    push("## 業務の流れ", "", "業務ごとの、作業と操作の順 (シーケンス図)。条件で流れが変わるところは、alt の枠。", "");
    for (const s of sequences) push(`### ${s.name}`, "", "```mermaid", sequenceToMermaid(s).trimEnd(), "```", "");
  }

  // ---- 画面とデータ (設計)
  if (design) {
    if (design.screens.length > 0) {
      push("## 画面", "");
      for (const s of design.screens) {
        const users = s.source.kind === "screen" ? sources("usecaseScreen", s.source.screenId).map((r) => r.sourceId) : [];
        push(`- ${designScreenName(model, s)}${users.length > 0 ? ` (操作: ${sorted(users).map(name).join("・")})` : ""}`);
      }
      push("");
    }
    for (const db of databases) {
      if (!db.dsl.trim()) continue;
      push(`## データ: ${nameOf(db)}`, "", "テーブルの定義 (Prisma の書き方)。", "", "```prisma", db.dsl.trimEnd(), "```", "");
    }
  }

  // ---- まだ決まっていないこと
  const readiness = checkReadiness(model, systemId);
  const open = readiness.conditions.filter((c) => !c.done);
  const remaining = open.reduce((n, c) => n + c.items.length, 0);
  push("## まだ決まっていないこと", "");
  if (open.length === 0) push("ありません (実装を始める準備が、すべてそろっています)。", "");
  for (const c of open) {
    push(`### ${c.title}`, "");
    for (const item of c.items) push(`- ${item.message}`);
    push("");
  }

  return { systemId, fileName: designBriefFileName(systemId), text: `${lines.join("\n").replace(/\n+$/, "")}\n`, usecases: usecases.length, remaining };
}

/** 操作のあるシステムの分を、すべて書き出す */
export function exportDesignBriefAll(model: UntieModel): DesignBrief[] {
  return model.elements
    .filter((e): e is Extract<Element, { kind: "system" }> => e.kind === "system")
    .map((s) => exportDesignBrief(model, s.id))
    .filter((b) => b.usecases > 0);
}
