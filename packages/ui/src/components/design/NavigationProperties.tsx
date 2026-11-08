import { useEffect, useRef, useState } from "react";
import { setDesignNavigation, type SetDesignNavigationPayload } from "@untie/core/model/commands";
import { usedDesignIds } from "@untie/core/model/design";
import { newUniqueId } from "@untie/core/model/id";
import { LIMITS } from "@untie/core/model/limits";
import { designScreenName, hasMenuScreen, navigationFromSitemap } from "@untie/core/model/sitemap";
import type { SystemDesign, UntieModel } from "@untie/core/model/types";
import { useAgentStore } from "../../ai/agentStore";
import { describeChatError } from "../../ai/chat";
import { generateNavigation, withNavIds } from "../../ai/designNav";
import { getApiKey } from "../../ai/keys";
import { PROVIDERS } from "../../ai/providers";
import { selectReadOnly, useUntieStore } from "../../store";
import { CommitField } from "../CommitField";
import { ConfirmDialog } from "../ConfirmDialog";

type Navigation = SetDesignNavigationPayload["navigation"];

/** 右のペイン (設計モードのナビゲーションボード): ナビゲーションメニューのグループと項目 */
export function NavigationProperties() {
  const model = useUntieStore((s) => s.model);
  const systemId = useUntieStore((s) => s.ui.designSystemId);
  const design = model.designs.find((d) => d.systemId === systemId);
  return (
    <aside className="property-panel" aria-label="プロパティ">
      <h2 className="panel-title">ナビゲーションメニュー</h2>
      {systemId ? <NavEditor model={model} systemId={systemId} design={design} /> : <p className="hint">設計の対象のシステムを選ぶと、ここに出ます</p>}
    </aside>
  );
}

function NavEditor({ model, systemId, design }: { model: UntieModel; systemId: string; design: SystemDesign | undefined }) {
  const readOnly = useUntieStore(selectReadOnly);
  const dispatch = useUntieStore((s) => s.dispatch);
  const pushToast = useUntieStore((s) => s.pushToast);
  const provider = useAgentStore((s) => s.settings.provider);
  const aiModels = useAgentStore((s) => s.settings.models);
  const settingsOpen = useAgentStore((s) => s.settingsOpen);
  const setSettingsOpen = useAgentStore((s) => s.setSettingsOpen);
  const [hasKey, setHasKey] = useState<boolean | undefined>(undefined);
  const [generating, setGenerating] = useState(false);
  // 置き換えの確認を待っている作り方 (sitemap: サイトマップから作る、ai: AI で考える)
  const [confirm, setConfirm] = useState<"sitemap" | "ai" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const docSeq = useRef(useUntieStore.getState().docSeq);

  const screens = design?.screens ?? [];
  const navigation: Navigation = (design?.layout.navigation ?? []).map((g) => ({ id: g.id, group: g.group, items: g.items.map((i) => ({ screenId: i.screenId, ...(i.label ? { label: i.label } : {}) })) }));
  const hasNav = navigation.length > 0;

  // API キーがあるか (設定のダイアログを閉じたあとにも調べ直す)
  useEffect(() => {
    let alive = true;
    setHasKey(undefined);
    getApiKey(provider).then(
      (k) => alive && setHasKey(!!k),
      () => alive && setHasKey(false),
    );
    return () => {
      alive = false;
    };
  }, [provider, settingsOpen]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const apply = (next: Navigation): boolean => {
    const r = dispatch((m) => setDesignNavigation(m, { systemId, navigation: next }));
    if (!r.ok) pushToast(r.reason, "error");
    return r.ok;
  };
  const newGroupId = () => newUniqueId("navGroup", new Set([...usedDesignIds(useUntieStore.getState().model), ...navigation.map((g) => g.id)]));
  const move = <T,>(list: T[], index: number, delta: -1 | 1): T[] => {
    const to = index + delta;
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  };
  const patchGroup = (index: number, patch: (g: Navigation[number]) => Navigation[number]) => apply(navigation.map((g, i) => (i === index ? patch(g) : g)));

  const buildFromSitemap = () => {
    setConfirm(null);
    const next = navigationFromSitemap(useUntieStore.getState().model, systemId);
    if (next.length === 0) pushToast("サイトマップに画面がありません", "error");
    else if (apply(next)) pushToast(`サイトマップから ${next.length} 個のグループを作りました`, "info");
  };

  const generate = async () => {
    setConfirm(null);
    const st = useUntieStore.getState();
    const current = st.model.designs.find((d) => d.systemId === systemId);
    if (!current) return;
    let apiKey: string | null;
    try {
      apiKey = await getApiKey(provider);
    } catch {
      apiKey = null;
    }
    if (!apiKey) {
      pushToast("API キーが設定されていません。「AI の設定」で入れてください", "error");
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    try {
      const result = await generateNavigation(st.model, systemId, current, {
        provider,
        model: aiModels[provider] || PROVIDERS[provider].defaultModel,
        apiKey,
        signal: controller.signal,
      });
      // 生成のあいだに別の文書を開いていたら、結果は捨てる
      if (useUntieStore.getState().docSeq !== docSeq.current) return;
      const r = useUntieStore.getState().dispatch((m) => setDesignNavigation(m, { systemId, navigation: withNavIds(m, result.groups) }));
      if (!r.ok) pushToast(r.reason, "error");
      else pushToast(`AI が ${result.groups.length} 個のグループを作りました${result.dropped > 0 ? `。存在しない画面や重複 ${result.dropped} 件は捨てました` : ""}`, "info");
    } catch (e) {
      pushToast(describeChatError(e), "error");
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  };

  const request = (kind: "sitemap" | "ai") => {
    if (hasNav) setConfirm(kind);
    else if (kind === "sitemap") buildFromSitemap();
    else void generate();
  };

  const aiDisabled = readOnly || screens.length === 0 || generating || hasKey !== true;
  const editable = !readOnly;

  return (
    <div className="editor navigation-menu" data-testid="navigation-menu">
      <div className="nav-actions">
        <button type="button" disabled={readOnly || screens.length === 0 || generating} title="画面を、その画面を使う操作の業務ごとにグループにする" onClick={() => request("sitemap")}>
          サイトマップから作る
        </button>
        <button
          type="button"
          disabled={aiDisabled}
          title={hasKey === false ? "「AI の設定」で API キーを入れると使えます" : "画面の一覧から、利用者にとって自然なグループ分けを AI に考えさせる"}
          onClick={() => request("ai")}
        >
          {generating ? "考えています…" : "AI で考える"}
        </button>
      </div>
      {hasKey === false && !readOnly && (
        <p className="hint">
          「AI で考える」を使うには、<button type="button" className="link" onClick={() => setSettingsOpen(true)}>AI の設定</button>で {PROVIDERS[provider].label} の API キーを入れてください。
        </p>
      )}
      {screens.length === 0 && <p className="hint">サイトマップで画面を足すと、メニューに並べられます。</p>}
      {design && hasNav && !hasMenuScreen(design) && <p className="hint">いまのレイアウトは「ヘッダーのみ」なので、メニューは出ません。</p>}
      {design && hasNav && design.layout.shell === "plain" && hasMenuScreen(design) && <p className="hint">設計は「ヘッダーのみ」ですが、上書きで shell にした画面ではメニューが出ます。</p>}
      <ul className="nav-groups">
        {navigation.map((group, gi) => (
          <li key={group.id} className="nav-group" data-nav-group={group.id}>
            <div className="nav-row">
              <CommitField
                label={`グループ名 ${gi + 1}`}
                value={group.group}
                maxLength={LIMITS.name.max}
                readOnly={readOnly}
                onCommit={(v) => patchGroup(gi, (g) => ({ ...g, group: v }))}
              />
              {editable && (
                <span className="nav-buttons">
                  <button type="button" aria-label={`グループ「${group.group || "(名前なし)"}」を上へ`} disabled={gi === 0} onClick={() => apply(move(navigation, gi, -1))}>
                    ↑
                  </button>
                  <button type="button" aria-label={`グループ「${group.group || "(名前なし)"}」を下へ`} disabled={gi === navigation.length - 1} onClick={() => apply(move(navigation, gi, 1))}>
                    ↓
                  </button>
                  <button type="button" aria-label={`グループ「${group.group || "(名前なし)"}」を削除`} onClick={() => apply(navigation.filter((_, i) => i !== gi))}>
                    ×
                  </button>
                </span>
              )}
            </div>
            <ul className="nav-items">
              {group.items.map((item, ii) => {
                const screen = screens.find((s) => s.id === item.screenId);
                const screenName = screen ? designScreenName(model, screen) : "";
                return (
                  <li key={`${ii}:${item.screenId}`} className="nav-item">
                    <div className="nav-row">
                      <label className="field">
                        <span className="field-label">画面</span>
                        <select
                          aria-label={`グループ「${group.group || "(名前なし)"}」の項目 ${ii + 1} の画面`}
                          value={item.screenId}
                          disabled={readOnly}
                          onChange={(e) => patchGroup(gi, (g) => ({ ...g, items: g.items.map((x, k) => (k === ii ? { screenId: e.target.value, ...(x.label ? { label: x.label } : {}) } : x)) }))}
                        >
                          {screens.map((s) => (
                            <option key={s.id} value={s.id}>
                              {designScreenName(model, s)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {editable && (
                        <span className="nav-buttons">
                          <button type="button" aria-label={`項目「${item.label || screenName}」を上へ`} disabled={ii === 0} onClick={() => patchGroup(gi, (g) => ({ ...g, items: move(g.items, ii, -1) }))}>
                            ↑
                          </button>
                          <button type="button" aria-label={`項目「${item.label || screenName}」を下へ`} disabled={ii === group.items.length - 1} onClick={() => patchGroup(gi, (g) => ({ ...g, items: move(g.items, ii, 1) }))}>
                            ↓
                          </button>
                          <button type="button" aria-label={`項目「${item.label || screenName}」を削除`} onClick={() => patchGroup(gi, (g) => ({ ...g, items: g.items.filter((_, k) => k !== ii) }))}>
                            ×
                          </button>
                        </span>
                      )}
                    </div>
                    <CommitField
                      key={`${group.id}:${ii}:${item.screenId}`}
                      label={`項目 ${ii + 1} の表示名`}
                      value={item.label ?? ""}
                      placeholder={screenName}
                      maxLength={LIMITS.name.max}
                      readOnly={readOnly}
                      onCommit={(v) => patchGroup(gi, (g) => ({ ...g, items: g.items.map((x, k) => (k === ii ? { screenId: x.screenId, ...(v.trim() ? { label: v } : {}) } : x)) }))}
                    />
                  </li>
                );
              })}
            </ul>
            {editable && (
              <button
                type="button"
                className="nav-add-item"
                disabled={screens.length === 0}
                aria-label={`グループ「${group.group || "(名前なし)"}」に項目を足す`}
                onClick={() => {
                  const next = screens.find((s) => !group.items.some((i) => i.screenId === s.id)) ?? screens[0];
                  if (next) patchGroup(gi, (g) => ({ ...g, items: [...g.items, { screenId: next.id }] }));
                }}
              >
                ＋項目
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <button type="button" className="nav-add-group" onClick={() => apply([...navigation, { id: newGroupId(), group: "新しいグループ", items: [] }])}>
          ＋グループ
        </button>
      )}
      {confirm !== null && (
        <ConfirmDialog
          title="ナビゲーションを置き換える"
          message={`いまのナビゲーション (${navigation.length} 個のグループ) を、${confirm === "sitemap" ? "サイトマップから作ったもの" : "AI が考えたもの"}に置き換えます。`}
          confirmLabel="置き換える"
          danger
          onConfirm={() => (confirm === "sitemap" ? buildFromSitemap() : void generate())}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
