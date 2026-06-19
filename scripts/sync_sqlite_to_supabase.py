from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Sequence


TABLES: tuple[str, ...] = (
    "articles",
    "files",
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
)

OPTIONAL_TABLES: set[str] = {
    "enrollment_plan",
    "major_admission_stats",
}

PRIMARY_KEYS = {
    "articles": "url",
    "files": "file_url",
    "source_files": "file_sha256",
    "attachment_links": "file_url",
    "raw_tables": "table_id",
    "admission_line": "id",
    "enrollment_plan": "id",
    "major_admission_stats": "id",
    "score_rank_table": "id",
    "batch_line": "id",
    "ocr_text_blocks": "id",
    "build_summary": "key",
}


def quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing environment variable: {name}")
    return value


def get_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f"pragma table_info({quote_ident(table)})")]


def row_to_dict(columns: Sequence[str], row: sqlite3.Row) -> dict[str, object]:
    item: dict[str, object] = {}
    for column, value in zip(columns, row):
        item[column] = value.replace("\x00", "") if isinstance(value, str) else value
    return item


def supabase_request(
    method: str,
    table: str,
    service_key: str,
    supabase_url: str,
    rows: Sequence[dict[str, object]] | None = None,
    timeout: int = 90,
) -> None:
    query = ""
    if method == "POST":
        query = f"?on_conflict={urllib.parse.quote(PRIMARY_KEYS[table])}"
    url = f"{supabase_url.rstrip('/')}/rest/v1/{urllib.parse.quote(table)}{query}"
    data = None
    headers = {
        "apikey": service_key,
        "authorization": f"Bearer {service_key}",
        "prefer": "resolution=merge-duplicates,return=minimal" if method == "POST" else "return=minimal",
    }
    if rows is not None:
        data = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json"

    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                if 200 <= response.status < 300:
                    return
                raise RuntimeError(f"unexpected status {response.status}")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code == 413 and rows and len(rows) > 1:
                mid = len(rows) // 2
                supabase_request(method, table, service_key, supabase_url, rows[:mid], timeout)
                supabase_request(method, table, service_key, supabase_url, rows[mid:], timeout)
                return
            if exc.code in {429, 500, 502, 503, 504} and attempt < 4:
                time.sleep(2 * attempt)
                continue
            raise RuntimeError(f"{method} {table} failed: HTTP {exc.code} {detail}") from exc


def clear_table(table: str, service_key: str, supabase_url: str) -> None:
    url = f"{supabase_url.rstrip('/')}/rest/v1/{urllib.parse.quote(table)}?id=not.is.null"
    # Tables that do not have an id column are cleared with their primary key.
    primary_key_filter = {
        "articles": "url=not.is.null",
        "files": "file_url=not.is.null",
        "source_files": "file_sha256=not.is.null",
        "attachment_links": "file_url=not.is.null",
        "raw_tables": "table_id=not.is.null",
        "build_summary": "key=not.is.null",
    }.get(table)
    if primary_key_filter:
        url = f"{supabase_url.rstrip('/')}/rest/v1/{urllib.parse.quote(table)}?{primary_key_filter}"
    request = urllib.request.Request(
        url,
        method="DELETE",
        headers={
            "apikey": service_key,
            "authorization": f"Bearer {service_key}",
            "prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(request, timeout=90) as response:
        if response.status not in {200, 204}:
            raise RuntimeError(f"clear {table} failed: {response.status}")


def import_table(
    conn: sqlite3.Connection,
    table: str,
    service_key: str,
    supabase_url: str,
    max_json_bytes: int,
) -> int:
    columns = get_columns(conn, table)
    if not columns:
        print(f"{table}: skipped, table not found", flush=True)
        return 0
    total = conn.execute(f"select count(*) from {quote_ident(table)}").fetchone()[0]
    if total == 0:
        print(f"{table}: 0 rows", flush=True)
        return 0

    select_sql = ", ".join(quote_ident(column) for column in columns)
    cursor = conn.execute(f"select {select_sql} from {quote_ident(table)}")
    batch: list[dict[str, object]] = []
    batch_bytes = 2
    imported = 0

    for row in cursor:
        item = row_to_dict(columns, row)
        item_bytes = len(json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1
        if batch and batch_bytes + item_bytes > max_json_bytes:
            supabase_request("POST", table, service_key, supabase_url, batch)
            imported += len(batch)
            print(f"{table}: {imported}/{total}", flush=True)
            batch.clear()
            batch_bytes = 2
        batch.append(item)
        batch_bytes += item_bytes

    if batch:
        supabase_request("POST", table, service_key, supabase_url, batch)
        imported += len(batch)
        print(f"{table}: {imported}/{total}", flush=True)
    return imported


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync crawler SQLite tables to Supabase.")
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--max-json-bytes", type=int, default=750_000)
    parser.add_argument("--replace", action="store_true", help="Clear target tables before importing. Use only for full rebuilds.")
    args = parser.parse_args()

    if not args.sqlite.exists():
        raise SystemExit(f"SQLite database not found: {args.sqlite}")

    supabase_url = required_env("SUPABASE_URL")
    service_key = required_env("SUPABASE_SERVICE_ROLE_KEY")

    conn = sqlite3.connect(args.sqlite)
    if args.replace:
        for table in TABLES:
            try:
                clear_table(table, service_key, supabase_url)
            except RuntimeError as exc:
                if table in OPTIONAL_TABLES:
                    print(f"{table}: optional target missing during clear, skipped ({exc})", flush=True)
                    continue
                raise
    for table in TABLES:
        try:
            import_table(conn, table, service_key, supabase_url, args.max_json_bytes)
        except RuntimeError as exc:
            if table in OPTIONAL_TABLES:
                print(f"{table}: optional target missing during import, skipped ({exc})", flush=True)
                continue
            raise
    conn.close()


if __name__ == "__main__":
    main()
