#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Generate paid report license codes.

The customer receives the plain code once. Supabase stores only an HMAC hash.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import secrets
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
PLAN_USES = {
    "single": 1,
    "triple": 3,
    "season": None,
}
PLAN_MARKS = {
    "single": "S",
    "triple": "T",
    "season": "Y",
}


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().lstrip("\ufeff")
        value = value.strip().strip('"').strip("'")
        if not os.environ.get(key):
            os.environ[key] = value


def normalize_code(code: str) -> str:
    return code.replace("-", "").replace(" ", "").upper()


def hash_code(code: str) -> str:
    secret = os.environ.get("LICENSE_HASH_SECRET", "").strip()
    if not secret:
        raise RuntimeError("LICENSE_HASH_SECRET is required.")
    return hmac.new(secret.encode("utf-8"), normalize_code(code).encode("utf-8"), hashlib.sha256).hexdigest()


def make_code(plan: str) -> str:
    body = "".join(secrets.choice(ALPHABET) for _ in range(16))
    chunks = [body[index : index + 4] for index in range(0, len(body), 4)]
    return "-".join([f"ZL26{PLAN_MARKS[plan]}", *chunks])


def sql_quote(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def build_record(code: str, plan: str, note: str, expires_at: str | None) -> dict[str, Any]:
    uses = PLAN_USES[plan]
    return {
        "code_hash": hash_code(code),
        "code_prefix": code[:10],
        "plan": plan,
        "total_uses": uses,
        "remaining_uses": uses,
        "max_uses_per_day": 20 if plan == "season" else 0,
        "expires_at": expires_at,
        "customer_note": note or None,
    }


def insert_record(record: dict[str, Any]) -> None:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_KEY", "")).strip()
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for --insert.")
    response = requests.post(
        f"{url}/rest/v1/report_licenses",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json=record,
        timeout=20,
    )
    response.raise_for_status()


def insert_sql(record: dict[str, Any]) -> str:
    columns = [
        "code_hash",
        "code_prefix",
        "plan",
        "total_uses",
        "remaining_uses",
        "max_uses_per_day",
        "expires_at",
        "customer_note",
    ]
    values = ", ".join(sql_quote(record[column]) for column in columns)
    return f"insert into public.report_licenses ({', '.join(columns)}) values ({values});"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate report license codes.")
    parser.add_argument("--plan", choices=sorted(PLAN_USES), required=True)
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--note", default="")
    parser.add_argument("--expires-at", default=None, help="ISO timestamp, for example 2026-07-31T23:59:59+08:00")
    parser.add_argument("--insert", action="store_true", help="Insert directly into Supabase with service role key.")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")

    for _ in range(max(1, args.count)):
        code = make_code(args.plan)
        record = build_record(code, args.plan, args.note, args.expires_at)
        if args.insert:
            insert_record(record)
            print(f"created\t{args.plan}\t{code}")
        else:
            print(f"code\t{args.plan}\t{code}")
            print(insert_sql(record))


if __name__ == "__main__":
    main()
