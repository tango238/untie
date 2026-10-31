// プロンプト (初期要望) からモデルを作る。段階を踏んで分析し、最後にモデル全体を submit_model で受け取って組み立てる。
// 組み立てた結果を検査し、問題があれば AI に返して直してもらう。
import { traceToActors } from "@untie/core/model/trace";
import { validateModel } from "@untie/core/model/validate";
import { ELEMENT_KIND_LABELS, type ElementKind } from "@untie/core/model/types";
import { createChatSession, ChatError, type SeedTurn } from "./chat";
import { analysisRequest, generationSystemPrompt, SUBMIT_REQUEST } from "./prompts";
import type { ProviderId } from "./providers";
import { buildModelFromSpec, SUBMIT_MODEL_TOOL, type BuildResult, type ModelSpec } from "./spec";
import type { ToolOutcome } from "./tools";

export type GenerationStep = "analysis" | "model" | "done";

export interface GenerationOptions {
  provider: ProviderId;
  model: string;
  apiKey: string;
  signal?: AbortSignal;
  onStep?: (step: GenerationStep) => void;
  /** 分析の文章が届いたとき */
  onText?: (delta: string) => void;
  /** 提出と検査の結果 */
  onSubmit?: (accepted: boolean, message: string) => void;
}

export interface GenerationResult {
  build: BuildResult;
  analysis: string;
  /** このあとエージェントの会話に引き継ぐ履歴 */
  seed: SeedTurn[];
  summary: string;
}

/** 提出を受け付ける回数の目安。これを超えたら、気づいたことが残っていても受け付ける */
const STRICT_ATTEMPTS = 2;

export function summarizeCounts(counts: BuildResult["counts"]): string {
  const order: ElementKind[] = ["business", "buc", "activity", "usecase", "actor", "externalActor", "system", "ledger", "context", "information", "state", "condition", "variation", "issue"];
  return order
    .filter((k) => counts[k])
    .map((k) => `${ELEMENT_KIND_LABELS[k]} ${counts[k]}`)
    .join("、");
}

export async function generateFromPrompt(request: string, o: GenerationOptions): Promise<GenerationResult> {
  let accepted: BuildResult | null = null;
  let attempts = 0;

  const runTool = (name: string, input: unknown): ToolOutcome => {
    if (name !== "submit_model") return { ok: false, content: JSON.stringify({ error: `不明な道具です: ${name}` }), changed: false };
    attempts++;
    const spec = input as ModelSpec;
    if (!spec || typeof spec !== "object" || !Array.isArray(spec.businesses)) {
      return { ok: false, content: JSON.stringify({ error: "businesses の一覧が必要です" }), changed: false };
    }
    const build = buildModelFromSpec(spec);
    const validation = validateModel(JSON.parse(JSON.stringify(build.model)));
    if (!validation.ok) {
      return { ok: false, content: JSON.stringify({ error: "モデルの検査で問題がありました", details: validation.errors.slice(0, 20) }), changed: false };
    }
    // 担い手まで辿れない要素 (担当の無い作業など) も直してもらう
    const trace = traceToActors(build.model).problems.filter((p) => p.isBreak);
    const byId = new Map(build.model.elements.map((e) => [e.id, e]));
    const issues = [
      ...build.warnings,
      ...trace.map((p) => {
        const e = byId.get(p.elementId)!;
        return `${ELEMENT_KIND_LABELS[e.kind]}「${e.name}」: ${p.reason}`;
      }),
    ];
    if (issues.length > 0 && attempts <= STRICT_ATTEMPTS) {
      const message = `次の点を直して、モデル全体をもう一度提出してください:\n- ${issues.slice(0, 30).join("\n- ")}`;
      o.onSubmit?.(false, message);
      return { ok: false, content: JSON.stringify({ error: message }), changed: false };
    }
    accepted = build;
    const message = `受け付けました: ${summarizeCounts(build.counts)}${issues.length > 0 ? ` (気づいたこと ${issues.length} 件は残っています)` : ""}`;
    o.onSubmit?.(true, message);
    return { ok: true, content: JSON.stringify({ result: message }), changed: true };
  };

  const session = createChatSession(o.provider, {
    apiKey: o.apiKey,
    model: o.model,
    system: generationSystemPrompt(),
    tools: [SUBMIT_MODEL_TOOL],
    runTool,
  });

  o.onStep?.("analysis");
  const analysis = await session.send(analysisRequest(request), { onText: o.onText }, o.signal);
  o.onStep?.("model");
  await session.send(SUBMIT_REQUEST, {}, o.signal);
  if (!accepted) {
    // 提出せずに終わったら、もう一度だけ頼む
    await session.send("submit_model でモデル全体を提出してください。", {}, o.signal);
  }
  const build = accepted as BuildResult | null;
  if (!build) throw new ChatError("AI がモデルを提出しませんでした。初期要望を具体的にして、もう一度試してください。");
  o.onStep?.("done");

  const summary = `初期要望からモデル「${build.model.meta.name}」を作成しました (${summarizeCounts(build.counts)})。${
    build.warnings.length > 0 ? `組み立てで気づいたこと: ${build.warnings.slice(0, 5).join(" / ")}` : ""
  }`;
  return {
    build,
    analysis,
    summary,
    seed: [
      { role: "user", text: `次の初期要望から業務モデルを作ってください。\n\n<初期要望>\n${request}\n</初期要望>` },
      { role: "assistant", text: `${analysis}\n\n${summary}` },
    ],
  };
}
