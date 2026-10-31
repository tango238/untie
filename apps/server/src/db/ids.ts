import { nanoid } from "nanoid";

/** 接頭辞付きの id (usr_ + nanoid) */
export function newId(prefix: string): string {
  return `${prefix}_${nanoid()}`;
}

/** ファイルの id。nanoid 21 文字 (= ルーム名) */
export function newFileId(): string {
  return nanoid();
}
