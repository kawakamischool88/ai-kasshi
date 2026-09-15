-- =============================================================
-- 0001: profiles（利用者ごとの基本情報）と、ユーザー分離の土台
--
-- 方針（Phase 1 で確定）
--   * すべての利用者データは「誰のものか」を auth.users の id で持つ
--   * 行の持ち主は必ず auth.uid()（ログイン情報）から決まる
--     → クライアントが送ってきた user_id は一切信用しない
--   * RLS を有効にし、自分の行だけ 読取/作成/更新/削除 できる
--   * ログインしていない（anon）状態では何も見えない
--   * アプリ本体は service_role を使わない（この方針はコード側でも守る）
-- =============================================================

create table public.profiles (
  -- auth.users.id と同じ値。ユーザー削除時は一緒に消える
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  -- 動作確認用のメモ（iPad の音声入力が保存まで通るかを確かめる欄）
  memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is '利用者の基本情報。id は auth.users.id と同一。';

-- ---------- RLS ----------
alter table public.profiles enable row level security;

-- ログイン済みユーザーは「自分の行」だけ
create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = id);

-- 作成時も「自分の id」以外は拒否（他人の id を名乗る作成を防ぐ）
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

-- 更新は自分の行だけ。id を他人に書き換えることも拒否
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles_delete_own"
  on public.profiles for delete
  to authenticated
  using (auth.uid() = id);

-- anon（未ログイン）向けのポリシーは意図的に作らない＝全拒否

-- ---------- 新規ユーザーの行を自動作成 ----------
-- auth.users に行が入ったら profiles にも作る。
-- security definer なのは、auth スキーマ側のトリガーから public へ書くため。
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- updated_at を自動で進める ----------
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();
