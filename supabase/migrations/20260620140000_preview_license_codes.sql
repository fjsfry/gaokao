alter table public.report_licenses
  drop constraint if exists report_licenses_plan_check;

alter table public.report_licenses
  add constraint report_licenses_plan_check
  check (plan in ('preview', 'single', 'triple', 'season'));

alter table public.report_licenses
  drop constraint if exists report_licenses_finite_usage;

alter table public.report_licenses
  add constraint report_licenses_finite_usage
  check (
    plan in ('preview', 'season')
    or (total_uses is not null and remaining_uses is not null and remaining_uses <= total_uses)
  );

alter table public.report_license_events
  drop constraint if exists report_license_events_event_type_check;

alter table public.report_license_events
  add constraint report_license_events_event_type_check
  check (event_type in ('verify', 'preview', 'consume', 'refund', 'disable'));

comment on column public.report_licenses.plan is
  'preview=体验预览码，仅展示往年位次；single=1次，triple=3次，season=填报季卡。';
