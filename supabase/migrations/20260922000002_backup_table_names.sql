-- =============================================================
-- 0013: 「控える表の一覧」に抜けがないかを調べられるようにする（Phase 4A）
--
-- 【なぜ要るか】
-- 表を増やしたのに、控える一覧（src/config/backup.ts）へ足し忘れると、
-- 復元したときに**その表だけ空**になる。
-- しかも気づきにくい。件数が合っているように見えるため。
--
-- そこで「いまDBにある表の名前」を読めるようにして、
-- テストで一覧と突き合わせる。
--
-- 返すのは表の名前だけ。中身は返さない。
-- =============================================================

create function public.backup_table_names()
  returns table (name text)
  language sql
  security definer
  stable
  set search_path = public
as $$
  select c.relname::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'                      -- 表だけ（見え方＝view は含めない）
    and c.relname <> 'schema_migrations'
  order by c.relname;
$$;

comment on function public.backup_table_names() is
  'public にある表の名前だけを返す。控える一覧に抜けがないかを調べるため。中身は返さない。';

revoke all on function public.backup_table_names() from public;
grant execute on function public.backup_table_names() to authenticated;
