// ソースコードから作成の、データの段階を、ソースの数に関わらず同じ仕組みで確かめる。
// ソースが 1 つでシステムが複数のとき (画面のシステムが 2 つ) も、すでにあるデータベースを use_database で使う。システムが 1 つだけなら、道具も依頼文も今までどおり。
import { describe, expect, it, vi } from "vitest";
import { checkDesign } from "@untie/core/model/designCheck";
import type { UntieModel } from "@untie/core/model/types";
import type { ChatEvents, ChatOptions } from "../chat";
import { memorySourceTree } from "../sourceTree";
import type { ModelSpec } from "../spec";
import type { ToolOutcome } from "../tools";
import { FIXTURE_DATABASE, FIXTURE_SITEMAP, FIXTURE_SPEC } from "./fixtures/reverseDraft";
import { MULTI_ADMIN, MULTI_API, MULTI_DATABASE, MULTI_SHOP, MULTI_SITEMAPS, MULTI_SPEC } from "./fixtures/reverseMultiSource";

type Kind = "survey" | "model" | "data" | "screen";
interface Call {
  kind: Kind;
  text: string;
  runTool: ChatOptions["runTool"];
}
type Script = (c: Call) => Promise<string> | string;

const fake = vi.hoisted(() => ({
  scripts: {} as Partial<Record<string, (c: unknown) => Promise<string> | string>>,
  calls: [] as { kind: string; text: string }[],
  /** データの会話ごとの道具の定義 */
  dataTools: [] as { name: string; description: string; parameters: unknown }[][],
}));

vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_provider: string, o: ChatOptions) => {
      const names = o.tools.map((t) => t.name);
      const kind = names.includes("submit_model") ? "model" : names.includes("submit_database") ? "data" : names.includes("submit_screen") ? "screen" : "survey";
      if (kind === "data") fake.dataTools.push(o.tools);
      return {
        seed: () => {},
        send: async (text: string, events?: ChatEvents) => {
          const runTool: ChatOptions["runTool"] = async (name, input) => {
            const outcome = await o.runTool(name, input);
            events?.onTool?.(name, outcome);
            return outcome;
          };
          fake.calls.push({ kind, text });
          return (await fake.scripts[kind]!({ kind, text, runTool })) as string;
        },
      };
    },
  };
});

const { reverseEngineer } = await import("../reverse");

const parse = (r: ToolOutcome) => JSON.parse(r.content) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const systemNameOf = (text: string) => /システム「(.+?)」のデータを作ります/.exec(text)?.[1] ?? "";
const results: Record<string, ToolOutcome[]> = {};
const keep = (k: string, r: ToolOutcome) => {
  (results[k] ??= []).push(r);
  return r;
};

/** バックエンドを持たない (ジョブも webhook も無い) 画面のシステム 2 つ */
const TWO_SYSTEMS: ModelSpec = { ...MULTI_SPEC, systems: MULTI_SPEC.systems!.filter((s) => s.name !== MULTI_API), events: [] };
/** ソースが 1 つ (ラベルなし) */
const ONE_SOURCE = () => memorySourceTree("shop-app", { "README.md": "# ショップ\n", "prisma/schema.prisma": MULTI_DATABASE.dsl, "src/a.ts": "export {};\n" });

async function run(spec: ModelSpec, data: Script) {
  fake.calls.length = 0;
  fake.dataTools.length = 0;
  for (const k of Object.keys(results)) delete results[k];
  fake.scripts = {
    survey: () => "## 調査結果\n- 注文",
    model: async (c: Call) => ((await c.runTool("submit_model", spec)).ok ? "提出しました" : "直します"),
    data,
    screen: () => "提出しました",
  } as typeof fake.scripts;
  return reverseEngineer(ONE_SOURCE(), "お客様の注文から、スタッフの承認まで", { provider: "claude", model: "claude-opus-5-5", apiKey: "k" });
}
const sysIdOf = (m: UntieModel, name: string) => m.elements.find((e) => e.kind === "system" && e.name === name)!.id;
const toolNames = (tools: { name: string }[]) => tools.map((t) => t.name).filter((n) => !["list_files", "read_file", "search_code"].includes(n));
const dbTool = (tools: { name: string; parameters: unknown }[]) => tools.find((t) => t.name === "submit_database")!;
const props = (t: { parameters: unknown }) => (t.parameters as { properties: Record<string, { description?: string }> }).properties;

describe("データの段階: ソースが 1 つでも、すでにあるデータベースは use_database で使う", () => {
  it("システムが 2 つ: 最初のシステムは submit_database と submit_sitemap だけ、2 つ目には use_database が付く。データベースは複製されない", async () => {
    const r = await run(TWO_SYSTEMS, async (c) => {
      const system = systemNameOf(c.text);
      if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system });
      else {
        // 同じスキーマを写し直そうとする → 断られて、use_database で使う
        keep("dup", await c.runTool("submit_database", { ...MULTI_DATABASE, system, database_name: "管理画面のDB" }));
        keep("dup", await c.runTool("use_database", { system, database: "注文DB", tables: [] }));
      }
      await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
      return "提出しました";
    });
    const m = r.build.model;
    expect(fake.dataTools.map(toolNames)).toEqual([
      ["submit_database", "submit_sitemap"],
      ["submit_database", "use_database", "submit_sitemap"],
    ]);
    // 最初の依頼には、ほかのシステムも使うことと、ソースが複数という文が入らない (ソースは 1 つ)
    const [first, second] = fake.calls.filter((c) => c.kind === "data").map((c) => c.text);
    expect(first).toMatch(/ここで写したデータベースは、ほかのシステムも使います/);
    expect(first).not.toMatch(/ソースが複数/);
    expect(second).toMatch(/<すでにあるデータベース/);
    expect(second).toMatch(/use_database/);
    expect(second).not.toMatch(/ソースが複数/);
    expect(props(dbTool(fake.dataTools[0]!)).database_name!.description).toMatch(/システムの名前にしない/);
    expect(props(dbTool(fake.dataTools[0]!)).separate_reason).toBeUndefined(); // まだ何も無いので、理由の項目は無い
    expect(props(dbTool(fake.dataTools[1]!)).separate_reason).toBeDefined();
    expect(results.dup![0]!.ok).toBe(false);
    expect(m.databases.filter((d) => d.dsl.includes("model Order"))).toHaveLength(1);
    for (const name of [MULTI_SHOP, MULTI_ADMIN]) expect(checkDesign(m, sysIdOf(m, name)).problems, name).toEqual([]);
    expect(r.warnings.filter((w) => w.startsWith("データ"))).toEqual([]);
  });

  it("システムが 1 つだけ: 道具は submit_database と submit_sitemap だけで、依頼文にも共有・use_database の話が入らない (今までどおり)", async () => {
    const r = await run(FIXTURE_SPEC, async (c) => {
      await c.runTool("submit_database", FIXTURE_DATABASE);
      await c.runTool("submit_sitemap", FIXTURE_SITEMAP);
      return "提出しました";
    });
    expect(r.build.model.elements.filter((e) => e.kind === "system")).toHaveLength(1);
    expect(fake.dataTools.map(toolNames)).toEqual([["submit_database", "submit_sitemap"]]);
    const text = fake.calls.find((c) => c.kind === "data")!.text;
    for (const word of ["use_database", "すでにあるデータベース", "ほかのシステムも使います", "ソースが複数", "separate_reason"]) expect(text, word).not.toContain(word);
    expect(text).toMatch(/スキーマ定義が見つからないときは、コードのデータの使い方/);
    const description = props(dbTool(fake.dataTools[0]!)).database_name!.description!;
    expect(description).not.toMatch(/ほかのシステム/);
    expect(props(dbTool(fake.dataTools[0]!)).separate_reason).toBeUndefined();
    expect(r.build.model.databases.filter((d) => d.dsl.includes("model Order"))).toHaveLength(1);
  });

  it("(item 6) 自前と共有の両方のデータベースを使うシステム: 出し直しの案内に並ぶテーブルは、その道具で結べるものだけ", async () => {
    const spec = structuredClone(TWO_SYSTEMS);
    spec.informations!.push({ name: "承認の記録", description: "承認した記録" }, { name: "注文明細", description: "注文の 1 行" });
    const list = spec.businesses![0]!.activities!.flatMap((a) => a.usecases ?? []).find((u) => u.name === "承認待ちの注文を探す")!;
    list.reads = ["注文", "注文明細"];
    list.writes = ["承認の記録"];
    const own = { database_name: "承認DB", dsl: "model Approval {\n  id String @id\n}\nmodel Memo {\n  id String @id\n}\n", tables: [{ table: "Approval", informations: ["承認の記録"] }] };
    await run(spec, async (c) => {
      const system = systemNameOf(c.text);
      if (system === MULTI_SHOP) await c.runTool("submit_database", { ...MULTI_DATABASE, system, tables: [{ table: "Order", informations: ["注文"] }, { table: "Product", informations: ["商品"] }] });
      else {
        keep("own", await c.runTool("submit_database", { system, ...own })); // Memo はどの情報にも結ばれていない
        keep("use", await c.runTool("use_database", { system, database: "注文DB", tables: [] })); // OrderItem も結ばれていない・注文明細も未対応
        keep("own", await c.runTool("submit_database", { system, ...own }));
      }
      await c.runTool("submit_sitemap", MULTI_SITEMAPS[system]!);
      return "提出しました";
    });
    const useNote = parse(results.use![0]!).result as string;
    expect(useNote).toMatch(/どの情報にも結ばれていないもの: OrderItem/);
    expect(useNote).not.toMatch(/Memo|承認DB/);
    const [firstOwn, secondOwn] = results.own!.map((x) => parse(x).result as string);
    expect(firstOwn).toMatch(/どの情報にも結ばれていないもの: Memo/);
    // 共有のデータベースも使っているとき: submit_database の案内に、共有のデータベースのテーブル (OrderItem) は並ばない
    expect(secondOwn).toMatch(/どの情報にも結ばれていないもの: Memo/);
    expect(secondOwn).not.toMatch(/OrderItem/);
    expect(secondOwn).toMatch(/どのテーブルにも結ばれていない情報: 注文明細/);
  });
});
