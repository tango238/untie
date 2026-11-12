// 「実装を開始する」の流れを、手元の Node で一続きに動かす。
//
//   node start.ts --model <モデルの JSON | sample:<サンプルの id>> --system <システムの id> --out <空のフォルダ>
//                 [--allow-unready] [--agent llm|replay|none] [--replay-from <記録のフォルダ>]
//
//   1. 準備   … 実装を始める準備がそろっているかを確かめる。そろっていなければ、残りを挙げて止まる (--allow-unready は、検証のための抜け道)
//   2. 材料   … その時点のモデルから、設計書・業務ルール (Souther)・受け入れテスト・土台を作って、作業フォルダに置く (本体の planBuild)
//   3. 依存   … 土台のパッケージを入れる (エージェントのシェルにはネットワークが無いので、前もって)
//   4. モデル … 業務ルールを Souther で WebAssembly にし、TypeScript の呼び出しコードを作る (JDK 25 と souther が要る。SOUTHER_BIN)
//   5. 実装   … Pi Durable のエージェントに依頼する (run.ts)。「できた」と答えるたびに、外で検査を流し、落ちたら差し戻す
//   6. 判定   … 最後の検査の結果で、受け入れるかを決める (エージェントの答えでは決めない)
//
// --agent llm    … 本物の LLM (ANTHROPIC_API_KEY が要る。API の利用料がかかる)
// --agent replay … 前に本物の LLM が書いたもの (--replay-from の app/ と acceptance/driver.ts) を、台本として書かせる (API キーなしで、流れを確かめる)
// --agent none   … 4 まで (材料を用意するだけ)
//
// 終了コード: 0 受け入れ / 1 検査を通らなかった・途中で失敗した / 2 準備がそろっていないので始めなかった
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

/** 本体の関数のうち、ここで使う分の形 (本体の型は、まとめたあとの JavaScript からは引けないので、要るところだけ書く) */
interface Plan {
  systemId: string;
  system: string;
  ready: boolean;
  remaining: number;
  operations: string[];
  readiness: { doneCount: number; conditions: { title: string; done: boolean; items: { message: string }[] }[] };
  files: { path: string; text: string }[];
  protectedPaths: string[];
  model: { source: string; wasm: string; bindings: string; moduleName: string } | null;
  acceptanceCases: number;
  checks: { name: string; command: string }[];
  task: string;
}
interface Core {
  SAMPLES: { id: string; create(): unknown }[];
  loadModelJson(json: unknown): { ok: true; model: unknown } | { ok: false; errors: string[] };
  planBuild(model: unknown, systemId: string): Plan;
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    system: { type: "string" },
    out: { type: "string" },
    "allow-unready": { type: "boolean", default: false },
    agent: { type: "string", default: "llm" },
    "replay-from": { type: "string" },
  },
});
const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};
if (!args.model || !args.system || !args.out) fail("使い方: node start.ts --model <モデルの JSON | sample:<id>> --system <システムの id> --out <空のフォルダ> [--allow-unready] [--agent llm|replay|none] [--replay-from <フォルダ>]");
if (!["llm", "replay", "none"].includes(args.agent!)) fail(`--agent は llm・replay・none のどれかです: ${args.agent}`);
if (args.agent === "replay" && !args["replay-from"]) fail("--agent replay には、--replay-from <記録のフォルダ> が要ります");
const out = resolve(args.out!);
const step = (n: number, title: string) => console.log(`\n[${n}/6] ${title}`);
const run = (command: string, argv: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string } = {}): number => {
  const fd = options.log ? openSync(options.log, "w") : undefined;
  const result = spawnSync(command, argv, { cwd: options.cwd, env: options.env ?? process.env, stdio: fd === undefined ? "inherit" : ["ignore", fd, fd] });
  if (fd !== undefined) closeSync(fd);
  return result.status ?? 1;
};

// ---- 本体 (packages/core) の関数を読み込む。TypeScript のまま Node からは読めないので、esbuild で 1 つにまとめる
const esbuild = createRequire(realpathSync(join(repo, "node_modules/vite/package.json")))("esbuild") as { build(options: Record<string, unknown>): Promise<unknown> };
const bundle = join(here, ".cache/plan.mjs");
await esbuild.build({ entryPoints: [join(here, "plan-entry.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "error" });
const core = (await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`)) as Core;

// ---- モデルを読む
let model: unknown;
if (args.model!.startsWith("sample:")) {
  const sample = core.SAMPLES.find((s) => s.id === args.model!.slice("sample:".length));
  if (!sample) fail(`サンプルがありません: ${args.model} (あるもの: ${core.SAMPLES.map((s) => s.id).join("・")})`);
  model = sample!.create();
} else {
  const loaded = core.loadModelJson(JSON.parse(readFileSync(resolve(args.model!), "utf8")));
  if (!loaded.ok) fail(`モデルを読めません:\n${loaded.errors.join("\n")}`);
  else model = loaded.model;
}

// ---- 1. 準備
step(1, "準備: 実装を始める準備がそろっているか");
const plan = core.planBuild(model, args.system!);
console.log(`対象: ${plan.system} (${plan.systemId})。作る操作 ${plan.operations.length} 個`);
for (const c of plan.readiness.conditions) {
  console.log(`  ${c.done ? "✓" : "○"} ${c.title}${c.done ? "" : ` (残り ${c.items.length} 件)`}`);
  for (const item of c.items) console.log(`      - ${item.message}`);
}
if (!plan.ready && !args["allow-unready"]) {
  fail(`\n始めません: 準備がそろっていません (条件 ${plan.readiness.doneCount} / ${plan.readiness.conditions.length}。決めることが残り ${plan.remaining} 件)。設計で決めてから、やり直してください。`, 2);
}
if (!plan.ready) console.log(`\n注意: 準備がそろっていませんが、--allow-unready なので続けます (検証のため。残り ${plan.remaining} 件は、作る範囲の外として依頼します)`);

// ---- 2. 材料
step(2, "材料: 設計書・業務ルール・受け入れテスト・土台を、作業フォルダに置く");
if (existsSync(out) && readdirSync(out).length > 0) fail(`書き出し先が空ではありません: ${out} (空のフォルダを指してください)`);
const workspace = join(out, "workspace");
const materials = join(out, "materials"); // 書き換えさせないものの元 (完了の検査の前に、ここから置き直す)
for (const file of plan.files) {
  for (const base of [workspace, materials]) {
    mkdirSync(dirname(join(base, file.path)), { recursive: true });
    writeFileSync(join(base, file.path), file.text);
  }
  console.log(`  ${file.path}`);
}
writeFileSync(join(out, "plan.json"), `${JSON.stringify({ systemId: plan.systemId, system: plan.system, ready: plan.ready, remaining: plan.remaining, task: plan.task, protectedPaths: plan.protectedPaths, checks: plan.checks, model: plan.model }, null, 2)}\n`);
writeFileSync(join(out, "task.md"), plan.task);
console.log(`受け入れテストのケース: ${plan.acceptanceCases} 件`);

// ---- 3. 依存
step(3, "依存: 土台のパッケージを入れる");
if (run("npm", ["install", "--no-audit", "--no-fund"], { cwd: workspace, log: join(out, "npm-install.log") }) !== 0) fail(`npm install が失敗しました (${join(out, "npm-install.log")})`);
console.log("  入れました");

// ---- 4. モデル
step(4, "モデル: 業務ルールを WebAssembly にする");
if (!plan.model) {
  console.log("  このシステムには、前提の状態も条件も無いので、業務ルールのモデルはありません");
} else {
  const log = join(out, "build-model.log");
  const code = run(join(here, "../build-model.sh"), [join(workspace, plan.model.source), join(workspace, plan.model.wasm), join(workspace, plan.model.bindings), join(workspace, "node_modules/.bin/souther-wasm-bindings")], { log });
  if (code !== 0) fail(`業務ルールのモデルを作れませんでした (${log})。JDK 25 と souther が要ります (SOUTHER_BIN)`);
  for (const path of [plan.model.wasm, plan.model.bindings]) {
    mkdirSync(dirname(join(materials, path)), { recursive: true });
    cpSync(join(workspace, path), join(materials, path));
    console.log(`  ${path}`);
  }
  console.log(`  ${readFileSync(log, "utf8").split("\n").find((l) => l.startsWith("adequacy")) ?? ""}`);
}
if (args.agent === "none") {
  console.log(`\n材料を用意しました: ${workspace}\n(--agent none なので、実装は始めません)`);
  process.exit(0);
}

// ---- 5. 実装
step(5, `実装: エージェントに依頼する (${args.agent === "llm" ? `本物の LLM: ${process.env.MODEL ?? "claude-sonnet-5-5"}` : "記録の再生"})`);
if (args.agent === "llm" && !process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY がありません");
const storage = join(out, "run.sqlite");
const runLog = join(out, "run.log");
const code = run(process.execPath, [join(here, "run.ts"), args.agent!], {
  cwd: here,
  env: { ...process.env, WORKSPACE: workspace, STORAGE: storage, PRISTINE: materials, PLAN: join(out, "plan.json"), ...(args["replay-from"] ? { REPLAY_FROM: resolve(args["replay-from"]) } : {}) },
  log: runLog,
});
for (const line of readFileSync(runLog, "utf8").split("\n")) if (/完了の検査|置き直したもの|結果:/.test(line)) console.log(`  ${line.slice(0, 260)}`);
if (code !== 0) fail(`実行基盤が失敗しました (終了コード ${code}。${runLog})`);

// ---- 6. 判定
step(6, "判定: 最後の検査の結果で決める");
const gate = JSON.parse(readFileSync(`${storage}.gate.json`, "utf8")) as { accepted: boolean; gateRuns: number; checks: unknown[] };
const verdict = { systemId: plan.systemId, system: plan.system, ready: plan.ready, remaining: plan.remaining, allowUnready: args["allow-unready"], agent: args.agent, accepted: gate.accepted, gateRuns: gate.gateRuns, checks: gate.checks };
writeFileSync(join(out, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(gate.accepted ? `受け入れ: 検査を通りました (検査 ${gate.gateRuns} 回)` : `受け入れない: 検査を通っていません (検査 ${gate.gateRuns} 回)`);
if (!plan.ready) console.log(`ただし、準備がそろっていないまま始めています (残り ${plan.remaining} 件)。出来上がったものは、検証のためのものです`);
console.log(`出来上がったもの: ${join(workspace, "app")}\n判定の記録: ${join(out, "verdict.json")}`);
process.exit(gate.accepted ? 0 : 1);
