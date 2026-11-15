// 段階の上限 (会話ごとの道具の回数と文字数) と、往復の上限 (MAX_STEPS) の関係
import { describe, expect, it } from "vitest";
import { MAX_STEPS } from "../chat";
import { conversationSteps, logicBudget, REVERSE_LIMITS, screensBudget, SOURCE_CHARS_CAP, sourceLimits } from "../reverse";

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
});
