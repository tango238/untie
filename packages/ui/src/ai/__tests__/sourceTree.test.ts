import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, excludeReason, isExcludedDirName, looksPrivateKey, memorySourceTree, normalizeTreePath, visibleFiles } from "../sourceTree";

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
  it("名前の揺れ・鍵・秘密のフォルダ・サービスアカウント", () => {
    for (const p of [".envrc", ".env-prod", ".env_dev", ".env~", "app.env.local", ".env.example", ".env.sample", ".env.template", "terraform.tfstate.backup", "a/x.tfvars.json", "id_ed25519_sk", "id_ecdsa_sk", "id_ed25519_sk.pub", ".ssh/config", "home/.aws/config", ".gnupg/x", ".docker/config.json", ".kube/config", "secrets/db.ts", "app/secrets/a.txt", "service-account.json", "service-account-prod.json", "client_secret.json", "client_secret_123.apps.json", "credentials.json.bak"]) {
      expect(excludeReason(p), p).toBe("secret");
    }
  });
  it("大文字小文字の違う名前も除外する", () => {
    expect(excludeReason(".ENV")).toBe("secret");
    expect(excludeReason("config/.Env.Local")).toBe("secret");
    expect(excludeReason("ID_RSA")).toBe("secret");
    expect(excludeReason("Secrets.YML")).toBe("secret");
    expect(excludeReason("Node_Modules/x/a.js")).toBe("folder");
    expect(excludeReason(".SSH/config")).toBe("secret");
    expect(excludeReason("Build/a.js")).toBe("folder");
    expect(isExcludedDirName("Node_Modules")).toBe(true);
    expect(isExcludedDirName("DerivedData", true)).toBe(true);
  });
  it("データ形式でない secret / credential の名前と asc は読める", () => {
    for (const p of ["src/Credential.java", "credentials.py", "src/Secret.kt", "src/Credentials.ts", "docs/manual.asc", "src/secretary.ts", "environment.ts", "src/.environment"]) {
      expect(excludeReason(p), p).toBeNull();
    }
    for (const p of ["secret.json", "Secrets.yaml", "credentials.toml", "credential.ini", "secrets.txt", "credentials.xml", "secret.properties", "credentials.conf", "secrets.cfg", "secrets", "credentials"]) {
      expect(excludeReason(p), p).toBe("secret");
    }
  });
  it("build・out・target・vendor・pods・deriveddata は根の直下だけ除外する", () => {
    for (const d of ["build", "out", "target", "vendor", "pods", "deriveddata"]) {
      expect(excludeReason(`${d}/a.js`), d).toBe("folder");
      expect(excludeReason(`src/${d}/A.java`), d).toBeNull();
    }
    expect(excludeReason("k8s/pods/a.yaml")).toBeNull();
    expect(excludeReason("src/target/Target.java")).toBeNull();
    expect(excludeReason("src/dist/a.js")).toBe("folder");
  });
  it("中身が秘密鍵のファイルを見分ける", () => {
    expect(looksPrivateKey("x\n-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
    expect(looksPrivateKey("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksPrivateKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(looksPrivateKey("-----BEGIN CERTIFICATE-----")).toBe(false);
    expect(looksPrivateKey("-----BEGIN PUBLIC KEY-----")).toBe(false);
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
