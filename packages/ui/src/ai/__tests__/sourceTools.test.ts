import { describe, expect, it } from "vitest";
import { SOURCE_LIMITS, SOURCE_TOOLS, executeSourceTool, globMatcher, isSourceTool } from "../sourceTools";
import { memorySourceTree } from "../sourceTree";

const tree = memorySourceTree("shop", {
  "README.md": "# shop\n",
  "src/routes/orders.ts": "export function createOrder() {}\nexport function cancelOrder() {}\n",
  "src/routes/users.ts": "export function login() {}\n",
  "src/db/schema.prisma": "model Order {\n  id Int @id\n}\n",
  "src/util/deep/very/deep/x.ts": "const a = 1;\n",
  ".env": "SECRET_KEY=abc\n",
  "config/.env.production": "DB=secret\n",
  "keys/id_rsa": "-----BEGIN-----\n",
  "node_modules/lib/index.js": "createOrder\n",
  "assets/logo.png": "createOrder\n",
  "dist/bundle.js": "createOrder\n",
  "big.ts": "createOrder\n" + "x".repeat(600 * 1024),
  "bin.dat.ts": "a\0b createOrder",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = async (name: string, input: unknown): Promise<Record<string, any>> => {
  const r = await executeSourceTool(tree, name, input);
  return { ok: r.ok, changed: r.changed, ...(JSON.parse(r.content) as Record<string, any>) };
};

describe("道具の定義", () => {
  it("3 つの道具", () => {
    expect(SOURCE_TOOLS.map((t) => t.name)).toEqual(["list_files", "read_file", "search_code"]);
    expect(isSourceTool("read_file")).toBe(true);
    expect(isSourceTool("get_model")).toBe(false);
  });
  it("不明な道具は失敗", async () => {
    expect((await run("nope", {})).ok).toBe(false);
  });
});

describe("list_files", () => {
  it("根を 1 段だけ出す。除外対象は出ない", async () => {
    const r = await run("list_files", {});
    const paths = r.entries.map((e: { path: string }) => e.path);
    expect(paths).toEqual(["src/", "README.md", "bin.dat.ts"]); // 中身だけがバイナリのファイルは、読むときに断る
    expect(JSON.stringify(r)).not.toMatch(/env|id_rsa|node_modules|logo|dist|big\.ts/);
  });
  it("フォルダの中・深さ", async () => {
    const r = await run("list_files", { path: "src", depth: 2 });
    expect(r.entries.map((e: { path: string }) => e.path)).toEqual(["src/db/", "src/routes/", "src/util/", "src/util/deep/", "src/db/schema.prisma", "src/routes/orders.ts", "src/routes/users.ts"]);
    expect(r.entries[1]).toEqual({ path: "src/routes/", files: 2 });
  });
  it("件数の上限で切り詰めて知らせる", async () => {
    const r = await run("list_files", { path: "src", depth: 4, limit: 2 });
    expect(r.entries.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.note).toMatch(/呼び直す/);
  });
  it("木の外・存在しない・ファイル・除外フォルダを断る", async () => {
    expect((await run("list_files", { path: ".." })).ok).toBe(false);
    expect((await run("list_files", { path: "/etc" })).ok).toBe(false);
    expect((await run("list_files", { path: "nothing" })).ok).toBe(false);
    expect((await run("list_files", { path: "node_modules" })).ok).toBe(false);
    expect((await run("list_files", { path: "README.md" })).error).toMatch(/ファイル/);
  });
});

describe("read_file", () => {
  it("全体と行の範囲", async () => {
    const all = await run("read_file", { path: "src/routes/orders.ts" });
    expect(all).toMatchObject({ startLine: 1, endLine: 2, totalLines: 2 });
    expect(all.truncated).toBeUndefined();
    const part = await run("read_file", { path: "./src/routes/orders.ts", start_line: 2, end_line: 2 });
    expect(part.content).toBe("export function cancelOrder() {}");
    expect(part.startLine).toBe(2);
  });
  it("範囲の外・逆転は失敗", async () => {
    expect((await run("read_file", { path: "README.md", start_line: 9 })).ok).toBe(false);
    expect((await run("read_file", { path: "src/routes/orders.ts", start_line: 2, end_line: 1 })).ok).toBe(false);
  });
  it("秘密・バイナリ・巨大・生成物・除外フォルダ・木の外・存在しないものは読めない", async () => {
    for (const path of [".env", "config/.env.production", "keys/id_rsa", "assets/logo.png", "node_modules/lib/index.js", "big.ts", "bin.dat.ts", "../etc/passwd", "/etc/passwd", "nothing.ts"]) {
      const r = await run("read_file", { path });
      expect(r.ok, path).toBe(false);
      expect(JSON.stringify(r), path).not.toMatch(/SECRET_KEY|BEGIN/);
    }
  });
  it("行数の上限で切り詰めて続きを知らせる", async () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
    const t = memorySourceTree("x", { "a.txt": lines.join("\n") });
    const r = JSON.parse((await executeSourceTool(t, "read_file", { path: "a.txt" })).content);
    expect(r.endLine).toBe(SOURCE_LIMITS.readLines);
    expect(r.truncated).toBe(true);
    expect(r.nextStartLine).toBe(SOURCE_LIMITS.readLines + 1);
    expect(r.note).toContain(`start_line=${SOURCE_LIMITS.readLines + 1}`);
    const next = JSON.parse((await executeSourceTool(t, "read_file", { path: "a.txt", start_line: r.nextStartLine })).content);
    expect(next.content.startsWith(`line ${SOURCE_LIMITS.readLines + 1}`)).toBe(true);
  });
  it("文字数の上限で切り詰める (長い 1 行でも止まる)", async () => {
    const t = memorySourceTree("x", { "a.txt": `${"a".repeat(100)}\n`.repeat(400) + "z".repeat(50000) });
    const r = JSON.parse((await executeSourceTool(t, "read_file", { path: "a.txt" })).content);
    expect(r.content.length).toBeLessThanOrEqual(SOURCE_LIMITS.readChars);
    expect(r.truncated).toBe(true);
    const one = memorySourceTree("x", { "b.txt": "z".repeat(50000) });
    const o = JSON.parse((await executeSourceTool(one, "read_file", { path: "b.txt" })).content);
    expect(o.content.length).toBe(SOURCE_LIMITS.readChars);
    expect(o.truncated).toBe(true);
  });
});

describe("search_code", () => {
  it("文字列検索は除外対象を探さない", async () => {
    const r = await run("search_code", { pattern: "createorder" });
    expect(r.matches).toEqual([{ path: "src/routes/orders.ts", line: 1, text: "export function createOrder() {}" }]);
    expect(r.mode).toBe("literal");
    expect(JSON.stringify(r)).not.toMatch(/node_modules|dist|logo|big\.ts|bin\.dat/);
  });
  it("秘密の中身は検索にも出ない", async () => {
    const r = await run("search_code", { pattern: "SECRET_KEY" });
    expect(r.matches).toEqual([]);
    expect((await run("search_code", { pattern: "BEGIN", regex: true })).matches).toEqual([]);
  });
  it("大文字小文字の区別", async () => {
    expect((await run("search_code", { pattern: "createorder", case_sensitive: true })).matches).toEqual([]);
  });
  it("正規表現と glob", async () => {
    const r = await run("search_code", { pattern: "function (create|cancel)Order", regex: true, glob: "src/**/*.ts" });
    expect(r.mode).toBe("regex");
    expect(r.matches.map((m: { line: number }) => m.line)).toEqual([1, 2]);
    expect((await run("search_code", { pattern: "model", glob: "*.prisma" })).matches.length).toBe(1);
    expect((await run("search_code", { pattern: "model", glob: "*.ts" })).matches).toEqual([]);
  });
  it("不正な正規表現は文字列検索に落として知らせる", async () => {
    const r = await run("search_code", { pattern: "function (", regex: true });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("literal");
    expect(r.note).toMatch(/文字列として探した/);
  });
  it("重い正規表現は実行せず文字列検索に落とす", async () => {
    const t = memorySourceTree("x", { "a.txt": `${"a".repeat(30)}!\n` });
    const started = Date.now();
    const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "(a+)+$", regex: true })).content);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.mode).toBe("literal");
    expect(r.note).toMatch(/重い/);
  });
  it("一致の件数の上限で切り詰めて知らせる", async () => {
    const t = memorySourceTree("x", { "a.txt": Array.from({ length: 300 }, () => "hit").join("\n") });
    const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "hit", limit: 10 })).content);
    expect(r.matches.length).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.note).toMatch(/10 件/);
    const max = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "hit", limit: 9999 })).content);
    expect(max.matches.length).toBe(SOURCE_LIMITS.searchMax);
  });
  it("長い行は先頭だけ照合し、結果の行も短くする", async () => {
    const t = memorySourceTree("x", { "a.txt": `${"x".repeat(5000)}needle\nshort needle\n` });
    const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "needle" })).content);
    expect(r.matches.map((m: { line: number }) => m.line)).toEqual([2]);
  });
  it("pattern が必要・長すぎは失敗", async () => {
    expect((await run("search_code", {})).ok).toBe(false);
    expect((await run("search_code", { pattern: "a".repeat(SOURCE_LIMITS.patternChars + 1) })).ok).toBe(false);
  });
});

describe("globMatcher", () => {
  it("ファイル名とパス全体", () => {
    expect(globMatcher("*.ts")("src/a/b.ts")).toBe(true);
    expect(globMatcher("*.ts")("src/a/b.tsx")).toBe(false);
    expect(globMatcher("src/**/*.ts")("src/b.ts")).toBe(true);
    expect(globMatcher("src/*.ts")("src/a/b.ts")).toBe(false);
    expect(globMatcher("*.{ts,tsx}")("a/b.tsx")).toBe(true);
    expect(globMatcher("a?.ts")("ab.ts")).toBe(true);
  });
});
