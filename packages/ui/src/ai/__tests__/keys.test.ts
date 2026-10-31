import { describe, expect, it } from "vitest";
import { memory } from "../../test/platform";
import { deleteApiKey, getApiKey, isApiKeyRemembered, setApiKey } from "../keys";

// 置き場所ごとの振る舞い (メモリ・localStorage・キーチェーン) は apps/web と apps/desktop の platform のテストで確かめる。
// ここでは、キーの読み書きが Platform の secrets を通ることだけを確かめる
describe("API キー (Platform の secrets を通る)", () => {
  it("プロバイダーごとに読み書きでき、消せる", async () => {
    expect(await getApiKey("claude")).toBeNull();
    await setApiKey("claude", "sk-a");
    await setApiKey("gemini", "g-key");
    expect(await getApiKey("claude")).toBe("sk-a");
    expect(await getApiKey("gemini")).toBe("g-key");
    await deleteApiKey("claude");
    expect(await getApiKey("claude")).toBeNull();
    expect(await getApiKey("gemini")).toBe("g-key");
  });

  it("remember を secrets へ渡し、保存の有無を isRemembered で引く", async () => {
    await setApiKey("claude", "sk-b", { remember: true });
    expect(isApiKeyRemembered("claude")).toBe(true);
    await setApiKey("claude", "sk-b");
    expect(isApiKeyRemembered("claude")).toBe(false);
    const set = memory().secrets.set;
    const calls: unknown[] = [];
    memory().secrets.set = async (...args) => {
      calls.push(args);
      return set(...args);
    };
    await setApiKey("codex", "x", { remember: true });
    expect(calls).toEqual([["codex", "x", { remember: true }]]);
  });
});
