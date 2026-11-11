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
    expect(screen.getByRole("heading").textContent).toBe("ヒアリング: 「フロント担当」(人間が聞いて、AI が答える)");
    expect(screen.getByRole("button", { name: "まとめる" })).toBeDefined();
    expect(screen.getByRole("button", { name: "ヒアリングを終える" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "新しい会話" })).toBeNull();
  });

  it("AI が聞いて、人間が答えるときのヘッダーと placeholder。人間が聞いて、AI が答えるときの placeholder は質問を促す", async () => {
    await startHearing("actor_front", "self");
    const { unmount } = render(<AgentPane />);
    expect(screen.getByRole("heading").textContent).toBe("ヒアリング: 「フロント担当」(AI が聞いて、人間が答える)");
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

describe("AgentPane: 高さを変える", () => {
  const pane = () => screen.getByRole("region", { name: "AI エージェント" });
  const handle = () => screen.getByRole("separator", { name: "AI エージェントの高さ" });
  const drag = (fromY: number, toY: number) => {
    // jsdom はペインの高さを測れないので、既定の高さを 300px として始める
    vi.spyOn(pane(), "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
    fireEvent.pointerDown(handle(), { button: 0, clientY: fromY, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: toY, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: toY, pointerId: 1 });
  };

  beforeEach(() => {
    localStorage.clear();
    window.innerHeight = 900;
  });

  it("上端の取っ手を上へ引くと大きく、下へ引くと小さくなり、高さを覚える", () => {
    const { unmount } = render(<AgentPane />);
    expect(pane().style.height).toBe("");
    drag(600, 500);
    expect(pane().style.height).toBe("400px");
    expect(localStorage.getItem("untie.agent.paneHeight")).toBe("400");
    unmount();
    render(<AgentPane />);
    expect(pane().style.height).toBe("400px");
    fireEvent.pointerDown(handle(), { button: 0, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle(), { clientY: 650, pointerId: 1 });
    fireEvent.pointerUp(handle(), { clientY: 650, pointerId: 1 });
    expect(pane().style.height).toBe("250px");
  });

  it("下限と、画面の上に残す高さで止まる", () => {
    render(<AgentPane />);
    drag(600, 0);
    expect(pane().style.height).toBe("740px");
    drag(0, 2000);
    expect(pane().style.height).toBe("120px");
  });

  it("矢印キーで変え、ダブルクリックで既定の高さに戻して忘れる", () => {
    render(<AgentPane />);
    vi.spyOn(pane(), "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(pane().style.height).toBe("324px");
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    fireEvent.keyDown(handle(), { key: "ArrowDown" });
    expect(pane().style.height).toBe("276px");
    expect(localStorage.getItem("untie.agent.paneHeight")).toBe("276");
    fireEvent.doubleClick(handle());
    expect(pane().style.height).toBe("");
    expect(localStorage.getItem("untie.agent.paneHeight")).toBeNull();
  });
});
