import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../../ai/sourceTree";
import { executeSourceTool } from "../../ai/sourceTools";
import { pickSourceFolderInBrowser, treeFromDirectoryHandle, treeFromFileList } from "../sourceFolder";

/** ハンドルの偽物。読んだ (getFile した) ファイルと、降りたフォルダを記録する */
interface FakeDir {
  kind: "directory";
  name: string;
  values(): AsyncIterable<FakeDir | { kind: "file"; name: string; getFile(): Promise<File> }>;
}
function fakeDir(name: string, children: Record<string, string | FakeDir>, log: { dirs: string[]; files: string[] }, prefix = ""): FakeDir {
  return {
    kind: "directory",
    name,
    async *values() {
      log.dirs.push(`${prefix}${name}`);
      for (const [n, c] of Object.entries(children)) {
        if (typeof c === "string") {
          yield {
            kind: "file",
            name: n,
            async getFile() {
              log.files.push(`${prefix}${name}/${n}`);
              return new File([c], n);
            },
          };
        } else yield c;
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

type Child = string | FakeDir | { kind: "file"; name: string; getFile(): Promise<File> };
const mkDir = (name: string, children: Child[]): FakeDir => ({
  kind: "directory",
  name,
  async *values() {
    for (const c of children) {
      if (typeof c === "string") yield { kind: "file" as const, name: c, getFile: async () => new File(["x"], c) };
      else yield c;
    }
  },
});

describe("treeFromDirectoryHandle", () => {
  it("深さの上限を超えたフォルダは、その枝だけ飛ばして兄弟の残りを読む", async () => {
    // aaa/d0/…/d24/leaf/z.ts (25 段を超える) と src/main.ts と README.md
    let deep: FakeDir = mkDir("leaf", ["z.ts"]);
    for (let i = 24; i >= 0; i--) deep = mkDir(`d${i}`, [deep]);
    const root = mkDir("app", [mkDir("aaa", [deep]), mkDir("src", ["main.ts"]), "README.md"]);
    const tree = await treeFromDirectoryHandle(root);
    expect(tree.files.map((f) => f.path)).toEqual(["README.md", "src/main.ts"]);
    expect(tree.depthTruncated).toBe(true);
    expect(tree.truncated).toBeUndefined();
    const r = JSON.parse((await executeSourceTool(tree, "list_files", {})).content);
    expect(r.treeTruncated).toBe(true);
    expect(r.treeNote).toMatch(/深さの上限/);
    expect(r.treeNote).not.toMatch(/多すぎ/);
  });
  it("深さの上限は引数で小さくして試せる。上限ぎりぎりは読む", async () => {
    const root = mkDir("app", ["a.ts", mkDir("x", ["b.ts", mkDir("y", ["c.ts"])])]);
    const tree = await treeFromDirectoryHandle(root, { maxDepth: 1 });
    expect(tree.files.map((f) => f.path)).toEqual(["a.ts", "x/b.ts"]);
    expect(tree.depthTruncated).toBe(true);
    const all = await treeFromDirectoryHandle(root, { maxDepth: 2 });
    expect(all.files.length).toBe(3);
    expect(all.depthTruncated).toBeUndefined();
  });
  it("件数の上限で全体を打ち切り、truncated だけが立つ", async () => {
    const root = mkDir("app", ["a.ts", "b.ts", "c.ts", mkDir("z", ["d.ts"])]);
    const tree = await treeFromDirectoryHandle(root, { maxFiles: 2 });
    expect(tree.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(tree.truncated).toBe(true);
    expect(tree.depthTruncated).toBeUndefined();
    const r = JSON.parse((await executeSourceTool(tree, "list_files", {})).content);
    expect(r.treeNote).toMatch(/件数の上限/);
  });
  it("getFile が投げるファイル、一覧が投げるフォルダは、その項目だけ飛ばして続ける", async () => {
    const bad = { kind: "file" as const, name: "bad.ts", getFile: async () => { throw new Error("denied"); } };
    const badDir: FakeDir = { kind: "directory", name: "locked", values: () => { throw new Error("denied"); } };
    const midDir: FakeDir = {
      kind: "directory",
      name: "mid",
      async *values() {
        yield { kind: "file" as const, name: "ok.ts", getFile: async () => new File(["x"], "ok.ts") };
        throw new Error("lost");
      },
    };
    const tree = await treeFromDirectoryHandle(mkDir("app", [bad, badDir, midDir, "good.ts"]));
    expect(tree.files.map((f) => f.path)).toEqual(["good.ts", "mid/ok.ts"]);
  });
  it("巨大ファイルは木に入れず、選んだあとに大きくなったファイルは readFile が断る", async () => {
    let calls = 0;
    const growing = {
      kind: "file" as const,
      name: "grow.ts",
      async getFile() {
        calls++;
        return new File([calls === 1 ? "small" : "x".repeat(MAX_FILE_BYTES + 1)], "grow.ts");
      },
    };
    const huge = { kind: "file" as const, name: "huge.ts", getFile: async () => new File(["x".repeat(MAX_FILE_BYTES + 1)], "huge.ts") };
    const tree = await treeFromDirectoryHandle(mkDir("app", [growing, huge]));
    expect(tree.files.map((f) => f.path)).toEqual(["grow.ts"]);
    await expect(tree.readFile("grow.ts")).rejects.toThrow(/大きすぎ/);
    const r = await executeSourceTool(tree, "read_file", { path: "grow.ts" });
    expect(r.ok).toBe(false);
  });
  it("根の直下の build は除外し、src/target は読む。.ssh の下は読まない", async () => {
    const tree = await treeFromDirectoryHandle(
      mkDir("app", [mkDir("build", ["o.js"]), mkDir("src", [mkDir("target", ["Target.java"])]), mkDir(".ssh", ["config"]), mkDir("Node_Modules", ["i.js"])]),
    );
    expect(tree.files.map((f) => f.path)).toEqual(["src/target/Target.java"]);
  });
  it("除外フォルダには降りず、秘密・バイナリ・巨大ファイルは木に入れない", async () => {
    const log = { dirs: [] as string[], files: [] as string[] };
    const root = fakeDir(
      "shop",
      {
        "a.ts": "export const a = 1;\n",
        ".env": "KEY=1",
        "logo.png": "x",
        "huge.ts": "x".repeat(600 * 1024),
        node_modules: fakeDir("node_modules", { "i.js": "x" }, log, "shop/"),
        src: fakeDir("src", { "b.ts": "b", ".git": fakeDir(".git", { c: "x" }, log, "shop/src/") }, log, "shop/"),
      },
      log,
    );
    const tree = await treeFromDirectoryHandle(root);
    expect(tree.name).toBe("shop");
    expect(tree.files.map((f) => f.path)).toEqual(["a.ts", "src/b.ts"]);
    expect(log.dirs).toEqual(["shop", "shop/src"]);
    expect(log.files).not.toContain("shop/.env");
    expect(log.files).not.toContain("shop/logo.png");
    expect(await tree.readFile("src/b.ts")).toBe("b");
    await expect(tree.readFile(".env")).rejects.toThrow();
    const r = JSON.parse((await executeSourceTool(tree, "list_files", {})).content);
    expect(r.entries.map((e: { path: string }) => e.path)).toEqual(["src/", "a.ts"]);
  });
});

describe("treeFromFileList", () => {
  const file = (rel: string, text: string) => {
    const f = new File([text], rel.split("/").pop()!);
    Object.defineProperty(f, "webkitRelativePath", { value: rel });
    return f;
  };
  it("深さの上限で捨てたら depthTruncated で知らせ、ほかのファイルは読む", async () => {
    const tree = treeFromFileList([file("app/a/b/c.ts", "C"), file("app/a/ok.ts", "O"), file("app/r.md", "R")], { maxDepth: 1 });
    expect(tree.files.map((f) => f.path)).toEqual(["a/ok.ts", "r.md"]);
    expect(tree.depthTruncated).toBe(true);
    expect(tree.truncated).toBeUndefined();
  });
  it("件数の上限で打ち切る", () => {
    const tree = treeFromFileList([file("app/a.ts", "1"), file("app/b.ts", "2"), file("app/c.ts", "3")], { maxFiles: 2 });
    expect(tree.files.length).toBe(2);
    expect(tree.truncated).toBe(true);
  });
  it("巨大ファイルは入れず、読むときにも大きさを確かめる", async () => {
    const tree = treeFromFileList([file("app/huge.ts", "x".repeat(MAX_FILE_BYTES + 1)), file("app/ok.ts", "o")]);
    expect(tree.files.map((f) => f.path)).toEqual(["ok.ts"]);
    await expect(tree.readFile("huge.ts")).rejects.toThrow();
  });
  it("先頭のフォルダ名を取り、除外フォルダの下・秘密などを捨てる", async () => {
    const tree = treeFromFileList([
      file("shop/src/a.ts", "A"),
      file("shop/node_modules/x/i.js", "N"),
      file("shop/.env.local", "S"),
      file("shop/img/p.png", "P"),
      file("shop/README.md", "R"),
    ]);
    expect(tree.name).toBe("shop");
    expect(tree.files.map((f) => f.path)).toEqual(["README.md", "src/a.ts"]);
    expect(await tree.readFile("src/a.ts")).toBe("A");
    await expect(tree.readFile("node_modules/x/i.js")).rejects.toThrow();
  });
});

describe("pickSourceFolderInBrowser", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).showDirectoryPicker;
  });
  it("showDirectoryPicker を読み取り専用で呼ぶ。取り消しは null", async () => {
    const log = { dirs: [] as string[], files: [] as string[] };
    const picker = vi.fn().mockResolvedValue(fakeDir("app", { "a.ts": "x" }, log));
    (window as unknown as Record<string, unknown>).showDirectoryPicker = picker;
    const tree = await pickSourceFolderInBrowser();
    expect(picker).toHaveBeenCalledWith({ mode: "read" });
    expect(tree?.files.map((f) => f.path)).toEqual(["a.ts"]);
    picker.mockRejectedValue(new DOMException("cancel", "AbortError"));
    expect(await pickSourceFolderInBrowser()).toBeNull();
  });
  it("showDirectoryPicker が無ければ webkitdirectory の input を使う", async () => {
    let created: HTMLInputElement | undefined;
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = original(tag);
      if (tag === "input") {
        created = el as HTMLInputElement;
        el.click = () => {
          const f = new File(["x"], "a.ts");
          Object.defineProperty(f, "webkitRelativePath", { value: "app/a.ts" });
          Object.defineProperty(el, "files", { value: [f] });
          el.dispatchEvent(new Event("change"));
        };
      }
      return el;
    }) as typeof document.createElement);
    const tree = await pickSourceFolderInBrowser();
    expect(created?.hasAttribute("webkitdirectory")).toBe(true);
    expect(tree?.name).toBe("app");
  });
  it("input を取り消したら null", async () => {
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = original(tag);
      if (tag === "input") el.click = () => el.dispatchEvent(new Event("cancel"));
      return el;
    }) as typeof document.createElement);
    expect(await pickSourceFolderInBrowser()).toBeNull();
  });
  it("input でファイルが 1 つも選ばれなかった (空のフォルダ) ときも null", async () => {
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = original(tag);
      if (tag === "input") {
        el.click = () => {
          Object.defineProperty(el, "files", { value: [] });
          el.dispatchEvent(new Event("change"));
        };
      }
      return el;
    }) as typeof document.createElement);
    expect(await pickSourceFolderInBrowser()).toBeNull();
  });
});
