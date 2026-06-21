create table if not exists public.site_visits (
  id bigserial primary key,
  visitor_key text not null,
  session_key text,
  page_path text not null default '/',
  referrer text,
  request_fingerprint text,
  client_ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_site_visits_created_at on public.site_visits (created_at desc);
create index if not exists idx_site_visits_visitor_time on public.site_visits (visitor_key, created_at desc);
create index if not exists idx_site_visits_page_time on public.site_visits (page_path, created_at desc);

alter table public.site_visits enable row level security;

revoke all on public.site_visits from anon, authenticated;
revoke all on sequence public.site_visits_id_seq from anon, authenticated;

grant select, insert, update, delete on public.site_visits to service_role;
grant usage, select on sequence public.site_visits_id_seq to service_role;

comment on table public.site_visits is '匿名网页访客和页面打开记录，用于后台运营统计。只允许服务端写入和读取。';
comment on column public.site_visits.visitor_key is '浏览器匿名访客 ID 的哈希值，用于估算访客人数。';
comment on column public.site_visits.session_key is '浏览器会话 ID 的哈希值，用于估算单次访问会话。';
comment on column public.site_visits.request_fingerprint is '服务端基于 IP 与 User-Agent 生成的请求指纹，用于辅助去重和排查异常访问。';
