// AI エージェントの会話: AI を偽物にして、道具の編集が 1 件の履歴にまとまること、キーが無いときの案内を確かめる。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import type { ChatOptions } from "../chat";

const fake = vi.hoisted(() => ({
  key: "k" as string | null,
  sent: [] as string[],
  systems: [] as string[],
  toolNames: [] as string[][],
  seeds: [] as { role: string; text: string }[][],
}));

vi.mock("../keys", () => ({ getApiKey: async () => fake.key, setApiKey: async () => {}, deleteApiKey: async () => {} }));
vi.mock("../chat", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    createChatSession: (_p: string, o: ChatOptions) => ({
      seed: (turns: { role: string; text: string }[]) => fake.seeds.push(turns),
      send: async (text: string, events?: { onText?: (d: string) => void; onTool?: (n: string, r: unknown) => void }) => {
        fake.sent.push(text);
        fake.systems.push(o.system);
        fake.toolNames.push(o.tools.map((t) => t.name));
        if (/^エラー/.test(text)) throw new Error("API に接続できませんでした");
        const grill = o.tools.some((t) => t.name === "update_issue_analysis");
        if (grill) {
          // 深掘り: 最初は質問を返し、「はい」が来たら課題を更新する
          if (!/^はい/.test(text)) {
            events?.onText?.("Q1 …");
            return "Q1 …";
          }
          events?.onTool?.("update_issue_analysis", await o.runTool("update_issue_analysis", { cause: "本人確認が手書き", severity: 5 }));
          events?.onTool?.("set_issue_targets", await o.runTool("set_issue_targets", { target_ids: ["act_verify_identity"] }));
          events?.onText?.("更新しました");
          return "更新しました";
        }
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
  fake.systems.length = 0;
  fake.toolNames.length = 0;
  fake.seeds.length = 0;
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

  it("課題の深掘り: 課題を渡して質問をもらい、了承後の更新は 1 件の履歴になり、終えると通常の会話に戻る", async () => {
    const agent = useAgentStore.getState();
    await agent.startGrill("issue_checkin_queue");
    expect(useAgentStore.getState().mode).toEqual({ kind: "grill", issueId: "issue_checkin_queue" });
    expect(useAgentStore.getState().open).toBe(true);
    // 最初の発言 (課題の JSON) は利用者の発言として表示しない。深掘りの指示と道具で会話を作る
    expect(fake.sent[0]).toContain('"id": "issue_checkin_queue"');
    expect(fake.systems[0]).toContain("深掘り");
    expect(fake.toolNames[0]).toEqual(["get_model", "update_issue_analysis", "set_issue_targets"]);
    let items = useAgentStore.getState().items;
    expect(items.map((i) => i.role)).toEqual(["info", "assistant"]);
    expect(items[0]!.text).toContain("繁忙期にチェックインの列ができる");
    expect(st().history.past).toHaveLength(0);

    await useAgentStore.getState().send("はい、その内容で更新してください");
    const issue = st().model.elements.find((e) => e.id === "issue_checkin_queue") as { severity: number; targetIds: string[]; analysis?: unknown };
    expect(issue).toMatchObject({ severity: 5, targetIds: ["act_verify_identity"], analysis: { cause: "本人確認が手書き" } });
    expect(st().history.past).toHaveLength(1);
    items = useAgentStore.getState().items;
    expect(items.slice(-3).map((i) => [i.role, i.text])).toEqual([
      ["tool", "課題の分析を更新"],
      ["tool", "課題の対象を変更"],
      ["assistant", "更新しました"],
    ]);

    useAgentStore.getState().endGrill();
    expect(useAgentStore.getState().mode).toEqual({ kind: "edit" });
    expect(useAgentStore.getState().items.slice(-1)[0]).toMatchObject({ role: "info" });
    await useAgentStore.getState().send("作業を足して");
    expect(fake.toolNames.slice(-1)[0]).toContain("add_element");
    expect(fake.systems.slice(-1)[0]).not.toContain("深掘り");
  });

  it("深掘りの途中でエラーになったら、作り直す会話に課題の JSON とやり取りを引き継ぐ", async () => {
    await useAgentStore.getState().startGrill("issue_checkin_queue");
    expect(fake.seeds).toEqual([[]]);
    await useAgentStore.getState().send("エラーを起こす");
    expect(useAgentStore.getState().items.slice(-1)[0]).toMatchObject({ role: "error" });
    expect(useAgentStore.getState().mode).toEqual({ kind: "grill", issueId: "issue_checkin_queue" });
    await useAgentStore.getState().send("はい");
    const seed = fake.seeds[1]!;
    expect(seed[0]!.role).toBe("user");
    expect(seed[0]!.text).toContain('"id": "issue_checkin_queue"');
    expect(seed.slice(1).map((t) => [t.role, t.text])).toEqual([
      ["assistant", "Q1 …"],
      ["user", "エラーを起こす"],
    ]);
  });

  it("最初の発言が届かなければ深掘りをやめて通常に戻す", async () => {
    fake.key = null;
    await useAgentStore.getState().startGrill("issue_checkin_queue");
    expect(useAgentStore.getState().mode).toEqual({ kind: "edit" });
    expect(useAgentStore.getState().items.map((i) => i.role)).toEqual(["info", "error"]);
  });

  it("課題でない要素では深掘りを始めない", async () => {
    await useAgentStore.getState().startGrill("actor_front");
    expect(useAgentStore.getState().mode).toEqual({ kind: "edit" });
    expect(fake.sent).toEqual([]);
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
