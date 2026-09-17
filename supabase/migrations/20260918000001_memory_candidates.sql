-- =============================================================
-- 0005: 記憶候補（Phase 3A）
--
-- 会話から「後で本人の役に立ちそうな内容」を候補として取り出し、
-- 本人が［残す］を選んだものだけを確定記憶にする。
--
-- 【1つの表で扱う理由】
-- 候補と確定記憶は、同じ1行の状態が変わったものとして扱う。
-- いつ提案され、いつ本人が確認し、本人が文章をどう直したかが1行に残るため、
-- 出典をたどりやすい。
--
-- 【取り違えを防ぐ仕組み】
-- ただし「未確定の候補」を確定記憶として使ってしまう事故は絶対に避けたい。
-- そこで確定済みだけを見せる view（confirmed_memories）を用意する。
-- Phase 3B 以降の検索・AI回答への注入は、必ずこの view を使うこと。
--
-- Phase 3A では、確定記憶をAI回答へ再利用する機能は作らない。
-- 訂正・考えの更新・削除は Phase 3C。
-- =============================================================

create table public.memory_candidates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,

  -- 出典：この候補のもとになった「本人の発言」
  -- 将来1つの記憶に複数の出典を持たせるときは、
  -- memory_sources という別の表に切り出す（Phase 3A では1件のみ）
  source_message_id uuid not null references public.messages (id) on delete cascade,

  -- 同じ発言から作る候補の通し番号（1 または 2）。
  -- source_message_id との組で重複を禁止し、
  -- 二重実行や再試行で同じ候補が増えないようにする
  candidate_index smallint not null check (candidate_index between 1 and 2),

  -- AIが提案した候補の文章
  suggested_text text not null,
  -- 本人が確定した最終文章（［直す］で編集したときは編集後の文章）
  confirmed_text text,

  /* 情報の由来。AIの提案を「本人が考えたこと」に混ぜないための区別。
       self_experience … 本人の経験・認識の申告
       third_party     … 本人が紹介した第三者の発言
       tentative       … 仮定・検討中の案
       ai_suggestion   … AIカッシーが提案しただけの案（本人は採用していない）
       ai_adopted      … AIの提案を本人が採用したもの
     ※ ai_suggestion は Phase 3A では候補にしない（本人の記憶ではないため）。
        区別のために値だけ用意しておく。 */
  origin text not null check (origin in (
    'self_experience', 'third_party', 'tentative', 'ai_suggestion', 'ai_adopted'
  )),

  -- 本人が「覚えておいて」等、はっきり保存を希望したか
  requested_by_user boolean not null default false,

  /* 状態
       pending   … 本人確認待ち
       confirmed … 本人が［残す］を選んだ（確定記憶）
       rejected  … 本人が［残さない］を選んだ
       expired   … 期限切れ（作成から30日）。確定できない */
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'rejected', 'expired')),

  created_at timestamptz not null default now(),          -- 候補作成日時
  confirmed_at timestamptz,                                -- 本人確認日時
  expires_at timestamptz not null default now() + interval '30 days',

  -- 評価用：なぜ候補にしたかのAIの説明。
  -- 「候補を出しすぎていないか」を見直すための記録で、本人の画面には出さない
  extraction_reason text
);

comment on table public.memory_candidates is
  '記憶候補。本人が［残す］を選んだ行（status=confirmed）だけが確定記憶。';
comment on column public.memory_candidates.candidate_index is
  '同じ発言から作る候補の通し番号。source_message_id との組で一意にして二重登録を防ぐ。';
comment on column public.memory_candidates.origin is
  '情報の由来。AIの提案を本人の考えとして保存しないための区別。';

-- 同じ発言から同じ候補を繰り返し作らない（二重実行・再試行の対策）
create unique index memory_candidates_source_uniq
  on public.memory_candidates (source_message_id, candidate_index);

-- 本人確認待ちの一覧を引くため
create index memory_candidates_pending_idx
  on public.memory_candidates (user_id, status, expires_at);

create index memory_candidates_conversation_idx
  on public.memory_candidates (conversation_id, created_at);

-- =============================================================
-- 確定記憶だけを見せる view
--
-- Phase 3B 以降の検索・AI回答への注入は、必ずこの view を使う。
-- security_invoker = true にしているので、view 越しでも
-- 元の表の RLS がそのまま効く（他人の記憶は見えない）。
-- これを付け忘れると view が RLS を素通りしてしまう。
-- =============================================================
create view public.confirmed_memories
  with (security_invoker = true)
  as
  select
    id,
    user_id,
    conversation_id,
    source_message_id,
    -- 本人が直した文章があればそちら、なければ提案文をそのまま
    coalesce(confirmed_text, suggested_text) as text,
    origin,
    requested_by_user,
    created_at,
    confirmed_at
  from public.memory_candidates
  where status = 'confirmed';

comment on view public.confirmed_memories is
  '本人が確認して確定した記憶だけ。未確定の候補は含まない。検索・AI回答にはこれを使う。';

-- =============================================================
-- RLS
-- =============================================================
alter table public.memory_candidates enable row level security;

create policy "memory_candidates_select_own" on public.memory_candidates
  for select to authenticated using (auth.uid() = user_id);

-- 自分名義であることに加えて、会話も自分のものであることを確かめる
create policy "memory_candidates_insert_own" on public.memory_candidates
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

-- ［残す］［直す］［残さない］による状態の変更
create policy "memory_candidates_update_own" on public.memory_candidates
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- delete のポリシーは意図的に作らない。
-- 記憶の削除は Phase 3C で、消した記録を残す形で実装する。
-- anon 向けのポリシーも作らない＝全拒否

-- =============================================================
-- テーブル権限（この Supabase では自動で付かないため明示する）
-- =============================================================
grant select, insert, update on table public.memory_candidates to authenticated;
grant select on public.confirmed_memories to authenticated;
grant all on table public.memory_candidates to service_role;
grant select on public.confirmed_memories to service_role;

-- anon には何も grant しない
