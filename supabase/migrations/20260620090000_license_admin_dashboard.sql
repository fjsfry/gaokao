alter table public.report_licenses
  add column if not exists code_sealed text;

comment on column public.report_licenses.code_sealed is
  'Encrypted full license code for internal admin recovery. Only service_role may read it.';
