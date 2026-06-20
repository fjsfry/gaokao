#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Static site server plus AI report proxy and public data lookup.

The browser never receives the AI report key. Frontend code posts the
structured diagnosis result to /api/ai-report, and this server calls the
configured AI report provider.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parent
DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"
DEFAULT_SUPABASE_URL = "https://tspotlvffujnlnmsglxj.supabase.co"
SUPPORTED_DEEPSEEK_MODELS = {
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    # Kept for compatibility with older deployments and provider aliases.
    "deepseek-chat",
    "deepseek-reasoner",
}
PUBLIC_TABLES = {
    "admission_line",
    "available_data_years",
    "batch_line",
    "enrollment_plan",
    "major_admission_stats",
    "score_rank_table",
    "school_admission_summary",
}
LICENSE_PLAN_LABELS = {
    "single": "单次报告码",
    "triple": "三次复查码",
    "season": "填报季卡",
}
LICENSE_PLAN_USES = {
    "single": 1,
    "triple": 3,
    "season": None,
}
LICENSE_PLAN_MARKS = {
    "single": "S",
    "triple": "T",
    "season": "Y",
}
LICENSE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
LICENSE_VAULT_PATTERN = re.compile(r"\n?\[code-vault:([A-Za-z0-9_\-=]+)\]\s*$")
HTTP = requests.Session()


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


def get_supabase_config() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", DEFAULT_SUPABASE_URL).rstrip("/")
    key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not key:
        raise RuntimeError("SUPABASE_ANON_KEY is not configured on the server.")
    return url, key


def get_supabase_service_config() -> tuple[str, str]:
    url = os.environ.get("SUPABASE_URL", DEFAULT_SUPABASE_URL).rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", os.environ.get("SUPABASE_SERVICE_KEY", "")).strip()
    if not key:
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.")
    return url, key


def get_license_hash_secret() -> str:
    secret = os.environ.get("LICENSE_HASH_SECRET", "").strip()
    if not secret:
        raise RuntimeError("LICENSE_HASH_SECRET is not configured on the server.")
    return secret


def get_license_admin_token() -> str:
    token = os.environ.get("LICENSE_ADMIN_TOKEN", "").strip()
    if not token:
        raise RuntimeError("LICENSE_ADMIN_TOKEN is not configured on the server.")
    return token


def get_deepseek_config() -> tuple[str, str]:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not configured on the server.")
    model = os.environ.get("DEEPSEEK_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL
    if model not in SUPPORTED_DEEPSEEK_MODELS:
        allowed = ", ".join(sorted(SUPPORTED_DEEPSEEK_MODELS))
        raise RuntimeError(f"Unsupported DEEPSEEK_MODEL '{model}'. Allowed models: {allowed}.")
    base_url = os.environ.get("DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL).strip().rstrip("/")
    if not base_url.startswith("https://"):
        raise RuntimeError("DEEPSEEK_BASE_URL must be an https URL.")
    return api_key, model


def deepseek_chat_url() -> str:
    base_url = os.environ.get("DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL).strip().rstrip("/")
    return f"{base_url}/chat/completions"


def supabase_get(table: str, params: dict[str, str], timeout: int = 20) -> list[dict[str, Any]]:
    if table not in PUBLIC_TABLES:
        raise ValueError(f"Unsupported public table: {table}")
    url, key = get_supabase_config()
    response = HTTP.get(
        f"{url}/rest/v1/{table}",
        params=params,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
        timeout=timeout,
    )
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list):
        raise RuntimeError("Unexpected Supabase response")
    return data


def optional_supabase_get(table: str, params: dict[str, str], timeout: int = 20) -> list[dict[str, Any]]:
    """Read optional enrichment tables without breaking the core diagnosis flow."""
    try:
        return supabase_get(table, params, timeout=timeout)
    except requests.HTTPError as exc:
        status = getattr(exc.response, "status_code", 0)
        if status in {HTTPStatus.NOT_FOUND, HTTPStatus.BAD_REQUEST}:
            return []
        raise
    except (requests.RequestException, RuntimeError, ValueError):
        return []


def supabase_service_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    _, key = get_supabase_service_config()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def supabase_service_url(table: str) -> str:
    url, _ = get_supabase_service_config()
    return f"{url}/rest/v1/{table}"


def normalize_license_code(value: Any) -> str:
    code = re.sub(r"[\s-]+", "", str(value or "").upper())
    if not re.fullmatch(r"[A-Z0-9]{12,64}", code):
        raise ValueError("授权码格式不正确，请检查是否复制完整。")
    return code


def hash_license_code(normalized_code: str) -> str:
    secret = get_license_hash_secret().encode("utf-8")
    return hmac.new(secret, normalized_code.encode("utf-8"), hashlib.sha256).hexdigest()


def license_keystream(length: int, nonce: bytes) -> bytes:
    secret = get_license_hash_secret().encode("utf-8")
    output = bytearray()
    counter = 0
    while len(output) < length:
        message = b"license-vault:" + nonce + counter.to_bytes(4, "big")
        output.extend(hmac.new(secret, message, hashlib.sha256).digest())
        counter += 1
    return bytes(output[:length])


def seal_license_code(normalized_code: str) -> str:
    raw = normalized_code.encode("utf-8")
    nonce = secrets.token_bytes(12)
    stream = license_keystream(len(raw), nonce)
    sealed = bytes(byte ^ stream[index] for index, byte in enumerate(raw))
    return base64.urlsafe_b64encode(nonce + sealed).decode("ascii")


def unseal_license_code(value: Any) -> str | None:
    if not value:
        return None
    try:
        payload = base64.urlsafe_b64decode(str(value).encode("ascii"))
        nonce, sealed = payload[:12], payload[12:]
        stream = license_keystream(len(sealed), nonce)
        raw = bytes(byte ^ stream[index] for index, byte in enumerate(sealed))
        return raw.decode("utf-8")
    except Exception:
        return None


def append_license_vault_note(note: Any, sealed_code: str | None) -> str | None:
    clean_note = LICENSE_VAULT_PATTERN.sub("", str(note or "")).strip()
    if not sealed_code:
        return clean_note or None
    return f"{clean_note}\n[code-vault:{sealed_code}]" if clean_note else f"[code-vault:{sealed_code}]"


def split_license_vault_note(note: Any) -> tuple[str, str | None]:
    text = str(note or "")
    match = LICENSE_VAULT_PATTERN.search(text)
    if not match:
        return text.strip(), None
    return LICENSE_VAULT_PATTERN.sub("", text).strip(), match.group(1)


def make_license_code(plan: str) -> str:
    body = "".join(secrets.choice(LICENSE_CODE_ALPHABET) for _ in range(16))
    chunks = [body[index : index + 4] for index in range(0, len(body), 4)]
    return "-".join([f"ZL26{LICENSE_PLAN_MARKS[plan]}", *chunks])


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_license_row(code_hash: str) -> dict[str, Any] | None:
    response = HTTP.get(
        supabase_service_url("report_licenses"),
        params={
            "select": (
                "id,code_prefix,plan,total_uses,remaining_uses,max_uses_per_day,"
                "expires_at,status,customer_note,last_used_at,created_at"
            ),
            "code_hash": f"eq.{code_hash}",
            "limit": "1",
        },
        headers=supabase_service_headers(),
        timeout=12,
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list):
        raise RuntimeError("Unexpected license lookup response")
    return rows[0] if rows else None


def plan_label(plan: Any) -> str:
    return LICENSE_PLAN_LABELS.get(str(plan or ""), "授权码")


def require_license_admin(payload: dict[str, Any]) -> None:
    supplied = str(payload.get("adminToken") or payload.get("token") or "").strip()
    if not supplied:
        raise PermissionError("请输入内部发码口令。")
    if not hmac.compare_digest(supplied, get_license_admin_token()):
        raise PermissionError("内部发码口令不正确。")


def parse_license_plan(value: Any) -> str:
    plan = str(value or "single").strip()
    if plan not in LICENSE_PLAN_USES:
        raise ValueError("授权码套餐不正确。")
    return plan


def parse_license_count(value: Any) -> int:
    count = parse_int(value, fallback=1)
    if count < 1 or count > 20:
        raise ValueError("单次最多生成20个授权码。")
    return count


def parse_license_expires_at(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    expires_at = f"{raw}T23:59:59+08:00" if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw) else raw
    expires_at = expires_at.replace("Z", "+00:00")
    parsed = parse_datetime(expires_at)
    if not parsed:
        raise ValueError("有效期格式不正确。")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
        expires_at = parsed.isoformat()
    if parsed <= datetime.now(timezone.utc):
        raise ValueError("有效期必须晚于当前时间。")
    return expires_at


def build_license_record(code: str, plan: str, note: str, expires_at: str | None) -> dict[str, Any]:
    uses = LICENSE_PLAN_USES[plan]
    normalized_code = normalize_license_code(code)
    sealed_code = seal_license_code(normalized_code)
    return {
        "code_hash": hash_license_code(normalized_code),
        "code_sealed": sealed_code,
        "code_prefix": code[:10],
        "plan": plan,
        "total_uses": uses,
        "remaining_uses": uses,
        "max_uses_per_day": 20 if plan == "season" else 0,
        "expires_at": expires_at,
        "customer_note": append_license_vault_note(note, sealed_code),
    }


def insert_license_record(record: dict[str, Any]) -> dict[str, Any]:
    try:
        response = HTTP.post(
            supabase_service_url("report_licenses"),
            headers=supabase_service_headers({"Prefer": "return=representation"}),
            json=record,
            timeout=12,
        )
        response.raise_for_status()
    except requests.HTTPError as exc:
        text = exc.response.text if exc.response is not None else ""
        if "code_sealed" not in text:
            raise
        legacy_record = {key: value for key, value in record.items() if key != "code_sealed"}
        response = HTTP.post(
            supabase_service_url("report_licenses"),
            headers=supabase_service_headers({"Prefer": "return=representation"}),
            json=legacy_record,
            timeout=12,
        )
        response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Unexpected license create response")
    return rows[0]


def public_created_license(code: str, row: dict[str, Any]) -> dict[str, Any]:
    unlimited = is_unlimited_license(row)
    return {
        "code": code,
        "codePrefix": row.get("code_prefix"),
        "plan": row.get("plan"),
        "planLabel": plan_label(row.get("plan")),
        "remainingUses": None if unlimited else int(row.get("remaining_uses") or 0),
        "totalUses": None if unlimited else int(row.get("total_uses") or 0),
        "unlimited": unlimited,
        "maxUsesPerDay": row.get("max_uses_per_day"),
        "expiresAt": row.get("expires_at"),
    }


def create_license_codes(payload: dict[str, Any]) -> list[dict[str, Any]]:
    require_license_admin(payload)
    plan = parse_license_plan(payload.get("plan"))
    count = parse_license_count(payload.get("count"))
    note = str(payload.get("note") or "").strip()[:160]
    expires_at = parse_license_expires_at(payload.get("expiresAt"))

    created: list[dict[str, Any]] = []
    for _ in range(count):
        for _attempt in range(4):
            code = make_license_code(plan)
            record = build_license_record(code, plan, note, expires_at)
            try:
                row = insert_license_record(record)
                created.append(public_created_license(code, row))
                break
            except requests.HTTPError as exc:
                if exc.response is not None and exc.response.status_code == HTTPStatus.CONFLICT:
                    continue
                raise
        else:
            raise RuntimeError("授权码生成冲突，请重试。")
    return created


def pretty_license_code(normalized_code: str | None) -> str | None:
    code = normalize_license_code(normalized_code) if normalized_code else ""
    if len(code) >= 9 and code.startswith("ZL26"):
        return "-".join([code[:5], *[code[index : index + 4] for index in range(5, len(code), 4)]])
    return code or None


def recoverable_license_code(row: dict[str, Any]) -> str | None:
    _clean_note, sealed_from_note = split_license_vault_note(row.get("customer_note"))
    return pretty_license_code(unseal_license_code(row.get("code_sealed") or sealed_from_note))


def license_status_label(row: dict[str, Any]) -> str:
    expires_at = parse_datetime(row.get("expires_at"))
    if expires_at and expires_at <= datetime.now(timezone.utc):
        return "已过期"
    status = str(row.get("status") or "active")
    return {"active": "可使用", "disabled": "已停用", "refunded": "已退款"}.get(status, status)


def get_admin_license_rows() -> tuple[list[dict[str, Any]], bool]:
    base_select = (
        "id,code_prefix,code_sealed,plan,total_uses,remaining_uses,max_uses_per_day,"
        "expires_at,status,customer_note,last_used_at,created_at,updated_at"
    )
    params = {"select": base_select, "order": "created_at.desc", "limit": "1000"}
    try:
        response = HTTP.get(
            supabase_service_url("report_licenses"),
            params=params,
            headers=supabase_service_headers(),
            timeout=15,
        )
        response.raise_for_status()
        rows = response.json()
        return rows if isinstance(rows, list) else [], True
    except requests.HTTPError as exc:
        text = exc.response.text if exc.response is not None else ""
        if "code_sealed" not in text:
            raise
    legacy_select = base_select.replace("code_sealed,", "")
    response = HTTP.get(
        supabase_service_url("report_licenses"),
        params={**params, "select": legacy_select},
        headers=supabase_service_headers(),
        timeout=15,
    )
    response.raise_for_status()
    rows = response.json()
    return rows if isinstance(rows, list) else [], False


def get_admin_license_events(limit: int = 300) -> list[dict[str, Any]]:
    response = HTTP.get(
        supabase_service_url("report_license_events"),
        params={
            "select": "id,license_id,event_type,uses_delta,request_fingerprint,client_ip,user_agent,metadata,created_at",
            "order": "created_at.desc",
            "limit": str(limit),
        },
        headers=supabase_service_headers(),
        timeout=15,
    )
    response.raise_for_status()
    rows = response.json()
    return rows if isinstance(rows, list) else []


def filter_admin_licenses(rows: list[dict[str, Any]], payload: dict[str, Any]) -> list[dict[str, Any]]:
    query = str(payload.get("query") or "").strip().lower()
    status_filter = str(payload.get("status") or "all")
    plan_filter = str(payload.get("plan") or "all")

    def matches(row: dict[str, Any]) -> bool:
        clean_note, sealed_from_note = split_license_vault_note(row.get("customer_note"))
        full_code = pretty_license_code(unseal_license_code(row.get("code_sealed") or sealed_from_note))
        status_label = license_status_label(row)
        if status_filter != "all":
            if status_filter == "expired":
                if status_label != "已过期":
                    return False
            elif str(row.get("status") or "") != status_filter:
                return False
        if plan_filter != "all" and str(row.get("plan") or "") != plan_filter:
            return False
        if query:
            haystack = " ".join(
                str(part or "")
                for part in (
                    row.get("code_prefix"),
                    clean_note,
                    row.get("plan"),
                    row.get("status"),
                    full_code,
                )
            ).lower()
            if query not in haystack:
                return False
        return True

    return [row for row in rows if matches(row)]


def public_admin_license(row: dict[str, Any], events_by_license: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    license_id = str(row.get("id") or "")
    events = events_by_license.get(license_id, [])
    consume_count = sum(1 for event in events if event.get("event_type") == "consume")
    clean_note, sealed_from_note = split_license_vault_note(row.get("customer_note"))
    total = row.get("total_uses")
    remaining = row.get("remaining_uses")
    unlimited = is_unlimited_license(row)
    if unlimited:
        used = consume_count
    else:
        used = max(0, int(total or 0) - int(remaining or 0))
    full_code = pretty_license_code(unseal_license_code(row.get("code_sealed") or sealed_from_note))
    return {
        "id": row.get("id"),
        "code": full_code,
        "codePrefix": row.get("code_prefix"),
        "codeDisplay": full_code or f"{row.get('code_prefix', '旧码')}******",
        "canReveal": bool(full_code),
        "plan": row.get("plan"),
        "planLabel": plan_label(row.get("plan")),
        "status": row.get("status"),
        "statusLabel": license_status_label(row),
        "customerNote": clean_note,
        "totalUses": None if unlimited else int(total or 0),
        "remainingUses": None if unlimited else int(remaining or 0),
        "usedUses": used,
        "unlimited": unlimited,
        "maxUsesPerDay": row.get("max_uses_per_day"),
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "expiresAt": row.get("expires_at"),
        "lastUsedAt": row.get("last_used_at"),
        "eventCount": len(events),
        "lastEventType": events[0].get("event_type") if events else "",
        "lastEventAt": events[0].get("created_at") if events else row.get("last_used_at"),
    }


def public_admin_event(event: dict[str, Any], license_lookup: dict[str, dict[str, Any]]) -> dict[str, Any]:
    license_id = str(event.get("license_id") or "")
    row = license_lookup.get(license_id, {})
    clean_note, _sealed_from_note = split_license_vault_note(row.get("customer_note"))
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    return {
        "id": event.get("id"),
        "licenseId": license_id,
        "codePrefix": row.get("code_prefix") or "",
        "planLabel": plan_label(row.get("plan")),
        "customerNote": clean_note,
        "eventType": event.get("event_type"),
        "usesDelta": event.get("uses_delta"),
        "createdAt": event.get("created_at"),
        "subject": metadata.get("subject") or "",
        "batch": metadata.get("batch") or "",
        "rank": metadata.get("rank") or "",
        "diagnosisCount": metadata.get("diagnosis_count") or "",
        "device": str(event.get("request_fingerprint") or "")[:12],
    }


def build_admin_dashboard(payload: dict[str, Any]) -> dict[str, Any]:
    require_license_admin(payload)
    rows, can_reveal_codes = get_admin_license_rows()
    events = get_admin_license_events()
    events_by_license: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        events_by_license.setdefault(str(event.get("license_id") or ""), []).append(event)

    filtered_rows = filter_admin_licenses(rows, payload)
    license_lookup = {str(row.get("id") or ""): row for row in rows}
    now = datetime.now(timezone.utc)
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    consume_events = [event for event in events if event.get("event_type") == "consume"]
    today_reports = [
        event
        for event in consume_events
        if (parse_datetime(event.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)) >= today
    ]
    expiring_soon = [
        row
        for row in rows
        if row.get("status") == "active"
        and (expires_at := parse_datetime(row.get("expires_at")))
        and now < expires_at <= now + timedelta(days=14)
    ]
    unique_notes = {
        clean_note
        for row in rows
        if (clean_note := split_license_vault_note(row.get("customer_note"))[0])
    }
    unique_devices = {str(event.get("request_fingerprint") or "") for event in events if event.get("request_fingerprint")}
    plan_counts: dict[str, int] = {}
    for row in rows:
        plan = str(row.get("plan") or "unknown")
        plan_counts[plan] = plan_counts.get(plan, 0) + 1

    dashboard_licenses = [public_admin_license(row, events_by_license) for row in filtered_rows[:200]]
    dashboard_events = [public_admin_event(event, license_lookup) for event in events[:120]]
    has_recoverable_codes = any(recoverable_license_code(row) for row in rows)
    return {
        "ok": True,
        "canRevealCodes": can_reveal_codes or has_recoverable_codes,
        "hasLicenseCodeColumn": can_reveal_codes,
        "stats": {
            "customerCount": len(unique_notes) or len(rows),
            "uniqueDeviceCount": len(unique_devices),
            "licenseCount": len(rows),
            "activeLicenseCount": sum(1 for row in rows if row.get("status") == "active" and license_status_label(row) != "已过期"),
            "usedLicenseCount": sum(1 for row in rows if row.get("last_used_at")),
            "reportCount": len(consume_events),
            "todayReportCount": len(today_reports),
            "expiringSoonCount": len(expiring_soon),
            "remainingFiniteUses": sum(int(row.get("remaining_uses") or 0) for row in rows if not is_unlimited_license(row)),
        },
        "planBreakdown": [
            {"plan": plan, "planLabel": plan_label(plan), "count": count}
            for plan, count in sorted(plan_counts.items())
        ],
        "licenses": dashboard_licenses,
        "events": dashboard_events,
        "resultCount": len(filtered_rows),
        "totalCount": len(rows),
    }


def update_license_status(payload: dict[str, Any]) -> dict[str, Any]:
    require_license_admin(payload)
    license_id = str(payload.get("licenseId") or "").strip()
    status = str(payload.get("status") or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F-]{32,36}", license_id):
        raise ValueError("授权码记录不存在。")
    if status not in {"active", "disabled", "refunded"}:
        raise ValueError("授权码状态不正确。")
    now = utc_now_iso()
    response = HTTP.patch(
        supabase_service_url("report_licenses"),
        params={"id": f"eq.{license_id}"},
        headers=supabase_service_headers({"Prefer": "return=representation"}),
        json={"status": status, "updated_at": now},
        timeout=12,
    )
    response.raise_for_status()
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise ValueError("授权码记录不存在。")
    row = rows[0]
    if status != "active":
        insert_license_event(
            row,
            event_type="disable",
            uses_delta=0,
            request_fingerprint="admin",
            client_ip="",
            user_agent="license-admin",
            metadata={"status": status},
        )
    return {"ok": True, "license": public_license_state(row)}


def is_unlimited_license(row: dict[str, Any]) -> bool:
    return str(row.get("plan")) == "season" or row.get("total_uses") is None


def validate_license_row(row: dict[str, Any]) -> None:
    if row.get("status") != "active":
        raise PermissionError("授权码已停用，请联系顾问处理。")
    expires_at = parse_datetime(row.get("expires_at"))
    if expires_at and expires_at <= datetime.now(timezone.utc):
        raise PermissionError("授权码已过期，请联系顾问续期。")
    if not is_unlimited_license(row) and int(row.get("remaining_uses") or 0) <= 0:
        raise PermissionError("授权码次数已用完，请购买新的报告码。")


def public_license_state(row: dict[str, Any]) -> dict[str, Any]:
    unlimited = is_unlimited_license(row)
    remaining = None if unlimited else int(row.get("remaining_uses") or 0)
    total = None if unlimited else int(row.get("total_uses") or 0)
    return {
        "ok": True,
        "id": row.get("id"),
        "codePrefix": row.get("code_prefix"),
        "plan": row.get("plan"),
        "planLabel": plan_label(row.get("plan")),
        "remainingUses": remaining,
        "totalUses": total,
        "unlimited": unlimited,
        "maxUsesPerDay": row.get("max_uses_per_day"),
        "expiresAt": row.get("expires_at"),
        "lastUsedAt": row.get("last_used_at"),
    }


def count_license_events_today(license_id: str, event_type: str = "consume") -> int:
    start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    response = HTTP.get(
        supabase_service_url("report_license_events"),
        params={
            "select": "id",
            "license_id": f"eq.{license_id}",
            "event_type": f"eq.{event_type}",
            "created_at": f"gte.{start}",
        },
        headers=supabase_service_headers({"Prefer": "count=exact"}),
        timeout=12,
    )
    response.raise_for_status()
    content_range = response.headers.get("Content-Range", "")
    if "/" in content_range:
        try:
            return int(content_range.rsplit("/", 1)[1])
        except ValueError:
            return 0
    rows = response.json()
    return len(rows) if isinstance(rows, list) else 0


def insert_license_event(
    row: dict[str, Any],
    *,
    event_type: str,
    uses_delta: int,
    request_fingerprint: str,
    client_ip: str,
    user_agent: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    payload = {
        "license_id": row.get("id"),
        "event_type": event_type,
        "uses_delta": uses_delta,
        "request_fingerprint": request_fingerprint,
        "client_ip": client_ip or None,
        "user_agent": user_agent[:500],
        "metadata": metadata or {},
    }
    response = HTTP.post(
        supabase_service_url("report_license_events"),
        headers=supabase_service_headers(),
        json=payload,
        timeout=12,
    )
    response.raise_for_status()


def verify_license_code(value: Any) -> dict[str, Any]:
    normalized = normalize_license_code(value)
    row = get_license_row(hash_license_code(normalized))
    if not row:
        raise PermissionError("授权码不存在或输入错误。")
    validate_license_row(row)
    return row


def consume_license_code(
    value: Any,
    *,
    request_fingerprint: str,
    client_ip: str,
    user_agent: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row = verify_license_code(value)
    now = utc_now_iso()

    if is_unlimited_license(row):
        daily_limit = int(row.get("max_uses_per_day") or 20)
        if daily_limit > 0 and count_license_events_today(str(row["id"])) >= daily_limit:
            raise PermissionError("授权码今日生成次数已达上限，请明天再试或联系顾问。")
        response = HTTP.patch(
            supabase_service_url("report_licenses"),
            params={"id": f"eq.{row['id']}", "status": "eq.active"},
            headers=supabase_service_headers({"Prefer": "return=representation"}),
            json={"last_used_at": now, "updated_at": now},
            timeout=12,
        )
    else:
        remaining = int(row.get("remaining_uses") or 0)
        response = HTTP.patch(
            supabase_service_url("report_licenses"),
            params={
                "id": f"eq.{row['id']}",
                "status": "eq.active",
                "remaining_uses": f"eq.{remaining}",
            },
            headers=supabase_service_headers({"Prefer": "return=representation"}),
            json={"remaining_uses": remaining - 1, "last_used_at": now, "updated_at": now},
            timeout=12,
        )

    response.raise_for_status()
    updated = response.json()
    if not isinstance(updated, list) or not updated:
        raise PermissionError("授权码正在被使用，请稍后重试。")
    consumed = updated[0]
    insert_license_event(
        consumed,
        event_type="consume",
        uses_delta=0 if is_unlimited_license(consumed) else -1,
        request_fingerprint=request_fingerprint,
        client_ip=client_ip,
        user_agent=user_agent,
        metadata=metadata,
    )
    return consumed


def refund_license_use(
    row: dict[str, Any],
    *,
    request_fingerprint: str,
    client_ip: str,
    user_agent: str,
    reason: str,
) -> None:
    if not row or is_unlimited_license(row):
        return
    total = int(row.get("total_uses") or 0)
    remaining = int(row.get("remaining_uses") or 0)
    restored = min(total, remaining + 1)
    now = utc_now_iso()
    try:
        response = HTTP.patch(
            supabase_service_url("report_licenses"),
            params={"id": f"eq.{row['id']}"},
            headers=supabase_service_headers({"Prefer": "return=representation"}),
            json={"remaining_uses": restored, "updated_at": now},
            timeout=12,
        )
        response.raise_for_status()
        insert_license_event(
            {**row, "remaining_uses": restored},
            event_type="refund",
            uses_delta=1,
            request_fingerprint=request_fingerprint,
            client_ip=client_ip,
            user_agent=user_agent,
            metadata={"reason": reason[:200]},
        )
    except Exception:
        # Do not hide the original AI failure if refund bookkeeping fails.
        return


def is_statement_timeout(exc: requests.HTTPError) -> bool:
    if exc.response is None:
        return False
    try:
        detail = exc.response.json()
    except Exception:
        detail = {}
    return isinstance(detail, dict) and detail.get("code") == "57014"


def clean_search_term(value: Any, max_len: int = 40) -> str:
    text = str(value or "").strip()
    text = re.sub(r"^(?:第)?\d{1,3}(?:个)?志愿[:：、.\s-]*", "", text)
    text = re.sub(r"^(?:院校|学校|专业|计划)?(?:代码|代号|编号)[:：\s]*", "", text)
    text = re.sub(r"^[A-Z]?\d{2,8}[A-Z]?(?:组)?[:：、.\s-]*", "", text, flags=re.IGNORECASE)
    text = text.replace("[公办]", "").replace("[民办]", "").replace("[独立学院]", "")
    text = text.replace("（公办）", "").replace("（民办）", "").replace("（独立学院）", "")
    text = re.sub(r"^(?:学校名称|院校名称|招生院校|院校|学校|专业名称|招生专业|专业类|专业)[:：\s]*", "", text)
    text = re.sub(r"(?:本科提前批|本科批|专科批|普通类本科批|普通类专科批|物理科目组合|历史科目组合|物理类|历史类)", "", text)
    for char in "%*_()[]{}（）【】":
        text = text.replace(char, "")
    return re.sub(r"\s+", "", text)[:max_len]


def major_query_candidates(value: Any) -> list[str]:
    raw = clean_search_term(value)
    candidates: list[str] = []
    for candidate in [
        raw,
        re.sub(r"（[^）]*(?:含|包含|方向|培养|校区|学费|年|授予|办学|合作|师范)[^）]*）", "", raw),
        re.sub(r"\([^)]*(?:含|包含|方向|培养|校区|学费|年|授予|办学|合作|师范)[^)]*\)", "", raw),
        re.split(r"含|包含|[、,，/／|;；]", raw, maxsplit=1)[0],
    ]:
        candidate = clean_search_term(candidate, max_len=24)
        if not candidate or candidate in candidates:
            continue
        if len(candidate) < 2:
            continue
        candidates.append(candidate)
    return candidates[:3]


def school_query_candidates(value: Any) -> list[str]:
    raw = clean_search_term(value)
    suffix_pattern = (
        r".*?(?:高等专科学校|职业技术大学|职业技术学院|职业学院|专科学校|医学院|警官学院|"
        r"师范学院|财经学院|理工学院|科技学院|工程学院|艺术学院|体育学院|政法学院|"
        r"外国语学院|大学|学院|学校)"
    )
    candidates: list[str] = []
    for candidate in [
        raw,
        re.sub(r"(?:主校区|[一-龥A-Za-z0-9]+校区|中外合作办学|校企合作|公办|民办|独立学院).*$", "", raw),
        re.sub(r"(?:学院|大学)\([^)]*\)$", lambda match: match.group(0).split("(")[0], raw),
    ]:
        candidate = clean_search_term(candidate, max_len=32)
        match = re.search(suffix_pattern, candidate)
        if match:
            candidate = match.group(0)
        if candidate and candidate not in candidates and len(candidate) >= 4:
            candidates.append(candidate)
    return candidates[:3] or ([raw] if raw else [])


def parse_int(value: Any, fallback: int = 0) -> int:
    try:
        return int(float(str(value).strip()))
    except Exception:
        return fallback


def normalize_batch(value: Any) -> str:
    text = str(value or "")
    if "专科" in text:
        return "专科批"
    if "提前" in text:
        return "本科提前批"
    return "本科批"


def pick_data_year(requested_year: int, available_rows: list[dict[str, Any]]) -> int:
    years = sorted(parse_int(row.get("year")) for row in available_rows if parse_int(row.get("year")))
    if not years:
        return requested_year
    eligible = [year for year in years if year <= requested_year]
    return eligible[-1] if eligible else years[-1]


def fetch_data_context(payload: dict[str, Any]) -> dict[str, Any]:
    form = payload.get("formData") or {}
    volunteers = payload.get("volunteers") or []
    requested_year = parse_int(form.get("year"), 2026)
    subject = str(form.get("subject") or "物理科目组合")
    batch = normalize_batch(form.get("batch"))
    score = parse_int(form.get("score"))

    available_rows = supabase_get(
        "available_data_years",
        {
            "select": "year,admission_line_count,score_rank_count,batch_line_count",
            "order": "year.desc",
        },
        timeout=12,
    )
    data_year = pick_data_year(requested_year, available_rows)

    batch_lines = supabase_get(
        "batch_line",
        {
            "select": "year,subject_group,batch,control_score,source_url",
            "year": f"eq.{data_year}",
            "subject_group": f"eq.{subject}",
            "order": "batch.asc",
        },
        timeout=12,
    )

    score_rank = []
    if score:
        score_rank = supabase_get(
            "score_rank_table",
            {
                "select": "year,subject_group,score,same_score_count,cumulative_rank,source_url",
                "year": f"eq.{data_year}",
                "subject_group": f"eq.{subject}",
                "score": f"eq.{score}",
                "limit": "1",
            },
            timeout=12,
        )

    rank_cache: dict[tuple[int, int], int] = {}

    def enrich_rank_from_score(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        scores_by_year: dict[int, set[int]] = {}
        for row in rows:
            if row.get("min_rank") or not row.get("min_score"):
                continue
            row_year = parse_int(row.get("year"))
            row_score = parse_int(row.get("min_score"))
            if row_year and row_score:
                scores_by_year.setdefault(row_year, set()).add(row_score)

        for row_year, scores in scores_by_year.items():
            missing = [score_item for score_item in scores if (row_year, score_item) not in rank_cache]
            if not missing:
                continue
            score_filter = ",".join(str(score_item) for score_item in sorted(missing))
            rank_rows = supabase_get(
                "score_rank_table",
                {
                    "select": "year,score,cumulative_rank",
                    "year": f"eq.{row_year}",
                    "subject_group": f"eq.{subject}",
                    "score": f"in.({score_filter})",
                },
                timeout=8,
            )
            for rank_row in rank_rows:
                rank_cache[(parse_int(rank_row.get("year")), parse_int(rank_row.get("score")))] = parse_int(
                    rank_row.get("cumulative_rank")
                )

        for row in rows:
            row_year = parse_int(row.get("year"))
            row_score = parse_int(row.get("min_score"))
            mapped_rank = rank_cache.get((row_year, row_score))
            if mapped_rank and not row.get("min_rank"):
                row["min_rank_estimated"] = mapped_rank
                row["rank_source"] = "score_rank_table"
        return rows

    admission_matches: dict[str, list[dict[str, Any]]] = {}
    enrollment_plan_matches: dict[str, list[dict[str, Any]]] = {}
    major_stat_matches: dict[str, list[dict[str, Any]]] = {}
    year_floor = max(2021, data_year - 2)
    years_filter = ",".join(str(year) for year in range(year_floor, data_year + 1))
    all_years_filter = ",".join(str(year) for year in range(2021, data_year + 1))
    plan_years_filter = ",".join(str(year) for year in sorted({requested_year, data_year}, reverse=True) if year)

    def admission_params(
        school: str,
        major: str,
        *,
        fuzzy_school: bool = False,
        include_major: bool = True,
        exact_batch: bool = True,
        years: str | None = None,
        limit: int = 18,
    ) -> dict[str, str]:
        params = {
            "select": "year,batch,subject_group,school_name,major_name,min_score,min_rank,source_url,confidence_level",
            "year": f"in.({years or years_filter})",
            "subject_group": f"eq.{subject}",
            "school_name": f"ilike.*{school}*" if fuzzy_school else f"eq.{school}",
            "order": "year.desc,min_rank.asc.nullslast,min_score.desc",
            "limit": str(limit),
        }
        if exact_batch:
            params["batch"] = f"eq.{batch}"
        elif "专科" in batch:
            params["batch"] = "ilike.*专科*"
        elif "本科" in batch:
            params["batch"] = "ilike.*本科*"
        if include_major and major:
            params["major_name"] = f"ilike.*{major}*"
        return params

    def safe_admission_get(params: dict[str, str], timeout: int = 5) -> list[dict[str, Any]]:
        try:
            return supabase_get("admission_line", params, timeout=timeout)
        except requests.HTTPError as exc:
            if is_statement_timeout(exc):
                return []
            raise
        except requests.RequestException:
            return []

    def optional_context_params(
        school: str,
        major: str,
        *,
        table: str,
        fuzzy_school: bool = False,
        include_major: bool = True,
        years: str,
        limit: int = 8,
    ) -> dict[str, str]:
        if table == "enrollment_plan":
            select = (
                "year,batch,subject_group,school_code,school_name,major_code,major_name,major_full_name,"
                "major_remark,level,selection_requirement,plan_count,duration,tuition,"
                "discipline_category,major_category,is_new_major,source_url,confidence_level"
            )
            order = "year.desc,plan_count.asc.nullslast"
        else:
            select = (
                "year,batch,subject_group,school_code,school_name,major_code,major_name,admission_count,"
                "min_score,min_rank,avg_score,avg_rank,max_score,max_rank,source_url,confidence_level"
            )
            order = "year.desc,min_rank.asc.nullslast,min_score.desc"
        params = {
            "select": select,
            "year": f"in.({years})",
            "subject_group": f"eq.{subject}",
            "school_name": f"ilike.*{school}*" if fuzzy_school else f"eq.{school}",
            "order": order,
            "limit": str(limit),
        }
        if batch:
            params["batch"] = f"eq.{batch}"
        if include_major and major:
            params["major_name"] = f"ilike.*{major}*"
        return params

    def safe_optional_context_get(table: str, params: dict[str, str], timeout: int = 4) -> list[dict[str, Any]]:
        return optional_supabase_get(table, params, timeout=timeout)

    def match_volunteer_admission(volunteer: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
        order_no = str(volunteer.get("orderNo") or "")
        school = clean_search_term(volunteer.get("matchSchoolName") or volunteer.get("schoolName"))
        school_candidates = school_query_candidates(volunteer.get("matchSchoolName") or volunteer.get("schoolName") or school)[:2]
        major = clean_search_term(volunteer.get("matchMajorName") or volunteer.get("majorName"))
        major_candidates = major_query_candidates(major)[:2]
        if not order_no or not school:
            return order_no, []

        rows: list[dict[str, Any]] = []
        for school_candidate in school_candidates:
            for major_candidate in major_candidates or [""]:
                rows = safe_admission_get(
                    admission_params(
                        school_candidate,
                        major_candidate,
                        fuzzy_school=True,
                        include_major=bool(major_candidate),
                        exact_batch=True,
                        limit=18,
                    ),
                    timeout=5,
                )
                if rows:
                    break
            if rows:
                break
        if not rows and major_candidates:
            for school_candidate in school_candidates:
                rows = safe_admission_get(
                    admission_params(school_candidate, major_candidates[0], fuzzy_school=True, include_major=False, limit=12),
                    timeout=4,
                )
                if rows:
                    break
        if not rows:
            preferred_major = major_candidates[0] if major_candidates else major
            for school_candidate in school_candidates:
                rows = safe_admission_get(
                    admission_params(
                        school_candidate,
                        preferred_major,
                        fuzzy_school=True,
                        include_major=bool(preferred_major),
                        exact_batch=False,
                        limit=10,
                    ),
                    timeout=4,
                )
                if rows:
                    break
        if not rows:
            preferred_major = major_candidates[0] if major_candidates else major
            for school_candidate in school_candidates:
                rows = safe_admission_get(
                    admission_params(
                        school_candidate,
                        preferred_major,
                        fuzzy_school=True,
                        include_major=bool(preferred_major),
                        exact_batch=False,
                        years=all_years_filter,
                        limit=12,
                    ),
                    timeout=3,
                )
                if rows:
                    break
        if not rows:
            preferred_major = major_candidates[0] if major_candidates else major
            for school_candidate in school_candidates:
                rows = safe_admission_get(
                    admission_params(
                        school_candidate,
                        preferred_major,
                        include_major=bool(preferred_major),
                        exact_batch=True,
                        years=all_years_filter,
                        limit=8,
                    ),
                    timeout=3,
                )
                if rows:
                    break
        return order_no, rows

    def match_volunteer_enrichment(volunteer: dict[str, Any]) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
        order_no = str(volunteer.get("orderNo") or "")
        school = clean_search_term(volunteer.get("matchSchoolName") or volunteer.get("schoolName"))
        school_candidates = school_query_candidates(volunteer.get("matchSchoolName") or volunteer.get("schoolName") or school)[:2]
        major = clean_search_term(volunteer.get("matchMajorName") or volunteer.get("majorName"))
        major_candidates = major_query_candidates(major)[:2]
        if not order_no or not school:
            return order_no, [], []

        plan_rows: list[dict[str, Any]] = []
        stat_rows: list[dict[str, Any]] = []

        for school_candidate in school_candidates:
            for major_candidate in major_candidates or [""]:
                plan_rows = safe_optional_context_get(
                    "enrollment_plan",
                    optional_context_params(
                        school_candidate,
                        major_candidate,
                        table="enrollment_plan",
                        fuzzy_school=True,
                        include_major=bool(major_candidate),
                        years=plan_years_filter,
                        limit=6,
                    ),
                    timeout=4,
                )
                if plan_rows:
                    break
            if plan_rows:
                break

        if not plan_rows and major_candidates:
            for school_candidate in school_candidates:
                plan_rows = safe_optional_context_get(
                    "enrollment_plan",
                    optional_context_params(
                        school_candidate,
                        major_candidates[0],
                        table="enrollment_plan",
                        fuzzy_school=True,
                        include_major=False,
                        years=plan_years_filter,
                        limit=6,
                    ),
                    timeout=4,
                )
                if plan_rows:
                    break

        for school_candidate in school_candidates:
            for major_candidate in major_candidates or [""]:
                stat_rows = safe_optional_context_get(
                    "major_admission_stats",
                    optional_context_params(
                        school_candidate,
                        major_candidate,
                        table="major_admission_stats",
                        fuzzy_school=True,
                        include_major=bool(major_candidate),
                        years=all_years_filter,
                        limit=10,
                    ),
                    timeout=4,
                )
                if stat_rows:
                    break
            if stat_rows:
                break

        return order_no, plan_rows, stat_rows

    with ThreadPoolExecutor(max_workers=min(10, max(1, len(volunteers[:96])))) as executor:
        futures = [executor.submit(match_volunteer_admission, volunteer) for volunteer in volunteers[:96]]
        for future in as_completed(futures):
            order_no, rows = future.result()
            if order_no:
                admission_matches[order_no] = enrich_rank_from_score(rows)
        enrichment_futures = [executor.submit(match_volunteer_enrichment, volunteer) for volunteer in volunteers[:96]]
        for future in as_completed(enrichment_futures):
            order_no, plan_rows, stat_rows = future.result()
            if order_no:
                enrollment_plan_matches[order_no] = plan_rows
                major_stat_matches[order_no] = stat_rows

    return {
        "requestedYear": requested_year,
        "dataYear": data_year,
        "availableYears": available_rows,
        "batchLines": batch_lines,
        "scoreRank": score_rank[0] if score_rank else None,
        "admissionMatches": admission_matches,
        "enrollmentPlanMatches": enrollment_plan_matches,
        "majorStatMatches": major_stat_matches,
    }


def compact_report_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = payload.get("formData") or {}
    summary = payload.get("summary") or {}
    diagnoses = payload.get("diagnoses") or []
    evidence_sources = [(item.get("ranks") or {}).get("source") for item in diagnoses]

    compact_summary = {
        "total": summary.get("total"),
        "volunteer_distribution_clue": {
            "extreme_rush": summary.get("extremeRush"),
            "rush": summary.get("rushOnly"),
            "small_rush": summary.get("smallRush"),
            "stable": summary.get("stable"),
            "safe": summary.get("safeOnly"),
            "cushion": summary.get("cushion"),
            "reference_range": summary.get("referenceRange"),
            "note": "该分布仅为粗略结构线索，不是要求用户机械照做的最终方案。",
        },
        "evidence_counts": {
            "public_data_count": evidence_sources.count("public-data"),
            "score_only_count": evidence_sources.count("score-only"),
            "estimated_count": evidence_sources.count("estimated"),
            "enrollment_plan_count": summary.get("planMatched"),
            "major_admission_stats_count": summary.get("statMatched"),
        },
        "risk_clues": {
            "selection_mismatch": summary.get("selectionMismatch"),
            "retreat_risk": summary.get("retreatRisk"),
            "high_fee_or_property_risk": summary.get("highFeeRisk"),
            "scarce_plan_or_new_major": (summary.get("planScarcity") or 0) + (summary.get("newMajor") or 0),
            "avg_rank_pressure": summary.get("avgRankPressureCount"),
            "need_review": summary.get("needReview"),
        },
    }

    compact_diagnoses = []
    for item in diagnoses[:96]:
        compact_diagnoses.append(
            {
                "order_no": item.get("orderNo"),
                "school_name": item.get("schoolName"),
                "major_name": item.get("majorName"),
                "batch": item.get("batch"),
                "volunteer_type": item.get("type"),
                "evidence_source": (item.get("ranks") or {}).get("source"),
                "match_count": (item.get("ranks") or {}).get("matchCount"),
                "flags": item.get("flags") or {},
                "reasons": item.get("reasons") or [],
                "evidence_preview": {
                    "rank_2023": (item.get("ranks") or {}).get("2023"),
                    "rank_2024": (item.get("ranks") or {}).get("2024"),
                    "rank_2025": (item.get("ranks") or {}).get("2025"),
                    "weighted_rank": (item.get("ranks") or {}).get("weightedRank"),
                },
                "enrollment_plan": item.get("planEvidence") or {},
                "major_admission_stats": item.get("majorStatEvidence") or {},
            }
        )

    return {
        "student": {
            "province": form.get("province", "河北"),
            "year": form.get("year"),
            "subject": form.get("subject"),
            "batch": form.get("batch"),
            "score": form.get("score"),
            "rank": form.get("rank"),
            "electives": form.get("electives"),
            "restriction": form.get("restriction"),
            "language": form.get("language"),
            "budget": form.get("budget"),
            "region_preference": form.get("regionPreference"),
            "family_target": form.get("familyTarget"),
            "accept_private": form.get("acceptPrivate"),
            "accept_coop": form.get("acceptCoop"),
            "accept_remote": form.get("acceptRemote"),
            "preferred_major": form.get("preferredMajor"),
            "avoid_major": form.get("avoidMajor"),
        },
        "summary": compact_summary,
        "evidence_audit": {
            "ai_rematch": payload.get("aiRematch") or {},
            "public_data_count": evidence_sources.count("public-data"),
            "score_only_count": evidence_sources.count("score-only"),
            "estimated_count": evidence_sources.count("estimated"),
            "enrollment_plan_count": sum(1 for item in diagnoses if item.get("planEvidence")),
            "major_admission_stats_count": sum(1 for item in diagnoses if item.get("majorStatEvidence")),
            "rule": "AI报告必须以该证据审计为边界；diagnoses只提供公开数据取证、风险线索和可疑点，不提供最终概率或去留结论；estimated只能给复核建议，不得写成已匹配投档数据。",
        },
        "diagnoses": compact_diagnoses,
    }


def build_messages(payload: dict[str, Any]) -> list[dict[str, str]]:
    compact = compact_report_payload(payload)
    return [
        {
            "role": "system",
            "content": (
                "你是河北省高考志愿风险体检报告助手。"
                "你理解河北新高考普通类志愿按“专业（类）+学校”为基本单位，最多96个志愿，"
                "平行志愿按分数优先、遵循志愿、一轮投档的逻辑运行。"
                "判断志愿风险时必须以全省位次和近年专业录取位次为核心，分数只用于批次线校验和一分一档换算，不得只凭分数高低下结论。"
                "你给出的调整建议必须围绕位次安全边际、近年波动、专业热度、选科/体检/语种/费用限制、地域偏好和家庭风险承受度综合判断。"
                "你可以使用常规冲稳保垫思路：冲刺区控制密度、稳妥区承担主体录取概率、保底和垫底区保证真实可执行性；"
                "但不得机械套用固定比例，必须结合输入数据解释为什么这样调整。"
                "专业偏好、地域偏好只作为家庭讨论参考，不能单独作为删除或替换依据；用户已经录入志愿表时，必须以志愿表的真实顺序和院校专业为准。"
                "只有批次线、选科/体检/语种等硬性限制、明确费用/项目证据、位次安全边际严重不足等证据，才可以给出删除或强替换建议。"
                "你只能依据输入的结构化数据生成解释，不得虚构学校、专业、分数、位次、招生计划或来源。"
                "如果输入中包含 enrollment_plan，必须把计划人数、选科要求、学费、学制、新增专业等作为可报性和波动风险证据。"
                "判断高收费或中外合作风险时，必须优先使用 tuition、major_remark、level、projectText、isCooperationOrHighFee 等证据；"
                "不得仅凭专业名称中的软件、国际、合作等词直接认定为高收费，只能写为待核实线索。"
                "如果输入中包含 major_admission_stats，必须把最低位次、平均位次、最高位次和录取人数用于判断专业热度与稳定性。"
                "如果这些增强资料为空，必须写明未命中公开计划/专业统计，不得自行补造。"
                "输入中的 diagnoses 是公开数据取证和风险线索，不是最终结论；"
                "每条志愿的录取概率区间、合理性判断和保留/下移/替换/删除建议必须由你基于证据独立生成。"
                "不得使用“保证录取”“一定录取”“绝对安全”等表述。"
                "如果某条没有匹配到足够公开投档记录，必须说明已降级为结构判断，建议核验官方招生计划、院校章程、近年投档线和专业组选科要求。"
                "输入中的 evidence_audit 是完整报告生成前重新匹配后的证据审计结果，必须在总评中说明直接命中、分数记录和需复核的大致情况。"
                "报告不能全是文字，必须使用Markdown表格和短段落组合，便于家长阅读。"
                "必须至少包含以下表格：1考生基本信息表，2志愿结构统计表，3风险统计表，4优先修改清单表，5逐条诊断摘要表。"
                "逐条诊断摘要表必须覆盖输入中的全部志愿，每一行都要包含录取概率区间、合理性判断和去留建议。"
                "表格之外每节最多写2个短段落，语言要像顾问解释给家长听。"
                "报告格式使用：总评、志愿结构评估、风险统计、优先修改清单、逐条诊断摘要、需要补充的志愿、提交前提醒。"
            ),
        },
        {
            "role": "user",
            "content": (
                "请根据下面授权码验证后重新匹配的公开数据、招生计划、专业统计和风险线索，生成一份面向家长的河北志愿表风险体检报告。"
                "逐条诊断摘要必须展示全部志愿，不能只展示前几条；如果志愿较多，逐条表格每条一行即可。"
                "需要明确输出每条志愿的录取概率区间、合理性判断，并明确四类动作：保留、下移、替换、删除。"
                "冲稳保垫参考分布只作为参照，不要强迫用户机械按模板调整；请根据当前真实分布动态判断是否合理。"
                "专业偏好和地域偏好只用于提醒家长沟通，不得只因为不匹配偏好就建议删除；用户志愿表中的学校和专业优先代表用户真实意向。"
                "必须保留证据字段，不能把演示数据包装成官方数据。\n\n"
                f"{json.dumps(compact, ensure_ascii=False, indent=2)}"
            ),
        },
    ]


def build_preview_messages(payload: dict[str, Any]) -> list[dict[str, str]]:
    compact = compact_report_payload(payload)
    return [
        {
            "role": "system",
            "content": (
                "你是河北高考志愿风险初步复核助手。"
                "你的任务是在完整报告前，对系统已经匹配的公开数据和逐条规则诊断做一次面向家长的短复核。"
                "冲稳保垫分布只能作为参考，不能要求用户机械照做。"
                "专业偏好、地域偏好只作为提醒，不得单独作为删除或替换依据。"
                "每条概率区间和去留建议必须由AI根据证据独立判断，且不得使用保证录取、一定录取、绝对安全等表述。"
                "不要虚构学校、专业、分数、位次、招生计划或来源。"
                "输出Markdown，控制在600字以内，必须包含一个3到6行表格。"
            ),
        },
        {
            "role": "user",
            "content": (
                "请输出四部分：1 AI复核结论；2 当前志愿分布是否合理；3 重点风险窗口表格；4 家长下一步操作。"
                "重点风险窗口表格优先列出概率偏低、需替换/删除、证据不足、选科或费用风险的志愿。"
                "如果有96条志愿，不需要逐条展开，只需要指出结构风险；完整报告阶段再覆盖全部志愿。\n\n"
                f"{json.dumps(compact, ensure_ascii=False, indent=2)}"
            ),
        },
    ]


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "TingNiShuoAiServer/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "no-store, max-age=0, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self) -> Any:
        if not self.path.startswith("/api/"):
            for header in ("If-Modified-Since", "If-None-Match"):
                if header in self.headers:
                    del self.headers[header]
        return super().send_head()

    def client_ip(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return self.client_address[0] if self.client_address else ""

    def user_agent(self) -> str:
        return self.headers.get("User-Agent", "")

    def request_fingerprint(self) -> str:
        raw = f"{self.client_ip()}|{self.user_agent()}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def read_json_payload(self, max_size: int = 1024 * 1024) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > max_size:
            raise ValueError("payload too large")
        payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self.write_json(
                {
                    "ok": True,
                    "ai_report_ready": bool(os.environ.get("DEEPSEEK_API_KEY")),
                    "public_data_ready": bool(os.environ.get("SUPABASE_ANON_KEY")),
                    "license_service_ready": bool(
                        os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
                    ),
                    "license_hash_ready": bool(os.environ.get("LICENSE_HASH_SECRET")),
                    "license_admin_ready": bool(os.environ.get("LICENSE_ADMIN_TOKEN")),
                }
            )
            return
        request_path = self.path.split("?", 1)[0]
        if request_path in {"/license-admin", "/license-admin/"}:
            self.path = "/index.html"
            super().do_GET()
            return
        if self.path == "/api/data/overview":
            try:
                years = supabase_get(
                    "available_data_years",
                    {
                        "select": "year,admission_line_count,score_rank_count,batch_line_count",
                        "order": "year.desc",
                    },
                )
                latest = years[0] if years else {}
                self.write_json(
                    {
                        "ok": True,
                        "latest": latest,
                        "years": years,
                    }
                )
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return
        super().do_GET()

    def do_POST(self) -> None:
        if self.path == "/api/license/verify":
            try:
                payload = self.read_json_payload(max_size=64 * 1024)
                row = verify_license_code(payload.get("licenseCode"))
                try:
                    insert_license_event(
                        row,
                        event_type="verify",
                        uses_delta=0,
                        request_fingerprint=self.request_fingerprint(),
                        client_ip=self.client_ip(),
                        user_agent=self.user_agent(),
                        metadata={"source": "manual_verify"},
                    )
                except Exception:
                    pass
                self.write_json({"ok": True, "license": public_license_state(row)})
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except PermissionError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
            except RuntimeError:
                self.write_json({"ok": False, "error": "授权码系统未完成配置，请联系顾问处理。"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            except requests.HTTPError as exc:
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json(
                    {"ok": False, "error": "授权码数据库未初始化或暂不可用。", "detail": detail},
                    status=HTTPStatus.BAD_GATEWAY,
                )
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path == "/api/admin/dashboard":
            try:
                payload = self.read_json_payload(max_size=64 * 1024)
                self.write_json(build_admin_dashboard(payload))
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except PermissionError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
            except RuntimeError:
                self.write_json({"ok": False, "error": "运营后台暂未完成配置，请检查服务密钥。"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            except requests.HTTPError as exc:
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json({"ok": False, "error": "运营后台数据读取失败。", "detail": detail}, status=HTTPStatus.BAD_GATEWAY)
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path == "/api/admin/license/status":
            try:
                payload = self.read_json_payload(max_size=64 * 1024)
                self.write_json(update_license_status(payload))
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except PermissionError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
            except RuntimeError:
                self.write_json({"ok": False, "error": "运营后台暂未完成配置，请检查服务密钥。"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            except requests.HTTPError as exc:
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json({"ok": False, "error": "授权码状态更新失败。", "detail": detail}, status=HTTPStatus.BAD_GATEWAY)
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path == "/api/admin/license/create":
            try:
                payload = self.read_json_payload(max_size=64 * 1024)
                licenses = create_license_codes(payload)
                self.write_json({"ok": True, "licenses": licenses})
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except PermissionError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
            except RuntimeError:
                self.write_json({"ok": False, "error": "内部发码系统未完成配置。"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            except requests.HTTPError as exc:
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json(
                    {"ok": False, "error": "授权码数据库写入失败。", "detail": detail},
                    status=HTTPStatus.BAD_GATEWAY,
                )
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path == "/api/checkup":
            try:
                payload = self.read_json_payload()
                form_data = payload.get("formData") if isinstance(payload.get("formData"), dict) else {}
                license_code = payload.get("licenseCode") or form_data.get("licenseCode")
                if not license_code:
                    self.write_json(
                        {"ok": False, "licenseRequired": True, "error": "请先输入并验证授权码，再生成志愿风险评估。"},
                        status=HTTPStatus.PAYMENT_REQUIRED,
                    )
                    return
                license_row = verify_license_code(license_code)
                context = fetch_data_context(payload)
                self.write_json({"ok": True, "context": context, "license": public_license_state(license_row)})
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            except PermissionError as exc:
                self.write_json({"ok": False, "licenseRequired": True, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
            except RuntimeError:
                self.write_json({"ok": False, "error": "授权码系统未完成配置，请联系顾问处理。"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            except requests.HTTPError as exc:
                status = HTTPStatus.BAD_GATEWAY
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json({"ok": False, "error": "公开数据匹配失败。", "detail": detail}, status=status)
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path == "/api/ai-checkup":
            try:
                payload = self.read_json_payload()
            except Exception as exc:
                self.write_json({"ok": False, "error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
                return

            form_data = payload.get("formData") if isinstance(payload.get("formData"), dict) else {}
            license_code = payload.get("licenseCode") or form_data.get("licenseCode")
            if not license_code:
                self.write_json(
                    {"ok": False, "licenseRequired": True, "error": "请先输入并验证授权码，再进行AI复核。"},
                    status=HTTPStatus.PAYMENT_REQUIRED,
                )
                return

            try:
                license_row = verify_license_code(license_code)
                api_key, model = get_deepseek_config()
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
            except PermissionError as exc:
                self.write_json({"ok": False, "licenseRequired": True, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
                return
            except RuntimeError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.SERVICE_UNAVAILABLE)
                return
            except requests.HTTPError as exc:
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json(
                    {"ok": False, "error": "授权码系统暂不可用，请联系顾问处理。", "detail": detail},
                    status=HTTPStatus.BAD_GATEWAY,
                )
                return

            body = {
                "model": model,
                "messages": build_preview_messages(payload),
                "thinking": {"type": os.environ.get("DEEPSEEK_THINKING", "enabled")},
                "reasoning_effort": os.environ.get("DEEPSEEK_REASONING_EFFORT", "medium"),
                "temperature": 0.2,
                "max_tokens": 1800,
                "stream": False,
            }

            try:
                response = requests.post(
                    deepseek_chat_url(),
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                    timeout=90,
                )
                response.raise_for_status()
                data = response.json()
                choices = data.get("choices") or []
                content = (choices[0].get("message") or {}).get("content") if choices else ""
                if not content:
                    raise RuntimeError("AI复核未返回有效内容。")
                self.write_json(
                    {
                        "ok": True,
                        "model": data.get("model", model),
                        "content": content,
                        "usage": data.get("usage"),
                        "license": public_license_state(license_row),
                    }
                )
            except requests.HTTPError as exc:
                status = exc.response.status_code if exc.response is not None else HTTPStatus.BAD_GATEWAY
                try:
                    detail = exc.response.json()
                except Exception:
                    detail = exc.response.text[:500] if exc.response is not None else str(exc)
                self.write_json({"ok": False, "error": "AI复核暂不可用，请稍后重试。", "detail": detail}, status=status)
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path != "/api/ai-report":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        try:
            payload = self.read_json_payload()
        except Exception as exc:
            self.write_json({"ok": False, "error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        license_code = payload.get("licenseCode") or (payload.get("license") or {}).get("code")
        if not license_code:
            self.write_json(
                {"ok": False, "licenseRequired": True, "error": "请输入购买后获得的授权码，再生成完整报告。"},
                status=HTTPStatus.PAYMENT_REQUIRED,
            )
            return

        license_metadata = {
            "diagnosis_count": len(payload.get("diagnoses") or []),
            "score": (payload.get("formData") or {}).get("score"),
            "rank": (payload.get("formData") or {}).get("rank"),
            "subject": (payload.get("formData") or {}).get("subject"),
            "batch": (payload.get("formData") or {}).get("batch"),
        }

        try:
            checked_license_row = verify_license_code(license_code)
            if is_unlimited_license(checked_license_row):
                daily_limit = int(checked_license_row.get("max_uses_per_day") or 20)
                if daily_limit > 0 and count_license_events_today(str(checked_license_row["id"])) >= daily_limit:
                    raise PermissionError("授权码今日生成次数已达上限，请明天再试或联系顾问。")
        except ValueError as exc:
            self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
            return
        except PermissionError as exc:
            self.write_json({"ok": False, "licenseRequired": True, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
            return
        except RuntimeError:
            self.write_json({"ok": False, "error": "授权码系统未完成配置，请联系顾问处理。"}, status=HTTPStatus.SERVICE_UNAVAILABLE)
            return
        except requests.HTTPError as exc:
            detail: Any = str(exc)
            if exc.response is not None:
                try:
                    detail = exc.response.json()
                except Exception:
                    detail = exc.response.text[:500]
            self.write_json(
                {"ok": False, "error": "授权码系统暂不可用，请联系顾问处理。", "detail": detail},
                status=HTTPStatus.BAD_GATEWAY,
            )
            return
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        try:
            api_key, model = get_deepseek_config()
        except Exception as exc:
            self.write_json(
                {
                    "ok": False,
                    "error": str(exc),
                },
                status=HTTPStatus.SERVICE_UNAVAILABLE,
            )
            return

        body = {
            "model": model,
            "messages": build_messages(payload),
            "thinking": {"type": os.environ.get("DEEPSEEK_THINKING", "enabled")},
            "reasoning_effort": os.environ.get("DEEPSEEK_REASONING_EFFORT", "high"),
            "temperature": 0.2,
            "max_tokens": 8200,
            "stream": False,
        }

        try:
            response = requests.post(
                deepseek_chat_url(),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=90,
            )
            response.raise_for_status()
            data = response.json()
            choices = data.get("choices") or []
            content = (choices[0].get("message") or {}).get("content") if choices else ""
            if not content:
                raise RuntimeError("AI报告未返回有效内容。")
            try:
                license_row = consume_license_code(
                    license_code,
                    request_fingerprint=self.request_fingerprint(),
                    client_ip=self.client_ip(),
                    user_agent=self.user_agent(),
                    metadata=license_metadata,
                )
            except ValueError as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
            except PermissionError as exc:
                self.write_json({"ok": False, "licenseRequired": True, "error": str(exc)}, status=HTTPStatus.FORBIDDEN)
                return
            except RuntimeError:
                self.write_json(
                    {"ok": False, "error": "授权码系统未完成配置，完整报告未扣次，请联系顾问处理。"},
                    status=HTTPStatus.SERVICE_UNAVAILABLE,
                )
                return
            except requests.HTTPError as exc:
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json(
                    {"ok": False, "error": "授权码系统暂不可用，完整报告未扣次，请联系顾问处理。", "detail": detail},
                    status=HTTPStatus.BAD_GATEWAY,
                )
                return
            except Exception as exc:
                self.write_json(
                    {"ok": False, "error": f"授权码扣次失败，完整报告未扣次：{exc}"},
                    status=HTTPStatus.BAD_GATEWAY,
                )
                return
            self.write_json(
                {
                    "ok": True,
                    "model": data.get("model", model),
                    "content": content,
                    "usage": data.get("usage"),
                    "license": public_license_state(license_row),
                }
            )
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else HTTPStatus.BAD_GATEWAY
            try:
                detail = exc.response.json()
            except Exception:
                detail = exc.response.text[:500] if exc.response is not None else str(exc)
            self.write_json({"ok": False, "error": "AI报告生成暂不可用，请稍后重试或联系顾问。", "detail": detail}, status=status)
        except Exception as exc:
            self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)

    def write_json(self, data: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


load_dotenv(ROOT / ".env")


class handler(AppHandler):
    pass


def main() -> None:
    port = int(os.environ.get("PORT", "4174"))
    host = os.environ.get("HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), AppHandler)
    print(f"Serving {ROOT} at http://{host}:{port}/")
    print(f"AI report model configured: {bool(os.environ.get('DEEPSEEK_MODEL', DEFAULT_MODEL))}")
    print(f"AI report key configured: {bool(os.environ.get('DEEPSEEK_API_KEY'))}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
