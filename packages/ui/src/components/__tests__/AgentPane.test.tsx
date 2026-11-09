import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUntieStore } from "../../store";
import { resetStore } from "../../test/utils";
import { useAgentStore } from "../../ai/agentStore";
import { HEARING_SUMMARY_REQUEST } from "../../ai/hearing";
import { AgentPane } from "../ai/AgentPane";

const sent: string[] = [];
vi.mock("../../ai/keys", () => ({ getApiKey: async () => "k", setApiKey: async () => {}, deleteApiKey: async () => {} }));
vi.mock("../../ai/chat", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createChatSession: () => ({
    seed: () => {},
    send: async (text: string) => {
      sent.push(text);
      return "了解";
    },
  }),
}));

beforeEach(() => {
  // jsdom には scrollTo が無い
  HTMLElement.prototype.scrollTo = () => {};
  resetStore();
  sent.length = 0;
  useAgentStore.getState().newConversation();
});

const startHearing = async (actorId: string, answerer: "persona" | "self") => {
  await act(async () => {
    await useAgentStore.getState().startHearing(actorId, answerer);
  });
};

describe("AgentPane: ヒアリング", () => {
  it("ヘッダーに「ヒアリング: 「アクター名」(答え方)」を出し、「まとめる」「ヒアリングを終える」を置く", async () => {
    await startHearing("actor_front", "persona");
    render(<AgentPane />);
    expect(screen.getByRole("heading").textContent).toBe("ヒアリング: 「フロント担当」(ペルソナが答える)");
    expect(screen.getByRole("button", { name: "まとめる" })).toBeDefined();
    expect(screen.getByRole("button", { name: "ヒアリングを終える" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "新しい会話" })).toBeNull();
  });

  it("本人に聞くときのヘッダーと placeholder。ペルソナが答えるときの placeholder は質問を促す", async () => {
    await startHearing("actor_front", "self");
    const { unmount } = render(<AgentPane />);
    expect(screen.getByRole("heading").textContent).toBe("ヒアリング: 「フロント担当」(本人に聞く)");
    expect(screen.getByLabelText("AI への依頼").getAttribute("placeholder")).toMatch(/^質問に答えて Enter で送信.*「はい」で推奨を採ります/);
    unmount();
    useAgentStore.getState().endHearing();
    await startHearing("actor_front", "persona");
    render(<AgentPane />);
    expect(screen.getByLabelText("AI への依頼").getAttribute("placeholder")).toMatch(/^ペルソナに質問して Enter で送信/);
  });

  it("「まとめる」は固定の発話を送る", async () => {
    await startHearing("actor_front", "persona");
    render(<AgentPane />);
    sent.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "まとめる" }));
    });
    expect(HEARING_SUMMARY_REQUEST).toBe("ここまでの困りごとをまとめてください");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(HEARING_SUMMARY_REQUEST);
    expect(useAgentStore.getState().items.some((i) => i.role === "user" && i.text === HEARING_SUMMARY_REQUEST)).toBe(true);
  });

  it("「ヒアリングを終える」で通常の会話に戻り、ヘッダーも戻る", async () => {
    await startHearing("actor_front", "persona");
    render(<AgentPane />);
    fireEvent.click(screen.getByRole("button", { name: "ヒアリングを終える" }));
    expect(useAgentStore.getState().mode).toEqual({ kind: "edit" });
    expect(screen.getByRole("heading").textContent).toBe("AI エージェント");
    expect(screen.queryByRole("button", { name: "まとめる" })).toBeNull();
    expect(useUntieStore.getState().model).toBeDefined();
  });
});
