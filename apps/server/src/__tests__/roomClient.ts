// ルームにつなぐテスト用の WebSocket クライアント。y-protocols の形 (先頭の varuint が 0 = sync / 1 = awareness) を最小限だけ手で扱う
import { SELF } from "cloudflare:test";
import * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

function varUint(n: number): number[] {
  const bytes: number[] = [];
  while (n > 127) {
    bytes.push(128 | (n & 127));
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return bytes;
}

function readVarUint(buf: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (pos >= buf.length) throw new Error("メッセージが途中で終わっています");
    const byte = buf[pos++];
    value += (byte & 127) * scale;
    if (byte < 128) return [value, pos];
    scale *= 128;
  }
}

const withLength = (bytes: Uint8Array): number[] => [...varUint(bytes.length), ...bytes];

/** sync メッセージ: 0, <type>, varUint8Array */
export const syncMessage = (type: number, payload: Uint8Array) => new Uint8Array([MESSAGE_SYNC, type, ...withLength(payload)]);
/** update を y-protocols の sync update (0, 2, update) に包む */
export const updateMessage = (update: Uint8Array) => syncMessage(SYNC_UPDATE, update);
/** step1 (自分の状態ベクトルを渡して、相手の差分を求める) */
export const step1Message = (doc: Y.Doc) => syncMessage(SYNC_STEP1, Y.encodeStateVector(doc));

/** awareness の更新 1 件 (clientID, clock, JSON の状態) を awareness メッセージ (1, varUint8Array) に包む */
export function awarenessMessage(clientId: number, clock: number, state: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(state));
  const update = new Uint8Array([...varUint(1), ...varUint(clientId), ...varUint(clock), ...withLength(json)]);
  return new Uint8Array([MESSAGE_AWARENESS, ...withLength(update)]);
}

export interface RoomClient {
  ws: WebSocket;
  /** サーバーと同期する手元の Doc。サーバーからの step2 / update を取り込み、手元の変更は自動で update として送る */
  doc: Y.Doc;
  /** 受け取った awareness メッセージの中身 (JSON の状態の文字列)。メッセージに複数の更新が入っていても、1 件目だけを読む */
  awareness: string[];
  /** 閉じられたときのコードと理由。まだなら null */
  closed: { code: number; reason: string } | null;
  send(message: Uint8Array): void;
  /** step1 を送り、サーバーの step2 が返るまで待つ。直前までに送ったメッセージがサーバーで処理済みになる (順序が保たれるため) */
  sync(): Promise<void>;
  close(): void;
}

const clients = new Set<RoomClient>();

/** 開いたままの接続を全部閉じる (テストの後始末) */
export function closeAllClients(): void {
  for (const client of clients) client.close();
  clients.clear();
}

/** ルームへ WebSocket でつなぐ。受け付けられなければ（101 以外）レスポンスを返す */
export async function connectRoom(roomId: string, ticket: string | null, extraQuery = ""): Promise<RoomClient | Response> {
  const params = [ticket === null ? "" : `ticket=${encodeURIComponent(ticket)}`, extraQuery].filter(Boolean).join("&");
  const query = params ? `?${params}` : "";
  const response = await SELF.fetch(`http://x/parties/untie-room/${roomId}${query}`, { headers: { Upgrade: "websocket" } });
  if (response.status !== 101 || !response.webSocket) return response;
  const ws = response.webSocket;
  // 既定は Blob。同期で読めるよう ArrayBuffer にする
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  ws.accept();

  const doc = new Y.Doc();
  let step2Count = 0;
  const waiters: (() => void)[] = [];
  const client: RoomClient = {
    ws,
    doc,
    awareness: [],
    closed: null,
    send: (message) => ws.send(message),
    async sync() {
      const target = step2Count + 1;
      ws.send(step1Message(doc));
      await new Promise<void>((resolve) => {
        const check = () => {
          if (step2Count >= target || client.closed) resolve();
          else waiters.push(check);
        };
        check();
      });
    },
    close: () => {
      try {
        ws.close(1000, "テスト終了");
      } catch {
        /* すでに閉じている */
      }
    },
  };

  ws.addEventListener("message", (event) => {
    const data = event.data;
    if (typeof data === "string") return;
    const buf = new Uint8Array(data as ArrayBuffer);
    const [kind, p1] = readVarUint(buf, 0);
    if (kind === MESSAGE_SYNC) {
      const [type, p2] = readVarUint(buf, p1);
      const [length, p3] = readVarUint(buf, p2);
      const payload = buf.slice(p3, p3 + length);
      if (type === SYNC_STEP1) {
        ws.send(syncMessage(SYNC_STEP2, Y.encodeStateAsUpdate(doc, payload)));
      } else {
        Y.applyUpdate(doc, payload, "remote");
        if (type === SYNC_STEP2) step2Count++;
      }
    } else if (kind === MESSAGE_AWARENESS) {
      const [length, p2] = readVarUint(buf, p1);
      const update = buf.slice(p2, p2 + length);
      // 読むのは 1 件目だけ (テストが送るのは 1 件だけの更新): count, clientID, clock, 長さ付きの JSON
      const [, q1] = readVarUint(update, 0);
      const [, q2] = readVarUint(update, q1);
      const [, q3] = readVarUint(update, q2);
      const [jsonLength, q4] = readVarUint(update, q3);
      client.awareness.push(new TextDecoder().decode(update.slice(q4, q4 + jsonLength)));
    }
    for (const waiter of waiters.splice(0)) waiter();
  });
  ws.addEventListener("close", (event) => {
    client.closed = { code: event.code, reason: event.reason };
    for (const waiter of waiters.splice(0)) waiter();
  });
  // 手元の変更 (サーバーから来たもの以外) は update として送る
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote" && !client.closed) ws.send(updateMessage(update));
  });

  clients.add(client);
  return client;
}

/** connectRoom の結果が接続できたものだと確かめる */
export function expectClient(result: RoomClient | Response): RoomClient {
  if (result instanceof Response) throw new Error(`接続できません: ${result.status}`);
  return result;
}
