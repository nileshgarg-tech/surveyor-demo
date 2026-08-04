-- Update rate_limit_policies table in Supabase database to allow expanded thresholds
update public.rate_limit_policies
set max_requests = 30, window_seconds = 60, retention_seconds = 3600
where route_class in ('event', 'intake', 'design', 'submission');

update public.rate_limit_policies
set max_requests = 15, window_seconds = 60, retention_seconds = 3600
where route_class in ('launch', 'finish', 'report', 'recovery');

update public.rate_limit_policies
set max_requests = 120, window_seconds = 60, retention_seconds = 3600
where route_class = 'status';
