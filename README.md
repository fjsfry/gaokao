# 寻鹿升学高考志愿填报风险评估系统

面向河北新高考家庭和志愿填报咨询师的风险评估系统。网站按导航拆分为首页、产品介绍、在线评估、报告样例和服务方案，不再是单页长滚动展示。

## 功能

- 96 个志愿逐条风险预览：冲稳保、梯度、选科限制、预算和专业偏好。
- 河北公开数据匹配：批次线、一分一档、历年投档记录和来源链接。
- Excel / CSV / TXT 志愿表导入：浏览器端解析，不上传 API 密钥。
- 授权码制完整报告：无需登录，客户付款后输入单次、三次或填报季授权码。
- DeepSeek 服务端报告生成：前端只调用本地 `/api/ai-report`，DeepSeek key 与授权码校验密钥只保存在服务器环境变量。
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
- `SUPABASE_SERVICE_ROLE_KEY`: 仅服务端使用，用于授权码校验、扣次和发码脚本，不要暴露给前端。
- `LICENSE_HASH_SECRET`: 授权码 HMAC 哈希密钥；生成授权码和服务端校验必须使用同一个值。
- `LICENSE_ADMIN_TOKEN`: 内部发码后台口令；只给运营人员使用，不要发给客户，不要提交到 GitHub。
- `HOST` / `PORT`: 本地服务监听地址。

不要提交 `.env`、DeepSeek key、Supabase service role key 或任何私密客户数据。仓库已通过 `.gitignore` 忽略 `.env` 和日志文件。

## 授权码 / 报告码

完整报告不采用账号登录。用户可以免费生成风险预览；购买后由顾问发送授权码，生成 DeepSeek 完整解读报告时才扣次数。

授权码类型：

- `single`: 单次报告码，完整报告生成 1 次。
- `triple`: 三次复查码，完整报告生成 3 次。
- `season`: 填报季卡，不限制总次数，默认每天最多 20 次完整报告。

数据库结构在：

```text
supabase/migrations/20260616090000_report_license_codes.sql
```

在 Supabase SQL Editor 执行该迁移后，使用脚本生成授权码：

```bash
python scripts/generate_license_code.py --plan single --note "客户备注"
python scripts/generate_license_code.py --plan triple --note "客户备注" --insert
python scripts/generate_license_code.py --plan season --expires-at 2026-07-31T23:59:59+08:00 --insert
```

不带 `--insert` 时脚本只输出明文授权码和可手动执行的 SQL；带 `--insert` 时会用 `SUPABASE_SERVICE_ROLE_KEY` 直接写入 Supabase。数据库只保存授权码 HMAC 哈希，明文授权码只会在生成时显示一次。

## 手机发码后台

内部发码后台地址：

```text
https://www.xunlushengxue.com.cn/license-admin
```

该入口不出现在网站导航中，适合在手机浏览器里使用。输入 `LICENSE_ADMIN_TOKEN` 后选择套餐、生成数量、客户备注和有效期，即可生成单次报告码、三次复查码或填报季卡。

注意事项：

- 明文授权码只在生成成功后返回一次，请立即复制给客户或保存到你的私密记录。
- 后台接口 `/api/admin/license/create` 只接受管理员口令，写库操作全部在服务端完成。
- 前端不会拿到 Supabase service role key、授权码哈希密钥或 DeepSeek API key。
- 如果更换 `LICENSE_ADMIN_TOKEN`，需要同步更新 Vercel Production 环境变量并重新部署。

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
- `max_list_failures`: 列表页累计失败熔断次数，默认 `12`。
- `max_consecutive_list_failures`: 列表页连续失败熔断次数，默认 `6`。
- `replace_existing`: 是否清空 Supabase 表后全量导入，仅用于确认过的全量重建。

定时任务采用轻量抓取和源站不可用熔断，减少河北考试院站点对 GitHub runner 断连导致的失败。需要重建历史全量库时，可手动触发并调高 `max_pages`、`max_list_visits` 和失败熔断阈值。

同步前会运行：

```bash
python -m py_compile crawler/hebei_gaokao_crawler.py crawler/build_hebei_database.py crawler/validate_hebei_database.py scripts/sync_sqlite_to_supabase.py
python crawler/validate_hebei_database.py --sqlite data_public/hebei_gaokao.sqlite
```

验证失败会停止同步，避免空库或半成品数据覆盖线上。

## 本地全量数据重建

```bash
pip install -r crawler/requirements.txt
python crawler/hebei_gaokao_crawler.py crawl --out data_public --years 2021 2022 2023 2024 2025 2026 --delay 1.0 --max-pages 80 --max-list-visits 1000 --max-list-failures 80 --max-consecutive-list-failures 20
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
