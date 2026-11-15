// 段階の上限 (会話ごとの道具の回数と文字数) と、往復の上限 (MAX_STEPS) の関係
import { describe, expect, it } from "vitest";
import { MAX_STEPS } from "../chat";
import { conversationSteps, logicBudget, MAPPING_CALLS_CAP, mappingLimits, REVERSE_LIMITS, screensBudget, SOURCE_CHARS_CAP, sourceLimits } from "../reverse";

describe("上限", () => {
  it("ソースが 1 つなら REVERSE_LIMITS のとおり。増えても会話ごとの往復は MAX_STEPS に収まり、文字数は上限を超えない", () => {
    expect(sourceLimits(1).survey).toEqual({ calls: REVERSE_LIMITS.sourceCallsSurvey, chars: REVERSE_LIMITS.sourceCharsSurvey });
    for (let n = 1; n <= 8; n++) {
      for (const v of Object.values(conversationSteps(n))) expect(v).toBeLessThan(MAX_STEPS);
      expect(sourceLimits(n).survey.chars).toBeLessThanOrEqual(SOURCE_CHARS_CAP.survey);
      expect(sourceLimits(n).model.chars).toBeLessThanOrEqual(SOURCE_CHARS_CAP.model);
      expect(sourceLimits(n).data.chars).toBeLessThanOrEqual(SOURCE_CHARS_CAP.data);
    }
  });

  it("段階の合計の上限は、画面・システムの数に応じて増える (後ろの分が残る)", () => {
    expect(screensBudget(10).calls).toBe(screensBudget(0).calls + 10 * sourceLimits(1).screen.calls);
    expect(screensBudget(2).chars).toBeGreaterThan(screensBudget(1).chars);
    expect(logicBudget(3).calls).toBe(logicBudget(0).calls + 3 * sourceLimits(1).data.calls);
  });

  it("テーブルと情報の対応の会話の上限は、対応を付けるシステムの数に応じて増え、全体の上限・往復の上限 (MAX_STEPS)・文字数の上限の中に収まる", () => {
    for (let sources = 1; sources <= 6; sources++) {
      // システムが 1 つ (または 0) のときは、これまでどおり
      expect(mappingLimits(sources, 1)).toEqual({ calls: sourceLimits(sources).data.calls, chars: sourceLimits(sources).data.chars });
      expect(mappingLimits(sources, 0)).toEqual(mappingLimits(sources, 1));
      let prev = mappingLimits(sources, 1);
      for (const systems of [2, 3, 5, 8, 20, 100]) {
        const m = mappingLimits(sources, systems);
        expect(m.calls).toBeGreaterThanOrEqual(prev.calls);
        expect(m.chars).toBeGreaterThanOrEqual(prev.chars);
        // 往復の上限の中: ソースの道具の回数 + use_database の回数 + 答え直し・終わりの返答 < MAX_STEPS
        expect(m.calls).toBeLessThanOrEqual(MAPPING_CALLS_CAP);
        expect(m.calls + REVERSE_LIMITS.mappingCalls + 3).toBeLessThan(MAX_STEPS);
        expect(m.chars).toBeLessThanOrEqual(SOURCE_CHARS_CAP.data);
        // 段階全体の上限にも、その分が入る
        expect(logicBudget(1, sources, systems).calls).toBe(logicBudget(0, sources).calls + m.calls);
        prev = m;
      }
    }
    expect(mappingLimits(1, 4).calls).toBeGreaterThan(mappingLimits(1, 1).calls);
    expect(mappingLimits(1, 4).chars).toBeGreaterThan(mappingLimits(1, 1).chars);
    expect(conversationSteps(1).data).toBeLessThan(MAX_STEPS);
  });
});
