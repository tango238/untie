// AI エージェントの会話: AI を偽物にして、道具の編集が 1 件の履歴にまとまること、キーが無いときの案内を確かめる。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import type { ChatOptions } from "../chat";

const fake = vi.hoisted(() => ({ key: "k" as string | null, sent: [] as string[] }));

vi.mock("../keys", () => ({ getApiKey: async () => fake.key, setApiKey: async () => {}, deleteApiKey: async () => {} }));
vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_p: string, o: ChatOptions) => ({
      seed: () => {},
      send: async (text: string, events?: { onText?: (d: string) => void; onTool?: (n: string, r: unknown) => void }) => {
        fake.sent.push(text);
        for (const [name, input] of [
          ["add_element", { kind: "activity", name: "AI の作業", business_id: "biz_checkin" }],
          ["add_element", { kind: "usecase", name: "AI の操作" }],
        ] as const) {
          events?.onTool?.(name, await o.runTool(name, input));
        }
        events?.onText?.("2 つ足しました");
        return "2 つ足しました";
      },
    }),
  };
});

const { useAgentStore } = await import("../agentStore");
const st = () => useUntieStore.getState();

beforeEach(() => {
  resetStore();
  fake.key = "k";
  fake.sent.length = 0;
  useAgentStore.getState().newConversation();
});

describe("AI エージェント", () => {
  it("1 回の返答の編集を 1 件の履歴にまとめ、Undo で一度に戻せる。発言には画面の状態を添える", async () => {
    act(() => st().select({ type: "element", id: "act_hand_key" }));
    await useAgentStore.getState().send("作業と操作を足して");
    expect(st().model.elements.some((e) => e.name === "AI の作業")).toBe(true);
    expect(st().history.past).toHaveLength(1);
    expect(fake.sent[0]).toMatch(/選択中: 作業「鍵を渡す」/);
    const items = useAgentStore.getState().items;
    expect(items.map((i) => i.role)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(items[3]!.text).toBe("2 つ足しました");
    st().undo();
    expect(st().model.elements.some((e) => e.name === "AI の作業" || e.name === "AI の操作")).toBe(false);
  });

  it("API キーが無ければ案内して設定を開く", async () => {
    fake.key = null;
    await useAgentStore.getState().send("こんにちは");
    expect(useAgentStore.getState().items.slice(-1)[0]).toMatchObject({ role: "error" });
    expect(useAgentStore.getState().settingsOpen).toBe(true);
    expect(fake.sent).toEqual([]);
  });
});

function act(fn: () => void) {
  fn();
}
