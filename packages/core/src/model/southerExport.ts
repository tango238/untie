// 業務ルールの骨組みを Souther (https://github.com/souther-lang/souther) のソース (.sou) に書き出す (6.1)。開発モードの中で使う。
// Souther は、業務ルールを data と behavior で書き、example の行をコンパイルのときに評価して、どの組み合わせに行が無いかを測る言語。
// ここで書き出すのは、分析から機械的に導けるところまで:
//   状態 → フィールドの無い data と、状態のグループの和
//   操作 → behavior (入力: 前提の状態と、判断する条件の真偽。出力: 次の状態か、条件のときの別の結果)
//   代替パターン (条件のときにどうなるか) → guard … else と、その example の行
// 条件の式 (何で判断するか)・情報の項目・不変条件は、ここでは書けない (分析に無い)。条件は真偽の入力にしておき、あとで詰める。
// まだ決まっていない組み合わせは、答えを `<?>` にした行にする (Souther が「答え待ち」と数える)。純粋関数だけを置く。
import { usecasePlaces } from "./placement";
import type { Element, Relation, UntieModel } from "./types";

/** まだ決まっていない組み合わせ 1 件 */
export interface SoutherOpenPattern {
  usecaseId: string;
  /** alternateUndecided: 条件のときにどうなるかが未定。nextStateUndecided: 次の状態が同じグループに複数あり、どれになるかが未定 */
  kind: "alternateUndecided" | "nextStateUndecided";
  message: string;
}

export interface SoutherExport {
  /** ファイル名 (ASCII。システムの id から作る) */
  fileName: string;
  moduleName: string;
  text: string;
  /** 書き出した behavior の数 */
  behaviors: number;
  /** example の行の数 (答え待ちを含む) */
  rows: number;
  /** 答え待ちの行の数 */
  owed: number;
  open: SoutherOpenPattern[];
  /** 前提の状態も、判断する条件も無いので書き出さなかった操作 (確かめる組み合わせが無い) */
  skipped: { usecaseId: string; name: string }[];
}

/** Souther の予約語・文脈で意味を持つ語・標準ライブラリの名前。識別子にしない */
const RESERVED = new Set([
  ...["module", "import", "exposing", "data", "invariant", "behavior", "constructs", "depends", "ensures", "match", "with", "as", "let", "if", "then", "else", "guard", "unreachable", "true", "false"],
  ...["examples", "for", "example", "fake", "private", "partial", "on", "intrinsic"],
  ...["None", "value", "Bool", "Int", "Decimal", "Rational", "String", "Date", "Time", "DateTime", "Instant", "List", "Map", "Set", "Main", "main"],
]);

/** 名前を Souther の識別子にする (文字と数字と _ だけ。日本語はそのまま使える) */
export function southerIdentifier(raw: string): string {
  let s = raw
    .normalize("NFC")
    .replace(/[^\p{L}\p{Nd}_]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (s === "") s = "名前なし";
  if (!/^\p{L}/u.test(s)) s = `n${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  return s;
}

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";
/** コメントに入れる 1 行の文 */
const line = (text: string): string => text.replace(/\s+/g, " ").trim();
/** 文字列リテラル */
const quote = (text: string): string => `"${line(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

interface StateGroup {
  key: string;
  /** グループの名前 (グループに入っていない状態は、状態の名前) */
  label: string;
  states: Extract<Element, { kind: "state" }>[];
}

/** 例の行にする、前提の状態の組み合わせの上限 (グループが多い操作で行が増えすぎないように) */
const MAX_COMBINATIONS = 12;

/** そのシステムの操作を、Souther のソースに書き出す */
export function exportSouther(model: UntieModel, systemId: string): SoutherExport {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const system = byId.get(systemId);
  const places = usecasePlaces(model);
  const usecases = model.elements.filter((e): e is Extract<Element, { kind: "usecase" }> => e.kind === "usecase" && places.get(e.id) === systemId);
  const rel = (kind: Relation["kind"]) => model.relations.filter((r) => r.kind === kind);
  const stateOf = (id: string) => {
    const e = byId.get(id);
    return e?.kind === "state" ? e : undefined;
  };
  const moduleName = `untie.${southerIdentifier(systemId)}`;
  const fileName = `${southerIdentifier(systemId)}.sou`;

  // 名前: data と behavior は同じ名前を持てないので、1 つの表で重なりを避ける
  const used = new Set<string>();
  const alloc = (base: string): string => {
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${i}`;
    used.add(name);
    return name;
  };

  // 状態: このシステムの操作が前提にする・次にする状態と、同じグループの状態 (グループの和を閉じるため)
  const touched = new Set<string>();
  const usecaseIds = new Set(usecases.map((u) => u.id));
  for (const r of rel("stateUsecase")) if (usecaseIds.has(r.targetId)) touched.add(r.sourceId);
  for (const r of rel("usecaseState")) if (usecaseIds.has(r.sourceId)) touched.add(r.targetId);
  const groupKey = (s: Extract<Element, { kind: "state" }>) => (s.group?.trim() ? `g:${s.group.trim()}` : `s:${s.id}`);
  const groups = new Map<string, StateGroup>();
  const touchedKeys = new Set([...touched].flatMap((id) => (stateOf(id) ? [groupKey(stateOf(id)!)] : [])));
  for (const e of model.elements) {
    if (e.kind !== "state" || !touchedKeys.has(groupKey(e))) continue;
    const key = groupKey(e);
    const g = groups.get(key) ?? { key, label: e.group?.trim() || nameOf(e), states: [] };
    g.states.push(e);
    groups.set(key, g);
  }
  const stateName = new Map<string, string>();
  const groupName = new Map<string, string>();
  for (const g of groups.values()) {
    for (const s of g.states) {
      const plain = southerIdentifier(nameOf(s));
      stateName.set(s.id, alloc(used.has(plain) ? `${southerIdentifier(g.label)}_${plain}` : plain));
    }
  }
  for (const g of groups.values()) if (g.states.length > 1) groupName.set(g.key, alloc(southerIdentifier(g.label)));

  const out: string[] = [
    "// untie が分析から書き出した、業務ルールの骨組み (自動生成。手で直しても、書き出し直すと消える)",
    `// システム: ${line(nameOf(system))}`,
    "//",
    "// 状態は data、操作は behavior。条件は真偽の入力にしてある (何で判断するかの式は、分析に無いのでまだ書いていない)。",
    "// example の行は、ふだんの流れと、条件のときの流れ (代替パターン)。答えが `<?>` の行は、まだ決まっていない組み合わせ。",
    `module ${moduleName}`,
    "",
  ];

  if (groups.size > 0) out.push("// ---- 状態", "");
  for (const g of groups.values()) {
    if (g.states.length > 1) {
      out.push(`data ${groupName.get(g.key)} = ${g.states.map((s) => stateName.get(s.id)).join(" | ")}`, "");
    } else {
      out.push(`data ${stateName.get(g.states[0]!.id)}`, "");
    }
  }

  // 操作ごとの材料
  const sourcesOf = (kind: Relation["kind"], targetId: string) => rel(kind).filter((r) => r.targetId === targetId).map((r) => r.sourceId);
  const targetsOf = (kind: Relation["kind"], sourceId: string) => rel(kind).filter((r) => r.sourceId === sourceId).map((r) => r.targetId);
  const byGroup = (ids: string[]): { group: StateGroup; states: string[] }[] => {
    const result: { group: StateGroup; states: string[] }[] = [];
    for (const id of ids) {
      const s = stateOf(id);
      if (!s) continue;
      const group = groups.get(groupKey(s))!;
      const entry = result.find((x) => x.group === group);
      if (entry) entry.states.push(stateName.get(id)!);
      else result.push({ group, states: [stateName.get(id)!] });
    }
    return result;
  };

  const open: SoutherOpenPattern[] = [];
  const skipped: SoutherExport["skipped"] = [];
  const blocks: string[] = [];
  let behaviors = 0;
  let rows = 0;
  let owed = 0;

  for (const u of usecases) {
    const pre = byGroup(sourcesOf("stateUsecase", u.id));
    const post = byGroup(targetsOf("usecaseState", u.id));
    const conditions = rel("usecaseCondition")
      .filter((r) => r.sourceId === u.id && byId.get(r.targetId)?.kind === "condition")
      .map((r) => ({ relation: r, condition: byId.get(r.targetId)! }));
    if (pre.length === 0 && conditions.length === 0) {
      skipped.push({ usecaseId: u.id, name: nameOf(u) });
      continue;
    }
    const behavior = alloc(southerIdentifier(nameOf(u)));

    // 入力: 前提の状態 (グループごと) と、条件の真偽
    const params: { name: string; type: string }[] = [];
    const local = new Set<string>();
    const param = (base: string): string => {
      let name = base;
      for (let i = 2; used.has(name) || local.has(name); i++) name = `${base}_${i}`;
      local.add(name);
      return name;
    };
    // behavior の引数には、名前の無い和 (`状態 | 状態`) を書けない。前提の状態が複数あるときは、グループの和をそのまま使うか
    // (グループの状態のすべてが前提のとき)、その操作の前提だけの和を宣言する (1 つの状態は、複数の和の場合になれる)
    const preDeclarations: string[] = [];
    for (const p of pre) {
      const name = param(southerIdentifier(`前の${p.group.label}`));
      let type = p.states[0]!;
      if (p.states.length > 1) {
        const whole = p.states.length === p.group.states.length ? groupName.get(p.group.key) : undefined;
        type = whole ?? alloc(`${behavior}_${name}`);
        if (!whole) preDeclarations.push(`data ${type} = ${p.states.join(" | ")}`);
      }
      params.push({ name, type });
    }
    const conds = conditions.map(({ relation, condition }) => ({ relation, condition, name: param(southerIdentifier(nameOf(condition))) }));
    for (const c of conds) params.push({ name: c.name, type: "Bool" });

    // 出力: ふだんの結果 (次の状態) と、条件のときの別の結果
    const ambiguous = post.filter((p) => p.states.length > 1);
    let normalType: string;
    let normalValue: string | null;
    let normalLabel: string;
    const declarations: string[] = [...preDeclarations];
    if (ambiguous.length > 0) {
      // 同じグループに次の状態が複数ある: どのときにどれになるかは、分析からは決まらない
      normalValue = null;
      normalType = post.length === 1 ? post[0]!.states.join(" | ") : alloc(`${behavior}_完了`);
      normalLabel = ambiguous.map((p) => p.states.join(" か ")).join("、");
      open.push({
        usecaseId: u.id,
        kind: "nextStateUndecided",
        message: `操作「${nameOf(u)}」の次の状態が、同じ「${ambiguous.map((p) => p.group.label).join("」「")}」に複数あります (${normalLabel})。どのときにどれになるかを決めてください`,
      });
    } else if (post.length === 0) {
      normalType = alloc(`${behavior}_完了`);
      normalValue = normalType;
      normalLabel = "完了";
    } else if (post.length === 1) {
      normalType = post[0]!.states[0]!;
      normalValue = normalType;
      normalLabel = normalType;
    } else {
      // 複数のグループの状態が同時に変わる: 結果を 1 つの data にまとめる
      normalType = alloc(`${behavior}_結果`);
      const fields = post.map((p) => ({ field: southerIdentifier(p.group.label), state: p.states[0]! }));
      declarations.push(`data ${normalType} = { ${fields.map((f) => `${f.field}: ${f.state}`).join(", ")} }`);
      normalValue = `${normalType} { ${fields.map((f) => `${f.field} = ${f.state}`).join(", ")} }`;
      normalLabel = fields.map((f) => f.state).join("・");
    }
    const alternates = conds.flatMap((c) => {
      const a = c.relation.alternate;
      if (!a) return [];
      return [{ ...c, alternate: a, type: alloc(`${behavior}_${southerIdentifier(nameOf(c.condition))}${a.when === "met" ? "" : "_でない"}`) }];
    });
    const undecided = conds.filter((c) => !c.relation.alternate);
    for (const c of undecided) {
      open.push({ usecaseId: u.id, kind: "alternateUndecided", message: `操作「${nameOf(u)}」で、条件「${nameOf(c.condition)}」のときにどうなるかが決まっていません` });
    }
    const output = [normalType, ...alternates.map((a) => a.type)].join(" | ");

    // コメント: どの作業の操作か、扱う情報、起きる出来事
    const activities = sourcesOf("activityUsecase", u.id).map((id) => byId.get(id));
    const actors = [...new Set(activities.flatMap((a) => (a ? sourcesOf("actorActivity", a.id) : [])))].map((id) => nameOf(byId.get(id)));
    const information = rel("usecaseInformation").filter((r) => r.sourceId === u.id);
    const reads = information.filter((r) => r.access !== "write").map((r) => nameOf(byId.get(r.targetId)));
    const writes = information.filter((r) => r.access !== "read").map((r) => nameOf(byId.get(r.targetId)));
    const events = targetsOf("usecaseEvent", u.id).map((id) => nameOf(byId.get(id)));
    const block: string[] = [`// 操作: ${line(nameOf(u))}`];
    if (activities.length > 0) block.push(`//   作業: ${line(activities.map((a) => nameOf(a)).join("・"))}${actors.length > 0 ? ` (担当: ${line(actors.join("・"))})` : ""}`);
    if (reads.length > 0) block.push(`//   取得する情報: ${line(reads.join("・"))}`);
    if (writes.length > 0) block.push(`//   保存する情報: ${line(writes.join("・"))}`);
    if (events.length > 0) block.push(`//   起きる出来事: ${line(events.join("・"))}`);
    for (const a of alternates) {
      const event = a.alternate.eventId ? byId.get(a.alternate.eventId) : undefined;
      block.push(`//   ${line(nameOf(a.condition))}${a.alternate.when === "met" ? "" : " でない"}とき: ${line(a.alternate.then)}${event ? ` (出来事: ${line(nameOf(event))})` : ""}`);
    }
    block.push(...declarations);
    block.push(`behavior ${behavior} : (${params.map((p) => `${p.name}: ${p.type}`).join(", ")}) -> ${output}`);
    if (normalValue !== null) {
      const head = `let ${behavior} (${params.map((p) => p.name).join(", ")}) =`;
      if (alternates.length === 0) block.push(`${head} ${normalValue}`);
      else {
        block.push(`${head} {`);
        // 条件を満たすときに別の結果になるなら「満たさないこと」を、満たさないときに別の結果になるなら「満たすこと」を確かめる
        for (const a of alternates) block.push(`    guard ${a.alternate.when === "met" ? `Bool.not(${a.name})` : a.name} else ${a.type}`);
        block.push(`    ${normalValue}`, "}");
      }
    } else {
      block.push("// 次の状態が決まっていないので、中身はまだ書けない (行は、何が要るかを記録するだけ)");
    }

    // 例の行: ふだんの流れ (前提の状態の組み合わせごと)、代替パターン、まだ決まっていない条件
    const combos = pre.reduce<string[][]>((acc, p) => acc.flatMap((c) => p.states.map((s) => [...c, s])), [[]]).slice(0, MAX_COMBINATIONS);
    /** ふだんの流れになる側の真偽 */
    const calm = (c: (typeof conds)[number]): boolean => (c.relation.alternate ? c.relation.alternate.when !== "met" : false);
    // flipped: その条件だけを、ふだんと反対の側にする (条件の名前で見分ける)
    const args = (combo: string[], flipped?: { name: string }) => [...combo, ...conds.map((c) => String(c.name === flipped?.name ? !calm(c) : calm(c)))].join(", ");
    const names = new Set<string>();
    const rowName = (base: string): string => {
      let name = line(base);
      for (let i = 2; names.has(name); i++) name = `${line(base)} (${i})`;
      names.add(name);
      return name;
    };
    const lines: string[] = [];
    const row = (name: string, input: string, answer: string | null) => {
      lines.push(`    | ${quote(rowName(name))} : (${input}) -> ${answer ?? "<?>"}`);
      rows++;
      if (answer === null) owed++;
    };
    for (const combo of combos) row(`ふだんの流れ${combo.length > 0 ? `: ${combo.join("・")} から` : ""} → ${normalLabel}`, args(combo), normalValue === null ? null : normalType);
    for (const a of alternates) row(`${nameOf(a.condition)}${a.alternate.when === "met" ? "" : " でない"}とき: ${a.alternate.then}`, args(combos[0]!, a), a.type);
    for (const c of undecided) row(`${nameOf(c.condition)} のとき: まだ決まっていない`, args(combos[0]!, c), null);
    block.push(`example ${behavior}`, ...lines);
    blocks.push(block.join("\n"));
    behaviors++;
  }

  if (blocks.length > 0) out.push("// ---- 操作", "", blocks.join("\n\n"), "");
  if (skipped.length > 0) {
    out.push("// ---- 書き出していない操作 (前提の状態も、判断する条件も無いので、確かめる組み合わせが無い)");
    for (const s of skipped) out.push(`//   ${line(s.name)}`);
    out.push("");
  }
  return { fileName, moduleName, text: `${out.join("\n").replace(/\n+$/, "")}\n`, behaviors, rows, owed, open, skipped };
}

/** 設計のあるなしにかかわらず、操作を書き出せるシステムの分をまとめて書き出す (behavior が 1 つも無いシステムは除く) */
export function exportSoutherAll(model: UntieModel): (SoutherExport & { systemId: string })[] {
  return model.elements
    .filter((e) => e.kind === "system")
    .map((s) => ({ systemId: s.id, ...exportSouther(model, s.id) }))
    .filter((x) => x.behaviors > 0);
}
