# 知录升学高考志愿填报风险评估系统

面向河北新高考家庭和志愿填报咨询师的风险评估系统。网站按导航拆分为首页、风险评估、产品流程、数据中心、风险模型、报告样例和服务方案，不再是单页长滚动展示。

## 功能

- 96 个志愿逐条风险预览：冲稳保、梯度、选科限制、预算和专业偏好。
- 河北公开数据匹配：批次线、一分一档、历年投档记录和来源链接。
- Excel / CSV / TXT 志愿表导入：浏览器端解析，不上传 API 密钥。
- DeepSeek 服务端报告生成：前端只调用本地 `/api/ai-report`，密钥只保存在服务器环境变量。
- GitHub Actions 定时爬取：默认覆盖 2021-2026 年公开数据，同步前校验 SQLite 核心表。

## 本地运行

```bash
pip install -r requirements.txt
copy .env.example .env
python server.py
```

打开 `http://127.0.0.1:4174/`。

## 环境变量

- `DEEPSEEK_API_KEY`: DeepSeek API key，只放在 `.env` 或服务器环境变量。
- `DEEPSEEK_BASE_URL`: 默认 `https://api.deepseek.com`。
- `DEEPSEEK_MODEL`: 默认 `deepseek-v4-pro`。
- `DEEPSEEK_THINKING`: 默认 `enabled`。
- `DEEPSEEK_REASONING_EFFORT`: 默认 `high`。
- `SUPABASE_URL`: Supabase 项目地址。
- `SUPABASE_ANON_KEY`: 前端公共查询使用的 anon key。
- `HOST` / `PORT`: 本地服务监听地址。

不要提交 `.env`、DeepSeek key、Supabase service role key 或任何私密客户数据。仓库已通过 `.gitignore` 忽略 `.env` 和日志文件。

## GitHub Actions 爬虫

工作流：`.github/workflows/crawl-hebei-gaokao.yml`

需要在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 配置：

- `SUPABASE_SERVICE_ROLE_KEY`

如果暂时没有配置该 secret，GitHub Actions 仍会执行爬虫、解析、SQLite 构建、校验和 artifact 上传；只有 Supabase 同步会被跳过。要让网站读取到最新线上数据，仍需补齐该 secret。

默认定时任务每 8 小时运行一次，覆盖年份为：

```text
2021 2022 2023 2024 2025 2026
```

手动运行时可调整：

- `years`: 抓取年份。
- `max_pages`: 每个频道翻页上限，定时任务默认 `20`。
- `max_list_visits`: 列表页访问上限，定时任务默认 `250`。
- `replace_existing`: 是否清空 Supabase 表后全量导入，仅用于确认过的全量重建。

定时任务采用轻量抓取，减少河北考试院站点对 GitHub runner 断连导致的失败。需要重建历史全量库时，可手动触发并调高 `max_pages` 与 `max_list_visits`。

同步前会运行：

```bash
python -m py_compile crawler/hebei_gaokao_crawler.py crawler/build_hebei_database.py crawler/validate_hebei_database.py scripts/sync_sqlite_to_supabase.py
python crawler/validate_hebei_database.py --sqlite data_public/hebei_gaokao.sqlite
```

验证失败会停止同步，避免空库或半成品数据覆盖线上。

## 本地全量数据重建

```bash
pip install -r crawler/requirements.txt
python crawler/hebei_gaokao_crawler.py crawl --out data_public --years 2021 2022 2023 2024 2025 2026 --delay 1.0 --max-pages 80 --max-list-visits 1000
python crawler/hebei_gaokao_crawler.py parse-excel --out data_public
python crawler/build_hebei_database.py --out data_public
python crawler/validate_hebei_database.py --sqlite data_public/hebei_gaokao.sqlite --min-admission-lines 100 --min-score-ranks 100 --min-batch-lines 4
```

生成文件：

- `data_public/hebei_gaokao.sqlite`
- `data_public/metadata/articles.csv`
- `data_public/metadata/files.csv`
- `data_public/metadata/table_inventory.csv`
- `data_public/metadata/crawl_manifest.json`

## 重要边界

系统结论用于志愿提交前风险复核，不保证录取结果。商用前应继续确认公开数据展示方式、隐私条款、退款规则和咨询师人工复核流程。
