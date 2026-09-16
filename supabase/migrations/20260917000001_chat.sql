-- =============================================================
-- 0003: 会話・メッセージ・AI利用量（Phase 2）
--
-- Phase 1 で確立した標準型をそのまま適用する。
--   * 行の持ち主は user_id（auth.users.id）
--   * RLS を有効にし、auth.uid() = user_id の行だけを許す
--   * authenticated にだけ GRANT する。anon には何も与えない
--   * アプリ本体は service_role を使わない
--
-- 長期記憶・記憶候補は Phase 3。ここでは作らない。
-- =============================================================

-- ---------- 会話 ----------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 一覧に出す見出し。最初の発言から自動で作る（AIは呼ばない）
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一覧を新しい順に並べるための時刻
  last_message_at timestamptz not null default now()
);

comment on table public.conversations is '会話のまとまり。1行＝1つの会話。';

create index conversations_user_recent_idx
  on public.conversations (user_id, last_message_at desc);

-- ---------- メッセージ ----------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- 会話にも持ち主がいるが、メッセージ側にも持たせて RLS を単純・確実にする
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now(),
  -- 二重送信対策。画面が送信ごとに作る ID。同じ ID は2回保存できない
  client_request_id uuid
);

comment on table public.messages is '会話の1発言。role は user か assistant。';
comment on column public.messages.client_request_id is
  '二重送信対策。同じ利用者が同じIDで2回保存することはできない。';

create index messages_conversation_idx
  on public.messages (conversation_id, created_at);

create unique index messages_client_request_uniq
  on public.messages (user_id, client_request_id)
  where client_request_id is not null;

-- ---------- AI利用量・推定原価 ----------
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- 会話が消えても原価の記録は残す（set null）
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,

  -- 何のための呼び出しか。Phase 2 では 'chat' のみ。将来 'memory_extract' 等が増える
  operation_type text not null,
  provider text not null,
  model text not null,

  -- APIの usage からそのまま写す（課金に関わる項目）
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_creation_5m_tokens integer not null default 0,
  cache_creation_1h_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  -- 思考ぶんのトークン。output_tokens に含まれるので二重に課金しない（内訳の記録用）
  thinking_tokens integer not null default 0,
  service_tier text,

  -- 推定原価。実際の請求と後から突き合わせられるよう、単価の版も一緒に残す
  estimated_cost numeric(12, 6) not null default 0,
  currency text not null default 'USD',
  pricing_version text not null,
  pricing_date date not null,

  -- success … API が成功
  -- error   … API が失敗（原価は0。何が起きたかは error_code）
  -- blocked … 原価の停止値に達していて呼び出さなかった
  status text not null check (status in ('success', 'error', 'blocked')),
  error_code text,
  duration_ms integer,

  created_at timestamptz not null default now()
);

comment on table public.ai_usage is
  'AI呼び出し1回ぶんの記録。推定原価と実際の請求を突き合わせるため、単価の版も残す。';

create index ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at desc);

-- =============================================================
-- RLS
-- =============================================================
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_usage enable row level security;

-- ---------- conversations ----------
create policy "conversations_select_own" on public.conversations
  for select to authenticated using (auth.uid() = user_id);

create policy "conversations_insert_own" on public.conversations
  for insert to authenticated with check (auth.uid() = user_id);

create policy "conversations_update_own" on public.conversations
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "conversations_delete_own" on public.conversations
  for delete to authenticated using (auth.uid() = user_id);

-- ---------- messages ----------
create policy "messages_select_own" on public.messages
  for select to authenticated using (auth.uid() = user_id);

-- 自分名義であることに加えて、会話そのものが自分のものであることも確かめる。
-- これがないと「自分の user_id で他人の会話にメッセージを混ぜる」ことができてしまう。
create policy "messages_insert_own" on public.messages
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

create policy "messages_update_own" on public.messages
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "messages_delete_own" on public.messages
  for delete to authenticated using (auth.uid() = user_id);

-- ---------- ai_usage ----------
-- 読む・足す はできるが、書き換え・削除はできない。
-- 原価の記録は後から書き換えない（請求との突き合わせを守るため）。
create policy "ai_usage_select_own" on public.ai_usage
  for select to authenticated using (auth.uid() = user_id);

create policy "ai_usage_insert_own" on public.ai_usage
  for insert to authenticated with check (auth.uid() = user_id);

-- update / delete のポリシーは意図的に作らない＝全拒否
-- anon 向けのポリシーもどのテーブルにも作らない＝全拒否

-- =============================================================
-- テーブル権限（新しい Supabase では自動で付かないため明示する）
-- =============================================================
grant select, insert, update, delete on table public.conversations to authenticated;
grant select, insert, update, delete on table public.messages to authenticated;
grant select, insert on table public.ai_usage to authenticated;

-- anon には何も grant しない

-- =============================================================
-- updated_at を自動で進める（0001 で作った関数を再利用）
-- =============================================================
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();
