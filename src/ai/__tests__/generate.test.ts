// プロンプトからの作成: AI の会話を偽物にして、分析 → 提出 → 検査 → 出し直し の流れを確かめる。
import { describe, expect, it, vi } from "vitest";
import type { ChatOptions } from "../chat";
import type { ModelSpec } from "../spec";

const scripted = vi.hoisted(() => ({ specs: [] as unknown[], sent: [] as string[], results: [] as { ok: boolean; content: string }[] }));

vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_provider: string, o: ChatOptions) => ({
      seed: () => {},
      send: async (text: string, events?: { onText?: (d: string) => void }) => {
        scripted.sent.push(text);
        if (scripted.sent.length === 1) {
          events?.onText?.("分析の結果");
          return "分析の結果";
        }
        // 提出の依頼には、用意した下書きを順に出す (検査で返されたら次のを出す)
        while (scripted.specs.length > 0) {
          const r = await o.runTool("submit_model", scripted.specs.shift());
          scripted.results.push(r);
          if (r.ok) break;
        }
        return "提出しました";
      },
    }),
  };
});

const { generateFromPrompt } = await import("../generate");

const good: ModelSpec = {
  system_name: "旅館",
  actors: [{ name: "フロント係" }],
  businesses: [{ name: "予約受付", main_actors: ["フロント係"], activities: [{ name: "予約を受け付ける", performers: ["フロント係"], usecases: [{ name: "予約を登録する" }] }] }],
};
const noPerformer: ModelSpec = {
  ...good,
  businesses: [{ name: "予約受付", main_actors: ["フロント係"], activities: [{ name: "予約を受け付ける", usecases: [] }] }],
};

describe("generateFromPrompt", () => {
  it("担当の無い作業があれば理由を返して出し直してもらい、受け付けたらモデルと引き継ぐ会話を返す", async () => {
    scripted.specs.push(noPerformer, good);
    const steps: string[] = [];
    const submits: boolean[] = [];
    const r = await generateFromPrompt("小さな旅館の予約業務", {
      provider: "claude",
      model: "claude-opus-5-5",
      apiKey: "k",
      onStep: (s) => steps.push(s),
      onSubmit: (ok) => submits.push(ok),
    });
    expect(steps).toEqual(["analysis", "model", "done"]);
    expect(submits).toEqual([false, true]);
    expect(scripted.results[0]!.content).toMatch(/担当/);
    expect(r.build.model.meta.name).toBe("旅館");
    expect(r.analysis).toBe("分析の結果");
    expect(r.seed[0]!.text).toMatch(/小さな旅館の予約業務/);
    expect(r.seed[1]!.text).toMatch(/作業 1/);
  });

  it("提出されなければエラーにする", async () => {
    scripted.sent.length = 0;
    scripted.specs.length = 0;
    await expect(generateFromPrompt("x", { provider: "gemini", model: "m", apiKey: "k" })).rejects.toThrow(/提出しませんでした/);
  });
});
