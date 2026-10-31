import { describe, expect, it } from "vitest";
import {
  CreateFileRequestSchema,
  CreateInvitationRequestSchema,
  CreateInvitationResponseSchema,
  FileDetailSchema,
  FileSummarySchema,
  FilesResponseSchema,
  InvitationInfoSchema,
  LinkInfoSchema,
  LinkResponseSchema,
  MemberSchema,
  ProvidersResponseSchema,
  PutLinkRequestSchema,
  PutMemberRequestSchema,
  RenameFileRequestSchema,
  TransferRequestSchema,
  UserSchema,
} from "../schemas";

const summary = {
  id: "abc",
  name: "宿泊",
  ownerId: "usr_1",
  ownerName: "山田",
  role: "owner",
  memberCount: 1,
  updatedAt: 2,
  createdAt: 1,
};

describe("CreateFileRequest", () => {
  it("name と model のどちらかを受ける", () => {
    expect(CreateFileRequestSchema.safeParse({ name: "新規" }).success).toBe(true);
    expect(CreateFileRequestSchema.safeParse({ model: { version: 1 } }).success).toBe(true);
  });
  it("空の名前・長すぎる名前・どちらも無い・両方ある、は拒む", () => {
    expect(CreateFileRequestSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(CreateFileRequestSchema.safeParse({ name: "a".repeat(201) }).success).toBe(false);
    expect(CreateFileRequestSchema.safeParse({}).success).toBe(false);
    expect(CreateFileRequestSchema.safeParse({ name: "a", model: {} }).success).toBe(false);
    expect(CreateFileRequestSchema.safeParse({ model: "x" }).success).toBe(false);
  });
  it("名前の前後の空白は落とす", () => {
    expect(CreateFileRequestSchema.parse({ name: "  新規 " })).toEqual({ name: "新規" });
  });
});

describe("RenameFileRequest", () => {
  it("name が要る", () => {
    expect(RenameFileRequestSchema.safeParse({ name: "x" }).success).toBe(true);
    expect(RenameFileRequestSchema.safeParse({}).success).toBe(false);
    expect(RenameFileRequestSchema.safeParse({ name: 1 }).success).toBe(false);
  });
});

describe("レスポンス", () => {
  it("FileSummary の正常と異常", () => {
    expect(FileSummarySchema.safeParse(summary).success).toBe(true);
    expect(FileSummarySchema.safeParse({ ...summary, deletedAt: 3 }).success).toBe(true);
    expect(FileSummarySchema.safeParse({ ...summary, role: "guest" }).success).toBe(false);
    expect(FileSummarySchema.safeParse({ ...summary, memberCount: "1" }).success).toBe(false);
  });
  it("FilesResponse", () => {
    expect(FilesResponseSchema.safeParse({ mine: [summary], shared: [] }).success).toBe(true);
    expect(FilesResponseSchema.safeParse({ mine: [summary] }).success).toBe(false);
  });
  it("User の avatarUrl は省略できる", () => {
    expect(UserSchema.safeParse({ id: "u", email: "a@b.c", name: "A" }).success).toBe(true);
    expect(UserSchema.safeParse({ id: "u", email: "a@b.c" }).success).toBe(false);
  });
  it("Providers は google と dev だけ", () => {
    expect(ProvidersResponseSchema.safeParse({ providers: ["google", "dev"] }).success).toBe(true);
    expect(ProvidersResponseSchema.safeParse({ providers: ["github"] }).success).toBe(false);
  });
});

describe("共有のリクエスト", () => {
  it("PutMemberRequest は editor / viewer だけ (owner は譲渡でだけ)", () => {
    expect(PutMemberRequestSchema.safeParse({ role: "editor" }).success).toBe(true);
    expect(PutMemberRequestSchema.safeParse({ role: "viewer" }).success).toBe(true);
    expect(PutMemberRequestSchema.safeParse({ role: "owner" }).success).toBe(false);
    expect(PutMemberRequestSchema.safeParse({ role: "guest" }).success).toBe(false);
    expect(PutMemberRequestSchema.safeParse({}).success).toBe(false);
    expect(PutMemberRequestSchema.safeParse({ role: "editor", extra: 1 }).success).toBe(false);
  });
  it("TransferRequest は userId が要る", () => {
    expect(TransferRequestSchema.safeParse({ userId: "usr_1" }).success).toBe(true);
    expect(TransferRequestSchema.safeParse({ userId: "" }).success).toBe(false);
    expect(TransferRequestSchema.safeParse({}).success).toBe(false);
  });
  it("CreateInvitationRequest はメールを小文字にそろえ、空白を落とし、形を見る", () => {
    expect(CreateInvitationRequestSchema.parse({ email: "  Hanako@Example.COM ", role: "viewer" })).toEqual({ email: "hanako@example.com", role: "viewer" });
    expect(CreateInvitationRequestSchema.safeParse({ email: "hanako", role: "viewer" }).success).toBe(false);
    expect(CreateInvitationRequestSchema.safeParse({ email: "a@b.c", role: "owner" }).success).toBe(false);
    expect(CreateInvitationRequestSchema.safeParse({ email: "a@b.c" }).success).toBe(false);
  });
  it("PutLinkRequest の regenerate は省略できる", () => {
    expect(PutLinkRequestSchema.safeParse({}).success).toBe(true);
    expect(PutLinkRequestSchema.safeParse({ regenerate: true }).success).toBe(true);
    expect(PutLinkRequestSchema.safeParse({ regenerate: "yes" }).success).toBe(false);
  });
});

describe("共有のレスポンス", () => {
  const member = { userId: "usr_1", email: "a@b.c", name: "A", role: "editor", addedAt: 5 };
  it("FileDetail の members・invitations・link は省略できる (owner 以外は受け取らない)", () => {
    expect(FileDetailSchema.safeParse(summary).success).toBe(true);
    expect(
      FileDetailSchema.safeParse({
        ...summary,
        members: [member],
        invitations: [{ id: "h", email: "x@y.z", role: "viewer", createdAt: 1, expiresAt: 2 }],
        link: { enabled: true },
      }).success,
    ).toBe(true);
    expect(FileDetailSchema.safeParse({ ...summary, link: { enabled: "yes" } }).success).toBe(false);
  });
  it("Member は addedAt が要る", () => {
    expect(MemberSchema.safeParse(member).success).toBe(true);
    expect(MemberSchema.safeParse({ ...member, addedAt: undefined }).success).toBe(false);
  });
  it("CreateInvitationResponse は kind で分かれる", () => {
    expect(CreateInvitationResponseSchema.safeParse({ kind: "member", userId: "u" }).success).toBe(true);
    expect(CreateInvitationResponseSchema.safeParse({ kind: "invitation", invitationId: "i", url: "https://x/#/invite/t" }).success).toBe(true);
    expect(CreateInvitationResponseSchema.safeParse({ kind: "invitation", invitationId: "i" }).success).toBe(false);
    expect(CreateInvitationResponseSchema.safeParse({ kind: "other" }).success).toBe(false);
  });
  it("InvitationInfo・LinkInfo・LinkResponse", () => {
    expect(InvitationInfoSchema.safeParse({ fileName: "f", role: "viewer", email: "a@b.c", inviterName: "太郎", expired: false }).success).toBe(true);
    expect(InvitationInfoSchema.safeParse({ fileName: "f", role: "owner", email: "a@b.c", inviterName: "太郎", expired: false }).success).toBe(false);
    expect(LinkInfoSchema.safeParse({ fileId: "f", name: "n", role: "guest" }).success).toBe(true);
    expect(LinkInfoSchema.safeParse({ fileId: "f", name: "n", role: "admin" }).success).toBe(false);
    expect(LinkResponseSchema.safeParse({ enabled: true, url: "https://x/#/link/t" }).success).toBe(true);
    expect(LinkResponseSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(LinkResponseSchema.safeParse({ enabled: false }).success).toBe(false);
  });
});
