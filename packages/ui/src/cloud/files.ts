// クラウドファイルの一覧と操作 (設計書 8.2)。サーバーの API (7.4) を呼び、結果をこのストアに持つ。
// 操作の失敗は ApiError の message (画面にそのまま出せる日本語) をトーストで出す。
import { create } from "zustand";
import type { CreateFileRequest, FileSummary } from "@untie/api";
import type { UntieModel } from "@untie/core/model/types";
import { parseModel, safeFileName, serializeModel } from "../io/document";
import { getPlatform } from "../platform";
import { useUntieStore } from "../store";
import { getApi, onUnauthorized } from "./api";

export interface FilesState {
  /** 自分のファイル */
  mine: FileSummary[];
  /** 共有されたファイル */
  shared: FileSummary[];
  /** ゴミ箱 (自分が消したもの) */
  trash: FileSummary[];
  loading: boolean;
  /** 一覧を 1 度でも読み終えたか (最初の読み込み中の表示に使う) */
  loaded: boolean;
  /** 一覧を読めなかったときの理由 */
  error: string | null;

  /** 一覧とゴミ箱を読み直す */
  refresh: () => Promise<void>;
  /** 作る。`{ name }` で空のモデル、`{ model }` でローカルのモデルを取り込む。作れたら一覧を読み直し、作ったファイルを返す */
  create: (request: { name: string } | { model: UntieModel }) => Promise<FileSummary | null>;
  rename: (id: string, name: string) => Promise<boolean>;
  duplicate: (id: string) => Promise<FileSummary | null>;
  /** JSON に書き出す (保存先は Platform が選ばせる。デスクトップでも動くようダウンロード URL は使わない) */
  exportToFile: (id: string) => Promise<boolean>;
  /** ゴミ箱に入れる */
  trashFile: (id: string) => Promise<boolean>;
  restore: (id: string) => Promise<boolean>;
  /** 完全に消す */
  purge: (id: string) => Promise<boolean>;
  /** 一覧を空に戻す (ログアウトしたとき) */
  reset: () => void;
}

/** 名前が空のモデルや名前は「名前なし」にして送る (サーバーは空の名前を断るため) */
export const UNNAMED = "名前なし";

function toRequest(request: { name: string } | { model: UntieModel }): CreateFileRequest {
  if ("model" in request) {
    const { model } = request;
    const named = model.meta.name.trim() ? model : { ...model, meta: { ...model.meta, name: UNNAMED } };
    return { model: named as unknown as Record<string, unknown> };
  }
  return { name: request.name.trim() || UNNAMED };
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toast = (message: string, tone: "info" | "error" = "info") => useUntieStore.getState().pushToast(message, tone);

// 読み込みが重なったとき、あとから始めたものだけを反映する
let refreshSeq = 0;

export const useFilesStore = create<FilesState>()((set, get) => {
  /** 操作を実行し、失敗したらトーストに出す。成功したら true を返し、一覧を読み直す */
  async function act<T>(run: () => Promise<T>, onDone?: (result: T) => string | void): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const value = await run();
      const message = onDone?.(value);
      if (message) toast(message);
      await get().refresh();
      return { ok: true, value };
    } catch (e) {
      toast(messageOf(e), "error");
      return { ok: false };
    }
  }

  return {
    mine: [],
    shared: [],
    trash: [],
    loading: false,
    loaded: false,
    error: null,

    refresh: async () => {
      const seq = ++refreshSeq;
      set({ loading: true });
      try {
        const api = getApi();
        const [{ mine, shared }, trash] = await Promise.all([api.files.list(), api.files.trashList()]);
        if (seq === refreshSeq) set({ mine, shared, trash, loading: false, loaded: true, error: null });
      } catch (e) {
        if (seq !== refreshSeq) return;
        set({ loading: false, loaded: true, error: messageOf(e) });
        toast(messageOf(e), "error");
      }
    },

    create: async (request) => {
      const body = toRequest(request);
      const result = await act(
        () => getApi().files.create(body),
        (file) => `クラウドに「${file.name}」を作りました`,
      );
      return result.ok ? result.value : null;
    },

    rename: async (id, name) => (await act(() => getApi().files.rename(id, name))).ok,

    duplicate: async (id) => {
      const result = await act(
        () => getApi().files.duplicate(id),
        (file) => `「${file.name}」を作りました`,
      );
      return result.ok ? result.value : null;
    },

    exportToFile: async (id) => {
      try {
        const exported = await getApi().files.export(id);
        const { mine, shared, trash } = get();
        const name = [...mine, ...shared, ...trash].find((f) => f.id === id)?.name ?? exported.filename.replace(/\.json$/i, "");
        const parsed = parseModel(exported.text);
        if (!parsed.ok) {
          toast(`「${name}」を書き出せません: ${parsed.errors.slice(0, 3).join(" / ")}`, "error");
          return false;
        }
        const saved = await getPlatform().saveTextFile(serializeModel(parsed.model), null, `${safeFileName(name)}.json`);
        if (saved) toast(`「${saved.name}」に書き出しました`);
        return saved !== null;
      } catch (e) {
        toast(messageOf(e), "error");
        return false;
      }
    },

    trashFile: async (id) => (await act(() => getApi().files.trash(id))).ok,
    restore: async (id) => (await act(() => getApi().files.restore(id))).ok,
    purge: async (id) => (await act(() => getApi().files.purge(id))).ok,

    reset: () => {
      refreshSeq++;
      set({ mine: [], shared: [], trash: [], loading: false, loaded: false, error: null });
    },
  };
});

/** いま編集中のローカルのモデルをクラウドに新しいファイルとして作る。ローカルの編集はそのまま続けられる */
export async function saveLocalToCloud(): Promise<FileSummary | null> {
  // 入力中の名前・説明を確定させ、ドラッグ中なら確定してから取る (saveDocument と同じ)
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const st = useUntieStore.getState();
  if (st.dragBase) st.commitDrag();
  return useFilesStore.getState().create({ model: useUntieStore.getState().model });
}

// 使っている途中で 401 を受けた・ログアウトしたら、一覧を空にする (session ストアとは api.ts の購読口でだけつながる)
onUnauthorized(() => useFilesStore.getState().reset());
