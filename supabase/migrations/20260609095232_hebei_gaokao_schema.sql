create extension if not exists pg_trgm with schema extensions;

create table if not exists public.articles (
  url text primary key,
  title text,
  publish_date text,
  channel text,
  text text,
  crawled_at text
);

create table if not exists public.files (
  file_url text primary key,
  article_title text,
  article_url text,
  local_path text,
  filename text,
  extension text,
  sha256 text,
  size_bytes bigint,
  crawled_at text
);

create table if not exists public.source_files (
  file_sha256 text primary key,
  file_url text,
  filename text,
  extension text,
  local_path text,
  link_text text,
  article_title text,
  article_url text,
  year integer,
  data_category text,
  size_bytes bigint,
  crawled_at text
);

create table if not exists public.attachment_links (
  file_url text primary key,
  article_url text,
  article_title text,
  link_text text,
  local_path text,
  filename text,
  extension text,
  year integer,
  imported_at text
);

create table if not exists public.raw_tables (
  table_id text primary key,
  source_file text,
  source_sheet text,
  source_sha256 text,
  year integer,
  inferred_category text,
  rows integer,
  cols integer,
  csv_path text,
  columns_json text,
  imported_at text
);

create table if not exists public.admission_line (
  id text primary key,
  year integer,
  province text,
  batch text,
  subject_group text,
  school_code text,
  school_name text,
  major_code text,
  major_name text,
  min_score integer,
  min_rank integer,
  tie_breaker_json text,
  remark text,
  source_file text,
  source_url text,
  source_sheet text,
  confidence_level text,
  imported_at text
);

create table if not exists public.score_rank_table (
  id text primary key,
  year integer,
  province text,
  subject_group text,
  score integer,
  same_score_count integer,
  cumulative_rank integer,
  source_url text,
  source_file text,
  imported_at text
);

create table if not exists public.batch_line (
  id text primary key,
  year integer,
  province text,
  subject_group text,
  batch text,
  control_score integer,
  source_url text,
  source_file text,
  imported_at text
);

create table if not exists public.ocr_text_blocks (
  id text primary key,
  source_file text,
  file_url text,
  article_title text,
  article_url text,
  year integer,
  page_no integer,
  block_no integer,
  x1 double precision,
  y1 double precision,
  x2 double precision,
  y2 double precision,
  text text,
  confidence double precision,
  ocr_engine text,
  imported_at text
);

create table if not exists public.build_summary (
  key text primary key,
  value text
);

create index if not exists idx_articles_publish_date on public.articles (publish_date);
create index if not exists idx_files_extension on public.files (extension);
create index if not exists idx_source_files_year_category on public.source_files (year, data_category);
create index if not exists idx_attachment_links_year on public.attachment_links (year);
create index if not exists idx_raw_tables_year_category on public.raw_tables (year, inferred_category);
create index if not exists idx_admission_lookup on public.admission_line (year, batch, subject_group, school_name, major_name);
create index if not exists idx_admission_score on public.admission_line (year, subject_group, min_score);
create index if not exists idx_admission_rank on public.admission_line (year, subject_group, min_rank);
create index if not exists idx_admission_school_trgm on public.admission_line using gin (school_name extensions.gin_trgm_ops);
create index if not exists idx_admission_major_trgm on public.admission_line using gin (major_name extensions.gin_trgm_ops);
create index if not exists idx_score_rank_lookup on public.score_rank_table (year, subject_group, score);
create index if not exists idx_batch_line_lookup on public.batch_line (year, subject_group, batch);
create index if not exists idx_ocr_source on public.ocr_text_blocks (year, source_file, page_no);

create or replace view public.school_admission_summary
with (security_invoker = true)
as
select
  year,
  province,
  batch,
  subject_group,
  school_code,
  school_name,
  count(*)::integer as major_count,
  min(min_score) as lowest_score,
  min(min_rank) as best_rank,
  max(min_rank) as lowest_rank,
  max(imported_at) as imported_at
from public.admission_line
group by year, province, batch, subject_group, school_code, school_name;

create or replace view public.available_data_years
with (security_invoker = true)
as
select
  year,
  (count(*) filter (where table_name = 'admission_line'))::integer as admission_line_count,
  (count(*) filter (where table_name = 'score_rank_table'))::integer as score_rank_count,
  (count(*) filter (where table_name = 'batch_line'))::integer as batch_line_count
from (
  select year, 'admission_line' as table_name from public.admission_line
  union all
  select year, 'score_rank_table' as table_name from public.score_rank_table
  union all
  select year, 'batch_line' as table_name from public.batch_line
) t
where year is not null
group by year;

alter table public.articles enable row level security;
alter table public.files enable row level security;
alter table public.source_files enable row level security;
alter table public.attachment_links enable row level security;
alter table public.raw_tables enable row level security;
alter table public.admission_line enable row level security;
alter table public.score_rank_table enable row level security;
alter table public.batch_line enable row level security;
alter table public.ocr_text_blocks enable row level security;
alter table public.build_summary enable row level security;

create policy "Public read articles" on public.articles for select to anon, authenticated using (true);
create policy "Public read files" on public.files for select to anon, authenticated using (true);
create policy "Public read source_files" on public.source_files for select to anon, authenticated using (true);
create policy "Public read attachment_links" on public.attachment_links for select to anon, authenticated using (true);
create policy "Public read raw_tables" on public.raw_tables for select to anon, authenticated using (true);
create policy "Public read admission_line" on public.admission_line for select to anon, authenticated using (true);
create policy "Public read score_rank_table" on public.score_rank_table for select to anon, authenticated using (true);
create policy "Public read batch_line" on public.batch_line for select to anon, authenticated using (true);
create policy "Public read ocr_text_blocks" on public.ocr_text_blocks for select to anon, authenticated using (true);
create policy "Public read build_summary" on public.build_summary for select to anon, authenticated using (true);

revoke insert, update, delete, truncate, references, trigger on
  public.articles,
  public.files,
  public.source_files,
  public.attachment_links,
  public.raw_tables,
  public.admission_line,
  public.score_rank_table,
  public.batch_line,
  public.ocr_text_blocks,
  public.build_summary
from anon, authenticated;

grant select on
  public.articles,
  public.files,
  public.source_files,
  public.attachment_links,
  public.raw_tables,
  public.admission_line,
  public.score_rank_table,
  public.batch_line,
  public.ocr_text_blocks,
  public.build_summary,
  public.school_admission_summary,
  public.available_data_years
to anon, authenticated;

comment on table public.admission_line is '河北高考普通类及相关批次投档线明细，来自河北省教育考试院公开附件。';
comment on table public.score_rank_table is '河北高考一分一档表，支持分数到位次换算。';
comment on table public.batch_line is '河北高考批次控制线。';
comment on table public.source_files is '公开附件文件元数据与来源追溯。';
