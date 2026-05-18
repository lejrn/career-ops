#!/usr/bin/env python3
"""Fetch Mobileye jobs via the __NUXT_DATA__ payload in careers page HTML.

Adapted from companies-analysis-base/mobileye/fetch_mobileye_engineering_rd_jobs_nuxt_data.py
for career-ops local-parser contract (stdout JSON jobs array).

The careers page is Nuxt SSR; job data is embedded in <script id="__NUXT_DATA__">.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SOURCE_URL = "https://careers.mobileye.com/jobs"
DEFAULT_OUTPUT = Path("data/parser-output/mobileye/engineering_rd_jobs.json")

EU_COUNTRY_CODES: frozenset[str] = frozenset({
    "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
    "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
    "NL", "PL", "PT", "RO", "SE", "SI", "SK",
})

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

_FULL_JOB_KEYS = frozenset({
    "additionalPlain", "commitment", "country", "department",
    "descriptionPlain", "id", "jobid", "lists", "location", "team", "text",
})


def read_response_body(resp) -> str:
    chunks: list[bytes] = []
    while True:
        chunk = resp.read(65536)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", errors="replace")


def fetch_html(url: str, *, attempts: int = 3) -> str:
    last_error: str | None = None
    for attempt in range(1, attempts + 1):
        req = Request(url, headers=_HEADERS)
        try:
            with urlopen(req, timeout=60) as resp:
                html = read_response_body(resp)
            if "__NUXT_DATA__" in html:
                return html
            last_error = "response missing __NUXT_DATA__ (truncated or bot page)"
        except HTTPError as exc:
            last_error = f"HTTP {exc.code}"
        except URLError as exc:
            last_error = f"network error: {exc.reason}"
        except Exception as exc:  # noqa: BLE001 — retry IncompleteRead and similar
            last_error = str(exc)

    sys.exit(f"Failed to fetch {url} after {attempts} attempts: {last_error}")


def extract_nuxt_data(html: str) -> list[Any]:
    match = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not match:
        sys.exit("__NUXT_DATA__ script tag not found — page structure may have changed")
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        sys.exit(f"Failed to parse __NUXT_DATA__ JSON: {exc}")


def extract_all_jobs(raw: list[Any]) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for val in raw:
        if not (isinstance(val, dict) and frozenset(val.keys()) == _FULL_JOB_KEYS):
            continue
        job = {k: raw[v] for k, v in val.items() if k != "lists"}
        jobs.append(job)
    return jobs


def geography_tags(country: str, location: str) -> list[str]:
    tags: list[str] = []
    loc_lower = location.lower()
    if country == "IL":
        tags.append("Israel")
    if country in EU_COUNTRY_CODES:
        tags.append("EU")
    if "remote" in loc_lower:
        tags.append("Remote")
    return tags


def is_engineering_dept(department: str) -> bool:
    return "R&D" in department or "Engineering" in department


def slugify(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def build_scan_job(raw_job: dict[str, Any]) -> dict[str, str]:
    jobid = raw_job["jobid"]
    return {
        "title": raw_job["text"],
        "url": f"https://careers.mobileye.com/jobs/{slugify(raw_job['text'])}/{jobid}",
        "location": raw_job["location"],
        "company": "Mobileye",
    }


def build_payload(source_url: str, *, all_departments: bool = False) -> dict[str, Any]:
    html = fetch_html(source_url)
    raw = extract_nuxt_data(html)
    all_jobs = extract_all_jobs(raw)

    if not all_jobs:
        sys.exit("No job records found in __NUXT_DATA__ — page structure may have changed")

    kept: list[dict[str, str]] = []
    seen_ids: set[str] = set()

    for raw_job in all_jobs:
        if not all_departments and not is_engineering_dept(raw_job["department"]):
            continue

        if not all_departments:
            tags = geography_tags(raw_job["country"], raw_job["location"])
            if not tags:
                continue

        job_id = raw_job["jobid"]
        if job_id in seen_ids:
            continue
        seen_ids.add(job_id)

        kept.append(build_scan_job(raw_job))

    return {
        "source": {
            "page_url": source_url,
            "extraction_method": "__NUXT_DATA__",
            "scraped_at_utc": datetime.now(UTC).isoformat(),
            "total_jobs_on_page": len(all_jobs),
            "matched_jobs": len(kept),
        },
        "jobs": kept,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="JSON output path")
    parser.add_argument("--source-url", "--url", default=SOURCE_URL, help="Mobileye careers page URL")
    parser.add_argument(
        "--all-departments",
        action="store_true",
        help="Include all departments (default: R&D/Engineering with IL/EU/Remote geography)",
    )
    parser.add_argument(
        "--stdout-jobs",
        action="store_true",
        help="Print jobs[] JSON to stdout for scan.mjs; status messages go to stderr",
    )
    parser.add_argument(
        "--no-output",
        action="store_true",
        help="Do not write the full payload JSON file",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = build_payload(args.source_url, all_departments=args.all_departments)

    output_path = Path(args.output)
    if not args.no_output:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    src = payload["source"]
    status = (
        f"Parsed {src['matched_jobs']} / {src['total_jobs_on_page']} Mobileye jobs"
        + (f" to {output_path}" if not args.no_output else " without writing JSON output")
    )

    if args.stdout_jobs:
        print(json.dumps(payload["jobs"], ensure_ascii=False))
        print(status, file=sys.stderr)
    else:
        print(status)


if __name__ == "__main__":
    main()
