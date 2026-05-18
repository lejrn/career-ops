#!/usr/bin/env python3
"""Fetch Cohere Engineering R&D jobs from the Ashby public job board API."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse


DEFAULT_SOURCE_URL = "https://jobs.ashbyhq.com/cohere"
DEFAULT_OUTPUT = Path("data/parser-output/cohere/engineering_rnd_jobs.json")

ENGINEERING_RND_DEPTS = {
    "Agentic Platform",
    "Cohere Labs",
    "Embeddings & Search",
    "Inference",
    "Modeling",
    "Product",
}


def ashby_api_url(source_url: str) -> str:
    parsed = urlparse(source_url)
    if parsed.netloc == "api.ashbyhq.com":
        return source_url

    board_slug = parsed.path.strip("/").split("/")[0]
    if not board_slug:
        raise ValueError(f"Cannot infer Ashby board slug from {source_url}")

    return f"https://api.ashbyhq.com/posting-api/job-board/{board_slug}"


def fetch_jobs(source_url: str) -> list[dict]:
    req = urllib.request.Request(
        ashby_api_url(source_url),
        headers={"User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    return data["jobs"]


def clean_job(job: dict) -> dict:
    return {
        "id": job["id"],
        "title": job["title"],
        "department": job["department"],
        "team": job["team"],
        "employmentType": job.get("employmentType"),
        "location": job.get("location"),
        "secondaryLocations": [
            loc.get("location") for loc in job.get("secondaryLocations", [])
        ],
        "isRemote": job.get("isRemote"),
        "workplaceType": job.get("workplaceType"),
        "publishedAt": job.get("publishedAt"),
        "url": job.get("jobUrl"),
        "jobUrl": job.get("jobUrl"),
        "applyUrl": job.get("applyUrl"),
        "descriptionPlain": job.get("descriptionPlain", ""),
    }


def build_payload(source_url: str) -> dict:
    all_jobs = fetch_jobs(source_url)
    eng_jobs = [j for j in all_jobs if j.get("department") in ENGINEERING_RND_DEPTS]
    cleaned = [clean_job(j) for j in eng_jobs]

    return {
        "source": source_url,
        "fetchedAt": datetime.now(UTC).isoformat(),
        "totalEngRndJobs": len(cleaned),
        "departments": sorted({j["department"] for j in cleaned}),
        "jobs": cleaned,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="JSON output path")
    parser.add_argument("--source-url", "--url", default=DEFAULT_SOURCE_URL, help="Cohere Ashby board URL")
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
    payload = build_payload(args.source_url)

    output_path = Path(args.output)
    if not args.no_output:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    dept_counts: dict[str, int] = {}
    for job in payload["jobs"]:
        dept_counts[job["department"]] = dept_counts.get(job["department"], 0) + 1

    status_lines = [
        (
            f"Saved {len(payload['jobs'])} Engineering R&D jobs to {output_path}"
            if not args.no_output
            else f"Parsed {len(payload['jobs'])} Engineering R&D jobs without writing JSON output"
        ),
        *[f"{count:3d}  {dept}" for dept, count in sorted(dept_counts.items())],
    ]

    if args.stdout_jobs:
        print(json.dumps(payload["jobs"], ensure_ascii=False))
        print("\n".join(status_lines), file=sys.stderr)
    else:
        print("\n".join(status_lines))


if __name__ == "__main__":
    main()
