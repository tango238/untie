// モデルの保存・読み込み (ストアとファイルをつなぐ)。
import { validateModel } from "../model/validate";
import { emptyModel, type UntieModel } from "../model/types";
import { hasUnsavedChanges, useUntieStore } from "../store";
import { confirmDiscard, openTextFile, saveTextFile, type OpenedFile } from "./file";
import { addRecentFile, readRecentFile, removeRecentFile, type RecentFile } from "./recent";

/** 保存する JSON。人が読み比べられるよう整形する */
export function serializeModel(model: UntieModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

/** JSON を読んで、スキーマと参照整合性を検査する */
export function parseModel(text: string): { ok: true; model: UntieModel } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON として読めません: ${(e as Error).message}`] };
  }
  return validateModel(json);
}

const suggestedName = (model: UntieModel) => `${(model.meta.name || "untie").replace(/[\\\\/:*?"<>|]/g, "_")}.json`;

const DISCARD_MESSAGE = "保存していない変更があります。破棄して続けますか？";

/** 空の新しいモデルにする。未保存の変更の確認は呼ぶ側で済ませておく */
export function newEmptyDocument(): void {
  const st = useUntieStore.getState();
  st.newDocument(emptyModel(), { pristine: true });
  st.pushToast("新しいモデルを作りました", "info");
}

/** 読んだファイルをモデルとして開く。開けたら最近開いたファイルに足す */
function loadOpened(opened: OpenedFile): boolean {
  const st = useUntieStore.getState();
  const parsed = parseModel(opened.text);
  if (!parsed.ok) {
    const shown = parsed.errors.slice(0, 3).join(" / ");
    const more = parsed.errors.length > 3 ? ` ほか ${parsed.errors.length - 3} 件` : "";
    st.pushToast(`「${opened.name}」を開けません: ${shown}${more}`, "error");
    return false;
  }
  st.loadDocument(parsed.model, { path: opened.path, name: opened.name });
  st.pushToast(`「${opened.name}」を開きました`, "info");
  void addRecentFile(opened);
  return true;
}

/** ファイルを開く。未保存の変更があれば先に確かめる */
export async function openDocument(): Promise<void> {
  const st = useUntieStore.getState();
  if (hasUnsavedChanges(st) && !(await confirmDiscard(DISCARD_MESSAGE))) return;
  try {
    const opened = await openTextFile();
    if (opened) loadOpened(opened);
  } catch (e) {
    st.pushToast(`開けませんでした: ${String(e)}`, "error");
  }
}

/** 最近開いたファイルを開く。読めなければ (消えた・動かしたなど) 一覧から外す */
export async function openRecentDocument(file: RecentFile): Promise<void> {
  const st = useUntieStore.getState();
  if (hasUnsavedChanges(st) && !(await confirmDiscard(DISCARD_MESSAGE))) return;
  let opened: OpenedFile;
  try {
    opened = await readRecentFile(file);
  } catch (e) {
    const missing = file.path !== undefined || (e instanceof DOMException && e.name === "NotFoundError");
    if (missing) await removeRecentFile(file);
    st.pushToast(`「${file.name}」を開けませんでした${missing ? " (最近開いたファイルから外しました)" : ""}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return;
  }
  loadOpened(opened);
}

/** 保存する。asNew なら保存先を選び直す */
export async function saveDocument(asNew = false): Promise<boolean> {
  const st = useUntieStore.getState();
  // 入力中の名前・説明を確定させてから保存する (入力欄はフォーカスが外れたときに確定する)
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (st.dragBase) st.commitDrag();
  const { model, file } = useUntieStore.getState();
  try {
    const saved = await saveTextFile(serializeModel(model), asNew ? null : (file?.path ?? null), file?.name ?? suggestedName(model));
    if (!saved) return false;
    useUntieStore.getState().markSaved(saved, model);
    void addRecentFile(saved);
    st.pushToast(`「${saved.name}」に保存しました`, "info");
    return true;
  } catch (e) {
    st.pushToast(`保存できませんでした: ${String(e)}`, "error");
    return false;
  }
}
