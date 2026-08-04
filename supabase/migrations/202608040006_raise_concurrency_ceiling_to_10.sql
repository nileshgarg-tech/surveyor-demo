-- Raise configure_event_control ceiling to allow up to 10 concurrent studies
create or replace function public.configure_event_control(
  p_max_study_budget_cents bigint,
  p_max_event_budget_cents bigint,
  p_max_concurrent_studies integer,
  p_target_hourly_pay_cents bigint,
  p_stale_launch_seconds integer,
  p_report_stale_seconds integer,
  p_max_report_attempts integer,
  p_recovery_batch_size integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
begin
  select * into v_control
  from public.event_control
  where singleton = true
  for update;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;

  if p_max_study_budget_cents not between 1 and 3500
    or p_max_event_budget_cents not between 1 and 50000
    or p_max_study_budget_cents > p_max_event_budget_cents then
    raise exception 'BUDGET_CONTROL_INVALID';
  end if;
  if p_max_concurrent_studies not between 1 and 10 then
    raise exception 'CONCURRENCY_CONTROL_INVALID';
  end if;
  if p_target_hourly_pay_cents < 1200 then
    raise exception 'COMPENSATION_CONTROL_INVALID';
  end if;
  if p_stale_launch_seconds not between 30 and 86400
    or p_report_stale_seconds not between 30 and 86400
    or p_max_report_attempts not between 1 and 20
    or p_recovery_batch_size not between 1 and 100 then
    raise exception 'RECOVERY_CONTROL_INVALID';
  end if;
  if v_control.reserved_budget_cents + v_control.lifetime_committed_budget_cents
      > p_max_event_budget_cents then
    raise exception 'EVENT_CAP_BELOW_EXISTING_AUTHORIZATION';
  end if;
  if v_control.held_slot_count > p_max_concurrent_studies then
    raise exception 'CONCURRENCY_CAP_BELOW_EXISTING_HOLDS';
  end if;

  update public.event_control
  set max_study_budget_cents = p_max_study_budget_cents,
      max_event_budget_cents = p_max_event_budget_cents,
      max_concurrent_studies = p_max_concurrent_studies,
      max_concurrent_per_session = p_max_concurrent_studies,
      target_hourly_pay_cents = p_target_hourly_pay_cents,
      stale_launch_seconds = p_stale_launch_seconds,
      report_stale_seconds = p_report_stale_seconds,
      max_report_attempts = p_max_report_attempts,
      recovery_batch_size = p_recovery_batch_size,
      version = version + 1
  where singleton = true
    and (
      max_study_budget_cents,
      max_event_budget_cents,
      max_concurrent_studies,
      max_concurrent_per_session,
      target_hourly_pay_cents,
      stale_launch_seconds,
      report_stale_seconds,
      max_report_attempts,
      recovery_batch_size
    ) is distinct from (
      p_max_study_budget_cents,
      p_max_event_budget_cents,
      p_max_concurrent_studies,
      p_max_concurrent_studies,
      p_target_hourly_pay_cents,
      p_stale_launch_seconds,
      p_report_stale_seconds,
      p_max_report_attempts,
      p_recovery_batch_size
    );
  return found;
end;
$$;

revoke execute on function public.configure_event_control(
  bigint, bigint, integer, bigint, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.configure_event_control(
  bigint, bigint, integer, bigint, integer, integer, integer, integer
) to service_role;
