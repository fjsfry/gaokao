#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Static site server plus DeepSeek API proxy and public data lookup.

The browser never receives the DeepSeek API key. Frontend code posts the
structured diagnosis result to /api/ai-report, and this server calls DeepSeek.
"""

from __future__ import annotations

import json
import os
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
    # Kept for compatibility with older deployments. DeepSeek has announced
    # these legacy names will be retired after 2026-07-24.
    "deepseek-chat",
    "deepseek-reasoner",
}
PUBLIC_TABLES = {
    "admission_line",
    "available_data_years",
    "batch_line",
    "score_rank_table",
    "school_admission_summary",
}
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
    text = text.replace("[公办]", "").replace("[民办]", "").replace("[独立学院]", "")
    for char in "%*_()[]{}":
        text = text.replace(char, "")
    return text[:max_len]


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
    year_floor = max(2021, data_year - 2)
    years_filter = ",".join(str(year) for year in range(year_floor, data_year + 1))

    def admission_params(
        school: str,
        major: str,
        *,
        fuzzy_school: bool = False,
        include_major: bool = True,
        exact_batch: bool = True,
        limit: int = 18,
    ) -> dict[str, str]:
        params = {
            "select": "year,batch,subject_group,school_name,major_name,min_score,min_rank,source_url,confidence_level",
            "year": f"in.({years_filter})",
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

    def safe_admission_get(params: dict[str, str]) -> list[dict[str, Any]]:
        try:
            return supabase_get("admission_line", params, timeout=8)
        except requests.HTTPError as exc:
            if is_statement_timeout(exc):
                return []
            raise
        except requests.RequestException:
            return []

    for volunteer in volunteers[:96]:
        order_no = str(volunteer.get("orderNo") or "")
        school = clean_search_term(volunteer.get("schoolName"))
        major = clean_search_term(volunteer.get("majorName"))
        if not order_no or not school:
            continue

        rows = safe_admission_get(
            admission_params(school, major, fuzzy_school=True, include_major=bool(major), exact_batch=True, limit=18)
        )
        if not rows and major:
            rows = safe_admission_get(admission_params(school, major, fuzzy_school=True, include_major=False, limit=12))
        if not rows:
            rows = safe_admission_get(
                admission_params(school, major, fuzzy_school=True, include_major=bool(major), exact_batch=False, limit=10)
            )
        if not rows:
            rows = safe_admission_get(admission_params(school, major, include_major=bool(major), exact_batch=True, limit=8))
        admission_matches[order_no] = enrich_rank_from_score(rows)

    return {
        "requestedYear": requested_year,
        "dataYear": data_year,
        "availableYears": available_rows,
        "batchLines": batch_lines,
        "scoreRank": score_rank[0] if score_rank else None,
        "admissionMatches": admission_matches,
    }


def compact_report_payload(payload: dict[str, Any]) -> dict[str, Any]:
    form = payload.get("formData") or {}
    summary = payload.get("summary") or {}
    diagnoses = payload.get("diagnoses") or []

    compact_diagnoses = []
    for item in diagnoses[:96]:
        compact_diagnoses.append(
            {
                "order_no": item.get("orderNo"),
                "school_name": item.get("schoolName"),
                "major_name": item.get("majorName"),
                "batch": item.get("batch"),
                "risk_level": (item.get("risk") or {}).get("label"),
                "volunteer_type": item.get("type"),
                "action": item.get("action"),
                "score": item.get("score"),
                "reasons": item.get("reasons") or [],
                "evidence_preview": {
                    "rank_2023": (item.get("ranks") or {}).get("2023"),
                    "rank_2024": (item.get("ranks") or {}).get("2024"),
                    "rank_2025": (item.get("ranks") or {}).get("2025"),
                    "weighted_rank": (item.get("ranks") or {}).get("weightedRank"),
                },
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
            "preferred_major": form.get("preferredMajor"),
            "avoid_major": form.get("avoidMajor"),
        },
        "summary": summary,
        "diagnoses": compact_diagnoses,
    }


def build_messages(payload: dict[str, Any]) -> list[dict[str, str]]:
    compact = compact_report_payload(payload)
    return [
        {
            "role": "system",
            "content": (
                "你是河北省高考志愿风险体检报告助手。"
                "你只能依据输入的结构化数据生成解释，不得虚构学校、专业、分数、位次、招生计划或来源。"
                "不得使用“保证录取”“一定录取”“绝对安全”等表述。"
                "如果数据只是演示或证据不足，必须明确提示“数据不足，建议人工复核”。"
                "报告格式使用：总评、主要问题、逐条意见、优先修改清单、提交前提醒。"
            ),
        },
        {
            "role": "user",
            "content": (
                "请根据下面的规则引擎结果，生成一份面向家长的河北志愿表风险体检报告。"
                "逐条意见最多展示前8条，高风险和建议替换/删除项优先。"
                "必须保留证据字段，不能把演示数据包装成官方数据。\n\n"
                f"{json.dumps(compact, ensure_ascii=False, indent=2)}"
            ),
        },
    ]


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "TingNiShuoDeepSeekServer/1.0"

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

    def do_GET(self) -> None:
        if self.path == "/api/health":
            self.write_json(
                {
                    "ok": True,
                    "model": os.environ.get("DEEPSEEK_MODEL", DEFAULT_MODEL),
                    "deepseek_base_url": os.environ.get("DEEPSEEK_BASE_URL", DEFAULT_DEEPSEEK_BASE_URL),
                    "has_api_key": bool(os.environ.get("DEEPSEEK_API_KEY")),
                    "has_public_data_key": bool(os.environ.get("SUPABASE_ANON_KEY")),
                }
            )
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
        if self.path == "/api/checkup":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length > 1024 * 1024:
                    raise ValueError("payload too large")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                context = fetch_data_context(payload)
                self.write_json({"ok": True, "context": context})
            except requests.HTTPError as exc:
                status = HTTPStatus.BAD_GATEWAY
                detail: Any = str(exc)
                if exc.response is not None:
                    try:
                        detail = exc.response.json()
                    except Exception:
                        detail = exc.response.text[:500]
                self.write_json({"ok": False, "error": "Public data lookup failed.", "detail": detail}, status=status)
            except Exception as exc:
                self.write_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_GATEWAY)
            return

        if self.path != "/api/ai-report":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
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

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 1024 * 1024:
                raise ValueError("payload too large")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as exc:
            self.write_json({"ok": False, "error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        body = {
            "model": model,
            "messages": build_messages(payload),
            "thinking": {"type": os.environ.get("DEEPSEEK_THINKING", "enabled")},
            "reasoning_effort": os.environ.get("DEEPSEEK_REASONING_EFFORT", "high"),
            "temperature": 0.2,
            "max_tokens": 2600,
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
                raise RuntimeError("DeepSeek response did not include report content.")
            self.write_json(
                {
                    "ok": True,
                    "model": data.get("model", model),
                    "content": content,
                    "usage": data.get("usage"),
                }
            )
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else HTTPStatus.BAD_GATEWAY
            try:
                detail = exc.response.json()
            except Exception:
                detail = exc.response.text[:500] if exc.response is not None else str(exc)
            self.write_json({"ok": False, "error": "DeepSeek API request failed.", "detail": detail}, status=status)
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
    print(f"DeepSeek model: {os.environ.get('DEEPSEEK_MODEL', DEFAULT_MODEL)}")
    print(f"DeepSeek key configured: {bool(os.environ.get('DEEPSEEK_API_KEY'))}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
