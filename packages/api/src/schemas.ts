// API のリクエストとレスポンスの形 (設計書 7.4)。サーバーはリクエストの検証に、クライアントはレスポンスの検証に使う。
import { z } from "zod";

/** 名前の長さの上限 (一覧に出す名前なので長すぎるものは拒む) */
export const NAME_MAX_LENGTH = 200;

export const RoleSchema = z.enum(["owner", "editor", "viewer", "guest"]);
export const MemberRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const ProviderIdSchema = z.enum(["google", "dev"]);

const NameSchema = z.string().trim().min(1, "名前を入力してください").max(NAME_MAX_LENGTH, `名前は ${NAME_MAX_LENGTH} 文字までです`);

export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const FileSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerId: z.string(),
  ownerName: z.string(),
  /** 自分の役割 */
  role: MemberRoleSchema,
  memberCount: z.number().int(),
  /** エポックミリ秒 */
  updatedAt: z.number(),
  createdAt: z.number(),
  /** ゴミ箱に入れた日時。ゴミ箱の一覧だけが持つ */
  deletedAt: z.number().optional(),
});
export type FileSummary = z.infer<typeof FileSummarySchema>;

export const MemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  avatarUrl: z.string().optional(),
  role: MemberRoleSchema,
});
export type Member = z.infer<typeof MemberSchema>;

export const FileDetailSchema = FileSummarySchema.extend({
  /** メンバー一覧。所有者だけが受け取る */
  members: z.array(MemberSchema).optional(),
});
export type FileDetail = z.infer<typeof FileDetailSchema>;

export const FilesResponseSchema = z.object({
  mine: z.array(FileSummarySchema),
  shared: z.array(FileSummarySchema),
});
export type FilesResponse = z.infer<typeof FilesResponseSchema>;

export const TrashResponseSchema = z.object({ files: z.array(FileSummarySchema) });
export type TrashResponse = z.infer<typeof TrashResponseSchema>;

export const ProvidersResponseSchema = z.object({ providers: z.array(ProviderIdSchema) });
export type ProvidersResponse = z.infer<typeof ProvidersResponseSchema>;
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/** 作る。`{ name }` で空のモデル、`{ model }` で JSON を取り込む (中身の検証はサーバーが validateModel で行う) */
export const CreateFileRequestSchema = z.union([
  z.object({ name: NameSchema }).strict(),
  z.object({ model: z.record(z.string(), z.unknown()) }).strict(),
]);
export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>;

export const RenameFileRequestSchema = z.object({ name: NameSchema }).strict();
export type RenameFileRequest = z.infer<typeof RenameFileRequestSchema>;

/** `POST /files/:id/ticket` の返事。ticket は 60 秒だけ使える (設計書 7.5) */
export const TicketResponseSchema = z.object({
  ticket: z.string(),
  role: RoleSchema,
  /** エポックミリ秒 */
  expiresAt: z.number(),
});
export type TicketResponse = z.infer<typeof TicketResponseSchema>;

export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
