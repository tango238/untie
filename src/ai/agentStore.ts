// AI エージェントの会話の状態。モデルの編集はアプリのストアを通し、1 回の応答の編集を 1 件の履歴にまとめる。
import { create } from "zustand";
import { ELEMENT_KIND_LABELS } from "../model/types";
import { FIXED_LAYER_LABELS, parseFixedBoardId } from "../model/fixedBoards";
import { useUntieStore } from "../store";
import { createChatSession, describeChatError, type ChatSession, type SeedTurn } from "./chat";
import { getApiKey } from "./keys";
import { agentSystemPrompt } from "./prompts";
import { loadAiSettings, PROVIDERS, saveAiSettings, type AiSettings } from "./providers";
import { executeTool, MODEL_TOOLS, type ModelEditor } from "./tools";

export type ChatItemRole = "user" | "assistant" | "tool" | "error" | "info";

export interface ChatItem {
  id: number;
  role: ChatItemRole;
  text: string;
  /** 道具の結果 (role が tool のとき) */
  ok?: boolean;
}

interface AgentState {
  /** 下のペインを開いているか */
  open: boolean;
  /** AI の設定ダイアログを開いているか */
  settingsOpen: boolean;
  settings: AiSettings;
  items: ChatItem[];
  running: boolean;
  setOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (settings: AiSettings) => void;
  /** 会話を最初からにする */
  newConversation: () => void;
  send: (text: string) => Promise<void>;
  cancel: () => void;
  /** プロンプトからの作成のあと、その会話を引き継いでペインを開く */
  continueFrom: (seed: SeedTurn[], items: { role: ChatItemRole; text: string }[]) => void;
}

let seq = 0;
let session: ChatSession | null = null;
/** セッションを作ったときのプロバイダーとモデル (変わったら作り直す) */
let sessionKey = "";
let pendingSeed: SeedTurn[] = [];
let controller: AbortController | null = null;

const TOOL_LABELS: Record<string, string> = {
  get_model: "モデルを読む",
  add_element: "要素を追加",
  update_element: "要素を変更",
  remove_element: "要素を削除",
  add_relation: "関係を追加",
  remove_relation: "関係を削除",
  move_activity: "作業の所属を変更",
  move_buc: "活動の所属を変更",
  set_context: "コンテキストを変更",
};

/** 道具がアプリのストアを通してモデルを読み書きする口 */
export const storeEditor: ModelEditor = {
  getModel: () => useUntieStore.getState().model,
  apply: (command) => useUntieStore.getState().agentApply(command),
};

/** 発言に添える画面の状態 (開いているボードと選択中の要素) */
function screenContext(): string {
  const st = useUntieStore.getState();
  const layer = parseFixedBoardId(st.ui.currentBoardId);
  const board = layer
    ? `固定ボード「${FIXED_LAYER_LABELS[layer]}」`
    : (st.model.boards.find((b) => b.id === st.ui.currentBoardId)?.name ?? st.ui.currentBoardId);
  const sel = st.ui.selection?.type === "element" ? st.model.elements.find((e) => e.id === st.ui.selection!.id) : undefined;
  return `[画面の状態] 開いているボード: ${board}${sel ? ` / 選択中: ${ELEMENT_KIND_LABELS[sel.kind]}「${sel.name}」(id: ${sel.id})` : ""}`;
}

export const useAgentStore = create<AgentState>()((set, get) => {
  const push = (role: ChatItemRole, text: string, ok?: boolean) =>
    set((s) => ({ items: [...s.items, { id: ++seq, role, text, ...(ok === undefined ? {} : { ok }) }] }));

  return {
    open: false,
    settingsOpen: false,
    settings: loadAiSettings(),
    items: [],
    running: false,
    setOpen: (open) => set({ open }),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    updateSettings: (settings) => {
      saveAiSettings(settings);
      set({ settings });
    },
    newConversation: () => {
      get().cancel();
      session = null;
      sessionKey = "";
      pendingSeed = [];
      set({ items: [] });
    },
    cancel: () => {
      controller?.abort();
    },
    continueFrom: (seed, items) => {
      session = null;
      sessionKey = "";
      pendingSeed = seed;
      set({ open: true, items: items.map((i) => ({ id: ++seq, role: i.role, text: i.text })) });
    },
    send: async (text) => {
      const message = text.trim();
      if (!message || get().running) return;
      const { provider, models } = get().settings;
      const model = models[provider] || PROVIDERS[provider].defaultModel;
      push("user", message);
      let apiKey: string | null;
      try {
        apiKey = await getApiKey(provider);
      } catch (e) {
        push("error", `${PROVIDERS[provider].label} の API キーをキーチェーンから読み出せませんでした。「AI の設定」で保存し直してください。(${String(e)})`);
        set({ settingsOpen: true });
        return;
      }
      if (!apiKey) {
        push("error", `${PROVIDERS[provider].label} の API キーが設定されていません。「AI の設定」で入れてください。`);
        set({ settingsOpen: true });
        return;
      }
      const key = `${provider}:${model}`;
      if (!session || sessionKey !== key) {
        if (session && sessionKey !== key) push("info", `${PROVIDERS[provider].label} (${model}) で新しく会話を始めます。`);
        session = createChatSession(provider, {
          apiKey,
          model,
          system: agentSystemPrompt(),
          tools: MODEL_TOOLS,
          runTool: (name, input) => executeTool(storeEditor, name, input),
        });
        session.seed(pendingSeed);
        pendingSeed = [];
        sessionKey = key;
      }
      controller = new AbortController();
      set({ running: true });
      useUntieStore.getState().beginAgentEdit();
      // 文章が届いたら、いま書いている返答に足す (道具を挟んだら次の返答にする)
      let current: number | null = null;
      try {
        await session.send(`${message}\n\n${screenContext()}`, {
          onText: (delta) => {
            if (current === null) {
              push("assistant", delta);
              current = seq;
            } else {
              set((s) => ({ items: s.items.map((i) => (i.id === current ? { ...i, text: i.text + delta } : i)) }));
            }
          },
          onTool: (name, outcome) => {
            current = null;
            push("tool", TOOL_LABELS[name] ?? name, outcome.ok);
          },
        }, controller.signal);
      } catch (e) {
        push("error", describeChatError(e));
        // 途中で失敗した会話は続けられないことがあるので、次の発言では作り直す
        session = null;
        sessionKey = "";
      } finally {
        useUntieStore.getState().endAgentEdit();
        controller = null;
        set({ running: false });
      }
    },
  };
});
