import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, excludeReason, memorySourceTree, normalizeTreePath, visibleFiles } from "../sourceTree";

describe("normalizeTreePath", () => {
  it("相対パスをそろえる", () => {
    expect(normalizeTreePath("./src//a/./b.ts")).toEqual({ ok: true, path: "src/a/b.ts" });
    expect(normalizeTreePath("src\\a\\b.ts")).toEqual({ ok: true, path: "src/a/b.ts" });
    expect(normalizeTreePath("")).toEqual({ ok: true, path: "" });
    expect(normalizeTreePath(".")).toEqual({ ok: true, path: "" });
  });
  it(".. ・絶対パス・NUL を断る", () => {
    for (const p of ["../x", "a/../../x", "a/..", "/etc/passwd", "C:\\x", "C:/x", "~/x", "a\0b"]) {
      expect(normalizeTreePath(p).ok, p).toBe(false);
    }
  });
});

describe("excludeReason", () => {
  it("秘密になりうるファイル", () => {
    for (const p of [".env", ".env.local", "config/.env.production", "prod.env", "id_rsa", "ssh/id_ed25519.pub", "certs/server.pem", "a/private.key", "k.p12", ".npmrc", "credentials.json", "secrets.yml", "terraform.tfstate"]) {
      expect(excludeReason(p), p).toBe("secret");
    }
    expect(excludeReason("src/secretary.ts")).toBeNull();
  });
  it("バイナリ・生成物・除外フォルダ・巨大ファイル", () => {
    expect(excludeReason("img/logo.png")).toBe("binary");
    expect(excludeReason("a.zip")).toBe("binary");
    expect(excludeReason("pnpm-lock.yaml")).toBe("generated");
    expect(excludeReason("dist/app.min.js")).toBe("folder");
    expect(excludeReason("public/app.min.js")).toBe("generated");
    expect(excludeReason("node_modules/x/index.js")).toBe("folder");
    expect(excludeReason("a/.git/config")).toBe("folder");
    expect(excludeReason("src/big.ts", MAX_FILE_BYTES + 1)).toBe("large");
    expect(excludeReason("src/ok.ts", MAX_FILE_BYTES)).toBeNull();
    expect(excludeReason("src/app.ts")).toBeNull();
  });
});

describe("memorySourceTree", () => {
  it("visibleFiles が除外を通す", () => {
    const tree = memorySourceTree("app", { "src/a.ts": "x", ".env": "K=1", "node_modules/p/i.js": "y", "logo.png": "z" });
    expect(visibleFiles(tree).map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(tree.files.length).toBe(4);
  });
  it("読めないパスは Error", async () => {
    await expect(memorySourceTree("app", {}).readFile("a")).rejects.toThrow();
  });
});
