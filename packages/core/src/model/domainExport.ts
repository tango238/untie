// ドメインモデル (domain。4.6) を、distill-ddd (/ddd スキル) の成果物の形式 (docs/domain/*.md) で書き出す。純粋関数だけを置く。
// distill-ddd の scripts/diagrams.py・build_site.py は、md を正規表現で読んで図と用語集を作る。読まれる箇所の書式は 1 文字も変えられないので、
// 決まりをここに集める (untie 側はスナップショットのテスト、distill-ddd 側は同じ文字列を使う golden テストで、両側のずれに気づく)。
//   bounded-contexts.md: `### 名前 (Core|Supporting|Generic)` (末尾の括弧は 1 つだけ。`###` はコンテキストにしか使わない)
//   context-map.md:      最初の表のヘッダに Upstream と Downstream。関係は英語の綴り (CONTEXT_RELATION_ENGLISH)
//   aggregates.md:       `### 名前 (Bounded Context: コンテキスト名)`。`**操作**:` の下に `- \`command()\`: 説明 → 発行: \`Event\``。
//                        コマンド名と発行のイベント名は ASCII の識別子しか読まれないので、英語名のあるものだけを書く
//   domain-events.md:    `#### 名前`、`- **発生元 Aggregate**: 集約の見出しの名前`、`- **Consumer**: A, B`、`## Event Flow` の下に `A --{Event}--> B`
//   glossary.md:         `## コンテキスト名` の下に `| 用語 | 英語 | 定義 |` の表
// 名前は、集約・イベントは英語名 (無ければ日本語の名前)、コンテキストは日本語の名前 (英語名は項目に書く)。ファイルをまたぐ結びつきは文字列の一致だけなので、同じ関数で作る。
import { CONTEXT_RELATION_ENGLISH, INTEGRATION_ENGLISH, isEmptyDomain, SUBDOMAIN_ENGLISH } from "./domain";
import { checkDomain } from "./domainCheck";
import { deriveContextMap } from "./domainMap";
import { deriveDomainModel } from "./domainModel";
import { domainNotices } from "./domainNotices";
import { resolveDomain, type ResolvedCommand, type ResolvedEvent } from "./domainResolve";
import { buildDomainScope } from "./domainScope";
import type { Aggregate, BoundedContext, UntieModel } from "./types";

export interface DomainDocFile {
  /** docs/domain/ の中のファイル名 */
  name: string;
  text: string;
}

export interface DomainDocs {
  files: DomainDocFile[];
  /** 書き出したが、distill-ddd の図に出ない・結びつかないもの (英語名が無い、名前が重なる、など) */
  warnings: string[];
}

/** distill-ddd の成果物を置くフォルダ (リポジトリからの相対) */
export const DOMAIN_DOCS_DIR = "docs/domain";
/** distill-ddd が進み具合 (済んだフェーズ・キュー・食い違い) を持つファイル。既にあれば、書き出しで上書きしない */
export const DOMAIN_SESSION_FILE = ".ddd-session.json";

/**
 * 表のセル・本文に入れる文字列 (改行と、書式を壊す記号を置き換える)。
 * `*` と `` ` `` は全角にする: 説明や不変条件に `**操作**:` のような文字列があると、distill-ddd がそこを節の区切りと読むため
 */
const cell = (text: string) => text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "／").replace(/\*/g, "＊").replace(/`/g, "｀").trim();
/**
 * 見出しの名前 (コンテキスト・集約・イベント)。ファイルをまたいで文字列の一致で結ぶので、distill-ddd が区切りと読む記号を全角にする:
 * 括弧 (末尾の括弧は分類やコンテキストと読まれる)、`/` `,` `、` (Consumer を分ける)、`{` `}` (Event Flow の書式)、`#`
 */
const heading = (text: string) =>
  cell(text)
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .replace(/\//g, "／")
    .replace(/[,、]/g, "・")
    .replace(/\{/g, "｛")
    .replace(/\}/g, "｝")
    .replace(/#/g, "＃");
/** コマンドのメソッド名 (英語名の先頭を小文字にする。distill-ddd の例と同じ lowerCamelCase) */
const methodName = (english: string) => english.charAt(0).toLowerCase() + english.slice(1);
const orNone = (lines: string[]) => (lines.length > 0 ? lines : ["- なし"]);

/**
 * ドメインモデルを distill-ddd の形式で書き出す。today は .ddd-session.json の lastUpdated (YYYY-MM-DD)。
 * 保存したコンテキストが無ければ files は空
 */
export function exportDomainDocs(model: UntieModel, options: { today?: string } = {}): DomainDocs {
  const d = model.domain;
  if (isEmptyDomain(d) || d.contexts.length === 0) return { files: [], warnings: ["境界づけられたコンテキストがまだありません"] };
  const warnings: string[] = [];
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const elementName = (id: string) => byId.get(id)?.name || "(名前なし)";
  const derivation = deriveDomainModel(model);
  const notices = domainNotices(model, derivation);

  // ---- 名前 (ファイルをまたいで同じ綴りにする)
  const unique = (label: string, names: Map<string, string>) => {
    const seen = new Map<string, number>();
    for (const n of names.values()) seen.set(n, (seen.get(n) ?? 0) + 1);
    for (const [n, count] of seen) if (count > 1) warnings.push(`${label}「${n}」が ${count} つあります (distill-ddd は名前で結びつけるので、図で 1 つに重なります)`);
  };
  const contextName = new Map(d.contexts.map((c) => [c.id, heading(c.name)]));
  const aggregateName = new Map(d.aggregates.map((a) => [a.id, heading(a.english ?? a.name)]));
  unique("コンテキスト", contextName);
  unique("集約", aggregateName);
  const ctxName = (id: string | null | undefined) => (id ? (contextName.get(id) ?? "?") : "?");

  // ---- 重ね合わせ: 保存したコマンド・イベント・ポリシーに、実装するシステムごとの候補を足す
  const contextIds = new Set(d.contexts.map((c) => c.id));
  const aggregateIds = new Set(d.aggregates.map((a) => a.id));
  const commands = new Map<string, ResolvedCommand>();
  const events = new Map<string, ResolvedEvent>();
  const policies = new Map<string, { eventKey: string; commandKey: string; auto: boolean }>();
  const systems = [...new Set(d.contexts.flatMap((c) => c.systemIds))];
  for (const systemId of systems) {
    const scope = buildDomainScope(model, systemId, derivation, notices);
    const r = resolveDomain(model, systemId, scope, derivation);
    const own = new Set(r.contexts.filter((c) => c.saved && c.role === "own").map((c) => c.key));
    const ownAggregates = new Set(r.aggregates.filter((a) => a.saved && own.has(a.contextKey)).map((a) => a.key));
    for (const c of r.commands) if (c.aggregateKey !== null && ownAggregates.has(c.aggregateKey) && !commands.has(c.key)) commands.set(c.key, c);
    for (const e of r.events) if (e.contextKey !== null && contextIds.has(e.contextKey) && (e.saved || own.has(e.contextKey)) && !events.has(e.key)) events.set(e.key, e);
    for (const p of r.policies) if (!policies.has(`${p.eventKey}\n${p.commandKey}`)) policies.set(`${p.eventKey}\n${p.commandKey}`, { eventKey: p.eventKey, commandKey: p.commandKey, auto: p.auto });
  }
  // システムの無いコンテキストのものなど、上で拾えなかった保存したもの
  for (const c of d.commands) {
    if (!commands.has(c.id) && aggregateIds.has(c.aggregateId)) commands.set(c.id, { key: c.id, saved: c, name: c.name, ...(c.english ? { english: c.english } : {}), candidate: null, sourceKey: null, aggregateKey: c.aggregateId, eventKeys: c.emits });
  }
  for (const e of d.events) {
    if (!events.has(e.id)) events.set(e.id, { key: e.id, saved: e, name: e.name, ...(e.english ? { english: e.english } : {}), scoped: null, sourceKey: null, origin: "inside", contextKey: e.boundedContextId, aggregateKey: e.aggregateId ?? null });
  }
  for (const p of d.policies) if (!policies.has(`${p.eventId}\n${p.commandId}`)) policies.set(`${p.eventId}\n${p.commandId}`, { eventKey: p.eventId, commandKey: p.commandId, auto: p.auto });

  const eventName = new Map([...events.values()].map((e) => [e.key, heading(e.english ?? e.name)]));
  unique("イベント", eventName);
  const commandContext = (c: ResolvedCommand): string | null => (c.aggregateKey !== null ? (d.aggregates.find((a) => a.id === c.aggregateKey)?.boundedContextId ?? null) : null);
  const commandLabel = (c: ResolvedCommand) => (c.english ? methodName(c.english) : cell(c.name));
  const commandsOf = (aggregateId: string) => [...commands.values()].filter((c) => c.aggregateKey === aggregateId);
  const eventsOfContext = (contextId: string) => [...events.values()].filter((e) => e.contextKey === contextId);
  const emittersOf = (eventKey: string) => [...commands.values()].filter((c) => c.eventKeys.includes(eventKey));
  const policiesOf = (eventKey: string) => [...policies.values()].filter((p) => p.eventKey === eventKey && commands.has(p.commandKey));
  for (const c of commands.values()) if (!c.english) warnings.push(`コマンド「${c.name}」に英語名がありません (distill-ddd の集約の図に出ません)`);
  for (const e of events.values()) if (!e.english) warnings.push(`イベント「${e.name}」に英語名がありません (コマンドとの結びつきが図に出ません)`);
  for (const a of d.aggregates) if (!a.english) warnings.push(`集約「${a.name}」に英語名がありません`);

  const problems = checkDomain(model, derivation);
  const map = deriveContextMap(model, derivation);
  const aggregatesOf = (c: BoundedContext): Aggregate[] => d.aggregates.filter((a) => a.boundedContextId === c.id);
  const termsOf = (contextId: string | null) => d.terms.filter((t) => t.boundedContextId === contextId);
  const questionsOf = (types: readonly string[]) => orNone(problems.filter((p) => types.includes(p.type)).map((p) => `- ${cell(p.message)}`));

  // ---- bounded-contexts.md
  const homonyms = notices.filter((n) => n.type === "homonym").map((n) => `- ${cell(n.message)}`);
  const boundedContexts = [
    "# Bounded Contexts",
    "",
    "## Context Map 概要図",
    "",
    "<!-- ddd:diagram:context-map -->",
    "",
    "## Bounded Context 一覧",
    "",
    ...d.contexts.flatMap((c) => {
      const concepts = aggregatesOf(c).map((a) => `${aggregateName.get(a.id)} (集約)`);
      const words = termsOf(c.id).map((t) => cell(t.term));
      return [
        `### ${contextName.get(c.id)}${c.subdomain ? ` (${SUBDOMAIN_ENGLISH[c.subdomain]})` : ""}`,
        ...(c.english ? [`- **英語名**: ${c.english}`] : []),
        `- **責務**: ${c.description ? cell(c.description) : "TBD"}`,
        `- **主要概念**: ${concepts.length > 0 ? concepts.join(", ") : "なし (外部のコンテキスト)"}`,
        `- **ユビキタス言語**: ${words.length > 0 ? words.join("、") : "TBD"}`,
        `- **所有チーム**: ${c.team ? cell(c.team) : "TBD"}`,
        `- **実装するシステム**: ${c.systemIds.length > 0 ? c.systemIds.map(elementName).map(cell).join("、") : "未割り当て"}`,
        ...(c.contextIds.length > 0 ? [`- **分析のコンテキスト (Untie)**: ${c.contextIds.map(elementName).map(cell).join("、")}`] : []),
        "",
      ];
    }),
    "## 言語の境界で発見した事実",
    ...orNone(homonyms),
    "",
    "## 未解決の問い",
    ...questionsOf(["contextUnassigned", "contextWithoutSubdomain", "informationWithoutAggregate"]),
    "",
  ].join("\n");

  // ---- context-map.md
  const relationRows = d.relations.map((r) => {
    const flow = map.flows.find((f) => (f.upstreamId === r.upstreamId && f.downstreamId === r.downstreamId) || (f.relation?.id === r.id));
    return { r, up: ctxName(r.upstreamId), down: ctxName(r.downstreamId), kind: CONTEXT_RELATION_ENGLISH[r.kind], integration: r.integration ? INTEGRATION_ENGLISH[r.integration] : "TBD", flow };
  });
  const contextMap = [
    "# Context Map",
    "",
    "## 図",
    "",
    "<!-- ddd:diagram:context-map -->",
    "",
    "## 関係一覧",
    "",
    "| Upstream | Downstream | 関係 | 統合方式 | 備考 |",
    "|----------|-----------|------|---------|------|",
    ...relationRows.map((x) => `| ${x.up} | ${x.down} | ${x.kind} | ${x.integration} | ${x.r.note ? cell(x.r.note) : ""} |`),
    "",
    "## 統合の詳細",
    "",
    ...relationRows.flatMap((x) => {
      const data = x.flow ? [...x.flow.events, ...x.flow.reads.map((n) => `${n} (取得)`)].map(cell) : [];
      return [
        `### ${x.up} → ${x.down}`,
        `- **関係**: ${x.kind}`,
        `- **流れるデータ**: ${data.length > 0 ? data.join("、") : "TBD"}`,
        `- **統合方式**: ${x.integration}`,
        `- **ACL の有無**: ${x.r.kind === "acl" ? "あり" : "なし"}`,
        ...(x.r.note ? [`- **補足**: ${cell(x.r.note)}`] : []),
        "",
      ];
    }),
    "## 未解決の問い",
    ...questionsOf(["flowWithoutRelation"]),
    "",
  ].join("\n");

  // ---- aggregates.md
  const aggregates = [
    "# Aggregates",
    "",
    "## 集約一覧",
    "",
    ...d.aggregates.flatMap((a) => {
      const list = commandsOf(a.id);
      const named = list.filter((c) => c.english);
      const unnamed = list.filter((c) => !c.english);
      const members = a.memberInformationIds.map((id) => {
        const info = byId.get(id);
        return `- ${cell(info?.name || "(名前なし)")}${info?.description ? `: ${cell(info.description)}` : ""}`;
      });
      const states = a.stateGroup ? model.elements.filter((e) => e.kind === "state" && e.group === a.stateGroup).map((s) => cell(s.name)) : [];
      const inside = new Set([a.rootInformationId, ...a.memberInformationIds]);
      const related = [
        ...new Set(
          model.relations
            .filter((r) => r.kind === "informationRelated" && (inside.has(r.sourceId) !== inside.has(r.targetId)))
            .map((r) => (inside.has(r.sourceId) ? r.targetId : r.sourceId)),
        ),
      ].map((id) => {
        const owner = d.aggregates.find((x) => x.id !== a.id && (x.rootInformationId === id || x.memberInformationIds.includes(id)));
        return owner ? `${aggregateName.get(owner.id)} (ID で参照)` : `${cell(elementName(id))} (集約にしていない情報)`;
      });
      const line = (c: ResolvedCommand) => {
        const emitted = c.eventKeys.map((k) => eventName.get(k)).filter((n): n is string => !!n);
        return `- \`${methodName(c.english!)}()\`: ${cell(c.name)}${emitted.length > 0 ? ` → 発行: ${emitted.map((n) => `\`${n}\``).join(", ")}` : ""}`;
      };
      return [
        `### ${aggregateName.get(a.id)} (Bounded Context: ${ctxName(a.boundedContextId)})`,
        "",
        ...(a.english ? [`**日本語名**: ${cell(a.name)}`] : []),
        `**Root Entity**: ${cell(elementName(a.rootInformationId))}`,
        ...(a.english ? [`**ID**: ${a.english}Id`] : []),
        "",
        "**構成要素**:",
        ...orNone(members),
        "",
        ...(a.stateGroup ? [`**状態**: ${cell(a.stateGroup)} (${states.join(" → ")})`, ""] : []),
        "**ビジネス不変条件**:",
        ...orNone(a.invariants.map((i) => `- ${cell(i.text)}`)),
        "",
        "**操作**:",
        ...orNone(named.map(line)),
        "",
        ...(unnamed.length > 0 ? ["**英語名の無い操作 (図には出ない)**:", ...unnamed.map((c) => `- ${cell(c.name)}`), ""] : []),
        `**他 Aggregate との参照**: ${related.length > 0 ? [...new Set(related)].join(", ") : "なし"}`,
        "",
      ];
    }),
    "## 未解決の問い",
    ...questionsOf(["aggregateOverlap", "aggregateWithoutInvariant"]),
    "",
  ].join("\n");

  // ---- domain-events.md
  const flowLines: string[] = [];
  const eventBlocks = d.contexts.flatMap((c) => {
    const list = eventsOfContext(c.id);
    if (list.length === 0) return [];
    return [
      `### ${contextName.get(c.id)}`,
      "",
      ...list.flatMap((e) => {
        const name = eventName.get(e.key)!;
        const emitters = emittersOf(e.key).map(commandLabel);
        const reacts = policiesOf(e.key).map((p) => ({ p, command: commands.get(p.commandKey)! }));
        const consumers = [...new Set(reacts.map((x) => commandContext(x.command)).filter((id): id is string => !!id && id !== c.id))].map((id) => ctxName(id));
        for (const consumer of consumers) flowLines.push(`${contextName.get(c.id)} --{${name}}--> ${consumer}`);
        const properties = e.saved?.properties ?? [];
        return [
          `#### ${name}`,
          ...(e.english ? [`- **日本語名**: ${cell(e.name)}`] : []),
          ...(e.aggregateKey !== null && aggregateName.has(e.aggregateKey) ? [`- **発生元 Aggregate**: ${aggregateName.get(e.aggregateKey)}`] : []),
          `- **トリガー**: ${emitters.length > 0 ? emitters.join(", ") : e.origin === "outside" ? "外部 (このコンテキストの外で発生する)" : "TBD"}`,
          ...(properties.length > 0 ? ["- **プロパティ**:", ...properties.map((p) => `  - \`${cell(p.name)}\``)] : []),
          ...(consumers.length > 0 ? [`- **Consumer**: ${consumers.join(", ")}`] : []),
          ...(reacts.length > 0 ? [`- **ポリシー**: ${reacts.map((x) => `${commandLabel(x.command)} (${x.p.auto ? "自動" : "人が判断"})`).join("、")}`] : []),
          "",
        ];
      }),
    ];
  });
  const domainEvents = [
    "# Domain Events",
    "",
    "## イベント一覧",
    "",
    ...(eventBlocks.length > 0 ? eventBlocks : ["(イベントはまだありません)", ""]),
    "## Event Flow (コンテキスト間)",
    "",
    "<!-- ddd:diagram:event-flow -->",
    "",
    ...(flowLines.length > 0 ? [...new Set(flowLines)] : ["(コンテキストをまたぐイベントはありません)"]),
    "",
    "## 未解決の問い",
    ...orNone([...events.values()].filter((e) => !e.english).map((e) => `- イベント「${cell(e.name)}」の英語名が決まっていません`)),
    "",
  ].join("\n");

  // ---- glossary.md
  const termRows = (contextId: string | null): string[] => {
    const rows = termsOf(contextId).map((t) => {
      const el = t.elementId ? byId.get(t.elementId) : undefined;
      return `| ${cell(t.term)} | ${t.english ? cell(t.english) : ""} | ${cell(t.definition || el?.description || "")} |`;
    });
    // 集約は主な名詞なので、用語に無ければ足す
    if (contextId !== null) {
      for (const a of d.aggregates.filter((x) => x.boundedContextId === contextId && x.english)) {
        if (d.terms.some((t) => t.elementId === a.rootInformationId || t.term === a.name)) continue;
        rows.push(`| ${cell(a.name)} | ${a.english} | ${cell(byId.get(a.rootInformationId)?.description || "集約")} |`);
      }
    }
    return rows;
  };
  const glossarySections = [...d.contexts.map((c) => ({ title: contextName.get(c.id)!, rows: termRows(c.id) })), { title: "共通", rows: termRows(null) }].filter((s) => s.rows.length > 0);
  const glossary = [
    "# ユビキタス言語 (用語集)",
    "",
    ...(glossarySections.length > 0 ? glossarySections.flatMap((s) => [`## ${s.title}`, "", "| 用語 | 英語 | 定義 |", "|------|------|------|", ...s.rows, ""]) : ["(用語はまだありません)", ""]),
  ].join("\n");

  // ---- event-storming.md (分析から導いた現状に、保存した名前を重ねたもの)
  const actorsOf = (c: ResolvedCommand) => (c.candidate ? (c.candidate.auto ? "System" : c.candidate.actors.map((a) => cell(a.name)).join("・") || "TBD") : "TBD");
  const storming = [
    "# Event Storming",
    "",
    "Untie の業務分析 (RDRA) から導いたものです。イベントの並びは時系列ではなく、分析の並び順です。",
    "",
    "## Domain Events (時系列)",
    "",
    ...d.contexts.flatMap((c) => {
      const list = eventsOfContext(c.id);
      return list.length > 0 ? [`### ${contextName.get(c.id)}`, ...list.map((e, i) => `${i + 1}. ${eventName.get(e.key)}${e.english ? ` — ${cell(e.name)}` : ""}`), ""] : [];
    }),
    "## Command / Event マトリクス",
    "",
    "| Actor | Command | Aggregate | Event | 備考 |",
    "|-------|---------|-----------|-------|------|",
    ...[...commands.values()].map((c) => {
      const emitted = c.eventKeys.map((k) => eventName.get(k)).filter(Boolean).join(", ");
      const trigger = [...policies.values()].filter((p) => p.commandKey === c.key && eventName.has(p.eventKey)).map((p) => `${eventName.get(p.eventKey)} がきっかけ (${p.auto ? "自動" : "人が判断"})`);
      const note = [c.english ? cell(c.name) : "", !c.candidate ? "あるべき姿 (分析に無い)" : "", ...trigger].filter(Boolean).join("。");
      return `| ${actorsOf(c)} | ${commandLabel(c)} | ${c.aggregateKey !== null ? (aggregateName.get(c.aggregateKey) ?? "") : ""} | ${emitted} | ${note} |`;
    }),
    "",
    "## 発見された問題点",
    ...orNone(notices.filter((n) => n.level === "question").map((n) => `- ${cell(n.message)}`)),
    "",
    "## Bounded Context 候補",
    ...d.contexts.map((c) => `- ${contextName.get(c.id)}: ${eventsOfContext(c.id).map((e) => eventName.get(e.key)).join(", ") || "(イベントなし)"}`),
    "",
    "## 未解決の問い",
    ...orNone(d.excluded.length > 0 ? [`- あるべき姿から外した候補が ${d.excluded.length} 件あります (Untie のドメインボードの「外した候補」)`] : []),
    "",
  ].join("\n");

  // ---- .ddd-session.json: Untie が書き出したフェーズだけを済みにする。discover (コアドメインの理由など) は人が決めるので、そこから再開する
  const completed = [
    ...(commands.size + events.size > 0 ? ["storming"] : []),
    "contexts",
    // 関係を決める相手がいて (コンテキストが 2 つ以上)、つながりのある組をすべて決めてあるとき
    ...(d.contexts.length >= 2 && map.flows.every((f) => f.relation || f.reverseRelation) ? ["mapping"] : []),
    ...(d.aggregates.length > 0 ? ["aggregates"] : []),
    ...(events.size > 0 ? ["events"] : []),
    ...(glossarySections.length > 0 ? ["glossary"] : []),
  ];
  const session = {
    currentPhase: "discover",
    completedPhases: completed,
    ...(options.today ? { lastUpdated: options.today } : {}),
    openQuestions: [...problems.filter((p) => p.type !== "missingEnglish").map((p) => p.message), ...warnings].slice(0, 30),
  };

  return {
    files: [
      { name: "event-storming.md", text: storming },
      { name: "bounded-contexts.md", text: boundedContexts },
      { name: "context-map.md", text: contextMap },
      { name: "aggregates.md", text: aggregates },
      { name: "domain-events.md", text: domainEvents },
      { name: "glossary.md", text: glossary },
      { name: DOMAIN_SESSION_FILE, text: `${JSON.stringify(session, null, 2)}\n` },
    ],
    warnings,
  };
}
