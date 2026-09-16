-- =============================================================
-- 0002: profiles のテーブル権限を明示する
--
-- 経緯：開発用 Supabase で anon から profiles を読むと
--   「permission denied for table profiles」(42501) が返った。
--   新しいプロジェクトでは、public のテーブルに対する権限が
--   自動では付かないため、必要な権限をここで明示的に与える。
--
-- 方針：
--   * authenticated（ログイン済み）… 4操作を許可。ただし RLS により自分の行だけ
--   * anon（未ログイン）… 何も与えない＝テーブルに触れることすらできない
--   * service_role … scripts/ と tests/ が使う。テーブル所有者経由で元々アクセス可
-- =============================================================

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.profiles to authenticated;

-- anon には意図的に何も grant しない。
-- 将来 anon に読ませる必要が出ても、まず RLS ポリシーの設計を見直すこと。
