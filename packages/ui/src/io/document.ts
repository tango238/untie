// モデルの保存・読み込み (ストアとファイルをつなぐ)。
import { validateModel } from "@untie/core/model/validate";
import { emptyModel, type UntieModel } from "@untie/core/model/types";
import { createHotelSample } from "@untie/core/sample";
import { hasUnsavedChanges, useUntieStore } from "../store";
import { getPlatform, type OpenedFile, type RecentFile } from "../platform";

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

/** ファイル名に使えない文字を置き換える (改行などの制御文字は取り除く)。空になったら "untie" */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 100);
  return cleaned || "untie";
}

const suggestedName = (model: UntieModel) => `${safeFileName(model.meta.name)}.json`;

const DISCARD_MESSAGE = "保存していない変更があります。破棄して続けますか？";

/** 未保存の変更があれば、捨ててよいか確かめる。続けてよければ true */
export async function confirmDiscardIfDirty(message = DISCARD_MESSAGE, okLabel?: string): Promise<boolean> {
  return !hasUnsavedChanges(useUntieStore.getState()) || (await getPlatform().confirmDiscard(message, okLabel));
}

/** 起動時のサンプルを開き直す (ホームの「サンプルを開く」)。未保存の変更があれば先に確かめる。開けたら true */
export async function openSampleDocument(): Promise<boolean> {
  if (!(await confirmDiscardIfDirty())) return false;
  const st = useUntieStore.getState();
  st.newDocument(createHotelSample(), { pristine: true });
  st.pushToast("サンプルを開きました", "info");
  return true;
}

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
  void getPlatform().recentFiles.add(opened);
  return true;
}

/** ファイルを開く。未保存の変更があれば先に確かめる。開けたら true (取り消し・失敗は false) */
export async function openDocument(): Promise<boolean> {
  const st = useUntieStore.getState();
  if (!(await confirmDiscardIfDirty())) return false;
  try {
    const opened = await getPlatform().openTextFile();
    return opened ? loadOpened(opened) : false;
  } catch (e) {
    st.pushToast(`開けませんでした: ${String(e)}`, "error");
    return false;
  }
}

/** 最近開いたファイルを開く。読めなければ (消えた・動かしたなど) 一覧から外す。開けたら true */
export async function openRecentDocument(file: RecentFile): Promise<boolean> {
  const st = useUntieStore.getState();
  if (!(await confirmDiscardIfDirty())) return false;
  let opened: OpenedFile;
  try {
    opened = await getPlatform().recentFiles.read(file);
  } catch (e) {
    const missing = file.path !== undefined || (e instanceof DOMException && e.name === "NotFoundError");
    if (missing) await getPlatform().recentFiles.remove(file);
    st.pushToast(`「${file.name}」を開けませんでした${missing ? " (最近開いたファイルから外しました)" : ""}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return false;
  }
  return loadOpened(opened);
}

/** 保存する。asNew なら保存先を選び直す */
export async function saveDocument(asNew = false): Promise<boolean> {
  const st = useUntieStore.getState();
  // 入力中の名前・説明を確定させてから保存する (入力欄はフォーカスが外れたときに確定する)
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (st.dragBase) st.commitDrag();
  const { model, file } = useUntieStore.getState();
  try {
    const saved = await getPlatform().saveTextFile(serializeModel(model), asNew ? null : (file?.path ?? null), file?.name ?? suggestedName(model));
    if (!saved) return false;
    useUntieStore.getState().markSaved(saved, model);
    void getPlatform().recentFiles.add(saved);
    st.pushToast(`「${saved.name}」に保存しました`, "info");
    return true;
  } catch (e) {
    st.pushToast(`保存できませんでした: ${String(e)}`, "error");
    return false;
  }
}
