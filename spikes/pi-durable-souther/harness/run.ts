// Pi Durable の実行基盤を、台本どおりに答えるモデル (faux) で動かす。
//   node run.ts full    … はじめから終わりまで
//   node run.ts crash   … テストの実行中に、プロセスを強制終了する (落ちたことにする)
//   node run.ts resume  … 同じストレージを開き直して、続きから終わらせる
//   node run.ts gate    … 完了の検査だけを流す (WORKSPACE の出来上がったものを、外で確かめ直す)
//   node run.ts llm     … 本物の LLM (Anthropic。ANTHROPIC_API_KEY が要る) に、task.md の依頼を渡す。モデルは MODEL (既定は claude-sonnet-5-5)
//                         TASK で依頼文を差し替え、CRASH_AFTER=N で N 回めのツールの実行中に強制終了、RESUME=1 で同じストレージの続きから
//                         エージェントのシェルは sandbox-shell.sh で隔離し、「できた」と答えるたびに、外で受け入れテストとアプリのテストを流す (完了の検査)
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { AssistantEntry, createRegistry, defineExtension, GenerationTask, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { FULL_SCRIPT, RESUME_SCRIPT, TEST_COMMAND } from "./script.ts";

const mode = process.argv[2] ?? "full";
const workspace = process.env.WORKSPACE ?? new URL("../workspace", import.meta.url).pathname;
const storagePath = process.env.STORAGE ?? new URL("../run.sqlite", import.meta.url).pathname;
const submissionFile = `${storagePath}.submission`;
const context = BACKGROUND_CONTEXT;
const log = (...args: unknown[]) => console.log(`[${mode}]`, ...args);
const started = Date.now();

const models = createModels();
let agentModel: { provider: string; modelId: string };
if (mode === "llm") {
  // 本物の LLM。キーは、このプロセスの環境変数からだけ読む (ファイルにも、エージェントのシェルにも渡さない)
  models.setProvider(anthropicProvider());
  agentModel = { provider: "anthropic", modelId: process.env.MODEL ?? "claude-sonnet-5-5" };
} else {
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  faux.setResponses(mode === "resume" ? RESUME_SCRIPT : FULL_SCRIPT);
  agentModel = { provider: model.provider, modelId: model.id };
}

/**
 * エージェントのシェルに渡す環境変数。NodeExecutionEnv は、shellEnv をこのプロセスの環境変数に重ねて渡す (親のものがそのまま見える)。
 * API キーや、この機械のほかの資格情報 (GitHub・クラウドのトークンなど) がシェルから読めないよう、許したもの以外は空にして渡す
 */
const SHELL_ENV_ALLOW = new Set(["PATH", "LANG", "LC_ALL", "TERM", "TMPDIR", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "SSL_CERT_FILE", "npm_config_https_proxy", "npm_config_noproxy", "NPM_CONFIG_USERCONFIG"]);
export const shellEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).filter((k) => !SHELL_ENV_ALLOW.has(k)).map((k) => [k, ""]));
shellEnv.HOME = `${workspace}/.home`;
shellEnv.UNTIE_SANDBOX_WORKSPACE = workspace;

/** エージェントのシェルを隔離するスクリプト (本物の LLM のときに使う)。作業フォルダの外は見えず、ネットワークも無い */
const sandboxShell = new URL("./sandbox-shell.sh", import.meta.url).pathname;
const sandboxed = mode === "llm" && process.env.SANDBOX !== "off";
/** 本物の LLM のときに、落ちたことにする: この回数めのツールが動き出したあとで、後始末なしに終了する */
const crashAfter = mode === "llm" ? Number(process.env.CRASH_AFTER ?? 0) : 0;
const resuming = mode === "resume" || (mode === "llm" && process.env.RESUME === "1");
let toolCalls = 0;

/**
 * シンボリックリンクをたどると、作業フォルダの外に出るか。
 * 隔離したシェルの中でリンクを作り、read・write (隔離の外で動く) に渡して、外のファイルに触れるのを防ぐ
 */
function escapesWorkspace(path: string): boolean {
  const root = realpathSync(workspace);
  let current = resolve(workspace, path);
  // まだ無いファイルは、いちばん近い、あるもの (リンクも含む) まで上がって確かめる
  while (current !== "/" && !lstatSync(current, { throwIfNoEntry: false })) current = dirname(current);
  try {
    const real = realpathSync(current);
    return real !== root && !real.startsWith(`${root}/`);
  } catch {
    return true; // 行き先の無いリンク
  }
}

// ---- 完了の検査 ----
// エージェントが「できた」と答えても、それだけでは完了にしない。実行基盤の側で、
//   1. 書き換えさせないもの (設計・業務ルールのモデル・受け入れテスト) を、元に戻す
//   2. 受け入れテスト (untie が設計から作ったもの) と、アプリのテストを、隔離の中で流す
// 落ちたら、結果を渡して続けさせる (GATE_MAX 回まで)。

/** 書き換えさせないものの元 (design/・model/・acceptance/ を持つフォルダ)。既定は、リポジトリの workspace/ */
const pristine = process.env.PRISTINE ?? new URL("../workspace", import.meta.url).pathname;
const PROTECTED_DIRS = ["design", "model", "acceptance"];
const GATE_MAX = 3;
const GATE_CHECKS = [
  { name: "受け入れテスト", command: "node --test acceptance/run.test.ts" },
  { name: "アプリのテスト", command: "npm test" },
];

interface GateCheck {
  name: string;
  command: string;
  exit: number | null;
  tests: number;
  pass: number;
  fail: number;
  ok: boolean;
  output: string;
}
interface GateResult {
  restored: string[];
  checks: GateCheck[];
  ok: boolean;
}
const gateHistory: GateResult[] = [];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** 書き換えさせないものを、元に戻す。置き直したファイル (無かった・書き換えられていた・消されていたもの) を返す */
function restoreProtected(): string[] {
  const restored: string[] = [];
  for (const dir of PROTECTED_DIRS) {
    for (const source of filesUnder(join(pristine, dir))) {
      const path = relative(pristine, source);
      const target = join(workspace, path);
      const original = readFileSync(source);
      if (existsSync(target) && readFileSync(target).equals(original)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, original);
      restored.push(path);
    }
  }
  return restored;
}

/** node:test の出力の終わりの集計 (# pass 3 / ℹ pass 3) を読む */
const count = (output: string, key: string): number => Number(output.match(new RegExp(`^(?:#|ℹ) ${key} (\\d+)`, "m"))?.[1] ?? 0);

/** 落ちたテストのまわりと、終わりの集計だけを残す (モデルに渡す分) */
function failureExcerpt(output: string): string {
  if (output.length <= 6000) return output;
  const lines = output.split("\n");
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (/^\s*(not ok|✖)/.test(line)) for (let k = i; k < Math.min(lines.length, i + 14); k++) keep.add(k);
  });
  for (let k = Math.max(0, lines.length - 14); k < lines.length; k++) keep.add(k);
  return [...keep]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join("\n")
    .slice(0, 6000);
}

function runGate(): GateResult {
  const restored = restoreProtected();
  const checks = GATE_CHECKS.map(({ name, command }): GateCheck => {
    // エージェントが書いたコードを動かすので、検査も隔離の中で流す。環境変数は、隔離のスクリプトが決まったものだけにする
    const run = spawnSync(sandboxShell, ["-c", command], {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "", UNTIE_SANDBOX_WORKSPACE: workspace },
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    const [tests, pass, fail] = [count(output, "tests"), count(output, "pass"), count(output, "fail")];
    return { name, command, exit: run.status, tests, pass, fail, ok: run.status === 0 && fail === 0 && pass > 0, output };
  });
  const result = { restored, checks, ok: checks.every((c) => c.ok) };
  gateHistory.push(result);
  log(`完了の検査 (${gateHistory.length} 回め):`, result.ok ? "通った" : "落ちた", JSON.stringify(checks.map((c) => ({ name: c.name, exit: c.exit, tests: c.tests, pass: c.pass, fail: c.fail }))));
  if (restored.length > 0) log("  無かった・書き換えられていたので、置き直したもの:", restored.join(", "));
  return result;
}

/** 検査が落ちたときに、エージェントに返す文 */
function gateFeedback(result: GateResult): string {
  const lines = ["実行基盤が、あなたの外で検査を実行しました。まだ完了ではありません。次を直して、もう一度「できた」と答えてください。", ""];
  if (result.restored.length > 0) lines.push(`- 次のファイルが無いか、変わっていたので、元のものを置き直しました (書き換えないでください): ${result.restored.join(", ")}`, "");
  for (const check of result.checks) {
    if (check.ok) {
      lines.push(`- ${check.name} (\`${check.command}\`): 通りました (${check.pass} 件)`);
    } else {
      lines.push(`- ${check.name} (\`${check.command}\`): 落ちました (終了コード ${check.exit}、${check.tests} 件のうち ${check.fail} 件が失敗${check.pass === 0 ? "、通ったテストが 1 件もありません" : ""})`, "", "```", failureExcerpt(check.output), "```");
    }
  }
  return lines.join("\n");
}

// 実装するエージェントへの指示 (AGENTS.md に当たるもの)。Pi Durable は AGENTS.md を自分では読まないので、ここで渡す
const Project = defineExtension({
  name: "untie-project",
  sections: [
    section(
      "untie",
      () =>
        [
          "You implement an application from a design exported by Untie.",
          "Read design/design.md first. Business rules are a Souther model compiled to WebAssembly in model/pms.wasm with TypeScript bindings in model/pms.ts.",
          "Never re-implement a business rule in application code: call the model. Write the application under app/ and prove it with tests.",
        ].join("\n"),
      { tag: false },
    ),
  ],
  hooks: [
    hook(ToolTask, {
      beforeTool: (call) => {
        log(`tool ${call.name}`, JSON.stringify(call.arguments ?? {}).slice(0, 110));
        // 本物の LLM のときの歯止め: 作業フォルダの外のファイルと、この機械の設定・資格情報に触れさせない。
        // これは検証のための簡単な歯止めで、隔離ではない。本番では、会話ごとのコンテナに閉じ込める
        if (crashAfter > 0 && ++toolCalls === crashAfter) {
          setTimeout(() => {
            log(`プロセスを強制終了します (SIGKILL。${crashAfter} 回めのツールの実行中)`);
            process.kill(process.pid, "SIGKILL");
          }, 400);
        }
        if (mode === "llm") {
          const args = (call.arguments ?? {}) as { path?: string; command?: string };
          // read・write・edit は、隔離したシェルを通らないので、パスで断る
          const outside = (path: string) => (path.startsWith("/") && !path.startsWith(`${workspace}/`)) || path.split("/").includes("..") || path.startsWith("~");
          if (typeof args.path === "string" && (outside(args.path) || escapesWorkspace(args.path))) return { block: "作業フォルダの外のファイルには触れられません。相対パスで、作業フォルダの中のファイルを指してください" };
          // シェルを隔離していないときだけの、簡単な歯止め (隔離しているときは、外がそもそも見えない)
          if (!sandboxed && typeof args.command === "string" && /(^|[\s"'=:])(\/root|\/home|\/etc|~\/|\$HOME)|\.claude|anthropic-key|\bsudo\b|git\s+push|\bssh\b|\benv\b|printenv/.test(args.command)) {
            return { block: "このコマンドは、作業フォルダの外か、この機械の設定に触れるので実行しません。作業フォルダの中だけで済む形にしてください" };
          }
        }
        // 落ちたことにする: テストのコマンドが動き出したあとで、後始末なしに終了する
        if (mode === "crash" && call.name === "bash" && (call.arguments as { command?: string })?.command === TEST_COMMAND) {
          setTimeout(() => {
            log("プロセスを強制終了します (SIGKILL)");
            process.kill(process.pid, "SIGKILL");
          }, 400);
        }
        return undefined;
      },
      // ツールの結果 (モデルに返るもの) の終わりのほうを、記録に出す
      afterTool: (call, result) => {
        const text = JSON.stringify((result as { output?: unknown }).output ?? result);
        log(`  → ${call.name} の結果:`, text.length > 260 ? `…${text.slice(-260)}` : text);
        log("  経過:", `${Math.round((Date.now() - started) / 1000)} 秒`);
        return undefined;
      },
    }),
    // 完了の検査: 最後の答えが出るたびに、外で検査を流す。落ちたら、結果を渡して続けさせる
    hook(GenerationTask, {
      onYield: () => {
        if (mode !== "llm") return undefined;
        const result = runGate();
        if (result.ok) return undefined;
        if (gateHistory.length >= GATE_MAX) {
          log(`完了の検査が ${GATE_MAX} 回落ちたので、続けさせずに終えます (完了とは扱わない)`);
          return undefined;
        }
        return { continue: gateFeedback(result) };
      },
    }),
  ],
});

// 検査だけを流す (出来上がったものを、あとから外で確かめ直すとき)
if (mode === "gate") {
  const result = runGate();
  if (!result.ok) console.log(gateFeedback(result));
  process.exit(result.ok ? 0 : 1);
}

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Project);

const harness = await Harness.open(
  await openNodeSqliteStorage(storagePath),
  {
    models,
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace, shellEnv, ...(sandboxed ? { shellPath: sandboxShell } : {}) }),
    onReport: (report) => log("report", report.kind, String(report.error ?? "").slice(0, 300)),
  },
  context,
);
const root = await harness.root(context, {
  agent: { model: agentModel, cwd: workspace, maxTurns: mode === "llm" ? 120 : 40, ...(mode === "llm" ? { thinkingLevel: "medium" as const } : {}) },
});

let submission;
if (resuming) {
  const id = JSON.parse(readFileSync(submissionFile, "utf8"));
  log("ストレージを開き直しました。前の依頼:", id);
  harness.resume();
  submission = (await harness.submission(id, context))!;
} else {
  const content =
    mode === "llm"
      ? readFileSync(process.env.TASK ?? new URL("./task.md", import.meta.url), "utf8")
      : "design/design.md の設計から、予約の操作 (確定・取消・チェックイン) の HTTP API を app/ に作り、テストで確かめてください。";
  submission = await root.submit({ type: "input", content }, context);
  writeFileSync(submissionFile, JSON.stringify(submission.id));
  log("依頼を受け付けました:", submission.id);
}

const settled = await submission.wait(context);
log("結果:", settled.status, "reason" in settled ? settled.reason : "");
if (settled.status === "done" && settled.type === "input") {
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  log("最後の答え:", JSON.stringify(answer?.model?.[0]).slice(0, mode === "llm" ? 4000 : 300));
}
const usage = await harness.usage?.(context).catch(() => undefined);
if (usage) log("usage:", JSON.stringify(usage).slice(0, 600));
if (mode === "llm") {
  // 判定は、エージェントの答えではなく、最後の検査の結果で決める
  const last = gateHistory.at(-1);
  const verdict = { accepted: last?.ok === true, gateRuns: gateHistory.length, checks: gateHistory.map((g) => ({ ok: g.ok, restored: g.restored, checks: g.checks.map(({ output, ...c }) => c) })) };
  writeFileSync(`${storagePath}.gate.json`, `${JSON.stringify(verdict, null, 2)}\n`);
  log("判定:", verdict.accepted ? "受け入れ (検査を通った)" : "受け入れない (検査を通っていない)", `検査 ${verdict.gateRuns} 回`);
}
log("app/ ができているか:", existsSync(`${workspace}/app`));
await harness.close(context);
