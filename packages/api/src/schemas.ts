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
  /** メンバーになった日時 (エポックミリ秒) */
  addedAt: z.number(),
});
export type Member = z.infer<typeof MemberSchema>;

/** 招待できる役割 (owner は譲渡でだけ変わる) */
export const InviteRoleSchema = z.enum(["editor", "viewer"]);
export type InviteRole = z.infer<typeof InviteRoleSchema>;

/** まだ受けられていない招待 (所有者の共有ダイアログに出す)。id はトークンの SHA-256 で、トークンそのものではない */
export const InvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: InviteRoleSchema,
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

/** リンク閲覧の状態。`url` は作成・作り直しの応答でだけ返る (トークンは D1 にハッシュだけ置くため、あとから復元できない。3.6) */
export const LinkStatusSchema = z.object({ enabled: z.boolean(), url: z.string().optional() });
export type LinkStatus = z.infer<typeof LinkStatusSchema>;

export const FileDetailSchema = FileSummarySchema.extend({
  /** メンバー一覧。所有者だけが受け取る */
  members: z.array(MemberSchema).optional(),
  /** 受けられていない招待。所有者だけが受け取る */
  invitations: z.array(InvitationSchema).optional(),
  /** リンク閲覧の状態 (`enabled` だけ。`url` は返さない)。所有者だけが受け取る */
  link: LinkStatusSchema.optional(),
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

/** `PUT /files/:id/members/:userId`。役割を足す・変える (owner にはできない) */
export const PutMemberRequestSchema = z.object({ role: InviteRoleSchema }).strict();
export type PutMemberRequest = z.infer<typeof PutMemberRequestSchema>;

/** `POST /files/:id/transfer`。所有者を譲る相手 (すでにメンバーの人) */
export const TransferRequestSchema = z.object({ userId: z.string().min(1) }).strict();
export type TransferRequest = z.infer<typeof TransferRequestSchema>;

/** メールアドレス。前後の空白を除き、小文字にそろえてから形を見る */
const EmailSchema = z.string().trim().toLowerCase().pipe(z.email("メールアドレスの形が正しくありません").max(254));

/** `POST /files/:id/invitations` */
export const CreateInvitationRequestSchema = z.object({ email: EmailSchema, role: InviteRoleSchema }).strict();
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

/**
 * 招待の結果。すでにユーザーならその場でメンバーにする (`member`)。
 * まだユーザーでなければ招待を作り、画面から写して送る URL (`${origin}/#/invite/<トークン>`) を返す (`invitation`)
 */
export const CreateInvitationResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.string() }),
  z.object({ kind: z.literal("invitation"), invitationId: z.string(), url: z.string() }),
]);
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponseSchema>;

/** `GET /invitations/:token`。招待を受ける画面に出す中身 */
export const InvitationInfoSchema = z.object({
  fileName: z.string(),
  role: InviteRoleSchema,
  email: z.string(),
  inviterName: z.string(),
  expired: z.boolean(),
});
export type InvitationInfo = z.infer<typeof InvitationInfoSchema>;

/** `POST /invitations/:token/accept` */
export const AcceptInvitationResponseSchema = z.object({ fileId: z.string() });
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

/**
 * `PUT /files/:id/link` の結果。新しく有効にした・作り直したときは url にトークンが入る。
 * すでに有効で作り直しでもないときは何も変えず、url は返らない (トークンは D1 にハッシュだけ置くため、あとから復元できない)
 */
export const LinkResponseSchema = z.object({ enabled: z.literal(true), url: z.string().optional() });
export type LinkResponse = z.infer<typeof LinkResponseSchema>;

/** `PUT /files/:id/link` のリクエスト。`regenerate: true` で新しいトークンに置き換える */
export const PutLinkRequestSchema = z.object({ regenerate: z.boolean().optional() }).strict();
export type PutLinkRequest = z.infer<typeof PutLinkRequestSchema>;

/** `GET /links/info`。リンクのファイルと自分の役割 (メンバーならその役割、それ以外は guest) */
export const LinkInfoSchema = z.object({ fileId: z.string(), name: z.string(), role: RoleSchema });
export type LinkInfo = z.infer<typeof LinkInfoSchema>;

export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
