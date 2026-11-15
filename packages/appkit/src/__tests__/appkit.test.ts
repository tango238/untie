import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { deriveAccessPolicy } from "@untie/core/model";
import { createHotelSample } from "@untie/core/sample";
import {
  AuditError,
  authenticate,
  createOperations,
  createTokenVerifier,
  decide,
  findOperation,
  ForbiddenError,
  memoryAuditSink,
  systemPrincipal,
  UnauthenticatedError,
  type AccessPolicy,
  type Principal,
} from "../index";

const ISSUER = "https://idp.example.test";
const AUDIENCE = "sys_pms";
let keys: JSONWebKeySet;
let sign: (claims: Record<string, unknown>, o?: { issuer?: string; audience?: string; expired?: boolean; key?: CryptoKey }) => Promise<string>;
let otherKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  otherKey = (await generateKeyPair("RS256")).privateKey;
  keys = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] };
  sign = (claims, o = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(o.issuer ?? ISSUER)
      .setAudience(o.audience ?? AUDIENCE)
      .setIssuedAt(o.expired ? Math.floor(Date.now() / 1000) - 7200 : undefined)
      .setExpirationTime(o.expired ? Math.floor(Date.now() / 1000) - 3600 : "5m")
      .sign(o.key ?? pair.privateKey);
});

const verifier = () => createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keys, systemId: "sys_pms" });

describe("createTokenVerifier: IdP のトークンを確かめて、操作を行う人にする", () => {
  it("このシステムの役割だけを読む (ほかのシステムの役割・形の違うものは捨てる)", async () => {
    const token = await sign({ sub: "u1", roles: ["sys_pms:actor_front", "sys_accounting:actor_front", "actor_manager", 3, "sys_pms:actor_front"] });
    expect(await verifier()(token)).toEqual({ kind: "user", subject: "u1", roles: ["actor_front"] });
  });

  it("役割が、名前をキーにしたオブジェクトで入っているクレームも読める", async () => {
    const verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, keys, systemId: "sys_pms", rolesClaim: "urn:example:roles" });
    const token = await sign({ sub: "u1", "urn:example:roles": { "sys_pms:actor_reservation": { org: "x" } } });
    expect((await verify(token)).roles).toEqual(["actor_reservation"]);
  });

  it("役割のクレームが無ければ、役割は空 (ログインはできるが、何も行えない)", async () => {
    expect(await verifier()(await sign({ sub: "u1" }))).toEqual({ kind: "user", subject: "u1", roles: [] });
  });

  it("署名・発行者・宛先・期限のどれかが違えば、通さない", async () => {
    const bad = [
      await sign({ sub: "u1" }, { key: otherKey }),
      await sign({ sub: "u1" }, { issuer: "https://evil.example.test" }),
      await sign({ sub: "u1" }, { audience: "sys_accounting" }),
      await sign({ sub: "u1" }, { expired: true }),
      await sign({}),
      "not-a-token",
    ];
    for (const token of bad) await expect(verifier()(token)).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("authenticate: リクエストから、操作を行う人を得る", () => {
  it("Authorization: Bearer のトークンを確かめる", async () => {
    const token = await sign({ sub: "u1", roles: ["sys_pms:actor_front"] });
    const request = new Request("https://app.example.test/x", { headers: { authorization: `Bearer ${token}` } });
    expect(await authenticate(request, verifier())).toEqual({ kind: "user", subject: "u1", roles: ["actor_front"] });
  });

  it("トークンが無い・Bearer でないときは 401", async () => {
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }] as Record<string, string>[]) {
      const error = await authenticate(new Request("https://app.example.test/x", { headers }), verifier()).catch((e) => e);
      expect(error).toBeInstanceOf(UnauthenticatedError);
      expect(error.status).toBe(401);
    }
  });
});

const policy: AccessPolicy = {
  format: 1,
  systemId: "sys",
  system: "受付システム",
  roles: [
    { id: "clerk", name: "受付係" },
    { id: "guest", name: "申込者" },
  ],
  operations: [
    { id: "register", name: "申し込みを登録する", allow: [{ role: "clerk" }], byEvent: false, informations: [{ id: "info", name: "申し込み", access: "write" }] },
    { id: "change", name: "申し込みを変更する", allow: [{ role: "clerk" }, { role: "guest", own: true }], byEvent: false, informations: [] },
    { id: "notify", name: "結果を知らせる", allow: [], byEvent: true, informations: [] },
  ],
};
const user = (subject: string, ...roles: string[]): Principal => ({ kind: "user", subject, roles });

describe("decide: 権限表を引く", () => {
  const op = (id: string) => findOperation(policy, id);
  it("役割があれば行える。無ければ行えない", () => {
    expect(decide(op("register"), user("u1", "clerk"))).toEqual({ allowed: true, role: "clerk" });
    expect(decide(op("register"), user("u2", "guest"))).toEqual({ allowed: false, reason: "noRole" });
    expect(decide(op("register"), user("u3"))).toEqual({ allowed: false, reason: "noRole" });
  });

  it("本人のものに限る役割は、対象の持ち主が本人のときだけ行える (持ち主が分からなければ、行えない)", () => {
    expect(decide(op("change"), user("u2", "guest"), { owner: "u2" })).toEqual({ allowed: true, role: "guest" });
    expect(decide(op("change"), user("u2", "guest"), { owner: "u9" })).toEqual({ allowed: false, reason: "notOwner" });
    expect(decide(op("change"), user("u2", "guest"))).toEqual({ allowed: false, reason: "notOwner" });
    expect(decide(op("change"), user("u1", "clerk"), { owner: "u9" })).toEqual({ allowed: true, role: "clerk" });
    expect(decide(op("change"), user("u1", "guest", "clerk"), { owner: "u9" })).toEqual({ allowed: true, role: "clerk" });
  });

  it("システム自身は、出来事をきっかけにした操作だけを行える。人は、役割が無ければ行えない", () => {
    expect(decide(op("notify"), systemPrincipal("sys"))).toEqual({ allowed: true, role: null });
    expect(decide(op("register"), systemPrincipal("sys"))).toEqual({ allowed: false, reason: "notByEvent" });
    expect(decide(op("notify"), user("u1", "clerk"))).toEqual({ allowed: false, reason: "noRole" });
  });

  it("表に無い操作は、エラーにする", () => {
    expect(() => findOperation(policy, "nothing")).toThrow("権限表に無い操作です");
  });
});

describe("createOperations: 操作の入口 (権限 → 処理 → 監査)", () => {
  const setup = () => {
    const audit = memoryAuditSink();
    let n = 0;
    const ops = createOperations({ policy, audit, now: () => new Date("2026-11-15T01:02:03Z"), newId: () => `a${++n}` });
    return { audit, ops };
  };

  it("行えたら、処理の結果を返し、記録を 1 件残す", async () => {
    const { audit, ops } = setup();
    const value = await ops.run({ principal: user("u1", "clerk"), operation: "register" }, (ctx) => {
      ctx.record({ targets: [{ information: "info", key: "A-1" }], before: {} });
      ctx.record({ result: "done", after: { 申し込みの状態: "受付済" } });
      return 42;
    });
    expect(value).toBe(42);
    expect(audit.records).toEqual([
      {
        id: "a1",
        at: "2026-11-15T01:02:03.000Z",
        system: "sys",
        operation: { id: "register", name: "申し込みを登録する" },
        actor: { kind: "user", subject: "u1", role: "clerk" },
        outcome: "done",
        result: "done",
        informations: [{ id: "info", name: "申し込み", access: "write" }],
        targets: [{ information: "info", key: "A-1" }],
        before: {},
        after: { 申し込みの状態: "受付済" },
      },
    ]);
  });

  it("権限が無ければ、処理を呼ばずに 403 にし、断ったことを記録する", async () => {
    const { audit, ops } = setup();
    let called = false;
    const error = await ops.run({ principal: user("u2", "guest"), operation: "change", target: { owner: "u9" } }, () => void (called = true)).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.status).toBe(403);
    expect(called).toBe(false);
    expect(audit.records).toMatchObject([{ outcome: "denied", reason: "notOwner", actor: { subject: "u2", role: null }, operation: { id: "change" } }]);
  });

  it("処理が失敗したら、そのエラーをそのまま投げ、失敗を記録する (メッセージは載せない)", async () => {
    const { audit, ops } = setup();
    const boom = new TypeError("秘密の値 12345");
    await expect(ops.run({ principal: user("u1", "clerk"), operation: "register" }, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(audit.records).toMatchObject([{ outcome: "failed", reason: "TypeError" }]);
    expect(JSON.stringify(audit.records)).not.toContain("12345");
  });

  it("出来事をきっかけにした操作は、システム自身として行う", async () => {
    const { audit, ops } = setup();
    await ops.run({ principal: systemPrincipal("sys"), operation: "notify" }, () => undefined);
    expect(audit.records).toMatchObject([{ outcome: "done", actor: { kind: "system", subject: "sys", role: null } }]);
  });

  it("記録を残せなければ、行ったことにしない (AuditError)。その 1 回だけの置き場所も渡せる", async () => {
    const { audit, ops } = setup();
    const broken = { append: () => Promise.reject(new Error("disk full")) };
    const error = await ops.run({ principal: user("u1", "clerk"), operation: "register", audit: broken }, () => 1).catch((e) => e);
    expect(error).toBeInstanceOf(AuditError);
    expect(error.status).toBe(500);
    expect(audit.records).toEqual([]);
    const once = memoryAuditSink();
    await ops.run({ principal: user("u1", "clerk"), operation: "register", audit: once }, () => 1);
    expect(once.records).toHaveLength(1);
    expect(audit.records).toEqual([]);
  });

  it("表に無い操作は、処理を呼ばずにエラーにする", async () => {
    const { ops } = setup();
    await expect(ops.run({ principal: user("u1", "clerk"), operation: "nothing" }, () => 1)).rejects.toThrow("権限表に無い操作です");
  });
});

describe("untie が書き出した権限表を、そのまま使える", () => {
  it("宿泊サンプルの宿泊管理システム: トークンの役割で、行える操作が決まる", async () => {
    const derived = deriveAccessPolicy(createHotelSample(), "sys_pms");
    // 書き出したファイル (JSON) を読んだものを渡す
    const hotel: AccessPolicy = JSON.parse(JSON.stringify(derived));
    const audit = memoryAuditSink();
    const ops = createOperations({ policy: hotel, audit });
    const id = (name: string) => hotel.operations.find((o) => o.name === name)!.id;
    const front = await verifier()(await sign({ sub: "front-1", roles: ["sys_pms:actor_front"] }));

    await expect(ops.run({ principal: front, operation: id("チェックインを記録する") }, () => "ok")).resolves.toBe("ok");
    await expect(ops.run({ principal: front, operation: id("予約を確定する") }, () => "ok")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ops.run({ principal: front, operation: id("請求金額を計算する") }, () => "ok")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(ops.run({ principal: systemPrincipal("sys_pms"), operation: id("請求金額を計算する") }, () => "ok")).resolves.toBe("ok");
    expect(audit.records.map((r) => [r.operation.name, r.outcome])).toEqual([
      ["チェックインを記録する", "done"],
      ["予約を確定する", "denied"],
      ["請求金額を計算する", "denied"],
      ["請求金額を計算する", "done"],
    ]);
  });
});
