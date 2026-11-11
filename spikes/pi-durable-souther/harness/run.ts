// Pi Durable の実行基盤を、台本どおりに答えるモデル (faux) で動かす。
//   node run.ts full    … はじめから終わりまで
//   node run.ts crash   … テストの実行中に、プロセスを強制終了する (落ちたことにする)
//   node run.ts resume  … 同じストレージを開き直して、続きから終わらせる
//   node run.ts llm     … 本物の LLM (Anthropic。ANTHROPIC_API_KEY が要る) に、task.md の依頼を渡す。モデルは MODEL (既定は claude-sonnet-5-5)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { AssistantEntry, createRegistry, defineExtension, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
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
        if (mode === "llm") {
          const args = (call.arguments ?? {}) as { path?: string; command?: string };
          const outside = (path: string) => (path.startsWith("/") && !path.startsWith(`${workspace}/`)) || path.split("/").includes("..") || path.startsWith("~");
          if (typeof args.path === "string" && outside(args.path)) return { block: "作業フォルダの外のファイルには触れられません。相対パスで、作業フォルダの中のファイルを指してください" };
          if (typeof args.command === "string" && /(^|[\s"'=:])(\/root|\/home|\/etc|~\/|\$HOME)|\.claude|anthropic-key|\bsudo\b|git\s+push|\bssh\b|\benv\b|printenv/.test(args.command)) {
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
  ],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Project);

const harness = await Harness.open(
  await openNodeSqliteStorage(storagePath),
  {
    models,
    registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace, shellEnv }),
    onReport: (report) => log("report", report.kind, String(report.error ?? "").slice(0, 300)),
  },
  context,
);
const root = await harness.root(context, {
  agent: { model: agentModel, cwd: workspace, maxTurns: mode === "llm" ? 120 : 40, ...(mode === "llm" ? { thinkingLevel: "medium" as const } : {}) },
});

let submission;
if (mode === "resume") {
  const id = JSON.parse(readFileSync(submissionFile, "utf8"));
  log("ストレージを開き直しました。前の依頼:", id);
  harness.resume();
  submission = (await harness.submission(id, context))!;
} else {
  const content =
    mode === "llm"
      ? readFileSync(new URL("./task.md", import.meta.url), "utf8")
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
log("app/ ができているか:", existsSync(`${workspace}/app/src/app.ts`));
await harness.close(context);
