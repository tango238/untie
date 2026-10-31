// このパッケージは DOM にも Worker の型にも依存しない (lib は ES2022、types は空)。
// 使う fetch の型だけをここで最小限に宣言する。Web・デスクトップ・Worker の側から取り込まれるときは、
// この宣言は読まれず、それぞれの本物の fetch / RequestInit / Response が使われる (構造が合うものだけを使うこと)。

interface RequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  credentials?: "omit" | "same-origin" | "include";
}

interface Response {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare function fetch(input: string, init?: RequestInit): Promise<Response>;
