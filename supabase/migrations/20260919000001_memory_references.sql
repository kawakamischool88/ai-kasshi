-- =============================================================
-- 0006: 出典の記録（Phase 3B）
--
-- AIカッシーが回答を作るときに、実際に使った確定記憶を記録する。
--
-- 【候補と実際に使ったものを区別する】
-- 検索で「関係がありそう」と選ばれた記憶と、AIが実際に回答へ使った記憶は違う。
-- ここに記録するのは **実際に使った記憶だけ**。
-- 使っていないものを出典として出すと、本人に嘘を伝えることになる。
--
-- 訂正・考えの更新・削除は Phase 3C。ここでは作らない。
-- =============================================================

create table public.memory_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- どのAIの返事で使ったか
  message_id uuid not null references public.messages (id) on delete cascade,
  -- どの確定記憶を使ったか
  memory_id uuid not null references public.memory_candidates (id) on delete cascade,

  created_at timestamptz not null default now()
);

comment on table public.memory_references is
  'AIが回答に実際に使った確定記憶の記録。出典表示のもと。検索で候補になっただけのものは含まない。';

-- 同じ返事に同じ記憶を二重に記録しない
create unique index memory_references_uniq
  on public.memory_references (message_id, memory_id);

create index memory_references_message_idx
  on public.memory_references (message_id);

-- =============================================================
-- RLS
-- =============================================================
alter table public.memory_references enable row level security;

create policy "memory_references_select_own" on public.memory_references
  for select to authenticated using (auth.uid() = user_id);

/* 自分名義であることに加えて、
   「その返事が自分のものか」「その記憶が自分の確定記憶か」も確かめる。
   これがないと、他人の記憶を自分の返事の出典に見せかけられてしまう。 */
create policy "memory_references_insert_own" on public.memory_references
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.messages m
      where m.id = message_id and m.user_id = auth.uid()
    )
    and exists (
      select 1 from public.memory_candidates mc
      where mc.id = memory_id
        and mc.user_id = auth.uid()
        and mc.status = 'confirmed'
    )
  );

-- update / delete のポリシーは作らない。出典は後から書き換えない記録
-- anon 向けのポリシーも作らない＝全拒否

-- =============================================================
-- テーブル権限
-- =============================================================
grant select, insert on table public.memory_references to authenticated;
grant all on table public.memory_references to service_role;

-- anon には何も grant しない
