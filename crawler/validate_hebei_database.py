#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate the normalized Hebei gaokao SQLite database before syncing."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


CORE_TABLES = ("admission_line", "score_rank_table", "batch_line")


def count_rows(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])


def count_years(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f'SELECT COUNT(DISTINCT year) FROM "{table}" WHERE year IS NOT NULL').fetchone()[0])


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate normalized Hebei gaokao SQLite database.")
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--min-admission-lines", type=int, default=1)
    parser.add_argument("--min-score-ranks", type=int, default=1)
    parser.add_argument("--min-batch-lines", type=int, default=1)
    args = parser.parse_args()

    if not args.sqlite.exists():
        raise SystemExit(f"SQLite database not found: {args.sqlite}")

    conn = sqlite3.connect(args.sqlite)
    counts = {table: count_rows(conn, table) for table in CORE_TABLES}
    years = {table: count_years(conn, table) for table in CORE_TABLES}
    conn.close()

    print("database validation summary:")
    for table in CORE_TABLES:
        print(f"- {table}: rows={counts[table]}, years={years[table]}")

    failures = []
    if counts["admission_line"] < args.min_admission_lines:
        failures.append(f"admission_line has {counts['admission_line']} rows")
    if counts["score_rank_table"] < args.min_score_ranks:
        failures.append(f"score_rank_table has {counts['score_rank_table']} rows")
    if counts["batch_line"] < args.min_batch_lines:
        failures.append(f"batch_line has {counts['batch_line']} rows")

    if failures:
        raise SystemExit("Refusing to sync incomplete database: " + "; ".join(failures))


if __name__ == "__main__":
    main()
