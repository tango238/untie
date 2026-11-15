// 共通の仕組みが投げるエラー。status は、HTTP で返すときのステータス

export class AppKitError extends Error {
  readonly status: number;
  constructor(name: string, status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = name;
    this.status = status;
  }
}

/** ログインしていない・トークンが正しくない (401) */
export class UnauthenticatedError extends AppKitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("UnauthenticatedError", 401, message, options);
  }
}

/** ログインしているが、その操作を行えない (403) */
export class ForbiddenError extends AppKitError {
  readonly reason: string;
  constructor(reason: string) {
    super("ForbiddenError", 403, "この操作を行う権限がありません");
    this.reason = reason;
  }
}

/** 監査の記録を残せなかった (500)。記録を残せない操作は、行ったことにしない */
export class AuditError extends AppKitError {
  constructor(options: { cause: unknown }) {
    super("AuditError", 500, "監査の記録を残せませんでした", options);
  }
}
