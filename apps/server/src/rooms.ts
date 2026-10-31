import { getServerByName } from "partyserver";
import type { UntieModel } from "@untie/core";
import type { KickTarget } from "@untie/collab/room";
import type { Env } from "./env";

/** Durable Object は最初に作られた場所に留まるので、作成の経路すべてで locationHint を付ける (設計書 3.7) */
export const LOCATION_HINT = "apac" as const;

/**
 * ファイルのルーム (RPC を呼ぶスタブ)。1 クラウドファイル = 1 ルーム、名前はファイルの id。
 * UntieModel は RPC の型変換でタプル型が崩れるので、モデルを渡す・受ける呼び出しは下の関数を使う
 */
export function getRoom(env: Pick<Env, "UntieRoom">, fileId: string) {
  return getServerByName(env.UntieRoom, fileId, { locationHint: LOCATION_HINT });
}

type RoomEnv = Pick<Env, "UntieRoom">;

export async function importRoomModel(env: RoomEnv, fileId: string, model: UntieModel): Promise<void> {
  const room = await getRoom(env, fileId);
  await room.importModel(model as never);
}

export async function exportRoomModel(env: RoomEnv, fileId: string): Promise<UntieModel> {
  const room = await getRoom(env, fileId);
  return (await room.exportModel()) as unknown as UntieModel;
}

export async function renameRoom(env: RoomEnv, fileId: string, name: string): Promise<void> {
  await (await getRoom(env, fileId)).rename(name);
}

export async function destroyRoom(env: RoomEnv, fileId: string): Promise<void> {
  await (await getRoom(env, fileId)).destroy();
}

/** kick の対象として正しい形か。userId は空でない文字列 (null や空でゲストを巻き込まない) */
function isKickTarget(target: unknown): target is KickTarget {
  if (typeof target !== "object" || target === null) return false;
  const t = target as Record<string, unknown>;
  if (t.all === true) return true;
  if (t.via === "link") return true;
  return typeof t.userId === "string" && t.userId !== "" && (t.reason === undefined || t.reason === "roleChanged" || t.reason === "removed");
}

/**
 * ルームの接続を閉じる (役割が変わった・外された・リンクが無効・ゴミ箱に入った)。閉じた数を返す。
 * 不正な対象はここで例外にする (ルームの RPC の中で投げず、呼び出し側のバグをルームに届ける前に止める)
 */
export async function kickRoom(env: RoomEnv, fileId: string, target: KickTarget): Promise<number> {
  if (!isKickTarget(target)) throw new Error("kick の対象が正しくありません");
  return (await getRoom(env, fileId)).kick(target);
}

/**
 * 共有の API(メンバー・譲渡・リンクの変更)が、D1 を書き換えたあとに呼ぶ kick。
 * 失敗しても D1 は変わっているので、例外にせず (500 にすると再試行されず、接続が残る) ログにだけ出す。
 * 再試行の経路 (すでに外した人への DELETE など) でも呼んで、切れていなかった接続を切る
 */
export async function kickRoomQuietly(env: RoomEnv, fileId: string, target: KickTarget): Promise<void> {
  try {
    await kickRoom(env, fileId, target);
  } catch (e) {
    // トークンやメールを出さないよう、メッセージだけを残す
    console.error(`ルームの接続を切れませんでした (${fileId})`, e instanceof Error ? e.message : e);
  }
}
