-- =============================================================
-- 0014: 削除のときに、抽出の理由も消す（Phase 4B で見つかった不具合の修正）
--
-- 【何が起きていたか】
-- Phase 4A で「消した候補は本文を持てない」決まりを作ったとき、
-- 本文（suggested_text / confirmed_text）に加えて
-- **抽出の理由（extraction_reason）も持てない**ようにした。
-- 理由の文は「なぜこの内容を候補にしたか」の説明で、
-- そこから本文の中身が推測できてしまうため。
--
-- ところが、記憶を消す処理（delete_memory）のほうを直し忘れていた。
-- 本文は消すが、理由は消さないままだった。
--
-- そのため、**AIが取り出した記憶（理由が付いている）を消そうとすると、
-- DBの決まりに引っかかって削除そのものが失敗する**状態だった。
-- 架空データでの書き出しテスト中に見つかった。
--
-- 本人が「この記憶を消して」と頼んでも消せない、という不具合なので、
-- 気づけてよかった部類のもの。
-- =============================================================

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
      -- 抽出の理由も消す（ここから本文の中身が推測できるため）
      extraction_reason = null,
      deleted_at = now()
  where id = any (ids)
    and user_id = me
    and status <> 'deleted';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.delete_memory(uuid) is
  '記憶だけを消す。つながっている版もまとめて消し、本文と抽出の理由を消して記録だけ残し、古いやりとりをAIへ送らなくする。元の会話は残る。';
