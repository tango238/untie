// 受け入れテスト (6.1)。設計から、「この状態のものに、この条件で、この操作をしたら、結果と状態はこうなる」というケースを機械的に導く。
// 実装を作る側 (AI のエージェント) が自分で書いたテストは、自分の誤りに合わせて書けてしまう。出来上がったかどうかは、
// 設計から作った、作る側が書き換えないテストで判定する。作る側の API の形には依存しない: 作る側は、自分のアプリケーションに
// つなぐ小さな口 (ドライバー) だけを書き、ケースとテストの本体は、ここで作ったものをそのまま使う。純粋関数だけを置く。
import { usecasePlaces } from "./placement";
import { ALTERNATE_ERROR_LABELS, stateGroupKey, type AlternateError, type Element, type Relation, type UntieModel } from "./types";

export type AcceptanceOutcome = "done" | "wrongState" | "alternate" | "error";

export interface AcceptanceCase {
  /** ケースの id (操作の id と、その中の番号) */
  id: string;
  usecaseId: string;
  /** 操作の名前 */
  operation: string;
  title: string;
  kind: "normal" | "wrongState" | "alternate";
  given: {
    /** 状態グループの名前 → 状態の名前 (操作の前提の状態があるグループだけ) */
    states: Record<string, string>;
    /** 条件の名前 → 満たすか */
    conditions: Record<string, boolean>;
  };
  expect: {
    /** done: ふだんの結果。wrongState: 前提の状態が違うので行えない。alternate: 条件のときの別の結果。error: 条件のときの結果がエラー */
    outcome: AcceptanceOutcome;
    /** alternate・error のとき、どの条件の分岐か (条件の名前) */
    condition?: string;
    /** error のとき、その種類 (サーバーエラーは HTTP ステータスも) */
    error?: AlternateError;
    /** そのあとの状態 (状態グループの名前 → 状態の名前)。ここに挙げたグループだけを確かめる */
    states: Record<string, string>;
  };
}

/** 設計で決まっていないので、ケースにできなかったもの */
export interface AcceptancePending {
  usecaseId: string;
  operation: string;
  reason: string;
}

export interface AcceptanceSuite {
  systemId: string;
  system: string;
  cases: AcceptanceCase[];
  pending: AcceptancePending[];
}

const nameOf = (e: { name: string } | undefined): string => e?.name || "(名前なし)";

/** ふだんの流れのケースにする、前提の状態の組み合わせの上限 */
const MAX_COMBINATIONS = 12;

/** そのシステムの操作から、受け入れテストのケースを導く */
export function deriveAcceptanceCases(model: UntieModel, systemId: string): AcceptanceSuite {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const places = usecasePlaces(model);
  const usecases = model.elements.filter((e) => e.kind === "usecase" && places.get(e.id) === systemId);
  const rel = (kind: Relation["kind"]) => model.relations.filter((r) => r.kind === kind);
  type State = Extract<Element, { kind: "state" }>;
  const stateOf = (id: string): State | undefined => {
    const e = byId.get(id);
    return e?.kind === "state" ? e : undefined;
  };
  const states = model.elements.filter((e): e is State => e.kind === "state");
  /** グループの名前 (グループの無い状態は、状態の名前) */
  const groupLabel = (s: State): string => s.group?.trim() || nameOf(s);
  const groupSize = (s: State): number => states.filter((x) => stateGroupKey(x) === stateGroupKey(s)).length;
  /** 状態の id の並びを、グループごとにまとめる */
  const byGroup = (ids: string[]): { label: string; key: string; states: State[] }[] => {
    const out: { label: string; key: string; states: State[] }[] = [];
    for (const id of ids) {
      const s = stateOf(id);
      if (!s) continue;
      const entry = out.find((x) => x.key === stateGroupKey(s));
      if (entry) entry.states.push(s);
      else out.push({ label: groupLabel(s), key: stateGroupKey(s), states: [s] });
    }
    return out;
  };

  const cases: AcceptanceCase[] = [];
  const pending: AcceptancePending[] = [];
  for (const u of usecases) {
    const operation = nameOf(u);
    const pre = byGroup(rel("stateUsecase").filter((r) => r.targetId === u.id).map((r) => r.sourceId));
    const post = byGroup(rel("usecaseState").filter((r) => r.sourceId === u.id).map((r) => r.targetId));
    const conds = rel("usecaseCondition")
      .filter((r) => r.sourceId === u.id && byId.get(r.targetId)?.kind === "condition")
      .map((r) => ({ relation: r, name: nameOf(byId.get(r.targetId)) }));
    // 前提の状態も、判断する条件も無い操作は、確かめる組み合わせが無い
    if (pre.length === 0 && conds.length === 0) continue;
    let n = 0;
    const add = (c: Omit<AcceptanceCase, "id" | "usecaseId" | "operation">) => cases.push({ id: `${u.id}#${++n}`, usecaseId: u.id, operation, ...c });
    const wait = (reason: string) => pending.push({ usecaseId: u.id, operation, reason });

    // ふだんの流れになる側の真偽 (満たすときに別の結果になる条件は、満たさない側)
    const calm = Object.fromEntries(conds.map((c) => [c.name, c.relation.alternate ? c.relation.alternate.when !== "met" : false]));
    const combos = pre.reduce<Record<string, string>[]>((acc, p) => acc.flatMap((c) => p.states.map((s) => ({ ...c, [p.label]: nameOf(s) }))), [{}]).slice(0, MAX_COMBINATIONS);
    const first = combos[0]!;
    // 次の状態: 同じグループに複数あれば、どのときにどれになるかが決まっていない
    const ambiguous = post.filter((p) => p.states.length > 1);
    const next = Object.fromEntries(post.map((p) => [p.label, nameOf(p.states[0])]));

    if (ambiguous.length > 0) {
      wait(`次の状態が、同じ「${ambiguous.map((p) => p.label).join("」「")}」に複数あります (${ambiguous.map((p) => p.states.map(nameOf).join(" か ")).join("、")})。どのときにどれになるかが決まっていません`);
    } else {
      for (const combo of combos) {
        const from = Object.values(combo).join("・");
        add({ kind: "normal", title: `ふだんの流れ${from ? `: ${from} から` : ""}`, given: { states: combo, conditions: calm }, expect: { outcome: "done", states: { ...combo, ...next } } });
      }
    }
    // 前提の状態が違うとき: 行えず、状態は変わらない (グループに状態が 1 つしか無ければ、違う状態が無い)
    for (const p of pre) {
      if (groupSize(p.states[0]!) < 2) continue;
      for (const s of states.filter((x) => stateGroupKey(x) === p.key && !p.states.includes(x))) {
        const given = { ...first, [p.label]: nameOf(s) };
        add({ kind: "wrongState", title: `前提の状態が違う: ${nameOf(s)} では行えない`, given: { states: given, conditions: calm }, expect: { outcome: "wrongState", states: given } });
      }
    }
    // 条件のときの別の結果 (代替パターン)
    for (const c of conds) {
      const a = c.relation.alternate;
      if (!a) {
        wait(`条件「${c.name}」のときにどうなるかが決まっていません`);
        continue;
      }
      const given = { states: first, conditions: { ...calm, [c.name]: a.when === "met" } };
      const title = `${c.name}${a.when === "met" ? "" : " でない"}とき: ${a.then}`;
      if (a.error) {
        add({ kind: "alternate", title: `${title} (${ALTERNATE_ERROR_LABELS[a.error.type]}${a.error.status !== undefined ? ` ${a.error.status}` : ""})`, given, expect: { outcome: "error", condition: c.name, error: a.error, states: first } });
        continue;
      }
      if (!a.after) {
        // 操作が状態を変えないなら、そのあとの状態は決めなくてよい (変わらない)
        if (post.length > 0) wait(`条件「${c.name}」のときに、そのあとの状態がどうなるかが決まっていません`);
        else add({ kind: "alternate", title, given, expect: { outcome: "alternate", condition: c.name, states: first } });
        continue;
      }
      if (a.after.type === "normal" && ambiguous.length > 0) {
        wait(`条件「${c.name}」のときの、そのあとの状態は「ふだんと同じ」ですが、ふだんの次の状態が決まっていません`);
        continue;
      }
      const chosen = Object.fromEntries(
        byGroup(a.after.type === "states" ? (a.after.stateIds ?? []) : []).map((g) => [g.label, nameOf(g.states[0])]),
      );
      const after = a.after.type === "unchanged" ? first : a.after.type === "normal" ? { ...first, ...next } : { ...first, ...chosen };
      add({ kind: "alternate", title, given, expect: { outcome: "alternate", condition: c.name, states: after } });
    }
  }
  return { systemId, system: nameOf(byId.get(systemId)), cases, pending };
}

/** 受け入れテストを流す、固定のテスト本体のファイル名 */
export const ACCEPTANCE_RUNNER_FILE = "run.test.ts";
export const ACCEPTANCE_README_FILE = "README.md";
/** 書き出すフォルダの名前 (zip の中) */
export const ACCEPTANCE_DIR = "acceptance";

/** テスト本体。node:test で、同じフォルダの *.cases.json を読み、driver.ts を通してアプリケーションを動かす。どの設計でも同じ中身 */
const RUNNER = `// untie が設計から作った受け入れテストの本体 (自動生成。書き換えない)。
// 同じフォルダの *.cases.json のケースを、driver.ts を通して、アプリケーションに 1 件ずつ当てる。
// 動かし方: node --test acceptance/run.test.ts   (Node 22 以上。ビルドは要らない)
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import driver from "./driver.ts";

/** 操作を 1 回行う、という依頼。states は、操作の前の状態 (状態グループの名前 → 状態の名前)。conditions は、条件の名前 → 満たすか */
export interface AcceptanceInput {
  operation: string;
  states: Record<string, string>;
  conditions: Record<string, boolean>;
}

/**
 * 操作の結果。
 * outcome: done (ふだんの結果)・wrongState (前提の状態が違うので行えない)・alternate (条件のときの別の結果)・error (条件のときの結果がエラー)
 * condition: alternate・error のとき、どの条件の分岐か (条件の名前)
 * states: 操作のあとの状態 (状態グループの名前 → 状態の名前)。アプリケーションに保存されているものを読んで返す
 */
export interface AcceptanceResult {
  outcome: "done" | "wrongState" | "alternate" | "error";
  condition?: string;
  error?: { type: "input" | "server"; status?: number };
  states: Record<string, string>;
}

/** 実装する側が driver.ts に書くもの。states の状態のものを用意し、conditions を渡して操作を行い、結果を返す */
export interface AcceptanceDriver {
  run(input: AcceptanceInput): Promise<AcceptanceResult> | AcceptanceResult;
}

const here = new URL(".", import.meta.url);
const files = readdirSync(here)
  .filter((f) => f.endsWith(".cases.json"))
  .sort();
test("受け入れテストのケースがある", () => assert.ok(files.length > 0, "*.cases.json がありません"));

for (const file of files) {
  const suite = JSON.parse(readFileSync(new URL(file, here), "utf8"));
  for (const c of suite.cases) {
    test(\`\${suite.system} / \${c.operation} / \${c.title}\`, async () => {
      const result = await (driver as AcceptanceDriver).run({ operation: c.operation, states: c.given.states, conditions: c.given.conditions });
      assert.equal(result.outcome, c.expect.outcome, "結果の種類");
      if (c.expect.condition !== undefined) assert.equal(result.condition, c.expect.condition, "どの条件の分岐か");
      if (c.expect.error !== undefined) {
        assert.equal(result.error?.type, c.expect.error.type, "エラーの種類");
        if (c.expect.error.status !== undefined) assert.equal(result.error?.status, c.expect.error.status, "HTTP ステータス");
      }
      for (const [group, state] of Object.entries(c.expect.states)) assert.equal(result.states[group], state, \`操作のあとの「\${group}」\`);
    });
  }
  // 設計で決まっていないことが残っているあいだは、出来上がったとは言えない
  test(\`\${suite.system} / 設計で決まっていないことが無い\`, () => assert.deepEqual(suite.pending.map((p: { operation: string; reason: string }) => \`\${p.operation}: \${p.reason}\`), []));
}
`;

const README = `# 受け入れテスト

untie が、設計 (操作・状態・条件・代替パターン) から作ったテストです。出来上がったアプリケーションが設計のとおりに動くかを、
作る側が書いたテストとは別に確かめます。

- \`*.cases.json\` … ケースの一覧 (システムごとに 1 つ)。「この状態のものに、この条件で、この操作をしたら、結果と状態はこうなる」
- \`run.test.ts\` … ケースを 1 件ずつ当てる、テストの本体
- \`driver.ts\` … **実装する側が書くもの。** テストの本体と、アプリケーションをつなぐ

\`*.cases.json\` と \`run.test.ts\` は、書き換えないでください (設計を直して、untie から書き出し直します)。

## driver.ts の書き方

\`run.test.ts\` の \`AcceptanceDriver\` を満たすものを、既定の export にします。

\`\`\`ts
import type { AcceptanceDriver } from "./run.test.ts";

const driver: AcceptanceDriver = {
  async run({ operation, states, conditions }) {
    // 1. states の状態のもの (予約など) を、アプリケーションに用意する
    // 2. conditions (条件の名前 → 満たすか) を渡して、operation (操作の名前) を行う
    // 3. 結果の種類と、アプリケーションに保存されている状態を読んで返す
    return { outcome: "done", states: {} };
  },
};
export default driver;
\`\`\`

driver.ts は、利用者が使うのと同じ入口 (HTTP の API や画面) を通して、アプリケーションを動かします。
業務ルールを driver.ts の中で判断したり、アプリケーションを通さずに答えを作ったりしないでください (テストは通りますが、アプリケーションを確かめたことになりません)。

結果の種類 (\`outcome\`):

| 値 | 意味 |
| --- | --- |
| \`done\` | ふだんの結果 |
| \`wrongState\` | 前提の状態が違うので、行えない (状態は変えない) |
| \`alternate\` | 条件のときの別の結果。\`condition\` に、条件の名前を入れる |
| \`error\` | 条件のときの結果がエラー。\`condition\` と、\`error\` (種類と、サーバーエラーなら HTTP ステータス) を入れる |

\`states\` には、操作のあとの状態を、状態グループの名前ごとに入れます (アプリケーションに保存されているものを読むこと。操作の戻り値をそのまま返さない)。

## 動かし方

\`\`\`sh
node --test acceptance/run.test.ts
\`\`\`

「設計で決まっていないことが無い」が落ちるときは、\`*.cases.json\` の \`pending\` に挙がっていることを、設計で決めてください。
`;

/** 受け入れテストの、ケースのファイルの名前 (システムの id から作る) */
export function acceptanceCasesFileName(systemId: string): string {
  return `${systemId.replace(/[^A-Za-z0-9_-]+/g, "_")}.cases.json`;
}

/** 書き出すファイル: システムごとのケース (操作が 1 つも無いシステムは除く) と、テストの本体と、説明 */
export function exportAcceptanceTests(model: UntieModel): { files: { name: string; text: string }[]; cases: number; pending: number } {
  const suites = model.elements
    .filter((e) => e.kind === "system")
    .map((s) => deriveAcceptanceCases(model, s.id))
    .filter((s) => s.cases.length + s.pending.length > 0);
  if (suites.length === 0) return { files: [], cases: 0, pending: 0 };
  return {
    files: [
      ...suites.map((s) => ({ name: acceptanceCasesFileName(s.systemId), text: `${JSON.stringify({ format: 1, ...s }, null, 2)}\n` })),
      { name: ACCEPTANCE_RUNNER_FILE, text: RUNNER },
      { name: ACCEPTANCE_README_FILE, text: README },
    ],
    cases: suites.reduce((n, s) => n + s.cases.length, 0),
    pending: suites.reduce((n, s) => n + s.pending.length, 0),
  };
}
