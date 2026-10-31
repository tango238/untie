// 共有 (メンバー・招待・リンク) のテストで使う小さな部品
import { expect, vi } from "vitest";
import { issueTicket } from "../auth/ticket";
import type { TicketClaims } from "../auth/ticket";
import { env, userIdOf } from "./helpers";
import type { Client } from "./helpers";
import { connectRoom, expectClient } from "./roomClient";
import type { RoomClient } from "./roomClient";

/** workerd の時計は I/O や待ちで進む。kick の時刻より後に発行したチケットにするため、少し待つ */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** ファイルを作る (中身は空のモデル) */
export async function createFile(owner: Client, name = "共有"): Promise<string> {
  return (await owner.json("/api/files", { method: "POST", json: { name } })).body.id;
}

/** メンバー行を D1 に直接足す (API を通さずに状態を作りたいとき) */
export async function addMember(fileId: string, userId: string, role: "editor" | "viewer"): Promise<void> {
  await env.DB.prepare("insert into file_members (file_id, user_id, role, added_by, added_at) values (?, ?, ?, ?, ?)")
    .bind(fileId, userId, role, null, Date.now())
    .run();
}

/** owner の API でメンバーにする (相手はログイン済みのユーザー) */
export async function share(owner: Client, fileId: string, other: Client, role: "editor" | "viewer"): Promise<string> {
  const userId = await userIdOf(other);
  const { status } = await owner.json(`/api/files/${fileId}/members/${userId}`, { method: "PUT", json: { role } });
  if (status !== 200) throw new Error(`メンバーにできません: ${status}`);
  return userId;
}

/** チケットの発行から接続、手元の Doc がサーバーと同期するまで */
export async function join(client: Client, fileId: string): Promise<RoomClient> {
  const ticket = (await client.json(`/api/files/${fileId}/ticket`, { method: "POST" })).body.ticket;
  const room = expectClient(await connectRoom(fileId, ticket));
  await room.sync();
  return room;
}

export async function joinWith(fileId: string, claims: Omit<TicketClaims, "fileId">): Promise<RoomClient> {
  const { ticket } = await issueTicket(env, { fileId, ...claims });
  const room = expectClient(await connectRoom(fileId, ticket));
  await room.sync();
  return room;
}

/** 接続が閉じられるまで待って、閉じたコードを返す */
export async function closedCode(room: RoomClient): Promise<number> {
  await vi.waitFor(() => expect(room.closed).not.toBeNull());
  return room.closed!.code;
}

/** リンクの URL (`.../#/link/<token>`) からトークンを取り出す */
export function tokenOf(url: string, kind: "link" | "invite"): string {
  const marker = `/#/${kind}/`;
  const at = url.indexOf(marker);
  if (at < 0) throw new Error(`URL の形が違います: ${url}`);
  return url.slice(at + marker.length);
}

/** リンク・招待のトークンを運ぶヘッダー (パスに置くと Workers のログに残るため) */
export const tok = (token: string): Record<string, string> => ({ "X-Untie-Token": token });
