create extension if not exists pg_trgm with schema extensions;

create table if not exists public.enrollment_plan (
  id text primary key,
  year integer,
  province text,
  batch text,
  subject_group text,
  plan_category text,
  school_code text,
  school_name text,
  major_code text,
  major_name text,
  major_full_name text,
  major_remark text,
  level text,
  selection_requirement text,
  plan_count integer,
  duration text,
  tuition integer,
  discipline_category text,
  major_category text,
  is_new_major boolean default false,
  source_file text,
  source_url text,
  source_sheet text,
  confidence_level text,
  imported_at text
);

create table if not exists public.major_admission_stats (
  id text primary key,
  year integer,
  province text,
  batch text,
  subject_group text,
  school_code text,
  school_name text,
  major_code text,
  major_name text,
  major_full_name text,
  admission_count integer,
  min_score integer,
  min_rank integer,
  avg_score integer,
  avg_rank integer,
  max_score integer,
  max_rank integer,
  source_file text,
  source_url text,
  source_sheet text,
  confidence_level text,
  imported_at text
);

create index if not exists idx_enrollment_plan_lookup
  on public.enrollment_plan (year, batch, subject_group, school_name, major_name);
create index if not exists idx_enrollment_plan_school_trgm
  on public.enrollment_plan using gin (school_name extensions.gin_trgm_ops);
create index if not exists idx_enrollment_plan_major_trgm
  on public.enrollment_plan using gin (major_name extensions.gin_trgm_ops);
create index if not exists idx_major_admission_stats_lookup
  on public.major_admission_stats (year, batch, subject_group, school_name, major_name);
create index if not exists idx_major_admission_stats_rank
  on public.major_admission_stats (year, subject_group, min_rank, avg_rank);
create index if not exists idx_major_admission_stats_school_trgm
  on public.major_admission_stats using gin (school_name extensions.gin_trgm_ops);
create index if not exists idx_major_admission_stats_major_trgm
  on public.major_admission_stats using gin (major_name extensions.gin_trgm_ops);

alter table public.enrollment_plan enable row level security;
alter table public.major_admission_stats enable row level security;

drop policy if exists "Public read enrollment_plan" on public.enrollment_plan;
create policy "Public read enrollment_plan"
  on public.enrollment_plan for select to anon, authenticated using (true);

drop policy if exists "Public read major_admission_stats" on public.major_admission_stats;
create policy "Public read major_admission_stats"
  on public.major_admission_stats for select to anon, authenticated using (true);

revoke insert, update, delete, truncate, references, trigger on
  public.enrollment_plan,
  public.major_admission_stats
from anon, authenticated;

grant select on
  public.enrollment_plan,
  public.major_admission_stats
to anon, authenticated;

grant select, insert, update, delete on
  public.enrollment_plan,
  public.major_admission_stats
to service_role;

create or replace view public.available_data_years
with (security_invoker = true)
as
select
  year,
  (count(*) filter (where table_name = 'admission_line'))::integer as admission_line_count,
  (count(*) filter (where table_name = 'score_rank_table'))::integer as score_rank_count,
  (count(*) filter (where table_name = 'batch_line'))::integer as batch_line_count,
  (count(*) filter (where table_name = 'enrollment_plan'))::integer as enrollment_plan_count,
  (count(*) filter (where table_name = 'major_admission_stats'))::integer as major_admission_stats_count
from (
  select year, 'admission_line' as table_name from public.admission_line
  union all
  select year, 'score_rank_table' as table_name from public.score_rank_table
  union all
  select year, 'batch_line' as table_name from public.batch_line
  union all
  select year, 'enrollment_plan' as table_name from public.enrollment_plan
  union all
  select year, 'major_admission_stats' as table_name from public.major_admission_stats
) t
where year is not null
group by year;

grant select on public.available_data_years to anon, authenticated;

comment on table public.enrollment_plan is '河北高考招生计划增强表，包含计划人数、选科要求、学费、学制、新增专业等可报性判断字段。';
comment on table public.major_admission_stats is '院校专业录取统计增强表，包含最低/平均/最高分位次和录取人数，用于专业热度与稳定性判断。';
