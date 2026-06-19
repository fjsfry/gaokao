#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build a normalized Hebei gaokao SQLite database from crawled public data.

Input:
  data_public/
    hebei_gaokao.sqlite           raw crawler DB: articles, files
    processed/tables/**/*.csv     parsed Excel tables
    raw/html/**/*.html            saved article pages

Output tables:
  source_files
  raw_tables
  admission_line
  score_rank_table
  batch_line
  build_summary
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
from bs4 import BeautifulSoup

try:
    import fitz  # PyMuPDF
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR
except Exception:  # OCR is optional for environments that only need Excel parsing.
    fitz = None
    np = None
    RapidOCR = None


PROVINCE = "河北"
NORMAL_BATCH_PATTERNS = [
    ("本科提前批B段", re.compile(r"本科提前批B段.*投档情况统计")),
    ("专科提前批", re.compile(r"专科提前批.*投档情况统计")),
    ("对口本科批", re.compile(r"对口本科批.*投档情况统计")),
    ("对口专科批", re.compile(r"对口专科批.*投档情况统计")),
    ("本科批", re.compile(r"本科批平行志愿投档情况统计")),
    ("专科批", re.compile(r"专科批平行志愿投档情况统计")),
]
PRIMARY_SUBJECT_BATCHES = {"本科批", "专科批"}


def clean_text(value: Any) -> str:
    text = "" if value is None else str(value)
    text = text.replace("\u3000", " ").replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def to_int(value: Any) -> int | None:
    text = clean_text(value)
    if not text or text.lower() == "nan":
        return None
    match = re.search(r"-?\d+", text.replace(",", ""))
    return int(match.group(0)) if match else None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def year_from_text(text: str) -> int | None:
    match = re.search(r"(20\d{2})", text)
    return int(match.group(1)) if match else None


def subject_from_source(text: str, filename: str = "") -> str | None:
    hay = f"{text} {filename}"
    if "历史科目组合" in hay or "历史组合" in hay:
        return "历史科目组合"
    if "物理科目组合" in hay or "物理组合" in hay:
        return "物理科目组合"
    if re.search(r"历史|文史", hay):
        return "历史科目组合"
    if re.search(r"物理|理工", hay):
        return "物理科目组合"
    return None


def batch_from_title(title: str) -> str | None:
    for batch, pattern in NORMAL_BATCH_PATTERNS:
        if pattern.search(title):
            return batch
    if "本科提前批B段" in title:
        return "本科提前批B段"
    if "专科提前批" in title:
        return "专科提前批"
    if "对口本科批" in title:
        return "对口本科批"
    if "对口专科批" in title:
        return "对口专科批"
    if "本科批" in title:
        return "本科批"
    if "专科批" in title:
        return "专科批"
    return None


def is_plain_parallel_admission(title: str, batch: str | None) -> bool:
    """普通本科批/专科批公告通常同页挂历史、物理两个附件。"""
    if batch not in PRIMARY_SUBJECT_BATCHES:
        return False
    if "平行志愿投档情况统计" not in title:
        return False
    return "提前" not in title and "对口" not in title


def init_schema(con: sqlite3.Connection) -> None:
    cur = con.cursor()
    for table in [
        "source_files",
        "attachment_links",
        "raw_tables",
        "admission_line",
        "enrollment_plan",
        "major_admission_stats",
        "score_rank_table",
        "batch_line",
        "ocr_text_blocks",
        "build_summary",
    ]:
        cur.execute(f"DROP TABLE IF EXISTS {table}")

    cur.execute(
        """
        CREATE TABLE source_files (
            file_sha256 TEXT PRIMARY KEY,
            file_url TEXT,
            filename TEXT,
            extension TEXT,
            local_path TEXT,
            link_text TEXT,
            article_title TEXT,
            article_url TEXT,
            year INTEGER,
            data_category TEXT,
            size_bytes INTEGER,
            crawled_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE attachment_links (
            file_url TEXT PRIMARY KEY,
            article_url TEXT,
            article_title TEXT,
            link_text TEXT,
            local_path TEXT,
            filename TEXT,
            extension TEXT,
            year INTEGER,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE raw_tables (
            table_id TEXT PRIMARY KEY,
            source_file TEXT,
            source_sheet TEXT,
            source_sha256 TEXT,
            year INTEGER,
            inferred_category TEXT,
            rows INTEGER,
            cols INTEGER,
            csv_path TEXT,
            columns_json TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE admission_line (
            id TEXT PRIMARY KEY,
            year INTEGER,
            province TEXT,
            batch TEXT,
            subject_group TEXT,
            school_code TEXT,
            school_name TEXT,
            major_code TEXT,
            major_name TEXT,
            min_score INTEGER,
            min_rank INTEGER,
            tie_breaker_json TEXT,
            remark TEXT,
            source_file TEXT,
            source_url TEXT,
            source_sheet TEXT,
            confidence_level TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE enrollment_plan (
            id TEXT PRIMARY KEY,
            year INTEGER,
            province TEXT,
            batch TEXT,
            subject_group TEXT,
            plan_category TEXT,
            school_code TEXT,
            school_name TEXT,
            major_code TEXT,
            major_name TEXT,
            major_full_name TEXT,
            major_remark TEXT,
            level TEXT,
            selection_requirement TEXT,
            plan_count INTEGER,
            duration TEXT,
            tuition INTEGER,
            discipline_category TEXT,
            major_category TEXT,
            is_new_major INTEGER,
            source_file TEXT,
            source_url TEXT,
            source_sheet TEXT,
            confidence_level TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE major_admission_stats (
            id TEXT PRIMARY KEY,
            year INTEGER,
            province TEXT,
            batch TEXT,
            subject_group TEXT,
            school_code TEXT,
            school_name TEXT,
            major_code TEXT,
            major_name TEXT,
            major_full_name TEXT,
            admission_count INTEGER,
            min_score INTEGER,
            min_rank INTEGER,
            avg_score INTEGER,
            avg_rank INTEGER,
            max_score INTEGER,
            max_rank INTEGER,
            source_file TEXT,
            source_url TEXT,
            source_sheet TEXT,
            confidence_level TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE score_rank_table (
            id TEXT PRIMARY KEY,
            year INTEGER,
            province TEXT,
            subject_group TEXT,
            score INTEGER,
            same_score_count INTEGER,
            cumulative_rank INTEGER,
            source_url TEXT,
            source_file TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE ocr_text_blocks (
            id TEXT PRIMARY KEY,
            source_file TEXT,
            file_url TEXT,
            article_title TEXT,
            article_url TEXT,
            year INTEGER,
            page_no INTEGER,
            block_no INTEGER,
            x1 REAL,
            y1 REAL,
            x2 REAL,
            y2 REAL,
            text TEXT,
            confidence REAL,
            ocr_engine TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE batch_line (
            id TEXT PRIMARY KEY,
            year INTEGER,
            province TEXT,
            subject_group TEXT,
            batch TEXT,
            control_score INTEGER,
            source_url TEXT,
            source_file TEXT,
            imported_at TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE build_summary (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    cur.execute("CREATE INDEX idx_admission_lookup ON admission_line(year,batch,subject_group,school_name,major_name)")
    cur.execute("CREATE INDEX idx_admission_score ON admission_line(year,subject_group,min_score)")
    cur.execute("CREATE INDEX idx_enrollment_plan_lookup ON enrollment_plan(year,batch,subject_group,school_name,major_name)")
    cur.execute("CREATE INDEX idx_major_admission_stats_lookup ON major_admission_stats(year,batch,subject_group,school_name,major_name)")
    cur.execute("CREATE INDEX idx_score_rank_lookup ON score_rank_table(year,subject_group,score)")
    cur.execute("CREATE INDEX idx_batch_line_lookup ON batch_line(year,subject_group,batch)")
    cur.execute("CREATE INDEX idx_ocr_source ON ocr_text_blocks(year,source_file,page_no)")
    con.commit()


def load_file_index(con: sqlite3.Connection) -> dict[str, dict[str, Any]]:
    rows = con.execute(
        "SELECT file_url, filename, local_path, article_title, article_url, extension, sha256, size_bytes, crawled_at FROM files"
    ).fetchall()
    by_norm_path: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    by_url: dict[str, dict[str, Any]] = {}
    for file_url, filename, local_path, article_title, article_url, extension, sha, size, crawled_at in rows:
        item = {
            "file_url": file_url,
            "filename": filename,
            "local_path": local_path,
            "article_title": article_title,
            "article_url": article_url,
            "extension": extension,
            "sha256": sha,
            "size_bytes": size,
            "crawled_at": crawled_at,
            "year": year_from_text(f"{article_title} {filename}"),
        }
        by_norm_path[str(Path(local_path)).lower()] = item
        by_name[filename] = item
        by_url[file_url] = item
    return {**by_norm_path, **by_name, **by_url}


def extract_attachment_labels(out_dir: Path) -> dict[str, str]:
    labels: dict[str, str] = {}
    for html_path in (out_dir / "raw" / "html").rglob("*.html"):
        try:
            soup = BeautifulSoup(html_path.read_text(encoding="utf-8", errors="ignore"), "lxml")
        except Exception:
            continue
        for tag, attr in [("a", "href"), ("img", "src")]:
            for node in soup.find_all(tag):
                raw_url = clean_text(node.get(attr))
                if not raw_url:
                    continue
                if raw_url.startswith("//"):
                    url = "https:" + raw_url
                elif raw_url.startswith("/"):
                    url = "https://www.hebeea.edu.cn" + raw_url
                else:
                    url = raw_url
                if "file.hebeea.edu.cn" not in url:
                    continue
                label = clean_text(node.get_text(" ")) or clean_text(node.get("alt")) or clean_text(node.get("title"))
                if not label:
                    continue
                current = labels.get(url, "")
                if not current or (len(label) > len(current) and "扫描" not in label and "纯图" not in label):
                    labels[url] = label
    return labels


def infer_category(title: str, columns: list[str]) -> str:
    col_text = " ".join(columns)
    if (
        ("计划人数" in col_text or "计划数" in col_text or "招生计划" in col_text)
        and ("专业名称" in col_text or "专业全称" in col_text)
        and ("选科" in col_text or "学费" in col_text or "学制" in col_text)
    ):
        return "enrollment_plan"
    if (
        ("平均分" in col_text or "平均位次" in col_text or "最高分" in col_text or "最高位次" in col_text)
        and ("最低分" in col_text or "最低位次" in col_text)
        and ("专业名称" in col_text or "专业全称" in col_text)
    ):
        return "major_admission_stats"
    if "投档最低分" in col_text and ("专业名称" in col_text or "院校名称" in col_text):
        return "admission_line"
    if "成绩统计表" in title or ("人数" in col_text and "累计" in col_text):
        return "score_rank_table"
    if "控制分数线" in title:
        return "batch_line"
    if "征集志愿计划" in title or "招生计划" in title:
        return "enrollment_plan_raw"
    return "raw"


def import_source_files(con: sqlite3.Connection, file_index: dict[str, dict[str, Any]], attachment_labels: dict[str, str]) -> None:
    seen: set[str] = set()
    source_rows = []
    attachment_rows = []
    imported_at = datetime.now().isoformat(timespec="seconds")
    for item in file_index.values():
        sha = item.get("sha256")
        if not sha or sha in seen:
            continue
        seen.add(sha)
        title = item.get("article_title") or ""
        file_url = item.get("file_url")
        link_text = attachment_labels.get(file_url or "", "")
        source_rows.append(
            (
                sha,
                file_url,
                item.get("filename"),
                item.get("extension"),
                item.get("local_path"),
                link_text,
                title,
                item.get("article_url"),
                item.get("year"),
                infer_category(title, []),
                item.get("size_bytes"),
                item.get("crawled_at"),
            )
        )
        if file_url:
            attachment_rows.append(
                (
                    file_url,
                    item.get("article_url"),
                    title,
                    link_text,
                    item.get("local_path"),
                    item.get("filename"),
                    item.get("extension"),
                    item.get("year"),
                    imported_at,
                )
            )
    con.executemany(
        """
        INSERT OR REPLACE INTO source_files
        (file_sha256, file_url, filename, extension, local_path, link_text, article_title, article_url, year, data_category, size_bytes, crawled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        source_rows,
    )
    con.executemany(
        """
        INSERT OR REPLACE INTO attachment_links
        (file_url, article_url, article_title, link_text, local_path, filename, extension, year, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        attachment_rows,
    )
    con.commit()


def resolve_source_info(csv_path: Path, df: pd.DataFrame, file_index: dict[str, dict[str, Any]]) -> dict[str, Any]:
    source_file = clean_text(df.get("source_file", pd.Series([""])).iloc[0]) if not df.empty else ""
    norm = str(Path(source_file)).lower()
    filename = Path(source_file).name
    info = file_index.get(norm) or file_index.get(filename) or {}
    if not info and source_file:
        abs_path = Path(source_file)
        if not abs_path.is_absolute():
            abs_path = csv_path.parents[3] / source_file
        if abs_path.exists():
            info = {
                "filename": abs_path.name,
                "local_path": str(abs_path),
                "sha256": sha256_file(abs_path),
                "year": year_from_text(str(abs_path)),
                "article_title": "",
                "article_url": "",
            }
    return info


def is_valid_admission_row(row: pd.Series) -> bool:
    return bool(
        clean_text(row.get("院校名称"))
        and clean_text(row.get("专业名称"))
        and to_int(row.get("投档最低分")) is not None
        and clean_text(row.get("院校代号")).lower() != "nan"
    )


def row_text(row: pd.Series, *names: str) -> str:
    for name in names:
        value = clean_text(row.get(name))
        if value and value.lower() != "nan":
            return value
    return ""


def row_int(row: pd.Series, *names: str) -> int | None:
    for name in names:
        value = to_int(row.get(name))
        if value is not None:
            return value
    return None


def row_bool(row: pd.Series, *names: str) -> int:
    value = row_text(row, *names)
    return 1 if re.search(r"新增|是|true|1", value, re.I) else 0


def is_valid_plan_row(row: pd.Series) -> bool:
    return bool(
        row_text(row, "院校名称", "招生单位", "学校名称")
        and row_text(row, "专业名称", "专业全称", "招生专业")
        and row_int(row, "计划人数", "计划数", "招生计划") is not None
    )


def is_valid_major_stat_row(row: pd.Series) -> bool:
    return bool(
        row_text(row, "院校名称", "招生单位", "学校名称")
        and row_text(row, "专业名称", "专业全称", "招生专业")
        and (
            row_int(row, "最低分", "最低分1", "投档最低分") is not None
            or row_int(row, "最低位次", "最低位次1", "最低排名") is not None
        )
    )


def build_subject_hints(csv_paths: list[Path], file_index: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Infer subject group for ordinary batch files when the official page exposes two unnamed attachments.

    Hebei's public pages often name the two Excel files only by timestamp. In the ordinary 本科批/专科批
    pages, the larger table is consistently the 物理科目组合 file and the smaller one is 历史科目组合.
    We keep this inference scoped to those plain ordinary-batch pages so special/early batches stay explicit.
    """
    grouped: dict[tuple[int | None, str, str], list[tuple[str, int, int]]] = {}
    for csv_path in csv_paths:
        try:
            df = pd.read_csv(csv_path, dtype=str)
        except Exception:
            continue
        if df.empty:
            continue
        source_info = resolve_source_info(csv_path, df, file_index)
        source_sha = source_info.get("sha256")
        if not source_sha:
            continue
        title = source_info.get("article_title") or ""
        batch = batch_from_title(title)
        if not is_plain_parallel_admission(title, batch):
            continue
        if infer_category(title, list(df.columns)) != "admission_line":
            continue
        key = (
            source_info.get("year") or year_from_text(title),
            batch or "",
            source_info.get("article_url") or title,
        )
        grouped.setdefault(key, []).append((source_sha, len(df), int(source_info.get("size_bytes") or 0)))

    hints: dict[str, str] = {}
    for items in grouped.values():
        unique: dict[str, tuple[int, int]] = {}
        for source_sha, rows, size_bytes in items:
            old_rows, old_size = unique.get(source_sha, (0, 0))
            unique[source_sha] = (max(old_rows, rows), max(old_size, size_bytes))
        if len(unique) < 2:
            continue
        ranked = sorted(unique.items(), key=lambda item: (item[1][0], item[1][1]), reverse=True)
        hints[ranked[0][0]] = "物理科目组合"
        hints[ranked[1][0]] = "历史科目组合"
    return hints


def import_raw_tables_and_admission(con: sqlite3.Connection, out_dir: Path, file_index: dict[str, dict[str, Any]]) -> None:
    imported_at = datetime.now().isoformat(timespec="seconds")
    csv_paths = sorted((out_dir / "processed" / "tables").rglob("*.csv"))
    subject_hints = build_subject_hints(csv_paths, file_index)
    admission_rows = []
    plan_rows = []
    stat_rows = []
    raw_rows = []
    seen_admission: set[str] = set()
    seen_plan: set[str] = set()
    seen_stat: set[str] = set()
    seen_table: set[str] = set()

    for csv_path in csv_paths:
        try:
            df = pd.read_csv(csv_path, dtype=str)
        except Exception:
            continue
        if df.empty:
            continue

        source_info = resolve_source_info(csv_path, df, file_index)
        source_sha = source_info.get("sha256")
        if not source_sha:
            continue
        columns = list(df.columns)
        title = source_info.get("article_title") or str(csv_path)
        category = infer_category(title, columns)
        table_id = hashlib.sha256(f"{source_sha}|{clean_text(df.get('source_sheet', pd.Series([''])).iloc[0])}|{len(df)}|{len(columns)}".encode()).hexdigest()
        if table_id in seen_table:
            continue
        seen_table.add(table_id)
        year = source_info.get("year") or year_from_text(title) or year_from_text(str(csv_path))
        raw_rows.append(
            (
                table_id,
                clean_text(df.get("source_file", pd.Series([""])).iloc[0]),
                clean_text(df.get("source_sheet", pd.Series([""])).iloc[0]),
                source_sha,
                year,
                category,
                len(df),
                len(columns),
                str(csv_path),
                json.dumps(columns, ensure_ascii=False),
                imported_at,
            )
        )

        if category == "enrollment_plan":
            batch = batch_from_title(title) or row_text(df.iloc[0], "批次", "录取批次") if not df.empty else batch_from_title(title)
            subject = subject_from_source(f"{title} {source_info.get('link_text', '')}", source_info.get("filename", ""))
            for _, row in df.iterrows():
                if not is_valid_plan_row(row):
                    continue
                row_subject = subject_from_source(row_text(row, "科类", "科目", "生源地")) or subject
                school_code = row_text(row, "院校代号", "院校代码", "学校代码")
                school_name = row_text(row, "院校名称", "招生单位", "学校名称")
                major_code = row_text(row, "专业代号", "专业代码")
                major_name = row_text(row, "专业名称", "招生专业")
                major_full_name = row_text(row, "专业全称", "专业名称")
                plan_count = row_int(row, "计划人数", "计划数", "招生计划")
                key = "|".join(
                    [
                        str(year or ""),
                        batch or "",
                        row_subject or "",
                        school_code,
                        school_name,
                        major_code,
                        major_name,
                        str(plan_count or ""),
                        source_info.get("article_url") or "",
                    ]
                )
                record_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
                if record_id in seen_plan:
                    continue
                seen_plan.add(record_id)
                plan_rows.append(
                    (
                        record_id,
                        year,
                        PROVINCE,
                        batch,
                        row_subject,
                        row_text(row, "计划类别"),
                        school_code,
                        school_name,
                        major_code,
                        major_name,
                        major_full_name,
                        row_text(row, "专业备注", "备注"),
                        row_text(row, "专业层次", "层次"),
                        row_text(row, "选科要求", "选考科目", "首选科目", "再选科目"),
                        plan_count,
                        row_text(row, "学制"),
                        row_int(row, "学费", "收费标准"),
                        row_text(row, "门类", "学科门类"),
                        row_text(row, "专业类"),
                        row_bool(row, "是否新增", "新增"),
                        source_info.get("local_path") or clean_text(row.get("source_file")),
                        source_info.get("article_url"),
                        clean_text(row.get("source_sheet")),
                        "official_or_imported_plan",
                        imported_at,
                    )
                )
            continue

        if category == "major_admission_stats":
            batch = batch_from_title(title) or row_text(df.iloc[0], "批次", "录取批次") if not df.empty else batch_from_title(title)
            subject = subject_from_source(f"{title} {source_info.get('link_text', '')}", source_info.get("filename", ""))
            for _, row in df.iterrows():
                if not is_valid_major_stat_row(row):
                    continue
                row_subject = subject_from_source(row_text(row, "科类", "科目", "生源地")) or subject
                school_code = row_text(row, "院校代号", "院校代码", "学校代码")
                school_name = row_text(row, "院校名称", "招生单位", "学校名称")
                major_code = row_text(row, "专业代号", "专业代码")
                major_name = row_text(row, "专业名称", "招生专业")
                min_score = row_int(row, "最低分", "最低分1", "投档最低分")
                min_rank = row_int(row, "最低位次", "最低位次1", "最低排名")
                key = "|".join(
                    [
                        str(year or ""),
                        batch or "",
                        row_subject or "",
                        school_code,
                        school_name,
                        major_code,
                        major_name,
                        str(min_score or ""),
                        str(min_rank or ""),
                        source_info.get("article_url") or "",
                    ]
                )
                record_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
                if record_id in seen_stat:
                    continue
                seen_stat.add(record_id)
                stat_rows.append(
                    (
                        record_id,
                        year,
                        PROVINCE,
                        batch,
                        row_subject,
                        school_code,
                        school_name,
                        major_code,
                        major_name,
                        row_text(row, "专业全称", "专业名称"),
                        row_int(row, "录取人数", "录取数"),
                        min_score,
                        min_rank,
                        row_int(row, "平均分", "平均分1"),
                        row_int(row, "平均位次", "平均位次1"),
                        row_int(row, "最高分", "最高分1"),
                        row_int(row, "最高位次", "最高位次1"),
                        source_info.get("local_path") or clean_text(row.get("source_file")),
                        source_info.get("article_url"),
                        clean_text(row.get("source_sheet")),
                        "official_or_imported_major_stats",
                        imported_at,
                    )
                )
            continue

        if category != "admission_line":
            continue

        batch = batch_from_title(title)
        subject = subject_from_source(f"{title} {source_info.get('link_text', '')}", source_info.get("filename", ""))
        subject_from_hint = subject_hints.get(source_sha) if not subject else None
        subject = subject or subject_from_hint
        confidence = "official_public_parsed_subject_inferred" if subject_from_hint else "official_public_parsed"
        for _, row in df.iterrows():
            if not is_valid_admission_row(row):
                continue
            row_subject = subject_from_source(clean_text(row.get("科类"))) or subject
            school_code = clean_text(row.get("院校代号"))
            school_name = clean_text(row.get("院校名称"))
            major_code = clean_text(row.get("专业代号"))
            major_name = clean_text(row.get("专业名称"))
            min_score = to_int(row.get("投档最低分"))
            tie = {
                "item_1": clean_text(row.get("投档最低分同分考生排序项")),
                "item_2": clean_text(row.get("Unnamed:6")),
                "item_3": clean_text(row.get("Unnamed:7")),
                "item_4": clean_text(row.get("Unnamed:8")),
                "item_5": clean_text(row.get("Unnamed:9")),
                "item_6": clean_text(row.get("Unnamed:10")),
                "item_7": clean_text(row.get("Unnamed:11")),
            }
            remark = clean_text(row.get("备注"))
            key = "|".join(
                [
                    str(year or ""),
                    batch or "",
                    row_subject or "",
                    school_code,
                    school_name,
                    major_code,
                    major_name,
                    str(min_score or ""),
                    source_info.get("article_url") or "",
                ]
            )
            record_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
            if record_id in seen_admission:
                continue
            seen_admission.add(record_id)
            admission_rows.append(
                (
                    record_id,
                    year,
                    PROVINCE,
                    batch,
                    row_subject,
                    school_code,
                    school_name,
                    major_code,
                    major_name,
                    min_score,
                    None,
                    json.dumps(tie, ensure_ascii=False),
                    remark,
                    source_info.get("local_path") or clean_text(row.get("source_file")),
                    source_info.get("article_url"),
                    clean_text(row.get("source_sheet")),
                    confidence,
                    imported_at,
                )
            )

    con.executemany(
        """
        INSERT OR REPLACE INTO raw_tables
        (table_id, source_file, source_sheet, source_sha256, year, inferred_category, rows, cols, csv_path, columns_json, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        raw_rows,
    )
    con.executemany(
        """
        INSERT OR REPLACE INTO admission_line
        (id, year, province, batch, subject_group, school_code, school_name, major_code, major_name, min_score, min_rank,
         tie_breaker_json, remark, source_file, source_url, source_sheet, confidence_level, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        admission_rows,
    )
    con.executemany(
        """
        INSERT OR REPLACE INTO enrollment_plan
        (id, year, province, batch, subject_group, plan_category, school_code, school_name, major_code, major_name,
         major_full_name, major_remark, level, selection_requirement, plan_count, duration, tuition,
         discipline_category, major_category, is_new_major, source_file, source_url, source_sheet, confidence_level, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        plan_rows,
    )
    con.executemany(
        """
        INSERT OR REPLACE INTO major_admission_stats
        (id, year, province, batch, subject_group, school_code, school_name, major_code, major_name, major_full_name,
         admission_count, min_score, min_rank, avg_score, avg_rank, max_score, max_rank,
         source_file, source_url, source_sheet, confidence_level, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        stat_rows,
    )
    con.commit()


def html_tables(path: Path) -> list[pd.DataFrame]:
    try:
        return pd.read_html(path, dtype=str)
    except Exception:
        return []


def ocr_available() -> bool:
    return fitz is not None and np is not None and RapidOCR is not None


def ocr_blocks_for_image(ocr: Any, image: Any) -> list[tuple[list[list[float]], str, float]]:
    result, _ = ocr(image)
    blocks = []
    for item in result or []:
        if len(item) < 3:
            continue
        box, text, score = item
        try:
            confidence = float(score)
        except Exception:
            confidence = None
        blocks.append((box, clean_text(text), confidence if confidence is not None else 0.0))
    return blocks


def ocr_file_pages(path: Path, ocr: Any) -> list[tuple[int, list[tuple[list[list[float]], str, float]]]]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        pages = []
        doc = fitz.open(path)
        for idx, page in enumerate(doc):
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            pages.append((idx + 1, ocr_blocks_for_image(ocr, image)))
        return pages
    if ext in {".jpg", ".jpeg", ".png"}:
        return [(1, ocr_blocks_for_image(ocr, str(path)))]
    return []


def ocr_rows_from_blocks(
    blocks: list[tuple[list[list[float]], str, float]],
    source_info: dict[str, Any],
    page_no: int,
    imported_at: str,
) -> list[tuple[Any, ...]]:
    rows = []
    for block_no, (box, text, confidence) in enumerate(blocks, start=1):
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        record_id = hashlib.sha256(
            f"{source_info.get('file_url')}|{page_no}|{block_no}|{text}|{min(xs):.1f}|{min(ys):.1f}".encode("utf-8")
        ).hexdigest()
        rows.append(
            (
                record_id,
                source_info.get("local_path"),
                source_info.get("file_url"),
                source_info.get("article_title"),
                source_info.get("article_url"),
                source_info.get("year"),
                page_no,
                block_no,
                min(xs),
                min(ys),
                max(xs),
                max(ys),
                text,
                confidence,
                "rapidocr_onnxruntime",
                imported_at,
            )
        )
    return rows


def group_ocr_lines(blocks: list[tuple[list[list[float]], str, float]], y_tolerance: float = 18) -> list[tuple[float, list[tuple[float, str]]]]:
    items: list[tuple[float, float, str]] = []
    for box, text, _ in blocks:
        if not text:
            continue
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        items.append((min(ys), min(xs), text))
    items.sort()
    lines: list[list[Any]] = []
    for y, x, text in items:
        if not lines or abs(y - lines[-1][0]) > y_tolerance:
            lines.append([y, [(x, text)]])
        else:
            lines[-1][1].append((x, text))
    return [(float(y), sorted(parts)) for y, parts in lines]


def int_from_ocr(text: str) -> int | None:
    normalized = (
        clean_text(text)
        .replace("O", "0")
        .replace("o", "0")
        .replace("I", "1")
        .replace("l", "1")
        .replace("Ｘ", "")
        .replace("X", "")
    )
    match = re.search(r"\d+", normalized.replace(",", ""))
    return int(match.group(0)) if match else None


def pick_int_in_range(parts: list[tuple[float, str]], left: float, right: float) -> int | None:
    for x, text in parts:
        if left <= x < right:
            value = int_from_ocr(text)
            if value is not None:
                return value
    return None


def parse_core_score_rank_from_pages(
    pages: list[tuple[int, list[tuple[list[list[float]], str, float]]]]
) -> dict[str, dict[int, dict[str, int | None]]]:
    parsed: dict[str, dict[int, dict[str, int | None]]] = {
        "物理科目组合": {},
        "历史科目组合": {},
    }
    for _, blocks in pages:
        for y, parts in group_ocr_lines(blocks):
            if y < 280:
                continue
            score = pick_int_in_range(parts, 90, 280)
            if score is None or score < 0 or score > 750:
                continue
            physics_same = pick_int_in_range(parts, 300, 540)
            physics_cum = pick_int_in_range(parts, 540, 740)
            history_same = pick_int_in_range(parts, 740, 930)
            history_cum = pick_int_in_range(parts, 930, 1120)
            if physics_cum is not None:
                parsed["物理科目组合"][score] = {"same": physics_same, "cum": physics_cum}
            if history_cum is not None:
                parsed["历史科目组合"][score] = {"same": history_same, "cum": history_cum}

    for subject, rows in parsed.items():
        prev_cum = 0
        for score in sorted(rows.keys(), reverse=True):
            cum = rows[score].get("cum")
            same = rows[score].get("same")
            if cum is None or cum < prev_cum:
                rows[score]["drop"] = 1
                continue
            if same is None or same <= 0:
                rows[score]["same"] = cum - prev_cum
            prev_cum = cum
    return parsed


def import_ocr_core_score_rank(con: sqlite3.Connection, attachment_labels: dict[str, str]) -> None:
    if not ocr_available():
        return
    imported_at = datetime.now().isoformat(timespec="seconds")
    ocr = RapidOCR()
    score_rows = []
    ocr_rows = []
    files = con.execute(
        """
        SELECT file_url, local_path, article_title, article_url, filename, extension
        FROM files
        WHERE extension='.pdf'
          AND article_title LIKE '%普通高校招生各类考生成绩统计表%'
        """
    ).fetchall()
    for file_url, local_path, article_title, article_url, filename, extension in files:
        label = attachment_labels.get(file_url, "")
        if not ("物理" in label and "历史" in label):
            continue
        path = Path(local_path)
        if not path.exists():
            continue
        year = year_from_text(f"{label} {article_title} {filename}")
        source_info = {
            "file_url": file_url,
            "local_path": local_path,
            "article_title": article_title,
            "article_url": article_url,
            "year": year,
        }
        pages = ocr_file_pages(path, ocr)
        for page_no, blocks in pages:
            ocr_rows.extend(ocr_rows_from_blocks(blocks, source_info, page_no, imported_at))
        parsed = parse_core_score_rank_from_pages(pages)
        for subject, by_score in parsed.items():
            for score, item in by_score.items():
                if item.get("drop"):
                    continue
                same_count = item.get("same")
                cumulative = item.get("cum")
                if cumulative is None:
                    continue
                record_id = hashlib.sha256(f"{year}|{subject}|{score}|{file_url}".encode("utf-8")).hexdigest()
                score_rows.append(
                    (
                        record_id,
                        year,
                        PROVINCE,
                        subject,
                        score,
                        same_count,
                        cumulative,
                        article_url,
                        local_path,
                        imported_at,
                    )
                )
    con.executemany(
        """
        INSERT OR REPLACE INTO ocr_text_blocks
        (id, source_file, file_url, article_title, article_url, year, page_no, block_no, x1, y1, x2, y2, text, confidence, ocr_engine, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ocr_rows,
    )
    con.executemany(
        """
        INSERT OR REPLACE INTO score_rank_table
        (id, year, province, subject_group, score, same_score_count, cumulative_rank, source_url, source_file, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        score_rows,
    )
    con.commit()


def parse_batch_lines_from_ocr_lines(lines: list[tuple[float, list[tuple[float, str]]]]) -> list[tuple[str, str, int]]:
    rows: list[tuple[str, str, int]] = []
    line_texts = [(y, " ".join(text for _, text in parts), parts) for y, parts in lines]
    for y, text, parts in line_texts:
        if y > 500:
            continue
        subject = None
        if "历史科目组合" in text:
            subject = "历史科目组合"
        elif "物理科目组合" in text:
            subject = "物理科目组合"
        if not subject:
            continue
        values = [int_from_ocr(t) for _, t in parts if int_from_ocr(t) is not None]
        values = [v for v in values if 0 < v <= 750]
        if len(values) >= 2:
            rows.append((subject, "本科批", values[-2]))
            rows.append((subject, "专科批", values[-1]))

    full_text = "\n".join(text for _, text, _ in line_texts)
    special_idx = full_text.find("特殊类型招生录取控制分数线")
    if special_idx >= 0:
        window = full_text[special_idx : special_idx + 120]
        match = re.search(r"历史科目组合\s*(\d{3})分.*?物理\s*(?:科目组合)?\s*(\d{3})分", window, flags=re.S)
        if match:
            rows.append(("历史科目组合", "特殊类型招生控制线", int(match.group(1))))
            rows.append(("物理科目组合", "特殊类型招生控制线", int(match.group(2))))
    return rows


def import_ocr_batch_lines(con: sqlite3.Connection, attachment_labels: dict[str, str]) -> None:
    if not ocr_available():
        return
    imported_at = datetime.now().isoformat(timespec="seconds")
    ocr = RapidOCR()
    batch_rows = []
    ocr_rows = []
    files = con.execute(
        """
        SELECT file_url, local_path, article_title, article_url, filename, extension
        FROM files
        WHERE extension IN ('.jpg','.jpeg','.png')
          AND article_title LIKE '%普通高校招生各批各类录取控制分数线%'
        """
    ).fetchall()
    for file_url, local_path, article_title, article_url, filename, extension in files:
        path = Path(local_path)
        if not path.exists():
            continue
        year = year_from_text(f"{attachment_labels.get(file_url, '')} {article_title} {filename}")
        source_info = {
            "file_url": file_url,
            "local_path": local_path,
            "article_title": article_title,
            "article_url": article_url,
            "year": year,
        }
        pages = ocr_file_pages(path, ocr)
        for page_no, blocks in pages:
            ocr_rows.extend(ocr_rows_from_blocks(blocks, source_info, page_no, imported_at))
            lines = group_ocr_lines(blocks)
            for subject, batch, score in parse_batch_lines_from_ocr_lines(lines):
                record_id = hashlib.sha256(f"{year}|{subject}|{batch}".encode("utf-8")).hexdigest()
                batch_rows.append((record_id, year, PROVINCE, subject, batch, score, article_url, local_path, imported_at))
    con.executemany(
        """
        INSERT OR REPLACE INTO ocr_text_blocks
        (id, source_file, file_url, article_title, article_url, year, page_no, block_no, x1, y1, x2, y2, text, confidence, ocr_engine, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        ocr_rows,
    )
    con.executemany(
        """
        INSERT OR REPLACE INTO batch_line
        (id, year, province, subject_group, batch, control_score, source_url, source_file, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        batch_rows,
    )
    con.commit()


def import_score_rank_from_html(con: sqlite3.Connection, out_dir: Path) -> None:
    imported_at = datetime.now().isoformat(timespec="seconds")
    rows = []
    seen: set[str] = set()
    for html_path in (out_dir / "raw" / "html").rglob("*.html"):
        name = html_path.name
        if "成绩统计表" not in name:
            continue
        year = year_from_text(name)
        for table in html_tables(html_path):
            columns = [clean_text(c) for c in table.columns]
            table.columns = columns
            col_text = " ".join(columns)
            if not any("分数" in c or "成绩" in c for c in columns):
                continue
            if not any("人数" in c or "累计" in c for c in columns):
                continue
            score_col = next((c for c in columns if "分数" in c or "成绩" in c), columns[0])
            count_col = next((c for c in columns if "人数" in c and "累计" not in c), None)
            rank_col = next((c for c in columns if "累计" in c), None)
            subject = subject_from_source(name + " " + col_text) or "未知"
            for _, row in table.iterrows():
                score = to_int(row.get(score_col))
                same_count = to_int(row.get(count_col)) if count_col else None
                cumulative = to_int(row.get(rank_col)) if rank_col else None
                if score is None or (same_count is None and cumulative is None):
                    continue
                key = f"{year}|{subject}|{score}|{html_path}"
                record_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
                if record_id in seen:
                    continue
                seen.add(record_id)
                rows.append((record_id, year, PROVINCE, subject, score, same_count, cumulative, None, str(html_path), imported_at))
    con.executemany(
        """
        INSERT OR REPLACE INTO score_rank_table
        (id, year, province, subject_group, score, same_score_count, cumulative_rank, source_url, source_file, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    con.commit()


def import_batch_lines_from_html(con: sqlite3.Connection, out_dir: Path) -> None:
    imported_at = datetime.now().isoformat(timespec="seconds")
    rows = []
    seen: set[str] = set()
    for html_path in (out_dir / "raw" / "html").rglob("*.html"):
        name = html_path.name
        if "控制分数线" not in name:
            continue
        year = year_from_text(name)
        for table in html_tables(html_path):
            table.columns = [clean_text(c) for c in table.columns]
            columns = list(table.columns)
            if len(columns) < 2:
                continue
            for _, row in table.iterrows():
                row_text = " ".join(clean_text(x) for x in row.tolist())
                if not row_text or not re.search(r"本科|专科|特殊类型", row_text):
                    continue
                subject = subject_from_source(row_text) or "普通类"
                batch = "特殊类型招生控制线" if "特殊类型" in row_text else ("本科批" if "本科" in row_text else ("专科批" if "专科" in row_text else None))
                scores = [to_int(x) for x in row.tolist()]
                scores = [x for x in scores if x is not None and 0 < x <= 750]
                if not batch or not scores:
                    continue
                score = scores[-1]
                key = f"{year}|{subject}|{batch}|{score}|{html_path}"
                record_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
                if record_id in seen:
                    continue
                seen.add(record_id)
                rows.append((record_id, year, PROVINCE, subject, batch, score, None, str(html_path), imported_at))
    con.executemany(
        """
        INSERT OR REPLACE INTO batch_line
        (id, year, province, subject_group, batch, control_score, source_url, source_file, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    con.commit()


def write_summary(con: sqlite3.Connection) -> None:
    summary = {}
    for table in [
        "source_files",
        "attachment_links",
        "raw_tables",
        "admission_line",
        "enrollment_plan",
        "major_admission_stats",
        "score_rank_table",
        "batch_line",
        "ocr_text_blocks",
    ]:
        summary[table] = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
    for key, value in summary.items():
        con.execute("INSERT OR REPLACE INTO build_summary(key, value) VALUES (?, ?)", (key, str(value)))
    con.execute("INSERT OR REPLACE INTO build_summary(key, value) VALUES (?, ?)", ("built_at", datetime.now().isoformat(timespec="seconds")))
    con.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description="Build normalized Hebei gaokao database")
    parser.add_argument("--out", default="data_public", help="crawler output directory")
    args = parser.parse_args()

    out_dir = Path(args.out)
    db_path = out_dir / "hebei_gaokao.sqlite"
    if not db_path.exists():
        raise SystemExit(f"missing database: {db_path}")

    con = sqlite3.connect(db_path)
    init_schema(con)
    file_index = load_file_index(con)
    attachment_labels = extract_attachment_labels(out_dir)
    for item in file_index.values():
        if item.get("file_url"):
            item["link_text"] = attachment_labels.get(item.get("file_url"), "")
    import_source_files(con, file_index, attachment_labels)
    import_raw_tables_and_admission(con, out_dir, file_index)
    import_score_rank_from_html(con, out_dir)
    import_batch_lines_from_html(con, out_dir)
    import_ocr_core_score_rank(con, attachment_labels)
    import_ocr_batch_lines(con, attachment_labels)
    write_summary(con)
    for row in con.execute("SELECT key, value FROM build_summary ORDER BY key"):
        print(f"{row[0]}={row[1]}")
    con.close()


if __name__ == "__main__":
    main()
