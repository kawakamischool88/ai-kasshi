-- =============================================================
-- 0010: 消した・直した内容が、別の道から戻ってこないようにする（Phase 3D）
--
-- 【なぜ必要か】
-- 記憶だけを消しても、元の会話は残る（本人が読み返せるようにするため）。
-- ところが会話のやりとりは、次の返事を作るときにAIへ送っている。
-- つまり──
--
--   本人「締め日は20日です」
--   AI  「20日なんですね」
--   （そのあと 25日 に訂正）
--   → 次の返事を作るとき、上のやりとりがAIへ送られ、
--     AIは「20日」をいまの情報として読んでしまう。
--
-- 記憶を消しても、**会話の文脈という別の道から古い内容が戻ってくる**。
--
-- 【Ver.0.1 の直し方】
-- 文章の一部を消すような細かい加工はしない（やり損なうと危ない）。
-- 影響を受けたやりとりを**まるごとAIへ送らない**という安全側の方式にする。
-- 画面の過去会話はそのまま残る（本人は読み返せる）。
-- =============================================================

-- -------------------------------------------------------------
-- 1. 「AIへ送らない」印
-- -------------------------------------------------------------
alter table public.messages
  -- この時刻以降、このやりとりはAIへ送らない（画面には出る）
  add column excluded_from_ai_at timestamptz,
  -- なぜ送らないことにしたか（corrected / updated / deleted）
  add column exclusion_reason text;

comment on column public.messages.excluded_from_ai_at is
  'AIへ送らないことにした日時。訂正・削除の影響を受けたやりとりに付く。画面には出る。';

create index messages_context_idx
  on public.messages (conversation_id, excluded_from_ai_at, created_at);

-- -------------------------------------------------------------
-- 2. 影響を受けたやりとりに印を付ける
--
-- 印を付けるのは次の3つ。
--   ① その記憶のもとになった本人の発言
--   ② そのすぐあとのAIの返事（内容をなぞっていることが多い）
--   ③ その記憶を使ったAIの返事
-- -------------------------------------------------------------
create function public.exclude_memory_context(memory uuid, reason text)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  src uuid;
  conv uuid;
  src_at timestamptz;
  affected integer := 0;
  n integer;
begin
  if me is null then
    return 0;
  end if;

  select m.source_message_id, m.conversation_id into src, conv
  from public.memory_candidates m
  where m.id = memory and m.user_id = me;

  if src is null then
    return 0;
  end if;

  select created_at into src_at from public.messages where id = src;

  -- ① もとになった本人の発言
  update public.messages
  set excluded_from_ai_at = now(), exclusion_reason = reason
  where id = src and user_id = me and excluded_from_ai_at is null;
  get diagnostics n = row_count;
  affected := affected + n;

  -- ② そのすぐあとのAIの返事
  update public.messages
  set excluded_from_ai_at = now(), exclusion_reason = reason
  where user_id = me
    and excluded_from_ai_at is null
    and id = (
      select id from public.messages
      where conversation_id = conv and role = 'assistant' and created_at > src_at
      order by created_at
      limit 1
    );
  get diagnostics n = row_count;
  affected := affected + n;

  -- ③ その記憶を使ったAIの返事
  update public.messages
  set excluded_from_ai_at = now(), exclusion_reason = reason
  where user_id = me
    and excluded_from_ai_at is null
    and id in (select r.message_id from public.memory_references r where r.memory_id = memory);
  get diagnostics n = row_count;
  affected := affected + n;

  return affected;
end;
$$;

comment on function public.exclude_memory_context(uuid, text) is
  '訂正・削除の影響を受けたやりとりに「AIへ送らない」印を付ける。画面からは消さない。';

revoke all on function public.exclude_memory_context(uuid, text) from public;
grant execute on function public.exclude_memory_context(uuid, text) to authenticated;

-- -------------------------------------------------------------
-- 3. 記憶に「版」を見えるようにする
--
-- 返事を作っている途中で記憶が変わっていないかを確かめるため、
-- 検索で使う view から版も読めるようにする。
-- -------------------------------------------------------------
create or replace view public.confirmed_memories
  with (security_invoker = true)
  as
  select
    id,
    user_id,
    conversation_id,
    source_message_id,
    coalesce(confirmed_text, suggested_text) as text,
    origin,
    requested_by_user,
    created_at,
    confirmed_at,
    version
  from public.memory_candidates
  where status = 'confirmed';

comment on view public.confirmed_memories is
  '本人が確認して確定した記憶だけ。未確定の候補は含まない。検索・AI回答にはこれを使う。';

-- -------------------------------------------------------------
-- 4. 出典の「墓標」（本文を持たない削除の跡）
--
-- 会話ごと消すと、その会話から作った記憶も消える。
-- すると、**別の会話の過去の返事**に付いていた出典の表示ごと消えてしまい、
-- 「何かを参考にしていた」という事実まで見えなくなっていた。
--
-- 記憶が消えても、出典の行は残す。
-- 残すのは「参照があった事実・消えたこと・消えた日時」だけ。本文は残さない。
-- -------------------------------------------------------------
alter table public.memory_references
  add column memory_deleted_at timestamptz;

comment on column public.memory_references.memory_deleted_at is
  '参考にした記憶が消えた日時。本文は残さない（墓標として事実だけ残す）。';

-- 記憶が消えたら、id は外れるが行は残る
alter table public.memory_references
  alter column memory_id drop not null;

alter table public.memory_references
  drop constraint memory_references_memory_id_fkey;

alter table public.memory_references
  add constraint memory_references_memory_id_fkey
  foreign key (memory_id) references public.memory_candidates (id) on delete set null;

/* 記憶が消える直前に、消えた日時を書いておく。
   security definer にしているのは、出典の表を
   利用者が書き換えられるようにしたくないため
   （memory_references に update のポリシーは作らない）。 */
create function public.mark_reference_deleted()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  update public.memory_references
  set memory_deleted_at = now()
  where memory_id = old.id and memory_deleted_at is null;
  return old;
end;
$$;

create trigger memory_candidates_mark_references
  before delete on public.memory_candidates
  for each row execute function public.mark_reference_deleted();

-- 同じ返事に、同じ記憶の墓標がいくつも並ばないようにする
drop index public.memory_references_uniq;
create unique index memory_references_uniq
  on public.memory_references (message_id, memory_id)
  where memory_id is not null;

-- memory_references には update / delete のポリシーを作らない（これまで通り）
-- ＝ 利用者もアプリも、出典を書き換えたり消したりできない
