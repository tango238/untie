// Pi Durable の実行基盤を、台本どおりに答えるモデル (faux) で動かす。
//   node run.ts full    … はじめから終わりまで
//   node run.ts crash   … テストの実行中に、プロセスを強制終了する (落ちたことにする)
//   node run.ts resume  … 同じストレージを開き直して、続きから終わらせる
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
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

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses(mode === "resume" ? RESUME_SCRIPT : FULL_SCRIPT);

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
    env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
    onReport: (report) => log("report", report.kind, String(report.error ?? "").slice(0, 300)),
  },
  context,
);
const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, cwd: workspace, maxTurns: 40 } });

let submission;
if (mode === "resume") {
  const id = JSON.parse(readFileSync(submissionFile, "utf8"));
  log("ストレージを開き直しました。前の依頼:", id);
  harness.resume();
  submission = (await harness.submission(id, context))!;
} else {
  submission = await root.submit({ type: "input", content: "design/design.md の設計から、予約の操作 (確定・取消・チェックイン) の HTTP API を app/ に作り、テストで確かめてください。" }, context);
  writeFileSync(submissionFile, JSON.stringify(submission.id));
  log("依頼を受け付けました:", submission.id);
}

const settled = await submission.wait(context);
log("結果:", settled.status, "reason" in settled ? settled.reason : "");
if (settled.status === "done" && settled.type === "input") {
  const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  log("最後の答え:", JSON.stringify(answer?.model?.[0]).slice(0, 300));
}
const usage = await harness.usage?.(context).catch(() => undefined);
if (usage) log("usage:", JSON.stringify(usage).slice(0, 200));
log("app/ ができているか:", existsSync(`${workspace}/app/src/app.ts`));
await harness.close(context);
