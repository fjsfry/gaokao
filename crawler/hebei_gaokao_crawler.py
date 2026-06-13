#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
河北高考公开数据采集器（合规版）

用途：
1) 从河北省教育考试院公开页面抓取普通高考相关文章；
2) 下载公开附件（xlsx/xls/pdf/doc/jpg/png/zip 等）；
3) 将 Excel 附件转为 CSV，并生成数据清单；
4) 便于后续建设“志愿风险诊断”数据库。

重要边界：
- 只抓取公开网页和公开附件；
- 不登录、不绕验证码、不模拟考生账号、不抓取竞品闭源数据库；
- 默认限速，减少对官网压力。

运行示例：
python hebei_gaokao_crawler.py crawl --out data --years 2021 2022 2023 2024 2025 2026
python hebei_gaokao_crawler.py parse-excel --out data
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional
from urllib.parse import urljoin, urlparse, urlunparse, unquote

import pandas as pd
import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from tqdm import tqdm


USER_AGENT = (
    "Mozilla/5.0 (compatible; HebeiGaokaoResearchBot/1.0; "
    "+for personal research and data verification; respectful crawling)"
)

ALLOWED_DOMAINS = {
    "www.hebeea.edu.cn",
    "file.hebeea.edu.cn",
}

# 重点抓取关键词：可按需要增删
DEFAULT_KEYWORDS = [
    "高考", "普通高校招生", "本科批", "专科批", "提前批",
    "投档情况", "投档情况统计", "平行志愿", "征集志愿", "征集志愿计划",
    "成绩统计表", "一分一段", "分段表", "录取控制分数线", "控制分数线",
    "招生计划", "志愿填报", "选考科目", "物理科目组合", "历史科目组合",
    "对口", "艺术", "体育", "单招",
]

ATTACHMENT_EXTENSIONS = {
    ".xlsx", ".xls", ".csv", ".pdf", ".doc", ".docx",
    ".jpg", ".jpeg", ".png", ".zip", ".rar",
}

SEED_URLS = [
    # 往年数据：投档线、一分一段、批次线、征集计划等核心数据多在这里
    "https://www.hebeea.edu.cn/ptgk/wnsj/",
    # 普通高考频道
    "https://www.hebeea.edu.cn/ptgk/",
    "https://www.hebeea.edu.cn/ptgk/index.html",
    # 通知公告、政策导航、信息公示：当年政策、专项计划、公示名单等
    "https://www.hebeea.edu.cn/ptgk/tzgg/",
    "https://www.hebeea.edu.cn/ptgk/zcda/",
    "https://www.hebeea.edu.cn/ptgk/xxgs/",
]


def default_years() -> list[int]:
    current_year = datetime.now().year
    return list(range(2021, max(current_year, 2026) + 1))


@dataclass
class ArticleRecord:
    title: str
    url: str
    publish_date: str = ""
    channel: str = ""
    text: str = ""
    crawled_at: str = ""


@dataclass
class FileRecord:
    article_title: str
    article_url: str
    file_url: str
    local_path: str
    filename: str
    extension: str
    sha256: str
    size_bytes: int
    crawled_at: str


def setup_logger(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    log_file = out_dir / "crawler.log"
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(log_file, encoding="utf-8"),
        ],
    )


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    retry = Retry(
        total=3,
        connect=3,
        read=3,
        backoff_factor=1.2,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["HEAD", "GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def is_allowed_url(url: str) -> bool:
    try:
        host = urlparse(url).netloc.lower()
        return host in ALLOWED_DOMAINS
    except Exception:
        return False


def normalize_url(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path or "/"
    return urlunparse((parsed.scheme, parsed.netloc.lower(), path, "", parsed.query, ""))


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def safe_filename(name: str, max_len: int = 160) -> str:
    name = unquote(name).strip().replace("\x00", "")
    name = re.sub(r"[\\/:*?\"<>|]+", "_", name)
    name = re.sub(r"\s+", "_", name)
    return name[:max_len] or "unnamed"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(session: requests.Session, url: str, timeout: int = 25) -> Optional[requests.Response]:
    if not is_allowed_url(url):
        logging.warning("跳过非允许域名：%s", url)
        return None
    try:
        resp = session.get(url, timeout=timeout)
        resp.raise_for_status()
        if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
            resp.encoding = resp.apparent_encoding or "utf-8"
        return resp
    except requests.RequestException as exc:
        logging.warning("请求失败：%s | %s", url, exc)
        return None


def extract_links(base_url: str, html: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    links: list[tuple[str, str]] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a.get("href", "").strip()
        text = clean_text(a.get_text(" "))
        if not href or href.startswith("javascript:") or href.startswith("#"):
            continue
        full = normalize_url(urljoin(base_url, href))
        if is_allowed_url(full):
            if full in seen:
                continue
            seen.add(full)
            links.append((text, full))
    return links


def is_article_url(url: str) -> bool:
    # 河北考试院文章一般为 /c/2025-07-23/489213.html
    return bool(re.search(r"/c/\d{4}-\d{2}-\d{2}/\d+\.html$", url))


def is_list_url(url: str) -> bool:
    path = urlparse(url).path
    return (
        "/ptgk/" in path
        and (path.endswith("/") or path.endswith(".html"))
        and not is_article_url(url)
    )


def year_from_text_or_url(text: str, url: str) -> Optional[int]:
    m = re.search(r"(20\d{2})", f"{text} {url}")
    return int(m.group(1)) if m else None


def keep_by_year_and_keyword(title: str, url: str, years: set[int], keywords: list[str]) -> bool:
    y = year_from_text_or_url(title, url)
    if years and y and y not in years:
        return False
    hay = f"{title} {url}"
    return any(k in hay for k in keywords)


def parse_article(html: str, url: str) -> ArticleRecord:
    soup = BeautifulSoup(html, "lxml")
    title = clean_text(soup.find("h1").get_text(" ")) if soup.find("h1") else ""
    if not title and soup.title:
        title = clean_text(soup.title.get_text(" "))

    text = clean_text(soup.get_text(" "))
    publish_date = ""
    m = re.search(r"发布时间：\[?(\d{4}-\d{2}-\d{2})\]?", text)
    if m:
        publish_date = m.group(1)
    else:
        m = re.search(r"(20\d{2}-\d{2}-\d{2})", text)
        if m:
            publish_date = m.group(1)

    channel = "普通高考"
    return ArticleRecord(
        title=title,
        url=url,
        publish_date=publish_date,
        channel=channel,
        text=text,
        crawled_at=datetime.now().isoformat(timespec="seconds"),
    )


def extract_attachment_links(article_url: str, html: str) -> list[tuple[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    links = extract_links(article_url, html)
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for text, url in links:
        path = urlparse(url).path
        ext = Path(path).suffix.lower()
        if ext in ATTACHMENT_EXTENSIONS or urlparse(url).netloc == "file.hebeea.edu.cn":
            if url in seen:
                continue
            seen.add(url)
            out.append((text, url))
    for img in soup.find_all("img", src=True):
        src = img.get("src", "").strip()
        if not src:
            continue
        url = normalize_url(urljoin(article_url, src))
        if not is_allowed_url(url):
            continue
        ext = Path(urlparse(url).path).suffix.lower()
        if ext in ATTACHMENT_EXTENSIONS:
            if url in seen:
                continue
            seen.add(url)
            alt = clean_text(img.get("alt") or img.get("title") or Path(urlparse(url).path).name)
            out.append((alt, url))
    return out


def get_filename_from_response(url: str, resp: requests.Response, fallback_text: str = "") -> str:
    # Content-Disposition 优先
    cd = resp.headers.get("Content-Disposition", "")
    m = re.search(r"filename\*=UTF-8''([^;]+)", cd, flags=re.I)
    if m:
        return safe_filename(unquote(m.group(1)))
    m = re.search(r'filename="?([^";]+)"?', cd, flags=re.I)
    if m:
        return safe_filename(unquote(m.group(1)))

    path_name = Path(urlparse(url).path).name
    if path_name:
        return safe_filename(path_name)
    return safe_filename(fallback_text) or "attachment"


def download_file(
    session: requests.Session,
    file_url: str,
    target_dir: Path,
    article_title: str,
    article_url: str,
    link_text: str,
    delay: float,
) -> Optional[FileRecord]:
    resp = fetch(session, file_url, timeout=60)
    time.sleep(delay)
    if resp is None:
        return None

    filename = get_filename_from_response(file_url, resp, link_text)
    # 有些附件 URL 无扩展名，用链接文字补一个扩展名
    ext = Path(filename).suffix.lower()
    if not ext:
        ext_from_url = Path(urlparse(file_url).path).suffix.lower()
        filename += ext_from_url if ext_from_url else ""
        ext = Path(filename).suffix.lower()

    year = str(year_from_text_or_url(article_title + " " + filename, file_url) or "unknown_year")
    save_dir = target_dir / year
    save_dir.mkdir(parents=True, exist_ok=True)

    local_path = save_dir / filename
    # 同名文件避免覆盖
    if local_path.exists():
        stem, suffix = local_path.stem, local_path.suffix
        local_path = save_dir / f"{stem}_{hashlib.md5(file_url.encode()).hexdigest()[:8]}{suffix}"

    local_path.write_bytes(resp.content)
    sha = sha256_file(local_path)
    return FileRecord(
        article_title=article_title,
        article_url=article_url,
        file_url=file_url,
        local_path=str(local_path),
        filename=local_path.name,
        extension=local_path.suffix.lower(),
        sha256=sha,
        size_bytes=local_path.stat().st_size,
        crawled_at=datetime.now().isoformat(timespec="seconds"),
    )


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_manifest(out_dir: Path, args: argparse.Namespace, articles: list[ArticleRecord], files: list[FileRecord]) -> None:
    years = sorted({year for year in (year_from_text_or_url(item.title, item.url) for item in articles) if year})
    payload = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "command": args.command,
        "requested_years": args.years or [],
        "discovered_years": years,
        "article_count": len(articles),
        "file_count": len(files),
        "allowed_domains": sorted(ALLOWED_DOMAINS),
        "seed_urls": SEED_URLS,
        "delay_seconds": args.delay,
        "max_pages": args.max_pages,
        "max_list_visits": args.max_list_visits,
    }
    manifest_path = out_dir / "metadata" / "crawl_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def init_db(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS articles (
            url TEXT PRIMARY KEY,
            title TEXT,
            publish_date TEXT,
            channel TEXT,
            text TEXT,
            crawled_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS files (
            file_url TEXT PRIMARY KEY,
            article_title TEXT,
            article_url TEXT,
            local_path TEXT,
            filename TEXT,
            extension TEXT,
            sha256 TEXT,
            size_bytes INTEGER,
            crawled_at TEXT
        )
        """
    )
    con.commit()
    con.close()


def upsert_article(db_path: Path, rec: ArticleRecord) -> None:
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute(
        """
        INSERT OR REPLACE INTO articles
        (url, title, publish_date, channel, text, crawled_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (rec.url, rec.title, rec.publish_date, rec.channel, rec.text, rec.crawled_at),
    )
    con.commit()
    con.close()


def upsert_file(db_path: Path, rec: FileRecord) -> None:
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute(
        """
        INSERT OR REPLACE INTO files
        (file_url, article_title, article_url, local_path, filename, extension, sha256, size_bytes, crawled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            rec.file_url,
            rec.article_title,
            rec.article_url,
            rec.local_path,
            rec.filename,
            rec.extension,
            rec.sha256,
            rec.size_bytes,
            rec.crawled_at,
        ),
    )
    con.commit()
    con.close()


def crawl(args: argparse.Namespace) -> None:
    out = Path(args.out)
    setup_logger(out)
    raw_dir = out / "raw"
    html_dir = raw_dir / "html"
    files_dir = raw_dir / "files"
    meta_dir = out / "metadata"
    db_path = out / "hebei_gaokao.sqlite"
    init_db(db_path)

    years = set(args.years or [])
    keywords = args.keywords or DEFAULT_KEYWORDS
    session = make_session()

    # 初始队列：频道页 + 频道翻页。河北考试院往年数据当前约 4 页，留到 20 页避免后续扩容。
    queue: list[str] = []
    for seed in SEED_URLS:
        queue.append(seed)
        base = seed.rstrip("/")
        # /ptgk/wnsj/index_2.html 这种翻页形式
        for i in range(2, args.max_pages + 1):
            if seed.endswith("/"):
                queue.append(f"{seed}index_{i}.html")
            elif seed.endswith("index.html"):
                queue.append(seed.replace("index.html", f"index_{i}.html"))

    seen: set[str] = set()
    article_urls: dict[str, str] = {}

    logging.info("开始发现文章链接。候选页面数：%s", len(queue))
    while queue:
        url = queue.pop(0)
        url = normalize_url(url)
        if url in seen:
            continue
        seen.add(url)
        resp = fetch(session, url)
        time.sleep(args.delay)
        if resp is None:
            continue
        links = extract_links(resp.url, resp.text)
        for text, link in links:
            if is_article_url(link) and keep_by_year_and_keyword(text, link, years, keywords):
                article_urls[link] = text
            elif is_list_url(link) and link not in seen and len(seen) < args.max_list_visits:
                # 限制频道内广度，避免无限爬全站
                queue.append(link)

    logging.info("发现候选文章：%s 篇", len(article_urls))

    article_records: list[ArticleRecord] = []
    file_records: list[FileRecord] = []

    for url, list_title in tqdm(article_urls.items(), desc="抓取文章"):
        resp = fetch(session, url)
        time.sleep(args.delay)
        if resp is None:
            continue
        rec = parse_article(resp.text, url)
        if not rec.title:
            rec.title = list_title
        if not keep_by_year_and_keyword(rec.title + " " + rec.text[:300], url, years, keywords):
            continue

        year = str(year_from_text_or_url(rec.title + " " + rec.publish_date, rec.url) or "unknown_year")
        save_html_dir = html_dir / year
        save_html_dir.mkdir(parents=True, exist_ok=True)
        html_name = safe_filename(f"{rec.publish_date}_{rec.title}.html")
        (save_html_dir / html_name).write_text(resp.text, encoding="utf-8")

        article_records.append(rec)
        upsert_article(db_path, rec)

        attachments = extract_attachment_links(resp.url, resp.text)
        for link_text, file_url in attachments:
            f_rec = download_file(
                session=session,
                file_url=file_url,
                target_dir=files_dir,
                article_title=rec.title,
                article_url=url,
                link_text=link_text,
                delay=args.delay,
            )
            if f_rec:
                file_records.append(f_rec)
                upsert_file(db_path, f_rec)

    write_csv(meta_dir / "articles.csv", [asdict(x) for x in article_records], list(ArticleRecord.__dataclass_fields__.keys()))
    write_csv(meta_dir / "files.csv", [asdict(x) for x in file_records], list(FileRecord.__dataclass_fields__.keys()))
    write_manifest(out, args, article_records, file_records)
    logging.info("完成。文章：%s，附件：%s，数据库：%s", len(article_records), len(file_records), db_path)


def infer_header_row(df_raw: pd.DataFrame, max_scan_rows: int = 12) -> int:
    """粗略推断 Excel 表头行：选非空单元格最多且包含关键字的一行。"""
    best_idx = 0
    best_score = -1
    keys = ["院校", "学校", "专业", "计划", "分数", "位次", "投档", "科目", "人数", "代码"]
    for i in range(min(max_scan_rows, len(df_raw))):
        row = df_raw.iloc[i].astype(str).fillna("").tolist()
        non_empty = sum(1 for x in row if x and x.lower() != "nan")
        keyword_hits = sum(1 for k in keys if any(k in x for x in row))
        score = non_empty + 4 * keyword_hits
        if score > best_score:
            best_idx = i
            best_score = score
    return best_idx


def normalize_columns(cols: Iterable[object]) -> list[str]:
    out = []
    seen = {}
    for c in cols:
        name = clean_text(str(c))
        if not name or name.lower() == "nan":
            name = "未命名列"
        name = re.sub(r"\s+", "", name)
        count = seen.get(name, 0)
        seen[name] = count + 1
        if count:
            name = f"{name}_{count + 1}"
        out.append(name)
    return out


def parse_excel(args: argparse.Namespace) -> None:
    out = Path(args.out)
    setup_logger(out)
    files_dir = out / "raw" / "files"
    tables_dir = out / "processed" / "tables"
    meta_dir = out / "metadata"
    tables_dir.mkdir(parents=True, exist_ok=True)
    meta_dir.mkdir(parents=True, exist_ok=True)

    excel_paths = list(files_dir.rglob("*.xlsx")) + list(files_dir.rglob("*.xls"))
    inventory: list[dict] = []

    for path in tqdm(excel_paths, desc="解析 Excel"):
        try:
            xls = pd.ExcelFile(path)
        except Exception as exc:
            logging.warning("无法打开 Excel：%s | %s", path, exc)
            inventory.append({
                "source_file": str(path), "sheet": "", "rows": 0, "cols": 0,
                "csv_path": "", "status": f"open_failed: {exc}", "columns": "",
            })
            continue

        for sheet in xls.sheet_names:
            try:
                raw = pd.read_excel(path, sheet_name=sheet, header=None, dtype=str)
                raw = raw.dropna(how="all").dropna(axis=1, how="all")
                if raw.empty:
                    continue
                header_idx = infer_header_row(raw)
                df = pd.read_excel(path, sheet_name=sheet, header=header_idx, dtype=str)
                df = df.dropna(how="all").dropna(axis=1, how="all")
                df.columns = normalize_columns(df.columns)
                # 增加溯源字段
                df.insert(0, "source_file", str(path))
                df.insert(1, "source_sheet", sheet)
                df.insert(2, "parsed_at", datetime.now().isoformat(timespec="seconds"))

                rel_parent = path.parent.name
                csv_name = safe_filename(f"{path.stem}_{sheet}.csv")
                csv_path = tables_dir / rel_parent / csv_name
                csv_path.parent.mkdir(parents=True, exist_ok=True)
                df.to_csv(csv_path, index=False, encoding="utf-8-sig")
                inventory.append({
                    "source_file": str(path),
                    "sheet": sheet,
                    "rows": len(df),
                    "cols": len(df.columns),
                    "csv_path": str(csv_path),
                    "status": "ok",
                    "columns": json.dumps(list(df.columns), ensure_ascii=False),
                })
            except Exception as exc:
                logging.warning("解析失败：%s | sheet=%s | %s", path, sheet, exc)
                inventory.append({
                    "source_file": str(path), "sheet": sheet, "rows": 0, "cols": 0,
                    "csv_path": "", "status": f"parse_failed: {exc}", "columns": "",
                })

    write_csv(
        meta_dir / "table_inventory.csv",
        inventory,
        ["source_file", "sheet", "rows", "cols", "csv_path", "status", "columns"],
    )
    logging.info("Excel 解析完成：%s 个工作表记录。", len(inventory))


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="河北高考公开数据采集器")
    sub = parser.add_subparsers(dest="command", required=True)

    p1 = sub.add_parser("crawl", help="抓取河北省教育考试院公开文章和附件")
    p1.add_argument("--out", default="data", help="输出目录，默认 data")
    p1.add_argument("--years", nargs="*", type=int, default=default_years(), help="年份过滤，默认 2021 到当前年份")
    p1.add_argument("--keywords", nargs="*", default=None, help="关键词过滤；默认使用内置高考关键词")
    p1.add_argument("--delay", type=float, default=1.2, help="请求间隔秒数，默认 1.2")
    p1.add_argument("--max-pages", type=int, default=20, help="每个频道尝试翻页数，默认 20")
    p1.add_argument("--max-list-visits", type=int, default=200, help="最多访问频道/列表页数量，默认 200")
    p1.set_defaults(func=crawl)

    p2 = sub.add_parser("parse-excel", help="将下载的 Excel 附件解析为 CSV")
    p2.add_argument("--out", default="data", help="输出目录，默认 data")
    p2.set_defaults(func=parse_excel)

    return parser


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
