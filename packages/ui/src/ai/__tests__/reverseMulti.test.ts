// ソースコードから作成 (ソースが複数のフォルダ): バックエンド・管理画面・フロント画面の 3 つのソースを、ラベル付きで渡す。
// AI の会話は偽物にして、ソースをまたいだ調査 → 分析モデル → データ → 画面 UI の流れを、台本どおりに確かめる。
import { describe, expect, it, vi } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { traceToActors } from "@untie/core/model/trace";
import type { UntieModel } from "@untie/core/model/types";
import { validateModel } from "@untie/core/model/validate";
import type { ChatEvents, ChatOptions } from "../chat";
import type { DatabaseDraft } from "../designDraft";
import { combineSourceTrees, memorySourceTree } from "../sourceTree";
import type { ModelSpec } from "../spec";
import type { ToolOutcome } from "../tools";
import {
  MULTI_ADMIN,
  MULTI_API,
  MULTI_DATABASE,
  MULTI_FOLDERS,
  MULTI_LABELS,
  MULTI_SCREENS,
  MULTI_SECRETS,
  MULTI_SHOP,
  MULTI_SITEMAPS,
  MULTI_SPEC,
  multiFixtureSources,
} from "./fixtures/reverseMultiSource";

type Kind = "survey" | "model" | "data" | "screen";
interface Call {
  kind: Kind;
  text: string;
  runTool: ChatOptions["runTool"];
  events?: ChatEvents;
  system: string;
}
type Script = (c: Call) => Promise<string> | string;

const fake = vi.hoisted(() => ({
  maxSteps: 0,
  scripts: {} as Partial<Record<string, (c: unknown) => Promise<string> | string>>,
  calls: [] as { kind: string; text: string; system: string }[],
}));

vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as { MAX_STEPS: number; ChatError: new (m: string) => Error };
  return {
    ...actual,
    createChatSession: (_provider: string, o: ChatOptions) => {
      fake.maxSteps = actual.MAX_STEPS;
      const names = o.tools.map((t) => t.name);
      const kind = names.includes("submit_model") ? "model" : names.includes("submit_database") ? "data" : names.includes("submit_screen") ? "screen" : "survey";
      return {
        seed: () => {},
        send: async (text: string, events?: ChatEvents) => {
          let steps = 0;
          const runTool: ChatOptions["runTool"] = async (name, input) => {
            steps++;
            const outcome = await o.runTool(name, input);
            events?.onTool?.(name, outcome);
            return outcome;
          };
          fake.calls.push({ kind, text, system: o.system });
          const reply = (await fake.scripts[kind]!({ kind, text, runTool, events, system: o.system })) as string;
          if (steps >= actual.MAX_STEPS) throw new actual.ChatError("道具を使う回数が上限に達しました。");
          return reply;
        },
      };
    },
  };
});

const { reverseEngineer, REVERSE_LIMITS, conversationSteps, sourceBudget, sourceLimits, sourcePathsIn } = await import("../reverse");
const { reverseSurveyRequest, reverseSystemPrompt, reverseDataRequest } = await import("../reversePrompts");
const { MAX_STEPS } = await import("../chat");

const parse = (r: ToolOutcome) => JSON.parse(r.content) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const screenNameOf = (text: string) => /画面「(.+?)」の画面 UI を作ってください/.exec(text)?.[1] ?? "";
const systemNameOf = (text: string) => /システム「(.+?)」のデータを作ります/.exec(text)?.[1] ?? "";

const results: Record<string, ToolOutcome[]> = {};
const keep = (k: string, r: ToolOutcome) => {
  (results[k] ??= []).push(r);
  return r;
};

const surveyScript: Script = async (c) => {
  keep("list", await c.runTool("list_files", {}));
  keep("readBack", await c.runTool("read_file", { path: "バックエンド/src/routes/orders.ts" }));
  keep("readFront", await c.runTool("read_file", { path: "フロント画面/src/pages/OrderNew.tsx" }));
  keep("search", await c.runTool("search_code", { pattern: "/api/orders" }));
  keep("searchAdmin", await c.runTool("search_code", { pattern: "approve", glob: "管理画面/**" }));
  keep("env", await c.runTool("read_file", { path: "バックエンド/.env" }));
  keep("envFront", await c.runTool("read_file", { path: "フロント画面/.env" }));
  keep("build", await c.runTool("read_file", { path: "管理画面/build/index.html" }));
  keep("outside", await c.runTool("read_file", { path: "フロント画面/../バックエンド/README.md" }));
  keep("secretSearch", await c.runTool("search_code", { pattern: "NOT-A-REAL-KEY" }));
  const text = "## 調査結果\n- ネット注文 (フロント画面/src/pages/OrderNew.tsx → /api/orders → バックエンド/src/routes/orders.ts)";
  c.events?.onText?.(text);
  return text;
};
const modelScript: Script = async (c) => {
  const r = await c.runTool("submit_model", MULTI_SPEC);
  return r.ok ? "提出しました" : "直します";
};
const dataScript: Script = async (c) => {
  const system = systemNameOf(c.text);
  if (system === MULTI_API) {
    await c.runTool("read_file", { path: "バックエンド/prisma/schema.prisma" });
    await c.runTool("submit_database", MULTI_DATABASE);
  } else if (MULTI_SITEMAPS[system]) {
    // 画面だけのシステム: スキーマ定義は自分のソースに無いので、すでにあるデータベース (バックエンドのシステムが写したもの) を使うと答える
    await c.runTool("use_database", { system, database: MULTI_DATABASE.database_name, tables: [] });
    await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]);
  }
  return "提出しました";
};
const screenScript: Script = async (c) => {
  const draft = MULTI_SCREENS.find((d) => d.screen === screenNameOf(c.text));
  if (draft) await c.runTool("submit_screen", draft);
  return "提出しました";
};

function useScripts(over: Partial<Record<Kind, Script>> = {}) {
  fake.calls.length = 0;
  for (const k of Object.keys(results)) delete results[k];
  fake.scripts = { survey: surveyScript, model: modelScript, data: dataScript, screen: screenScript, ...over } as typeof fake.scripts;
}

const baseOptions = { provider: "claude" as const, model: "claude-opus-5-5", apiKey: "k" };
const run = (over: Partial<Parameters<typeof reverseEngineer>[2]> = {}) => reverseEngineer(multiFixtureSources(), "お客様の注文から、スタッフの承認まで", { ...baseOptions, ...over });
const callsOf = (kind: Kind) => fake.calls.filter((c) => c.kind === kind);

describe("reverseEngineer: 複数のソース", () => {
  it("調査の依頼に、ソースの一覧 (ラベル・フォルダ名・読めるファイル数) とソースをまたいだ調べ方が入る", async () => {
    useScripts();
    await run();
    const survey = callsOf("survey")[0]!.text;
    expect(survey).toMatch(/3 か所のソースコード/);
    for (const label of MULTI_LABELS) {
      const tree = multiFixtureSources().find((s) => s.label === label)!.tree;
      const files = tree.files.filter((f) => !/(^|\/)(\.env|build\/)/.test(f.path)).length;
      expect(survey).toContain(`- ${label} / フォルダ名 ${MULTI_FOLDERS[label]} / 読めるファイル ${files} 件`);
    }
    expect(survey).toMatch(/ラベルは利用者が付けた呼び名/);
    expect(survey).toMatch(/決めつけず/);
    expect(survey).toMatch(/fetch・axios・生成されたクライアント・GraphQL のクエリ/);
    expect(survey).toMatch(/ルート・ハンドラーの定義と突き合わせる/);
    expect(survey).toMatch(/同じ業務の別の担当/);
    expect(survey).toMatch(/システムの分け方/);
    // 指示にも、ラベル付きのパスの決まりが入る (全会話で同じ)
    for (const c of fake.calls) expect(c.system).toMatch(/先頭がソースのラベル/);
    expect(new Set(fake.calls.map((c) => c.system)).size).toBe(1);
  });

  it("ソースをまたいだ一覧・読み取り・検索ができ、秘密は結果に出ない", async () => {
    useScripts();
    await run();
    const list = parse(results.list![0]!);
    expect(list.entries.map((e: { path: string }) => e.path)).toEqual(["バックエンド/", "フロント画面/", "管理画面/"].sort());
    expect(list.sources.map((s: { label: string }) => s.label)).toEqual([...MULTI_LABELS]);
    expect(parse(results.readBack![0]!).content).toMatch(/orders\.post\("\/api\/orders"/);
    expect(parse(results.readFront![0]!).content).toMatch(/fetch\("\/api\/orders"/);
    // /api/orders は、フロントの呼び出しとバックエンドのルートの両方で見つかる
    const hits = parse(results.search![0]!).matches.map((m: { path: string }) => m.path);
    expect(hits).toContain("フロント画面/src/pages/OrderNew.tsx");
    expect(hits).toContain("バックエンド/src/routes/orders.ts");
    // glob にラベルを付けて、1 つのソースに絞れる
    expect(parse(results.searchAdmin![0]!).matches.every((m: { path: string }) => m.path.startsWith("管理画面/"))).toBe(true);
    // .env・各ソースの根の直下の build・ソースの外・秘密の値は、道具の結果に出ない
    for (const k of ["env", "envFront", "build", "outside"]) expect(results[k]![0]!.ok, k).toBe(false);
    const everything = Object.values(results).flat().map((r) => r.content).join("\n");
    for (const secret of Object.values(MULTI_SECRETS)) expect(everything).not.toContain(secret);
    expect(parse(results.secretSearch![0]!).matches).toEqual([]);
    expect(everything).not.toContain("build の成果物");
  });

  it("最終モデルは validateModel・traceToActors・checkDesign を通り、システムごとの設計が入る", async () => {
    useScripts();
    const steps: string[] = [];
    const r = await run({ onStep: (s) => steps.push(s) });
    expect(steps).toEqual(["survey", "model", "data", "screens", "done"]);
    const m = r.build.model;
    expect(validateModel(JSON.parse(JSON.stringify(m))).ok).toBe(true);
    expect(traceToActors(m).problems.filter((p) => p.isBreak)).toEqual([]);
    expect(m.domain.commands).toEqual([]);
    const sysId = (name: string) => m.elements.find((e) => e.kind === "system" && e.name === name)!.id;
    for (const name of [MULTI_SHOP, MULTI_ADMIN]) {
      const checked = checkDesign(m, sysId(name));
      expect(checked.problems, name).toEqual([]);
      expect(checked.warnings, name).toEqual([]);
      expect(m.designs.find((d) => d.systemId === sysId(name))!.screens.filter((s) => s.view !== undefined)).toHaveLength(2);
    }
    expect(r.warnings).toEqual([]);
    expect(r.summary).toMatch(/3 か所 \(バックエンド \(aozora-api\)、管理画面 \(aozora-admin\)、フロント画面 \(aozora-shop\)\)/);
    expect(r.seed[0]!.text).toMatch(/バックエンド: aozora-api/);
    // 担当の違う業務がつながっている: 主担当はスタッフ 1 人、お客様は作業の担当
    const business = m.elements.find((e) => e.kind === "business")!;
    expect(business.name).toBe("ネット注文の受付");
  });

  it("データベースはバックエンドのシステムに 1 つ。画面だけのシステムは、そのテーブルの列に画面の項目を結べる", async () => {
    useScripts();
    const r = await run();
    const m = r.build.model;
    const sysId = (name: string) => m.elements.find((e) => e.kind === "system" && e.name === name)!.id;
    const own = m.databases.filter((d) => d.dsl.includes("model Order"));
    expect(own).toHaveLength(1);
    const dbId = own[0]!.id;
    // 画面だけのシステムは、自分のデータベースを作らず、バックエンドのデータベースを使う (空の既定のデータベースではない)
    for (const name of [MULTI_SHOP, MULTI_ADMIN, MULTI_API]) {
      const design = m.designs.find((d) => d.systemId === sysId(name))!;
      expect(effectiveDatabaseIds(m, design), name).toEqual([dbId]);
    }
    for (const name of [MULTI_SHOP, MULTI_ADMIN]) {
      const design = m.designs.find((d) => d.systemId === sysId(name))!;
      const bindings = design.screens.flatMap((s) => s.bindings ?? []);
      expect(bindings.length).toBeGreaterThan(0);
      expect(bindings.every((b) => b.databaseId === dbId)).toBe(true);
    }
    const front = m.designs.find((d) => d.systemId === sysId(MULTI_SHOP))!;
    expect([...new Set(front.screens.flatMap((s) => s.bindings ?? []).map((b) => `${b.table}.${b.column}`))].sort()).toEqual(["Order.customer", "Order.status", "OrderItem.quantity"]);
    // データの会話は、データを持たないシステムにも開く。画面を持たないシステムが先。あとのシステムの依頼に、すでにあるデータベースと使い方が入る
    const dataCalls = callsOf("data").map((c) => c.text);
    expect(dataCalls).toHaveLength(3);
    expect(dataCalls.map(systemNameOf)).toEqual([MULTI_API, MULTI_SHOP, MULTI_ADMIN]);
    // 画面を持たないバックエンドの依頼は、このシステム自身のスキーマ定義だけを写す (「ここで写したものはほかも使う」は画面を持つシステムの依頼にだけ入る)
    expect(dataCalls[0]).toMatch(/このシステム自身のスキーマ定義/);
    expect(dataCalls[0]).not.toMatch(/まだ誰もデータベースを写していません/);
    expect(dataCalls[0]).not.toMatch(/ここで写したデータベースは/);
    const shop = dataCalls.find((t) => systemNameOf(t) === MULTI_SHOP)!;
    expect(shop).toMatch(/<すでにあるデータベース/);
    expect(shop).toMatch(/"name": "注文DB"/);
    expect(shop).toMatch(/use_database/);
    expect(shop).toMatch(/テーブルが重なるものを submit_database で出すと、同じかどうかを確かめられる/);
  });

  it("画面 UI の依頼に、その画面のソースのパス (ラベル付き) が手がかりとして渡る", async () => {
    useScripts();
    await run();
    const screens = callsOf("screen");
    expect(screens).toHaveLength(4);
    const detail = screens.find((c) => screenNameOf(c.text) === "注文入力")!.text;
    expect(detail).toMatch(/この画面のソースの手がかり: フロント画面\/src\/pages\/OrderNew\.tsx/);
    expect(detail).toMatch(/ラベル: 「バックエンド」「管理画面」「フロント画面」/);
    expect(screens.find((c) => screenNameOf(c.text) === "注文承認")!.text).toMatch(/管理画面\/src\/pages\/ApproveOrder\.tsx/);
  });

  it("onSourceTool の通知には、ラベル付きのパスがそのまま出る", async () => {
    useScripts();
    const tools: [string, string][] = [];
    await run({ onSourceTool: (n, d) => tools.push([n, d]) });
    expect(tools).toContainEqual(["読む", "バックエンド/src/routes/orders.ts"]);
    expect(tools).toContainEqual(["探す", "/api/orders"]);
  });

  it("ソースが 1 つなら (ラベル付きでも) 今までの木。ラベルのフォルダは挟まず、調査の依頼にラベルだけが入る", async () => {
    useScripts({
      survey: async (c) => {
        keep("list", await c.runTool("list_files", {}));
        keep("read", await c.runTool("read_file", { path: "src/routes/orders.ts" }));
        return "調査結果";
      },
    });
    const [back] = multiFixtureSources();
    await reverseEngineer([{ label: "バックエンド", tree: back!.tree }], "注文", { ...baseOptions });
    expect(parse(results.list![0]!).entries.map((e: { path: string }) => e.path)).toContain("src/");
    expect(parse(results.list![0]!).sources).toBeUndefined();
    expect(results.read![0]!.ok).toBe(true);
    const text = callsOf("survey")[0]!.text;
    expect(text).toMatch(/ラベル「バックエンド」/);
    expect(text).not.toMatch(/か所のソースコード/);
    expect(callsOf("survey")[0]!.system).not.toMatch(/先頭がソースのラベル/);
  });

  it("使えないラベル・重なるラベルは、読み始める前に断る", async () => {
    useScripts();
    const [a, b] = multiFixtureSources();
    await expect(reverseEngineer([{ label: "a/b", tree: a!.tree }, { label: "b", tree: b!.tree }], "x", baseOptions)).rejects.toThrow(/1 番目のソース/);
    await expect(reverseEngineer([{ label: "API", tree: a!.tree }, { label: "ａｐｉ", tree: b!.tree }], "x", baseOptions)).rejects.toThrow(/重なっています/);
    expect(fake.calls).toEqual([]);
  });
});

describe("複数のソースの上限", () => {
  it("ソースが 1 つなら今までの上限のまま。複数なら増えるが、どの会話も MAX_STEPS より小さい", () => {
    const L = REVERSE_LIMITS;
    expect(sourceLimits(1).survey).toEqual({ calls: L.sourceCallsSurvey, chars: L.sourceCharsSurvey });
    expect(sourceLimits(1).screen).toEqual({ calls: L.sourceCallsScreen, chars: L.sourceCharsScreen });
    expect(sourceBudget(2, 5)).toEqual(sourceBudget(2, 5, 1));
    for (let n = 2; n <= 8; n++) {
      const l = sourceLimits(n);
      expect(l.survey.calls, `調査 ${n}`).toBeGreaterThanOrEqual(sourceLimits(n - 1).survey.calls);
      expect(l.survey.calls).toBeGreaterThan(L.sourceCallsSurvey - 1);
      for (const [name, steps] of Object.entries(conversationSteps(n))) expect(steps, `${name} ${n}`).toBeLessThan(MAX_STEPS);
      expect(sourceBudget(1, 1, n).calls).toBe(l.survey.calls + l.model.calls + l.data.calls + l.screen.calls);
    }
    expect(sourceLimits(3).survey.calls).toBeGreaterThan(sourceLimits(1).survey.calls);
    expect(sourceLimits(8).survey.calls).toBe(sourceLimits(20).survey.calls); // 上限で止まる
  });

  it("3 つのソースで、調査が上限いっぱいまで読んでも、そのあとの返答の往復が残る", async () => {
    const n = 3;
    useScripts({
      survey: async (c) => {
        for (let i = 0; i < sourceLimits(n).survey.calls; i++) keep("many", await c.runTool("read_file", { path: "バックエンド/README.md" }));
        c.events?.onText?.("## 調査結果\n- 上限まで読んだ");
        return "## 調査結果\n- 上限まで読んだ";
      },
    });
    const r = await run();
    expect(results.many!.every((x) => x.ok)).toBe(true);
    expect(r.survey).toMatch(/上限まで読んだ/);
    // 上限を超えたぶんは断られる
    useScripts({
      survey: async (c) => {
        for (let i = 0; i < sourceLimits(n).survey.calls + 1; i++) keep("over", await c.runTool("read_file", { path: "バックエンド/README.md" }));
        return "調査結果";
      },
    });
    await run();
    expect(results.over![results.over!.length - 1]!.ok).toBe(false);
    expect(results.over![results.over!.length - 1]!.content).toMatch(/回数の上限/);
  });
});

describe("プロンプトと手がかり", () => {
  it("ソースが 1 つでラベルなしの依頼・指示は、複数用の文を含まない", () => {
    const single = reverseSurveyRequest("注文", "app", 3);
    expect(single).not.toMatch(/ソースが複数/);
    expect(reverseSystemPrompt()).not.toMatch(/先頭がソースのラベル/);
    expect(reverseSystemPrompt(true)).toMatch(/利用者から見て別のものとして使われているか/);
  });

  it("データの依頼 (複数): 画面を持つシステムは、スキーマ定義のあるソースから写し、ここで写したものはほかも使う。画面を持たないシステムの依頼は、このシステム自身のスキーマだけ", () => {
    const withScreen = { elements: [{ id: "s", kind: "system", name: "サーバー" }, { id: "p", kind: "screen", name: "画面", systemId: "s" }], relations: [] } as never;
    const first = reverseDataRequest(withScreen, "s", true);
    expect(first).toMatch(/スキーマ定義のあるソースから写す/);
    expect(first).toMatch(/ここで写したデータベースは、ほかのシステムも使います/);
    expect(first).not.toMatch(/画面だけで/);
    expect(reverseDataRequest(withScreen, "s", false)).not.toMatch(/ソースが複数/);
    // システムが 1 つだけの単一ソースは、共有に触れない (今までどおり)
    expect(reverseDataRequest(withScreen, "s", false)).not.toMatch(/ほかのシステムも使います/);
    expect(reverseDataRequest(withScreen, "s", false)).toMatch(/スキーマ定義が見つからないときは、コードのデータの使い方/);
    const screenless = { elements: [{ id: "s", kind: "system", name: "サーバー" }], relations: [] } as never;
    const back = reverseDataRequest(screenless, "s", true);
    expect(back).toMatch(/このシステム自身のスキーマ定義/);
    expect(back).toMatch(/ほかのシステムのデータは写さない/);
    expect(back).not.toMatch(/画面のソースではなく/);
    expect(back).not.toMatch(/ここで写したデータベースは/);
  });

  it("データの依頼: すでにデータベースがあるときは、ソースが 1 つでも use_database を案内し、推測で別のテーブルを作らせない。社外のシステムはスキーマを写さない", () => {
    const base = {
      elements: [
        { id: "s", kind: "system", name: "ショップ" },
        { id: "p", kind: "screen", name: "画面", systemId: "s" },
        { id: "x", kind: "system", name: "決済サービス" },
      ],
      relations: [],
      databases: [{ id: "d1", name: "注文DB", dsl: "model Order {\n  id String @id\n}\n", tables: [] }],
    } as never;
    for (const multi of [false, true]) {
      const shop = reverseDataRequest(base, "s", multi, ["d1"], true);
      expect(shop, `multi=${multi}`).toMatch(/<すでにあるデータベース/);
      expect(shop).toMatch(/use_database で、そのデータベースを名前で指して使うと答える/);
      expect(shop).toMatch(/自分のソースにスキーマ定義が無ければ、use_database を使う。推測で別のテーブルを作らない/);
      expect(shop).not.toMatch(/スキーマ定義が見つからないときは、コードのデータの使い方/);
      expect(shop).not.toMatch(/ここで写したデータベースは/);
      const pay = reverseDataRequest(base, "x", multi, ["d1"], true);
      expect(pay).toMatch(/このシステム自身のスキーマ定義/);
      expect(pay).toMatch(/「ありません」と答える/);
      expect(pay).not.toMatch(/ここで写したデータベースは/);
      expect(pay).not.toMatch(/画面のソースではなく/);
    }
    expect(reverseDataRequest(base, "s", false, ["d1"], true)).not.toMatch(/ソースが複数/);
  });

  it("sourcePathsIn は、ラベルがほかのラベルの末尾と重なるとき (「画面」と「フロント画面」) も、ほかのパスの途中に当たらない", () => {
    const tree = combineSourceTrees([
      { label: "画面", tree: memorySourceTree("a", { "src/Top.tsx": "a", "src/Only.tsx": "x" }) },
      { label: "フロント画面", tree: memorySourceTree("b", { "src/Top.tsx": "b", "src/Cart.tsx": "c" }) },
    ]);
    // フロント画面/src/Top.tsx の途中の「画面/src/Top.tsx」は、画面ラベルのパスとして拾わない
    expect(sourcePathsIn("カート (フロント画面/src/Top.tsx)", tree)).toEqual(["フロント画面/src/Top.tsx"]);
    expect(sourcePathsIn("一覧は 画面/src/Top.tsx と フロント画面/src/Cart.tsx", tree)).toEqual(["画面/src/Top.tsx", "フロント画面/src/Cart.tsx"]);
    // パスの先頭・区切りの直後は拾える。ラベルでないフォルダの途中 (x/画面/…) は拾わない
    expect(sourcePathsIn("(画面/src/Only.tsx)、`画面/src/Top.tsx`", tree)).toEqual(["画面/src/Only.tsx", "画面/src/Top.tsx"]);
    expect(sourcePathsIn("共通/画面/src/Only.tsx", tree)).toEqual([]);
  });

  it("sourcePathsIn は、「・」「→」などの区切りの前後でもパスを拾う", () => {
    const tree = combineSourceTrees([
      { label: "画面", tree: memorySourceTree("a", { "src/A.tsx": "a", "src/B.tsx": "b", "src/x.ts": "x" }) },
      { label: "フロント画面", tree: memorySourceTree("b", { "src/Cart.tsx": "c" }) },
    ]);
    expect(sourcePathsIn("・画面/src/x.ts", tree)).toEqual(["画面/src/x.ts"]);
    expect(sourcePathsIn("一覧→画面/src/x.ts", tree)).toEqual(["画面/src/x.ts"]);
    expect(sourcePathsIn("画面/src/A.tsx・画面/src/B.tsx", tree)).toEqual(["画面/src/A.tsx", "画面/src/B.tsx"]);
    expect(sourcePathsIn("画面/src/A.tsx・B.tsx、「画面/src/x.ts」。（画面/src/B.tsx）,画面/src/A.tsx", tree)).toEqual(["画面/src/A.tsx", "画面/src/x.ts", "画面/src/B.tsx"]);
    // ほかのラベルの末尾に重なるものは、区切りがあっても拾わない
    expect(sourcePathsIn("・フロント画面/src/Cart.tsx", tree)).toEqual(["フロント画面/src/Cart.tsx"]);
  });

  it("データの依頼: システムが 1 つ (othersShare が偽) なら、ソースが複数でも共有・ほかのシステムの文を入れない。画面を持たない依頼は複数ソース前の文", () => {
    const screenless = { elements: [{ id: "s", kind: "system", name: "サーバー" }], relations: [] } as never;
    const one = reverseDataRequest(screenless, "s", true, [], false);
    expect(one).toMatch(/このシステムのスキーマ定義がソースに無ければ/);
    expect(one).not.toMatch(/このシステム自身のスキーマ定義|ほかのシステムのスキーマ/);
    const two = reverseDataRequest(screenless, "s", true, [], true);
    expect(two).toMatch(/バックエンドなどほかのシステムのスキーマを、このシステムのものとして写さない/);
    const withScreen = { elements: [{ id: "s", kind: "system", name: "サーバー" }, { id: "p", kind: "screen", name: "画面", systemId: "s" }], relations: [] } as never;
    expect(reverseDataRequest(withScreen, "s", true, [], false)).not.toMatch(/ほかのシステムも使います/);
  });

  it("sourcePathsIn は、説明にあるラベル付きのパスのうち、木にあるものだけを取り出す", () => {
    const tree = combineSourceTrees(multiFixtureSources());
    const text = "お客様が注文を送る (フロント画面/src/pages/OrderNew.tsx:12)。参考: バックエンド/src/routes/orders.ts、フロント画面/src/pages/Nothing.tsx、フロント画面/.env";
    expect(sourcePathsIn(text, tree)).toEqual(["フロント画面/src/pages/OrderNew.tsx", "バックエンド/src/routes/orders.ts"]);
    expect(sourcePathsIn(text, memorySourceTree("x", { "a.ts": "" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 共有されたデータベース

/** バックエンドがジョブも webhook も持たない純粋な API サーバー: システムにならず (画面を通る操作の対象は画面)、画面のシステムが 2 つだけ残る */
const NO_JOB_SPEC: ModelSpec = { ...MULTI_SPEC, systems: MULTI_SPEC.systems!.filter((s) => s.name !== MULTI_API), events: [] };

/** NO_JOB_SPEC に、管理画面だけが読む情報「注文明細」を足す (実際の API で起きた構成) */
function detailSpec(): ModelSpec {
  const spec = structuredClone(NO_JOB_SPEC);
  spec.informations!.push({ name: "注文明細", description: "注文の 1 行 (商品と数量)" });
  const list = spec.businesses![0]!.activities!.flatMap((a) => a.usecases ?? []).find((u) => u.name === "承認待ちの注文を探す")!;
  list.reads = ["注文", "注文明細"];
  return spec;
}

const specScript = (spec: ModelSpec): Script => async (c) => {
  const r = await c.runTool("submit_model", spec);
  return r.ok ? "提出しました" : "直します";
};
const modelOf = async (over: Partial<Record<Kind, Script>>, spec: ModelSpec = NO_JOB_SPEC) => {
  useScripts({ model: specScript(spec), ...over });
  return run();
};
const sysIdOf = (m: UntieModel, name: string) => m.elements.find((e) => e.kind === "system" && e.name === name)!.id;
const realDbs = (m: UntieModel) => m.databases.filter((d) => d.dsl.includes("model Order"));

describe("共有されたデータベース", () => {
  it("(a) ジョブの無いバックエンド + 画面のシステム 2 つ: データベースが 1 つできて、両方の画面の項目が結べ、設計の検証のエラーが無い", async () => {
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        // 最初のシステム (ネットショップ) が、バックエンドのソースのスキーマ定義を写す。もう片方は、それを使う
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else await c.runTool("use_database", { system, database: "注文DB", tables: [] });
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
        return "提出しました";
      },
    });
    const m = r.build.model;
    expect(m.elements.filter((e) => e.kind === "system").map((e) => e.name)).toEqual([MULTI_SHOP, MULTI_ADMIN]);
    expect(callsOf("data").map((c) => systemNameOf(c.text))).toEqual([MULTI_SHOP, MULTI_ADMIN]);
    const dbs = realDbs(m);
    expect(dbs).toHaveLength(1);
    expect(dbs[0]!.name).toBe("注文DB"); // システム名ではなく、データの中身の名前
    for (const name of [MULTI_SHOP, MULTI_ADMIN]) {
      const design = m.designs.find((d) => d.systemId === sysIdOf(m, name))!;
      expect(effectiveDatabaseIds(m, design), name).toEqual([dbs[0]!.id]);
      const bindings = design.screens.flatMap((s) => s.bindings ?? []);
      expect(bindings.length, name).toBeGreaterThan(0);
      expect(bindings.every((b) => b.databaseId === dbs[0]!.id)).toBe(true);
      expect(design.screens.filter((s) => s.view !== undefined), name).toHaveLength(2);
      expect(checkDesign(m, sysIdOf(m, name)).problems, name).toEqual([]);
    }
    expect(r.warnings).toEqual([]);
    expect(r.summary).toMatch(/データベース 2\/2 システム/);
    // 2 つ目の依頼には、すでにあるデータベースが入り、1 つ目には入らない
    expect(callsOf("data")[0]!.text).not.toMatch(/<すでにあるデータベース/);
    expect(callsOf("data")[1]!.text).toMatch(/<すでにあるデータベース/);
  });

  it("(b) 実際の API で起きた構成: 片方が写し、もう片方が同じデータベースを使って、足りない対応 (注文明細 → OrderItem) を足す", async () => {
    const results2: ToolOutcome[] = [];
    const shopDraft: DatabaseDraft = {
      ...MULTI_DATABASE,
      system: MULTI_SHOP,
      database_name: "店舗管理データベース",
      tables: [{ table: "Order", informations: ["注文"] }, { table: "Product", informations: ["商品"] }],
    };
    const r = await modelOf(
      {
        data: async (c) => {
          const system = systemNameOf(c.text);
          if (system === MULTI_SHOP) results2.push(await c.runTool("submit_database", shopDraft));
          else {
            // 1 回目は対応を足さずに答える → 未対応の情報と候補のテーブルが返る。2 回目で足す
            results2.push(await c.runTool("use_database", { system, database: "店舗管理データベース", tables: [] }));
            results2.push(await c.runTool("use_database", { system, database: "店舗管理データベース", tables: [{ table: "OrderItem", informations: ["注文明細"] }] }));
          }
          await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
          return "提出しました";
        },
      },
      detailSpec(),
    );
    const m = r.build.model;
    const admin = sysIdOf(m, MULTI_ADMIN);
    // 写したシステム自身は、未対応の情報が無いので、出し直しは求められない
    expect(parse(results2[0]!).result).not.toMatch(/出し直して/);
    // 管理画面の依頼に、すでにあるデータベースのテーブルと、いまの対応 (OrderItem はどの情報にも結ばれていない) が入る
    const adminRequest = callsOf("data").find((c) => systemNameOf(c.text) === MULTI_ADMIN)!.text;
    expect(adminRequest).toMatch(/"name": "店舗管理データベース"/);
    expect(adminRequest).toMatch(/"table": "OrderItem",\s+"columns": \[[^\]]*\],\s+"informations": \[\]/);
    // 1 回目の答え: 未対応の情報「注文明細」と、候補のテーブル OrderItem を添えて、出し直しを求める
    const first = parse(results2[1]!);
    expect(results2[1]!.ok).toBe(true);
    expect(first.result).toMatch(/どのテーブルにも結ばれていない情報: 注文明細/);
    expect(first.result).toMatch(/どの情報にも結ばれていないもの: OrderItem/);
    expect(first.result).toMatch(/use_database を出し直してください \(あと 2 回まで/);
    // 2 回目で足りて、出し直しは求められない
    expect(parse(results2[2]!).result).not.toMatch(/出し直してください/);
    const db = realDbs(m)[0]!;
    expect(db.name).toBe("店舗管理データベース");
    expect(db.tables.find((t) => t.table === "OrderItem")!.informationIds.map((id) => m.elements.find((e) => e.id === id)!.name)).toEqual(["注文明細"]);
    expect(db.tables.find((t) => t.table === "Order")!.informationIds).toHaveLength(1); // すでにある対応は消えない
    expect(m.designs.find((d) => d.systemId === admin)!.databaseIds).toEqual([db.id]);
    expect(checkDesign(m, admin).problems).toEqual([]);
    expect(checkDesign(m, sysIdOf(m, MULTI_SHOP)).problems).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("(b2) 出し直しの回数の中でも対応を足さなければ、未対応の情報は設計の検証の警告に残る (黙って通さない)", async () => {
    const r = await modelOf(
      {
        data: async (c) => {
          const system = systemNameOf(c.text);
          if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system, tables: [{ table: "Order", informations: ["注文"] }, { table: "Product", informations: ["商品"] }] });
          else for (let i = 0; i < 4; i++) keep("useOver", await c.runTool("use_database", { system, database: "注文DB", tables: [] }));
          await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
          return "提出しました";
        },
      },
      detailSpec(),
    );
    // 回数 (1 + dataRetries) を超えたら受け付けず、そのまま進む
    expect(results.useOver!.map((x) => parse(x).result).pop()).toMatch(/これ以上は出し直せません/);
    expect(r.warnings.some((w) => /情報「注文明細」がどのテーブルにも対応していません/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /設計の検証: エラー 1 件/.test(w))).toBe(true);
  });

  it("(b3) データベースを写したシステム自身の出し直しの案内は、DSL にあるのに結ばれていないテーブルと、未対応の情報を並べ、ソースに無い情報だけ直さなくてよいと言い分ける", async () => {
    const spec = structuredClone(NO_JOB_SPEC);
    spec.informations!.push({ name: "注文明細", description: "注文の 1 行" });
    spec.businesses![0]!.activities!.flatMap((a) => a.usecases ?? []).find((u) => u.name === "注文を送る")!.reads = ["商品", "注文明細"];
    await modelOf(
      {
        data: async (c) => {
          const system = systemNameOf(c.text);
          if (system === MULTI_SHOP) {
            keep("own", await c.runTool("submit_database", { ...MULTI_DATABASE, system, tables: [{ table: "Order", informations: ["注文"] }, { table: "Product", informations: ["商品"] }] }));
            keep("own", await c.runTool("submit_database", MULTI_DATABASE));
          } else await c.runTool("use_database", { system, database: "注文DB", tables: [] });
          await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
          return "提出しました";
        },
      },
      spec,
    );
    const note = parse(results.own![0]!).result as string;
    expect(note).toMatch(/DSL にあるテーブルのうち、どの情報にも結ばれていないもの: OrderItem/);
    expect(note).toMatch(/どのテーブルにも結ばれていない情報: 注文明細/);
    expect(note).toMatch(/テーブルが DSL にあるのに対応が無い情報は、tables に足して submit_database を出し直してください/);
    expect(note).toMatch(/対応するテーブルがソースに無い情報だけ、直さなくてかまいません/);
    // 古い言い方 (すべて「ソースに無い」扱い) には戻さない
    expect(note).not.toMatch(/直さなくてかまいません。$/);
  });

  it("(c) 同じスキーマを別の名前で出したら、1 回だけ断って use_database を案内する。そのとおり使えば、データベースは 1 つのまま", async () => {
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else {
          keep("dup", await c.runTool("submit_database", { ...MULTI_DATABASE, system, database_name: "管理画面のデータベース" }));
          keep("dup", await c.runTool("use_database", { system, database: "注文DB", tables: [] }));
        }
        keep("map", await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!));
        return "提出しました";
      },
    });
    const m = r.build.model;
    const [first, used] = results.dup!;
    expect(first!.ok).toBe(false);
    expect(parse(first!).error).toMatch(/「注文DB」と重なっています/);
    expect(parse(first!).error).toMatch(/use_database/);
    expect(parse(first!).error).toMatch(/separate_reason/);
    expect(used!.ok).toBe(true);
    expect(realDbs(m)).toHaveLength(1);
    expect(m.databases.some((d) => d.name === "管理画面のデータベース")).toBe(false);
    expect(m.designs.find((d) => d.systemId === sysIdOf(m, MULTI_ADMIN))!.databaseIds).toEqual([realDbs(m)[0]!.id]);
    expect(checkDesign(m, sysIdOf(m, MULTI_ADMIN)).problems).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("(c2) 重なると断られても、本当に別のデータベースなら separate_reason を添えて出し直せば受け付ける (理由は気づいたことに残る)", async () => {
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else {
          const own = { system, database_name: "承認の記録", dsl: "model Product {\n  id String @id\n  note String\n}\n", tables: [{ table: "Product", informations: ["商品"] }] };
          keep("own", await c.runTool("submit_database", own));
          keep("own", await c.runTool("submit_database", { ...own, separate_reason: "承認の記録専用のテーブルで、名前だけが重なる" }));
        }
        keep("map", await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!));
        return "提出しました";
      },
    });
    const m = r.build.model;
    const [first, second] = results.own!;
    expect(first!.ok).toBe(false); // 既存と同じ名前のテーブル Product だけを持つ → 同じかもしれない
    expect(second!.ok).toBe(true);
    expect(m.databases.map((d) => d.name)).toEqual(expect.arrayContaining(["注文DB", "承認の記録"]));
    expect(m.designs.find((d) => d.systemId === sysIdOf(m, MULTI_ADMIN))!.databaseIds.map((id) => m.databases.find((d) => d.id === id)!.name)).toEqual(["承認の記録"]);
    expect(r.warnings).toContainEqual(expect.stringMatching(/出したデータベースは、すでにあるデータベース「注文DB」とテーブルが重なりますが.*別のデータベースとして受け付けました \(理由: 承認の記録専用/));
    // 受け付けたので、サイトマップの返事は「続けて submit_database か use_database」と食い違わず、データベースを答えなかった警告も出ない
    expect(parse(results.map![1]!).result).not.toMatch(/続けて submit_database/);
    expect(r.warnings.some((w) => /AI がデータベースを(答えなかった|提出しなかった)/.test(w))).toBe(false);
  });

  it("(c3) 断ったあと、理由を添えずに出し直しても、断り切らずに受け付ける (そのことは気づいたことに残る)", async () => {
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else {
          const dup = { ...MULTI_DATABASE, system, database_name: "管理画面のデータベース" };
          keep("dup", await c.runTool("submit_database", dup));
          keep("dup", await c.runTool("submit_database", dup));
        }
        keep("map", await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!));
        return "提出しました";
      },
    });
    const m = r.build.model;
    expect(results.dup!.map((x) => x.ok)).toEqual([false, true]);
    expect(m.databases.filter((d) => d.dsl.includes("model Order")).map((d) => d.name).sort()).toEqual(["注文DB", "管理画面のデータベース"]);
    expect(r.warnings).toContainEqual(expect.stringMatching(/確かめたうえで、別のデータベースとして受け付けました \(理由は添えられていません\)/));
  });

  it("(c4) 重なりの判定: 既存と同じテーブルに 1 つ足しただけ・大文字小文字だけの違いは、別のデータベースとして通さず、1 回確かめる。重ならないものは確かめない", async () => {
    const run1 = async (dsl: string, tables: { table: string; informations: string[] }[]) => {
      useScripts({
        model: specScript(NO_JOB_SPEC),
        data: async (c) => {
          const system = systemNameOf(c.text);
          if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
          else keep("x", await c.runTool("submit_database", { system, database_name: "別名DB", dsl, tables }));
          await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
          return "提出しました";
        },
      });
      for (const k of Object.keys(results)) delete results[k];
      await run();
      return results.x![0]!;
    };
    const base = "model Order {\n  id String @id\n}\nmodel OrderItem {\n  id String @id\n}\nmodel Product {\n  id String @id\n}\n";
    // (b) 既存と同じテーブルに 1 つ足しただけ
    expect((await run1(`${base}model Extra {\n  id String @id\n}\n`, [])).ok).toBe(false);
    // (c) テーブルの名前の大文字小文字が違うだけ
    expect((await run1("model order {\n  id String @id\n}\nmodel ORDERITEM {\n  id String @id\n}\nmodel product {\n  id String @id\n}\n", [])).ok).toBe(false);
    // 重ならない
    expect((await run1("model Stock {\n  id String @id\n}\nmodel Shelf {\n  id String @id\n}\n", [])).ok).toBe(true);
    // 1 つだけ重なり、出したテーブルも既存も過半ではない
    expect((await run1("model Order {\n  id String @id\n}\nmodel Stock {\n  id String @id\n}\nmodel Shelf {\n  id String @id\n}\n", [])).ok).toBe(true);
  });

  it("(c5) 共有のデータベースは、別のスキーマで置き換えない: 同じ名前の提出は断り、本当に別なら別の名前を案内する。2 回断っても変わらなければ、名前を付け替えて受け付ける (データベースの名前は重ならない)", async () => {
    const cart = { database_name: "注文DB", dsl: "model Cart {\n  id String @id\n  total Int\n}\n", tables: [{ table: "Cart", informations: ["注文"] }] };
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else {
          // 管理画面は、すでにある「注文DB」を使うと答えたあと、同じ名前で別のスキーマを出し直す (設計の databaseIds に共有のデータベースが入っている)
          await c.runTool("use_database", { system, database: "注文DB", tables: [] });
          for (let i = 0; i < 3; i++) keep("cart", await c.runTool("submit_database", { system, ...cart }));
        }
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
        return "提出しました";
      },
    });
    const m = r.build.model;
    // 注文DB は元のスキーマのまま
    const orderDb = m.databases.filter((d) => d.name === "注文DB");
    expect(orderDb).toHaveLength(1);
    expect(orderDb[0]!.dsl).toContain("model Order ");
    expect(orderDb[0]!.dsl).not.toContain("Cart");
    expect(new Set(m.databases.map((d) => d.name)).size).toBe(m.databases.length);
    // 最初の 2 回は、置き換えずに断る (別の名前・use_database の案内)
    const [one, two, three] = results.cart!;
    expect(one!.ok).toBe(false);
    expect(parse(one!).error).toMatch(/「注文DB」は、すでにモデルにあります。置き換えません/);
    expect(parse(one!).error).toMatch(/use_database/);
    expect(parse(one!).error).toMatch(/別の名前/);
    expect(two!.ok).toBe(false);
    // 3 回目は名前を付け替えて受け付ける (行き止まりにしない)
    expect(three!.ok).toBe(true);
    const cartDb = m.databases.find((d) => d.dsl.includes("model Cart"))!;
    expect(cartDb.name).not.toBe("注文DB");
    expect(r.warnings).toContainEqual(expect.stringMatching(/データベース「注文DB」はすでにあったので、「.+」の名前で受け付けました/));
    // 注文サーバーの対応も、全システムの画面の対応も落ちていない
    expect(orderDb[0]!.tables.length).toBeGreaterThan(0);
    for (const name of [MULTI_SHOP, MULTI_ADMIN]) expect(checkDesign(m, sysIdOf(m, name)).problems, name).toEqual([]);
  });

  it("use_database は、すでにあるデータベースの名前でないものを断って、名前の一覧を返す", async () => {
    await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else {
          keep("bad", await c.runTool("use_database", { system, database: "存在しないDB", tables: [] }));
          await c.runTool("use_database", { system, database: "注文DB", tables: [{ table: "Nothing", informations: ["注文"] }] });
        }
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
        return "提出しました";
      },
    });
    expect(results.bad![0]!.ok).toBe(false);
    expect(parse(results.bad![0]!).error).toMatch(/「注文DB」/);
  });

  it("(d) AI が何も答えなかったときは、再度頼んだうえで、情報を表すテーブルが最も多いデータベースに結び、結んだことを気づいたことに残す", async () => {
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!); // 管理画面は、データベースについて何も答えない
        return "提出しました";
      },
    });
    const m = r.build.model;
    const admin = sysIdOf(m, MULTI_ADMIN);
    // 管理画面は、答えが無いので 1 度だけ頼み直す (すでにあるデータベースを使うか、写すか)
    expect(callsOf("data").filter((c) => c.text.startsWith("すでにあるデータベースを使うなら"))).toHaveLength(1);
    expect(m.designs.find((d) => d.systemId === admin)!.databaseIds).toEqual([realDbs(m)[0]!.id]);
    expect(r.warnings).toContainEqual(expect.stringMatching(/システム「注文管理画面」: AI がデータベースを答えなかったので.*データベース「注文DB」に結びました/));
    expect(checkDesign(m, admin).problems).toEqual([]);
    expect(r.summary).toMatch(/データベース 2\/2 システム/);
  });

  it("(d2) 結べるデータベースが無いとき (どのシステムも写さない) は、結ばずに警告だけを残す", async () => {
    const r = await modelOf({
      data: async (c) => {
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[systemNameOf(c.text)]!);
        return "提出しました";
      },
    });
    const m = r.build.model;
    for (const name of [MULTI_SHOP, MULTI_ADMIN]) {
      expect(m.designs.find((d) => d.systemId === sysIdOf(m, name))!.databaseIds, name).toEqual([]);
      expect(r.warnings).toContainEqual(expect.stringMatching(new RegExp(`システム「${name}」: AI がデータベースを提出しなかったので、データベースは作りませんでした`)));
    }
  });

  it("(e) データの会話が失敗したシステムも、補いの対象になる (失敗の警告と、結んだ警告の両方)", async () => {
    const { ChatError } = await import("../chat");
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_ADMIN) throw new ChatError("道具を使う回数が上限に達しました。");
        await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
        return "提出しました";
      },
    });
    const m = r.build.model;
    const admin = sysIdOf(m, MULTI_ADMIN);
    expect(r.warnings).toContainEqual(expect.stringMatching(/データ: システム「注文管理画面」: 道具を使う回数が上限/));
    expect(r.warnings).toContainEqual(expect.stringMatching(/システム「注文管理画面」: AI がデータベースを答えなかったので.*「注文DB」に結びました/));
    // 提出が無くても、画面は設計に足され (空の遷移)、使うデータベースも決まる
    const design = m.designs.find((d) => d.systemId === admin)!;
    expect(design.screens.length).toBe(2);
    expect(design.databaseIds).toEqual([realDbs(m)[0]!.id]);
  });

  it("AI が画面だけのシステムにも別のスキーマを出したら、そのシステムは自分のデータベースを使い、別の画面のシステムのデータベースは混ざらない", async () => {
    const ownDsl = "model AdminOrder {\n  id String @id\n  customer String\n}\n";
    const r = await modelOf({
      data: async (c) => {
        const system = systemNameOf(c.text);
        if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
        else await c.runTool("submit_database", { system, database_name: "承認の記録", dsl: ownDsl, tables: [{ table: "AdminOrder", informations: ["注文"] }] });
        await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
        return "提出しました";
      },
    });
    const m = r.build.model;
    const admin = m.designs.find((d) => d.systemId === sysIdOf(m, MULTI_ADMIN))!;
    const shop = m.designs.find((d) => d.systemId === sysIdOf(m, MULTI_SHOP))!;
    expect(admin.databaseIds.map((id) => m.databases.find((d) => d.id === id)!.name)).toEqual(["承認の記録"]);
    expect(shop.databaseIds.map((id) => m.databases.find((d) => d.id === id)!.name)).toEqual(["注文DB"]);
  });

  it("(補い) 結び先は、そのシステムの情報を表すテーブルが最も多いデータベース 1 つだけ (多いほうを選び、ほかは混ぜない)", async () => {
    // 3 つ目のシステムを足し、写したデータベースを 2 つ (情報の対応の数が違う) にして、答えなかったシステムの結び先を確かめる
    const spec = structuredClone(NO_JOB_SPEC);
    spec.systems!.push({ name: "会員サイト", description: "会員が使う画面" });
    spec.screens!.push({ name: "会員の注文履歴", description: "会員が注文を見る", system: "会員サイト", usecase: "会員が注文を見る" });
    spec.businesses![0]!.activities![0]!.usecases!.push({ name: "会員が注文を見る", reads: ["注文", "商品"] });
    const small = "model Stock {\n  id String @id\n}\n";
    const r = await modelOf(
      {
        data: async (c) => {
          const system = systemNameOf(c.text);
          if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
          else if (system === MULTI_ADMIN) await c.runTool("submit_database", { system, database_name: "在庫DB", dsl: small, tables: [{ table: "Stock", informations: ["商品"] }] });
          await c.runTool("submit_sitemap", { system, transitions: [] });
          return "提出しました";
        },
      },
      spec,
    );
    const m = r.build.model;
    const member = m.designs.find((d) => d.systemId === sysIdOf(m, "会員サイト"))!;
    // 会員サイトの情報 (注文・商品) を表すテーブルは、注文DB が 3 つ、在庫DB が 1 つ
    expect(member.databaseIds.map((id) => m.databases.find((d) => d.id === id)!.name)).toEqual(["注文DB"]);
    expect(r.warnings).toContainEqual(expect.stringMatching(/システム「会員サイト」.*「注文DB」に結びました \(テーブル 3 件/));
  });
});

describe("ソースの上限・手がかり (レビューの指摘)", () => {
  it("調査の文字数の上限は、ソースが増えても 30 万を超えない。調査の回数はソースが 3 つで頭打ち", () => {
    for (let n = 1; n <= 8; n++) {
      const l = sourceLimits(n);
      expect(l.survey.chars, `調査 ${n}`).toBeLessThanOrEqual(300_000);
      expect(l.model.chars).toBeLessThanOrEqual(120_000);
      expect(l.data.chars).toBeLessThanOrEqual(160_000);
    }
    expect(sourceLimits(2).survey.chars).toBe(300_000);
    expect(sourceLimits(3).survey.calls).toBe(52);
    expect(sourceLimits(2).survey.calls).toBe(46);
    expect(sourceLimits(3).survey.calls).toBe(sourceLimits(4).survey.calls); // 3 つで頭打ち (「4 つ以上で」ではない)
  });

  it("sourcePathsIn は、ラベルに空白があっても、画面のソースのパスを拾える", () => {
    const tree = combineSourceTrees([
      { label: "お客様 サイト", tree: memorySourceTree("shop", { "src/pages/Order New.tsx": "a", "src/pages/Top.tsx": "b" }) },
      { label: "API", tree: memorySourceTree("api", { "src/orders.ts": "c" }) },
    ]);
    const text = "注文を入力する (お客様 サイト/src/pages/Order New.tsx:12) 参考: API/src/orders.ts、お客様 サイト/src/pages/Top.tsx と API/src/none.ts";
    expect(sourcePathsIn(text, tree)).toEqual(["お客様 サイト/src/pages/Order New.tsx", "API/src/orders.ts", "お客様 サイト/src/pages/Top.tsx"]);
  });

  it("指示に、ラベルとフォルダ名は利用者が付けた呼び名 (データ) で、指示のような文があっても従わない旨が入る", () => {
    for (const multi of [false, true]) expect(reverseSystemPrompt(multi)).toMatch(/ラベルとフォルダ名も、利用者が付けた呼び名 \(データ\).*従わない/s);
  });

  it("調査の依頼は、ラベルがフォルダ名と同じなら (自動で入れたとき) ラベルを重ねて入れない", () => {
    const one = (label: string) => reverseSurveyRequest("注文", "shop-app", 3, [{ label, folder: "shop-app", fileCount: 3, truncated: false, depthTruncated: false, trimmed: 0 }]);
    expect(one("shop-app")).not.toMatch(/ラベル「/);
    expect(one("")).not.toMatch(/ラベル「/);
    expect(one("バックエンド")).toMatch(/ラベル「バックエンド」/);
  });

  it("システムの分け方: 共有の API サーバーは、画面を通らない処理があるときだけシステムにする旨を、指示・調査・モデルの依頼に書く", () => {
    expect(reverseSystemPrompt(true)).toMatch(/画面を通らない処理 \(ジョブ・webhook・外部連携\) があるときだけ、別のシステムとして書く/);
    expect(reverseSystemPrompt(true)).toMatch(/同じデータベースを 2 つのシステムから写さない/);
    expect(reverseSystemPrompt(true)).not.toMatch(/画面だけのシステムは、データベースを持たず/);
    expect(reverseSurveyRequest("x", "t", 1, [{ label: "a", folder: "a", fileCount: 1, truncated: false, depthTruncated: false, trimmed: 0 }, { label: "b", folder: "b", fileCount: 1, truncated: false, depthTruncated: false, trimmed: 0 }])).toMatch(/無ければシステムにしない/);
  });

  it("画面 UI の依頼に、操作に関わる状態の名前と、説明・注記に開発メモを書かない旨が入る", async () => {
    useScripts();
    await run();
    const text = callsOf("screen").find((c) => screenNameOf(c.text) === "承認待ち一覧")!.text;
    expect(text).toMatch(/モデルの状態の名前を使う \(この画面の操作に関わる状態: 「承認待ち」\)/);
    const order = callsOf("screen").find((c) => screenNameOf(c.text) === "注文承認")!.text;
    expect(order).toMatch(/「承認待ち」「承認済み」/);
    expect(text).toMatch(/help・note など、利用者に見える文\) には、ソースの不整合や開発者向けのメモ/);
  });
});
