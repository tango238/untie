// ソースコードから作成 (ソースが複数のフォルダ): バックエンド・管理画面・フロント画面の 3 つのソースを、ラベル付きで渡す。
// AI の会話は偽物にして、ソースをまたいだ調査 → 分析モデル → データ → 画面 UI の流れを、台本どおりに確かめる。
import { describe, expect, it, vi } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import { effectiveDatabaseIds } from "@untie/core/model/design";
import { traceToActors } from "@untie/core/model/trace";
import { validateModel } from "@untie/core/model/validate";
import type { ChatEvents, ChatOptions } from "../chat";
import { combineSourceTrees, memorySourceTree } from "../sourceTree";
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
    // 画面だけのシステム: スキーマ定義は自分のソースに無いので、データベースは提出しない
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
    // データの会話は、データを持たないシステムにも開く。画面だけのシステムの依頼には、データベースを提出しない旨が入る
    const dataCalls = callsOf("data").map((c) => c.text);
    expect(dataCalls).toHaveLength(3);
    expect(dataCalls.find((t) => systemNameOf(t) === MULTI_SHOP)).toMatch(/submit_database は提出しない/);
    expect(dataCalls.find((t) => systemNameOf(t) === MULTI_SHOP)).toMatch(/スキーマ定義のあるソース/);
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

  it("データの依頼 (複数): スキーマ定義のあるソースから写す。画面を持たないシステムの依頼に、画面だけのシステムの決めは入らない", () => {
    const m = { elements: [{ id: "s", kind: "system", name: "サーバー" }], relations: [] } as never;
    expect(reverseDataRequest(m, "s", true)).toMatch(/スキーマ定義のあるソースから写す/);
    expect(reverseDataRequest(m, "s", true)).not.toMatch(/画面だけで/);
    expect(reverseDataRequest(m, "s", false)).not.toMatch(/ソースが複数/);
  });

  it("sourcePathsIn は、説明にあるラベル付きのパスのうち、木にあるものだけを取り出す", () => {
    const tree = combineSourceTrees(multiFixtureSources());
    const text = "お客様が注文を送る (フロント画面/src/pages/OrderNew.tsx:12)。参考: バックエンド/src/routes/orders.ts、フロント画面/src/pages/Nothing.tsx、フロント画面/.env";
    expect(sourcePathsIn(text, tree)).toEqual(["フロント画面/src/pages/OrderNew.tsx", "バックエンド/src/routes/orders.ts"]);
    expect(sourcePathsIn(text, memorySourceTree("x", { "a.ts": "" }))).toEqual([]);
  });
});
