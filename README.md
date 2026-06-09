# 听你说升学

河北普通类高考志愿表风险体检网站。产品面向已经整理出志愿表的家长和学生，提供分数位次、批次线、历史投档记录和逐条风险建议。

## 本地运行

```bash
pip install -r requirements.txt
cp .env.example .env
python server.py
```

打开 `http://127.0.0.1:4174/`。

## 环境变量

- `SUPABASE_URL`: Supabase 项目地址
- `SUPABASE_ANON_KEY`: 前端/服务端只读查询使用的公开 anon key
- `DEEPSEEK_API_KEY`: 生成完整报告时使用，只保存在服务端环境变量中
- `DEEPSEEK_MODEL`: 默认 `deepseek-v4-pro`

不要把 `.env`、service role key、DeepSeek key 提交到仓库。

## 定时爬取

仓库包含 `.github/workflows/crawl-hebei-gaokao.yml`。工作流会按计划抓取河北省教育考试院公开高考通知和附件，构建 SQLite，并将新增/更新数据同步到 Supabase。

需要在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 添加：

- `SUPABASE_SERVICE_ROLE_KEY`

默认计划为每天 UTC `00:00`、`10:00`、`20:00` 运行；也可以在 GitHub Actions 手动触发并指定年份。
