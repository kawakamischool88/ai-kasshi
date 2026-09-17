-- =============================================================
-- 0011: 訂正・削除のときに、古いやりとりもAIへ送らなくする（Phase 3D）
--
-- 0010 で作った印を、訂正・考えの変化・削除のときに付ける。
-- 記憶を消すだけでは足りない。
-- 元の会話に残っている古い内容が、次の返事を作るときに
-- AIへ送られてしまうため。
-- =============================================================

create or replace function public.revise_memory(
  target uuid,
  kind text,
  new_text text,
  in_conversation uuid,
  in_message uuid,
  note text default null
)
  returns uuid
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  old_row public.memory_candidates%rowtype;
  new_id uuid;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;
  if kind not in ('correction', 'update') then
    raise exception '訂正の種類が正しくありません' using errcode = '22023';
  end if;
  if new_text is null or btrim(new_text) = '' then
    raise exception '新しい内容が空です' using errcode = '22023';
  end if;

  /* 行を押さえてから読む。
     「いま現在有効な内容であること」を条件に入れているので、
     先に別の処理が直していたら found にならず、何も起きない。 */
  select * into old_row
  from public.memory_candidates
  where id = target
    and user_id = me
    and status = 'confirmed'
  for update;

  if not found then
    return null;
  end if;

  insert into public.memory_candidates (
    user_id, conversation_id, source_message_id, candidate_index,
    suggested_text, confirmed_text, origin, requested_by_user,
    status, confirmed_at, revised_at,
    version, revision_of, revision_kind, extraction_reason
  ) values (
    me, in_conversation, in_message, 1,
    btrim(new_text), btrim(new_text), old_row.origin, true,
    'confirmed', now(), now(),
    old_row.version + 1, old_row.id,
    kind, note
  )
  returning id into new_id;

  update public.memory_candidates
  set status = case when kind = 'correction' then 'superseded' else 'archived' end,
      superseded_by = new_id,
      revised_at = now()
  where id = old_row.id
    and status = 'confirmed';

  /* 古い内容が残っているやりとりを、AIへ送らないようにする。
     記憶だけ直しても、会話の文脈から古い内容が戻ってきてしまうため。
     画面の過去会話はそのまま残る。 */
  perform public.exclude_memory_context(
    old_row.id,
    case when kind = 'correction' then 'corrected' else 'updated' end
  );

  return new_id;
end;
$$;

comment on function public.revise_memory(uuid, text, text, uuid, uuid, text) is
  '訂正・考えの変化。新しい記憶を足し、古い記憶を無効化（または過去の考えに）し、古いやりとりをAIへ送らなくする。';

-- -------------------------------------------------------------

create or replace function public.delete_memory(target uuid)
  returns integer
  language plpgsql
as $$
declare
  me uuid := auth.uid();
  ids uuid[];
  one uuid;
  affected integer;
begin
  if me is null then
    raise exception 'ログインが必要です' using errcode = '42501';
  end if;

  -- つながっている版（訂正前・考えが変わる前）をまとめて対象にする
  select array_agg(c.id) into ids from public.memory_chain(target) c;

  -- 自分のものでない、または見つからない
  if ids is null or array_length(ids, 1) is null then
    return 0;
  end if;

  -- 行を押さえてから消す（同時に走った処理が古い内容を書き戻さないように）
  perform 1
  from public.memory_candidates m
  where m.id = any (ids)
  for update;

  /* 削除の記録を先に残す。
     あとで本文を消すので、消す前に「もとの発言」を控えておく。
     すでに記録があるもの（二度押し）は足さない。 */
  insert into public.memory_deletions (user_id, memory_id, source_message_id, conversation_id, scope)
  select m.user_id, m.id, m.source_message_id, m.conversation_id, 'memory_only'
  from public.memory_candidates m
  where m.id = any (ids)
    and m.user_id = me
  on conflict (user_id, memory_id) do nothing;

  /* 消した内容が残っているやりとりを、AIへ送らないようにする。
     本文を消しても、会話の文脈から戻ってきてしまうため。
     （本文を消す前に呼ぶ。もとの発言をたどる必要があるので） */
  foreach one in array ids loop
    perform public.exclude_memory_context(one, 'deleted');
  end loop;

  update public.memory_candidates
  set status = 'deleted',
      suggested_text = null,
      confirmed_text = null,
      deleted_at = now()
  where id = any (ids)
    and user_id = me
    and status <> 'deleted';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.delete_memory(uuid) is
  '記憶だけを消す。つながっている版もまとめて消し、本文を消して記録だけ残し、古いやりとりをAIへ送らなくする。元の会話は残る。';
