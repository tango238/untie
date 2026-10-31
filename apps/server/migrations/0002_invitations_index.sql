-- 招待の一覧 (ファイルごとの未承諾) と、同じメール宛の置き換え・メンバー追加時の削除を速くする
create index invitations_file on invitations(file_id, accepted_at);
