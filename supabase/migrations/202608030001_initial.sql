-- Surveyor initial schema.
-- All browser traffic is mediated by server route handlers.  The public schema is
-- exposed by Supabase, so every table has RLS enabled and intentionally has no
-- anon/authenticated policies.  Paid-state transitions happen only through the
-- service-role RPCs at the end of this migration.

create extension if not exists pgcrypto with schema extensions;

create type public.intake_session_status as enum (
  'open',
  'processing',
  'ready',
  'insufficient',
  'consumed'
);

create type public.study_status as enum (
  'draft',
  'launching',
  'reconciling',
  'collecting',
  'ready_to_report',
  'reporting',
  'complete',
  'blocked',
  'abandoned',
  'cancelled'
);

create type public.targeting_status as enum ('exact', 'proxy', 'unsupported');
create type public.budget_state as enum ('none', 'reserved', 'committed', 'void');
create type public.slot_state as enum ('none', 'held', 'released');

create type public.participant_response_status as enum (
  'started',
  'declined',
  'completed',
  'issue'
);

create type public.report_status as enum ('ready', 'reporting', 'complete', 'blocked');
create type public.report_completion_reason as enum ('target', 'manual');

create type public.provider_event_status as enum (
  'pending',
  'dispatched',
  'succeeded',
  'definitive_failure',
  'ambiguous'
);

create type public.provider_effect_evidence as enum (
  'unknown',
  'request_not_dispatched',
  'definitive_no_create',
  'draft_exists',
  'published_or_spend_possible',
  'external_deleted',
  'non_recruiting'
);

create table public.event_control (
  singleton boolean primary key default true check (singleton),
  reserved_budget_cents bigint not null default 0,
  lifetime_committed_budget_cents bigint not null default 0,
  held_slot_count integer not null default 0,
  max_study_budget_cents bigint not null default 2500,
  max_event_budget_cents bigint not null default 50000,
  max_concurrent_studies integer not null default 3,
  max_concurrent_per_session integer not null default 1,
  target_hourly_pay_cents bigint not null default 1200,
  cost_freshness_seconds integer not null default 300,
  stale_launch_seconds integer not null default 300,
  report_stale_seconds integer not null default 120,
  max_report_attempts integer not null default 3,
  recovery_batch_size integer not null default 10,
  version bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (reserved_budget_cents >= 0),
  check (lifetime_committed_budget_cents >= 0),
  check (held_slot_count >= 0),
  check (max_study_budget_cents > 0),
  check (max_event_budget_cents > 0),
  check (max_study_budget_cents <= max_event_budget_cents),
  check (reserved_budget_cents + lifetime_committed_budget_cents <= max_event_budget_cents),
  check (max_concurrent_studies > 0),
  check (max_concurrent_per_session > 0),
  check (max_concurrent_per_session <= max_concurrent_studies),
  check (held_slot_count <= max_concurrent_studies),
  check (target_hourly_pay_cents > 0),
  check (cost_freshness_seconds between 30 and 3600),
  check (stale_launch_seconds between 30 and 86400),
  check (report_stale_seconds between 30 and 86400),
  check (max_report_attempts between 1 and 20),
  check (recovery_batch_size between 1 and 100)
);

insert into public.event_control (singleton) values (true);

create table public.event_sessions (
  id uuid primary key default gen_random_uuid(),
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (expires_at > issued_at),
  check (revoked_at is null or revoked_at >= issued_at)
);

create table public.intake_sessions (
  id uuid primary key default gen_random_uuid(),
  event_session_id uuid references public.event_sessions(id) on delete restrict,
  messages jsonb not null default '[]'::jsonb,
  user_message_count smallint not null default 0,
  previous_interaction_id text,
  status public.intake_session_status not null default 'open',
  ready_payload jsonb,
  provider text,
  model text,
  last_request_id text unique,
  expires_at timestamptz not null default (clock_timestamp() + interval '24 hours'),
  failure_code text,
  failure_message text,
  version bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (jsonb_typeof(messages) = 'array'),
  check (jsonb_array_length(messages) <= 10),
  check (user_message_count between 0 and 5),
  check (ready_payload is null or jsonb_typeof(ready_payload) = 'object'),
  check (expires_at > created_at),
  check (status <> 'ready' or ready_payload is not null),
  check (status <> 'consumed' or ready_payload is not null)
);

create table public.studies (
  id uuid primary key default gen_random_uuid(),
  source_intake_id uuid unique references public.intake_sessions(id) on delete restrict,
  event_session_id uuid references public.event_sessions(id) on delete restrict,

  brief_title varchar(80) not null,
  research_goal text not null,
  requested_audience text not null,
  recruited_audience text not null,
  brief_context text not null,
  brief jsonb not null,
  survey_spec jsonb not null,
  targeting_plan jsonb not null,
  targeting_status public.targeting_status not null,
  proxy_accepted_at timestamptz,

  participant_count smallint not null default 10,
  participant_cost_options jsonb not null default '[]'::jsonb,
  estimated_minutes smallint not null,
  reward_cents bigint not null,
  rough_estimate_cents bigint not null,
  authoritative_total_cents bigint,
  currency_code text,
  authoritative_cost_checked_at timestamptz,
  workspace_available_balance_cents bigint,
  workspace_balance_checked_at timestamptz,
  launch_input_fingerprint text,
  cost_provider_event_id uuid,
  balance_provider_event_id uuid,

  status public.study_status not null default 'draft',
  prolific_internal_name text generated always as ('surveyor-demo:' || id::text) stored,
  prolific_metadata text generated always as (id::text) stored,
  prolific_study_id text,
  prolific_status text,
  provider_status_checked_at timestamptz,
  prolific_completion_code text,
  prolific_is_ready_to_publish boolean,
  prolific_ready_evidence_at timestamptz,
  prolific_payload jsonb,

  budget_state public.budget_state not null default 'none',
  budget_amount_cents bigint not null default 0,
  budget_reserved_at timestamptz,
  budget_committed_at timestamptz,
  budget_voided_at timestamptz,

  slot_state public.slot_state not null default 'none',
  slot_held_at timestamptz,
  slot_released_at timestamptz,
  slot_release_reason text,

  operation_stage text not null default 'idle',
  operation_attempt_count integer not null default 0,
  operation_heartbeat_at timestamptz,
  recovery_claim_token uuid,
  recovery_claimed_at timestamptz,
  provider_request_ids jsonb not null default '[]'::jsonb,

  launch_requested_at timestamptz,
  draft_created_at timestamptz,
  publish_requested_at timestamptz,
  launch_confirmed_at timestamptz,
  pause_requested_at timestamptz,
  pause_confirmed_at timestamptz,
  pause_cutoff_at timestamptz,
  final_stop_requested_at timestamptz,
  final_stop_confirmed_at timestamptz,
  manual_finish_at timestamptz,
  report_snapshot_at timestamptz,
  report_completion_reason public.report_completion_reason,
  report_sample_size integer,
  completed_at timestamptz,

  failure_stage text,
  failure_code text,
  failure_message text,
  failed_at timestamptz,
  version bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  unique (prolific_internal_name),
  unique (prolific_study_id),
  unique (prolific_completion_code),
  check (char_length(brief_title) between 1 and 80),
  check (jsonb_typeof(brief) = 'object'),
  check (jsonb_typeof(survey_spec) = 'object'),
  check (jsonb_typeof(survey_spec -> 'questions') = 'array'),
  check (jsonb_array_length(survey_spec -> 'questions') between 3 and 5),
  check (jsonb_typeof(targeting_plan) = 'object'),
  check (targeting_plan ->> 'status' = targeting_status::text),
  check (jsonb_typeof(participant_cost_options) = 'array'),
  check (participant_count in (5, 10, 20)),
  check (estimated_minutes between 1 and 5),
  check (reward_cents > 0),
  check (rough_estimate_cents > 0),
  check (authoritative_total_cents is null or authoritative_total_cents > 0),
  check (workspace_available_balance_cents is null or workspace_available_balance_cents >= 0),
  check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  check (launch_input_fingerprint is null or launch_input_fingerprint ~ '^[0-9a-f]{64}$'),
  check (prolific_status is null or prolific_status in (
    'UNPUBLISHED', 'PUBLISHING', 'ACTIVE', 'PAUSED', 'AWAITING REVIEW', 'COMPLETED'
  )),
  check (prolific_payload is null or jsonb_typeof(prolific_payload) = 'object'),
  check (jsonb_typeof(provider_request_ids) = 'array'),
  check (operation_attempt_count >= 0),
  check (
    (budget_state = 'none' and budget_amount_cents = 0
      and budget_reserved_at is null and budget_committed_at is null and budget_voided_at is null)
    or
    (budget_state = 'reserved' and budget_amount_cents > 0
      and budget_reserved_at is not null and budget_committed_at is null and budget_voided_at is null)
    or
    (budget_state = 'committed' and budget_amount_cents > 0
      and budget_reserved_at is not null and budget_committed_at is not null and budget_voided_at is null)
    or
    (budget_state = 'void' and budget_amount_cents > 0
      and budget_reserved_at is not null and budget_committed_at is null and budget_voided_at is not null)
  ),
  check (
    (slot_state = 'none' and slot_held_at is null and slot_released_at is null)
    or
    (slot_state = 'held' and slot_held_at is not null and slot_released_at is null)
    or
    (slot_state = 'released' and slot_held_at is not null and slot_released_at is not null)
  ),
  check (budget_state = 'none' or budget_amount_cents = authoritative_total_cents),
  check (targeting_status <> 'unsupported' or budget_state = 'none'),
  check (targeting_status <> 'proxy' or budget_state = 'none' or proxy_accepted_at is not null),
  check (manual_finish_at is null or (
    pause_confirmed_at is not null and pause_cutoff_at is not null
    and report_snapshot_at is not null and slot_state = 'released'
  )),
  check (report_snapshot_at is null or (
    report_completion_reason is not null and report_sample_size is not null and report_sample_size >= 0
  )),
  check (status <> 'abandoned' or (
    budget_state in ('none', 'void') and slot_state in ('none', 'released')
  )),
  check (final_stop_confirmed_at is null or pause_confirmed_at is not null)
);

create table public.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('prolific', 'gemini', 'openai')),
  operation text not null,
  local_operation_key text not null,
  study_id uuid references public.studies(id) on delete restrict,
  request_fingerprint text,
  sanitized_request jsonb not null default '{}'::jsonb,
  sanitized_response jsonb,
  provider_request_id text,
  external_resource_id text,
  external_status text,
  status public.provider_event_status not null default 'pending',
  effect_evidence public.provider_effect_evidence not null default 'unknown',
  observed_amount_cents bigint,
  observed_currency_code text,
  observed_at timestamptz,
  attempt_count integer not null default 0,
  request_started_at timestamptz not null default clock_timestamp(),
  request_dispatched_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, operation, local_operation_key),
  check (char_length(operation) between 1 and 100),
  check (char_length(local_operation_key) between 1 and 240),
  check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(sanitized_request) = 'object'),
  check (sanitized_response is null or jsonb_typeof(sanitized_response) = 'object'),
  check (observed_amount_cents is null or observed_amount_cents >= 0),
  check (observed_currency_code is null or observed_currency_code ~ '^[A-Z]{3}$'),
  check (attempt_count >= 0),
  check (request_dispatched_at is null or request_dispatched_at >= request_started_at),
  check (completed_at is null or completed_at >= request_started_at)
);

alter table public.studies
  add constraint studies_cost_provider_event_fk
  foreign key (cost_provider_event_id) references public.provider_events(id) on delete restrict;

alter table public.studies
  add constraint studies_balance_provider_event_fk
  foreign key (balance_provider_event_id) references public.provider_events(id) on delete restrict;

create table public.participant_responses (
  id uuid primary key default gen_random_uuid(),
  study_id uuid not null references public.studies(id) on delete restrict,
  prolific_participant_id text not null,
  prolific_submission_id text not null,
  prolific_study_id text not null,
  provider_started_at timestamptz not null,
  last_provider_status text not null,
  provider_validated_at timestamptz not null,
  participant_session_fingerprint text not null,
  answer_fingerprint text,
  status public.participant_response_status not null default 'started',
  consented_at timestamptz,
  declined_at timestamptz,
  submitted_at timestamptz,
  answers jsonb not null default '{}'::jsonb,
  readable_summary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (study_id, prolific_submission_id),
  check (char_length(prolific_participant_id) between 1 and 200),
  check (char_length(prolific_submission_id) between 1 and 200),
  check (char_length(prolific_study_id) between 1 and 200),
  check (participant_session_fingerprint ~ '^[0-9a-f]{64}$'),
  check (answer_fingerprint is null or answer_fingerprint ~ '^[0-9a-f]{64}$'),
  check (jsonb_typeof(answers) = 'object'),
  check (jsonb_typeof(readable_summary) = 'array'),
  check (status <> 'completed' or (
    consented_at is not null and submitted_at is not null and answer_fingerprint is not null
  )),
  check (status <> 'declined' or declined_at is not null)
);

create table public.reports (
  study_id uuid primary key references public.studies(id) on delete restrict,
  status public.report_status not null default 'ready',
  sample_size integer not null check (sample_size >= 0),
  snapshot_cutoff_at timestamptz not null,
  completion_reason public.report_completion_reason not null,
  deterministic_aggregates jsonb,
  narrative jsonb,
  ai_provider text,
  ai_model text,
  sanitized_provider_metadata jsonb,
  attempt_count integer not null default 0,
  claim_token uuid,
  heartbeat_at timestamptz,
  error_code text,
  error_message text,
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (attempt_count >= 0),
  check (deterministic_aggregates is null or jsonb_typeof(deterministic_aggregates) = 'object'),
  check (narrative is null or jsonb_typeof(narrative) = 'object'),
  check (sanitized_provider_metadata is null or jsonb_typeof(sanitized_provider_metadata) = 'object'),
  check (status <> 'reporting' or (claim_token is not null and heartbeat_at is not null)),
  check (status <> 'complete' or (
    deterministic_aggregates is not null and narrative is not null
    and completed_at is not null and claim_token is null
  ))
);

create table public.rate_limit_policies (
  route_class text primary key,
  window_seconds integer not null check (window_seconds > 0),
  max_requests integer not null check (max_requests > 0),
  retention_seconds integer not null check (retention_seconds >= window_seconds)
);

insert into public.rate_limit_policies (route_class, window_seconds, max_requests, retention_seconds)
values
  ('event', 60, 10, 3600),
  ('intake', 60, 12, 3600),
  ('design', 60, 8, 3600),
  ('launch', 300, 3, 3600),
  ('status', 60, 30, 3600),
  ('submission', 60, 8, 3600),
  ('finish', 300, 3, 3600),
  ('report', 300, 5, 3600),
  ('recovery', 300, 6, 3600);

create table public.rate_limit_buckets (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  route_class text not null references public.rate_limit_policies(route_class) on delete restrict,
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (key_hash, route_class, window_start)
);

create index event_sessions_expiry_idx on public.event_sessions (expires_at);
create index intake_sessions_expiry_idx on public.intake_sessions (expires_at);
create index intake_sessions_event_idx on public.intake_sessions (event_session_id, created_at desc);
create index studies_event_held_idx on public.studies (event_session_id) where slot_state = 'held';
create index studies_budget_idx on public.studies (budget_state) where budget_state in ('reserved', 'committed');
create index studies_stale_operation_idx on public.studies (operation_heartbeat_at)
  where operation_stage in ('creating', 'publishing', 'reconciling', 'pausing', 'stopping');
create index studies_ready_report_idx on public.studies (created_at) where status = 'ready_to_report';
create index participant_responses_completed_idx
  on public.participant_responses (study_id, submitted_at) where status = 'completed';
create index provider_events_study_idx on public.provider_events (study_id, created_at desc);
create index provider_events_pending_idx on public.provider_events (heartbeat_at)
  where status in ('pending', 'dispatched', 'ambiguous');
create index reports_stale_idx on public.reports (heartbeat_at) where status = 'reporting';
create index rate_limit_buckets_expiry_idx on public.rate_limit_buckets (expires_at);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create function public.validate_intake_messages()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_user_count integer;
  v_invalid_count integer;
begin
  if jsonb_typeof(new.messages) <> 'array' or jsonb_array_length(new.messages) > 10 then
    raise exception 'INVALID_INTAKE_MESSAGES';
  end if;

  select
    count(*) filter (where item ->> 'role' = 'user'),
    count(*) filter (where
      jsonb_typeof(item) <> 'object'
      or coalesce(item ->> 'role', '') not in ('user', 'assistant')
      or nullif(btrim(item ->> 'content'), '') is null
    )
  into v_user_count, v_invalid_count
  from jsonb_array_elements(new.messages) as items(item);

  if v_invalid_count <> 0 or v_user_count > 5 then
    raise exception 'INVALID_INTAKE_MESSAGES';
  end if;

  if v_user_count = 5 and new.status = 'open' then
    raise exception 'FIFTH_USER_MESSAGE_MUST_RESOLVE';
  end if;

  new.user_message_count := v_user_count;
  return new;
end;
$$;

create function public.guard_event_control_counters()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (
    new.reserved_budget_cents,
    new.lifetime_committed_budget_cents,
    new.held_slot_count
  ) is distinct from (
    old.reserved_budget_cents,
    old.lifetime_committed_budget_cents,
    old.held_slot_count
  ) and coalesce(current_setting('surveyor.lifecycle_rpc', true), '') <> 'on' then
    raise exception 'LIFECYCLE_RPC_REQUIRED';
  end if;
  return new;
end;
$$;

create function public.guard_study_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.budget_state = 'none' and new.budget_state not in ('none', 'reserved') then
    raise exception 'INVALID_BUDGET_TRANSITION';
  elsif old.budget_state = 'reserved' and new.budget_state not in ('reserved', 'committed', 'void') then
    raise exception 'INVALID_BUDGET_TRANSITION';
  elsif old.budget_state in ('committed', 'void') and new.budget_state <> old.budget_state then
    raise exception 'INVALID_BUDGET_TRANSITION';
  end if;

  if old.slot_state = 'none' and new.slot_state not in ('none', 'held') then
    raise exception 'INVALID_SLOT_TRANSITION';
  elsif old.slot_state = 'held' and new.slot_state not in ('held', 'released') then
    raise exception 'INVALID_SLOT_TRANSITION';
  elsif old.slot_state = 'released' and new.slot_state <> 'released' then
    raise exception 'INVALID_SLOT_TRANSITION';
  end if;

  if (
    new.budget_state, new.budget_amount_cents, new.budget_reserved_at,
    new.budget_committed_at, new.budget_voided_at, new.slot_state,
    new.slot_held_at, new.slot_released_at, new.slot_release_reason
  ) is distinct from (
    old.budget_state, old.budget_amount_cents, old.budget_reserved_at,
    old.budget_committed_at, old.budget_voided_at, old.slot_state,
    old.slot_held_at, old.slot_released_at, old.slot_release_reason
  ) and coalesce(current_setting('surveyor.lifecycle_rpc', true), '') <> 'on' then
    raise exception 'LIFECYCLE_RPC_REQUIRED';
  end if;

  if (old.budget_state <> 'none' or old.slot_state <> 'none') and (
    new.participant_count, new.estimated_minutes, new.reward_cents,
    new.survey_spec, new.targeting_plan, new.targeting_status,
    new.authoritative_total_cents, new.currency_code, new.launch_input_fingerprint
  ) is distinct from (
    old.participant_count, old.estimated_minutes, old.reward_cents,
    old.survey_spec, old.targeting_plan, old.targeting_status,
    old.authoritative_total_cents, old.currency_code, old.launch_input_fingerprint
  ) then
    raise exception 'LAUNCH_ECONOMICS_IMMUTABLE';
  end if;

  if old.prolific_study_id is not null and new.prolific_study_id is distinct from old.prolific_study_id then
    raise exception 'PROLIFIC_STUDY_ID_IMMUTABLE';
  end if;

  if old.report_snapshot_at is not null and (
    new.report_snapshot_at, new.report_completion_reason, new.report_sample_size
  ) is distinct from (
    old.report_snapshot_at, old.report_completion_reason, old.report_sample_size
  ) then
    raise exception 'REPORT_SNAPSHOT_IMMUTABLE';
  end if;

  if old.manual_finish_at is not null and (
    new.manual_finish_at is null or new.status = 'collecting'
  ) then
    raise exception 'MANUAL_FINISH_IS_FINAL';
  end if;

  return new;
end;
$$;

create function public.guard_provider_event_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'pending' and new.status not in ('pending', 'dispatched', 'definitive_failure') then
    raise exception 'INVALID_PROVIDER_EVENT_TRANSITION';
  elsif old.status = 'dispatched' and new.status not in (
    'dispatched', 'succeeded', 'definitive_failure', 'ambiguous'
  ) then
    raise exception 'INVALID_PROVIDER_EVENT_TRANSITION';
  elsif old.status in ('succeeded', 'definitive_failure', 'ambiguous')
    and new.status <> old.status then
    raise exception 'PROVIDER_EVENT_TERMINAL';
  end if;

  if old.external_resource_id is not null
    and new.external_resource_id is distinct from old.external_resource_id then
    raise exception 'PROVIDER_RESOURCE_ID_IMMUTABLE';
  end if;

  return new;
end;
$$;

create trigger event_control_guard_before_update
before update on public.event_control
for each row execute function public.guard_event_control_counters();

create trigger intake_sessions_validate_before_write
before insert or update of messages on public.intake_sessions
for each row execute function public.validate_intake_messages();

create trigger studies_lifecycle_guard_before_update
before update on public.studies
for each row execute function public.guard_study_lifecycle();

create trigger provider_events_guard_before_update
before update on public.provider_events
for each row execute function public.guard_provider_event_transition();

create trigger event_control_set_updated_at before update on public.event_control
for each row execute function public.set_updated_at();
create trigger event_sessions_set_updated_at before update on public.event_sessions
for each row execute function public.set_updated_at();
create trigger intake_sessions_set_updated_at before update on public.intake_sessions
for each row execute function public.set_updated_at();
create trigger studies_set_updated_at before update on public.studies
for each row execute function public.set_updated_at();
create trigger provider_events_set_updated_at before update on public.provider_events
for each row execute function public.set_updated_at();
create trigger participant_responses_set_updated_at before update on public.participant_responses
for each row execute function public.set_updated_at();
create trigger reports_set_updated_at before update on public.reports
for each row execute function public.set_updated_at();

alter table public.event_control enable row level security;
alter table public.event_sessions enable row level security;
alter table public.intake_sessions enable row level security;
alter table public.studies enable row level security;
alter table public.provider_events enable row level security;
alter table public.participant_responses enable row level security;
alter table public.reports enable row level security;
alter table public.rate_limit_policies enable row level security;
alter table public.rate_limit_buckets enable row level security;

alter table public.event_control force row level security;
alter table public.event_sessions force row level security;
alter table public.intake_sessions force row level security;
alter table public.studies force row level security;
alter table public.provider_events force row level security;
alter table public.participant_responses force row level security;
alter table public.reports force row level security;
alter table public.rate_limit_policies force row level security;
alter table public.rate_limit_buckets force row level security;

revoke all on table public.event_control from anon, authenticated;
revoke all on table public.event_sessions from anon, authenticated;
revoke all on table public.intake_sessions from anon, authenticated;
revoke all on table public.studies from anon, authenticated;
revoke all on table public.provider_events from anon, authenticated;
revoke all on table public.participant_responses from anon, authenticated;
revoke all on table public.reports from anon, authenticated;
revoke all on table public.rate_limit_policies from anon, authenticated;
revoke all on table public.rate_limit_buckets from anon, authenticated;

create function public.create_event_session(p_expires_at timestamptz)
returns table (session_id uuid, session_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_expires_at is null or p_expires_at <= clock_timestamp() then
    raise exception 'INVALID_EVENT_SESSION_EXPIRY';
  end if;

  insert into public.event_sessions (expires_at)
  values (p_expires_at)
  returning id into v_id;

  return query select v_id, p_expires_at;
end;
$$;

create function public.touch_event_session(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.event_sessions
  set last_seen_at = clock_timestamp()
  where id = p_session_id
    and revoked_at is null
    and expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.create_intake_session(
  p_event_session_id uuid default null,
  p_expires_at timestamptz default (clock_timestamp() + interval '24 hours')
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_expires_at <= clock_timestamp() then
    raise exception 'INVALID_INTAKE_EXPIRY';
  end if;

  if p_event_session_id is not null and not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id
      and es.revoked_at is null
      and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;

  insert into public.intake_sessions (event_session_id, expires_at)
  values (p_event_session_id, p_expires_at)
  returning id into v_id;
  return v_id;
end;
$$;

create function public.claim_intake_request(
  p_intake_id uuid,
  p_request_id text,
  p_messages jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.intake_sessions%rowtype;
begin
  if nullif(btrim(p_request_id), '') is null then
    raise exception 'REQUEST_ID_REQUIRED';
  end if;

  select * into v_intake
  from public.intake_sessions
  where id = p_intake_id
  for update;

  if not found then raise exception 'INTAKE_NOT_FOUND'; end if;
  if v_intake.expires_at <= clock_timestamp() then raise exception 'INTAKE_EXPIRED'; end if;

  if v_intake.last_request_id = p_request_id then
    return jsonb_build_object(
      'applied', false,
      'status', v_intake.status,
      'readyPayload', v_intake.ready_payload,
      'version', v_intake.version
    );
  end if;

  if v_intake.status = 'processing' then raise exception 'INTAKE_ALREADY_PROCESSING'; end if;
  if v_intake.status <> 'open' then raise exception 'INTAKE_NOT_OPEN'; end if;

  update public.intake_sessions
  set messages = p_messages,
      status = 'processing',
      last_request_id = p_request_id,
      failure_code = null,
      failure_message = null,
      version = version + 1
  where id = p_intake_id;

  select * into v_intake from public.intake_sessions where id = p_intake_id;
  return jsonb_build_object(
    'applied', true,
    'status', v_intake.status,
    'userMessageCount', v_intake.user_message_count,
    'version', v_intake.version
  );
end;
$$;

create function public.complete_intake_request(
  p_intake_id uuid,
  p_request_id text,
  p_status public.intake_session_status,
  p_messages jsonb,
  p_previous_interaction_id text default null,
  p_ready_payload jsonb default null,
  p_provider text default null,
  p_model text default null,
  p_failure_code text default null,
  p_failure_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake public.intake_sessions%rowtype;
begin
  if p_status not in ('open', 'ready', 'insufficient') then
    raise exception 'INVALID_INTAKE_COMPLETION_STATUS';
  end if;
  if p_status = 'ready' and (p_ready_payload is null or jsonb_typeof(p_ready_payload) <> 'object') then
    raise exception 'READY_PAYLOAD_REQUIRED';
  end if;

  select * into v_intake
  from public.intake_sessions
  where id = p_intake_id
  for update;

  if not found then raise exception 'INTAKE_NOT_FOUND'; end if;
  if v_intake.last_request_id is distinct from p_request_id then
    raise exception 'INTAKE_REQUEST_MISMATCH';
  end if;
  if v_intake.status <> 'processing' then
    if v_intake.status = p_status then return false; end if;
    raise exception 'INTAKE_NOT_PROCESSING';
  end if;

  update public.intake_sessions
  set messages = p_messages,
      previous_interaction_id = p_previous_interaction_id,
      status = p_status,
      ready_payload = case when p_status = 'ready' then p_ready_payload else null end,
      provider = p_provider,
      model = p_model,
      failure_code = p_failure_code,
      failure_message = p_failure_message,
      version = version + 1
  where id = p_intake_id;
  return true;
end;
$$;

create function public.consume_rate_limit(
  p_key text,
  p_route_class text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_policy public.rate_limit_policies%rowtype;
  v_window_start timestamptz;
  v_allowed boolean := false;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_RATE_LIMIT_KEY';
  end if;

  select * into v_policy
  from public.rate_limit_policies
  where route_class = p_route_class;

  if not found then raise exception 'UNKNOWN_RATE_LIMIT_ROUTE'; end if;
  if p_limit <> v_policy.max_requests or p_window_seconds <> v_policy.window_seconds then
    raise exception 'RATE_LIMIT_POLICY_MISMATCH';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / v_policy.window_seconds)
      * v_policy.window_seconds
  );

  insert into public.rate_limit_buckets (
    key_hash, route_class, window_start, request_count, expires_at
  ) values (
    p_key, p_route_class, v_window_start, 1,
    v_window_start + make_interval(secs => v_policy.retention_seconds)
  )
  on conflict (key_hash, route_class, window_start) do update
  set request_count = public.rate_limit_buckets.request_count + 1,
      expires_at = excluded.expires_at,
      updated_at = clock_timestamp()
  where public.rate_limit_buckets.request_count + 1 <= v_policy.max_requests
  returning true into v_allowed;

  delete from public.rate_limit_buckets b
  where b.ctid in (
    select expired.ctid from public.rate_limit_buckets expired
    where expired.expires_at <= clock_timestamp()
    limit 100
  );

  return coalesce(v_allowed, false);
end;
$$;

create function public.claim_provider_operation(
  p_provider text,
  p_operation text,
  p_local_operation_key text,
  p_study_id uuid default null,
  p_request_fingerprint text default null,
  p_sanitized_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.provider_events%rowtype;
  v_inserted boolean := false;
begin
  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request
  ) values (
    p_provider, p_operation, p_local_operation_key, p_study_id,
    p_request_fingerprint, p_sanitized_request
  )
  on conflict (provider, operation, local_operation_key) do nothing
  returning * into v_event;

  if found then
    v_inserted := true;
  else
    select * into v_event
    from public.provider_events
    where provider = p_provider
      and operation = p_operation
      and local_operation_key = p_local_operation_key
    for update;

    if v_event.study_id is distinct from p_study_id
      or v_event.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PROVIDER_OPERATION_CONFLICT';
    end if;
  end if;

  return jsonb_build_object(
    'eventId', v_event.id,
    'applied', v_inserted,
    'status', v_event.status,
    'effectEvidence', v_event.effect_evidence,
    'attemptCount', v_event.attempt_count,
    'externalResourceId', v_event.external_resource_id
  );
end;
$$;

create function public.mark_provider_operation_dispatched(p_event_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.provider_event_status;
begin
  select status into v_status
  from public.provider_events
  where id = p_event_id
  for update;

  if not found then raise exception 'PROVIDER_EVENT_NOT_FOUND'; end if;
  if v_status not in ('pending', 'dispatched') then return false; end if;

  update public.provider_events
  set status = 'dispatched',
      request_dispatched_at = coalesce(request_dispatched_at, clock_timestamp()),
      heartbeat_at = clock_timestamp(),
      attempt_count = attempt_count + 1
  where id = p_event_id;
  return true;
end;
$$;

create function public.record_provider_operation_result(
  p_event_id uuid,
  p_status public.provider_event_status,
  p_effect_evidence public.provider_effect_evidence,
  p_sanitized_response jsonb default null,
  p_provider_request_id text default null,
  p_external_resource_id text default null,
  p_external_status text default null,
  p_observed_amount_cents bigint default null,
  p_observed_currency_code text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.provider_events%rowtype;
begin
  if p_status not in ('succeeded', 'definitive_failure', 'ambiguous') then
    raise exception 'INVALID_PROVIDER_RESULT_STATUS';
  end if;

  select * into v_event
  from public.provider_events
  where id = p_event_id
  for update;

  if not found then raise exception 'PROVIDER_EVENT_NOT_FOUND'; end if;

  if v_event.status in ('succeeded', 'definitive_failure', 'ambiguous') then
    if v_event.status = p_status
      and v_event.effect_evidence = p_effect_evidence
      and v_event.external_resource_id is not distinct from p_external_resource_id then
      return false;
    end if;
    raise exception 'PROVIDER_RESULT_CONFLICT';
  end if;

  if v_event.status = 'pending' and not (
    p_status = 'definitive_failure' and p_effect_evidence = 'request_not_dispatched'
  ) then
    raise exception 'PROVIDER_REQUEST_NOT_DISPATCHED';
  end if;
  if p_status = 'ambiguous' and p_effect_evidence <> 'unknown' then
    raise exception 'AMBIGUOUS_EFFECT_MUST_REMAIN_UNKNOWN';
  end if;

  update public.provider_events
  set status = p_status,
      effect_evidence = p_effect_evidence,
      sanitized_response = p_sanitized_response,
      provider_request_id = coalesce(p_provider_request_id, provider_request_id),
      external_resource_id = coalesce(p_external_resource_id, external_resource_id),
      external_status = p_external_status,
      observed_amount_cents = p_observed_amount_cents,
      observed_currency_code = p_observed_currency_code,
      observed_at = clock_timestamp(),
      completed_at = clock_timestamp(),
      heartbeat_at = clock_timestamp(),
      error_code = p_error_code,
      error_message = p_error_message
  where id = p_event_id;
  return true;
end;
$$;

create function public.persist_prolific_draft(
  p_study_id uuid,
  p_provider_event_id uuid,
  p_prolific_study_id text,
  p_is_ready_to_publish boolean,
  p_sanitized_payload jsonb,
  p_provider_request_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_event public.provider_events%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;

  select * into v_event from public.provider_events where id = p_provider_event_id for update;
  if not found or v_event.study_id is distinct from p_study_id
    or v_event.provider <> 'prolific'
    or v_event.status <> 'succeeded'
    or v_event.effect_evidence <> 'draft_exists'
    or v_event.external_resource_id is distinct from p_prolific_study_id then
    raise exception 'DRAFT_EVIDENCE_INVALID';
  end if;

  if v_study.prolific_study_id is not null then
    if v_study.prolific_study_id = p_prolific_study_id then return false; end if;
    raise exception 'PROLIFIC_STUDY_ID_CONFLICT';
  end if;
  if v_study.budget_state <> 'reserved' or v_study.slot_state <> 'held'
    or v_study.status not in ('launching', 'reconciling') then
    raise exception 'STUDY_NOT_LAUNCHING';
  end if;

  update public.studies
  set prolific_study_id = p_prolific_study_id,
      prolific_status = 'UNPUBLISHED',
      provider_status_checked_at = clock_timestamp(),
      prolific_is_ready_to_publish = p_is_ready_to_publish,
      prolific_ready_evidence_at = clock_timestamp(),
      prolific_payload = p_sanitized_payload,
      draft_created_at = clock_timestamp(),
      operation_stage = 'draft_created',
      operation_heartbeat_at = clock_timestamp(),
      provider_request_ids = case
        when p_provider_request_id is null then provider_request_ids
        else provider_request_ids || jsonb_build_array(p_provider_request_id)
      end,
      recovery_claim_token = null,
      recovery_claimed_at = null,
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.claim_publish_study(
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
  v_inserted boolean := false;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if v_study.prolific_study_id is null or v_study.prolific_status <> 'UNPUBLISHED'
    or v_study.prolific_is_ready_to_publish is not true
    or v_study.budget_state <> 'reserved' or v_study.slot_state <> 'held' then
    raise exception 'STUDY_NOT_PUBLISHABLE';
  end if;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request
  ) values (
    'prolific', 'publish_study', 'publish:' || p_study_id::text, p_study_id,
    p_request_fingerprint, p_sanitized_request
  )
  on conflict (provider, operation, local_operation_key) do nothing
  returning * into v_event;

  if found then
    v_inserted := true;
    update public.studies
    set operation_stage = 'publishing',
        operation_heartbeat_at = clock_timestamp(),
        publish_requested_at = coalesce(publish_requested_at, clock_timestamp()),
        operation_attempt_count = operation_attempt_count + 1,
        version = version + 1
    where id = p_study_id;
  else
    select * into v_event from public.provider_events
    where provider = 'prolific' and operation = 'publish_study'
      and local_operation_key = 'publish:' || p_study_id::text
    for update;
    if v_event.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PUBLISH_OPERATION_CONFLICT';
    end if;
  end if;

  return jsonb_build_object(
    'eventId', v_event.id,
    'applied', v_inserted,
    'status', v_event.status,
    'attemptCount', v_event.attempt_count
  );
end;
$$;

create function public.mark_launch_ambiguous(
  p_study_id uuid,
  p_provider_event_id uuid,
  p_failure_stage text,
  p_error_code text,
  p_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;

  if not exists (
    select 1 from public.provider_events pe
    where pe.id = p_provider_event_id and pe.study_id = p_study_id
      and pe.status = 'ambiguous' and pe.effect_evidence = 'unknown'
  ) then
    raise exception 'AMBIGUOUS_EVIDENCE_REQUIRED';
  end if;

  if v_study.status = 'reconciling'
    and v_study.failure_stage is not distinct from p_failure_stage
    and v_study.failure_code is not distinct from p_error_code then
    return false;
  end if;

  update public.studies
  set status = 'reconciling',
      operation_stage = 'reconciling',
      operation_heartbeat_at = clock_timestamp(),
      failure_stage = p_failure_stage,
      failure_code = p_error_code,
      failure_message = p_error_message,
      failed_at = clock_timestamp(),
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.reserve_study_launch(
  p_study_id uuid,
  p_event_session_id uuid,
  p_expected_version bigint,
  p_cost_event_id uuid,
  p_balance_event_id uuid,
  p_create_request_fingerprint text,
  p_sanitized_create_request jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_study public.studies%rowtype;
  v_cost public.provider_events%rowtype;
  v_balance public.provider_events%rowtype;
  v_create public.provider_events%rowtype;
  v_session_held integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_control
  from public.event_control
  where singleton = true
  for update;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;

  select * into v_study
  from public.studies
  where id = p_study_id
  for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;

  if v_study.event_session_id is null
    or v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id
      and es.revoked_at is null
      and es.expires_at > v_now
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;

  if v_study.budget_state in ('reserved', 'committed') then
    select * into v_create
    from public.provider_events pe
    where pe.provider = 'prolific'
      and pe.operation = 'create_study'
      and pe.local_operation_key = 'create:' || p_study_id::text;
    return jsonb_build_object(
      'applied', false,
      'studyId', v_study.id,
      'status', v_study.status,
      'budgetState', v_study.budget_state,
      'slotState', v_study.slot_state,
      'amountCents', v_study.budget_amount_cents,
      'providerEventId', v_create.id,
      'version', v_study.version
    );
  end if;

  if p_expected_version is not null and v_study.version <> p_expected_version then
    raise exception 'STUDY_VERSION_CONFLICT';
  end if;
  if v_study.status <> 'draft' or v_study.budget_state <> 'none' or v_study.slot_state <> 'none' then
    raise exception 'STUDY_NOT_RESERVABLE';
  end if;
  if v_study.targeting_status = 'unsupported'
    or (v_study.targeting_status = 'proxy' and v_study.proxy_accepted_at is null) then
    raise exception 'TARGETING_NOT_LAUNCHABLE';
  end if;
  if v_study.prolific_completion_code is null then
    raise exception 'COMPLETION_CODE_REQUIRED';
  end if;

  if exists (
    select 1 from public.studies stale
    where stale.operation_stage in ('creating', 'publishing', 'reconciling', 'pausing', 'stopping')
      and stale.operation_heartbeat_at < v_now - make_interval(secs => v_control.stale_launch_seconds)
  ) then
    raise exception 'STALE_RECONCILIATION_REQUIRED';
  end if;

  select * into v_cost from public.provider_events where id = p_cost_event_id for update;
  if not found or v_cost.provider <> 'prolific'
    or v_cost.operation <> 'calculate_study_cost'
    or v_cost.study_id is distinct from p_study_id
    or v_cost.status <> 'succeeded'
    or v_cost.observed_amount_cents is null
    or v_cost.observed_currency_code <> 'USD'
    or v_cost.observed_at is null
    or v_cost.observed_at < v_now - make_interval(secs => v_control.cost_freshness_seconds)
    or v_cost.request_fingerprint is distinct from v_study.launch_input_fingerprint then
    raise exception 'AUTHORITATIVE_COST_EVIDENCE_INVALID';
  end if;

  select * into v_balance from public.provider_events where id = p_balance_event_id for update;
  if not found or v_balance.provider <> 'prolific'
    or v_balance.operation <> 'workspace_balance'
    or (v_balance.study_id is not null and v_balance.study_id is distinct from p_study_id)
    or v_balance.status <> 'succeeded'
    or v_balance.observed_amount_cents is null
    or v_balance.observed_currency_code <> 'USD'
    or v_balance.observed_at is null
    or v_balance.observed_at < v_now - make_interval(secs => v_control.cost_freshness_seconds) then
    raise exception 'WORKSPACE_BALANCE_EVIDENCE_INVALID';
  end if;

  if v_study.authoritative_total_cents is distinct from v_cost.observed_amount_cents
    or v_study.currency_code is distinct from 'USD' then
    raise exception 'AUTHORITATIVE_COST_MISMATCH';
  end if;
  if v_balance.observed_amount_cents < v_cost.observed_amount_cents then
    raise exception 'INSUFFICIENT_WORKSPACE_BALANCE';
  end if;
  if v_cost.observed_amount_cents > v_control.max_study_budget_cents then
    raise exception 'STUDY_BUDGET_CAP_EXCEEDED';
  end if;
  if v_control.reserved_budget_cents + v_control.lifetime_committed_budget_cents
       + v_cost.observed_amount_cents > v_control.max_event_budget_cents then
    raise exception 'EVENT_BUDGET_CAP_EXCEEDED';
  end if;
  if v_control.held_slot_count >= v_control.max_concurrent_studies then
    raise exception 'GLOBAL_CONCURRENCY_CAP_REACHED';
  end if;

  select count(*) into v_session_held
  from public.studies s
  where s.event_session_id = p_event_session_id and s.slot_state = 'held';
  if v_session_held >= v_control.max_concurrent_per_session then
    raise exception 'SESSION_CONCURRENCY_CAP_REACHED';
  end if;

  if v_study.reward_cents <> (
    (v_study.estimated_minutes::bigint * v_control.target_hourly_pay_cents + 59) / 60
  ) then
    raise exception 'REWARD_BELOW_CONFIGURED_RATE';
  end if;

  if exists (
    select 1 from public.provider_events pe
    where pe.provider = 'prolific' and pe.operation = 'create_study'
      and pe.local_operation_key = 'create:' || p_study_id::text
  ) then
    raise exception 'CREATE_OPERATION_ALREADY_EXISTS';
  end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);

  update public.event_control
  set reserved_budget_cents = reserved_budget_cents + v_cost.observed_amount_cents,
      held_slot_count = held_slot_count + 1,
      version = version + 1
  where singleton = true;

  update public.studies
  set status = 'launching',
      authoritative_cost_checked_at = v_cost.observed_at,
      workspace_available_balance_cents = v_balance.observed_amount_cents,
      workspace_balance_checked_at = v_balance.observed_at,
      cost_provider_event_id = p_cost_event_id,
      balance_provider_event_id = p_balance_event_id,
      budget_state = 'reserved',
      budget_amount_cents = v_cost.observed_amount_cents,
      budget_reserved_at = v_now,
      slot_state = 'held',
      slot_held_at = v_now,
      operation_stage = 'creating',
      operation_attempt_count = operation_attempt_count + 1,
      operation_heartbeat_at = v_now,
      launch_requested_at = coalesce(launch_requested_at, v_now),
      failure_stage = null,
      failure_code = null,
      failure_message = null,
      failed_at = null,
      version = version + 1
  where id = p_study_id;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'create_study', 'create:' || p_study_id::text, p_study_id,
    p_create_request_fingerprint, p_sanitized_create_request, v_now
  )
  returning * into v_create;

  return jsonb_build_object(
    'applied', true,
    'studyId', p_study_id,
    'status', 'launching',
    'budgetState', 'reserved',
    'slotState', 'held',
    'amountCents', v_cost.observed_amount_cents,
    'providerEventId', v_create.id,
    'version', v_study.version + 1
  );
end;
$$;

create function public.commit_study_budget(
  p_study_id uuid,
  p_provider_event_id uuid
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

  if not found or v_event.provider <> 'prolific'
    or v_event.study_id is distinct from p_study_id
    or v_event.status <> 'succeeded'
    or v_event.effect_evidence not in ('published_or_spend_possible', 'non_recruiting')
    or v_event.external_resource_id is distinct from v_study.prolific_study_id
    or v_event.external_status not in ('PUBLISHING', 'ACTIVE', 'PAUSED', 'AWAITING REVIEW', 'COMPLETED') then
    raise exception 'COMMIT_EVIDENCE_INVALID';
  end if;

  if v_study.budget_state = 'committed' then return false; end if;
  if v_study.budget_state <> 'reserved' then raise exception 'BUDGET_NOT_RESERVED'; end if;
  if v_control.reserved_budget_cents < v_study.budget_amount_cents then
    raise exception 'EVENT_COUNTER_CORRUPT';
  end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);
  update public.event_control
  set reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents,
      lifetime_committed_budget_cents = lifetime_committed_budget_cents + v_study.budget_amount_cents,
      version = version + 1
  where singleton = true;

  update public.studies
  set budget_state = 'committed',
      budget_committed_at = clock_timestamp(),
      prolific_status = v_event.external_status,
      provider_status_checked_at = clock_timestamp(),
      status = case
        when v_event.external_status in ('PUBLISHING', 'ACTIVE') then 'collecting'::public.study_status
        else status
      end,
      operation_stage = case
        when v_event.external_status in ('PUBLISHING', 'ACTIVE') then 'collecting'
        else operation_stage
      end,
      operation_heartbeat_at = clock_timestamp(),
      launch_confirmed_at = coalesce(launch_confirmed_at, clock_timestamp()),
      provider_request_ids = case
        when v_event.provider_request_id is null then provider_request_ids
        else provider_request_ids || jsonb_build_array(v_event.provider_request_id)
      end,
      recovery_claim_token = null,
      recovery_claimed_at = null,
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.void_study_budget(
  p_study_id uuid,
  p_provider_event_id uuid
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
      'request_not_dispatched', 'definitive_no_create', 'external_deleted'
    ) then
    raise exception 'VOID_EVIDENCE_INVALID';
  end if;

  if v_study.budget_state = 'void' then return false; end if;
  if v_study.budget_state = 'committed' then raise exception 'COMMITTED_BUDGET_CANNOT_BE_VOIDED'; end if;
  if v_study.budget_state <> 'reserved' then raise exception 'BUDGET_NOT_RESERVED'; end if;
  if v_control.reserved_budget_cents < v_study.budget_amount_cents then
    raise exception 'EVENT_COUNTER_CORRUPT';
  end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);
  update public.event_control
  set reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents,
      version = version + 1
  where singleton = true;
  update public.studies
  set budget_state = 'void',
      budget_voided_at = clock_timestamp(),
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.release_study_slot(
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

create function public.abandon_unlaunched_study(
  p_study_id uuid,
  p_provider_event_id uuid,
  p_failure_stage text,
  p_error_code text,
  p_error_message text
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

  if v_study.status = 'abandoned' and v_study.budget_state = 'void'
    and v_study.slot_state = 'released' then return false; end if;

  if not found or v_event.study_id is distinct from p_study_id
    or v_event.status not in ('succeeded', 'definitive_failure')
    or v_event.effect_evidence not in (
      'request_not_dispatched', 'definitive_no_create', 'external_deleted'
    ) then
    raise exception 'ABANDON_EVIDENCE_INVALID';
  end if;
  if v_study.budget_state <> 'reserved' or v_study.slot_state <> 'held' then
    raise exception 'STUDY_NOT_ABANDONABLE';
  end if;
  if v_control.reserved_budget_cents < v_study.budget_amount_cents
    or v_control.held_slot_count <= 0 then
    raise exception 'EVENT_COUNTER_CORRUPT';
  end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);
  update public.event_control
  set reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents,
      held_slot_count = held_slot_count - 1,
      version = version + 1
  where singleton = true;
  update public.studies
  set budget_state = 'void',
      budget_voided_at = clock_timestamp(),
      slot_state = 'released',
      slot_released_at = clock_timestamp(),
      slot_release_reason = 'abandoned_unlaunched',
      status = 'abandoned',
      operation_stage = 'abandoned',
      operation_heartbeat_at = clock_timestamp(),
      recovery_claim_token = null,
      recovery_claimed_at = null,
      failure_stage = p_failure_stage,
      failure_code = p_error_code,
      failure_message = p_error_message,
      failed_at = clock_timestamp(),
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.begin_participant_response(
  p_study_id uuid,
  p_prolific_participant_id text,
  p_prolific_submission_id text,
  p_prolific_study_id text,
  p_provider_started_at timestamptz,
  p_provider_status text,
  p_participant_session_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_response public.participant_responses%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.prolific_study_id is null
    or v_study.prolific_study_id is distinct from p_prolific_study_id then
    raise exception 'PROLIFIC_STUDY_MISMATCH';
  end if;

  select * into v_response
  from public.participant_responses
  where study_id = p_study_id and prolific_submission_id = p_prolific_submission_id
  for update;

  if found then
    if v_response.prolific_participant_id is distinct from p_prolific_participant_id
      or v_response.prolific_study_id is distinct from p_prolific_study_id
      or v_response.participant_session_fingerprint is distinct from p_participant_session_fingerprint then
      raise exception 'PARTICIPANT_IDENTITY_MISMATCH';
    end if;
    if v_response.status = 'completed' and p_provider_status not in ('AWAITING REVIEW', 'APPROVED') then
      raise exception 'COMPLETED_REVISIT_STATUS_INVALID';
    end if;

    update public.participant_responses
    set last_provider_status = p_provider_status,
        provider_validated_at = clock_timestamp()
    where id = v_response.id;

    return jsonb_build_object(
      'responseId', v_response.id,
      'created', false,
      'status', v_response.status,
      'consented', v_response.consented_at is not null,
      'completed', v_response.status = 'completed'
    );
  end if;

  if p_provider_status not in ('RESERVED', 'ACTIVE') then
    raise exception 'PROVIDER_SUBMISSION_NOT_COLLECTABLE';
  end if;
  if v_study.status not in (
    'collecting', 'reconciling', 'ready_to_report', 'reporting', 'complete'
  ) then
    raise exception 'STUDY_NOT_COLLECTING';
  end if;
  if v_study.manual_finish_at is not null and (
    v_study.pause_cutoff_at is null or p_provider_started_at > v_study.pause_cutoff_at
  ) then
    raise exception 'PARTICIPANT_STARTED_AFTER_PAUSE';
  end if;

  insert into public.participant_responses (
    study_id, prolific_participant_id, prolific_submission_id, prolific_study_id,
    provider_started_at, last_provider_status, provider_validated_at,
    participant_session_fingerprint
  ) values (
    p_study_id, p_prolific_participant_id, p_prolific_submission_id, p_prolific_study_id,
    p_provider_started_at, p_provider_status, clock_timestamp(),
    p_participant_session_fingerprint
  )
  returning * into v_response;

  return jsonb_build_object(
    'responseId', v_response.id,
    'created', true,
    'status', v_response.status,
    'consented', false,
    'completed', false
  );
end;
$$;

create function public.record_participant_consent(
  p_study_id uuid,
  p_participant_session_fingerprint text,
  p_agreed boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_response public.participant_responses%rowtype;
begin
  select * into v_response
  from public.participant_responses
  where study_id = p_study_id
    and participant_session_fingerprint = p_participant_session_fingerprint
  for update;

  if not found then raise exception 'PARTICIPANT_SESSION_NOT_FOUND'; end if;
  if v_response.status = 'completed' then return false; end if;
  if v_response.status = 'declined' then
    if not p_agreed then return false; end if;
    raise exception 'CONSENT_DECLINE_IS_FINAL';
  end if;
  if v_response.status <> 'started' then raise exception 'PARTICIPANT_NOT_STARTABLE'; end if;

  if p_agreed then
    if v_response.consented_at is not null then return false; end if;
    update public.participant_responses
    set consented_at = clock_timestamp()
    where id = v_response.id;
  else
    update public.participant_responses
    set status = 'declined',
        declined_at = clock_timestamp()
    where id = v_response.id;
  end if;
  return true;
end;
$$;

create function public.submit_participant_response(
  p_study_id uuid,
  p_participant_session_fingerprint text,
  p_answer_fingerprint text,
  p_answers jsonb,
  p_readable_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_response public.participant_responses%rowtype;
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_ready boolean := false;
begin
  if p_answer_fingerprint !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_answers) <> 'object'
    or jsonb_typeof(p_readable_summary) <> 'array' then
    raise exception 'INVALID_SUBMISSION_PAYLOAD';
  end if;

  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;

  select * into v_response
  from public.participant_responses
  where study_id = p_study_id
    and participant_session_fingerprint = p_participant_session_fingerprint
  for update;
  if not found then raise exception 'PARTICIPANT_SESSION_NOT_FOUND'; end if;

  if v_response.status = 'completed' then
    if v_response.answer_fingerprint = p_answer_fingerprint
      and v_response.answers = p_answers then
      return jsonb_build_object(
        'applied', false,
        'responseId', v_response.id,
        'reportBecameReady', false,
        'completionCode', v_study.prolific_completion_code
      );
    end if;
    raise exception 'DIFFERING_DUPLICATE_SUBMISSION';
  end if;

  if v_response.status <> 'started' or v_response.consented_at is null then
    raise exception 'CONSENT_REQUIRED';
  end if;
  if v_study.status not in (
    'collecting', 'reconciling', 'ready_to_report', 'reporting', 'complete'
  ) then
    raise exception 'STUDY_NOT_ACCEPTING_RESPONSES';
  end if;
  if v_study.manual_finish_at is not null and (
    v_study.pause_cutoff_at is null
    or v_response.provider_started_at > v_study.pause_cutoff_at
  ) then
    raise exception 'PARTICIPANT_STARTED_AFTER_PAUSE';
  end if;

  update public.participant_responses
  set status = 'completed',
      answer_fingerprint = p_answer_fingerprint,
      answers = p_answers,
      readable_summary = p_readable_summary,
      submitted_at = v_now
  where id = v_response.id;

  select count(*) into v_count
  from public.participant_responses pr
  where pr.study_id = p_study_id and pr.status = 'completed' and pr.submitted_at <= v_now;

  if v_study.report_snapshot_at is null and v_count >= v_study.participant_count then
    update public.studies
    set status = 'ready_to_report',
        report_snapshot_at = v_now,
        report_completion_reason = 'target',
        report_sample_size = v_count,
        operation_stage = 'report_ready',
        operation_heartbeat_at = v_now,
        version = version + 1
    where id = p_study_id;

    insert into public.reports (
      study_id, status, sample_size, snapshot_cutoff_at, completion_reason
    ) values (
      p_study_id, 'ready', v_count, v_now, 'target'
    );
    v_ready := true;
  end if;

  return jsonb_build_object(
    'applied', true,
    'responseId', v_response.id,
    'reportBecameReady', v_ready,
    'completedCount', v_count,
    'completionCode', v_study.prolific_completion_code
  );
end;
$$;

create function public.claim_manual_pause(
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
  v_count integer;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;

  select * into v_event from public.provider_events
  where provider = 'prolific' and operation = 'pause_study'
    and local_operation_key = 'pause:' || p_study_id::text
  for update;
  if found then
    if v_event.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PAUSE_OPERATION_CONFLICT';
    end if;
    return jsonb_build_object('applied', false, 'eventId', v_event.id, 'status', v_event.status);
  end if;

  if v_study.status <> 'collecting' or v_study.manual_finish_at is not null
    or v_study.launch_confirmed_at is null
    or v_study.launch_confirmed_at > clock_timestamp() - interval '2 minutes' then
    raise exception 'MANUAL_FINISH_NOT_AVAILABLE';
  end if;

  select count(*) into v_count from public.participant_responses pr
  where pr.study_id = p_study_id and pr.status = 'completed';
  if v_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'; end if;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'pause_study', 'pause:' || p_study_id::text, p_study_id,
    p_request_fingerprint, p_sanitized_request, clock_timestamp()
  ) returning * into v_event;

  update public.studies
  set pause_requested_at = clock_timestamp(),
      operation_stage = 'pausing',
      operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      version = version + 1
  where id = p_study_id;

  return jsonb_build_object('applied', true, 'eventId', v_event.id, 'status', v_event.status);
end;
$$;

create function public.confirm_manual_pause(
  p_study_id uuid,
  p_provider_event_id uuid,
  p_pause_cutoff_at timestamptz default null
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
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_cutoff timestamptz;
begin
  select * into v_control from public.event_control where singleton = true for update;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_event from public.provider_events where id = p_provider_event_id for update;

  if v_study.manual_finish_at is not null then return false; end if;
  if not found or v_event.study_id is distinct from p_study_id
    or v_event.provider <> 'prolific' or v_event.operation <> 'pause_study'
    or v_event.status <> 'succeeded' or v_event.effect_evidence <> 'non_recruiting'
    or v_event.external_status <> 'PAUSED' then
    raise exception 'PAUSE_EVIDENCE_INVALID';
  end if;
  if v_study.budget_state <> 'committed' or v_study.slot_state <> 'held'
    or v_study.report_snapshot_at is not null then
    raise exception 'STUDY_NOT_PAUSE_CONFIRMABLE';
  end if;
  if v_control.held_slot_count <= 0 then raise exception 'EVENT_COUNTER_CORRUPT'; end if;

  v_cutoff := coalesce(p_pause_cutoff_at, v_event.observed_at, v_now);
  if v_cutoff > v_now + interval '1 minute' then raise exception 'PAUSE_CUTOFF_INVALID'; end if;

  select count(*) into v_count
  from public.participant_responses pr
  where pr.study_id = p_study_id and pr.status = 'completed' and pr.submitted_at <= v_now;
  if v_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'; end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);
  update public.event_control
  set held_slot_count = held_slot_count - 1,
      version = version + 1
  where singleton = true;

  update public.studies
  set prolific_status = 'PAUSED',
          provider_status_checked_at = clock_timestamp(),
      pause_confirmed_at = v_now,
      pause_cutoff_at = v_cutoff,
      manual_finish_at = v_now,
      slot_state = 'released',
      slot_released_at = v_now,
      slot_release_reason = 'manual_pause_confirmed',
      report_snapshot_at = v_now,
      report_completion_reason = 'manual',
      report_sample_size = v_count,
      status = 'ready_to_report',
      operation_stage = 'report_ready',
      operation_heartbeat_at = v_now,
      provider_request_ids = case
        when v_event.provider_request_id is null then provider_request_ids
        else provider_request_ids || jsonb_build_array(v_event.provider_request_id)
      end,
      recovery_claim_token = null,
      recovery_claimed_at = null,
      version = version + 1
  where id = p_study_id;

  insert into public.reports (
    study_id, status, sample_size, snapshot_cutoff_at, completion_reason
  ) values (
    p_study_id, 'ready', v_count, v_now, 'manual'
  );
  return true;
end;
$$;

create function public.claim_final_stop(
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
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.manual_finish_at is null or v_study.pause_confirmed_at is null
    or v_study.prolific_status <> 'PAUSED' then
    raise exception 'STUDY_NOT_STOPPABLE';
  end if;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'stop_study', 'stop:' || p_study_id::text, p_study_id,
    p_request_fingerprint, p_sanitized_request, clock_timestamp()
  )
  on conflict (provider, operation, local_operation_key) do nothing
  returning * into v_event;

  if not found then
    select * into v_event from public.provider_events
    where provider = 'prolific' and operation = 'stop_study'
      and local_operation_key = 'stop:' || p_study_id::text;
    if v_event.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'STOP_OPERATION_CONFLICT';
    end if;
    return jsonb_build_object('applied', false, 'eventId', v_event.id, 'status', v_event.status);
  end if;

  update public.studies
  set final_stop_requested_at = clock_timestamp(),
      operation_stage = 'stopping',
      operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      version = version + 1
  where id = p_study_id;
  return jsonb_build_object('applied', true, 'eventId', v_event.id, 'status', v_event.status);
end;
$$;

create function public.confirm_final_stop(
  p_study_id uuid,
  p_provider_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_event public.provider_events%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_event from public.provider_events where id = p_provider_event_id for update;

  if v_study.final_stop_confirmed_at is not null then return false; end if;
  if not found or v_event.study_id is distinct from p_study_id
    or v_event.operation <> 'stop_study' or v_event.status <> 'succeeded'
    or v_event.effect_evidence <> 'non_recruiting'
    or v_event.external_status not in ('AWAITING REVIEW', 'COMPLETED') then
    raise exception 'STOP_EVIDENCE_INVALID';
  end if;

  update public.studies
  set final_stop_confirmed_at = clock_timestamp(),
      prolific_status = v_event.external_status,
      provider_status_checked_at = clock_timestamp(),
      operation_stage = 'stopped',
      operation_heartbeat_at = clock_timestamp(),
      provider_request_ids = case
        when v_event.provider_request_id is null then provider_request_ids
        else provider_request_ids || jsonb_build_array(v_event.provider_request_id)
      end,
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.claim_report(
  p_study_id uuid,
  p_event_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_study public.studies%rowtype;
  v_report public.reports%rowtype;
  v_token uuid;
  v_attempt integer;
begin
  select * into v_control from public.event_control where singleton = true;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;

  select * into v_report from public.reports where study_id = p_study_id for update;
  if not found then raise exception 'REPORT_NOT_FOUND'; end if;

  if v_report.status <> 'ready' or v_study.status <> 'ready_to_report' then
    return jsonb_build_object(
      'applied', false,
      'status', v_report.status,
      'attemptCount', v_report.attempt_count
    );
  end if;
  if v_report.attempt_count > v_control.max_report_attempts
    and v_report.attempt_count <> 0 then
    update public.reports
    set status = 'blocked', claim_token = null, heartbeat_at = null,
        error_code = 'MAX_REPORT_ATTEMPTS'
    where study_id = p_study_id;
    update public.studies
    set status = 'blocked', failure_stage = 'report', failure_code = 'MAX_REPORT_ATTEMPTS',
        failed_at = clock_timestamp(), version = version + 1
    where id = p_study_id;
    return jsonb_build_object('applied', false, 'status', 'blocked');
  end if;

  v_token := gen_random_uuid();
  v_attempt := case when v_report.attempt_count = 0 then 1 else v_report.attempt_count end;
  update public.reports
  set status = 'reporting',
      attempt_count = v_attempt,
      claim_token = v_token,
      heartbeat_at = clock_timestamp(),
      error_code = null,
      error_message = null
  where study_id = p_study_id;
  update public.studies
  set status = 'reporting',
      operation_stage = 'reporting',
      operation_heartbeat_at = clock_timestamp(),
      version = version + 1
  where id = p_study_id;

  return jsonb_build_object(
    'applied', true,
    'studyId', p_study_id,
    'claimToken', v_token,
    'attemptCount', v_attempt,
    'sampleSize', v_report.sample_size,
    'snapshotCutoffAt', v_report.snapshot_cutoff_at,
    'completionReason', v_report.completion_reason
  );
end;
$$;

create function public.claim_ready_reports(p_limit integer default null)
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
  v_attempt integer;
begin
  select * into v_control from public.event_control where singleton = true;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  v_limit := least(greatest(coalesce(p_limit, v_control.recovery_batch_size), 1), 100);

  for v_row in
    select r.study_id, r.sample_size, r.snapshot_cutoff_at,
      r.completion_reason, r.attempt_count
    from public.reports r
    join public.studies s on s.id = r.study_id
    where r.status = 'ready' and s.status = 'ready_to_report'
    order by r.created_at
    limit v_limit
    for update of r, s skip locked
  loop
    if v_row.attempt_count > v_control.max_report_attempts and v_row.attempt_count <> 0 then
      update public.reports
      set status = 'blocked', claim_token = null, heartbeat_at = null,
          error_code = 'MAX_REPORT_ATTEMPTS'
      where study_id = v_row.study_id;
      update public.studies
      set status = 'blocked', failure_stage = 'report', failure_code = 'MAX_REPORT_ATTEMPTS',
          failed_at = clock_timestamp(), version = version + 1
      where id = v_row.study_id;
      continue;
    end if;

    v_token := gen_random_uuid();
    v_attempt := case when v_row.attempt_count = 0 then 1 else v_row.attempt_count end;
    update public.reports
    set status = 'reporting', attempt_count = v_attempt,
        claim_token = v_token, heartbeat_at = clock_timestamp(),
        error_code = null, error_message = null
    where study_id = v_row.study_id;
    update public.studies
    set status = 'reporting', operation_stage = 'reporting',
        operation_heartbeat_at = clock_timestamp(), version = version + 1
    where id = v_row.study_id;

    return next jsonb_build_object(
      'studyId', v_row.study_id,
      'claimToken', v_token,
      'attemptCount', v_attempt,
      'sampleSize', v_row.sample_size,
      'snapshotCutoffAt', v_row.snapshot_cutoff_at,
      'completionReason', v_row.completion_reason
    );
  end loop;
  return;
end;
$$;

create function public.heartbeat_report(
  p_study_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.reports
  set heartbeat_at = clock_timestamp()
  where study_id = p_study_id and status = 'reporting' and claim_token = p_claim_token;
  if not found then return false; end if;

  update public.studies
  set operation_heartbeat_at = clock_timestamp()
  where id = p_study_id and status = 'reporting';
  return true;
end;
$$;

create function public.complete_report(
  p_study_id uuid,
  p_claim_token uuid,
  p_deterministic_aggregates jsonb,
  p_narrative jsonb,
  p_ai_provider text,
  p_ai_model text,
  p_sanitized_provider_metadata jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_report public.reports%rowtype;
  v_count integer;
begin
  if jsonb_typeof(p_deterministic_aggregates) <> 'object'
    or jsonb_typeof(p_narrative) <> 'object'
    or p_ai_provider not in ('gemini', 'openai') then
    raise exception 'INVALID_REPORT_PAYLOAD';
  end if;

  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_report from public.reports where study_id = p_study_id for update;
  if not found then raise exception 'REPORT_NOT_FOUND'; end if;

  if v_report.status = 'complete' then return false; end if;
  if v_study.status <> 'reporting' or v_report.status <> 'reporting'
    or v_report.claim_token is distinct from p_claim_token then
    raise exception 'STALE_REPORT_CLAIM';
  end if;

  select count(*) into v_count
  from public.participant_responses pr
  where pr.study_id = p_study_id
    and pr.status = 'completed'
    and pr.submitted_at <= v_report.snapshot_cutoff_at;
  if v_count <> v_report.sample_size or v_count <> v_study.report_sample_size then
    raise exception 'REPORT_SAMPLE_INVARIANT_FAILED';
  end if;

  update public.reports
  set status = 'complete',
      deterministic_aggregates = p_deterministic_aggregates,
      narrative = p_narrative,
      ai_provider = p_ai_provider,
      ai_model = p_ai_model,
      sanitized_provider_metadata = p_sanitized_provider_metadata,
      claim_token = null,
      heartbeat_at = null,
      error_code = null,
      error_message = null,
      completed_at = clock_timestamp()
  where study_id = p_study_id;
  update public.studies
  set status = 'complete',
      operation_stage = 'complete',
      operation_heartbeat_at = clock_timestamp(),
      completed_at = clock_timestamp(),
      failure_stage = null,
      failure_code = null,
      failure_message = null,
      failed_at = null,
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.fail_report_attempt(
  p_study_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_error_message text,
  p_retryable boolean
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_study public.studies%rowtype;
  v_report public.reports%rowtype;
begin
  select * into v_control from public.event_control where singleton = true;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_report from public.reports where study_id = p_study_id for update;
  if not found then raise exception 'REPORT_NOT_FOUND'; end if;
  if v_report.status <> 'reporting' or v_report.claim_token is distinct from p_claim_token then
    return 'stale';
  end if;

  if p_retryable and v_report.attempt_count < v_control.max_report_attempts then
    update public.reports
    set status = 'ready', attempt_count = attempt_count + 1,
        claim_token = null, heartbeat_at = null,
        error_code = p_error_code, error_message = p_error_message
    where study_id = p_study_id;
    update public.studies
    set status = 'ready_to_report', operation_stage = 'report_ready',
        operation_heartbeat_at = clock_timestamp(),
        failure_stage = 'report', failure_code = p_error_code,
        failure_message = p_error_message, failed_at = clock_timestamp(),
        version = version + 1
    where id = p_study_id;
    return 'ready';
  end if;

  update public.reports
  set status = 'blocked', claim_token = null, heartbeat_at = null,
      error_code = p_error_code, error_message = p_error_message
  where study_id = p_study_id;
  update public.studies
  set status = 'blocked', operation_stage = 'blocked',
      operation_heartbeat_at = clock_timestamp(),
      failure_stage = 'report', failure_code = p_error_code,
      failure_message = p_error_message, failed_at = clock_timestamp(),
      version = version + 1
  where id = p_study_id;
  return 'blocked';
end;
$$;

create function public.recover_stale_reports(p_limit integer default null)
returns setof jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_row record;
  v_limit integer;
begin
  select * into v_control from public.event_control where singleton = true;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  v_limit := least(greatest(coalesce(p_limit, v_control.recovery_batch_size), 1), 100);

  for v_row in
    select r.study_id, r.attempt_count
    from public.reports r
    join public.studies s on s.id = r.study_id
    where r.status = 'reporting'
      and r.heartbeat_at < clock_timestamp() - make_interval(secs => v_control.report_stale_seconds)
    order by r.heartbeat_at
    limit v_limit
    for update of r, s skip locked
  loop
    if v_row.attempt_count >= v_control.max_report_attempts then
      update public.reports
      set status = 'blocked', claim_token = null, heartbeat_at = null,
          error_code = 'STALE_MAX_ATTEMPTS', error_message = 'Report worker stopped responding.'
      where study_id = v_row.study_id;
      update public.studies
      set status = 'blocked', operation_stage = 'blocked',
          failure_stage = 'report', failure_code = 'STALE_MAX_ATTEMPTS',
          failure_message = 'Report worker stopped responding.', failed_at = clock_timestamp(),
          version = version + 1
      where id = v_row.study_id;
      return next jsonb_build_object(
        'studyId', v_row.study_id, 'action', 'blocked', 'attemptCount', v_row.attempt_count
      );
    else
      update public.reports
      set status = 'ready', attempt_count = attempt_count + 1,
          claim_token = null, heartbeat_at = null,
          error_code = 'STALE_RECOVERED', error_message = 'A stale report claim was recovered.'
      where study_id = v_row.study_id;
      update public.studies
      set status = 'ready_to_report', operation_stage = 'report_ready',
          operation_heartbeat_at = clock_timestamp(),
          failure_stage = 'report', failure_code = 'STALE_RECOVERED',
          failure_message = 'A stale report claim was recovered.', failed_at = clock_timestamp(),
          version = version + 1
      where id = v_row.study_id;
      return next jsonb_build_object(
        'studyId', v_row.study_id, 'action', 'ready', 'attemptCount', v_row.attempt_count + 1
      );
    end if;
  end loop;
  return;
end;
$$;

create function public.retry_blocked_report(
  p_study_id uuid,
  p_event_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
  v_report public.reports%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  select * into v_report from public.reports where study_id = p_study_id for update;
  if not found then raise exception 'REPORT_NOT_FOUND'; end if;
  if v_report.status = 'ready' and v_study.status = 'ready_to_report' then return false; end if;
  if v_report.status <> 'blocked' or v_study.status <> 'blocked' then
    raise exception 'REPORT_NOT_BLOCKED';
  end if;

  update public.reports
  set status = 'ready', attempt_count = 0, claim_token = null, heartbeat_at = null,
      error_code = null, error_message = null
  where study_id = p_study_id;
  update public.studies
  set status = 'ready_to_report', operation_stage = 'report_ready',
      operation_heartbeat_at = clock_timestamp(),
      failure_stage = null, failure_code = null, failure_message = null, failed_at = null,
      version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create unique index participant_responses_session_fingerprint_idx
  on public.participant_responses (study_id, participant_session_fingerprint);

create function public.claim_stale_provider_operations(p_limit integer default null)
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
    where s.operation_stage in ('creating', 'publishing', 'reconciling', 'pausing', 'stopping')
      and s.operation_heartbeat_at < clock_timestamp() - make_interval(secs => v_control.stale_launch_seconds)
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

create function public.claim_study_reconciliation(
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
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if v_study.operation_stage not in ('creating', 'publishing', 'reconciling', 'pausing', 'stopping') then
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

create function public.apply_launch_reconciliation(
  p_study_id uuid,
  p_claim_token uuid,
  p_provider_event_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control public.event_control%rowtype;
  v_study public.studies%rowtype;
  v_event public.provider_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  select * into v_control from public.event_control where singleton = true for update;
  if not found then raise exception 'EVENT_CONTROL_MISSING'; end if;
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.recovery_claim_token is distinct from p_claim_token then
    raise exception 'STALE_RECOVERY_CLAIM';
  end if;
  select * into v_event from public.provider_events where id = p_provider_event_id for update;
  if not found or v_event.study_id is distinct from p_study_id or v_event.provider <> 'prolific' then
    raise exception 'RECONCILIATION_EVIDENCE_INVALID';
  end if;

  if v_event.status = 'ambiguous' and v_event.effect_evidence = 'unknown' then
    update public.studies
    set status = case
          when status in ('launching', 'reconciling') then 'reconciling'::public.study_status
          else status
        end,
        operation_stage = 'reconciling',
        operation_heartbeat_at = v_now,
        recovery_claim_token = null,
        recovery_claimed_at = null,
        failure_stage = 'reconciliation',
        failure_code = coalesce(v_event.error_code, 'AMBIGUOUS_PROVIDER_RESULT'),
        failure_message = v_event.error_message,
        failed_at = v_now,
        version = version + 1
    where id = p_study_id;
    return 'retained';
  end if;

  if v_event.status not in ('succeeded', 'definitive_failure') then
    raise exception 'RECONCILIATION_EVIDENCE_NOT_FINAL';
  end if;

  perform set_config('surveyor.lifecycle_rpc', 'on', true);

  if v_event.effect_evidence in (
    'request_not_dispatched', 'definitive_no_create', 'external_deleted'
  ) then
    if v_study.budget_state = 'committed' then
      raise exception 'COMMITTED_STUDY_CANNOT_BE_ABANDONED';
    end if;
    if v_study.budget_state = 'reserved' then
      if v_control.reserved_budget_cents < v_study.budget_amount_cents then
        raise exception 'EVENT_COUNTER_CORRUPT';
      end if;
      update public.event_control
      set reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents,
          held_slot_count = held_slot_count - case when v_study.slot_state = 'held' then 1 else 0 end,
          version = version + 1
      where singleton = true;
    elsif v_study.slot_state = 'held' then
      update public.event_control
      set held_slot_count = held_slot_count - 1, version = version + 1
      where singleton = true;
    end if;

    update public.studies
    set budget_state = case
          when budget_state = 'reserved' then 'void'::public.budget_state else budget_state
        end,
        budget_voided_at = case when budget_state = 'reserved' then v_now else budget_voided_at end,
        slot_state = case when slot_state = 'held' then 'released'::public.slot_state else slot_state end,
        slot_released_at = case when slot_state = 'held' then v_now else slot_released_at end,
        slot_release_reason = case when slot_state = 'held' then 'reconciled_no_spend' else slot_release_reason end,
        status = 'abandoned',
        operation_stage = 'abandoned',
        operation_heartbeat_at = v_now,
        recovery_claim_token = null,
        recovery_claimed_at = null,
        failure_stage = 'reconciliation',
        failure_code = coalesce(v_event.error_code, 'NO_EXTERNAL_SPEND'),
        failure_message = v_event.error_message,
        failed_at = v_now,
        version = version + 1
    where id = p_study_id;
    return 'abandoned';
  end if;

  if v_event.effect_evidence = 'draft_exists' then
    if v_event.external_resource_id is null or v_event.external_status <> 'UNPUBLISHED' then
      raise exception 'UNPUBLISHED_DRAFT_EVIDENCE_INVALID';
    end if;
    if v_study.prolific_study_id is not null
      and v_study.prolific_study_id is distinct from v_event.external_resource_id then
      raise exception 'PROLIFIC_STUDY_ID_CONFLICT';
    end if;
    if v_study.budget_state <> 'reserved' or v_study.slot_state <> 'held' then
      raise exception 'DRAFT_RESERVATION_MISSING';
    end if;

    update public.studies
    set prolific_study_id = coalesce(prolific_study_id, v_event.external_resource_id),
        prolific_status = 'UNPUBLISHED',
      provider_status_checked_at = clock_timestamp(),
        prolific_is_ready_to_publish = case
          when jsonb_typeof(v_event.sanitized_response -> 'is_ready_to_publish') = 'boolean'
            then (v_event.sanitized_response ->> 'is_ready_to_publish')::boolean
          else prolific_is_ready_to_publish
        end,
        prolific_ready_evidence_at = case
          when jsonb_typeof(v_event.sanitized_response -> 'is_ready_to_publish') = 'boolean'
            then coalesce(v_event.observed_at, v_now)
          else prolific_ready_evidence_at
        end,
        prolific_payload = coalesce(v_event.sanitized_response, prolific_payload),
        status = 'launching',
        -- A reconciled unpublished draft still needs the publish step. Leave it
        -- in a stale-eligible publish stage so unattended recovery can claim it
        -- immediately; claim_publish_study remains the sole creator of a publish
        -- operation and enforces the one-retry ceiling.
        operation_stage = 'publishing',
        operation_heartbeat_at = v_now
          - make_interval(secs => v_control.stale_launch_seconds + 1),
        draft_created_at = coalesce(draft_created_at, v_now),
        recovery_claim_token = null,
        recovery_claimed_at = null,
        failure_stage = null, failure_code = null, failure_message = null, failed_at = null,
        version = version + 1
    where id = p_study_id;
    return 'draft_adopted';
  end if;

  if v_event.effect_evidence = 'published_or_spend_possible' then
    if v_event.external_status not in ('PUBLISHING', 'ACTIVE')
      or v_event.external_resource_id is null
      or (v_study.prolific_study_id is not null
        and v_event.external_resource_id is distinct from v_study.prolific_study_id) then
      raise exception 'ACTIVE_STUDY_EVIDENCE_INVALID';
    end if;
    if v_study.budget_state = 'reserved' then
      if v_control.reserved_budget_cents < v_study.budget_amount_cents then
        raise exception 'EVENT_COUNTER_CORRUPT';
      end if;
      update public.event_control
      set reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents,
          lifetime_committed_budget_cents = lifetime_committed_budget_cents + v_study.budget_amount_cents,
          version = version + 1
      where singleton = true;
    elsif v_study.budget_state <> 'committed' then
      raise exception 'ACTIVE_STUDY_BUDGET_INVALID';
    end if;

    update public.studies
    set budget_state = 'committed',
        prolific_study_id = coalesce(prolific_study_id, v_event.external_resource_id),
        budget_committed_at = coalesce(budget_committed_at, v_now),
        prolific_status = v_event.external_status,
      provider_status_checked_at = clock_timestamp(),
        status = 'collecting',
        operation_stage = 'collecting',
        operation_heartbeat_at = v_now,
        launch_confirmed_at = coalesce(launch_confirmed_at, v_now),
        recovery_claim_token = null,
        recovery_claimed_at = null,
        failure_stage = null, failure_code = null, failure_message = null, failed_at = null,
        version = version + 1
    where id = p_study_id;
    return 'collecting';
  end if;

  if v_event.effect_evidence = 'non_recruiting' then
    if v_event.external_status not in ('PAUSED', 'AWAITING REVIEW', 'COMPLETED')
      or v_event.external_resource_id is null
      or (v_study.prolific_study_id is not null
        and v_event.external_resource_id is distinct from v_study.prolific_study_id) then
      raise exception 'NON_RECRUITING_EVIDENCE_INVALID';
    end if;

    if v_study.budget_state = 'reserved' then
      if v_control.reserved_budget_cents < v_study.budget_amount_cents then
        raise exception 'EVENT_COUNTER_CORRUPT';
      end if;
      update public.event_control
      set reserved_budget_cents = reserved_budget_cents - v_study.budget_amount_cents,
          lifetime_committed_budget_cents = lifetime_committed_budget_cents + v_study.budget_amount_cents,
          held_slot_count = held_slot_count - case when v_study.slot_state = 'held' then 1 else 0 end,
          version = version + 1
      where singleton = true;
    elsif v_study.budget_state = 'committed' and v_study.slot_state = 'held' then
      update public.event_control
      set held_slot_count = held_slot_count - 1, version = version + 1
      where singleton = true;
    elsif v_study.budget_state <> 'committed' then
      raise exception 'NON_RECRUITING_BUDGET_INVALID';
    end if;

    if v_event.external_status = 'PAUSED' and v_study.pause_requested_at is not null
      and v_study.manual_finish_at is null then
      select count(*) into v_count
      from public.participant_responses pr
      where pr.study_id = p_study_id and pr.status = 'completed' and pr.submitted_at <= v_now;
      if v_count < 3 then raise exception 'MANUAL_FINISH_REQUIRES_THREE_RESPONSES'; end if;

      update public.studies
      set budget_state = 'committed',
          prolific_study_id = coalesce(prolific_study_id, v_event.external_resource_id),
          budget_committed_at = coalesce(budget_committed_at, v_now),
          slot_state = 'released', slot_released_at = v_now,
          slot_release_reason = 'reconciled_paused',
          prolific_status = 'PAUSED',
          provider_status_checked_at = clock_timestamp(),
          pause_confirmed_at = v_now,
          pause_cutoff_at = coalesce(v_event.observed_at, v_now),
          manual_finish_at = v_now,
          report_snapshot_at = v_now,
          report_completion_reason = 'manual', report_sample_size = v_count,
          status = 'ready_to_report', operation_stage = 'report_ready',
          operation_heartbeat_at = v_now,
          recovery_claim_token = null, recovery_claimed_at = null,
          version = version + 1
      where id = p_study_id;
      insert into public.reports (
        study_id, status, sample_size, snapshot_cutoff_at, completion_reason
      ) values (p_study_id, 'ready', v_count, v_now, 'manual');
      return 'paused_report_ready';
    end if;

    update public.studies
    set budget_state = 'committed',
        prolific_study_id = coalesce(prolific_study_id, v_event.external_resource_id),
        budget_committed_at = coalesce(budget_committed_at, v_now),
        slot_state = case when slot_state = 'held' then 'released'::public.slot_state else slot_state end,
        slot_released_at = case when slot_state = 'held' then v_now else slot_released_at end,
        slot_release_reason = case when slot_state = 'held' then 'provider_non_recruiting' else slot_release_reason end,
        prolific_status = v_event.external_status,
      provider_status_checked_at = clock_timestamp(),
        status = case when report_snapshot_at is null then 'blocked'::public.study_status else status end,
        final_stop_confirmed_at = case
          when v_study.operation_stage = 'stopping'
            and v_study.pause_confirmed_at is not null
            and v_event.external_status in ('AWAITING REVIEW', 'COMPLETED')
            then coalesce(final_stop_confirmed_at, v_now)
          else final_stop_confirmed_at
        end,
        operation_stage = case
          when v_study.operation_stage = 'stopping'
            and v_study.pause_confirmed_at is not null
            and v_event.external_status in ('AWAITING REVIEW', 'COMPLETED')
            then 'stopped'
          when report_snapshot_at is null then 'blocked'
          else operation_stage
        end,
        operation_heartbeat_at = v_now,
        recovery_claim_token = null, recovery_claimed_at = null,
        failure_stage = case when report_snapshot_at is null then 'reconciliation' else failure_stage end,
        failure_code = case when report_snapshot_at is null then 'ENDED_BEFORE_REPORT_SNAPSHOT' else failure_code end,
        failed_at = case when report_snapshot_at is null then v_now else failed_at end,
        version = version + 1
    where id = p_study_id;
    return 'non_recruiting';
  end if;

  update public.studies
  set status = 'blocked', operation_stage = 'blocked',
      operation_heartbeat_at = v_now,
      recovery_claim_token = null, recovery_claimed_at = null,
      failure_stage = 'reconciliation', failure_code = 'UNKNOWN_PROVIDER_STATE',
      failure_message = 'Provider state could not be mapped safely.', failed_at = v_now,
      version = version + 1
  where id = p_study_id;
  return 'blocked';
end;
$$;

create function public.event_control_audit()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'reservedCounter', ec.reserved_budget_cents,
    'reservedActual', coalesce(sums.reserved_actual, 0),
    'committedCounter', ec.lifetime_committed_budget_cents,
    'committedActual', coalesce(sums.committed_actual, 0),
    'heldCounter', ec.held_slot_count,
    'heldActual', coalesce(sums.held_actual, 0),
    'valid', ec.reserved_budget_cents = coalesce(sums.reserved_actual, 0)
      and ec.lifetime_committed_budget_cents = coalesce(sums.committed_actual, 0)
      and ec.held_slot_count = coalesce(sums.held_actual, 0)
  )
  from public.event_control ec
  cross join lateral (
    select
      sum(s.budget_amount_cents) filter (where s.budget_state = 'reserved') as reserved_actual,
      sum(s.budget_amount_cents) filter (where s.budget_state = 'committed') as committed_actual,
      count(*) filter (where s.slot_state = 'held')::integer as held_actual
    from public.studies s
  ) sums
  where ec.singleton = true;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

grant select, insert, update, delete on table public.event_control to service_role;
grant select, insert, update, delete on table public.event_sessions to service_role;
grant select, insert, update, delete on table public.intake_sessions to service_role;
grant select, insert, update, delete on table public.studies to service_role;
grant select, insert, update, delete on table public.provider_events to service_role;
grant select, insert, update, delete on table public.participant_responses to service_role;
grant select, insert, update, delete on table public.reports to service_role;
grant select, insert, update, delete on table public.rate_limit_policies to service_role;
grant select, insert, update, delete on table public.rate_limit_buckets to service_role;

create function public.consume_source_intake()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_intake public.intake_sessions%rowtype;
begin
  if new.source_intake_id is null then return new; end if;

  select * into v_intake
  from public.intake_sessions
  where id = new.source_intake_id
  for update;
  if not found then raise exception 'SOURCE_INTAKE_NOT_FOUND'; end if;
  if v_intake.expires_at <= clock_timestamp() then raise exception 'SOURCE_INTAKE_EXPIRED'; end if;

  if new.event_session_id is null then
    new.event_session_id := v_intake.event_session_id;
  elsif v_intake.event_session_id is not null
    and new.event_session_id is distinct from v_intake.event_session_id then
    raise exception 'SOURCE_INTAKE_SESSION_MISMATCH';
  end if;

  if v_intake.status = 'ready' then
    update public.intake_sessions
    set status = 'consumed', version = version + 1
    where id = v_intake.id;
  elsif v_intake.status = 'consumed' and exists (
    select 1 from public.studies s where s.source_intake_id = v_intake.id
  ) then
    null;
  else
    raise exception 'SOURCE_INTAKE_NOT_READY';
  end if;
  return new;
end;
$$;

create trigger studies_consume_source_intake_before_insert
before insert on public.studies
for each row execute function public.consume_source_intake();

create function public.accept_study_proxy(
  p_study_id uuid,
  p_event_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_study public.studies%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if v_study.targeting_status <> 'proxy' then raise exception 'STUDY_IS_NOT_PROXY'; end if;
  if v_study.status <> 'draft' or v_study.budget_state <> 'none' then
    raise exception 'PROXY_ACCEPTANCE_TOO_LATE';
  end if;
  if v_study.proxy_accepted_at is not null then return false; end if;

  update public.studies
  set proxy_accepted_at = clock_timestamp(), version = version + 1
  where id = p_study_id;
  return true;
end;
$$;

create function public.claim_create_retry_after_reconciliation(
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
  v_evidence public.provider_events%rowtype;
  v_retry public.provider_events%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_evidence from public.provider_events where id = p_reconciliation_event_id for update;
  if not found or v_evidence.study_id is distinct from p_study_id
    or v_evidence.provider <> 'prolific'
    or v_evidence.status not in ('succeeded', 'definitive_failure')
    or v_evidence.effect_evidence <> 'definitive_no_create' then
    raise exception 'NO_CREATE_RECONCILIATION_REQUIRED';
  end if;
  if v_study.prolific_study_id is not null or v_study.budget_state <> 'reserved'
    or v_study.slot_state <> 'held' or v_study.status not in ('launching', 'reconciling') then
    raise exception 'CREATE_RETRY_NOT_SAFE';
  end if;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'create_study_retry', 'create-retry:' || p_study_id::text, p_study_id,
    p_request_fingerprint, p_sanitized_request, clock_timestamp()
  )
  on conflict (provider, operation, local_operation_key) do nothing
  returning * into v_retry;

  if not found then
    select * into v_retry from public.provider_events
    where provider = 'prolific' and operation = 'create_study_retry'
      and local_operation_key = 'create-retry:' || p_study_id::text;
    if v_retry.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'CREATE_RETRY_CONFLICT';
    end if;
    return jsonb_build_object('applied', false, 'eventId', v_retry.id, 'status', v_retry.status);
  end if;

  update public.studies
  set status = 'launching', operation_stage = 'creating',
      operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      recovery_claim_token = null, recovery_claimed_at = null,
      version = version + 1
  where id = p_study_id;
  return jsonb_build_object('applied', true, 'eventId', v_retry.id, 'status', v_retry.status);
end;
$$;

create function public.claim_publish_retry_after_reconciliation(
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
  v_evidence public.provider_events%rowtype;
  v_retry public.provider_events%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  select * into v_evidence from public.provider_events where id = p_reconciliation_event_id for update;
  if not found or v_evidence.study_id is distinct from p_study_id
    or v_evidence.provider <> 'prolific' or v_evidence.status <> 'succeeded'
    or v_evidence.effect_evidence <> 'draft_exists'
    or v_evidence.external_status <> 'UNPUBLISHED'
    or v_evidence.external_resource_id is distinct from v_study.prolific_study_id then
    raise exception 'UNPUBLISHED_RECONCILIATION_REQUIRED';
  end if;
  if v_study.budget_state <> 'reserved' or v_study.slot_state <> 'held'
    or v_study.status not in ('launching', 'reconciling') then
    raise exception 'PUBLISH_RETRY_NOT_SAFE';
  end if;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'publish_study_retry', 'publish-retry:' || p_study_id::text, p_study_id,
    p_request_fingerprint, p_sanitized_request, clock_timestamp()
  )
  on conflict (provider, operation, local_operation_key) do nothing
  returning * into v_retry;

  if not found then
    select * into v_retry from public.provider_events
    where provider = 'prolific' and operation = 'publish_study_retry'
      and local_operation_key = 'publish-retry:' || p_study_id::text;
    if v_retry.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PUBLISH_RETRY_CONFLICT';
    end if;
    return jsonb_build_object('applied', false, 'eventId', v_retry.id, 'status', v_retry.status);
  end if;

  update public.studies
  set status = 'launching', operation_stage = 'publishing',
      publish_requested_at = clock_timestamp(), operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      recovery_claim_token = null, recovery_claimed_at = null,
      version = version + 1
  where id = p_study_id;
  return jsonb_build_object('applied', true, 'eventId', v_retry.id, 'status', v_retry.status);
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

drop function public.claim_publish_retry_after_reconciliation(uuid, uuid, text, jsonb);

create or replace function public.claim_publish_study(
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
  v_first public.provider_events%rowtype;
  v_second public.provider_events%rowtype;
  v_reconcile public.provider_events%rowtype;
begin
  select * into v_study from public.studies where id = p_study_id for update;
  if not found then raise exception 'STUDY_NOT_FOUND'; end if;
  if v_study.event_session_id is distinct from p_event_session_id then
    raise exception 'STUDY_SESSION_MISMATCH';
  end if;
  if not exists (
    select 1 from public.event_sessions es
    where es.id = p_event_session_id and es.revoked_at is null and es.expires_at > clock_timestamp()
  ) then
    raise exception 'EVENT_SESSION_INVALID';
  end if;
  if v_study.prolific_study_id is null or v_study.prolific_status <> 'UNPUBLISHED'
    or v_study.prolific_is_ready_to_publish is not true
    or v_study.budget_state <> 'reserved' or v_study.slot_state <> 'held'
    or v_study.status not in ('launching', 'reconciling') then
    raise exception 'STUDY_NOT_PUBLISHABLE';
  end if;

  select * into v_first
  from public.provider_events
  where provider = 'prolific' and operation = 'publish_study'
    and local_operation_key = 'publish:' || p_study_id::text || ':1'
  for update;

  if not found then
    insert into public.provider_events (
      provider, operation, local_operation_key, study_id,
      request_fingerprint, sanitized_request, heartbeat_at
    ) values (
      'prolific', 'publish_study', 'publish:' || p_study_id::text || ':1', p_study_id,
      p_request_fingerprint, p_sanitized_request, clock_timestamp()
    ) returning * into v_first;

    update public.studies
    set operation_stage = 'publishing', operation_heartbeat_at = clock_timestamp(),
        publish_requested_at = coalesce(publish_requested_at, clock_timestamp()),
        operation_attempt_count = operation_attempt_count + 1,
        version = version + 1
    where id = p_study_id;
    return jsonb_build_object(
      'eventId', v_first.id, 'applied', true, 'status', v_first.status, 'attempt', 1
    );
  end if;

  if v_first.request_fingerprint is distinct from p_request_fingerprint then
    raise exception 'PUBLISH_OPERATION_CONFLICT';
  end if;
  if v_first.status <> 'definitive_failure' then
    return jsonb_build_object(
      'eventId', v_first.id, 'applied', false, 'status', v_first.status, 'attempt', 1
    );
  end if;

  select * into v_reconcile
  from public.provider_events pe
  where pe.study_id = p_study_id
    and pe.provider = 'prolific'
    and pe.id <> v_first.id
    and pe.status = 'succeeded'
    and pe.effect_evidence = 'draft_exists'
    and pe.external_status = 'UNPUBLISHED'
    and pe.external_resource_id = v_study.prolific_study_id
    and pe.created_at >= coalesce(v_first.completed_at, v_first.updated_at)
  order by pe.created_at desc
  limit 1
  for update;
  if not found then raise exception 'PUBLISH_RETRY_REQUIRES_RECONCILIATION'; end if;

  select * into v_second
  from public.provider_events
  where provider = 'prolific' and operation = 'publish_study'
    and local_operation_key = 'publish:' || p_study_id::text || ':2'
  for update;
  if found then
    if v_second.request_fingerprint is distinct from p_request_fingerprint then
      raise exception 'PUBLISH_RETRY_CONFLICT';
    end if;
    return jsonb_build_object(
      'eventId', v_second.id, 'applied', false, 'status', v_second.status, 'attempt', 2
    );
  end if;

  insert into public.provider_events (
    provider, operation, local_operation_key, study_id,
    request_fingerprint, sanitized_request, heartbeat_at
  ) values (
    'prolific', 'publish_study', 'publish:' || p_study_id::text || ':2', p_study_id,
    p_request_fingerprint, p_sanitized_request, clock_timestamp()
  ) returning * into v_second;

  update public.studies
  set status = 'launching', operation_stage = 'publishing',
      publish_requested_at = clock_timestamp(), operation_heartbeat_at = clock_timestamp(),
      operation_attempt_count = operation_attempt_count + 1,
      recovery_claim_token = null, recovery_claimed_at = null,
      version = version + 1
  where id = p_study_id;
  return jsonb_build_object(
    'eventId', v_second.id, 'applied', true, 'status', v_second.status, 'attempt', 2
  );
end;
$$;

revoke execute on function public.claim_publish_study(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_publish_study(uuid, uuid, text, jsonb)
  to service_role;

create function public.valid_survey_spec_structure(p_spec jsonb)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_spec) <> 'object'
      or jsonb_typeof(p_spec -> 'questions') <> 'array'
      or jsonb_typeof(p_spec -> 'title') <> 'string'
      or jsonb_typeof(p_spec -> 'intro') <> 'string'
      or jsonb_typeof(p_spec -> 'estimatedMinutes') <> 'number'
      then false
    else (
      select count(*) between 3 and 5
        and count(distinct q ->> 'ref') = count(*)
        and count(*) filter (where q ->> 'type' = 'short_text') <= 1
        and bool_and(
          jsonb_typeof(q) = 'object'
          and coalesce(q ->> 'ref', '') ~ '^[a-z][a-z0-9_]{0,31}$'
          and q ->> 'type' in ('multiple_choice', 'opinion_scale', 'yes_no', 'short_text')
          and q -> 'required' = 'true'::jsonb
          and nullif(btrim(q ->> 'title'), '') is not null
          and (
            q ->> 'type' <> 'short_text'
            or q ->> 'description' = 'Do not include names or contact details.'
          )
          and (
            q ->> 'type' <> 'multiple_choice'
            or (
              jsonb_typeof(q -> 'choices') = 'array'
              and jsonb_array_length(q -> 'choices') between 2 and 10
            )
          )
          and (
            q ->> 'type' <> 'opinion_scale'
            or jsonb_typeof(q -> 'scale') = 'object'
          )
        )
      from jsonb_array_elements(p_spec -> 'questions') questions(q)
    )
  end;
$$;

create function public.valid_targeting_plan_structure(
  p_plan jsonb,
  p_status public.targeting_status
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_plan) <> 'object'
      or p_plan ->> 'status' is distinct from p_status::text
      or jsonb_typeof(p_plan -> 'filters') <> 'array'
      or jsonb_typeof(p_plan -> 'proxies') <> 'array'
      or jsonb_typeof(p_plan -> 'unsupportedCriteria') <> 'array'
      or jsonb_typeof(p_plan -> 'availability') <> 'object'
      then false
    when p_status = 'exact' then
      p_plan ->> 'confidence' = 'high'
      and jsonb_array_length(p_plan -> 'proxies') = 0
      and jsonb_array_length(p_plan -> 'unsupportedCriteria') = 0
    when p_status = 'proxy' then
      jsonb_array_length(p_plan -> 'proxies') > 0
    when p_status = 'unsupported' then
      jsonb_array_length(p_plan -> 'unsupportedCriteria') > 0
    else false
  end;
$$;

alter table public.studies
  add constraint studies_survey_spec_structure_strong_ck
  check (public.valid_survey_spec_structure(survey_spec));

alter table public.studies
  add constraint studies_survey_minutes_match_ck
  check (survey_spec ->> 'estimatedMinutes' is not distinct from estimated_minutes::text);

alter table public.studies
  add constraint studies_targeting_plan_structure_strong_ck
  check (public.valid_targeting_plan_structure(targeting_plan, targeting_status));

alter table public.studies
  add constraint studies_targeting_audiences_match_ck
  check (
    targeting_plan ->> 'requestedAudience' is not distinct from requested_audience
    and targeting_plan ->> 'recruitedAudience' is not distinct from recruited_audience
  );

alter table public.studies
  add constraint studies_budget_amount_authoritative_strong_ck
  check (
    budget_state = 'none'
    or (authoritative_total_cents is not null and budget_amount_cents = authoritative_total_cents)
  );

revoke execute on function public.valid_survey_spec_structure(jsonb)
  from public, anon, authenticated;
revoke execute on function public.valid_targeting_plan_structure(jsonb, public.targeting_status)
  from public, anon, authenticated;
grant execute on function public.valid_survey_spec_structure(jsonb) to service_role;
grant execute on function public.valid_targeting_plan_structure(jsonb, public.targeting_status) to service_role;
