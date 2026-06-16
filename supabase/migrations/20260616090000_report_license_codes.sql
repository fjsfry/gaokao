create extension if not exists pgcrypto with schema extensions;

create table if not exists public.report_licenses (
  id uuid primary key default extensions.gen_random_uuid(),
  code_hash text not null unique,
  code_prefix text not null,
  plan text not null check (plan in ('single', 'triple', 'season')),
  total_uses integer check (total_uses is null or total_uses >= 0),
  remaining_uses integer check (remaining_uses is null or remaining_uses >= 0),
  max_uses_per_day integer not null default 20 check (max_uses_per_day >= 0),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'disabled', 'refunded')),
  customer_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  constraint report_licenses_finite_usage check (
    plan = 'season'
    or (total_uses is not null and remaining_uses is not null and remaining_uses <= total_uses)
  )
);

create table if not exists public.report_license_events (
  id bigserial primary key,
  license_id uuid not null references public.report_licenses(id) on delete cascade,
  event_type text not null check (event_type in ('verify', 'consume', 'refund', 'disable')),
  uses_delta integer not null default 0,
  request_fingerprint text,
  client_ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_report_licenses_hash on public.report_licenses (code_hash);
create index if not exists idx_report_licenses_status_plan on public.report_licenses (status, plan);
create index if not exists idx_report_license_events_license_time on public.report_license_events (license_id, created_at desc);
create index if not exists idx_report_license_events_type_time on public.report_license_events (event_type, created_at desc);

alter table public.report_licenses enable row level security;
alter table public.report_license_events enable row level security;

revoke all on public.report_licenses from anon, authenticated;
revoke all on public.report_license_events from anon, authenticated;
revoke all on sequence public.report_license_events_id_seq from anon, authenticated;

grant select, insert, update, delete on public.report_licenses to service_role;
grant select, insert, update, delete on public.report_license_events to service_role;
grant usage, select on sequence public.report_license_events_id_seq to service_role;

comment on table public.report_licenses is '付费完整报告授权码。只保存授权码 HMAC 哈希，前端不可直接访问。';
comment on table public.report_license_events is '授权码验证、扣次和补偿记录，用于售后和滥用排查。';
comment on column public.report_licenses.plan is 'single=1次，triple=3次，season=填报季卡。';
comment on column public.report_licenses.max_uses_per_day is 'season 码的每日完整报告生成上限；0 表示不限制。';
