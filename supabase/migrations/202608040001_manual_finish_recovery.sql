-- Recover a manual finish when Prolific is already non-recruiting.
-- This can happen when the provider reaches COMPLETED or AWAITING REVIEW
-- before Surveyor records the PAUSED observation.

create or replace function public.recover_ended_manual_finish_record(
  p_study_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.status <> 'blocked'
    or v_study.failure_code <> 'ENDED_BEFORE_REPORT_SNAPSHOT'
    or v_study.pause_requested_at is null
    or v_study.manual_finish_at is not null
    or v_study.report_snapshot_at is not null
    or v_study.prolific_status not in ('PAUSED', 'AWAITING REVIEW', 'COMPLETED') then
    return false;
  end if;
  select count(*)::integer into v_count
  from public.participant_responses pr
  where pr.study_id = p_study_id and pr.status = 'completed' and pr.submitted_at <= v_now;
  if v_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'; end if;

  update public.studies
  set pause_confirmed_at = coalesce(pause_confirmed_at, v_now),
      pause_cutoff_at = coalesce(pause_cutoff_at, v_now),
      manual_finish_at = v_now,
      report_snapshot_at = v_now,
      report_completion_reason = 'manual',
      report_sample_size = v_count,
      status = 'ready_to_report',
      operation_stage = 'report_ready',
      operation_heartbeat_at = v_now,
      failure_stage = null,
      failure_code = null,
      failure_message = null,
      failed_at = null,
      version = version + 1
  where id = p_study_id;

  insert into public.reports (
    study_id, status, sample_size, snapshot_cutoff_at, completion_reason
  ) values (
    p_study_id, 'ready', v_count, v_now, 'manual'
  ) on conflict (study_id) do nothing;
  return true;
end;
$$;

create or replace function public.recover_ended_manual_finish(
  p_study_id uuid,
  p_event_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id
      and es.revoked_at is null
      and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if not exists (
    select 1 from public.studies s
    where s.id = p_study_id and s.event_session_id = p_event_session_id
  ) then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  return public.recover_ended_manual_finish_record(p_study_id);
end;
$$;

create or replace function public.recover_ended_manual_finishes(
  p_limit integer default 10
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer := 0;
  v_study record;
begin
  for v_study in
    select s.id
    from public.studies s
    where s.status = 'blocked'
      and s.failure_code = 'ENDED_BEFORE_REPORT_SNAPSHOT'
      and s.pause_requested_at is not null
      and s.report_snapshot_at is null
      and s.prolific_status in ('PAUSED', 'AWAITING REVIEW', 'COMPLETED')
    order by s.updated_at
    limit least(greatest(coalesce(p_limit, 10), 1), 100)
    for update skip locked
  loop
    if public.recover_ended_manual_finish_record(v_study.id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke execute on function public.recover_ended_manual_finish_record(uuid)
  from public, anon, authenticated;
revoke execute on function public.recover_ended_manual_finish(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.recover_ended_manual_finishes(integer)
  from public, anon, authenticated;
grant execute on function public.recover_ended_manual_finish_record(uuid) to service_role;
grant execute on function public.recover_ended_manual_finish(uuid, uuid) to service_role;
grant execute on function public.recover_ended_manual_finishes(integer) to service_role;
