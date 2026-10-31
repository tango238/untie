// AI エージェントの会話の状態。モデルの編集はアプリのストアを通し、1 回の応答の編集を 1 件の履歴にまとめる。
import { create } from "zustand";
import { ELEMENT_KIND_LABELS } from "@untie/core/model/types";
import { FIXED_LAYER_LABELS, parseFixedBoardId } from "@untie/core/model/fixedBoards";
import { selectReadOnly, useUntieStore } from "../store";
import { createChatSession, describeChatError, type ChatSession, type SeedTurn } from "./chat";
import { executeGrillTool, GRILL_TOOLS, grillOpening, grillSystemPrompt } from "./grill";
import { getApiKey } from "./keys";
import { agentSystemPrompt } from "./prompts";
import { loadAiSettings, PROVIDERS, saveAiSettings, type AiSettings } from "./providers";
import { executeTool, MODEL_TOOLS, type ModelEditor, type ToolDef, type ToolOutcome } from "./tools";

export type ChatItemRole = "user" | "assistant" | "tool" | "error" | "info";

export interface ChatItem {
  id: number;
  role: ChatItemRole;
  text: string;
  /** 道具の結果 (role が tool のとき) */
  ok?: boolean;
}

/**
 * 会話のモード。
 * - edit: 編集中のモデルを会話で直す (通常)
 * - grill: 1 つの課題を深掘りする。AI はその課題の分析・重要度・対象だけを変えられる
 */
export type AgentMode = { kind: "edit" } | { kind: "grill"; issueId: string };

interface AgentState {
  /** 下のペインを開いているか */
  open: boolean;
  mode: AgentMode;
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
  /** 課題の深掘りを始める。新しい会話にし、課題と対象のまわりを渡して最初の質問をもらう */
  startGrill: (issueId: string) => Promise<void>;
  /** 深掘りを終えて通常の会話に戻る (会話の表示は残し、次の発言から新しい会話) */
  endGrill: () => void;
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
  update_issue_analysis: "課題の分析を更新",
  set_issue_targets: "課題の対象を変更",
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

/** モードごとの指示と道具 */
function modeSetup(mode: AgentMode): { key: string; system: string; tools: ToolDef[]; runTool: (name: string, input: unknown) => ToolOutcome } {
  if (mode.kind === "grill") {
    return {
      key: `grill:${mode.issueId}`,
      system: grillSystemPrompt(),
      tools: GRILL_TOOLS,
      runTool: (name, input) => executeGrillTool(storeEditor, mode.issueId, name, input),
    };
  }
  return { key: "edit", system: agentSystemPrompt(), tools: MODEL_TOOLS, runTool: (name, input) => executeTool(storeEditor, name, input) };
}

export const useAgentStore = create<AgentState>()((set, get) => {
  const push = (role: ChatItemRole, text: string, ok?: boolean) =>
    set((s) => ({ items: [...s.items, { id: ++seq, role, text, ...(ok === undefined ? {} : { ok }) }] }));

  /** 会話を捨てる (表示は残す)。次の発言で作り直す */
  const resetSession = () => {
    session = null;
    sessionKey = "";
    pendingSeed = [];
  };

  return {
    open: false,
    mode: { kind: "edit" },
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
      resetSession();
      set({ items: [], mode: { kind: "edit" } });
    },
    cancel: () => {
      controller?.abort();
    },
    continueFrom: (seed, items) => {
      resetSession();
      pendingSeed = seed;
      set({ open: true, mode: { kind: "edit" }, items: items.map((i) => ({ id: ++seq, role: i.role, text: i.text })) });
    },
    startGrill: async (issueId) => {
      if (get().running) return;
      const st = useUntieStore.getState();
      const issue = st.model.elements.find((e) => e.id === issueId);
      if (!issue || issue.kind !== "issue") return;
      resetSession();
      set({ open: true, mode: { kind: "grill", issueId }, items: [] });
      push("info", `課題「${issue.name || "(名前なし)"}」を深掘りします。AI の質問に答えていくと、現象・所在・理由・影響を突き止め、最後に課題を更新します。`);
      await run(grillOpening(st.model, issue), false);
      // 最初の発言が届かなかった (キーが無い・中断など) ら、通常に戻してやり直せるようにする
      if (!session) set({ mode: { kind: "edit" } });
    },
    endGrill: () => {
      if (get().mode.kind !== "grill") return;
      get().cancel();
      resetSession();
      set({ mode: { kind: "edit" } });
      push("info", "深掘りを終えました。ここからは通常の会話です。");
    },
    send: (text) => run(text, true),
  };

  /**
   * 途中でエラーになった会話を作り直すときに引き継ぐ履歴。深掘りでは、表示していない最初の発言 (課題の JSON) を
   * いまの課題から作り直して先頭に置き、そのあとの利用者と AI のやり取りを続ける。まだやり取りが無ければ何も引き継がない
   */
  function recoverySeed(): SeedTurn[] {
    const mode = get().mode;
    const turns = get().items.flatMap((i): SeedTurn[] => (i.role === "user" || i.role === "assistant" ? [{ role: i.role, text: i.text }] : []));
    if (mode.kind !== "grill" || turns.length === 0) return [];
    const st = useUntieStore.getState();
    const issue = st.model.elements.find((e) => e.id === mode.issueId);
    if (!issue || issue.kind !== "issue") return [];
    return [{ role: "user", text: grillOpening(st.model, issue) }, ...turns];
  }

  /** 発言を送る。show が偽なら利用者の発言として表示しない (深掘りの最初の JSON など) */
  async function run(text: string, show: boolean): Promise<void> {
    {
      const message = text.trim();
      if (!message || get().running) return;
      // 閲覧専用のファイルでは、モデルを直せないので使わせない
      if (selectReadOnly(useUntieStore.getState())) {
        push("error", "閲覧専用のため、AI エージェントは使えません。");
        return;
      }
      const { provider, models } = get().settings;
      const model = models[provider] || PROVIDERS[provider].defaultModel;
      // 作り直すときに引き継ぐ履歴は、この発言を表示に足す前に取る (この発言は send で送る)
      const recovery = recoverySeed();
      if (show) push("user", message);
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
      const setup = modeSetup(get().mode);
      const key = `${provider}:${model}:${setup.key}`;
      if (!session || sessionKey !== key) {
        if (session && sessionKey !== key) push("info", `${PROVIDERS[provider].label} (${model}) で新しく会話を始めます。`);
        session = createChatSession(provider, { apiKey, model, system: setup.system, tools: setup.tools, runTool: setup.runTool });
        session.seed(pendingSeed.length > 0 ? pendingSeed : recovery);
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
    }
  }
});
