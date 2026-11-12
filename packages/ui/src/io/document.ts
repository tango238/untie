// モデルの保存・読み込み (ストアとファイルをつなぐ)。
import { DOMAIN_DOCS_DIR, DOMAIN_SESSION_FILE, exportDomainDocs } from "@untie/core/model/domainExport";
import { ACCEPTANCE_DIR, exportAcceptanceTests } from "@untie/core/model/acceptance";
import { exportDesignBriefAll } from "@untie/core/model/designBrief";
import { exportSoutherAll } from "@untie/core/model/southerExport";
import { loadModelJson } from "@untie/core/model/migrate";
import { emptyModel, type UntieModel } from "@untie/core/model/types";
import { SAMPLES, type SampleEntry } from "@untie/core/sample";
import { hasUnsavedChanges, useUntieStore } from "../store";
import { getPlatform, type OpenedFile, type RecentFile } from "../platform";

/** 保存する JSON。人が読み比べられるよう整形する */
export function serializeModel(model: UntieModel): string {
  return `${JSON.stringify(model, null, 2)}\n`;
}

/**
 * JSON を読んで、古い版のモデルの形式なら現行へ変換し (migrateModel)、スキーマと参照整合性を検査する。
 * migrated は変換したか (保存すると現行の版で書き出す)
 */
export function parseModel(
  text: string,
): { ok: true; model: UntieModel; from: string | null; migrated: boolean; notes: string[] } | { ok: false; errors: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON として読めません: ${(e as Error).message}`] };
  }
  return loadModelJson(json);
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

/** サンプルを開く (ホームのサンプルの一覧。省略すると一覧の先頭のサンプル)。未保存の変更があれば先に確かめる。開けたら true */
export async function openSampleDocument(sample: SampleEntry = SAMPLES[0]!): Promise<boolean> {
  if (!(await confirmDiscardIfDirty())) return false;
  const st = useUntieStore.getState();
  st.newDocument(sample.create(), { pristine: true });
  st.pushToast(`サンプル「${sample.title}」を開きました`, "info");
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
  st.pushToast(
    parsed.migrated
      ? `「${opened.name}」を開きました (古い形式 ${parsed.from} から ${parsed.model.version} に変換しました。${parsed.notes.map((n) => `${n}。`).join("")}保存すると新しい形式で書き出します)`
      : `「${opened.name}」を開きました`,
    "info",
  );
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

/**
 * 手元のモデルを JSON に書き出す (保存先は毎回選ぶ)。クラウドファイルの Cmd/Ctrl+S と、メニューの「JSON に書き出す」。
 * 開いているファイルや最近開いたファイルは変えない。書き出せたら true (取り消し・失敗は false)
 */
export async function exportModelToFile(): Promise<boolean> {
  const st = useUntieStore.getState();
  // 入力中の名前・説明を確定させてから書き出す
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (st.dragBase) st.commitDrag();
  const { model } = useUntieStore.getState();
  try {
    // 名前が空のときは、ホームの書き出しと同じ「名前なし」にする
    const name = `${safeFileName(model.meta.name.trim() || "名前なし")}.json`;
    const saved = await getPlatform().saveTextFile(serializeModel(model), null, name);
    if (!saved) return false;
    st.pushToast(`「${saved.name}」に書き出しました`, "info");
    return true;
  } catch (e) {
    st.pushToast(`書き出せませんでした: ${String(e)}`, "error");
    return false;
  }
}

/**
 * 受け入れテストを書き出す (開発モード)。設計から導いたケース (システムごと) と、それを流すテストの本体と、説明。
 * 実装を作る側は、同じフォルダに driver.ts だけを書く。既にある driver.ts は、消さない (書き出すのは、ほかのファイルだけ)
 */
export async function exportAcceptanceToFolder(): Promise<boolean> {
  const st = useUntieStore.getState();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const { model } = useUntieStore.getState();
  const out = exportAcceptanceTests(model);
  if (out.files.length === 0) {
    st.pushToast("書き出せるケースがありません。分析で、操作に前提の状態か、判断する条件を結んでください", "error");
    return false;
  }
  try {
    const saved = await getPlatform().saveTextFiles(out.files, { zipName: `${safeFileName(model.meta.name.trim() || "名前なし")}-acceptance.zip`, zipFolder: ACCEPTANCE_DIR });
    if (!saved) return false;
    st.pushToast(`受け入れテストを「${saved.where}」に書き出しました (ケース ${out.cases} 件)${out.pending > 0 ? `。設計で決まっていないことが ${out.pending} 件あり、そのぶんはケースになっていません` : ""}`, "info");
    return true;
  } catch (e) {
    st.pushToast(`書き出せませんでした: ${String(e)}`, "error");
    return false;
  }
}

/** 書き出す設計書を入れるフォルダの名前 (zip の中) */
export const DESIGN_BRIEF_DIR = "design";

/**
 * 実装に渡す設計書を書き出す (開発モード)。操作のあるシステムごとに 1 ファイル (<システムの id>.design.md)。
 * 実装を作る側 (AI のエージェント) が、作る前に読む。決まっていないことが残っていれば、その数を知らせる
 */
export async function exportDesignBriefToFolder(): Promise<boolean> {
  const st = useUntieStore.getState();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const { model } = useUntieStore.getState();
  const briefs = exportDesignBriefAll(model);
  if (briefs.length === 0) {
    st.pushToast("書き出せるシステムがありません。分析で、操作の対象にシステム (か、その画面) を結んでください", "error");
    return false;
  }
  try {
    const saved = await getPlatform().saveTextFiles(
      briefs.map((b) => ({ name: b.fileName, text: b.text })),
      { zipName: `${safeFileName(model.meta.name.trim() || "名前なし")}-design.zip`, zipFolder: DESIGN_BRIEF_DIR },
    );
    if (!saved) return false;
    const remaining = briefs.reduce((n, b) => n + b.remaining, 0);
    st.pushToast(`設計書を「${saved.where}」に書き出しました (${saved.count} ファイル)${remaining > 0 ? `。まだ決まっていないことが ${remaining} 件あります (実装を始める準備)` : ""}`, "info");
    return true;
  } catch (e) {
    st.pushToast(`書き出せませんでした: ${String(e)}`, "error");
    return false;
  }
}

/** 書き出す Souther のソースを入れるフォルダの名前 (zip の中) */
export const SOUTHER_DIR = "souther";

/**
 * 業務ルールの骨組みを、Souther のソース (.sou) で書き出す (開発モード)。システムごとに 1 ファイル。
 * 書き出せる操作 (前提の状態か、判断する条件のある操作) が 1 つも無ければ、何もしない
 */
export async function exportSoutherToFolder(): Promise<boolean> {
  const st = useUntieStore.getState();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const { model } = useUntieStore.getState();
  const files = exportSoutherAll(model);
  if (files.length === 0) {
    st.pushToast("書き出せる操作がありません。分析で、操作に前提の状態か、判断する条件を結んでください", "error");
    return false;
  }
  try {
    const saved = await getPlatform().saveTextFiles(
      files.map((f) => ({ name: f.fileName, text: f.text })),
      { zipName: `${safeFileName(model.meta.name.trim() || "名前なし")}-souther.zip`, zipFolder: SOUTHER_DIR },
    );
    if (!saved) return false;
    const owed = files.reduce((n, f) => n + f.owed, 0);
    st.pushToast(`業務ルールを「${saved.where}」に書き出しました (${saved.count} ファイル)${owed > 0 ? `。答え待ちの行が ${owed} 件あります` : ""}`, "info");
    return true;
  } catch (e) {
    st.pushToast(`書き出せませんでした: ${String(e)}`, "error");
    return false;
  }
}

/**
 * ドメインモデルを、distill-ddd (/ddd スキル) の成果物の形式 (docs/domain/*.md と .ddd-session.json) で書き出す。
 * 書き出すフォルダを選ぶ (リポジトリの docs/domain)。フォルダを選べないブラウザでは zip にまとめる
 */
export async function exportDomainDocsToFolder(): Promise<boolean> {
  const st = useUntieStore.getState();
  // 入力中の名前・説明を確定させてから書き出す
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const { model } = useUntieStore.getState();
  const docs = exportDomainDocs(model, { today: new Date().toISOString().slice(0, 10) });
  if (docs.files.length === 0) {
    st.pushToast("書き出すドメインモデルがありません。設計モードのドメインボードで、境界づけられたコンテキストを作ってください", "error");
    return false;
  }
  try {
    const saved = await getPlatform().saveTextFiles(docs.files, { zipName: `${safeFileName(model.meta.name.trim() || "名前なし")}-domain.zip`, zipFolder: DOMAIN_DOCS_DIR, keep: [DOMAIN_SESSION_FILE] });
    if (!saved) return false;
    const note = docs.warnings.length > 0 ? `。英語名が無いなど、distill-ddd の図に出ないものが ${docs.warnings.length} 件あります (設計モードの検証で確かめられます)` : "";
    // distill-ddd が進み具合を書いているセッションのファイルは、既にあれば上書きしない
    const kept = saved.kept.length > 0 ? `。${saved.kept.join("・")} は既にあるので、そのままにしました` : "";
    st.pushToast(`ドメインモデルを「${saved.where}」に書き出しました (${saved.count} ファイル)${kept}${note}`, "info");
    return true;
  } catch (e) {
    st.pushToast(`書き出せませんでした: ${String(e)}`, "error");
    return false;
  }
}
