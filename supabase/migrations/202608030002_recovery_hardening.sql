-- Evidence-gated retries for unattended provider recovery.  This migration is
-- intentionally separate from the initial schema so each replacement remains
-- reviewable and can be applied to an already-created demo database.

drop index if exists public.studies_stale_operation_idx;
create index studies_stale_operation_idx on public.studies (operation_heartbeat_at)
  where operation_stage in (
    'creating', 'publishing', 'deleting', 'reconciling', 'pausing', 'stopping'
  );

create or replace function public.claim_stale_provider_operations(p_limit integer default null)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_row record;
  v_limit integer;
  v_token uuid;
begin
  select * into v_control from public.event_control where singleton = true;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  v_limit := least(greatest(coalesce(p_limit, v_control.recovery_batch_size), 1), 100);

  for v_row in
    select s.id, s.status, s.operation_stage, s.prolific_internal_name,
      s.prolific_metadata, s.prolific_study_id, s.operation_heartbeat_at
    from public.studies s
    where s.operation_stage in (
        'creating', 'publishing', 'deleting', 'reconciling', 'pausing', 'stopping'
      )
      and s.operation_heartbeat_at
        < clock_timestamp() - make_interval(secs => v_control.stale_launch_seconds)
      and s.status not in ('abandoned', 'cancelled')
    order by s.operation_heartbeat_at
    limit v_limit
    for update skip locked
  loop
    v_token := gen_random_uuid();
    update public.studies
    set status = case
          when status in ('launching', 'reconciling') then 'reconciling'::public.study_status
          else status
        end,
        recovery_claim_token = v_token,
        recovery_claimed_at = clock_timestamp(),
        operation_heartbeat_at = clock_timestamp(),
        operation_attempt_count = operation_attempt_count + 1,
        version = version + 1
    where id = v_row.id;

    return next jsonb_build_object(
      'studyId', v_row.id,
      'claimToken', v_token,
      'status', v_row.status,
      'operationStage', v_row.operation_stage,
      'internalName', v_row.prolific_internal_name,
      'metadata', v_row.prolific_metadata,
      'prolificStudyId', v_row.prolific_study_id
    );
  end loop;
  return;
end;
$$;

create or replace function public.claim_study_reconciliation(
  p_study_id uuid,
  p_event_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_token uuid;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id
      and es.revoked_at is null
      and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if v_study.operation_stage not in (
    'creating', 'publishing', 'deleting', 'reconciling', 'pausing', 'stopping'
  ) then
    raise exception 'STUDY_HAS_NO_RECONCILABLE_OPERATION';
  end if;
  if v_study.recovery_claim_token is not null
    and v_study.recovery_claimed_at > clock_timestamp() - interval '1 minute' then
    return jsonb_build_object('applied', false, 'status', v_study.status);
  end if;

  v_token := gen_random_uuid();
  update public.studies
  set status = case
        when status in ('launching', 'reconciling') then 'reconciling'::public.study_status
        else status
      end,
      recovery_claim_token = v_token,
      recovery_claimed_at = clock_timestamp(),
      operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      version = version + 1
  where id = p_study_id;

  return jsonb_build_object(
    'applied', true,
    'studyId', p_study_id,
    'claimToken', v_token,
    'operationStage', v_study.operation_stage,
    'internalName', v_study.prolific_internal_name,
    'metadata', v_study.prolific_metadata,
    'prolificStudyId', v_study.prolific_study_id
  );
end;
$$;

-- Decide and claim the next paid recovery action under the study lock.  A
-- current exact UNPUBLISHED observation is required.  Publish gets at most two
-- total attempts; after that, the only safe automatic action is deletion.
create function public.claim_recovery_draft_action(
  p_study_id uuid,
  p_reconciliation_event_id uuid,
  p_request_fingerprint text,
  p_sanitized_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_reconcile public.provider_events%rowtype;
  v_event public.provider_events%rowtype;
  v_publish_count integer;
  v_attempt integer;
  v_inserted boolean := false;
  v_key text;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_reconcile
  from public.provider_events
  where id = p_reconciliation_event_id
  for update;

  if not found
    or v_reconcile.provider <> 'prolific'
    or v_reconcile.operation <> 'reconcile_study'
    or v_reconcile.study_id is distinct from p_study_id
    or v_reconcile.status <> 'succeeded'
    or v_reconcile.effect_evidence <> 'draft_exists'
    or v_reconcile.external_status <> 'UNPUBLISHED'
    or v_reconcile.external_resource_id is distinct from v_study.prolific_study_id then
    raise exception 'UNPUBLISHED_RECONCILIATION_REQUIRED';
  end if;
  if v_study.prolific_study_id is null
    or v_study.prolific_status <> 'UNPUBLISHED'
    or v_study.budget_state <> 'reserved'
    or v_study.slot_state <> 'held'
    or v_study.status not in ('launching', 'reconciling') then
    raise exception 'RECOVERY_DRAFT_STATE_INVALID';
  end if;
  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_sanitized_request) <> 'object' then
    raise exception 'RECOVERY_REQUEST_INVALID';
  end if;
  if exists (
    select 1 from public.provider_events pe
    where pe.study_id = p_study_id
      and pe.provider = 'prolific'
      and pe.operation = 'publish_study'
      and pe.status = 'succeeded'
      and pe.effect_evidence in ('published_or_spend_possible', 'non_recruiting')
  ) then
    raise exception 'PUBLISHED_EVIDENCE_CONFLICT';
  end if;

  select count(*)::integer into v_publish_count
  from public.provider_events pe
  where pe.study_id = p_study_id
    and pe.provider = 'prolific'
    and pe.operation = 'publish_study';

  if v_study.prolific_is_ready_to_publish is true and v_publish_count < 2 then
    v_attempt := v_publish_count + 1;
    v_key := 'publish:' || p_study_id::text || ':' || v_attempt::text;
    insert into public.provider_events (
      provider, operation, local_operation_key, study_id,
      request_fingerprint, sanitized_request, heartbeat_at
    ) values (
      'prolific', 'publish_study', v_key, p_study_id,
      p_request_fingerprint, p_sanitized_request, clock_timestamp()
    )
    on conflict (provider, operation, local_operation_key) do nothing
    returning * into v_event;
    if found then
      v_inserted := true;
      update public.studies
      set status = 'launching',
          operation_stage = 'publishing',
          operation_heartbeat_at = clock_timestamp(),
          publish_requested_at = coalesce(publish_requested_at, clock_timestamp()),
          operation_attempt_count = operation_attempt_count + 1,
          version = version + 1
      where id = p_study_id;
    else
      select * into v_event from public.provider_events
      where provider = 'prolific' and operation = 'publish_study'
        and local_operation_key = v_key
      for update;
      if v_event.request_fingerprint is distinct from p_request_fingerprint then
        raise exception 'RECOVERY_PUBLISH_CONFLICT';
      end if;
    end if;
    return jsonb_build_object(
      'action', 'publish', 'applied', v_inserted,
      'eventId', v_event.id, 'attempt', v_attempt, 'status', v_event.status
    );
  end if;

  v_key := 'delete-recovery:' || p_study_id::text || ':' || p_reconciliation_event_id::text;
  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'delete_draft', v_key, p_study_id,
    p_request_fingerprint, p_sanitized_request, clock_timestamp()
  )
  on conflict (provider, operation, local_operation_key) do nothing
  returning * into v_event;
  if found then
    v_inserted := true;
    update public.studies
    set status = 'reconciling',
        operation_stage = 'deleting',
        operation_heartbeat_at = clock_timestamp(),
        operation_attempt_count = operation_attempt_count + 1,
        version = version + 1
    where id = p_study_id;
  else
    select * into v_event from public.provider_events
    where provider = 'prolific' and operation = 'delete_draft'
      and local_operation_key = v_key
    for update;
    if v_event.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'RECOVERY_DELETE_CONFLICT';
    end if;
  end if;
  return jsonb_build_object(
    'action', 'delete', 'applied', v_inserted,
    'eventId', v_event.id, 'status', v_event.status
  );
end;
$$;

-- Manual PAUSE is serialized and may be tried once more only after a later
-- exact ACTIVE/PUBLISHING reconciliation proves the prior action did not stop
-- recruitment.
create or replace function public.claim_manual_pause(
  p_study_id uuid,
  p_event_session_id uuid,
  p_request_fingerprint text,
  p_sanitized_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_event public.provider_events%rowtype;
  v_latest public.provider_events%rowtype;
  v_count integer;
  v_response_count integer;
  v_attempt integer;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id
      and es.revoked_at is null
      and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if v_study.manual_finish_at is not null then
    return jsonb_build_object('applied', false, 'status', 'succeeded');
  end if;

  select count(*)::integer into v_count
  from public.provider_events pe
  where pe.provider = 'prolific' and pe.operation = 'pause_study'
    and pe.study_id = p_study_id;
  select * into v_latest
  from public.provider_events pe
  where pe.provider = 'prolific' and pe.operation = 'pause_study'
    and pe.study_id = p_study_id
  order by pe.created_at desc
  limit 1
  for update;

  if v_count >= 2 then
    if v_latest.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PAUSE_OPERATION_CONFLICT';
    end if;
    return jsonb_build_object(
      'applied', false, 'eventId', v_latest.id, 'status', v_latest.status, 'attempt', v_count
    );
  end if;
  if v_count > 0 then
    if v_latest.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PAUSE_OPERATION_CONFLICT';
    end if;
    if v_latest.status = 'succeeded' and v_latest.effect_evidence = 'non_recruiting' then
      return jsonb_build_object(
        'applied', false, 'eventId', v_latest.id, 'status', v_latest.status, 'attempt', v_count
      );
    end if;
    if not exists (
      select 1 from public.provider_events pe
      where pe.provider = 'prolific'
        and pe.operation = 'reconcile_study'
        and pe.study_id = p_study_id
        and pe.status = 'succeeded'
        and pe.effect_evidence = 'published_or_spend_possible'
        and pe.external_status in ('PUBLISHING', 'ACTIVE')
        and pe.external_resource_id = v_study.prolific_study_id
        and pe.created_at >= coalesce(v_latest.completed_at, v_latest.updated_at)
    ) then
      return jsonb_build_object(
        'applied', false, 'eventId', v_latest.id, 'status', v_latest.status, 'attempt', v_count
      );
    end if;
  end if;

  if v_study.status <> 'collecting'
    or v_study.launch_confirmed_at is null
    or v_study.launch_confirmed_at > clock_timestamp() - interval '2 minutes' then
    raise exception 'MANUAL_FINISH_NOT_AVAILABLE';
  end if;
  select count(*) into v_response_count
  from public.participant_responses pr
  where pr.study_id = p_study_id and pr.status = 'completed';
  if v_response_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'; end if;

  v_attempt := v_count + 1;
  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'pause_study',
    'pause:' || p_study_id::text || ':' || v_attempt::text,
    p_study_id, p_request_fingerprint, p_sanitized_request, clock_timestamp()
  ) returning * into v_event;
  update public.studies
  set pause_requested_at = coalesce(pause_requested_at, clock_timestamp()),
      operation_stage = 'pausing',
      operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      version = version + 1
  where id = p_study_id;
  return jsonb_build_object(
    'applied', true, 'eventId', v_event.id, 'status', v_event.status, 'attempt', v_attempt
  );
end;
$$;

-- STOP follows the same proof-before-retry rule.  An exact later PAUSED
-- observation is the only state that permits a second STOP request.
create or replace function public.claim_final_stop(
  p_study_id uuid,
  p_request_fingerprint text,
  p_sanitized_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_event public.provider_events%rowtype;
  v_latest public.provider_events%rowtype;
  v_count integer;
  v_attempt integer;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.final_stop_confirmed_at is not null then
    return jsonb_build_object('applied', false, 'status', 'succeeded');
  end if;
  if v_study.manual_finish_at is null
    or v_study.pause_confirmed_at is null
    or v_study.prolific_status <> 'PAUSED' then
    raise exception 'STUDY_NOT_STOPPABLE';
  end if;

  select count(*)::integer into v_count
  from public.provider_events pe
  where pe.provider = 'prolific' and pe.operation = 'stop_study'
    and pe.study_id = p_study_id;
  select * into v_latest
  from public.provider_events pe
  where pe.provider = 'prolific' and pe.operation = 'stop_study'
    and pe.study_id = p_study_id
  order by pe.created_at desc
  limit 1
  for update;

  if v_count >= 2 then
    if v_latest.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'STOP_OPERATION_CONFLICT';
    end if;
    return jsonb_build_object(
      'applied', false, 'eventId', v_latest.id, 'status', v_latest.status, 'attempt', v_count
    );
  end if;
  if v_count > 0 then
    if v_latest.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'STOP_OPERATION_CONFLICT';
    end if;
    if v_latest.status = 'succeeded' and v_latest.effect_evidence = 'non_recruiting'
      and v_latest.external_status in ('AWAITING REVIEW', 'COMPLETED') then
      return jsonb_build_object(
        'applied', false, 'eventId', v_latest.id, 'status', v_latest.status, 'attempt', v_count
      );
    end if;
    if not exists (
      select 1 from public.provider_events pe
      where pe.provider = 'prolific'
        and pe.operation = 'reconcile_study'
        and pe.study_id = p_study_id
        and pe.status = 'succeeded'
        and pe.effect_evidence = 'non_recruiting'
        and pe.external_status = 'PAUSED'
        and pe.external_resource_id = v_study.prolific_study_id
        and pe.created_at >= coalesce(v_latest.completed_at, v_latest.updated_at)
    ) then
      return jsonb_build_object(
        'applied', false, 'eventId', v_latest.id, 'status', v_latest.status, 'attempt', v_count
      );
    end if;
  end if;

  v_attempt := v_count + 1;
  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'stop_study',
    'stop:' || p_study_id::text || ':' || v_attempt::text,
    p_study_id, p_request_fingerprint, p_sanitized_request, clock_timestamp()
  ) returning * into v_event;
  update public.studies
  set final_stop_requested_at = coalesce(final_stop_requested_at, clock_timestamp()),
      operation_stage = 'stopping',
      operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      version = version + 1
  where id = p_study_id;
  return jsonb_build_object(
    'applied', true, 'eventId', v_event.id, 'status', v_event.status, 'attempt', v_attempt
  );
end;
$$;

-- A passive status observation must not win the race against the PAUSE/STOP
-- transaction which owns slot release and report snapshot creation.
create or replace function public.release_study_slot(
  p_study_id uuid,
  p_provider_event_id uuid,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_study public.studies%rowtype;
  v_event public.provider_events%rowtype;
begin
  select * into v_control from public.event_control where singleton = true for update;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_event from public.provider_events where id = p_provider_event_id for update;

  if not found or v_event.study_id is distinct from p_study_id
    or v_event.status not in ('succeeded', 'definitive_failure')
    or v_event.effect_evidence not in (
      'request_not_dispatched', 'definitive_no_create', 'external_deleted', 'non_recruiting'
    )
    or (v_event.effect_evidence = 'non_recruiting'
      and v_event.external_status not in ('PAUSED', 'AWAITING REVIEW', 'COMPLETED')) then
    raise exception 'SLOT_RELEASE_EVIDENCE_INVALID';
  end if;
  if v_study.slot_state = 'released' then return false; end if;
  if v_study.operation_stage in ('pausing', 'stopping') then
    raise exception 'LIFECYCLE_OPERATION_OWNS_SLOT_RELEASE';
  end if;
  if v_study.slot_state <> 'held' then raise exception 'SLOT_NOT_HELD'; end if;
  if v_control.held_slot_count <= 0 then raise exception 'EVENT_COUNTER_CORRUPT'; end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);
  update public.event_control
  set held_slot_count = held_slot_count - 1,
      version = version + 1
  where singleton = true;
  update public.studies
  set slot_state = 'released',
      slot_released_at = clock_timestamp(),
      slot_release_reason = p_reason,
      prolific_status = coalesce(v_event.external_status, prolific_status),
      provider_status_checked_at = clock_timestamp(),
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

revoke execute on function public.claim_recovery_draft_action(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_recovery_draft_action(uuid, uuid, text, jsonb)
  to service_role;
revoke execute on function public.claim_manual_pause(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_manual_pause(uuid, uuid, text, jsonb)
  to service_role;
revoke execute on function public.claim_final_stop(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_final_stop(uuid, text, jsonb)
  to service_role;
revoke execute on function public.release_study_slot(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.release_study_slot(uuid, uuid, text)
  to service_role;
