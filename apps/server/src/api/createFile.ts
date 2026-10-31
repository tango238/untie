import type { Context } from "hono";
import { validateModel } from "@untie/core";
import type { UntieModel } from "@untie/core";
import type { AppEnv } from "../env";
import { deleteFileRows, getFileForUser, insertFile, toSummary } from "../db/files";
import { newFileId } from "../db/ids";
import { conflict } from "../errors";
import { destroyRoom, exportRoomModel, importRoomModel } from "../rooms";

/** 行を作り、ルームに取り込む。取り込みに失敗したら行を消して元に戻す。作った人 (ログイン中のユーザー) が owner */
export async function createFile(c: Context<AppEnv>, model: UntieModel) {
  const id = newFileId();
  const now = Date.now();
  const name = model.meta.name;
  await insertFile(c.env.DB, { id, name, ownerId: c.var.user.id, now });
  try {
    await importRoomModel(c.env, id, model);
  } catch (e) {
    // ルームに一部でも書かれていたら消してから、行を消す。後始末の失敗は元の例外を隠さない
    await destroyRoom(c.env, id).catch(() => {});
    await deleteFileRows(c.env.DB, id);
    throw e;
  }
  const row = await getFileForUser(c.env.DB, id, c.var.user.id);
  return toSummary(row!);
}

/** ファイルの中身を複製して、ログイン中のユーザーが owner の新しいファイルにする (メンバーの複製とリンクからの複製で共有) */
export async function duplicateFile(c: Context<AppEnv>, fileId: string) {
  const model = await exportRoomModel(c.env, fileId);
  // 壊れた中身を新しいファイルに写さない (500 ではなく画面に出せる 409 で返す)
  if (!validateModel(model).ok) throw conflict("ファイルの中身が壊れているため複製できません", "broken_model");
  const copy: UntieModel = { ...model, meta: { ...model.meta, name: `${model.meta.name} のコピー`.slice(0, 200) } };
  return createFile(c, copy);
}
