import { getServerByName } from "partyserver";
import type { UntieModel } from "@untie/core";
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
