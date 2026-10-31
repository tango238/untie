import { describe, expect, it } from "vitest";
import {
  CreateFileRequestSchema,
  FileSummarySchema,
  FilesResponseSchema,
  ProvidersResponseSchema,
  RenameFileRequestSchema,
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
