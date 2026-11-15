import { describe, expect, it } from "vitest";
import { SOURCE_LIMITS, SOURCE_TOOLS, executeSourceTool, globMatcher, isSourceTool } from "../sourceTools";
import { MAX_FILE_BYTES, combineSourceTrees, memorySourceTree } from "../sourceTree";

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
  it("limit で切るときも、浅い階層が先で、ファイルがフォルダに押し出されて全部落ちない", async () => {
    const contents: Record<string, string> = { "a.ts": "1", "b.ts": "2" };
    for (let i = 0; i < 10; i++) contents[`dir${i}/f.ts`] = "x";
    const t = memorySourceTree("x", contents);
    const r = JSON.parse((await executeSourceTool(t, "list_files", { depth: 2, limit: 4 })).content);
    const paths = r.entries.map((e: { path: string }) => e.path);
    expect(paths).toEqual(["dir0/", "dir1/", "a.ts", "b.ts"]);
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(22);
    // 深い階層は浅い階層のあと
    const deep = JSON.parse((await executeSourceTool(t, "list_files", { depth: 2, limit: 12 })).content);
    expect(deep.entries.map((e: { path: string }) => e.path).slice(-2)).not.toContain("dir0/f.ts");
  });
  it("深さで打ち切られた木は、理由を分けて知らせる", async () => {
    const base = memorySourceTree("x", { "a.ts": "1" });
    const r1 = JSON.parse((await executeSourceTool({ ...base, truncated: true }, "list_files", {})).content);
    expect(r1.treeTruncated).toBe(true);
    expect(r1.treeNote).toMatch(/件数の上限/);
    expect(r1.treeNote).not.toMatch(/深さ/);
    const r2 = JSON.parse((await executeSourceTool({ ...base, depthTruncated: true }, "list_files", {})).content);
    expect(r2.treeTruncated).toBe(true);
    expect(r2.treeNote).toMatch(/深さの上限/);
    expect(r2.treeNote).not.toMatch(/件数/);
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

describe("read_file の長い行", () => {
  it("1 行が上限を超えるとき、その行の残りが読めないことを note に書く", async () => {
    const t = memorySourceTree("x", { "a.txt": `${"x".repeat(SOURCE_LIMITS.readChars + 500)}\nnext\n` });
    const r = JSON.parse((await executeSourceTool(t, "read_file", { path: "a.txt" })).content);
    expect(r.truncated).toBe(true);
    expect(r.omittedChars).toBe(500);
    expect(r.note).toMatch(/残り 500 文字は read_file では読めない/);
    expect(r.nextStartLine).toBe(2);
  });
  it("切り詰めはサロゲートペアの途中で切らない", async () => {
    // 先頭が 1 文字ずれて、上限の位置が 𠮷 の真ん中になる
    const t = memorySourceTree("x", { "a.txt": `a${"𠮷".repeat(SOURCE_LIMITS.readChars)}\n` });
    const r = JSON.parse((await executeSourceTool(t, "read_file", { path: "a.txt" })).content);
    const last = r.content.charCodeAt(r.content.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(() => encodeURIComponent(r.content)).not.toThrow();
    const found = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "a" })).content);
    expect(() => encodeURIComponent(found.matches[0].text)).not.toThrow();
  });
});

describe("木の実装が除外し忘れたとき", () => {
  it("巨大なファイルは、木が大きさを偽っても読んだ文字数で断る", async () => {
    const huge = "x".repeat(MAX_FILE_BYTES + 1);
    const liar = { name: "x", files: [{ path: "a.ts", size: 10 }], async readFile() { return huge; } };
    const r = JSON.parse((await executeSourceTool(liar, "read_file", { path: "a.ts" })).content);
    expect(r.error).toMatch(/大きすぎ/);
    expect(JSON.parse((await executeSourceTool(liar, "search_code", { pattern: "x" })).content).matches).toEqual([]);
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
  it("不正な正規表現は失敗で返す (文字列検索に落とさない)", async () => {
    const r = await run("search_code", { pattern: "function (", regex: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/正規表現として読めませんでした/);
    expect(r.error).toMatch(/文字列検索/);
  });
  it("重くなりうる正規表現は実行せず、書き直し方を添えて失敗で返す", async () => {
    const t = memorySourceTree("x", { "a.txt": `${"a".repeat(30)}!\n` });
    for (const pattern of ["(a+)+$", "((a+))+$", "(a|a)+$", "(a{1,}){1,}$", "(a*)*b", "(?:a|b)*c", "(a|aa)?b", "(x+x+){2}y", "^(\\w+\\s?)*$"]) {
      const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern, regex: true })).content);
      expect(r.error, pattern).toMatch(/量指定子の付いたグループ/);
      expect(r.error, pattern).toMatch(/文字列検索/);
    }
    for (const pattern of ["(a)\\1", "(?<n>a)\\k<n>"]) {
      const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern, regex: true })).content);
      expect(r.error, pattern).toMatch(/後方参照/);
    }
    for (const pattern of [".*.*.*.*.*x", "a+a+a+a+b", "a{1,}a{2,}a{3,}a{4,}b", "\\w*\\w*\\w*b", "a*a*a*b"]) {
      const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern, regex: true })).content);
      expect(r.error, pattern).toMatch(/際限のない繰り返し/);
    }
    const many = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "a?a?a?a?a?a?a?a?a?aaaaaaaaaa", regex: true })).content);
    expect(many.error).toMatch(/量指定子が/);
    const alts = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)b", regex: true })).content);
    expect(alts.error).toMatch(/「\|」/);
  });
  it("病的な正規表現は、1000 文字の行に対して全体で短時間に終わる (断るか、速く終わる)", async () => {
    const line = `${"a".repeat(999)}!`;
    const t = memorySourceTree("x", { "a.txt": `${line}\n${line}\n` });
    const patterns = [
      "((a+))+$", "(a|a)+$", "(a{1,}){1,}$", ".*.*.*.*.*x", "(a*)*b", "(.*a){20}", "(?:a|b)*c", "a*a*a*a*a*b", "(a|aa)+$", "^(\\w+\\s?)*$", "(x+x+)+y",
      "(a)\\1", "a?a?a?a?a?a?a?a?a?a?a?a?a?a?a?aaaaaaaaaaaaaaaa", "(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)b", "a{0,999}a{0,999}a{0,999}a{0,999}b",
      "\\w*\\w*\\w*b", "[a-z]*[a-z]*[a-z]*[a-z]*!x",
    ];
    const started = Date.now();
    for (const pattern of patterns) await executeSourceTool(t, "search_code", { pattern, regex: true });
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("安全なもの (名前付きグループ・先読み・後読み・文字クラス) は通り、長い行でも固まらない", async () => {
    const line = `${"a".repeat(999)}!`;
    const t = memorySourceTree("x", { "a.txt": `foobar\n${line}\n` });
    const started = Date.now();
    for (const [pattern, hits] of [
      ["(?<n>foo)bar", 1],
      ["foo(?=bar)", 1],
      ["(?<!x)bar", 1],
      ["(?<=foo)bar", 1],
      ["fo+bar", 1],
      ["a*a*b", 1],
      ["[a-c]+a", 2],
      ["function\\s+\\w+", 0],
    ] as const) {
      const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern, regex: true })).content);
      expect(r.ok === false ? r.error : r.matches.length, pattern).toBe(r.ok === false ? undefined : hits);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("正規表現で行を切って照合したときは知らせる", async () => {
    const t = memorySourceTree("x", { "a.txt": `${"x".repeat(SOURCE_LIMITS.searchRegexLine)}needle\n` });
    const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "needle", regex: true })).content);
    expect(r.matches).toEqual([]);
    expect(r.note).toMatch(/先頭 300 文字だけ照合/);
  });
  it("打ち切ったときは、対象の総数と探した数を返す", async () => {
    const t = memorySourceTree("x", { "a.txt": "hit\nhit\nhit\n", "b.txt": "hit\n", "c.txt": "hit\n" });
    const r = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "hit", limit: 2 })).content);
    expect(r.truncated).toBe(true);
    expect(r.candidateFiles).toBe(3);
    expect(r.examinedFiles).toBe(1);
    expect(r.note).toMatch(/3 ファイルのうち、先頭から 1 個目まで/);
  });
  it("名前で分からない秘密鍵 (中身が PRIVATE KEY) は読めず、検索にも出ない", async () => {
    const t = memorySourceTree("x", {
      "deploy/key.txt": "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n",
      "deploy/other.txt": "x\n-----BEGIN PGP PRIVATE KEY BLOCK-----\ny",
      "README.md": "abc\n",
    });
    const read = JSON.parse((await executeSourceTool(t, "read_file", { path: "deploy/key.txt" })).content);
    expect(read.error).toMatch(/ありません/);
    expect(JSON.parse((await executeSourceTool(t, "read_file", { path: "deploy/other.txt" })).content).error).toMatch(/ありません/);
    const found = JSON.parse((await executeSourceTool(t, "search_code", { pattern: "abc" })).content);
    expect(found.matches.map((m: { path: string }) => m.path)).toEqual(["README.md"]);
    expect(JSON.parse((await executeSourceTool(t, "search_code", { pattern: "PRIVATE" })).content).matches).toEqual([]);
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

describe("複数のソースをまとめた木", () => {
  const sources = [
    { label: "バックエンド", tree: memorySourceTree("api", { "src/routes/orders.ts": "app.post('/api/orders')\n", "prisma/schema.prisma": "model Order {}\n", ".env": "KEY=abc", "build/out.js": "/api/orders", "secrets/key.txt": "s" }) },
    { label: "build", tree: memorySourceTree("web", { "src/pages/New.tsx": "fetch('/api/orders')\n", ".env.local": "KEY=def", "build/y.js": "/api/orders", "src/build/ok.ts": "/api/orders\n", "dist/z.js": "/api/orders" }) },
    { label: "空", tree: memorySourceTree("empty", { ".env": "x" }) },
  ];
  const multi = combineSourceTrees(sources);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const go = async (name: string, input: unknown, t = multi): Promise<Record<string, any>> => {
    const r = await executeSourceTool(t, name, input);
    return { ok: r.ok, ...(JSON.parse(r.content) as Record<string, any>) };
  };

  it("根の一覧に、すべてのラベル (読めるファイルが 0 件のソースも) が出る。ソースの内訳も付く", async () => {
    const r = await go("list_files", {});
    expect(r.entries.map((e: { path: string }) => e.path)).toEqual(["build/", "バックエンド/", "空/"]);
    expect(r.entries.find((e: { path: string }) => e.path === "空/")).toEqual({ path: "空/", files: 0 });
    expect(r.sources).toEqual([
      { label: "バックエンド", folder: "api", files: 2 },
      { label: "build", folder: "web", files: 2 },
      { label: "空", folder: "empty", files: 0 },
    ]);
  });

  it("limit が小さくても、根ではラベルのフォルダが落ちない", async () => {
    const r = await go("list_files", { limit: 1 });
    expect(r.entries.map((e: { path: string }) => e.path)).toEqual(["build/", "バックエンド/", "空/"]);
  });

  it("ラベルの中は、もとのソースと同じ規則で見える (.env・根の直下の build・secrets・dist は出ない)", async () => {
    const back = await go("list_files", { path: "バックエンド", depth: 3 });
    expect(back.entries.map((e: { path: string }) => e.path).sort()).toEqual(["バックエンド/prisma/", "バックエンド/prisma/schema.prisma", "バックエンド/src/", "バックエンド/src/routes/", "バックエンド/src/routes/orders.ts"]);
    const web = await go("list_files", { path: "build", depth: 3 });
    const paths = web.entries.map((e: { path: string }) => e.path);
    expect(paths).toContain("build/src/pages/New.tsx");
    expect(paths).toContain("build/src/build/ok.ts"); // ラベルが build でも、そのソースは消えない。根の直下ではない build は読める
    expect(JSON.stringify(web)).not.toMatch(/\.env|y\.js|z\.js/);
  });

  it("read_file: ラベル付きで読める。.env・根の直下の build・秘密・ラベルなし・知らないラベルは読めない", async () => {
    expect((await go("read_file", { path: "build/src/pages/New.tsx" })).content).toContain("fetch");
    expect((await go("read_file", { path: "build/src/build/ok.ts" })).ok).toBe(true);
    for (const p of ["バックエンド/.env", "build/.env.local", "バックエンド/build/out.js", "build/build/y.js", "build/dist/z.js", "バックエンド/secrets/key.txt", "src/routes/orders.ts", "知らない/a.ts", "バックエンド", "バックエンド/"]) {
      expect((await go("read_file", { path: p })).ok, p).toBe(false);
    }
  });

  it("../ で、別のソースにも木の外にも出られない", async () => {
    for (const p of ["バックエンド/../build/src/pages/New.tsx", "../etc/passwd", "バックエンド/src/../../build/.env.local", "/バックエンド/src/routes/orders.ts", "C:/x"]) {
      expect((await go("read_file", { path: p })).ok, p).toBe(false);
    }
    expect((await go("list_files", { path: "バックエンド/.." })).ok).toBe(false);
    expect((await go("list_files", { path: "バックエンド/../build" })).ok).toBe(false);
  });

  it("search_code: ソースをまたいで探し、除外対象は見つからない。glob はラベル付きでもなしでも絞れる", async () => {
    const r = await go("search_code", { pattern: "/api/orders" });
    expect(r.matches.map((m: { path: string }) => m.path).sort()).toEqual(["build/src/build/ok.ts", "build/src/pages/New.tsx", "バックエンド/src/routes/orders.ts"].sort());
    expect((await go("search_code", { pattern: "/api/orders", glob: "build/src/pages/**" })).matches).toHaveLength(1);
    expect((await go("search_code", { pattern: "/api/orders", glob: "src/routes/**" })).matches.map((m: { path: string }) => m.path)).toEqual(["バックエンド/src/routes/orders.ts"]);
    expect((await go("search_code", { pattern: "/api/orders", glob: "バックエンド/**" })).matches).toHaveLength(1);
    expect((await go("search_code", { pattern: "KEY=" })).matches).toEqual([]);
  });

  it("打ち切りは、どのソースか名指しして知らせる", async () => {
    const big = memorySourceTree("big", Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, "needle"])));
    const t = combineSourceTrees([{ label: "大", tree: big }, { label: "小", tree: memorySourceTree("small", { "a.ts": "needle" }) }], { maxFiles: 10 });
    const list = await go("list_files", {}, t);
    expect(list.treeTruncated).toBe(true);
    expect(list.truncatedSources).toEqual(["大"]);
    expect(list.treeNote).toMatch(/「大」/);
    expect(list.treeNote).not.toMatch(/「小」/);
    expect(list.sources.find((s: { label: string }) => s.label === "大")).toMatchObject({ files: 9, truncated: true });
    const found = await go("search_code", { pattern: "needle" }, t);
    expect(found.truncatedSources).toEqual(["大"]);
    expect(found.matches.some((m: { path: string }) => m.path === "小/a.ts")).toBe(true);
    // もとのソースが深さで打ち切られていれば、それも名指しする
    const deep = combineSourceTrees([{ label: "A", tree: { ...memorySourceTree("a", { "x.ts": "x" }), depthTruncated: true } }, { label: "B", tree: memorySourceTree("b", { "y.ts": "y" }) }]);
    expect((await go("list_files", {}, deep)).treeNote).toMatch(/「A」: 深さの上限/);
  });

  it("どれかのソースが、たどる時点で打ち切られているときも分け合いの知らせが出る。打ち切りと減らしの両方に当たるソースは両方を伝え、減らしたファイルは読めず検索にも出ない", async () => {
    const big = memorySourceTree("big", Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${i < 15 ? "docs" : "src"}/f${String(i).padStart(2, "0")}.ts`, "needle"])));
    const t = combineSourceTrees([{ label: "大", tree: { ...big, truncated: true } }, { label: "小", tree: memorySourceTree("small", { "a.ts": "needle" }) }], { maxFiles: 10 });
    const list = await go("list_files", {}, t);
    expect(list.treeNote).toMatch(/「大」: ファイルが多すぎて、件数の上限で読むのをやめたので.*。件数の上限をほかのソースと分け合うため 21 件を減らした/);
    expect(list.treeNote).toMatch(/読み取りも検索もできない/);
    expect(list.sources.find((s: { label: string }) => s.label === "大")).toMatchObject({ files: 9, truncated: true, trimmed: 21 });
    // 減らしたあとも、どの最上位のフォルダも少し残る
    const kept = t.files.map((f) => f.path).filter((p) => p.startsWith("大/"));
    expect(kept.some((p) => p.startsWith("大/docs/"))).toBe(true);
    expect(kept.some((p) => p.startsWith("大/src/"))).toBe(true);
    // 減らしたファイルは、読み取りも検索もできない
    const dropped = big.files.map((f) => `大/${f.path}`).find((p) => !kept.includes(p))!;
    expect((await go("read_file", { path: dropped }, t)).ok).toBe(false);
    const found = await go("search_code", { pattern: "needle" }, t);
    expect(found.matches.map((m: { path: string }) => m.path)).not.toContain(dropped);
    expect(found.matches).toHaveLength(10);
  });

  it("ソースが 1 つの木は、今までと同じ (ラベルのフォルダが無く、ソースの内訳も出ない)", async () => {
    const one = combineSourceTrees([{ label: "バックエンド", tree: sources[0]!.tree }]);
    const a = await go("list_files", {}, one);
    const b = await go("list_files", {}, sources[0]!.tree);
    expect(a).toEqual(b);
    expect(a.sources).toBeUndefined();
    expect(await go("search_code", { pattern: "api/orders" }, one)).toEqual(await go("search_code", { pattern: "api/orders" }, sources[0]!.tree));
  });
});
