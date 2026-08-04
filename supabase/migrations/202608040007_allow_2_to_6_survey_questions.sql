-- Migration 202608040007: Allow 2 to 6 survey questions in PostgreSQL studies table constraints

do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.studies'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%jsonb_array_length%questions%'
  loop
    execute format('alter table public.studies drop constraint %I', r.conname);
  end loop;
end $$;

-- Add updated table check constraint (2 to 6 questions)
alter table public.studies
  add constraint studies_questions_length_ck
  check (jsonb_array_length(survey_spec -> 'questions') between 2 and 6);

-- Replace valid_survey_spec_structure function to accept 2 to 6 questions
create or replace function public.valid_survey_spec_structure(p_spec jsonb)
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
      select count(*) between 2 and 6
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
