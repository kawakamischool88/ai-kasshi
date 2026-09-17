-- =============================================================
-- 0007: 記憶の訂正・考えの変化・削除（Phase 3C）
--
-- 【3つを同じ処理にしない】
--   訂正       … 内容が間違っていた。旧版は無効になる
--   考えの変化 … 間違っていたわけではない。旧版は「過去の考え」として残る
--   削除       … 本人が消したいと言った。本文を消し、記録だけ残す
--
-- 【AIに自由な書き換え権限を与えない】
-- AIができるのは「対象を探して提案する」ところまで（memory_revision_requests）。
-- 実際に記憶を書き換えるのは、本人が画面でボタンを押したときだけ。
--
-- 【ゾンビ記憶を作らない】
-- 削除した記憶が、元の会話・再抽出・古い処理・バックアップ復元から
-- ふたたび「有効な記憶」として復活しないようにする。
-- =============================================================

-- -------------------------------------------------------------
-- 1. 記憶に「版」と「関係」を持たせる
-- -------------------------------------------------------------

/* 状態を増やす。
     superseded … 訂正されて無効になった旧版（通常検索・回答に使わない）
     archived   … 考えが変わる前の「過去の考え」（昔を聞かれたときだけ使う）
     deleted    … 本人が削除した（本文は消す。記録だけ残る） */
alter table public.memory_candidates
  drop constraint memory_candidates_status_check;

alter table public.memory_candidates
  add constraint memory_candidates_status_check check (status in (
    'pending', 'confirmed', 'rejected', 'expired',
    'superseded', 'archived', 'deleted'
  ));

alter table public.memory_candidates
  -- この記憶が置き換えた旧記憶（訂正前 ／ 以前の考え）
  add column revision_of uuid references public.memory_candidates (id) on delete set null,
  -- 置き換えの種類。correction＝訂正、update＝考えの変化
  add column revision_kind text check (revision_kind in ('correction', 'update')),
  -- この記憶を置き換えた新しい記憶
  add column superseded_by uuid references public.memory_candidates (id) on delete set null,
  -- 何代目か。訂正・変化のたびに1つ増える
  add column version integer not null default 1,
  -- 訂正・変化が行われた日時（＝本人が確認した日時）
  add column revised_at timestamptz,
  -- 削除した日時
  add column deleted_at timestamptz;

comment on column public.memory_candidates.revision_of is
  '置き換えた旧記憶。訂正・考えの変化で作られた行だけが持つ。';
comment on column public.memory_candidates.revision_kind is
  'correction＝訂正（旧版は無効）、update＝考えの変化（旧版は過去の考えとして残る）。';
comment on column public.memory_candidates.version is
  '何代目の内容か。もとの記憶が1、訂正・変化のたびに1つ増える。';

-- 置き換えの行には、必ず種類が付いていること
alter table public.memory_candidates
  add constraint memory_candidates_revision_pair_check
  check ((revision_of is null) = (revision_kind is null));

/* 削除した記憶は、本文を持たないこと。
   「削除した本文を履歴に残し続けない」を、DBの決まりとして守らせる。 */
alter table public.memory_candidates
  add constraint memory_candidates_deleted_has_no_text
  check (status <> 'deleted' or (suggested_text is null and confirmed_text is null));

-- 削除時に本文を消せるようにする
alter table public.memory_candidates
  alter column suggested_text drop not null;

/* 二重登録を防ぐ一意の決まりは「自動で取り出した候補」だけが対象。
   訂正・変化で作る行（revision_of がある行）は対象外にする。
   これがないと、同じ発言から2回訂正できなくなる。 */
drop index public.memory_candidates_source_uniq;
create unique index memory_candidates_source_uniq
  on public.memory_candidates (source_message_id, candidate_index)
  where revision_of is null;

create index memory_candidates_revision_idx
  on public.memory_candidates (revision_of);

-- 「過去の考え」を引くため
create index memory_candidates_archived_idx
  on public.memory_candidates (user_id, status, revised_at desc);

-- -------------------------------------------------------------
-- 2. 過去の考えだけを見せる view
--
-- 通常の検索は confirmed_memories（現在有効な内容）だけを見る。
-- 「昔はどう考えていた？」と聞かれたときだけ、こちらも見る。
-- 訂正された旧版（superseded）は入れない。間違いだった内容を
-- 「昔の考え」として持ち出さないため。
-- -------------------------------------------------------------
create view public.past_memories
  with (security_invoker = true)
  as
  select
    id,
    user_id,
    conversation_id,
    source_message_id,
    coalesce(confirmed_text, suggested_text) as text,
    origin,
    version,
    revised_at,
    superseded_by,
    created_at,
    confirmed_at
  from public.memory_candidates
  where status = 'archived';

comment on view public.past_memories is
  '考えが変わる前の「過去の考え」。訂正された旧版は含まない。昔を聞かれたときだけ使う。';

-- -------------------------------------------------------------
-- 3. 削除の記録（本文を持たない）
--
-- 【なぜ外部キーを張らないか】
-- 元の会話ごと消したときも、古いバックアップから戻したときも、
-- 「これは削除された」という事実だけは残っていてほしい。
-- 外部キーを張ると、参照先が消えたときに削除の記録まで一緒に消えてしまう。
-- -------------------------------------------------------------
create table public.memory_deletions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  -- 消した記憶。外部キーは張らない（上のコメントの理由）
  memory_id uuid not null,
  -- もとになった本人の発言。同じ発言から作り直さないための印
  source_message_id uuid,
  conversation_id uuid,

  /* 削除の範囲
       memory_only  … この記憶だけ消す（元の会話は残す）
       conversation … 元の会話ごと消す */
  scope text not null check (scope in ('memory_only', 'conversation')),

  deleted_at timestamptz not null default now()
);

comment on table public.memory_deletions is
  '削除の記録。本文は持たない。同じ内容を作り直さないための印にもなる。';
comment on column public.memory_deletions.memory_id is
  '消した記憶のid。外部キーは張らない（参照先が消えても削除の事実を残すため）。';

create unique index memory_deletions_uniq
  on public.memory_deletions (user_id, memory_id);

-- 「この発言から作り直してよいか」を調べるため
create index memory_deletions_source_idx
  on public.memory_deletions (user_id, source_message_id);

-- -------------------------------------------------------------
-- 4. 記憶の操作の提案（AIが探し、本人が決める）
--
-- AIは「これのことですか？」と対象を挙げるところまで。
-- 実際に書き換えるのは、本人がボタンを押したとき。
-- -------------------------------------------------------------
create table public.memory_revision_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- 本人が「それ違うよ」等と言った発言
  source_message_id uuid not null references public.messages (id) on delete cascade,
  -- 同じ発言から出す提案の通し番号（1 または 2）。曖昧なときは2件まで
  request_index smallint not null check (request_index between 1 and 2),

  /* 本人が求めていると思われる操作
       correct … 間違いの訂正
       update  … 考えの変化
       delete  … 削除 */
  intent text not null check (intent in ('correct', 'update', 'delete')),

  -- 対象の記憶。消えたら提案も消えてよい
  target_memory_id uuid not null references public.memory_candidates (id) on delete cascade,
  -- 訂正・変化のときの新しい文章の案。削除のときは null
  proposed_text text,
  -- なぜこの記憶が対象だと考えたかの説明（評価用。本人の画面には出さない）
  reason text,

  status text not null default 'pending'
    check (status in ('pending', 'done', 'dismissed')),

  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

comment on table public.memory_revision_requests is
  'AIが見つけた「訂正・変化・削除の対象候補」。本人が決めるまで何も起きない。';

create unique index memory_revision_requests_uniq
  on public.memory_revision_requests (source_message_id, request_index);

create index memory_revision_requests_pending_idx
  on public.memory_revision_requests (user_id, status, created_at desc);

-- -------------------------------------------------------------
-- 5. 持ち主の確認を、再帰せずに行う関数
--
-- RLS の条件の中で同じ表を読むと無限に回ってしまう。
-- security definer の関数に切り出して、ログイン中の本人のものかだけを返す。
-- （auth.uid() を使っているので、他人の行では必ず false になる）
-- -------------------------------------------------------------
create function public.owns_memory(target uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  select exists (
    select 1 from public.memory_candidates
    where id = target and user_id = auth.uid()
  );
$$;

comment on function public.owns_memory(uuid) is
  'その記憶がログイン中の本人のものか。RLSの中で同じ表を読むための関数。';

revoke all on function public.owns_memory(uuid) from public;
grant execute on function public.owns_memory(uuid) to authenticated;

-- -------------------------------------------------------------
-- 6. RLS
-- -------------------------------------------------------------

/* memory_candidates の追加・更新に、
   「置き換えの相手も自分のものか」の確認を足す。
   これがないと、他人の記憶を自分の記憶の旧版に見せかけられる。 */
drop policy "memory_candidates_insert_own" on public.memory_candidates;
create policy "memory_candidates_insert_own" on public.memory_candidates
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
    and (revision_of is null or public.owns_memory(revision_of))
    and (superseded_by is null or public.owns_memory(superseded_by))
  );

drop policy "memory_candidates_update_own" on public.memory_candidates;
create policy "memory_candidates_update_own" on public.memory_candidates
  for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (revision_of is null or public.owns_memory(revision_of))
    and (superseded_by is null or public.owns_memory(superseded_by))
  );

-- delete のポリシーは引き続き作らない。記憶は「消した記録を残す形」で消す

-- ---------- memory_deletions ----------
alter table public.memory_deletions enable row level security;

create policy "memory_deletions_select_own" on public.memory_deletions
  for select to authenticated using (auth.uid() = user_id);

create policy "memory_deletions_insert_own" on public.memory_deletions
  for insert to authenticated with check (auth.uid() = user_id);

-- update / delete のポリシーは作らない。
-- 削除の記録を取り消せてしまうと、消したものが復活しうる

-- ---------- memory_revision_requests ----------
alter table public.memory_revision_requests enable row level security;

create policy "memory_revision_requests_select_own" on public.memory_revision_requests
  for select to authenticated using (auth.uid() = user_id);

/* 自分名義であることに加えて、
   会話・発言・対象の記憶がすべて自分のものであることを確かめる */
create policy "memory_revision_requests_insert_own" on public.memory_revision_requests
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
    and exists (
      select 1 from public.messages m
      where m.id = source_message_id and m.user_id = auth.uid()
    )
    and public.owns_memory(target_memory_id)
  );

-- ［やめる］や実行後の状態変更のため
create policy "memory_revision_requests_update_own" on public.memory_revision_requests
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- anon 向けのポリシーはどの表にも作らない＝全拒否

-- -------------------------------------------------------------
-- 7. テーブル権限（この Supabase では自動で付かないため明示する）
-- -------------------------------------------------------------
grant select on public.past_memories to authenticated;
grant select on public.past_memories to service_role;

grant select, insert on table public.memory_deletions to authenticated;
grant all on table public.memory_deletions to service_role;

grant select, insert, update on table public.memory_revision_requests to authenticated;
grant all on table public.memory_revision_requests to service_role;

-- anon には何も grant しない
