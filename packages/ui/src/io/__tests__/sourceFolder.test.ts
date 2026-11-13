import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("treeFromDirectoryHandle", () => {
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
    vi.restoreAllMocks();
  });
  it("input を取り消したら null", async () => {
    const original = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
      const el = original(tag);
      if (tag === "input") el.click = () => el.dispatchEvent(new Event("cancel"));
      return el;
    }) as typeof document.createElement);
    expect(await pickSourceFolderInBrowser()).toBeNull();
    vi.restoreAllMocks();
  });
});
