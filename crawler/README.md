# 河北高考公开数据采集器

## 目标

用于采集河北省教育考试院公开发布的普通高考相关网页和附件，形成后续志愿填报风险诊断数据库的原始数据底座。

## 合规边界

- 只抓公开网页与公开附件；
- 不登录河北省高考志愿填报智能参考系统；
- 不绕验证码、不模拟考生账号、不抓竞品闭源数据库；
- 默认设置请求间隔，减少对官网压力。

## 安装

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## 抓取

```bash
python hebei_gaokao_crawler.py crawl --out data --years 2022 2023 2024 2025 2026
```

输出：

```text
data/
  hebei_gaokao.sqlite
  metadata/
    articles.csv
    files.csv
  raw/
    html/
    files/
```

## 解析 Excel 附件

```bash
python hebei_gaokao_crawler.py parse-excel --out data
```

输出：

```text
data/
  metadata/table_inventory.csv
  processed/tables/
```

## 构建标准化 SQLite 数据库

先抓取和解析公开附件，再把可追溯到官方附件的 Excel 表转换成网站可直接查询的业务表：

```bash
python hebei_gaokao_crawler.py crawl --out data_public --years 2023 2024 2025 2026 --delay 0.25 --max-pages 10 --max-list-visits 120
python hebei_gaokao_crawler.py parse-excel --out data_public
python build_hebei_database.py --out data_public
python validate_hebei_database.py --sqlite data_public/hebei_gaokao.sqlite --min-admission-lines 100 --min-score-ranks 100 --min-batch-lines 4
```

标准化表会写回：

```text
data_public/hebei_gaokao.sqlite
```

核心表：

- `source_files`：官方附件索引，包含来源公告、URL、文件 SHA256、大小。
- `raw_tables`：已成功解析的官方 Excel 表清单。
- `admission_line`：投档线业务表，字段包括年份、批次、科目组合、院校、专业、最低分、来源 URL。
- `score_rank_table`：一分一段表预留表；当前普通高考页面主要是 PDF/图片附件，需要后续 OCR/PDF 解析。
- `batch_line`：批次控制线预留表；当前普通高考控制线主要是图片附件，需要后续 OCR 解析。

当前构建逻辑会丢弃无法追溯到官方附件的历史残留 CSV。普通本科批、专科批公告中，如果历史/物理两个附件没有显式命名，会按同一公告下表格行数和文件大小推断科目组合，并在 `confidence_level` 中标记为 `official_public_parsed_subject_inferred`。

## 全量商用数据库构建

当前项目的全量构建目录使用 `data_full`，覆盖 2021-2026 年河北省教育考试院公开页面。2026 年截至 2026-06-08 还没有普通高考投档线，当前可用于志愿推荐的完整业务数据主要覆盖 2021-2025 年。

```bash
python hebei_gaokao_crawler.py crawl --out data_full --years 2021 2022 2023 2024 2025 2026 --delay 0.2 --max-pages 80 --max-list-visits 1000
python hebei_gaokao_crawler.py crawl --out data_full --years 2021 2022 2023 2024 2025 2026 --keywords 录取控制分数线 控制分数线 --delay 0.2 --max-pages 8 --max-list-visits 100
python hebei_gaokao_crawler.py parse-excel --out data_full
python build_hebei_database.py --out data_full
```

全量库路径：

```text
data_full/hebei_gaokao.sqlite
```

抓取任务还会写入：

```text
data_full/metadata/crawl_manifest.json
```

该文件记录本次请求年份、发现年份、文章数、附件数、种子 URL 和抓取参数，便于排查 GitHub Actions 是否抓错年份或抓到空结果。

全量库新增表：

- `attachment_links`：从本地 HTML 恢复出的附件标题，用于判断附件所属批次、科目组合、艺术/体育/对口类别。
- `ocr_text_blocks`：OCR 原始识别块，保留页码、坐标、置信度和来源文件，便于后续人工校对或继续结构化。
- `score_rank_table`：已用 OCR 结构化 2021-2025 年普通物理/历史一分一段表。
- `batch_line`：已用 OCR 结构化 2021-2025 年普通物理/历史本科批、专科批、特殊类型招生控制线。

## 下一步建议

1. 人工抽检 `metadata/files.csv` 中核心附件是否下载完整；
2. 对 `processed/tables` 中表头做标准化映射；
3. 建立字段字典：年份、省份、批次、科目组合、院校代码、院校名称、专业组代码、专业名称、计划数、最低分、最低位次等；
4. 用阳光高考招生章程和高校本科招生网补全专业限制、体检限制、单科要求、外语语种要求；
5. 商用前务必确认数据来源授权和展示方式。

## GitHub Actions 注意事项

仓库工作流默认抓取 2021-2026 年，构建完成后会先运行 `validate_hebei_database.py`。核心表数量不达标时会停止同步，避免空库或半成品同步到 Supabase。

如果仓库没有配置 `SUPABASE_SERVICE_ROLE_KEY`，工作流不会在密钥检查阶段失败；它会继续生成 SQLite 和 artifact，仅跳过 Supabase 同步。线上网站要读取最新数据时，仍需在 GitHub Actions secrets 中补齐该 key。

定时任务默认 `max_pages=20`、`max_list_visits=250`，并使用较短网络超时和较少重试，避免河北考试院站点临时断连时把整轮任务拖到超时。全量补库时可手动触发并调高这两个参数。

如果需要全量重建 Supabase，可手动触发工作流并打开 `replace_existing`。不要在未确认本次 SQLite 校验通过前使用全量替换。
