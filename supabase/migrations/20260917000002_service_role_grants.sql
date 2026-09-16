-- =============================================================
-- 0004: 管理用ロール（service_role）へのテーブル権限
--
-- 経緯：開発用データの掃除スクリプトで
--   「permission denied for table conversations」(42501) が返った。
--   この Supabase プロジェクトでは、新しく作ったテーブルに対する権限が
--   service_role にも自動では付かないため、ここで明示する。
--
-- 注意：service_role は RLS を素通りする強い権限。
--   使ってよいのは scripts/ と tests/ だけで、アプリ本体（src/）では使わない。
--   この方針は AGENTS.md にも書いてある。
--
--   ai_usage は利用者からは書き換え・削除できないが、
--   管理作業（開発データの掃除・保守）のために service_role には許可する。
-- =============================================================

grant all on table public.profiles to service_role;
grant all on table public.conversations to service_role;
grant all on table public.messages to service_role;
grant all on table public.ai_usage to service_role;
