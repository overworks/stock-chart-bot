create table public.chart_test_deliveries (
  id bigint generated always as identity primary key,
  kind text not null,
  payload jsonb not null,
  png_base64 text,
  mime text,
  filename text,
  deno_version text not null
);
alter table public.chart_test_deliveries enable row level security;
revoke all on public.chart_test_deliveries from public, anon, authenticated;
grant select, insert, delete on public.chart_test_deliveries to service_role;
grant usage, select on sequence public.chart_test_deliveries_id_seq to service_role;
