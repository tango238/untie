import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_SOURCES,
  MAX_SOURCE_LABEL_CHARS,
  combineSourceTrees,
  excludeReason,
  isExcludedDirName,
  isMultiSourceTree,
  looksPrivateKey,
  memorySourceTree,
  normalizeTreePath,
  shareFileQuota,
  sourceLabelProblem,
  sourceLabelProblems,
  takeFairly,
  tidySourceLabel,
  treeExcludeReason,
  visibleFiles,
} from "../sourceTree";

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

describe("ソースのラベル", () => {
  it("パスの 1 階層としてそのまま使えるものだけ", () => {
    for (const ok of ["バックエンド", "管理画面", "api", "Front End", "web-1", "a.b", "共通ライブラリ", ".env", "build", "secrets", "dist"]) {
      expect(sourceLabelProblem(ok), ok).toBeNull();
    }
  });
  it("空・空白で始まる/終わる・. ・..・区切り文字・制御文字・長すぎるものは使えない", () => {
    for (const bad of ["", " a", "a ", "\ta", ".", "..", "a/b", "a\\b", "C:x", "a\0b", "a\nb", "~root", "a\u200bb", "x".repeat(MAX_SOURCE_LABEL_CHARS + 1)]) {
      expect(sourceLabelProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    expect(sourceLabelProblem("x".repeat(MAX_SOURCE_LABEL_CHARS))).toBeNull();
    expect(sourceLabelProblem("あ".repeat(MAX_SOURCE_LABEL_CHARS))).toBeNull();
  });
  it("使えるラベルは、normalizeTreePath を 1 階層のまま通る", () => {
    for (const ok of ["バックエンド", "a.b", ".env", "Front End"]) expect(normalizeTreePath(ok)).toEqual({ ok: true, path: ok });
  });
  it("見えない文字・glob の記号を含むラベルを断る。tidySourceLabel はフォルダ名を規則に合う形に整える", () => {
    for (const bad of ["\u00ad", "ab\u00adc", "\u3164", "a\u3164", "\u115f\u1160", "\uffa0", "x\u{e0041}", "a\u200bb", "\u2060", "a\u2800"]) {
      expect(sourceLabelProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    for (const bad of ["a*", "src?", "{a,b}", "a}", "{x"]) expect(sourceLabelProblem(bad), bad).toMatch(/\* \? \{ \}/);
    expect(sourceLabelProblem("バックエンド (本番)")).toBeNull();
    expect(tidySourceLabel("~/work/my-app")).toBe("work my-app");
    expect(tidySourceLabel("a".repeat(60))).toBe("a".repeat(40));
    expect(tidySourceLabel("..hidden*")).toBe("hidden");
    expect(tidySourceLabel("a\u00adb")).toBe("ab");
    expect(tidySourceLabel("***")).toBe("");
    for (const name of ["~home", "x".repeat(50), "a:b/c", "[f]"]) expect(sourceLabelProblem(tidySourceLabel(name)) ?? null, name).toBeNull();
  });
  it("絵文字の間の ZWJ (👨‍👩‍👧) は使える。ZWJ だけ・文字の間の ZWJ・U+034F・孤立したサロゲートは断る", () => {
    for (const ok of ["👨\u200d👩\u200d👧", "家族 👨\u200d👩\u200d👧", "🏳️\u200d🌈", "👩🏽\u200d💻"]) expect(sourceLabelProblem(ok), ok).toBeNull();
    for (const bad of ["\u200d", "a\u200db", "👨\u200d", "\u200d👨", "a\u034fb", "\u034f", "a\ud800b", "\udc00", "x\ud83d"]) {
      expect(sourceLabelProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
    // 整えるときも、絵文字の ZWJ は残し、見えない文字・孤立したサロゲートは取る
    expect(tidySourceLabel("👨\u200d👩\u200d👧")).toBe("👨\u200d👩\u200d👧");
    expect(tidySourceLabel("a\u200db\u034fc\ud800")).toBe("abc");
  });
  it("glob で効かない [ ] と、{} の外では区切りにならない , は、ラベルに使える (「[admin]」)。glob では文字どおり当たる", async () => {
    for (const ok of ["[admin]", "a[1]", "a,b", "管理,画面"]) expect(sourceLabelProblem(ok), ok).toBeNull();
    const { globMatcher } = await import("../sourceTools");
    expect(globMatcher("[admin]/src/**")("[admin]/src/a.ts")).toBe(true);
    expect(globMatcher("[admin]/src/**")("a/src/a.ts")).toBe(false);
    expect(globMatcher("a,b/src/**")("a,b/src/x.ts")).toBe(true);
    expect(tidySourceLabel("[f]")).toBe("[f]");
    const tree = combineSourceTrees([
      { label: "[admin]", tree: memorySourceTree("a", { "src/a.ts": "x" }) },
      { label: "b,c", tree: memorySourceTree("b", { "src/b.ts": "y" }) },
    ]);
    expect(tree.files.map((f) => f.path)).toEqual(["[admin]/src/a.ts", "b,c/src/b.ts"]);
  });
  it("重複は、大文字小文字・全角半角の違いだけでも後ろの行に出す", () => {
    expect(sourceLabelProblems(["API", "管理", "api"])).toEqual([null, null, expect.stringMatching(/1 番目のソースと重なっています/)]);
    expect(sourceLabelProblems(["API", "ＡＰＩ"])[1]).toMatch(/重なっています/);
    expect(sourceLabelProblems(["バックエンド", "フロント"])).toEqual([null, null]);
    expect(sourceLabelProblems(["", "a"])[0]).toMatch(/入力/);
  });
});

describe("combineSourceTrees", () => {
  const back = () => memorySourceTree("api", { "src/routes/orders.ts": "orders\n", "src/db.ts": "db\n", ".env": "S=1", "build/x.js": "b", "build.gradle": "g" });
  const front = () => memorySourceTree("web", { "src/pages/Order.tsx": "page\n", "build/y.js": "b", "src/build/ok.ts": "ok", ".env.local": "S=2" });

  it("各ソースがラベルを名前にした最上位のフォルダになる。読み取りも、ラベルを除いたもとのパスに届く", async () => {
    const t = combineSourceTrees([
      { label: "バックエンド", tree: back() },
      { label: "フロント", tree: front() },
    ]);
    expect(isMultiSourceTree(t)).toBe(true);
    expect(t.files.map((f) => f.path).sort()).toEqual(["バックエンド/build.gradle", "バックエンド/src/db.ts", "バックエンド/src/routes/orders.ts", "フロント/src/build/ok.ts", "フロント/src/pages/Order.tsx"]);
    expect(await t.readFile("フロント/src/pages/Order.tsx")).toBe("page\n");
    await expect(t.readFile("src/pages/Order.tsx")).rejects.toThrow();
    await expect(t.readFile("存在しない/a.ts")).rejects.toThrow();
    expect(t.sources!.map((s) => [s.label, s.folder, s.fileCount])).toEqual([["バックエンド", "api", 3], ["フロント", "web", 2]]);
  });

  it("除外規則はラベルを除いたパスで当てる (ラベルが build・secrets・dist・.env でも、ソース全体が消えない)", () => {
    const t = combineSourceTrees([
      { label: "build", tree: back() },
      { label: "secrets", tree: front() },
      { label: "dist", tree: memorySourceTree("d", { "src/a.ts": "a" }) },
      { label: ".env", tree: memorySourceTree("e", { "src/b.ts": "b" }) },
    ]);
    const visible = visibleFiles(t).map((f) => f.path);
    expect(visible).toContain("build/src/db.ts");
    expect(visible).toContain("secrets/src/pages/Order.tsx");
    expect(visible).toContain("dist/src/a.ts");
    expect(visible).toContain(".env/src/b.ts");
    // もとのソースの除外規則は効く: 各ソースの根の直下の build、.env、.env.local
    expect(visible.some((p) => /\/(\.env|build\/)/.test(p) && !p.includes("src/build/"))).toBe(false);
    expect(visible).toContain("secrets/src/build/ok.ts"); // 根の直下ではない build は読める
    expect(visible).toContain("build/build.gradle");
    // 木の実装が除外し忘れていても (直に files へ入れても)、判定はもとのパスで行う
    expect(treeExcludeReason(t, "secrets/.env.local", 1)).toBe("secret");
    expect(treeExcludeReason(t, "build/build/y.js", 1)).toBe("folder");
    expect(treeExcludeReason(t, "build/src/db.ts", 1)).toBeNull();
    expect(treeExcludeReason(t, "知らないラベル/a.ts", 1)).not.toBeNull();
    // 単純にラベル込みで判定すると、ラベルが build や secrets のソースが全部消える (これを避けている)
    expect(excludeReason("build/src/db.ts")).toBe("folder");
    expect(excludeReason("secrets/src/pages/Order.tsx")).toBe("secret");
  });

  it("ソースが 1 つなら、ラベルがあってもなくても今までの木 (ラベルのフォルダを挟まない)", async () => {
    const one = combineSourceTrees([{ label: "バックエンド", tree: back() }]);
    expect(isMultiSourceTree(one)).toBe(false);
    expect(one.name).toBe("api");
    expect(one.files.map((f) => f.path).sort()).toEqual(back().files.map((f) => f.path).sort());
    expect(visibleFiles(one).map((f) => f.path).sort()).toEqual(["build.gradle", "src/db.ts", "src/routes/orders.ts"]);
    expect(one.sources).toEqual([{ label: "バックエンド", folder: "api", fileCount: 3, truncated: false, depthTruncated: false, trimmed: 0 }]);
    expect(await one.readFile("src/db.ts")).toBe("db\n");
    expect(combineSourceTrees([{ label: "", tree: back() }]).sources![0]!.label).toBe("");
    expect(() => combineSourceTrees([{ label: "a/b", tree: back() }])).toThrow();
  });

  it("ラベルが使えない・重なる・数が合わないときは Error", () => {
    expect(() => combineSourceTrees([])).toThrow();
    expect(() => combineSourceTrees([{ label: "a", tree: back() }, { label: "", tree: front() }])).toThrow(/2 番目のソース/);
    expect(() => combineSourceTrees([{ label: "a", tree: back() }, { label: "A", tree: front() }])).toThrow(/重なっています/);
    const many = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => ({ label: `s${i}`, tree: back() }));
    expect(() => combineSourceTrees(many)).toThrow();
  });

  it("件数の上限はソースで分け合い、1 つのソースが使い切って、ほかが見えなくならない。減らしたソースが分かる", () => {
    const big = memorySourceTree("big", Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, "x"])));
    const small = memorySourceTree("small", { "a.ts": "a", "b.ts": "b" });
    const t = combineSourceTrees([{ label: "大", tree: big }, { label: "小", tree: small }], { maxFiles: 12 });
    expect(t.files).toHaveLength(12);
    expect(t.files.filter((f) => f.path.startsWith("小/"))).toHaveLength(2);
    expect(t.files.filter((f) => f.path.startsWith("大/"))).toHaveLength(10);
    expect(t.truncated).toBe(true);
    expect(t.sources!.find((s) => s.label === "大")).toMatchObject({ fileCount: 10, trimmed: 40, truncated: false });
    expect(t.sources!.find((s) => s.label === "小")).toMatchObject({ fileCount: 2, trimmed: 0, truncated: false });
    // 打ち切り (たどる時点) と減らし (分け合うとき) は別の印。両方に当たるソースは、両方が付く
    const both = combineSourceTrees([{ label: "大", tree: { ...big, truncated: true } }, { label: "小", tree: small }], { maxFiles: 12 });
    expect(both.sources!.find((s) => s.label === "大")).toMatchObject({ truncated: true, trimmed: 40 });
    // もとのソースが打ち切られていたなら、そのソースの印が付く (もとの深さの打ち切りも)
    const cut = combineSourceTrees([{ label: "a", tree: { ...small, truncated: true } }, { label: "b", tree: { ...big, depthTruncated: true } }]);
    expect(cut.sources!.map((s) => [s.truncated, s.depthTruncated])).toEqual([[true, false], [false, true]]);
    expect(cut.truncated).toBe(true);
    expect(cut.depthTruncated).toBe(true);
  });

  it("ソースの中で減らすときは、最上位のフォルダごとに順番に取る (docs が残って src が 0 件にならない)", () => {
    const files = [
      ...Array.from({ length: 30 }, (_, i) => `docs/d${String(i).padStart(2, "0")}.md`),
      ...Array.from({ length: 30 }, (_, i) => `src/s${String(i).padStart(2, "0")}.ts`),
      "README.md",
    ];
    const big = memorySourceTree("big", Object.fromEntries(files.map((f) => [f, "x"])));
    const small = memorySourceTree("small", { "a.ts": "a" });
    const t = combineSourceTrees([{ label: "大", tree: big }, { label: "小", tree: small }], { maxFiles: 13 });
    const kept = t.files.map((f) => f.path).filter((p) => p.startsWith("大/"));
    expect(kept).toHaveLength(12);
    for (const top of ["docs/", "src/"]) expect(kept.filter((p) => p.startsWith(`大/${top}`)).length, top).toBeGreaterThanOrEqual(4);
    expect(kept).toContain("大/README.md");
    expect(takeFairly([{ path: "a/1" }, { path: "a/2" }, { path: "b/1" }], 2).map((f) => f.path)).toEqual(["a/1", "b/1"]);
    expect(takeFairly([{ path: "a/1" }], 5)).toHaveLength(1);
  });

  it("takeFairly: 最上位のフォルダが 1 つだけ (src/ の下に全部) のときは、次の階層で分ける。減らさないときも名前順に揃える", () => {
    const paths = ["src/api/a.ts", "src/api/b.ts", "src/api/c.ts", "src/api/d.ts", "src/web/a.tsx", "src/web/b.tsx", "src/web/c.tsx", "src/web/d.tsx"];
    const kept = takeFairly(paths.map((path) => ({ path })), 4).map((f) => f.path);
    expect(kept.filter((p) => p.startsWith("src/api/"))).toHaveLength(2);
    expect(kept.filter((p) => p.startsWith("src/web/"))).toHaveLength(2);
    expect(kept).toEqual([...kept].sort());
    // さらに 1 つのフォルダの下に全部あれば、もう 1 つ下で分ける
    const deep = ["a/src/x/1", "a/src/x/2", "a/src/y/1", "a/src/y/2"].map((path) => ({ path }));
    expect(takeFairly(deep, 2).map((f) => f.path)).toEqual(["a/src/x/1", "a/src/y/1"]);
    // 根のファイルがあれば、そこで分ける (根のファイルも残る)
    const mixed = ["README.md", "src/a", "src/b", "src/c"].map((path) => ({ path }));
    expect(takeFairly(mixed, 2).map((f) => f.path)).toEqual(["README.md", "src/a"]);
    // 減らさないときも、名前順
    expect(takeFairly(["b", "a/x", "a/w"].map((path) => ({ path })), 10).map((f) => f.path)).toEqual(["a/w", "a/x", "b"]);
    // まとめた木でも効く
    const tree = combineSourceTrees([
      { label: "あ", tree: memorySourceTree("a", Object.fromEntries(paths.map((p) => [p, "x"]))) },
      { label: "い", tree: memorySourceTree("b", { "x.ts": "y" }) },
    ], { maxFiles: 5 });
    const kept2 = tree.files.map((f) => f.path).filter((p) => p.startsWith("あ/"));
    expect(kept2).toHaveLength(4);
    expect(kept2.some((p) => p.startsWith("あ/src/web/"))).toBe(true);
    expect(kept2.some((p) => p.startsWith("あ/src/api/"))).toBe(true);
  });

  it("まとめた木の excludeReasonOf は、中の木の excludeReasonOf があればそれを使う", () => {
    const inner = { ...memorySourceTree("inner", { "x/keep.ts": "a", "x/hide.ts": "b" }), excludeReasonOf: (p: string) => (p.endsWith("hide.ts") ? ("generated" as const) : null) };
    const t = combineSourceTrees([{ label: "A", tree: inner }, { label: "B", tree: memorySourceTree("b", { "b.ts": "b" }) }]);
    expect(treeExcludeReason(t, "A/x/hide.ts", 1)).toBe("generated");
    expect(treeExcludeReason(t, "A/x/keep.ts", 1)).toBeNull();
    expect(t.files.map((f) => f.path)).not.toContain("A/x/hide.ts");
  });

  it("shareFileQuota: 少ないソースはそのまま、余りは多いソースへ回る。合計は上限を超えない", () => {
    expect(shareFileQuota([2, 50], 12)).toEqual([2, 10]);
    expect(shareFileQuota([5, 5], 20)).toEqual([5, 5]);
    expect(shareFileQuota([50, 50, 50], 10).reduce((a, b) => a + b, 0)).toBe(10);
    expect(shareFileQuota([50, 50, 50], 10).every((n) => n >= 3)).toBe(true);
    expect(shareFileQuota([0, 9], 5)).toEqual([0, 5]);
    expect(shareFileQuota([100], 7)).toEqual([7]);
  });
});
