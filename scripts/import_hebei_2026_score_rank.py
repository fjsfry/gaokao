from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
import urllib.parse
from datetime import datetime
from pathlib import Path
from typing import Any

import fitz
import numpy as np
import requests
from rapidocr_onnxruntime import RapidOCR


YEAR = 2026
PROVINCE = "\u6cb3\u5317"
PHYSICS = "\u7269\u7406\u79d1\u76ee\u7ec4\u5408"
HISTORY = "\u5386\u53f2\u79d1\u76ee\u7ec4\u5408"
BACHELOR = "\u672c\u79d1\u6279"
JUNIOR = "\u4e13\u79d1\u6279"
SPECIAL = "\u7279\u6b8a\u7c7b\u578b\u62db\u751f\u63a7\u5236\u7ebf"
PDF_URL = "https://file.hebeea.edu.cn/upload/resources/file/2026/06/24/27144.pdf"
SCORE_PAGE_URL = "https://www.hebeea.edu.cn/c/2026-06-24/493215.html"
CONTROL_LINE_SOURCE_URL = "https://www.hebeea.edu.cn/c/2026-06-24/493121.html"
SCORE_SOURCE_TITLE = (
    "\u4e8c\u3001\u202f2026\u5e74\u6cb3\u5317\u7701\u666e\u901a\u9ad8\u6821\u62db\u751f"
    "\u7269\u7406\u79d1\u76ee\u7ec4\u5408\u3001\u5386\u53f2\u79d1\u76ee\u7ec4\u5408"
    "\u8003\u751f\u6210\u7ee9\u7edf\u8ba1\u8868"
)

CONTROL_LINES = [
    (PHYSICS, BACHELOR, 443),
    (PHYSICS, SPECIAL, 510),
    (PHYSICS, JUNIOR, 200),
    (HISTORY, BACHELOR, 485),
    (HISTORY, SPECIAL, 542),
    (HISTORY, JUNIOR, 200),
]


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8-sig")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"").strip("'"))


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def int_from_ocr(value: Any) -> int | None:
    text = (
        clean_text(value)
        .replace("O", "0")
        .replace("o", "0")
        .replace("I", "1")
        .replace("l", "1")
        .replace(",", "")
    )
    match = re.search(r"\d+", text)
    return int(match.group(0)) if match else None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_pdf(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    target = cache_dir / "hebei_2026_score_rank_normal.pdf"
    if target.exists() and target.stat().st_size > 100_000:
        return target
    response = requests.get(PDF_URL, timeout=60, headers={"User-Agent": "Mozilla/5.0"})
    response.raise_for_status()
    target.write_bytes(response.content)
    return target


def ocr_pdf(pdf_path: Path, cache_dir: Path, refresh: bool = False) -> list[dict[str, Any]]:
    cache_path = cache_dir / "ocr_blocks_27144.json"
    if cache_path.exists() and not refresh:
        return json.loads(cache_path.read_text(encoding="utf-8"))

    ocr = RapidOCR()
    pages: list[dict[str, Any]] = []
    document = fitz.open(pdf_path)
    for idx, page in enumerate(document, start=1):
        print(f"ocr page {idx}/{document.page_count}", flush=True)
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        result, _ = ocr(image)
        blocks = []
        for item in result or []:
            box, text, score = item[:3]
            try:
                confidence = float(score)
            except Exception:
                confidence = 0.0
            blocks.append([box, clean_text(text), confidence])
        pages.append({"page": idx, "blocks": blocks})
    cache_path.write_text(json.dumps(pages, ensure_ascii=False), encoding="utf-8")
    return pages


def group_ocr_lines(blocks: list[Any], y_tolerance: float = 18) -> list[tuple[float, list[tuple[float, str]]]]:
    items: list[tuple[float, float, str]] = []
    for box, text, _confidence in blocks:
        xs = [point[0] for point in box]
        ys = [point[1] for point in box]
        items.append((float(min(ys)), float(min(xs)), clean_text(text)))
    items.sort()
    lines: list[list[Any]] = []
    for y, x, text in items:
        if not text:
            continue
        if not lines or abs(y - lines[-1][0]) > y_tolerance:
            lines.append([y, [(x, text)]])
        else:
            lines[-1][1].append((x, text))
    return [(float(y), sorted(parts)) for y, parts in lines]


def pick_int(parts: list[tuple[float, str]], left: float, right: float) -> int | None:
    for x, text in parts:
        if left <= x < right:
            value = int_from_ocr(text)
            if value is not None:
                return value
    return None


def parse_score_rank_rows(pages: list[dict[str, Any]]) -> dict[str, dict[int, dict[str, int]]]:
    parsed: dict[str, dict[int, dict[str, int]]] = {PHYSICS: {}, HISTORY: {}}
    for page in pages:
        for y, parts in group_ocr_lines(page["blocks"]):
            if y < 280:
                continue
            score = pick_int(parts, 90, 280)
            if score is None or score < 0 or score > 750:
                continue
            physics_same = pick_int(parts, 300, 540)
            physics_cum = pick_int(parts, 540, 740)
            history_same = pick_int(parts, 740, 930)
            history_cum = pick_int(parts, 930, 1120)
            if physics_cum is not None:
                parsed[PHYSICS][score] = {"same": physics_same or 0, "cum": physics_cum, "page": int(page["page"])}
            if history_cum is not None:
                parsed[HISTORY][score] = {"same": history_same or 0, "cum": history_cum, "page": int(page["page"])}

    for subject, rows in parsed.items():
        previous_cumulative = 0
        for score in sorted(rows.keys(), reverse=True):
            cumulative = rows[score]["cum"]
            if cumulative < previous_cumulative:
                raise ValueError(f"{subject} score {score} cumulative rank decreased: {cumulative} < {previous_cumulative}")
            if rows[score]["same"] <= 0:
                rows[score]["same"] = cumulative - previous_cumulative
            previous_cumulative = cumulative
    return parsed


def validate_score_rank_rows(rows: dict[str, dict[int, dict[str, int]]]) -> None:
    expectations = {
        PHYSICS: (700, 550),
        HISTORY: (650, 520),
    }
    for subject, (expected_top, min_count) in expectations.items():
        scores = sorted(rows[subject].keys(), reverse=True)
        if len(scores) < min_count:
            raise ValueError(f"{subject} has only {len(scores)} score rows")
        if scores[0] < expected_top:
            raise ValueError(f"{subject} highest score row looks too low: {scores[0]}")
        gaps = [(a, b) for a, b in zip(scores, scores[1:]) if a - b != 1]
        if gaps:
            raise ValueError(f"{subject} score rows are not continuous: {gaps[:5]}")
        for score, item in rows[subject].items():
            if item["same"] < 0 or item["cum"] <= 0:
                raise ValueError(f"{subject} score {score} has invalid values: {item}")


def build_score_payload(rows: dict[str, dict[int, dict[str, int]]], pdf_path: Path) -> list[dict[str, Any]]:
    imported_at = datetime.now().isoformat(timespec="seconds")
    payload: list[dict[str, Any]] = []
    for subject, by_score in rows.items():
        for score, item in by_score.items():
            row_id = hashlib.sha256(f"{YEAR}|{subject}|{score}|{PDF_URL}".encode("utf-8")).hexdigest()
            payload.append(
                {
                    "id": row_id,
                    "year": YEAR,
                    "province": PROVINCE,
                    "subject_group": subject,
                    "score": score,
                    "same_score_count": int(item["same"]),
                    "cumulative_rank": int(item["cum"]),
                    "source_url": PDF_URL,
                    "source_file": str(pdf_path),
                    "imported_at": imported_at,
                }
            )
    return sorted(payload, key=lambda row: (row["subject_group"], -int(row["score"])))


def build_batch_payload() -> list[dict[str, Any]]:
    imported_at = datetime.now().isoformat(timespec="seconds")
    payload = []
    for subject, batch, score in CONTROL_LINES:
        row_id = hashlib.sha256(f"{YEAR}|{subject}|{batch}|official_control_line".encode("utf-8")).hexdigest()
        payload.append(
            {
                "id": row_id,
                "year": YEAR,
                "province": PROVINCE,
                "subject_group": subject,
                "batch": batch,
                "control_score": score,
                "source_url": CONTROL_LINE_SOURCE_URL,
                "source_file": "official_2026_control_line",
                "imported_at": imported_at,
            }
        )
    return payload


def build_source_payload(pdf_path: Path) -> dict[str, Any]:
    imported_at = datetime.now().isoformat(timespec="seconds")
    digest = sha256_file(pdf_path)
    return {
        "file_sha256": digest,
        "file_url": PDF_URL,
        "filename": pdf_path.name,
        "extension": ".pdf",
        "local_path": str(pdf_path),
        "link_text": SCORE_SOURCE_TITLE,
        "article_title": SCORE_SOURCE_TITLE,
        "article_url": SCORE_PAGE_URL,
        "year": YEAR,
        "data_category": "score_rank_table",
        "size_bytes": pdf_path.stat().st_size,
        "crawled_at": imported_at,
    }


def supabase_headers(service_key: str, prefer: str = "return=minimal") -> dict[str, str]:
    return {
        "apikey": service_key,
        "authorization": f"Bearer {service_key}",
        "content-type": "application/json",
        "prefer": prefer,
    }


def supabase_url(base_url: str, table: str, query: str = "") -> str:
    suffix = f"/rest/v1/{urllib.parse.quote(table)}"
    return base_url.rstrip("/") + suffix + query


def delete_year(base_url: str, service_key: str, table: str) -> None:
    response = requests.delete(
        supabase_url(base_url, table, f"?year=eq.{YEAR}"),
        headers=supabase_headers(service_key),
        timeout=60,
    )
    response.raise_for_status()


def upsert_rows(base_url: str, service_key: str, table: str, rows: list[dict[str, Any]], key: str, chunk_size: int = 500) -> None:
    for start in range(0, len(rows), chunk_size):
        chunk = rows[start : start + chunk_size]
        response = requests.post(
            supabase_url(base_url, table, f"?on_conflict={urllib.parse.quote(key)}"),
            headers=supabase_headers(service_key, "resolution=merge-duplicates,return=minimal"),
            data=json.dumps(chunk, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            timeout=90,
        )
        response.raise_for_status()
        print(f"{table}: {min(start + len(chunk), len(rows))}/{len(rows)}", flush=True)


def upsert_one(base_url: str, service_key: str, table: str, row: dict[str, Any], key: str) -> None:
    upsert_rows(base_url, service_key, table, [row], key, chunk_size=1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Import Hebei 2026 official score-rank and control-line data.")
    parser.add_argument("--cache-dir", type=Path, default=Path("data_2026_official"))
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--refresh-ocr", action="store_true")
    parser.add_argument("--no-replace-year", action="store_true")
    args = parser.parse_args()

    load_env_file(args.env_file)
    pdf_path = download_pdf(args.cache_dir)
    pages = ocr_pdf(pdf_path, args.cache_dir, refresh=args.refresh_ocr)
    parsed = parse_score_rank_rows(pages)
    validate_score_rank_rows(parsed)
    score_rows = build_score_payload(parsed, pdf_path)
    batch_rows = build_batch_payload()
    source_row = build_source_payload(pdf_path)

    summary = {
        "year": YEAR,
        "score_rank_rows": len(score_rows),
        "batch_line_rows": len(batch_rows),
        "subjects": {
            subject: {
                "rows": len(rows),
                "max_score": max(rows),
                "min_score": min(rows),
                "total_cumulative_rank": rows[min(rows)]["cum"],
            }
            for subject, rows in parsed.items()
        },
        "source_url": PDF_URL,
        "score_page_url": SCORE_PAGE_URL,
        "control_line_source_url": CONTROL_LINE_SOURCE_URL,
        "source_sha256": source_row["file_sha256"],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    if args.dry_run:
        return

    supabase_base = os.environ.get("SUPABASE_URL", "").strip()
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not supabase_base or not service_key:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless --dry-run is used.")

    if not args.no_replace_year:
        delete_year(supabase_base, service_key, "score_rank_table")
        delete_year(supabase_base, service_key, "batch_line")
    upsert_rows(supabase_base, service_key, "score_rank_table", score_rows, "id")
    upsert_rows(supabase_base, service_key, "batch_line", batch_rows, "id")
    upsert_one(supabase_base, service_key, "source_files", source_row, "file_sha256")
    upsert_one(
        supabase_base,
        service_key,
        "build_summary",
        {
            "key": f"hebei_{YEAR}_official_score_rank_import",
            "value": json.dumps(summary, ensure_ascii=False, separators=(",", ":")),
        },
        "key",
    )

    time.sleep(0.5)
    print("import complete", flush=True)


if __name__ == "__main__":
    main()
