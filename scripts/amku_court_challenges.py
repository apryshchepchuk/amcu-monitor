#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import io
import json
import hashlib
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

USER_AGENT = "amku-court-challenges/1.3-history"
PASSPORT_URL_TEMPLATE = "https://dsa.court.gov.ua/open_data_json.php?json={dataset_id}"
DATASET_IDS = {2024: 829, 2025: 879, 2026: 7636}
PUBLIC_EDRSR_URL = "https://reyestr.court.gov.ua/Review/{doc_id}"

# Exact category-name selection only. We deliberately do NOT infer descendants
# from numeric prefixes: the EDRSR category codes are not safely traversable by startswith().
CATEGORY_PATTERNS = [
    re.compile(r"оскаржен\w*\s+рішен\w*\s+антимонопольн", re.I),
    re.compile(r"застосуван\w*\s+антимонопольн\w*\s+(?:та\s+конкурентн\w*\s+)?законодавств", re.I),
    re.compile(r"захист\w*\s+економічн\w*\s+конкуренц", re.I),
    re.compile(r"антиконкурентн\w*\s+узгоджен\w*\s+ді", re.I),
    re.compile(r"антиконкурентн\w*\s+ді\w*\s+орган", re.I),
    re.compile(r"недобросовісн\w*\s+конкуренц", re.I),
    re.compile(r"зловживан\w*\s+монопольн\w*\s+становищ", re.I),
]
PRIMARY_CHALLENGE_CATEGORY_RE = re.compile(
    r"оскаржен\w*\s+рішен\w*\s+антимонопольн", re.I
)
MERITS_FORM_RE = re.compile(r"(?:^|\s)(рішення|постанова)(?:\s|$)", re.I)
COMMERCIAL_JUSTICE_RE = re.compile(r"господар", re.I)

# Cautious negative prefilter. It is used only when the LATEST substantive/current
# court document itself clearly identifies AMCU (or its territorial office) as plaintiff.
# If a counterclaim against AMCU is visible in that same current document, the case is
# NOT excluded and still goes to Gemini.
AMCU_ENTITY_RE_FRAGMENT = (
    r"(?:антимонопольн\w*\s+комітет\w*\s+україн\w*|"
    r"(?:[а-яіїєг\-]+\s+){0,7}(?:міжобласн\w*\s+)?територіальн\w*\s+"
    r"відділен\w*\s+антимонопольн\w*\s+комітет\w*\s+україн\w*)"
)
AMCU_PLAINTIFF_RE = re.compile(
    rf"(?:за\s+(?:первісн\w*\s+)?позов\w*|за\s+позовн\w*\s+заяв\w*)"
    rf".{{0,280}}?{AMCU_ENTITY_RE_FRAGMENT}.{{0,140}}?\sдо\s",
    re.I | re.S,
)
COUNTERCLAIM_AGAINST_AMCU_RE = re.compile(
    rf"(?:зустрічн\w*\s+позов\w*|зустрічн\w*\s+позовн\w*\s+заяв\w*)"
    rf".{{0,650}}?\sдо\s.{{0,260}}?{AMCU_ENTITY_RE_FRAGMENT}",
    re.I | re.S,
)

# Generic / anonymized values should never be treated as a party match.
GENERIC_PARTY_PHRASES = {
    "інформація з обмеженим доступом",
    "інформація доступ до якої обмежено",
    "інформація доступ до якої є обмеженим",
    "особа 1",
    "особа 2",
    "особа 3",
    "фізична особа",
    "юридична особа",
}
LEGAL_FORM_TOKENS = {
    "товариство", "обмеженою", "відповідальністю", "приватне", "акціонерне",
    "публічне", "підприємство", "компанія", "фірма", "державне", "комунальне",
    "приватний", "акціонерний", "тов", "пат", "прат", "ат", "пп", "дп",
}

# RTF destinations that contain formatting/metadata rather than visible body text.
RTF_DESTINATIONS = {
    "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "headerf",
    "headerl", "headerr", "footer", "footerf", "footerl", "footerr", "footnote", "annotation",
    "fldinst", "xmlnstbl", "listtable", "listoverridetable", "themedata", "datastore",
    "latentstyles", "generator", "revtbl", "rsidtbl", "protusertbl", "shp", "shpinst",
}
RTF_SPECIAL_WORDS = {
    "par": "\n", "line": "\n", "tab": "\t", "emdash": "—", "endash": "–",
    "bullet": "•", "lquote": "‘", "rquote": "’", "ldblquote": "“", "rdblquote": "”",
    "enspace": " ", "emspace": " ", "qmspace": " ",
}

DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite"
REGISTRY_SCHEMA = "amku_court_challenges_v1"
CASE_OUTCOMES = {"ongoing", "upheld", "overturned", "partially_overturned"}
CASE_STATUS_LABELS = {
    "ongoing": "Оскарження триває",
    "upheld": "Рішення АМКУ залишено чинним",
    "overturned": "Рішення АМКУ скасовано",
    "partially_overturned": "Рішення АМКУ скасовано частково",
}

AI_CACHE_SCHEMA = "amku_court_ai_cache_v2"
CHALLENGE_CACHE_VERSION = "direct-challenge-v2"
SAFEGUARD_CACHE_VERSION = "weak-yes-v1"
MERITS_CACHE_VERSION = "merits-status-v2"
CURRENT_STATUS_CACHE_VERSION = "post-merits-current-status-v1"




@dataclass
class PracticeRow:
    raw: dict[str, Any]
    row_id: str
    decision_number: str
    decision_date: str
    liable_parties: list[str]
    decision_number_norm: str
    decision_number_pattern: re.Pattern[str]
    party_norms: list[str]


@dataclass
class DocRow:
    doc_id: str
    court_code: str
    judgment_code: str
    justice_kind: str
    category_code: str
    cause_num: str
    adjudication_date: str
    receipt_date: str
    doc_url: str
    status: str
    date_publ: str


class DocumentFetchError(RuntimeError):
    def __init__(self, message: str, attempts: list[dict[str, Any]]):
        super().__init__(message)
        self.attempts = attempts


def log(msg: str) -> None:
    print(msg, flush=True)


def clean(v: Any) -> str:
    return str(v or "").replace("\ufeff", "").strip()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Production enrichment: detect judicial challenges of AMCU decisions in EDRSR, "
            "classify the current result, and merge a persistent court-challenge registry."
        )
    )
    p.add_argument("--year", type=int, default=2026, choices=sorted(DATASET_IDS))
    p.add_argument("--dataset-id", type=int, default=0, help="Override DSA dataset id.")
    p.add_argument("--practice", default="data/practice/amku_practice.json")
    p.add_argument("--registry", default="data/practice/amku_court_challenges.json")
    p.add_argument("--out-dir", default="data/tmp/amku_court_challenges")
    p.add_argument("--cache-dir", default="data/tmp/amku_court_challenge_cache/v4")
    p.add_argument("--max-cases", type=int, default=0, help="0 = all prefiltered cases.")
    p.add_argument("--workers", type=int, default=4, help="Concurrent EDRSR text fetch workers.")
    p.add_argument("--request-delay-ms", type=int, default=0)
    p.add_argument("--request-timeout", type=int, default=45)
    p.add_argument("--retries", type=int, default=4)
    p.add_argument("--max-gemini-calls", type=int, default=20, help="Maximum Gemini calls for challenge classification.")
    p.add_argument("--max-targeted-retry-calls", type=int, default=10, help="Maximum extra single-candidate retries for malformed/partial Gemini challenge responses.")
    p.add_argument("--targeted-retry-attempts", type=int, default=2, help="Maximum targeted retry attempts per unresolved candidate.")
    p.add_argument("--max-safeguard-gemini-calls", type=int, default=10, help="Maximum second-check calls for weak YES results.")
    p.add_argument("--max-merits-gemini-calls", type=int, default=80, help="Maximum Gemini calls for substantive/current-status verification.")
    p.add_argument("--max-current-status-gemini-calls", type=int, default=20, help="Maximum Gemini calls to verify whether a later court act keeps appellate/cassation review ongoing after a merits act.")
    p.add_argument("--ai-cache", default="data/tmp/amku_court_ai_cache/cache.json", help="Checkpoint cache for normalized Gemini results; safe to restore between runs.")
    p.add_argument("--seed-cache", default="", help="Optional approved historical probe seed used only when year/dataset/ZIP/model match.")
    p.add_argument("--gemini-rpm-limit", type=int, default=5)
    p.add_argument("--gemini-max-text-chars", type=int, default=30000)
    p.add_argument("--skip-gemini", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="Do not write the persistent registry.")
    p.add_argument("--replace-year", action="store_true", help="Replace this year's observations in the persistent registry before merging new results.")
    p.add_argument(
        "--focus-decision",
        default="",
        help="Optional AMCU decision number for report/debug emphasis only; does not alter case selection.",
    )
    p.add_argument("--keep-zip", action="store_true")
    return p.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def atomic_write_json(path: Path, value: Any) -> None:
    """Durably checkpoint JSON without exposing a half-written file to the next run."""
    ensure_dir(path.parent)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def load_ai_cache(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schema": AI_CACHE_SCHEMA,
            "updated_at": None,
            "entries": {},
        }
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        # Corrupt/mid-write caches are never trusted. The atomic writer should make this rare.
        return {
            "schema": AI_CACHE_SCHEMA,
            "updated_at": None,
            "entries": {},
        }
    if not isinstance(raw, dict) or raw.get("schema") != AI_CACHE_SCHEMA:
        return {
            "schema": AI_CACHE_SCHEMA,
            "updated_at": None,
            "entries": {},
        }
    entries = raw.get("entries") if isinstance(raw.get("entries"), dict) else {}
    return {
        "schema": AI_CACHE_SCHEMA,
        "updated_at": raw.get("updated_at"),
        "entries": entries,
    }


def text_sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8", errors="replace")).hexdigest()


def ai_cache_key(
    stage: str,
    year: int,
    cause_num: str,
    doc_id: str,
    decision_key: str,
    model: str,
    version: str,
    text_hash: str,
) -> str:
    raw = "\x1f".join([
        stage,
        str(year),
        clean(cause_num),
        clean(doc_id),
        clean(decision_key),
        clean(model),
        clean(version),
        clean(text_hash),
    ])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def ai_cache_get(
    cache: dict[str, Any],
    *,
    stage: str,
    year: int,
    cause_num: str,
    doc_id: str,
    decision_key: str,
    model: str,
    version: str,
    text_hash: str,
) -> dict[str, Any] | None:
    key = ai_cache_key(stage, year, cause_num, doc_id, decision_key, model, version, text_hash)
    entry = (cache.get("entries") or {}).get(key)
    if not isinstance(entry, dict):
        return None
    result = entry.get("result")
    return dict(result) if isinstance(result, dict) else None


def ai_cache_put(
    cache_path: Path,
    cache: dict[str, Any],
    *,
    stage: str,
    year: int,
    cause_num: str,
    doc_id: str,
    decision_key: str,
    model: str,
    version: str,
    text_hash: str,
    result: dict[str, Any],
    source: str,
) -> None:
    key = ai_cache_key(stage, year, cause_num, doc_id, decision_key, model, version, text_hash)
    entries = cache.setdefault("entries", {})
    entries[key] = {
        "stage": stage,
        "year": year,
        "cause_num": clean(cause_num),
        "doc_id": clean(doc_id),
        "decision_key": clean(decision_key),
        "model": clean(model),
        "version": version,
        "text_sha256": text_hash,
        "source": source,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "result": result,
    }
    cache["schema"] = AI_CACHE_SCHEMA
    cache["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    atomic_write_json(cache_path, cache)


def load_approved_seed(
    path: Path | None,
    *,
    year: int,
    dataset_id: int,
    zip_url: str,
    model: str,
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Load an approved v6 direct-challenge seed for the same year/dataset/model.

    The annual ZIP may be refreshed later. A seed row is still reusable only when current discovery
    independently finds the exact same case + court doc_id + AMCU decision, so newly added documents
    never inherit a historical classification by number alone.
    """
    if not path or not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:  # noqa: BLE001
        log(f"Seed cache ignored: could not parse {path}: {exc}")
        return {}
    if not isinstance(raw, dict) or raw.get("schema") != "amku_court_ai_seed_v1":
        log(f"Seed cache ignored: unsupported schema in {path}")
        return {}
    if int(raw.get("year") or 0) != int(year):
        return {}
    if int(raw.get("dataset_id") or 0) != int(dataset_id):
        return {}
    if clean(raw.get("zip_url")) != clean(zip_url):
        log(
            "Seed ZIP URL differs from the historical probe ZIP; reusing only exact "
            "case + court-doc-id + AMCU-decision identities. Current metadata discovery still "
            "has to find those same active candidate documents before a seed entry can be used."
        )
    if clean(raw.get("gemini_model")) != clean(model):
        log("Seed cache ignored: Gemini model differs from the successful probe model.")
        return {}
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    for item in raw.get("challenge_results") or []:
        if not isinstance(item, dict):
            continue
        decision_key = clean(item.get("decision_key"))
        cause_num = clean(item.get("cause_num"))
        doc_id = clean(item.get("doc_id"))
        cls = clean(item.get("classification")).upper()
        if decision_key and cause_num and doc_id and cls in {"YES", "NO"}:
            out[(cause_num, doc_id, decision_key)] = dict(item)
    return out


def result_from_seed(candidate: dict[str, Any], seed: dict[str, Any]) -> dict[str, Any]:
    cls = clean(seed.get("classification")).upper()
    # Seed v6 is trusted only for the direct YES/NO question. Current case status and merits are
    # intentionally re-verified by the production merits stage because those rules changed later.
    return {
        **candidate,
        "classification": cls,
        "gemini_confidence": clean(seed.get("gemini_confidence")) or "high",
        "challenger": clean(seed.get("challenger")),
        "current_document_resolves_merits": False,
        "current_document_invalidates_prior_merits": False,
        "case_outcome": "not_applicable" if cls == "NO" else "ongoing",
        "status_reason": "",
        "reason": clean(seed.get("reason"))[:600],
        "current_status_verified": False,
        "cache_source": "approved_probe_v6_seed",
    }


def load_approved_merits_seed(
    path: Path | None,
    *,
    year: int,
    dataset_id: int,
    model: str,
) -> dict[tuple[str, str, str], dict[str, Any]]:
    """Load conservative v6 merits/status recovery rows.

    Only rows whose v6 audit text explicitly supported an outcome/process status were included in
    the seed. Ambiguous outcome rows are intentionally absent and will still go to production Gemini.
    Current discovery must independently encounter the exact same case + doc_id + AMCU decision.
    """
    if not path or not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return {}
    if not isinstance(raw, dict) or raw.get("schema") != "amku_court_ai_seed_v1":
        return {}
    if int(raw.get("year") or 0) != int(year):
        return {}
    if int(raw.get("dataset_id") or 0) != int(dataset_id):
        return {}
    if clean(raw.get("gemini_model")) != clean(model):
        return {}
    out: dict[tuple[str, str, str], dict[str, Any]] = {}
    for item in raw.get("merits_results") or []:
        if not isinstance(item, dict):
            continue
        decision_key = clean(item.get("decision_key"))
        cause_num = clean(item.get("cause_num"))
        doc_id = clean(item.get("doc_id"))
        outcome = clean(item.get("outcome")).lower()
        if outcome not in CASE_OUTCOMES:
            continue
        if not (decision_key and cause_num and doc_id):
            continue
        out[(cause_num, doc_id, decision_key)] = {
            "resolves_merits": bool(item.get("resolves_merits", False)),
            "invalidates_prior_merits": bool(item.get("invalidates_prior_merits", False)),
            "outcome": outcome,
            "gemini_confidence": clean(item.get("gemini_confidence")) or "high",
            "reason": clean(item.get("reason"))[:600],
        }
    return out


def http_bytes(url: str, timeout: int, retries: int) -> bytes:
    body, _meta = http_bytes_meta(url, timeout, retries)
    return body


def http_bytes_meta(url: str, timeout: int, retries: int) -> tuple[bytes, dict[str, Any]]:
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                body = res.read()
                return body, {
                    "requested_url": url,
                    "final_url": clean(getattr(res, "geturl", lambda: url)()),
                    "status": int(getattr(res, "status", 0) or 0),
                    "content_type": clean(res.headers.get("Content-Type")),
                    "body_bytes": len(body),
                }
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt >= retries:
                break
            wait = min(20, 2 ** (attempt - 1))
            log(f"HTTP retry {attempt}/{retries} after error: {exc}; sleep {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"Failed to fetch {url}: {last}")


def download_file(url: str, dest: Path, timeout: int, retries: int) -> None:
    if dest.exists() and dest.stat().st_size > 1_000_000:
        log(f"Using cached ZIP: {dest} ({dest.stat().st_size:,} bytes)")
        return

    ensure_dir(dest.parent)
    tmp = dest.with_suffix(dest.suffix + ".part")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as res, tmp.open("wb") as f:
                total = int(res.headers.get("Content-Length") or 0)
                copied = 0
                next_mark = 50 * 1024 * 1024
                while True:
                    chunk = res.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    copied += len(chunk)
                    if copied >= next_mark:
                        if total:
                            log(f"Downloaded {copied / 1024 / 1024:.0f}/{total / 1024 / 1024:.0f} MB")
                        else:
                            log(f"Downloaded {copied / 1024 / 1024:.0f} MB")
                        next_mark += 50 * 1024 * 1024
            tmp.replace(dest)
            return
        except Exception as exc:  # noqa: BLE001
            last = exc
            tmp.unlink(missing_ok=True)
            if attempt >= retries:
                break
            wait = min(30, 2 ** attempt)
            log(f"ZIP download retry {attempt}/{retries}: {exc}; sleep {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"Failed to download {url}: {last}")


def fetch_passport_zip_url(year: int, dataset_id: int, timeout: int, retries: int) -> str:
    passport_url = PASSPORT_URL_TEMPLATE.format(dataset_id=dataset_id)
    data = json.loads(http_bytes(passport_url, timeout, retries).decode("utf-8-sig"))
    wanted = f"edrsr_data_{year}.zip"
    files = data.get("Файли") or []
    for item in files:
        if isinstance(item, dict) and wanted in item:
            return str(item[wanted])
    for item in files:
        if isinstance(item, dict):
            for name, url in item.items():
                if str(name).lower().endswith(".zip"):
                    return str(url)
    raise RuntimeError(f"ZIP URL not found in passport {passport_url}")


def find_zip_member(zf: zipfile.ZipFile, basename: str) -> str:
    target = basename.lower()
    for name in zf.namelist():
        if Path(name).name.lower() == target:
            return name
    raise KeyError(f"{basename} not found in ZIP")


def open_tsv_member(zf: zipfile.ZipFile, member: str) -> io.TextIOWrapper:
    return io.TextIOWrapper(zf.open(member, "r"), encoding="utf-8-sig", errors="replace", newline="")


def read_dict_tsv(zf: zipfile.ZipFile, basename: str, key_name: str) -> dict[str, str]:
    member = find_zip_member(zf, basename)
    with open_tsv_member(zf, member) as f:
        reader = csv.DictReader(f, delimiter="\t", quotechar='"')
        out: dict[str, str] = {}
        for row in reader:
            key = clean(row.get(key_name))
            name = clean(row.get("name"))
            if key:
                out[key] = name
        return out


def normalize_text(v: Any) -> str:
    raw = clean(v).replace("№", " ")
    s = unicodedata.normalize("NFKC", raw).lower().replace("ґ", "г")
    s = re.sub(r"[’'`ʼ«»“”„]", " ", s)
    s = re.sub(r"[‐‑‒–—−]", "-", s)
    s = re.sub(r"[^0-9a-zа-яіїєг/\-]+", " ", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


def normalized_number(v: Any) -> str:
    s = unicodedata.normalize("NFKC", clean(v)).lower().replace("№", "").replace("ґ", "г")
    s = re.sub(r"[‐‑‒–—−]", "-", s)
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[^0-9a-zа-яіїєг/\-]", "", s, flags=re.I)
    return s


def structured_identifier_regex(v: Any) -> re.Pattern[str]:
    canonical = normalized_number(v)
    if not canonical:
        return re.compile(r"(?!)")
    parts = re.split(r"([/\-])", canonical)
    body: list[str] = []
    for part in parts:
        if not part:
            continue
        if part == "/":
            body.append(r"\s*/\s*")
        elif part == "-":
            body.append(r"\s*[-‐‑‒–—−]?\s*")
        else:
            body.append(re.escape(part))
    return re.compile(
        r"(?<![0-9a-zа-яіїєг/])" + "".join(body) + r"(?![0-9a-zа-яіїєг/])",
        re.I,
    )


def decision_number_regex(v: Any) -> re.Pattern[str]:
    # Same boundary-safe structure-preserving matcher used for AMCU decision numbers.
    return structured_identifier_regex(v)


def parse_date(v: str) -> datetime | None:
    s = clean(v)
    if not s:
        return None
    candidates = [s[:10], s[:19]]
    for candidate in candidates:
        for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(candidate, fmt)
            except ValueError:
                pass
    return None


def date_variants(iso_date: str) -> list[str]:
    dt = parse_date(iso_date)
    if not dt:
        return []
    month_names = {
        1: "січня", 2: "лютого", 3: "березня", 4: "квітня", 5: "травня", 6: "червня",
        7: "липня", 8: "серпня", 9: "вересня", 10: "жовтня", 11: "листопада", 12: "грудня",
    }
    raw = [
        dt.strftime("%d.%m.%Y"),
        f"{dt.day}.{dt.month}.{dt.year}",
        dt.strftime("%Y-%m-%d"),
        f"{dt.day} {month_names[dt.month]} {dt.year}",
    ]
    return sorted({normalize_text(x) for x in raw})


def load_practice(path: Path) -> list[PracticeRow]:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    rows: list[Any] = []
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        for key in ("rows", "results", "items", "practice", "data"):
            if isinstance(raw.get(key), list):
                rows = raw[key]
                break

    out: list[PracticeRow] = []
    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        num = clean(row.get("decision_number"))
        date = clean(row.get("decision_date"))
        parties = row.get("liable_parties")
        if not isinstance(parties, list):
            parties = []
        parties = [clean(x) for x in parties if clean(x)]
        if not num:
            continue
        row_id = clean(row.get("decision_key")) or clean(row.get("id")) or clean(row.get("decision_id")) or f"practice-{idx}"
        party_norms = []
        for party in parties:
            n = normalize_text(party)
            if n and n not in GENERIC_PARTY_PHRASES and not re.fullmatch(r"особа\s*\d+", n):
                party_norms.append(n)
        out.append(
            PracticeRow(
                raw=row,
                row_id=row_id,
                decision_number=num,
                decision_date=date,
                liable_parties=parties,
                decision_number_norm=normalized_number(num),
                decision_number_pattern=decision_number_regex(num),
                party_norms=party_norms,
            )
        )
    return out


def category_name_is_relevant(name: str) -> bool:
    return any(pattern.search(name or "") for pattern in CATEGORY_PATTERNS)


def relevant_category_codes(categories: dict[str, str]) -> set[str]:
    return {code for code, name in categories.items() if category_name_is_relevant(name)}


def primary_challenge_category_codes(categories: dict[str, str]) -> set[str]:
    return {
        code for code, name in categories.items()
        if PRIMARY_CHALLENGE_CATEGORY_RE.search(name or "")
    }


def doc_from_row(row: dict[str, str]) -> DocRow:
    return DocRow(
        doc_id=clean(row.get("doc_id")),
        court_code=clean(row.get("court_code")),
        judgment_code=clean(row.get("judgment_code")),
        justice_kind=clean(row.get("justice_kind")),
        category_code=clean(row.get("category_code")),
        cause_num=clean(row.get("cause_num")),
        adjudication_date=clean(row.get("adjudication_date")),
        receipt_date=clean(row.get("receipt_date")),
        doc_url=clean(row.get("doc_url")),
        status=clean(row.get("status")),
        date_publ=clean(row.get("date_publ")),
    )


def date_sort_value(v: str) -> tuple[int, str]:
    dt = parse_date(v)
    return (1, dt.isoformat()) if dt else (0, clean(v))


def doc_sort_key(d: DocRow) -> tuple[Any, ...]:
    return (
        date_sort_value(d.adjudication_date),
        date_sort_value(d.receipt_date),
        int(d.doc_id) if d.doc_id.isdigit() else 0,
    )


def scan_prefilter(
    zf: zipfile.ZipFile,
    relevant_categories: set[str],
    commercial_justice_codes: set[str],
    known_case_numbers: set[str] | None = None,
) -> tuple[
    dict[str, list[DocRow]],
    dict[str, int],
    dict[str, dict[str, Any]],
    dict[str, int],
    dict[str, list[DocRow]],
]:
    """Single-pass EDRSR metadata scan.

    Discovery remains conservative: active + exact competition category + commercial
    jurisdiction + case number. In parallel, already-confirmed court case numbers are
    collected across ALL active EDRSR categories so their appellate/cassation history
    is not lost merely because a later document uses a different category code or no
    longer repeats the AMCU decision number.
    """
    member = find_zip_member(zf, "documents.csv")
    cases: dict[str, list[DocRow]] = defaultdict(list)
    known_history_cases: dict[str, list[DocRow]] = defaultdict(list)
    known_case_numbers = {clean(x) for x in (known_case_numbers or set()) if clean(x)}

    stats = {
        "rows_total": 0,
        "active": 0,
        "category_match": 0,
        "commercial_match": 0,
        "with_cause_num": 0,
        "cases": 0,
        "known_history_case_numbers_requested": len(known_case_numbers),
        "known_history_documents": 0,
        "known_history_cases_found": 0,
    }
    category_stats: dict[str, dict[str, Any]] = {
        code: {
            "category_code": code,
            "active_documents": 0,
            "commercial_documents": 0,
            "cases": set(),
        }
        for code in relevant_categories
    }
    justice_stats: dict[str, int] = defaultdict(int)

    with open_tsv_member(zf, member) as f:
        reader = csv.DictReader(f, delimiter="\t", quotechar='"')
        for row in reader:
            stats["rows_total"] += 1
            if clean(row.get("status")) != "1":
                continue
            stats["active"] += 1

            # Known-case history is intentionally independent of category matching.
            # Exact cause_num is already a confirmed link from our persistent registry.
            cause_num = clean(row.get("cause_num"))
            doc_for_history: DocRow | None = None
            if cause_num and cause_num in known_case_numbers:
                doc_for_history = doc_from_row(row)
                known_history_cases[cause_num].append(doc_for_history)
                stats["known_history_documents"] += 1

            cat = clean(row.get("category_code"))
            if cat not in relevant_categories:
                continue
            stats["category_match"] += 1
            category_stats[cat]["active_documents"] += 1

            justice_code = clean(row.get("justice_kind"))
            justice_stats[justice_code] += 1
            if justice_code not in commercial_justice_codes:
                continue
            stats["commercial_match"] += 1
            category_stats[cat]["commercial_documents"] += 1

            doc = doc_for_history if doc_for_history is not None else doc_from_row(row)
            if not doc.cause_num:
                continue
            stats["with_cause_num"] += 1
            cases[doc.cause_num].append(doc)
            category_stats[cat]["cases"].add(doc.cause_num)

    stats["cases"] = len(cases)
    stats["known_history_cases_found"] = len(known_history_cases)
    return cases, stats, category_stats, dict(justice_stats), dict(known_history_cases)

def decode_response_text(raw: bytes, content_type: str = "") -> str:
    encodings: list[str] = []
    m = re.search(r"charset\s*=\s*['\"]?([^;\s'\"]+)", content_type or "", re.I)
    if m:
        encodings.append(m.group(1).strip())
    if raw.startswith(b"\xef\xbb\xbf"):
        encodings.append("utf-8-sig")
    elif raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        encodings.append("utf-16")
    encodings.extend(["utf-8", "cp1251", "latin-1"])
    seen: set[str] = set()
    for encoding in encodings:
        key = encoding.lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            return raw.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            continue
    return raw.decode("utf-8", errors="replace")


def rtf_decode_byte(byte_value: int, encoding: str) -> str:
    try:
        return bytes([byte_value]).decode(encoding, errors="replace")
    except LookupError:
        return bytes([byte_value]).decode("cp1251", errors="replace")


def rtf_to_text(raw: bytes) -> str:
    """Small dependency-free RTF-to-Unicode converter sufficient for EDRSR RTF bodies.

    Handles ansicpg, RTF hex escapes, Unicode control escapes, paragraph/tab controls and ignores
    common formatting destinations. The previous POC sometimes analyzed raw RTF control text,
    which is why Cyrillic AMCU names/numbers were missed in documents such as doc_id 138445197.
    """
    source = raw.decode("latin-1", errors="replace")
    cp_match = re.search(r"\\ansicpg(\d+)", source[:4000], re.I)
    codepage = f"cp{cp_match.group(1)}" if cp_match else "cp1251"

    # Groups preserve destination/uc state.
    stack: list[tuple[bool, int]] = []
    ignorable = False
    ucskip = 1
    skip_fallback = 0
    out: list[str] = []
    i = 0
    n = len(source)

    def append_literal(s: str) -> None:
        nonlocal skip_fallback
        if not s or ignorable:
            return
        if skip_fallback > 0:
            take = min(skip_fallback, len(s))
            s = s[take:]
            skip_fallback -= take
        if not s:
            return
        buf: list[str] = []
        for ch in s:
            o = ord(ch)
            if o >= 128 and o <= 255:
                buf.append(rtf_decode_byte(o, codepage))
            else:
                buf.append(ch)
        out.append("".join(buf))

    while i < n:
        ch = source[i]
        if ch == "{":
            stack.append((ignorable, ucskip))
            i += 1
            continue
        if ch == "}":
            if stack:
                ignorable, ucskip = stack.pop()
            i += 1
            continue
        if ch != "\\":
            # Copy plain run until a control/group delimiter.
            j = i + 1
            while j < n and source[j] not in "{}\\":
                j += 1
            append_literal(source[i:j])
            i = j
            continue

        # Backslash control.
        if i + 1 >= n:
            break
        nxt = source[i + 1]

        # Hex escape: \'hh
        if nxt == "'" and i + 3 < n:
            hx = source[i + 2:i + 4]
            if re.fullmatch(r"[0-9A-Fa-f]{2}", hx):
                if skip_fallback > 0:
                    skip_fallback -= 1
                elif not ignorable:
                    out.append(rtf_decode_byte(int(hx, 16), codepage))
                i += 4
                continue

        # Escaped literal symbols.
        if nxt in "{}\\":
            append_literal(nxt)
            i += 2
            continue
        if nxt == "~":
            append_literal(" ")
            i += 2
            continue
        if nxt == "_":
            append_literal("-")
            i += 2
            continue
        if nxt == "*":
            ignorable = True
            i += 2
            continue

        # Control word with optional signed integer parameter.
        m = re.match(r"\\([A-Za-z]+)(-?\d+)? ?", source[i:])
        if not m:
            i += 2
            continue
        word = m.group(1).lower()
        arg = int(m.group(2)) if m.group(2) is not None else None
        i += len(m.group(0))

        if word in RTF_DESTINATIONS:
            ignorable = True
            continue
        if word == "ansicpg" and arg:
            codepage = f"cp{arg}"
            continue
        if word == "uc" and arg is not None:
            ucskip = max(0, arg)
            continue
        if word == "u" and arg is not None:
            if not ignorable:
                value = arg if arg >= 0 else arg + 65536
                try:
                    out.append(chr(value))
                except ValueError:
                    out.append(" ")
            skip_fallback = ucskip
            continue
        if word in RTF_SPECIAL_WORDS:
            append_literal(RTF_SPECIAL_WORDS[word])
            continue
        # Other formatting controls are ignored.

    text = "".join(out)
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def html_to_text(raw: bytes, content_type: str = "") -> str:
    text = decode_response_text(raw, content_type)
    text = re.sub(r"(?is)<script\b.*?</script>", " ", text)
    text = re.sub(r"(?is)<style\b.*?</style>", " ", text)
    text = re.sub(r"(?is)<noscript\b.*?</noscript>", " ", text)
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</(?:p|div|tr|li|h[1-6])\s*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return html.unescape(text)


def extract_document_text(raw: bytes, content_type: str, url: str) -> tuple[str, str]:
    head = raw[:300].lstrip().lower()
    ct = (content_type or "").lower()
    if "rtf" in ct or str(url).lower().endswith(".rtf") or head.startswith(b"{\\rtf"):
        return rtf_to_text(raw), "rtf"
    if "html" in ct or b"<html" in head or b"<!doctype html" in head:
        return html_to_text(raw, content_type), "html"
    return decode_response_text(raw, content_type), "plain"


def court_document_validation(text: str, doc: DocRow) -> dict[str, Any]:
    norm = normalize_text(text)
    text_length = len(norm)
    case_hit = bool(doc.cause_num and structured_identifier_regex(doc.cause_num).search(norm))
    raw_rtf_artifact = bool(re.search(r"(?:^|\s)rtf1\s+ansi(?:\s|$)", norm[:300]))
    judgment_markers = ["ухвала", "рішення", "постанова", "судовий наказ"]
    has_judgment_marker = any(
        re.search(rf"(?:^|\s){re.escape(x)}(?:\s|$)", norm) for x in judgment_markers
    )
    has_court_marker = any(
        x in norm for x in ["господарський суд", "апеляційний господарський суд", "верховний суд", "суддя"]
    )
    has_case_word = bool(re.search(r"(?:^|\s)справ[аиіою](?:\s|$)", norm))

    valid_by_case = text_length >= 300 and case_hit and not raw_rtf_artifact
    valid_by_markers = (
        text_length >= 1000 and has_case_word and has_judgment_marker and has_court_marker and not raw_rtf_artifact
    )
    valid = valid_by_case or valid_by_markers
    if raw_rtf_artifact:
        reason = "raw_rtf_not_decoded"
    elif text_length < 300:
        reason = "too_short"
    elif not valid:
        reason = "case_number_or_court_markers_missing"
    else:
        reason = "ok"
    return {
        "valid": valid,
        "reason": reason,
        "text_length": text_length,
        "contains_case_number": case_hit,
        "contains_case_word": has_case_word,
        "contains_judgment_marker": has_judgment_marker,
        "contains_court_marker": has_court_marker,
        "raw_rtf_artifact": raw_rtf_artifact,
    }


def fetch_doc_text(
    doc: DocRow,
    cache_dir: Path,
    timeout: int,
    retries: int,
    request_delay_ms: int = 0,
) -> tuple[str, dict[str, Any]]:
    ensure_dir(cache_dir)
    cache = cache_dir / f"{doc.doc_id}.v4.txt"
    attempts: list[dict[str, Any]] = []

    if cache.exists() and cache.stat().st_size > 50:
        cached_text = cache.read_text(encoding="utf-8", errors="replace")
        validation = court_document_validation(cached_text, doc)
        attempts.append({
            "source": "cache", "content_type": "text/plain; cache", "body_bytes": cache.stat().st_size,
            **validation, "accepted": bool(validation["valid"]),
        })
        if validation["valid"]:
            return cached_text, {
                "cache_hit": True,
                "source_url": "cache",
                "content_type": "text/plain; cache",
                "decoder": "cache-v4",
                "attempts": attempts,
                "validation": validation,
            }
        cache.unlink(missing_ok=True)

    urls: list[tuple[str, str]] = []
    if doc.doc_url:
        urls.append(("doc_url", doc.doc_url))
    public_url = PUBLIC_EDRSR_URL.format(doc_id=doc.doc_id)
    if all(url != public_url for _kind, url in urls):
        urls.append(("public_review", public_url))

    last: Exception | None = None
    for source_kind, url in urls:
        if request_delay_ms > 0:
            time.sleep(request_delay_ms / 1000)
        try:
            body, http_meta = http_bytes_meta(url, timeout, retries)
            text, decoder = extract_document_text(body, http_meta.get("content_type", ""), url)
            validation = court_document_validation(text, doc)
            attempt = {
                "source": source_kind,
                **http_meta,
                "decoder": decoder,
                **validation,
                "accepted": bool(validation["valid"]),
            }
            if not validation["valid"]:
                attempt["text_preview"] = normalize_text(text)[:500]
            attempts.append(attempt)
            if not validation["valid"]:
                last = RuntimeError(f"Not a validated court document: {validation['reason']}")
                continue
            cache.write_text(text, encoding="utf-8")
            return text, {
                "cache_hit": False,
                "source_url": url,
                "final_url": http_meta.get("final_url", url),
                "content_type": http_meta.get("content_type", ""),
                "body_bytes": http_meta.get("body_bytes", len(body)),
                "decoder": decoder,
                "attempts": attempts,
                "validation": validation,
            }
        except Exception as exc:  # noqa: BLE001
            last = exc
            attempts.append({"source": source_kind, "requested_url": url, "accepted": False, "error": str(exc)})

    raise DocumentFetchError(
        f"Could not fetch validated court text for doc {doc.doc_id}: {last}", attempts
    )


def is_merits_doc(doc: DocRow, judgment_forms: dict[str, str]) -> bool:
    name = normalize_text(judgment_forms.get(doc.judgment_code, ""))
    if "ухвала" in name or "судовий наказ" in name:
        return False
    return bool(MERITS_FORM_RE.search(name))


def latest_merits(docs: list[DocRow], judgment_forms: dict[str, str]) -> DocRow | None:
    merits = [d for d in docs if d.status == "1" and is_merits_doc(d, judgment_forms)]
    return max(merits, key=doc_sort_key) if merits else None


def merits_docs_desc(docs: list[DocRow], judgment_forms: dict[str, str]) -> list[DocRow]:
    """Return all active Рішення/Постанови newest first.

    This is only a form-based candidate list. Whether a particular act actually resolves the
    AMCU challenge on the merits is verified separately by Gemini.
    """
    merits = [d for d in docs if d.status == "1" and is_merits_doc(d, judgment_forms)]
    return sorted(merits, key=doc_sort_key, reverse=True)


def latest_active(docs: list[DocRow]) -> DocRow | None:
    active = [d for d in docs if d.status == "1"]
    return max(active, key=doc_sort_key) if active else None


def earliest_active(docs: list[DocRow]) -> DocRow | None:
    active = [d for d in docs if d.status == "1"]
    return min(active, key=doc_sort_key) if active else None


def primary_discovery_doc(
    docs: list[DocRow],
    judgment_forms: dict[str, str],
) -> tuple[DocRow | None, str]:
    merits = latest_merits(docs, judgment_forms)
    if merits:
        return merits, "latest_merits"
    latest = latest_active(docs)
    if latest:
        return latest, "latest_active"
    return None, "none"

def amcu_plaintiff_negative_prefilter(text: str, preamble_chars: int = 12000) -> dict[str, Any]:
    """Return a cautious negative signal for obvious AMCU-as-plaintiff enforcement cases.

    We inspect only the beginning of the latest substantive/current court text. A case is excluded
    only when that current document explicitly identifies AMCU/its territorial office as plaintiff
    AND does not show a counterclaim against AMCU. Ambiguous cases remain candidates for Gemini.
    """
    norm = normalize_text(text)
    preamble = norm[:preamble_chars]
    plaintiff = bool(AMCU_PLAINTIFF_RE.search(preamble))
    counterclaim = bool(COUNTERCLAIM_AGAINST_AMCU_RE.search(norm[:30000]))
    return {
        "exclude": bool(plaintiff and not counterclaim),
        "amcu_plaintiff": plaintiff,
        "counterclaim_against_amcu": counterclaim,
        "preamble_chars_checked": min(len(norm), preamble_chars),
    }


def party_match_score(text_norm: str, party_norms: Iterable[str]) -> tuple[bool, str]:
    for party in party_norms:
        if not party or party in GENERIC_PARTY_PHRASES or re.fullmatch(r"особа\s*\d+", party):
            continue
        if len(party) >= 8 and party in text_norm:
            return True, party
        tokens = [
            t for t in party.split()
            if len(t) >= 4 and t not in LEGAL_FORM_TOKENS and not t.isdigit()
        ]
        # Require at least one meaningful token; for multi-token names require all first 4.
        if tokens and all(t in text_norm for t in tokens[:4]):
            return True, " ".join(tokens[:4])
    return False, ""


def row_is_chronologically_possible(row: PracticeRow, doc: DocRow) -> bool:
    decision_dt = parse_date(row.decision_date)
    court_dt = parse_date(doc.adjudication_date)
    if not decision_dt or not court_dt:
        return True
    return court_dt.date() >= decision_dt.date()


def candidate_signals(text: str, row: PracticeRow) -> dict[str, Any]:
    text_norm = normalize_text(text)
    padded = f" {text_norm} "
    num_hit = bool(row.decision_number_pattern.search(text_norm)) if row.decision_number_norm else False
    party_hit, party_needle = party_match_score(text_norm, row.party_norms)
    date_hit = any(f" {v} " in padded for v in date_variants(row.decision_date))
    return {
        "decision_number": num_hit,
        "decision_date": date_hit,
        "liable_party": party_hit,
        "party_needle": party_needle,
    }


def build_number_index(practice: list[PracticeRow]) -> dict[str, list[PracticeRow]]:
    out: dict[str, list[PracticeRow]] = defaultdict(list)
    for row in practice:
        if row.decision_number_norm:
            out[row.decision_number_norm].append(row)
    return dict(out)


def find_candidate_rows(
    text: str,
    doc: DocRow,
    number_index: dict[str, list[PracticeRow]],
) -> list[dict[str, Any]]:
    """Candidate gate agreed with the user: exact decision number is sufficient.

    Party/date are only corroborating signals and are passed to Gemini. No deterministic
    challenge/cancellation phrase is required here.
    """
    text_norm = normalize_text(text)
    candidates: list[dict[str, Any]] = []
    for number_norm, rows in number_index.items():
        if not rows:
            continue
        pattern = rows[0].decision_number_pattern
        if not pattern.search(text_norm):
            continue
        for row in rows:
            if not row_is_chronologically_possible(row, doc):
                continue
            signals = candidate_signals(text, row)
            if not signals["decision_number"]:
                continue
            strength = "number+party" if signals["liable_party"] else "number_only"
            candidates.append({
                "candidate_id": row.row_id,
                "decision_number": row.decision_number,
                "decision_date": row.decision_date,
                "liable_parties": row.liable_parties,
                "strength": strength,
                "signals": signals,
            })
    return candidates


def text_excerpt_for_gemini(text: str, candidates: list[dict[str, Any]], max_chars: int) -> str:
    """Build a bounded Gemini excerpt without batching or overlap-dedup optimization.

    We keep the beginning of the court document and add context around candidate decision numbers.
    Overlapping fragments are intentionally NOT merged in this version.
    """
    if len(text) <= max_chars:
        return text

    chunks: list[tuple[int, int]] = [(0, min(len(text), 8000))]
    lower = text.lower()
    for c in candidates:
        number = clean(c.get("decision_number"))
        visible_variants = [number, number.replace("-", " "), number.replace("№", "")]
        for variant in visible_variants:
            pos = lower.find(variant.lower())
            if pos >= 0:
                chunks.append((max(0, pos - 4500), min(len(text), pos + 6500)))
                break

    chunks.append((max(0, len(text) - 4000), len(text)))

    out: list[str] = []
    used = 0
    for start, end in chunks:
        chunk = text[start:end]
        if used + len(chunk) > max_chars:
            chunk = chunk[: max(0, max_chars - used)]
        if chunk:
            out.append(chunk)
            used += len(chunk)
        if used >= max_chars:
            break
    return "\n\n[...fragment boundary...]\n\n".join(out)


def build_gemini_prompt(
    cause_num: str,
    court_name: str,
    doc: DocRow,
    current_doc_form: str,
    candidates: list[dict[str, Any]],
    text_excerpt: str,
) -> str:
    compact_candidates = [
        {
            "candidate_id": c["candidate_id"],
            "decision_number": c["decision_number"],
            "decision_date": c["decision_date"],
            "liable_parties": c["liable_parties"],
            "prefilter_strength": c["strength"],
            "prefilter_signals": c["signals"],
        }
        for c in candidates
    ]
    return f"""Ти аналізуєш текст судового документа з ЄДРСР для бази практики АМКУ.

ЗАВДАННЯ 1 — ФАКТ ОСКАРЖЕННЯ:
Для КОЖНОГО candidate визнач лише YES або NO: чи є САМЕ зазначене рішення АМКУ БЕЗПОСЕРЕДНІМ ПРЕДМЕТОМ СУДОВОГО ОСКАРЖЕННЯ У ПОТОЧНІЙ СУДОВІЙ СПРАВІ {cause_num}.

Критерії:
- Формулювання позовної вимоги може бути будь-яким. Не вимагай сталої фрази.
- YES: у поточній справі суд безпосередньо перевіряє законність/дійсність саме candidate decision, повністю або в частині.
- NO: candidate decision лише згадується як передумова, доказ, історія іншої справи, підстава для штрафу/пені/виконання або інший контекст.
- Якщо у справі оскаржується ІНШЕ рішення АМКУ, яким candidate decision лише залишено без змін, підтверджено, змінено, переглянуто або щодо нього відмовлено в перегляді — поверни NO для candidate decision.
- Збіг повного номера вже перевірений кодом. Назва порушника і дата — лише допоміжні ознаки.
- Обов'язково YES або NO. Не використовуй UNCERTAIN/RELATED.

ЗАВДАННЯ 2 — ПОТОЧНИЙ СТАН СПОРУ:
Для кожного candidate з classification=YES визнач:
1) current_document_resolves_merits=true/false — чи саме цей акт вирішує по суті вимогу щодо законності/дійсності candidate decision.
2) current_document_invalidates_prior_merits=true/false — чи цей акт скасовує/усуває чинність попереднього судового акта по суті та залишає спір невирішеним (зокрема направляє справу на новий розгляд).
3) case_outcome — одне з:
   - ongoing: спір триває, остаточного актуального вирішення по суті немає; сюди ОБОВ'ЯЗКОВО належить направлення на новий розгляд після скасування попередніх судових актів;
   - upheld: актуальний судовий акт по суті відмовляє в оскарженні / залишає рішення АМКУ чинним;
   - overturned: актуальний судовий акт по суті повністю скасовує/визнає недійсним candidate decision;
   - partially_overturned: актуальний судовий акт по суті скасовує/визнає недійсним candidate decision лише частково;
   - not_applicable: тільки якщо classification=NO.

ВАЖЛИВО:
- Постанова, яка скасувала попередні судові рішення та направила справу на новий розгляд, НЕ є актуальним остаточним вирішенням законності рішення АМКУ. Для неї current_document_resolves_merits=false, current_document_invalidates_prior_merits=true, case_outcome=ongoing.
- Процесуальні акти про відкриття/повернення позову, залишення без розгляду, строки, забезпечення, зупинення/поновлення, підсудність, виправлення, судові витрати тощо: current_document_resolves_merits=false; якщо вони не скасовують попередній merits-акт — invalidates_prior_merits=false.
- Якщо classification=NO: resolves=false, invalidates=false, case_outcome=not_applicable.

Поверни ТІЛЬКИ валідний JSON без markdown:
{{
  "results": [
    {{
      "candidate_id": "...",
      "classification": "YES|NO",
      "confidence": "high|medium|low",
      "challenger": "коротка назва позивача/скаржника або порожньо",
      "current_document_resolves_merits": true,
      "current_document_invalidates_prior_merits": false,
      "case_outcome": "ongoing|upheld|overturned|partially_overturned|not_applicable",
      "reason": "дуже коротко, чому YES/NO",
      "status_reason": "дуже коротко, який поточний процесуальний/результативний стан"
    }}
  ]
}}

Суд: {court_name}
Номер поточної справи: {cause_num}
Дата документа: {doc.adjudication_date}
Форма документа за metadata: {current_doc_form}
Doc ID: {doc.doc_id}

CANDIDATES:
{json.dumps(compact_candidates, ensure_ascii=False, indent=2)}

ТЕКСТ СУДОВОГО ДОКУМЕНТА:
{text_excerpt}
"""

def build_merits_verification_prompt(
    cause_num: str,
    court_name: str,
    doc: DocRow,
    doc_form: str,
    candidate: dict[str, Any],
    text_excerpt: str,
) -> str:
    compact_candidate = {
        "candidate_id": candidate["candidate_id"],
        "decision_number": candidate["decision_number"],
        "decision_date": candidate["decision_date"],
        "liable_parties": candidate["liable_parties"],
    }
    return f"""Ти перевіряєш конкретний судовий акт у справі про оскарження рішення АМКУ.

Поточна судова справа: {cause_num}
Суд: {court_name}
Дата акта: {doc.adjudication_date}
Форма за metadata: {doc_form}
Doc ID: {doc.doc_id}

Рішення АМКУ:
{json.dumps(compact_candidate, ensure_ascii=False, indent=2)}

Визнач:
- resolves_merits=YES лише якщо цей акт реально вирішує по суті законність/дійсність саме зазначеного рішення АМКУ.
- invalidates_prior_merits=YES, якщо цей акт скасовує попередній судовий акт по суті та залишає спір невирішеним, зокрема направляє справу на новий розгляд. У такому випадку resolves_merits=NO і outcome=ongoing.
- Якщо resolves_merits=YES, outcome має бути одним з upheld / overturned / partially_overturned.
- Якщо resolves_merits=NO і invalidates_prior_merits=NO, outcome=ongoing.
- Акти про відкриття/повернення позову, залишення без розгляду, строки, забезпечення, зупинення/поновлення, підсудність, виправлення, судові витрати, виконання або процесуальну апеляцію/касацію — не є merits-актом.
- Якщо акт стосується іншого рішення АМКУ, а candidate лише згадується — resolves_merits=NO.

Поверни ТІЛЬКИ валідний JSON без markdown:
{{
  "resolves_merits": "YES|NO",
  "invalidates_prior_merits": "YES|NO",
  "outcome": "ongoing|upheld|overturned|partially_overturned",
  "confidence": "high|medium|low",
  "reason": "дуже коротко, чому"
}}

ТЕКСТ СУДОВОГО АКТА:
{text_excerpt}
"""


def build_current_status_verification_prompt(
    cause_num: str,
    court_name: str,
    current_doc: DocRow,
    current_doc_form: str,
    prior_merits: dict[str, Any],
    candidate: dict[str, Any],
    text_excerpt: str,
) -> str:
    compact_candidate = {
        "candidate_id": candidate["candidate_id"],
        "decision_number": candidate["decision_number"],
        "decision_date": candidate["decision_date"],
        "liable_parties": candidate["liable_parties"],
    }
    return f"""Ти перевіряєш ПОТОЧНИЙ ПРОЦЕСУАЛЬНИЙ СТАН судового оскарження рішення АМКУ.

У справі вже знайдено раніший судовий акт, який вирішив спір по суті.
Після нього в ЄДРСР є НОВІШИЙ судовий акт. Потрібно визначити, чи означає цей новіший акт, що перегляд рішення по суті ще триває.

Поточна справа: {cause_num}
Суд нового акта: {court_name}
Дата нового акта: {current_doc.adjudication_date}
Форма нового акта за metadata: {current_doc_form}
Doc ID нового акта: {current_doc.doc_id}

Рішення АМКУ:
{json.dumps(compact_candidate, ensure_ascii=False, indent=2)}

Попередній підтверджений акт по суті:
{json.dumps(prior_merits, ensure_ascii=False, indent=2)}

Поверни ОДИН status:
- ONGOING — новіший акт підтверджує, що апеляційний/касаційний або інший перегляд по суті ще триває. Наприклад: відкрито апеляційне/касаційне провадження, скаргу прийнято до розгляду, призначено розгляд, витребувано матеріали саме для такого перегляду, провадження поновлено тощо.
- FINAL_UNCHANGED — новіший акт НЕ робить перегляд по суті активним і не скасовує попередній merits-акт. Сюди належать, зокрема: відмова у відкритті апеляційного/касаційного провадження, повернення скарги, залишення скарги без розгляду, закриття апеляційного/касаційного провадження без перегляду по суті, відмова у поновленні строку, а також післярішеневі питання про виконання, судові витрати, виправлення описок тощо.
- INVALIDATES_PRIOR — новіший акт скасував/усунув чинність попереднього судового акта по суті та залишив спір невирішеним, зокрема направив справу на новий розгляд.

ВАЖЛИВО:
- Не вважай сам факт наявності новішої ухвали доказом ONGOING.
- Визначай статус лише зі змісту цього нового акта.
- Якщо новіший акт сам остаточно вирішує законність рішення АМКУ по суті, поверни FINAL_UNCHANGED: такий випадок має бути опрацьований як merits на іншому етапі, а тут ми лише перевіряємо, чи попередній результат перестав бути поточно-фінальним через подальший ПРОЦЕСУАЛЬНИЙ рух.

Поверни ТІЛЬКИ JSON без markdown:
{{
  "status": "ONGOING|FINAL_UNCHANGED|INVALIDATES_PRIOR",
  "confidence": "high|medium|low",
  "reason": "дуже коротко, що саме означає новіший акт"
}}

ТЕКСТ НОВІШОГО СУДОВОГО АКТА:
{text_excerpt}
"""


def build_weak_yes_safeguard_prompt(
    cause_num: str,
    court_name: str,
    doc: DocRow,
    candidate: dict[str, Any],
    text_excerpt: str,
) -> str:
    compact_candidate = {
        "candidate_id": candidate["candidate_id"],
        "decision_number": candidate["decision_number"],
        "decision_date": candidate["decision_date"],
        "liable_parties": candidate["liable_parties"],
    }
    return f"""Це контрольна перевірка слабкого YES для однакових/повторюваних номерів рішень АМКУ.

Судова справа: {cause_num}
Суд: {court_name}
Doc ID: {doc.doc_id}

Конкретний запис бази АМКУ:
{json.dumps(compact_candidate, ensure_ascii=False, indent=2)}

Перший аналіз уже дав YES, але в детермінованому пошуку НЕ збіглися ані дата рішення, ані назва порушника.
Поверни NO, якщо текст ЧІТКО показує, що йдеться про інше однойменне рішення АМКУ — наприклад, прямо вказана інша дата або інший контекст, який однозначно ідентифікує інше рішення.
Поверни YES, якщо текст не містить такого явного протиріччя і справді може стосуватися саме цього запису. Відсутність у тексті дати/назви сторони сама по собі НЕ є підставою для NO.

Поверни ТІЛЬКИ валідний JSON без markdown:
{{
  "classification": "YES|NO",
  "confidence": "high|medium|low",
  "reason": "дуже коротко"
}}

ТЕКСТ СУДОВОГО ДОКУМЕНТА:
{text_excerpt}
"""

def parse_json_loose(text: str) -> Any:
    s = clean(text)
    s = re.sub(r"^```(?:json)?\s*", "", s, flags=re.I)
    s = re.sub(r"\s*```$", "", s)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        start = s.find("{")
        end = s.rfind("}")
        if start >= 0 and end > start:
            return json.loads(s[start:end + 1])
        raise


def gemini_generate_json(
    prompt: str,
    api_key: str,
    model: str,
    timeout: int,
    retries: int,
) -> dict[str, Any]:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{urllib.parse.quote(model, safe='')}:generateContent?key={urllib.parse.quote(api_key, safe='')}"
    )
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
        },
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url,
                data=body,
                headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=max(timeout, 90)) as res:
                response = json.loads(res.read().decode("utf-8"))
            parts = (((response.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [])
            raw_text = "\n".join(clean(p.get("text")) for p in parts if isinstance(p, dict) and p.get("text"))
            parsed = parse_json_loose(raw_text)
            if not isinstance(parsed, dict):
                raise RuntimeError("Gemini response JSON is not an object")
            return parsed
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            last = RuntimeError(f"Gemini HTTP {exc.code}: {raw[:1000]}")
            if exc.code == 429 and attempt < retries:
                wait = 60 + 5 * attempt
                log(f"Gemini quota retry {attempt}/{retries}; sleep {wait}s")
                time.sleep(wait)
                continue
            if 500 <= exc.code < 600 and attempt < retries:
                wait = min(30, 2 ** attempt)
                log(f"Gemini server retry {attempt}/{retries}; sleep {wait}s")
                time.sleep(wait)
                continue
            break
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt >= retries:
                break
            wait = min(20, 2 ** attempt)
            log(f"Gemini retry {attempt}/{retries}: {exc}; sleep {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"Gemini request failed: {last}")


def classify_candidates_with_gemini(
    cause_num: str,
    court_name: str,
    doc: DocRow,
    current_doc_form: str,
    candidates: list[dict[str, Any]],
    text: str,
    api_key: str,
    model: str,
    timeout: int,
    retries: int,
    max_text_chars: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    excerpt = text_excerpt_for_gemini(text, candidates, max_text_chars)
    prompt = build_gemini_prompt(
        cause_num,
        court_name,
        doc,
        current_doc_form,
        candidates,
        excerpt,
    )
    response = gemini_generate_json(prompt, api_key, model, timeout, retries)
    results = response.get("results")
    if not isinstance(results, list):
        raise RuntimeError(f"Gemini JSON has no results[]: {json.dumps(response, ensure_ascii=False)[:1000]}")

    by_id = {clean(c["candidate_id"]): c for c in candidates}
    classified: list[dict[str, Any]] = []
    not_processed: list[dict[str, Any]] = []
    seen: set[str] = set()

    for item in results:
        if not isinstance(item, dict):
            continue
        cid = clean(item.get("candidate_id"))
        if cid not in by_id or cid in seen:
            continue
        seen.add(cid)
        cls = clean(item.get("classification")).upper()
        if cls not in {"YES", "NO"}:
            not_processed.append({
                **by_id[cid],
                "not_processed_reason": f"Gemini returned invalid classification: {cls or '<empty>'}",
            })
            continue
        conf = clean(item.get("confidence")).lower()
        if conf not in {"high", "medium", "low"}:
            conf = "low"
        resolves_raw = item.get("current_document_resolves_merits", False)
        resolves_merits = resolves_raw is True or clean(resolves_raw).lower() in {"true", "yes", "1"}
        invalidates_raw = item.get("current_document_invalidates_prior_merits", False)
        invalidates_prior = invalidates_raw is True or clean(invalidates_raw).lower() in {"true", "yes", "1"}
        outcome = clean(item.get("case_outcome")).lower()
        if cls == "NO":
            resolves_merits = False
            invalidates_prior = False
            outcome = "not_applicable"
        elif outcome not in CASE_OUTCOMES:
            outcome = "ongoing"
        if invalidates_prior:
            resolves_merits = False
            outcome = "ongoing"
        classified.append({
            **by_id[cid],
            "classification": cls,
            "gemini_confidence": conf,
            "challenger": clean(item.get("challenger")),
            "current_document_resolves_merits": resolves_merits,
            "current_document_invalidates_prior_merits": invalidates_prior,
            "case_outcome": outcome,
            "status_reason": clean(item.get("status_reason"))[:600],
            "reason": clean(item.get("reason"))[:600],
            "current_status_verified": True,
            "cache_source": "gemini",
        })

    for cid, candidate in by_id.items():
        if cid not in seen:
            not_processed.append({
                **candidate,
                "not_processed_reason": "Gemini did not return this candidate_id.",
            })

    return classified, not_processed, excerpt

def verify_merits_doc_with_gemini(
    cause_num: str,
    court_name: str,
    doc: DocRow,
    doc_form: str,
    candidate: dict[str, Any],
    text: str,
    api_key: str,
    model: str,
    timeout: int,
    retries: int,
    max_text_chars: int,
) -> dict[str, Any]:
    excerpt = text_excerpt_for_gemini(text, [candidate], max_text_chars)
    prompt = build_merits_verification_prompt(
        cause_num,
        court_name,
        doc,
        doc_form,
        candidate,
        excerpt,
    )
    response = gemini_generate_json(prompt, api_key, model, timeout, retries)
    value = clean(response.get("resolves_merits")).upper()
    invalidates_value = clean(response.get("invalidates_prior_merits")).upper()
    if value not in {"YES", "NO"}:
        raise RuntimeError(
            f"Gemini merits JSON has invalid resolves_merits: {json.dumps(response, ensure_ascii=False)[:1000]}"
        )
    if invalidates_value not in {"YES", "NO"}:
        invalidates_value = "NO"
    outcome = clean(response.get("outcome")).lower()
    if outcome not in CASE_OUTCOMES:
        outcome = "ongoing"
    resolves = value == "YES"
    invalidates = invalidates_value == "YES"
    if invalidates:
        resolves = False
        outcome = "ongoing"
    if resolves and outcome == "ongoing":
        # A substantive result must say what happened to the AMCU decision.
        resolves = False
    conf = clean(response.get("confidence")).lower()
    if conf not in {"high", "medium", "low"}:
        conf = "low"
    return {
        "resolves_merits": resolves,
        "invalidates_prior_merits": invalidates,
        "outcome": outcome,
        "gemini_confidence": conf,
        "reason": clean(response.get("reason"))[:600],
        "excerpt": excerpt,
    }


def verify_current_status_with_gemini(
    cause_num: str,
    court_name: str,
    current_doc: DocRow,
    current_doc_form: str,
    prior_merits: dict[str, Any],
    candidate: dict[str, Any],
    text: str,
    api_key: str,
    model: str,
    timeout: int,
    retries: int,
    max_text_chars: int,
) -> dict[str, Any]:
    excerpt = text_excerpt_for_gemini(text, [candidate], max_text_chars)
    prompt = build_current_status_verification_prompt(
        cause_num,
        court_name,
        current_doc,
        current_doc_form,
        prior_merits,
        candidate,
        excerpt,
    )
    response = gemini_generate_json(prompt, api_key, model, timeout, retries)
    status = clean(response.get("status")).upper()
    if status not in {"ONGOING", "FINAL_UNCHANGED", "INVALIDATES_PRIOR"}:
        raise RuntimeError(
            f"Gemini current-status JSON has invalid status: {json.dumps(response, ensure_ascii=False)[:1000]}"
        )
    conf = clean(response.get("confidence")).lower()
    if conf not in {"high", "medium", "low"}:
        conf = "low"
    return {
        "status": status,
        "gemini_confidence": conf,
        "reason": clean(response.get("reason"))[:600],
        "excerpt": excerpt,
    }


def verify_weak_yes_with_gemini(
    cause_num: str,
    court_name: str,
    doc: DocRow,
    candidate: dict[str, Any],
    text: str,
    api_key: str,
    model: str,
    timeout: int,
    retries: int,
    max_text_chars: int,
) -> dict[str, Any]:
    excerpt = text_excerpt_for_gemini(text, [candidate], max_text_chars)
    prompt = build_weak_yes_safeguard_prompt(cause_num, court_name, doc, candidate, excerpt)
    response = gemini_generate_json(prompt, api_key, model, timeout, retries)
    cls = clean(response.get("classification")).upper()
    if cls not in {"YES", "NO"}:
        raise RuntimeError(
            f"Gemini safeguard JSON has invalid classification: {json.dumps(response, ensure_ascii=False)[:1000]}"
        )
    conf = clean(response.get("confidence")).lower()
    if conf not in {"high", "medium", "low"}:
        conf = "low"
    return {
        "classification": cls,
        "gemini_confidence": conf,
        "reason": clean(response.get("reason"))[:600],
        "excerpt": excerpt,
    }

def csv_cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        w.writeheader()
        for row in rows:
            w.writerow({k: csv_cell(row.get(k)) for k in columns})



def date_only(value: str) -> str:
    dt = parse_date(value)
    return dt.strftime("%Y-%m-%d") if dt else clean(value)[:10]


def court_doc_payload(
    doc: DocRow | None,
    courts: dict[str, str],
    judgment_forms: dict[str, str],
) -> dict[str, Any] | None:
    if not doc:
        return None
    return {
        "doc_id": doc.doc_id,
        "type": clean(judgment_forms.get(doc.judgment_code, "")) or "Судовий акт",
        "date": date_only(doc.adjudication_date),
        "court": clean(courts.get(doc.court_code, "")),
        "url": PUBLIC_EDRSR_URL.format(doc_id=doc.doc_id),
    }


def status_label(code: str, detail: str = "") -> str:
    code = clean(code).lower()
    if code == "ongoing":
        detail_norm = normalize_text(detail)
        if "направ" in detail_norm and "нов" in detail_norm and "розгляд" in detail_norm:
            return "Справу направлено на новий розгляд"
    return CASE_STATUS_LABELS.get(code, CASE_STATUS_LABELS["ongoing"])


def status_result_summary(code: str, detail: str = "") -> str:
    return status_label(code, detail)


def case_freshness(case: dict[str, Any]) -> tuple[str, str]:
    latest = case.get("latest_relevant") or {}
    return (clean(latest.get("date")), clean(latest.get("doc_id")))


def merge_case(existing: dict[str, Any] | None, incoming: dict[str, Any]) -> dict[str, Any]:
    if not existing:
        return incoming

    old_years = set(existing.get("source_years") or [])
    new_years = set(incoming.get("source_years") or [])
    merged_years = sorted({int(y) for y in old_years | new_years if str(y).isdigit()})

    freshest = incoming if case_freshness(incoming) >= case_freshness(existing) else existing
    older = existing if freshest is incoming else incoming
    merged = dict(freshest)
    merged["source_years"] = merged_years

    # Keep the newest court act regardless of which yearly EDRSR package supplied it.
    relevant_candidates = [
        doc for doc in [existing.get("latest_relevant"), incoming.get("latest_relevant")]
        if isinstance(doc, dict) and clean(doc.get("doc_id"))
    ]
    if relevant_candidates:
        merged["latest_relevant"] = max(
            relevant_candidates,
            key=lambda d: (clean(d.get("date")), clean(d.get("doc_id"))),
        )

    # A later explicit remand/cancellation invalidates the previously current merits result.
    # Otherwise, an older substantive act remains useful as the latest merits reference even
    # when a newer yearly observation shows that the proceedings are still ongoing.
    if bool(freshest.get("invalidates_prior_merits")):
        merged["status"] = "ongoing"
        merged["latest_merits"] = None
    else:
        merits_candidates = [
            doc for doc in [existing.get("latest_merits"), incoming.get("latest_merits")]
            if isinstance(doc, dict) and clean(doc.get("doc_id"))
        ]
        if merits_candidates:
            merged["latest_merits"] = max(
                merits_candidates,
                key=lambda d: (clean(d.get("date")), clean(d.get("doc_id"))),
            )
        elif "latest_merits" not in merged:
            merged["latest_merits"] = None

        # Freshest observation controls whether the challenge is currently ongoing. If it is
        # final, use its final status; if it is ongoing, keep ongoing while retaining the last
        # non-invalidated merits act above for reference.
        merged["status"] = clean(freshest.get("status")).lower() or "ongoing"

    detail = clean(freshest.get("status_detail"))
    merged["status_detail"] = detail
    merged["status_label"] = status_label(merged["status"], detail)
    merged["result_summary"] = status_result_summary(merged["status"], detail)
    merged["invalidates_prior_merits"] = bool(freshest.get("invalidates_prior_merits"))
    merged["updated_at"] = max(clean(existing.get("updated_at")), clean(incoming.get("updated_at")))
    return merged


def aggregate_decision_record(decision_key: str, cases: list[dict[str, Any]]) -> dict[str, Any]:
    cases = sorted(cases, key=case_freshness, reverse=True)
    statuses = [clean(c.get("status")).lower() for c in cases]
    if any(s == "ongoing" for s in statuses):
        display_status = "ongoing"
    else:
        # For several proceedings, do not reinterpret a mix of successful and unsuccessful
        # challenges as a legal "partial cancellation" of the AMCU decision. The top-level
        # status is only a display priority: any full cancellation -> red/overturned; otherwise
        # any partial cancellation -> red/partially_overturned; only all-upheld -> green.
        has_overturned = any(s == "overturned" for s in statuses)
        has_partial = any(s == "partially_overturned" for s in statuses)
        if has_overturned:
            display_status = "overturned"
        elif has_partial:
            display_status = "partially_overturned"
        else:
            display_status = "upheld"

    preferred = [c for c in cases if c.get("status") == display_status]
    primary = (preferred or cases)[0]

    # Top-level display fields always come from the same primary case so the status,
    # case number and linked court act cannot accidentally refer to different proceedings.
    primary_merits = primary.get("latest_merits") or None
    primary_relevant = primary.get("latest_relevant") or None
    display_doc = primary_merits if display_status != "ongoing" else None
    if not display_doc:
        display_doc = primary_relevant

    return {
        "has_challenge": True,
        "decision_key": decision_key,
        "display_status": display_status,
        "display_status_label": status_label(display_status, clean(primary.get("status_detail"))),
        "primary_case_number": clean(primary.get("case_number")),
        "cases_count": len(cases),
        "display_url": clean((display_doc or {}).get("url")),
        "latest_merits": primary_merits,
        "latest_relevant": primary_relevant,
        "cases": cases,
    }


def read_registry(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "schema": REGISTRY_SCHEMA,
            "updated_at": None,
            "source_years": [],
            "decisions": {},
        }
    try:
        raw = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        raw = {}
    if not isinstance(raw, dict):
        raw = {}
    decisions = raw.get("decisions") if isinstance(raw.get("decisions"), dict) else {}
    return {
        "schema": REGISTRY_SCHEMA,
        "updated_at": raw.get("updated_at"),
        "source_years": raw.get("source_years") if isinstance(raw.get("source_years"), list) else [],
        "decisions": decisions,
    }


def merge_registry(
    path: Path,
    year: int,
    yes_rows: list[dict[str, Any]],
    courts: dict[str, str],
    judgment_forms: dict[str, str],
    replace_year: bool,
) -> dict[str, Any]:
    registry = read_registry(path)
    by_decision_case: dict[str, dict[str, dict[str, Any]]] = {}

    for decision_key, record in (registry.get("decisions") or {}).items():
        case_map: dict[str, dict[str, Any]] = {}
        for case in record.get("cases") or []:
            if not isinstance(case, dict) or not clean(case.get("case_number")):
                continue
            case_copy = dict(case)
            years = {int(y) for y in (case_copy.get("source_years") or []) if str(y).isdigit()}
            if replace_year and year in years:
                years.discard(year)
                if not years:
                    continue
                case_copy["source_years"] = sorted(years)
            case_map[clean(case_copy.get("case_number"))] = case_copy
        if case_map:
            by_decision_case[decision_key] = case_map

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for row in yes_rows:
        decision_key = clean(row.get("decision_key"))
        case_number = clean(row.get("cause_num"))
        if not decision_key or not case_number:
            continue
        status = clean(row.get("case_status")).lower()
        if status not in CASE_OUTCOMES:
            status = "ongoing"
        status_detail = clean(row.get("status_detail"))
        latest_relevant = row.get("latest_relevant") or None
        latest_merits = row.get("latest_merits") or None
        incoming = {
            "case_number": case_number,
            "challenger": clean(row.get("challenger")),
            "status": status,
            "status_label": status_label(status, status_detail),
            "status_detail": status_detail,
            "result_summary": status_result_summary(status, status_detail),
            "latest_merits": latest_merits,
            "latest_relevant": latest_relevant,
            "invalidates_prior_merits": bool(row.get("invalidates_prior_merits", False)),
            "source_years": [year],
            "matched_on_doc_id": clean(row.get("matched_on_doc_id")),
            "updated_at": now,
        }
        case_map = by_decision_case.setdefault(decision_key, {})
        case_map[case_number] = merge_case(case_map.get(case_number), incoming)

    decisions: dict[str, Any] = {}
    for decision_key, case_map in by_decision_case.items():
        cases = list(case_map.values())
        if cases:
            decisions[decision_key] = aggregate_decision_record(decision_key, cases)

    source_years = sorted({
        int(y)
        for record in decisions.values()
        for case in (record.get("cases") or [])
        for y in (case.get("source_years") or [])
        if str(y).isdigit()
    })
    return {
        "schema": REGISTRY_SCHEMA,
        "updated_at": now,
        "source_years": source_years,
        "decisions": decisions,
    }


def is_discovery_eligible(row: PracticeRow) -> bool:
    """Exclude only explicit closure/no-violation decisions from NEW-case discovery.

    All other outcomes, including legacy rows without decision_outcome, remain eligible.
    This filter never removes already-confirmed cases from history enrichment.
    """
    return clean(row.raw.get("decision_outcome")) != "proceeding_closed_no_violation"


def known_case_links_from_registry(registry: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """Map confirmed cause_num -> decision links already present in the registry."""
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for decision_key, record in (registry.get("decisions") or {}).items():
        for case in record.get("cases") or []:
            if not isinstance(case, dict):
                continue
            case_number = clean(case.get("case_number"))
            if not case_number:
                continue
            out[case_number].append({
                "decision_key": clean(decision_key),
                "case": dict(case),
            })
    return dict(out)


def history_row_from_known_case(
    practice_row: PracticeRow,
    case_number: str,
    existing_case: dict[str, Any],
    entry: dict[str, Any],
    courts: dict[str, str],
    judgment_forms: dict[str, str],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Create a confirmed-YES work item without re-running challenge discovery.

    The decision<->case relation has already been confirmed in a prior run. Gemini is used
    only later, if needed, to classify substantive/result documents for this yearly history.
    """
    raw_latest_form: DocRow | None = entry.get("latest_merits")
    primary_doc: DocRow = entry["doc"]
    latest_relevant_payload = court_doc_payload(entry.get("latest_active"), courts, judgment_forms)
    prior_merits = existing_case.get("latest_merits") if isinstance(existing_case.get("latest_merits"), dict) else None
    prior_status = clean(existing_case.get("status")).lower()
    if prior_status not in CASE_OUTCOMES:
        prior_status = "ongoing"

    result = {
        "candidate_id": practice_row.row_id,
        "decision_number": practice_row.decision_number,
        "decision_date": practice_row.decision_date,
        "liable_parties": practice_row.liable_parties,
        "strength": "known_case_history",
        "signals": {
            "decision_number": False,
            "decision_date": False,
            "liable_party": False,
            "party_needle": "",
        },
        "classification": "YES",
        "gemini_confidence": "registry_confirmed",
        "challenger": clean(existing_case.get("challenger")),
        "reason": "Known confirmed decision/case link from persistent registry; direct-challenge Gemini classification skipped for history enrichment.",
        "current_document_resolves_merits": False,
        "current_document_invalidates_prior_merits": False,
        "case_outcome": prior_status,
        "current_status_verified": False,
        "cache_source": "known_case_registry",
        "status_reason": clean(existing_case.get("status_detail")),
    }

    row = {
        "decision_key": practice_row.row_id,
        "decision_number": practice_row.decision_number,
        "decision_date": practice_row.decision_date,
        "liable_parties": practice_row.liable_parties,
        "prefilter_strength": "known_case_history",
        "signals": result["signals"],
        "classification": "YES",
        "gemini_confidence": "registry_confirmed",
        "challenger": clean(existing_case.get("challenger")),
        "reason": result["reason"],
        "current_document_resolves_merits": False,
        "current_document_invalidates_prior_merits": False,
        "current_document_case_outcome": prior_status,
        "current_status_verified": False,
        "classification_cache_source": "known_case_registry",
        "status_detail": clean(existing_case.get("status_detail")),
        "cause_num": case_number,
        "matched_on_doc_id": primary_doc.doc_id,
        "matched_on_source": "known_case_history",
        "primary_doc_id": primary_doc.doc_id,
        "primary_kind": entry.get("primary_kind", "history"),
        "court": entry.get("court", ""),
        "category_code": primary_doc.category_code,
        "category_name": entry.get("category_name", ""),
        "latest_form_doc_id": raw_latest_form.doc_id if raw_latest_form else "",
        "latest_form_type": judgment_forms.get(raw_latest_form.judgment_code, "") if raw_latest_form else "",
        "latest_form_date": raw_latest_form.adjudication_date if raw_latest_form else "",
        "latest_relevant": latest_relevant_payload,
        "latest_merits": prior_merits,
        "latest_merits_doc_id": clean((prior_merits or {}).get("doc_id")),
        "latest_merits_type": clean((prior_merits or {}).get("type")),
        "latest_merits_date": clean((prior_merits or {}).get("date")),
        "latest_merits_court": clean((prior_merits or {}).get("court")),
        "latest_merits_url": clean((prior_merits or {}).get("url")),
        "merits_gemini_confidence": "",
        "merits_reason": "",
        "challenge_status": "history_prior_merits" if prior_merits else "",
        "case_status": prior_status if prior_merits else "ongoing",
        "invalidates_prior_merits": False,
    }
    return row, result

def main() -> int:
    args = parse_args()
    year = args.year
    dataset_id = args.dataset_id or DATASET_IDS[year]
    practice_path = Path(args.practice)
    registry_path = Path(args.registry)
    out_dir = Path(args.out_dir)
    cache_dir = Path(args.cache_dir)
    ai_cache_path = Path(args.ai_cache)
    seed_cache_path = Path(args.seed_cache) if clean(args.seed_cache) else None
    ensure_dir(out_dir)
    ensure_dir(cache_dir)
    ensure_dir(ai_cache_path.parent)
    ai_cache = load_ai_cache(ai_cache_path)
    # Ensure the checkpoint path exists even if the run fails before the first Gemini call.
    atomic_write_json(ai_cache_path, ai_cache)

    practice = load_practice(practice_path)
    discovery_practice = [row for row in practice if is_discovery_eligible(row)]
    excluded_closed_practice = [row for row in practice if not is_discovery_eligible(row)]
    number_index = build_number_index(discovery_practice)
    practice_by_key = {row.row_id: row for row in practice}

    registry_snapshot = read_registry(registry_path)
    known_case_links = known_case_links_from_registry(registry_snapshot)
    known_case_numbers = set(known_case_links)

    focus_norm = normalized_number(args.focus_decision)
    focus_rows = [r for r in practice if focus_norm and r.decision_number_norm == focus_norm]
    focus_debug: dict[str, Any] = {
        "focus_decision": args.focus_decision,
        "practice_rows": [
            {
                "candidate_id": r.row_id,
                "decision_number": r.decision_number,
                "decision_date": r.decision_date,
                "liable_parties": r.liable_parties,
            }
            for r in focus_rows
        ],
        "candidate_hits": [],
        "negative_prefilter_hits": [],
        "negative_prefilter_bypassed_fallback": [],
        "gemini_results": [],
        "merits_verification": [],
        "current_status_verification": [],
        "not_processed": [],
        "fetch_failures": [],
    }

    log(
        f"Practice rows: {len(practice):,}; discovery-eligible={len(discovery_practice):,}; "
        f"excluded proceeding_closed_no_violation={len(excluded_closed_practice):,}; "
        f"unique discovery decision numbers={len(number_index):,}; "
        f"known confirmed court cases={len(known_case_numbers):,}"
    )
    if args.focus_decision:
        log(f"Focus `{args.focus_decision}` corresponds to {len(focus_rows)} practice row(s).")

    zip_url = fetch_passport_zip_url(year, dataset_id, args.request_timeout, args.retries)
    log(f"EDRSR ZIP: {zip_url}")
    zip_path = cache_dir / f"edrsr_data_{year}.zip"
    download_file(zip_url, zip_path, max(args.request_timeout, 120), args.retries)

    fetch_stats = {
        "documents_requested": 0,
        "validated_documents": 0,
        "cache_hits": 0,
        "fetch_errors": 0,
        "primary_documents": 0,
        "fallback_documents": 0,
        "merits_documents": 0,
        "current_status_documents": 0,
        "fallback_candidate_cases": 0,
        "candidate_documents_before_negative_filter": 0,
        "candidate_pairs_before_negative_filter": 0,
        "negative_prefilter_cases": 0,
        "negative_prefilter_pairs": 0,
        "negative_prefilter_bypassed_fallback_cases": 0,
        "negative_prefilter_bypassed_fallback_pairs": 0,
        "candidate_documents": 0,
        "candidate_pairs": 0,
        "weak_yes_safeguard_calls": 0,
        "weak_yes_rejected": 0,
        "known_history_work_items": 0,
        "known_history_current_refresh": 0,
        "known_history_backfill_merits": 0,
        "known_history_skipped_existing_merits": 0,
        "known_history_skipped_duplicate_discovery": 0,
        "known_confirmed_pairs_reused": 0,
        "known_confirmed_cases_fully_skipped": 0,
        "known_confirmed_cases_partially_deduped": 0,
    }
    registry_write_blocked_reason = ""
    ai_stats = {
        "challenge_cache_hits": 0,
        "challenge_seed_hits": 0,
        "challenge_cache_writes": 0,
        "challenge_targeted_retry_calls": 0,
        "challenge_targeted_retry_recovered": 0,
        "safeguard_cache_hits": 0,
        "safeguard_cache_writes": 0,
        "merits_cache_hits": 0,
        "merits_seed_hits": 0,
        "current_status_cache_hits": 0,
        "current_status_cache_writes": 0,
        "merits_cache_writes": 0,
    }

    with zipfile.ZipFile(zip_path, "r") as zf:
        categories = read_dict_tsv(zf, "cause_categories.csv", "category_code")
        judgment_forms = read_dict_tsv(zf, "judgment_forms.csv", "judgment_code")
        courts = read_dict_tsv(zf, "courts.csv", "court_code")
        justice = read_dict_tsv(zf, "justice_kinds.csv", "justice_kind")

        cat_codes = relevant_category_codes(categories)
        primary_cat_codes = primary_challenge_category_codes(categories)
        commercial_codes = {
            code for code, name in justice.items()
            if COMMERCIAL_JUSTICE_RE.search(name or "")
        }
        if not commercial_codes:
            raise RuntimeError("Commercial justice_kind code was not found in justice_kinds.csv")

        log(f"Relevant exact category codes: {len(cat_codes)}")
        for code in sorted(cat_codes):
            log(f"  {code}: {categories.get(code, '')}")
        log(
            "Commercial justice codes: "
            + ", ".join(f"{code}={justice.get(code, '')}" for code in sorted(commercial_codes))
        )

        cases, stats, category_stats, justice_stats, known_history_docs = scan_prefilter(
            zf,
            cat_codes,
            commercial_codes,
            known_case_numbers,
        )

        log(
            "Prefilter: "
            f"rows={stats['rows_total']:,}; "
            f"active={stats['active']:,}; "
            f"category={stats['category_match']:,}; "
            f"commercial={stats['commercial_match']:,}; "
            f"with_case={stats['with_cause_num']:,}; "
            f"cases={stats['cases']:,}; "
            f"known_history_cases_found={stats['known_history_cases_found']:,}; "
            f"known_history_documents={stats['known_history_documents']:,}"
        )

        ordered_cases = sorted(
            cases.items(),
            key=lambda kv: (
                1 if any(d.category_code in primary_cat_codes for d in kv[1]) else 0,
                max((doc_sort_key(d) for d in kv[1]), default=((0, ""), (0, ""), 0)),
            ),
            reverse=True,
        )
        if args.max_cases > 0:
            ordered_cases = ordered_cases[:args.max_cases]

        prefilter_rows: list[dict[str, Any]] = []
        jobs: list[tuple[str, DocRow, str, DocRow | None, list[DocRow]]] = []

        for cause_num, docs in ordered_cases:
            primary, primary_kind = primary_discovery_doc(docs, judgment_forms)
            earliest = earliest_active(docs)
            merits = latest_merits(docs, judgment_forms)
            latest = latest_active(docs)
            if not primary:
                continue

            prefilter_rows.append({
                "cause_num": cause_num,
                "documents": len(docs),
                "category_code": primary.category_code,
                "category_name": categories.get(primary.category_code, ""),
                "justice_kind": justice.get(primary.justice_kind, primary.justice_kind),
                "primary_kind": primary_kind,
                "primary_doc_id": primary.doc_id,
                "primary_date": primary.adjudication_date,
                "earliest_doc_id": earliest.doc_id if earliest else "",
                "earliest_date": earliest.adjudication_date if earliest else "",
                "latest_active_doc_id": latest.doc_id if latest else "",
                "latest_active_date": latest.adjudication_date if latest else "",
                "latest_merits_doc_id": merits.doc_id if merits else "",
                "latest_merits_date": merits.adjudication_date if merits else "",
                "latest_merits_form": judgment_forms.get(merits.judgment_code, "") if merits else "",
            })
            jobs.append((cause_num, primary, primary_kind, earliest, docs))

        candidate_docs: list[dict[str, Any]] = []
        negative_prefilter_rows: list[dict[str, Any]] = []
        negative_prefilter_bypassed_rows: list[dict[str, Any]] = []
        fetch_errors: list[dict[str, Any]] = []
        text_cache_for_gemini: dict[str, str] = {}

        def fetch_one(doc: DocRow) -> tuple[str, dict[str, Any]]:
            return fetch_doc_text(
                doc,
                cache_dir / "texts",
                args.request_timeout,
                args.retries,
                args.request_delay_ms,
            )

        def worker(job: tuple[str, DocRow, str, DocRow | None, list[DocRow]]) -> dict[str, Any]:
            cause_num, primary, primary_kind, earliest, docs = job
            fetch_records: list[dict[str, Any]] = []
            primary_text = ""
            primary_meta: dict[str, Any] = {}
            primary_error: dict[str, Any] | None = None

            try:
                primary_text, primary_meta = fetch_one(primary)
                fetch_records.append({"role": "primary", "doc": primary, "meta": primary_meta, "ok": True})
            except Exception as exc:  # noqa: BLE001
                primary_error = {
                    "role": "primary",
                    "doc_id": primary.doc_id,
                    "doc_url": primary.doc_url,
                    "error": str(exc),
                    "attempts": exc.attempts if isinstance(exc, DocumentFetchError) else [],
                }
                fetch_records.append({"role": "primary", "doc": primary, "ok": False, **primary_error})

            candidates: list[dict[str, Any]] = []
            candidate_doc = primary
            candidate_text = primary_text
            candidate_meta = primary_meta
            candidate_source = primary_kind

            if primary_text:
                candidates = find_candidate_rows(primary_text, primary, number_index)

            fallback_used = False
            fallback_error: dict[str, Any] | None = None
            if not candidates and earliest and earliest.doc_id != primary.doc_id:
                fallback_used = True
                try:
                    fallback_text, fallback_meta = fetch_one(earliest)
                    fetch_records.append({"role": "earliest_fallback", "doc": earliest, "meta": fallback_meta, "ok": True})
                    fallback_candidates = find_candidate_rows(fallback_text, earliest, number_index)
                    if fallback_candidates:
                        candidates = fallback_candidates
                        candidate_doc = earliest
                        candidate_text = fallback_text
                        candidate_meta = fallback_meta
                        candidate_source = "earliest_fallback"
                except Exception as exc:  # noqa: BLE001
                    fallback_error = {
                        "role": "earliest_fallback",
                        "doc_id": earliest.doc_id,
                        "doc_url": earliest.doc_url,
                        "error": str(exc),
                        "attempts": exc.attempts if isinstance(exc, DocumentFetchError) else [],
                    }
                    fetch_records.append({"role": "earliest_fallback", "doc": earliest, "ok": False, **fallback_error})

            negative = amcu_plaintiff_negative_prefilter(primary_text) if primary_text else {
                "exclude": False,
                "amcu_plaintiff": False,
                "counterclaim_against_amcu": False,
                "preamble_chars_checked": 0,
            }

            if not primary_text and not candidate_text:
                return {
                    "ok": False,
                    "cause_num": cause_num,
                    "doc": primary,
                    "error": primary_error or fallback_error or {"error": "No validated court text"},
                    "fetch_records": fetch_records,
                }

            return {
                "ok": True,
                "cause_num": cause_num,
                "primary_doc": primary,
                "primary_kind": primary_kind,
                "primary_text": primary_text,
                "primary_meta": primary_meta,
                "candidate_doc": candidate_doc,
                "candidate_text": candidate_text,
                "candidate_meta": candidate_meta,
                "candidate_source": candidate_source,
                "docs": docs,
                "candidates": candidates,
                "negative": negative,
                "fallback_used": fallback_used,
                "fetch_records": fetch_records,
            }

        workers = max(1, min(8, args.workers))
        log(
            f"Discovery scan: {len(jobs):,} cases; primary=latest merits else latest active; "
            f"earliest fallback only when primary has no exact AMCU number; workers={workers}"
        )

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(worker, job): job[0] for job in jobs}
            done_count = 0
            for future in as_completed(futures):
                done_count += 1
                result = future.result()

                for fr in result.get("fetch_records", []):
                    fetch_stats["documents_requested"] += 1
                    if fr.get("role") == "primary":
                        fetch_stats["primary_documents"] += 1
                    elif fr.get("role") == "earliest_fallback":
                        fetch_stats["fallback_documents"] += 1
                    if fr.get("ok"):
                        fetch_stats["validated_documents"] += 1
                        if fr.get("meta", {}).get("cache_hit"):
                            fetch_stats["cache_hits"] += 1
                    else:
                        fetch_stats["fetch_errors"] += 1
                        fetch_errors.append({
                            "cause_num": result.get("cause_num", ""),
                            "role": fr.get("role", ""),
                            "doc_id": fr.get("doc_id", ""),
                            "doc_url": fr.get("doc_url", ""),
                            "error": fr.get("error", ""),
                            "attempts": fr.get("attempts", []),
                        })

                if not result.get("ok"):
                    if focus_norm:
                        focus_debug["fetch_failures"].append({
                            "cause_num": result.get("cause_num", ""),
                            "error": result.get("error", {}),
                        })
                    continue

                candidates = result["candidates"]
                if result.get("fallback_used") and candidates and result.get("candidate_source") == "earliest_fallback":
                    fetch_stats["fallback_candidate_cases"] += 1

                if candidates:
                    fetch_stats["candidate_documents_before_negative_filter"] += 1
                    fetch_stats["candidate_pairs_before_negative_filter"] += len(candidates)

                    doc: DocRow = result["candidate_doc"]
                    primary_doc: DocRow = result["primary_doc"]
                    docs: list[DocRow] = result["docs"]
                    merits = latest_merits(docs, judgment_forms)
                    negative = result["negative"]

                    # Safety rule: the AMCU-plaintiff negative filter may hard-drop a case only
                    # when the exact AMCU decision number was found in the SAME primary/latest
                    # document on which the plaintiff-role check was performed.
                    #
                    # If the exact number was found only in earliest_fallback, a later primary
                    # document can describe a different procedural phase (including AMCU enforcement)
                    # and cannot safely exclude a challenge that is visible in the earlier document.
                    negative_filter_applicable = result["candidate_source"] != "earliest_fallback"
                    negative_should_drop = bool(negative.get("exclude") and negative_filter_applicable)

                    if negative.get("exclude") and not negative_filter_applicable:
                        fetch_stats["negative_prefilter_bypassed_fallback_cases"] += 1
                        fetch_stats["negative_prefilter_bypassed_fallback_pairs"] += len(candidates)
                        for c in candidates:
                            negative_prefilter_bypassed_rows.append({
                                "decision_number": c["decision_number"],
                                "decision_date": c["decision_date"],
                                "liable_parties": c["liable_parties"],
                                "strength": c["strength"],
                                "signals": c["signals"],
                                "cause_num": result["cause_num"],
                                "matched_on_doc_id": doc.doc_id,
                                "matched_on_source": result["candidate_source"],
                                "primary_doc_id": primary_doc.doc_id,
                                "primary_kind": result["primary_kind"],
                                "negative_prefilter": negative,
                                "reason": "Hard drop bypassed: exact AMCU decision number was found only in earliest fallback; the later primary document cannot safely exclude a challenge found in a different document.",
                            })
                        if focus_norm and any(normalized_number(c["decision_number"]) == focus_norm for c in candidates):
                            focus_debug["negative_prefilter_bypassed_fallback"].append({
                                "cause_num": result["cause_num"],
                                "primary_doc_id": primary_doc.doc_id,
                                "candidate_doc_id": doc.doc_id,
                                "negative_prefilter": negative,
                                "candidates": [c for c in candidates if normalized_number(c["decision_number"]) == focus_norm],
                            })

                    if negative_should_drop:
                        fetch_stats["negative_prefilter_cases"] += 1
                        fetch_stats["negative_prefilter_pairs"] += len(candidates)
                        for c in candidates:
                            negative_prefilter_rows.append({
                                "decision_number": c["decision_number"],
                                "decision_date": c["decision_date"],
                                "liable_parties": c["liable_parties"],
                                "strength": c["strength"],
                                "signals": c["signals"],
                                "cause_num": result["cause_num"],
                                "matched_on_doc_id": doc.doc_id,
                                "matched_on_source": result["candidate_source"],
                                "primary_doc_id": primary_doc.doc_id,
                                "primary_kind": result["primary_kind"],
                                "negative_prefilter": negative,
                                "reason": "The same primary/latest document both contains the exact AMCU decision number and explicitly identifies AMCU as plaintiff, with no counterclaim against AMCU.",
                            })
                        if focus_norm and any(normalized_number(c["decision_number"]) == focus_norm for c in candidates):
                            focus_debug["negative_prefilter_hits"].append({
                                "cause_num": result["cause_num"],
                                "primary_doc_id": primary_doc.doc_id,
                                "candidate_doc_id": doc.doc_id,
                                "negative_prefilter": negative,
                                "candidates": [c for c in candidates if normalized_number(c["decision_number"]) == focus_norm],
                            })
                    else:
                        fetch_stats["candidate_documents"] += 1
                        fetch_stats["candidate_pairs"] += len(candidates)
                        entry = {
                            "cause_num": result["cause_num"],
                            "doc": doc,
                            "text": result["candidate_text"],
                            "court": courts.get(doc.court_code, ""),
                            "category_code": doc.category_code,
                            "category_name": categories.get(doc.category_code, ""),
                            "candidates": candidates,
                            "fetch_meta": result["candidate_meta"],
                            "candidate_source": result["candidate_source"],
                            "primary_doc": primary_doc,
                            "primary_kind": result["primary_kind"],
                            "negative_prefilter": negative,
                            "latest_merits": merits,
                            "latest_active": latest_active(docs),
                            "docs": docs,
                        }
                        candidate_docs.append(entry)
                        text_cache_for_gemini[doc.doc_id] = result["candidate_text"]

                        if focus_norm and any(normalized_number(c["decision_number"]) == focus_norm for c in candidates):
                            focus_debug["candidate_hits"].append({
                                "cause_num": result["cause_num"],
                                "doc_id": doc.doc_id,
                                "doc_date": doc.adjudication_date,
                                "candidate_source": result["candidate_source"],
                                "primary_doc_id": primary_doc.doc_id,
                                "primary_kind": result["primary_kind"],
                                "negative_prefilter": negative,
                                "content_type": result["candidate_meta"].get("content_type", ""),
                                "decoder": result["candidate_meta"].get("decoder", ""),
                                "validation": result["candidate_meta"].get("validation", {}),
                                "candidates": [c for c in candidates if normalized_number(c["decision_number"]) == focus_norm],
                                "text_preview": normalize_text(result["candidate_text"])[:1400],
                            })

                if done_count == 1 or done_count % 100 == 0 or done_count == len(jobs):
                    log(
                        f"Discovery progress {done_count}/{len(jobs)}; "
                        f"candidate_cases(before negative)={fetch_stats['candidate_documents_before_negative_filter']}; "
                        f"negative_dropped={fetch_stats['negative_prefilter_cases']}; "
                        f"to_gemini={fetch_stats['candidate_documents']}; "
                        f"errors={fetch_stats['fetch_errors']}"
                    )

        # Known-pair dedup: if decision<->case is already confirmed in the persistent registry,
        # do not spend Gemini again on the direct-challenge question. The known-case history
        # stage below will still inspect that cause_num when historical enrichment is useful.
        known_confirmed_pairs = {
            (clean(link.get("decision_key")), clean(case_number))
            for case_number, links in known_case_links.items()
            for link in (links or [])
            if clean(link.get("decision_key")) and clean(case_number)
        }

        deduped_candidate_docs: list[dict[str, Any]] = []
        for entry in candidate_docs:
            original_candidates = list(entry.get("candidates") or [])
            new_candidates = [
                candidate
                for candidate in original_candidates
                if (clean(candidate.get("candidate_id")), clean(entry.get("cause_num")))
                not in known_confirmed_pairs
            ]
            reused_count = len(original_candidates) - len(new_candidates)
            if reused_count:
                fetch_stats["known_confirmed_pairs_reused"] += reused_count
                if not new_candidates:
                    fetch_stats["known_confirmed_cases_fully_skipped"] += 1
                else:
                    fetch_stats["known_confirmed_cases_partially_deduped"] += 1
            if new_candidates:
                entry = dict(entry)
                entry["candidates"] = new_candidates
                deduped_candidate_docs.append(entry)

        candidate_docs = deduped_candidate_docs
        log(
            "Known-pair dedup: "
            f"reused_pairs={fetch_stats['known_confirmed_pairs_reused']:,}; "
            f"fully_skipped_cases={fetch_stats['known_confirmed_cases_fully_skipped']:,}; "
            f"partially_deduped_cases={fetch_stats['known_confirmed_cases_partially_deduped']:,}; "
            f"new_candidate_cases={len(candidate_docs):,}"
        )

        # Stronger corroborating signals first if the Gemini budget is smaller than the candidate set.
        candidate_docs.sort(
            key=lambda e: (
                1 if any(c["signals"].get("liable_party") and c["signals"].get("decision_date") for c in e["candidates"]) else 0,
                1 if any(c["strength"] == "number+party" for c in e["candidates"]) else 0,
                doc_sort_key(e["doc"]),
            ),
            reverse=True,
        )

        candidate_rows: list[dict[str, Any]] = []
        for entry in candidate_docs:
            doc: DocRow = entry["doc"]
            merits: DocRow | None = entry["latest_merits"]
            for c in entry["candidates"]:
                candidate_rows.append({
                    "decision_number": c["decision_number"],
                    "decision_date": c["decision_date"],
                    "liable_parties": c["liable_parties"],
                    "strength": c["strength"],
                    "signals": c["signals"],
                    "cause_num": entry["cause_num"],
                    "doc_id": doc.doc_id,
                    "doc_date": doc.adjudication_date,
                    "candidate_source": entry["candidate_source"],
                    "primary_doc_id": entry["primary_doc"].doc_id,
                    "primary_kind": entry["primary_kind"],
                    "court": entry["court"],
                    "category_code": entry["category_code"],
                    "category_name": entry["category_name"],
                    "latest_merits_doc_id": merits.doc_id if merits else "",
                    "latest_merits_date": merits.adjudication_date if merits else "",
                })

        api_key = clean(os.environ.get("GEMINI_API_KEY"))
        gemini_model = clean(os.environ.get("GEMINI_MODEL")) or DEFAULT_GEMINI_MODEL
        approved_seed = load_approved_seed(
            seed_cache_path,
            year=year,
            dataset_id=dataset_id,
            zip_url=zip_url,
            model=gemini_model,
        )
        approved_merits_seed = load_approved_merits_seed(
            seed_cache_path,
            year=year,
            dataset_id=dataset_id,
            model=gemini_model,
        )
        log(
            f"AI checkpoint entries restored: {len(ai_cache.get('entries') or {}):,}; "
            f"approved challenge seed entries: {len(approved_seed):,}; "
            f"approved merits/status seed entries: {len(approved_merits_seed):,}"
        )
        if candidate_docs and not args.skip_gemini and not api_key and not approved_seed and not (ai_cache.get("entries") or {}):
            raise RuntimeError("GEMINI_API_KEY is required because exact-number candidates were found and no reusable AI results are available.")

        yes_rows: list[dict[str, Any]] = []
        no_rows: list[dict[str, Any]] = []
        not_processed_rows: list[dict[str, Any]] = []
        gemini_errors: list[dict[str, Any]] = []
        merits_verification_rows: list[dict[str, Any]] = []
        safeguard_rows: list[dict[str, Any]] = []
        yes_work_items: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any]]] = []

        gemini_calls = 0
        targeted_retry_calls = 0
        safeguard_gemini_calls = 0
        merits_gemini_calls = 0
        current_status_gemini_calls = 0
        current_status_verification_rows: list[dict[str, Any]] = []
        min_call_interval = 60.0 / max(1, args.gemini_rpm_limit) if args.gemini_rpm_limit > 0 else 0.0
        last_call_started = 0.0

        def wait_for_gemini_slot() -> None:
            nonlocal last_call_started
            elapsed = time.monotonic() - last_call_started
            if last_call_started and min_call_interval > 0 and elapsed < min_call_interval:
                time.sleep(min_call_interval - elapsed)
            last_call_started = time.monotonic()

        # Stage 1: determine whether each candidate AMCU decision is directly challenged in the case.
        # Results are checkpointed per candidate. A failed/partial run therefore resumes from the
        # missing candidate(s) instead of repeating every case-level Gemini call.
        for entry in candidate_docs:
            doc: DocRow = entry["doc"]
            raw_latest_form: DocRow | None = entry["latest_merits"]
            text = text_cache_for_gemini.get(doc.doc_id, "")
            doc_text_hash = text_sha256(text)
            candidates = entry["candidates"]
            current_doc_form = judgment_forms.get(doc.judgment_code, "")

            classified: list[dict[str, Any]] = []
            unresolved_candidates: list[dict[str, Any]] = []
            technical_not_processed: list[dict[str, Any]] = []

            # 1A. Reuse persistent checkpoints first; then the approved v6 recovery seed.
            for candidate in candidates:
                cid = clean(candidate.get("candidate_id"))
                cached = ai_cache_get(
                    ai_cache,
                    stage="challenge",
                    year=year,
                    cause_num=entry["cause_num"],
                    doc_id=doc.doc_id,
                    decision_key=cid,
                    model=gemini_model,
                    version=CHALLENGE_CACHE_VERSION,
                    text_hash=doc_text_hash,
                )
                if cached:
                    ai_stats["challenge_cache_hits"] += 1
                    classified.append({**candidate, **cached, "cache_source": cached.get("cache_source", "checkpoint")})
                    continue

                seed = approved_seed.get((entry["cause_num"], doc.doc_id, cid))
                if seed:
                    result = result_from_seed(candidate, seed)
                    classified.append(result)
                    ai_stats["challenge_seed_hits"] += 1
                    ai_cache_put(
                        ai_cache_path,
                        ai_cache,
                        stage="challenge",
                        year=year,
                        cause_num=entry["cause_num"],
                        doc_id=doc.doc_id,
                        decision_key=cid,
                        model=gemini_model,
                        version=CHALLENGE_CACHE_VERSION,
                        text_hash=doc_text_hash,
                        result=result,
                        source="approved_probe_v6_seed",
                    )
                    ai_stats["challenge_cache_writes"] += 1
                    continue

                unresolved_candidates.append(candidate)

            # 1B. Only genuinely missing candidates consume a normal challenge call.
            partial_not_processed: list[dict[str, Any]] = []
            if unresolved_candidates:
                if args.skip_gemini:
                    partial_not_processed = [
                        {**c, "not_processed_reason": "Gemini skipped by --skip-gemini."}
                        for c in unresolved_candidates
                    ]
                elif not api_key:
                    partial_not_processed = [
                        {**c, "not_processed_reason": "GEMINI_API_KEY is unavailable for uncached challenge candidates."}
                        for c in unresolved_candidates
                    ]
                elif gemini_calls >= args.max_gemini_calls:
                    partial_not_processed = [
                        {**c, "not_processed_reason": f"Gemini challenge-classification call budget exceeded ({args.max_gemini_calls})."}
                        for c in unresolved_candidates
                    ]
                else:
                    wait_for_gemini_slot()
                    gemini_calls += 1
                    log(
                        f"Gemini challenge {gemini_calls}/{args.max_gemini_calls}: "
                        f"case {entry['cause_num']}; uncached candidate(s)={len(unresolved_candidates)}"
                    )
                    try:
                        fresh_classified, partial_not_processed, _excerpt = classify_candidates_with_gemini(
                            entry["cause_num"],
                            entry["court"],
                            doc,
                            current_doc_form,
                            unresolved_candidates,
                            text,
                            api_key,
                            gemini_model,
                            args.request_timeout,
                            args.retries,
                            args.gemini_max_text_chars,
                        )
                        for result in fresh_classified:
                            result["current_status_verified"] = True
                            result["cache_source"] = "gemini"
                            classified.append(result)
                            ai_cache_put(
                                ai_cache_path,
                                ai_cache,
                                stage="challenge",
                                year=year,
                                cause_num=entry["cause_num"],
                                doc_id=doc.doc_id,
                                decision_key=result["candidate_id"],
                                model=gemini_model,
                                version=CHALLENGE_CACHE_VERSION,
                                text_hash=doc_text_hash,
                                result=result,
                                source="gemini",
                            )
                            ai_stats["challenge_cache_writes"] += 1
                    except Exception as exc:  # noqa: BLE001
                        gemini_errors.append({
                            "stage": "challenge_classification",
                            "cause_num": entry["cause_num"],
                            "doc_id": doc.doc_id,
                            "error": str(exc),
                            "candidates": unresolved_candidates,
                        })
                        partial_not_processed = [
                            {**c, "not_processed_reason": f"Gemini challenge-classification error: {str(exc)[:300]}"}
                            for c in unresolved_candidates
                        ]

            # 1C. Partial/malformed case-level responses get a small single-candidate retry.
            # This is the failure mode that wasted the previous run: 2 missing results no longer
            # invalidate the other 239 already successful candidate classifications.
            for missing in partial_not_processed:
                reason = clean(missing.get("not_processed_reason"))
                retriable = any(token in reason for token in [
                    "Gemini did not return this candidate_id",
                    "Gemini returned invalid classification",
                    "Gemini challenge-classification error",
                ])
                recovered: dict[str, Any] | None = None
                last_retry_reason = reason

                if retriable and not args.skip_gemini and api_key:
                    for attempt in range(1, max(1, args.targeted_retry_attempts) + 1):
                        if targeted_retry_calls >= args.max_targeted_retry_calls:
                            last_retry_reason = (
                                f"Targeted retry budget exceeded ({args.max_targeted_retry_calls}) after: {last_retry_reason}"
                            )
                            break
                        wait_for_gemini_slot()
                        targeted_retry_calls += 1
                        ai_stats["challenge_targeted_retry_calls"] += 1
                        log(
                            f"Gemini targeted retry {targeted_retry_calls}/{args.max_targeted_retry_calls}: "
                            f"case {entry['cause_num']}; decision {missing.get('decision_number')}; attempt {attempt}"
                        )
                        try:
                            retry_classified, retry_missing, _excerpt = classify_candidates_with_gemini(
                                entry["cause_num"],
                                entry["court"],
                                doc,
                                current_doc_form,
                                [missing],
                                text,
                                api_key,
                                gemini_model,
                                args.request_timeout,
                                args.retries,
                                args.gemini_max_text_chars,
                            )
                            if retry_classified and not retry_missing:
                                recovered = retry_classified[0]
                                recovered["current_status_verified"] = True
                                recovered["cache_source"] = "gemini_targeted_retry"
                                classified.append(recovered)
                                ai_cache_put(
                                    ai_cache_path,
                                    ai_cache,
                                    stage="challenge",
                                    year=year,
                                    cause_num=entry["cause_num"],
                                    doc_id=doc.doc_id,
                                    decision_key=recovered["candidate_id"],
                                    model=gemini_model,
                                    version=CHALLENGE_CACHE_VERSION,
                                    text_hash=doc_text_hash,
                                    result=recovered,
                                    source="gemini_targeted_retry",
                                )
                                ai_stats["challenge_cache_writes"] += 1
                                ai_stats["challenge_targeted_retry_recovered"] += 1
                                break
                            if retry_missing:
                                last_retry_reason = clean(retry_missing[0].get("not_processed_reason")) or last_retry_reason
                        except Exception as exc:  # noqa: BLE001
                            last_retry_reason = f"Targeted retry error: {str(exc)[:300]}"
                            gemini_errors.append({
                                "stage": "challenge_targeted_retry",
                                "cause_num": entry["cause_num"],
                                "doc_id": doc.doc_id,
                                "decision_number": missing.get("decision_number"),
                                "attempt": attempt,
                                "error": str(exc),
                            })

                if recovered is None:
                    technical_not_processed.append({
                        **missing,
                        "not_processed_reason": last_retry_reason or "Technical classification failure",
                    })

            for result in classified:
                # Production safeguard for weak YES results: if neither party nor date corroborates
                # the exact number, run one additional contradiction-focused check. Safeguard results
                # have their own checkpoint, so a later failure does not pay for them again.
                safeguard_result: dict[str, Any] | None = None
                weak_yes = bool(
                    result["classification"] == "YES"
                    and not result.get("signals", {}).get("decision_date")
                    and not result.get("signals", {}).get("liable_party")
                )
                if weak_yes:
                    safeguard_result = ai_cache_get(
                        ai_cache,
                        stage="safeguard",
                        year=year,
                        cause_num=entry["cause_num"],
                        doc_id=doc.doc_id,
                        decision_key=result["candidate_id"],
                        model=gemini_model,
                        version=SAFEGUARD_CACHE_VERSION,
                        text_hash=doc_text_hash,
                    )
                    if safeguard_result:
                        ai_stats["safeguard_cache_hits"] += 1
                    elif args.skip_gemini:
                        technical_not_processed.append({
                            **result,
                            "not_processed_reason": "Weak-YES safeguard skipped by --skip-gemini.",
                        })
                        continue
                    elif not api_key:
                        technical_not_processed.append({
                            **result,
                            "not_processed_reason": "GEMINI_API_KEY is unavailable for weak-YES safeguard.",
                        })
                        continue
                    elif safeguard_gemini_calls >= args.max_safeguard_gemini_calls:
                        technical_not_processed.append({
                            **result,
                            "not_processed_reason": (
                                f"Weak-YES safeguard call budget exceeded ({args.max_safeguard_gemini_calls})."
                            ),
                        })
                        continue
                    else:
                        wait_for_gemini_slot()
                        safeguard_gemini_calls += 1
                        fetch_stats["weak_yes_safeguard_calls"] += 1
                        log(
                            f"Gemini weak-YES safeguard {safeguard_gemini_calls}/{args.max_safeguard_gemini_calls}: "
                            f"case {entry['cause_num']}; decision {result['decision_number']}"
                        )
                        try:
                            safeguard_result = verify_weak_yes_with_gemini(
                                entry["cause_num"],
                                entry["court"],
                                doc,
                                result,
                                text,
                                api_key,
                                gemini_model,
                                args.request_timeout,
                                args.retries,
                                args.gemini_max_text_chars,
                            )
                            ai_cache_put(
                                ai_cache_path,
                                ai_cache,
                                stage="safeguard",
                                year=year,
                                cause_num=entry["cause_num"],
                                doc_id=doc.doc_id,
                                decision_key=result["candidate_id"],
                                model=gemini_model,
                                version=SAFEGUARD_CACHE_VERSION,
                                text_hash=doc_text_hash,
                                result=safeguard_result,
                                source="gemini",
                            )
                            ai_stats["safeguard_cache_writes"] += 1
                        except Exception as exc:  # noqa: BLE001
                            gemini_errors.append({
                                "stage": "weak_yes_safeguard",
                                "cause_num": entry["cause_num"],
                                "doc_id": doc.doc_id,
                                "decision_number": result["decision_number"],
                                "error": str(exc),
                            })
                            technical_not_processed.append({
                                **result,
                                "not_processed_reason": f"Weak-YES safeguard error: {str(exc)[:300]}",
                            })
                            continue

                    safeguard_row = {
                        "decision_key": result["candidate_id"],
                        "decision_number": result["decision_number"],
                        "decision_date": result["decision_date"],
                        "cause_num": entry["cause_num"],
                        "classification": safeguard_result["classification"],
                        "confidence": safeguard_result["gemini_confidence"],
                        "reason": safeguard_result["reason"],
                    }
                    safeguard_rows.append(safeguard_row)
                    if safeguard_result["classification"] == "NO":
                        fetch_stats["weak_yes_rejected"] += 1
                        result = {
                            **result,
                            "classification": "NO",
                            "reason": (
                                f"Safeguard rejected weak YES: {safeguard_result['reason']}"
                            ),
                            "case_outcome": "not_applicable",
                            "current_document_resolves_merits": False,
                            "current_document_invalidates_prior_merits": False,
                        }

                latest_relevant_payload = court_doc_payload(
                    entry.get("latest_active"), courts, judgment_forms
                )
                row = {
                    "decision_key": result["candidate_id"],
                    "decision_number": result["decision_number"],
                    "decision_date": result["decision_date"],
                    "liable_parties": result["liable_parties"],
                    "prefilter_strength": result["strength"],
                    "signals": result["signals"],
                    "classification": result["classification"],
                    "gemini_confidence": result["gemini_confidence"],
                    "challenger": result["challenger"],
                    "reason": result["reason"],
                    "current_document_resolves_merits": result.get("current_document_resolves_merits", False),
                    "current_document_invalidates_prior_merits": result.get("current_document_invalidates_prior_merits", False),
                    "current_document_case_outcome": result.get("case_outcome", "ongoing"),
                    "current_status_verified": bool(result.get("current_status_verified", False)),
                    "classification_cache_source": result.get("cache_source", ""),
                    "status_detail": result.get("status_reason", ""),
                    "cause_num": entry["cause_num"],
                    "matched_on_doc_id": doc.doc_id,
                    "matched_on_source": entry["candidate_source"],
                    "primary_doc_id": entry["primary_doc"].doc_id,
                    "primary_kind": entry["primary_kind"],
                    "court": entry["court"],
                    "category_code": entry["category_code"],
                    "category_name": entry["category_name"],
                    "latest_form_doc_id": raw_latest_form.doc_id if raw_latest_form else "",
                    "latest_form_type": judgment_forms.get(raw_latest_form.judgment_code, "") if raw_latest_form else "",
                    "latest_form_date": raw_latest_form.adjudication_date if raw_latest_form else "",
                    "latest_relevant": latest_relevant_payload,
                    "latest_merits": None,
                    "latest_merits_doc_id": "",
                    "latest_merits_type": "",
                    "latest_merits_date": "",
                    "latest_merits_court": "",
                    "latest_merits_url": "",
                    "merits_gemini_confidence": "",
                    "merits_reason": "",
                    "challenge_status": "",
                    "case_status": "ongoing",
                    "invalidates_prior_merits": False,
                }
                if row["classification"] == "YES":
                    yes_rows.append(row)
                    yes_work_items.append((row, result, entry))
                else:
                    no_rows.append(row)
                if focus_norm and normalized_number(row["decision_number"]) == focus_norm:
                    focus_debug["gemini_results"].append(dict(row))

            for result in technical_not_processed:
                row = {
                    "stage": "challenge_classification",
                    "decision_key": result.get("candidate_id", ""),
                    "decision_number": result["decision_number"],
                    "decision_date": result["decision_date"],
                    "liable_parties": result["liable_parties"],
                    "prefilter_strength": result["strength"],
                    "signals": result["signals"],
                    "cause_num": entry["cause_num"],
                    "matched_on_doc_id": doc.doc_id,
                    "matched_on_source": entry["candidate_source"],
                    "primary_doc_id": entry["primary_doc"].doc_id,
                    "primary_kind": entry["primary_kind"],
                    "court": entry["court"],
                    "not_processed_reason": result.get("not_processed_reason", "Technical classification failure"),
                }
                not_processed_rows.append(row)
                if focus_norm and normalized_number(row["decision_number"]) == focus_norm:
                    focus_debug["not_processed"].append(row)


        new_discovery_yes_count = len(yes_rows)
        new_discovery_no_count = len(no_rows)

        # Stage 1H: history enrichment for already-confirmed decision<->case links.
        #
        # Two modes are intentionally different:
        # - current/newer-year refresh: follow the known cause_num even when newer documents do
        #   not repeat the AMCU decision number; preserve prior merits as a reference and let
        #   Stage 2/3 determine whether the current yearly acts change the status.
        # - older-year backfill: to save Gemini calls, inspect a known case only when the registry
        #   still lacks a substantive merits act and this older package contains Рішення/Постанова.
        known_history_rows: list[dict[str, Any]] = []
        already_confirmed_pairs = {
            (clean(row.get("decision_key")), clean(row.get("cause_num")))
            for row in yes_rows
        }

        for case_number, docs in sorted(known_history_docs.items()):
            links = known_case_links.get(case_number) or []
            if not links or not docs:
                continue

            primary, primary_kind = primary_discovery_doc(docs, judgment_forms)
            if not primary:
                continue
            raw_latest_form = latest_merits(docs, judgment_forms)
            latest_doc = latest_active(docs)
            form_docs = merits_docs_desc(docs, judgment_forms)

            for link in links:
                decision_key = clean(link.get("decision_key"))
                pair = (decision_key, case_number)
                if pair in already_confirmed_pairs:
                    fetch_stats["known_history_skipped_duplicate_discovery"] += 1
                    continue

                practice_row = practice_by_key.get(decision_key)
                if not practice_row:
                    known_history_rows.append({
                        "decision_key": decision_key,
                        "cause_num": case_number,
                        "mode": "skipped",
                        "reason": "Decision key from registry is not present in current AMCU practice database.",
                        "documents": len(docs),
                    })
                    continue

                existing_case = link.get("case") if isinstance(link.get("case"), dict) else {}
                source_years = sorted({
                    int(y) for y in (existing_case.get("source_years") or [])
                    if str(y).isdigit()
                })
                latest_source_year = max(source_years) if source_years else 0
                current_or_newer_refresh = year >= latest_source_year
                has_prior_merits = isinstance(existing_case.get("latest_merits"), dict) and clean(existing_case.get("latest_merits", {}).get("doc_id"))
                prior_invalidated = bool(existing_case.get("invalidates_prior_merits"))
                needs_older_merits_backfill = bool(
                    year < latest_source_year
                    and not has_prior_merits
                    and not prior_invalidated
                    and form_docs
                )

                if not current_or_newer_refresh and not needs_older_merits_backfill:
                    fetch_stats["known_history_skipped_existing_merits"] += 1
                    known_history_rows.append({
                        "decision_key": decision_key,
                        "decision_number": practice_row.decision_number,
                        "decision_date": practice_row.decision_date,
                        "cause_num": case_number,
                        "mode": "skipped_older_history",
                        "documents": len(docs),
                        "form_documents": len(form_docs),
                        "prior_merits_doc_id": clean((existing_case.get("latest_merits") or {}).get("doc_id")),
                        "latest_source_year": latest_source_year,
                        "reason": "Older package cannot improve the dashboard: a newer registry observation already has a merits act (or prior merits were invalidated).",
                    })
                    continue

                mode = "current_refresh" if current_or_newer_refresh else "backfill_missing_merits"
                entry = {
                    "cause_num": case_number,
                    "doc": primary,
                    "text": "",
                    "court": courts.get(primary.court_code, ""),
                    "category_code": primary.category_code,
                    "category_name": categories.get(primary.category_code, ""),
                    "candidates": [],
                    "fetch_meta": {},
                    "candidate_source": "known_case_history",
                    "primary_doc": primary,
                    "primary_kind": f"known_case_{mode}",
                    "negative_prefilter": {},
                    "latest_merits": raw_latest_form,
                    "latest_active": latest_doc,
                    "docs": docs,
                    "history_mode": mode,
                    "history_prior_merits": existing_case.get("latest_merits") if current_or_newer_refresh else None,
                    "history_existing_status": clean(existing_case.get("status")).lower() or "ongoing",
                    "history_existing_status_detail": clean(existing_case.get("status_detail")),
                }
                row, result = history_row_from_known_case(
                    practice_row,
                    case_number,
                    existing_case,
                    entry,
                    courts,
                    judgment_forms,
                )
                yes_rows.append(row)
                yes_work_items.append((row, result, entry))
                already_confirmed_pairs.add(pair)
                fetch_stats["known_history_work_items"] += 1
                if mode == "current_refresh":
                    fetch_stats["known_history_current_refresh"] += 1
                else:
                    fetch_stats["known_history_backfill_merits"] += 1

                known_history_rows.append({
                    "decision_key": decision_key,
                    "decision_number": practice_row.decision_number,
                    "decision_date": practice_row.decision_date,
                    "cause_num": case_number,
                    "mode": mode,
                    "documents": len(docs),
                    "form_documents": len(form_docs),
                    "primary_doc_id": primary.doc_id,
                    "latest_active_doc_id": latest_doc.doc_id if latest_doc else "",
                    "latest_form_doc_id": raw_latest_form.doc_id if raw_latest_form else "",
                    "prior_merits_doc_id": clean((existing_case.get("latest_merits") or {}).get("doc_id")),
                    "latest_source_year": latest_source_year,
                    "reason": "Known challenge link reused; direct-challenge Gemini classification skipped.",
                })

        if known_history_docs:
            log(
                f"Known-case history: metadata cases found={len(known_history_docs):,}; "
                f"work_items={fetch_stats['known_history_work_items']:,}; "
                f"current_refresh={fetch_stats['known_history_current_refresh']:,}; "
                f"older_missing_merits={fetch_stats['known_history_backfill_merits']:,}; "
                f"skipped_older={fetch_stats['known_history_skipped_existing_merits']:,}; "
                f"duplicate_with_discovery={fetch_stats['known_history_skipped_duplicate_discovery']:,}"
            )


        # Stage 2: determine the current usable court result and the newest still-current
        # substantive act. A later act that cancels prior merits and remands the case makes the
        # display status ongoing; we deliberately do NOT fall back to the cancelled older merits.
        for row, result, entry in yes_work_items:
            docs: list[DocRow] = entry["docs"]
            form_docs = merits_docs_desc(docs, judgment_forms)
            current_doc: DocRow = entry["doc"]
            current_is_latest_form = bool(form_docs and form_docs[0].doc_id == current_doc.doc_id)

            if not form_docs:
                prior_merits = entry.get("history_prior_merits") if isinstance(entry.get("history_prior_merits"), dict) else None
                if prior_merits and clean(prior_merits.get("doc_id")):
                    # A known case can have only a newer procedural act in this yearly package.
                    # Keep the previously verified merits act so Stage 3 can decide whether the
                    # newer act makes appellate/cassation review ongoing.
                    row["latest_merits"] = prior_merits
                    row["latest_merits_doc_id"] = clean(prior_merits.get("doc_id"))
                    row["latest_merits_type"] = clean(prior_merits.get("type"))
                    row["latest_merits_date"] = clean(prior_merits.get("date"))
                    row["latest_merits_court"] = clean(prior_merits.get("court"))
                    row["latest_merits_url"] = clean(prior_merits.get("url"))
                    prior_status = clean(entry.get("history_existing_status")).lower()
                    row["case_status"] = prior_status if prior_status in CASE_OUTCOMES else "ongoing"
                    row["challenge_status"] = "history_prior_merits"
                    row["merits_reason"] = "No current-year Рішення/Постанова; retained previously verified merits act for cross-year current-status verification."
                    if not row.get("status_detail"):
                        row["status_detail"] = clean(entry.get("history_existing_status_detail"))
                else:
                    row["case_status"] = "ongoing"
                    row["challenge_status"] = "pending_no_merits"
                    row["merits_reason"] = "No active Рішення/Постанова exists in EDRSR metadata for this case."
                    if not row.get("status_detail"):
                        row["status_detail"] = "Оскарження триває"
                continue

            start_index = 0
            if current_is_latest_form and result.get("current_status_verified", False):
                reused = {
                    "decision_key": row["decision_key"],
                    "decision_number": row["decision_number"],
                    "decision_date": row["decision_date"],
                    "cause_num": row["cause_num"],
                    "doc_id": current_doc.doc_id,
                    "doc_date": current_doc.adjudication_date,
                    "doc_form": judgment_forms.get(current_doc.judgment_code, ""),
                    "source": "reused_challenge_classification",
                    "resolves_merits": bool(result.get("current_document_resolves_merits", False)),
                    "invalidates_prior_merits": bool(result.get("current_document_invalidates_prior_merits", False)),
                    "outcome": result.get("case_outcome", "ongoing"),
                    "confidence": result.get("gemini_confidence", ""),
                    "reason": result.get("status_reason", "") or result.get("reason", ""),
                }
                merits_verification_rows.append(reused)
                if focus_norm and normalized_number(row["decision_number"]) == focus_norm:
                    focus_debug["merits_verification"].append(reused)

                if result.get("current_document_invalidates_prior_merits", False):
                    row["case_status"] = "ongoing"
                    row["challenge_status"] = "pending_no_merits"
                    row["invalidates_prior_merits"] = True
                    row["status_detail"] = result.get("status_reason", "") or "Справу направлено на новий розгляд"
                    row["merits_reason"] = row["status_detail"]
                    continue

                if result.get("current_document_resolves_merits", False):
                    outcome = clean(result.get("case_outcome")).lower()
                    if outcome not in {"upheld", "overturned", "partially_overturned"}:
                        outcome = "ongoing"
                    if outcome != "ongoing":
                        payload = court_doc_payload(current_doc, courts, judgment_forms)
                        row["latest_merits"] = payload
                        row["latest_merits_doc_id"] = current_doc.doc_id
                        row["latest_merits_type"] = judgment_forms.get(current_doc.judgment_code, "")
                        row["latest_merits_date"] = date_only(current_doc.adjudication_date)
                        row["latest_merits_court"] = courts.get(current_doc.court_code, "")
                        row["latest_merits_url"] = PUBLIC_EDRSR_URL.format(doc_id=current_doc.doc_id)
                        row["merits_gemini_confidence"] = result.get("gemini_confidence", "")
                        row["merits_reason"] = result.get("status_reason", "") or result.get("reason", "")
                        row["case_status"] = outcome
                        row["challenge_status"] = "merits_found"
                        row["status_detail"] = row["merits_reason"]
                        continue
                start_index = 1

            merits_resolved = False
            merits_check_interrupted = False
            invalidated_prior = False

            for merit_doc in form_docs[start_index:]:
                try:
                    merit_text, merit_meta = fetch_doc_text(
                        merit_doc,
                        cache_dir / "texts",
                        args.request_timeout,
                        args.retries,
                        args.request_delay_ms,
                    )
                    fetch_stats["documents_requested"] += 1
                    fetch_stats["merits_documents"] += 1
                    fetch_stats["validated_documents"] += 1
                    if merit_meta.get("cache_hit"):
                        fetch_stats["cache_hits"] += 1
                except Exception as exc:  # noqa: BLE001
                    fetch_stats["documents_requested"] += 1
                    fetch_stats["merits_documents"] += 1
                    fetch_stats["fetch_errors"] += 1
                    fetch_errors.append({
                        "cause_num": row["cause_num"],
                        "role": "merits_verification",
                        "doc_id": merit_doc.doc_id,
                        "doc_url": merit_doc.doc_url,
                        "error": str(exc),
                        "attempts": exc.attempts if isinstance(exc, DocumentFetchError) else [],
                    })
                    row["challenge_status"] = "merits_not_verified"
                    row["merits_reason"] = f"Could not fetch candidate merits document {merit_doc.doc_id}."
                    not_processed_rows.append({
                        "stage": "merits_verification",
                        "decision_key": row["decision_key"],
                        "decision_number": row["decision_number"],
                        "decision_date": row["decision_date"],
                        "liable_parties": row["liable_parties"],
                        "cause_num": row["cause_num"],
                        "court": row["court"],
                        "matched_on_doc_id": merit_doc.doc_id,
                        "not_processed_reason": row["merits_reason"],
                    })
                    merits_check_interrupted = True
                    break

                candidate_for_merits = {
                    "candidate_id": result["candidate_id"],
                    "decision_number": row["decision_number"],
                    "decision_date": row["decision_date"],
                    "liable_parties": row["liable_parties"],
                    "strength": row["prefilter_strength"],
                    "signals": row["signals"],
                }
                merit_hash = text_sha256(merit_text)
                verification = ai_cache_get(
                    ai_cache,
                    stage="merits",
                    year=year,
                    cause_num=row["cause_num"],
                    doc_id=merit_doc.doc_id,
                    decision_key=row["decision_key"],
                    model=gemini_model,
                    version=MERITS_CACHE_VERSION,
                    text_hash=merit_hash,
                )
                verification_source = "checkpoint"
                if verification:
                    ai_stats["merits_cache_hits"] += 1
                else:
                    seeded_verification = approved_merits_seed.get((
                        row["cause_num"], merit_doc.doc_id, row["decision_key"]
                    ))
                    if seeded_verification:
                        verification = dict(seeded_verification)
                        verification_source = "approved_probe_v6_seed"
                        ai_stats["merits_seed_hits"] += 1
                        ai_cache_put(
                            ai_cache_path,
                            ai_cache,
                            stage="merits",
                            year=year,
                            cause_num=row["cause_num"],
                            doc_id=merit_doc.doc_id,
                            decision_key=row["decision_key"],
                            model=gemini_model,
                            version=MERITS_CACHE_VERSION,
                            text_hash=merit_hash,
                            result=verification,
                            source="approved_probe_v6_seed",
                        )
                        ai_stats["merits_cache_writes"] += 1

                if not verification:
                    if args.skip_gemini:
                        row["challenge_status"] = "merits_not_verified"
                        row["merits_reason"] = "Merits verification skipped by --skip-gemini and no checkpoint exists."
                        not_processed_rows.append({
                            "stage": "merits_verification",
                            "decision_key": row["decision_key"],
                            "decision_number": row["decision_number"],
                            "decision_date": row["decision_date"],
                            "liable_parties": row["liable_parties"],
                            "cause_num": row["cause_num"],
                            "court": row["court"],
                            "matched_on_doc_id": merit_doc.doc_id,
                            "not_processed_reason": row["merits_reason"],
                        })
                        merits_check_interrupted = True
                        break
                    if not api_key:
                        row["challenge_status"] = "merits_not_verified"
                        row["merits_reason"] = "GEMINI_API_KEY is unavailable for uncached merits verification."
                        not_processed_rows.append({
                            "stage": "merits_verification",
                            "decision_key": row["decision_key"],
                            "decision_number": row["decision_number"],
                            "decision_date": row["decision_date"],
                            "liable_parties": row["liable_parties"],
                            "cause_num": row["cause_num"],
                            "court": row["court"],
                            "matched_on_doc_id": merit_doc.doc_id,
                            "not_processed_reason": row["merits_reason"],
                        })
                        merits_check_interrupted = True
                        break
                    if merits_gemini_calls >= args.max_merits_gemini_calls:
                        row["challenge_status"] = "merits_not_verified"
                        row["merits_reason"] = (
                            f"Gemini merits-verification call budget exceeded ({args.max_merits_gemini_calls})."
                        )
                        not_processed_rows.append({
                            "stage": "merits_verification",
                            "decision_key": row["decision_key"],
                            "decision_number": row["decision_number"],
                            "decision_date": row["decision_date"],
                            "liable_parties": row["liable_parties"],
                            "cause_num": row["cause_num"],
                            "court": row["court"],
                            "matched_on_doc_id": merit_doc.doc_id,
                            "not_processed_reason": row["merits_reason"],
                        })
                        merits_check_interrupted = True
                        break

                    wait_for_gemini_slot()
                    merits_gemini_calls += 1
                    log(
                        f"Gemini merits {merits_gemini_calls}/{args.max_merits_gemini_calls}: "
                        f"case {row['cause_num']}; decision {row['decision_number']}; doc {merit_doc.doc_id}"
                    )
                    try:
                        verification = verify_merits_doc_with_gemini(
                            row["cause_num"],
                            courts.get(merit_doc.court_code, row["court"]),
                            merit_doc,
                            judgment_forms.get(merit_doc.judgment_code, ""),
                            candidate_for_merits,
                            merit_text,
                            api_key,
                            gemini_model,
                            args.request_timeout,
                            args.retries,
                            args.gemini_max_text_chars,
                        )
                        ai_cache_put(
                            ai_cache_path,
                            ai_cache,
                            stage="merits",
                            year=year,
                            cause_num=row["cause_num"],
                            doc_id=merit_doc.doc_id,
                            decision_key=row["decision_key"],
                            model=gemini_model,
                            version=MERITS_CACHE_VERSION,
                            text_hash=merit_hash,
                            result=verification,
                            source="gemini",
                        )
                        ai_stats["merits_cache_writes"] += 1
                        verification_source = "gemini"
                    except Exception as exc:  # noqa: BLE001
                        gemini_errors.append({
                            "stage": "merits_verification",
                            "cause_num": row["cause_num"],
                            "doc_id": merit_doc.doc_id,
                            "decision_number": row["decision_number"],
                            "error": str(exc),
                        })
                        row["challenge_status"] = "merits_not_verified"
                        row["merits_reason"] = f"Gemini merits-verification error: {str(exc)[:300]}"
                        not_processed_rows.append({
                            "stage": "merits_verification",
                            "decision_key": row["decision_key"],
                            "decision_number": row["decision_number"],
                            "decision_date": row["decision_date"],
                            "liable_parties": row["liable_parties"],
                            "cause_num": row["cause_num"],
                            "court": row["court"],
                            "matched_on_doc_id": merit_doc.doc_id,
                            "not_processed_reason": row["merits_reason"],
                        })
                        merits_check_interrupted = True
                        break

                verification_row = {
                    "decision_key": row["decision_key"],
                    "decision_number": row["decision_number"],
                    "decision_date": row["decision_date"],
                    "cause_num": row["cause_num"],
                    "doc_id": merit_doc.doc_id,
                    "doc_date": merit_doc.adjudication_date,
                    "doc_form": judgment_forms.get(merit_doc.judgment_code, ""),
                    "source": f"merits_verification_{verification_source}",
                    "resolves_merits": verification["resolves_merits"],
                    "invalidates_prior_merits": verification["invalidates_prior_merits"],
                    "outcome": verification["outcome"],
                    "confidence": verification["gemini_confidence"],
                    "reason": verification["reason"],
                }
                merits_verification_rows.append(verification_row)
                if focus_norm and normalized_number(row["decision_number"]) == focus_norm:
                    focus_debug["merits_verification"].append(verification_row)

                if verification["invalidates_prior_merits"]:
                    row["case_status"] = "ongoing"
                    row["challenge_status"] = "pending_no_merits"
                    row["invalidates_prior_merits"] = True
                    row["status_detail"] = verification["reason"] or "Справу направлено на новий розгляд"
                    row["merits_reason"] = row["status_detail"]
                    invalidated_prior = True
                    break

                if verification["resolves_merits"]:
                    outcome = verification["outcome"]
                    if outcome not in {"upheld", "overturned", "partially_overturned"}:
                        outcome = "ongoing"
                    if outcome != "ongoing":
                        payload = court_doc_payload(merit_doc, courts, judgment_forms)
                        row["latest_merits"] = payload
                        row["latest_merits_doc_id"] = merit_doc.doc_id
                        row["latest_merits_type"] = judgment_forms.get(merit_doc.judgment_code, "")
                        row["latest_merits_date"] = date_only(merit_doc.adjudication_date)
                        row["latest_merits_court"] = courts.get(merit_doc.court_code, "")
                        row["latest_merits_url"] = PUBLIC_EDRSR_URL.format(doc_id=merit_doc.doc_id)
                        row["merits_gemini_confidence"] = verification["gemini_confidence"]
                        row["merits_reason"] = verification["reason"]
                        row["case_status"] = outcome
                        row["challenge_status"] = "merits_found"
                        row["status_detail"] = verification["reason"]
                        merits_resolved = True
                        break

            if not merits_resolved and not merits_check_interrupted and not invalidated_prior:
                prior_merits = entry.get("history_prior_merits") if isinstance(entry.get("history_prior_merits"), dict) else None
                if prior_merits and clean(prior_merits.get("doc_id")):
                    row["latest_merits"] = prior_merits
                    row["latest_merits_doc_id"] = clean(prior_merits.get("doc_id"))
                    row["latest_merits_type"] = clean(prior_merits.get("type"))
                    row["latest_merits_date"] = clean(prior_merits.get("date"))
                    row["latest_merits_court"] = clean(prior_merits.get("court"))
                    row["latest_merits_url"] = clean(prior_merits.get("url"))
                    prior_status = clean(entry.get("history_existing_status")).lower()
                    row["case_status"] = prior_status if prior_status in CASE_OUTCOMES else "ongoing"
                    row["challenge_status"] = "history_prior_merits"
                    row["merits_reason"] = (
                        "Current-year Рішення/Постанови did not replace the previously verified substantive result; prior merits retained pending later-act status verification."
                    )
                    if not row.get("status_detail"):
                        row["status_detail"] = clean(entry.get("history_existing_status_detail"))
                else:
                    row["case_status"] = "ongoing"
                    row["challenge_status"] = "pending_no_merits"
                    row["merits_reason"] = (
                        "Active Рішення/Постанови exist, but none of the checked acts is a current substantive result of the AMCU challenge."
                    )
                    if not row.get("status_detail"):
                        row["status_detail"] = "Оскарження триває"

        # Stage 3: if a confirmed merits act exists but EDRSR has a newer active court act,
        # verify whether appellate/cassation review is still genuinely active. A newer procedural
        # document is NOT automatically ongoing; Gemini reads that one later act and classifies it.
        current_status_eligible_pairs = 0
        for row, result, entry in yes_work_items:
            if row.get("case_status") not in {"upheld", "overturned", "partially_overturned"}:
                continue
            latest_merits_payload = row.get("latest_merits") or None
            if not latest_merits_payload:
                continue
            latest_active_doc: DocRow | None = entry.get("latest_active")
            if not latest_active_doc or not latest_active_doc.doc_id:
                continue
            if latest_active_doc.doc_id == clean(latest_merits_payload.get("doc_id")):
                continue

            docs: list[DocRow] = entry["docs"]
            merits_doc = next(
                (d for d in docs if d.doc_id == clean(latest_merits_payload.get("doc_id"))),
                None,
            )
            if merits_doc:
                if doc_sort_key(latest_active_doc) <= doc_sort_key(merits_doc):
                    continue
            else:
                # Cross-year history refresh: prior merits can come from an older EDRSR package
                # and therefore be absent from the current year's docs list. Compare by date.
                latest_dt = parse_date(latest_active_doc.adjudication_date)
                merits_dt = parse_date(clean(latest_merits_payload.get("date")))
                if latest_dt and merits_dt and latest_dt <= merits_dt:
                    continue
                if not latest_dt or not merits_dt:
                    # Without a reliable ordering, do not spend Gemini on a speculative status check.
                    continue

            current_status_eligible_pairs += 1

            try:
                status_text, status_meta = fetch_doc_text(
                    latest_active_doc,
                    cache_dir / "texts",
                    args.request_timeout,
                    args.retries,
                    args.request_delay_ms,
                )
                fetch_stats["documents_requested"] += 1
                fetch_stats["current_status_documents"] += 1
                fetch_stats["validated_documents"] += 1
                if status_meta.get("cache_hit"):
                    fetch_stats["cache_hits"] += 1
            except Exception as exc:  # noqa: BLE001
                fetch_stats["documents_requested"] += 1
                fetch_stats["current_status_documents"] += 1
                fetch_stats["fetch_errors"] += 1
                fetch_errors.append({
                    "cause_num": row["cause_num"],
                    "role": "current_status_verification",
                    "doc_id": latest_active_doc.doc_id,
                    "doc_url": latest_active_doc.doc_url,
                    "error": str(exc),
                    "attempts": exc.attempts if isinstance(exc, DocumentFetchError) else [],
                })
                row["challenge_status"] = "current_status_not_verified"
                not_processed_rows.append({
                    "stage": "current_status_verification",
                    "decision_key": row["decision_key"],
                    "decision_number": row["decision_number"],
                    "decision_date": row["decision_date"],
                    "liable_parties": row["liable_parties"],
                    "cause_num": row["cause_num"],
                    "court": courts.get(latest_active_doc.court_code, row["court"]),
                    "matched_on_doc_id": latest_active_doc.doc_id,
                    "not_processed_reason": f"Could not fetch newer court act {latest_active_doc.doc_id} for current-status verification.",
                })
                continue

            candidate_for_status = {
                "candidate_id": result["candidate_id"],
                "decision_number": row["decision_number"],
                "decision_date": row["decision_date"],
                "liable_parties": row["liable_parties"],
                "strength": row["prefilter_strength"],
                "signals": row["signals"],
            }
            status_hash = text_sha256(status_text)
            verification = ai_cache_get(
                ai_cache,
                stage="current_status",
                year=year,
                cause_num=row["cause_num"],
                doc_id=latest_active_doc.doc_id,
                decision_key=row["decision_key"],
                model=gemini_model,
                version=CURRENT_STATUS_CACHE_VERSION,
                text_hash=status_hash,
            )
            verification_source = "checkpoint"
            if verification:
                ai_stats["current_status_cache_hits"] += 1
            else:
                if args.skip_gemini:
                    row["challenge_status"] = "current_status_not_verified"
                    not_processed_rows.append({
                        "stage": "current_status_verification",
                        "decision_key": row["decision_key"],
                        "decision_number": row["decision_number"],
                        "decision_date": row["decision_date"],
                        "liable_parties": row["liable_parties"],
                        "cause_num": row["cause_num"],
                        "court": courts.get(latest_active_doc.court_code, row["court"]),
                        "matched_on_doc_id": latest_active_doc.doc_id,
                        "not_processed_reason": "Current-status verification skipped by --skip-gemini and no checkpoint exists.",
                    })
                    continue
                if not api_key:
                    row["challenge_status"] = "current_status_not_verified"
                    not_processed_rows.append({
                        "stage": "current_status_verification",
                        "decision_key": row["decision_key"],
                        "decision_number": row["decision_number"],
                        "decision_date": row["decision_date"],
                        "liable_parties": row["liable_parties"],
                        "cause_num": row["cause_num"],
                        "court": courts.get(latest_active_doc.court_code, row["court"]),
                        "matched_on_doc_id": latest_active_doc.doc_id,
                        "not_processed_reason": "GEMINI_API_KEY is unavailable for uncached current-status verification.",
                    })
                    continue
                if current_status_gemini_calls >= args.max_current_status_gemini_calls:
                    row["challenge_status"] = "current_status_not_verified"
                    not_processed_rows.append({
                        "stage": "current_status_verification",
                        "decision_key": row["decision_key"],
                        "decision_number": row["decision_number"],
                        "decision_date": row["decision_date"],
                        "liable_parties": row["liable_parties"],
                        "cause_num": row["cause_num"],
                        "court": courts.get(latest_active_doc.court_code, row["court"]),
                        "matched_on_doc_id": latest_active_doc.doc_id,
                        "not_processed_reason": f"Gemini current-status call budget exceeded ({args.max_current_status_gemini_calls}).",
                    })
                    continue

                wait_for_gemini_slot()
                current_status_gemini_calls += 1
                log(
                    f"Gemini current status {current_status_gemini_calls}/{args.max_current_status_gemini_calls}: "
                    f"case {row['cause_num']}; decision {row['decision_number']}; doc {latest_active_doc.doc_id}"
                )
                try:
                    verification = verify_current_status_with_gemini(
                        row["cause_num"],
                        courts.get(latest_active_doc.court_code, row["court"]),
                        latest_active_doc,
                        judgment_forms.get(latest_active_doc.judgment_code, ""),
                        latest_merits_payload,
                        candidate_for_status,
                        status_text,
                        api_key,
                        gemini_model,
                        args.request_timeout,
                        args.retries,
                        args.gemini_max_text_chars,
                    )
                    ai_cache_put(
                        ai_cache_path,
                        ai_cache,
                        stage="current_status",
                        year=year,
                        cause_num=row["cause_num"],
                        doc_id=latest_active_doc.doc_id,
                        decision_key=row["decision_key"],
                        model=gemini_model,
                        version=CURRENT_STATUS_CACHE_VERSION,
                        text_hash=status_hash,
                        result=verification,
                        source="gemini",
                    )
                    ai_stats["current_status_cache_writes"] += 1
                    verification_source = "gemini"
                except Exception as exc:  # noqa: BLE001
                    gemini_errors.append({
                        "stage": "current_status_verification",
                        "cause_num": row["cause_num"],
                        "doc_id": latest_active_doc.doc_id,
                        "decision_number": row["decision_number"],
                        "error": str(exc),
                    })
                    row["challenge_status"] = "current_status_not_verified"
                    not_processed_rows.append({
                        "stage": "current_status_verification",
                        "decision_key": row["decision_key"],
                        "decision_number": row["decision_number"],
                        "decision_date": row["decision_date"],
                        "liable_parties": row["liable_parties"],
                        "cause_num": row["cause_num"],
                        "court": courts.get(latest_active_doc.court_code, row["court"]),
                        "matched_on_doc_id": latest_active_doc.doc_id,
                        "not_processed_reason": f"Gemini current-status verification error: {str(exc)[:300]}",
                    })
                    continue

            status_code = clean(verification.get("status")).upper()
            verification_row = {
                "decision_key": row["decision_key"],
                "decision_number": row["decision_number"],
                "decision_date": row["decision_date"],
                "cause_num": row["cause_num"],
                "prior_merits_doc_id": clean(latest_merits_payload.get("doc_id")),
                "prior_merits_date": clean(latest_merits_payload.get("date")),
                "newer_doc_id": latest_active_doc.doc_id,
                "newer_doc_date": date_only(latest_active_doc.adjudication_date),
                "newer_doc_form": judgment_forms.get(latest_active_doc.judgment_code, ""),
                "newer_doc_court": courts.get(latest_active_doc.court_code, ""),
                "source": f"current_status_{verification_source}",
                "status": status_code,
                "confidence": verification.get("gemini_confidence", ""),
                "reason": verification.get("reason", ""),
            }
            current_status_verification_rows.append(verification_row)
            if focus_norm and normalized_number(row["decision_number"]) == focus_norm:
                focus_debug["current_status_verification"].append(verification_row)

            row["current_status_verification"] = {
                "status": status_code,
                "confidence": verification.get("gemini_confidence", ""),
                "reason": verification.get("reason", ""),
                "doc_id": latest_active_doc.doc_id,
            }

            if status_code == "INVALIDATES_PRIOR":
                row["case_status"] = "ongoing"
                row["challenge_status"] = "pending_no_merits"
                row["invalidates_prior_merits"] = True
                row["latest_merits"] = None
                row["latest_merits_doc_id"] = ""
                row["latest_merits_type"] = ""
                row["latest_merits_date"] = ""
                row["latest_merits_court"] = ""
                row["latest_merits_url"] = ""
                row["status_detail"] = verification.get("reason", "") or "Справу направлено на новий розгляд"
                row["merits_reason"] = row["status_detail"]
            elif status_code == "ONGOING":
                # Keep the prior merits act as reference, but the current dashboard status is yellow.
                row["case_status"] = "ongoing"
                row["challenge_status"] = "merits_found_review_ongoing"
                row["status_detail"] = verification.get("reason", "") or "Оскарження триває"
            elif status_code == "FINAL_UNCHANGED":
                pass

        sort_key = lambda x: (
            clean(x.get("decision_date")),
            clean(x.get("decision_number")),
            clean(x.get("cause_num")),
        )
        yes_rows.sort(key=sort_key, reverse=True)
        no_rows.sort(key=sort_key, reverse=True)
        not_processed_rows.sort(key=sort_key, reverse=True)
        negative_prefilter_rows.sort(key=sort_key, reverse=True)

        matched_category_rows: list[dict[str, Any]] = []
        for code in sorted(cat_codes):
            stat = category_stats.get(code, {})
            matched_category_rows.append({
                "category_code": code,
                "name": categories.get(code, ""),
                "primary_challenge_category": code in primary_cat_codes,
                "active_documents": int(stat.get("active_documents", 0)),
                "commercial_documents": int(stat.get("commercial_documents", 0)),
                "cases": len(stat.get("cases", set())),
            })
        matched_category_rows.sort(key=lambda r: (r["cases"], r["commercial_documents"]), reverse=True)

        justice_rows = [
            {"justice_kind": code, "name": justice.get(code, ""), "category_matched_documents": count}
            for code, count in sorted(justice_stats.items(), key=lambda kv: kv[1], reverse=True)
        ]

        merits_found_count = sum(1 for row in yes_rows if row.get("latest_merits"))
        pending_no_merits_count = sum(1 for row in yes_rows if row.get("challenge_status") == "pending_no_merits")
        review_ongoing_after_merits_count = sum(1 for row in yes_rows if row.get("challenge_status") == "merits_found_review_ongoing")
        merits_not_verified_count = sum(1 for row in yes_rows if row.get("challenge_status") == "merits_not_verified")

        outcome_counts = {code: sum(1 for row in yes_rows if row.get("case_status") == code) for code in sorted(CASE_OUTCOMES)}

        # A partial technical run must never write a production registry. Unlike the previous
        # version, diagnostics/checkpoints are still written first and the process fails only after
        # those artifacts are safely available to the workflow.
        blocking_unprocessed = [
            row for row in not_processed_rows
            if row.get("stage") in {"challenge_classification", "weak_yes_safeguard", "merits_verification", "current_status_verification"}
        ]
        blocking_merits = [
            row for row in yes_rows
            if row.get("challenge_status") == "merits_not_verified"
        ]
        current_status_not_processed_count = sum(
            1 for row in blocking_unprocessed
            if row.get("stage") == "current_status_verification"
        )
        current_status_coverage_gap = max(
            0,
            current_status_eligible_pairs
            - len(current_status_verification_rows)
            - current_status_not_processed_count,
        )
        technically_complete = not (
            blocking_unprocessed
            or blocking_merits
            or fetch_errors
            or current_status_coverage_gap
        )
        if not args.dry_run and not technically_complete:
            registry_write_blocked_reason = (
                "Refusing registry write because the yearly court scan was technically incomplete: "
                f"not_processed={len(blocking_unprocessed)}, merits_not_verified={len(blocking_merits)}, "
                f"fetch_errors={len(fetch_errors)}, current_status_coverage_gap={current_status_coverage_gap}"
            )
            log(f"REGISTRY WRITE BLOCKED: {registry_write_blocked_reason}")
            registry_preview = read_registry(registry_path)
        else:
            registry_preview = merge_registry(
                registry_path,
                year,
                yes_rows,
                courts,
                judgment_forms,
                args.replace_year,
            )

        if not args.dry_run and technically_complete:
            registry_path.parent.mkdir(parents=True, exist_ok=True)
            registry_path.write_text(
                json.dumps(registry_preview, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            log(f"Court-challenge registry written: {registry_path}")
        elif args.dry_run:
            log("DRY RUN: persistent court-challenge registry was not written.")

        # Keep diagnostics deliberately compact. data/tmp is uploaded as a workflow artifact,
        # not committed to the repository. We retain only a human report, a machine summary,
        # and one combined diagnostics JSON for errors / targeted verification details.

        summary = {
            "schema": "amku_court_challenges_production_v1_3_known_pair_dedup",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "year": year,
            "dataset_id": dataset_id,
            "zip_url": zip_url,
            "practice_rows": len(practice),
            "discovery_eligible_practice_rows": len(discovery_practice),
            "discovery_excluded_closed_no_violation": len(excluded_closed_practice),
            "unique_decision_numbers": len(number_index),
            "known_registry_cases_before_run": len(known_case_numbers),
            "known_history_cases_found_in_year": len(known_history_docs),
            "known_history_work_items": fetch_stats["known_history_work_items"],
            "prefilter": stats,
            "cases_scanned": len(jobs),
            "text_fetch": {
                "documents_requested": fetch_stats["documents_requested"],
                "validated_documents": fetch_stats["validated_documents"],
                "cache_hits": fetch_stats["cache_hits"],
                "fetch_errors": fetch_stats["fetch_errors"],
            },
            "candidate_cases_before_negative_filter": fetch_stats["candidate_documents_before_negative_filter"],
            "candidate_pairs_before_negative_filter": fetch_stats["candidate_pairs_before_negative_filter"],
            "negative_prefilter_cases": fetch_stats["negative_prefilter_cases"],
            "negative_prefilter_pairs": fetch_stats["negative_prefilter_pairs"],
            "candidate_cases_after_negative_filter": fetch_stats["candidate_documents"],
            "candidate_pairs_after_negative_filter": fetch_stats["candidate_pairs"],
            "known_confirmed_pairs_reused": fetch_stats["known_confirmed_pairs_reused"],
            "known_confirmed_cases_fully_skipped": fetch_stats["known_confirmed_cases_fully_skipped"],
            "known_confirmed_cases_partially_deduped": fetch_stats["known_confirmed_cases_partially_deduped"],
            "new_candidate_cases_for_gemini": len(candidate_docs),
            "new_candidate_pairs_for_gemini": len(candidate_rows),
            "known_history_current_refresh": fetch_stats["known_history_current_refresh"],
            "known_history_backfill_merits": fetch_stats["known_history_backfill_merits"],
            "known_history_skipped_existing_merits": fetch_stats["known_history_skipped_existing_merits"],
            "technically_complete": technically_complete,
            "registry_write_blocked": bool(registry_write_blocked_reason),
            "registry_write_blocked_reason": registry_write_blocked_reason,
            "challenge_gemini_calls": gemini_calls,
            "targeted_retry_calls": targeted_retry_calls,
            "weak_yes_safeguard_calls": safeguard_gemini_calls,
            "weak_yes_rejected": fetch_stats["weak_yes_rejected"],
            "merits_gemini_calls": merits_gemini_calls,
            "current_status_gemini_calls": current_status_gemini_calls,
            "current_status_eligible_pairs": current_status_eligible_pairs,
            "current_status_coverage_gap": current_status_coverage_gap,
            "new_discovery_confirmed_challenges": new_discovery_yes_count,
            "new_discovery_rejected_mentions": new_discovery_no_count,
            "confirmed_challenges_this_year_workset": len(yes_rows),
            "outcome_counts": outcome_counts,
            "registry_decisions_after_merge": len(registry_preview.get("decisions") or {}),
            "merits_found": merits_found_count,
            "pending_no_merits": pending_no_merits_count,
            "review_ongoing_after_merits": review_ongoing_after_merits_count,
            "merits_not_verified": merits_not_verified_count,
            "not_processed": len(not_processed_rows),
            "gemini_errors": len(gemini_errors),
            "ai_checkpoint_entries": len(ai_cache.get("entries") or {}),
            "focus_decision": args.focus_decision,
        }

        diagnostics = {
            "not_processed": not_processed_rows,
            "fetch_errors": fetch_errors,
            "gemini_errors": gemini_errors,
            "weak_yes_safeguard": safeguard_rows,
            "merits_verification": merits_verification_rows,
            "current_status_verification": current_status_verification_rows,
            "focus": focus_debug if args.focus_decision else {},
        }

        (out_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (out_dir / "diagnostics.json").write_text(
            json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

        focus_md = ""
        if args.focus_decision:
            focus_confirmed = [
                row for row in yes_rows
                if focus_norm and normalized_number(row.get("decision_number")) == focus_norm
            ]
            focus_md = (
                f"\n## Focus `{args.focus_decision}`\n\n"
                f"- Candidate document(s) after exact-number search: {len(focus_debug['candidate_hits'])}\n"
                f"- Dropped by AMCU-plaintiff negative prefilter: {len(focus_debug['negative_prefilter_hits'])}\n"
                f"- Negative filter bypassed because match came from earliest fallback: {len(focus_debug['negative_prefilter_bypassed_fallback'])}\n"
                f"- Gemini-confirmed challenge(s): {len(focus_confirmed)}\n"
                f"- Merits-verification records: {len(focus_debug['merits_verification'])}\n"
                f"- Current-status verification records: {len(focus_debug['current_status_verification'])}\n"
                f"- Not processed technically/budget: {len(focus_debug['not_processed'])}\n"
            )
            for h in focus_confirmed:
                focus_md += (
                    f"- case `{h['cause_num']}`, status `{h['challenge_status']}`, "
                    f"verified merits `{h['latest_merits_doc_id'] or 'none'}`\n"
                )

        report = f"""# AMCU court challenges production enrichment — {year}

Generated: {summary['generated_at']}

## Pipeline

`EDRSR metadata -> (A) new-case discovery: active + exact competition category + commercial jurisdiction -> exact AMCU decision number from discovery-eligible practice -> Gemini YES/NO; plus (B) known-case history: exact confirmed cause_num across all active categories -> substantive/history verification only when useful -> later-act current-status verification -> persistent registry`

If the primary latest document contains no exact AMCU practice decision number, the earliest active document is fetched once as a fallback. A candidate found only in that earliest fallback is never hard-dropped solely because a different later primary document shows AMCU as plaintiff. Party/date matches remain corroborating signals only.

Gemini must classify a candidate as `NO` when the current case directly challenges another AMCU decision and the candidate decision is merely mentioned, including cases where that other decision left the candidate unchanged/confirmed/reviewed it.

A metadata form `Рішення` or `Постанова` is only a candidate merits act. If a newer active court act exists after a verified merits act, that later act is separately checked: active appellate/cassation review makes the display status `ongoing`; refusal/return/closure that leaves the merits result untouched keeps the final status; cancellation/remand invalidates the old merits link. Weak YES results with neither date nor party corroboration receive a second contradiction-focused check before entering the registry.

## Metadata prefilter

- Practice rows total: {len(practice):,}
- Discovery-eligible practice rows: {len(discovery_practice):,}
- Excluded from NEW-case discovery because `decision_outcome=proceeding_closed_no_violation`: {len(excluded_closed_practice):,}
- Unique AMCU decision numbers used for NEW-case discovery: {len(number_index):,}
- Confirmed registry case numbers available for history lookup: {len(known_case_numbers):,}
- Confirmed case numbers found in this EDRSR year (all active categories): {len(known_history_docs):,}
- Active documents collected for known-case history: {stats['known_history_documents']:,}
- EDRSR rows: {stats['rows_total']:,}
- Active rows: {stats['active']:,}
- Exact competition-category rows: {stats['category_match']:,}
- Commercial-jurisdiction rows: {stats['commercial_match']:,}
- Rows with case number: {stats['with_cause_num']:,}
- Unique prefiltered cases: {stats['cases']:,}
- Cases actually scanned: {len(jobs):,}

## Candidate discovery

- Court texts requested (all stages): {fetch_stats['documents_requested']:,}
- Primary latest texts: {fetch_stats['primary_documents']:,}
- Earliest fallback texts: {fetch_stats['fallback_documents']:,}
- Additional merits-verification texts: {fetch_stats['merits_documents']:,}
- Later-act current-status texts: {fetch_stats['current_status_documents']:,}
- Cases where fallback found the exact number: {fetch_stats['fallback_candidate_cases']:,}
- Validated court texts: {fetch_stats['validated_documents']:,}
- Persistent/cache hits: {fetch_stats['cache_hits']:,}
- Fetch errors: {fetch_stats['fetch_errors']:,}
- Candidate cases before AMCU-plaintiff negative filter: {fetch_stats['candidate_documents_before_negative_filter']:,}
- Candidate pairs before negative filter: {fetch_stats['candidate_pairs_before_negative_filter']:,}
- Cases dropped because the SAME primary/latest document both contains the exact AMCU decision number and clearly shows AMCU as plaintiff with no counterclaim: {fetch_stats['negative_prefilter_cases']:,}
- Candidate pairs dropped by that negative filter: {fetch_stats['negative_prefilter_pairs']:,}
- Fallback candidate cases protected from that hard drop: {fetch_stats['negative_prefilter_bypassed_fallback_cases']:,}
- Fallback candidate pairs protected from that hard drop: {fetch_stats['negative_prefilter_bypassed_fallback_pairs']:,}
- Candidate cases after negative filter, before known-pair dedup: {fetch_stats['candidate_documents']:,}
- Candidate pairs after negative filter, before known-pair dedup: {fetch_stats['candidate_pairs']:,}
- Already-confirmed decision/case pairs reused from registry (no repeat challenge Gemini): {fetch_stats['known_confirmed_pairs_reused']:,}
- Candidate cases fully removed from challenge Gemini because every pair was already confirmed: {fetch_stats['known_confirmed_cases_fully_skipped']:,}
- Candidate cases partially deduplicated (known + new pairs mixed): {fetch_stats['known_confirmed_cases_partially_deduped']:,}
- NEW candidate cases remaining for Gemini queue: {len(candidate_docs):,}
- NEW candidate pairs remaining for Gemini queue: {len(candidate_rows):,}

## Known-case history enrichment

- Known decision/case work items added without repeat challenge classification: {fetch_stats['known_history_work_items']:,}
- Current/newer-year refresh work items: {fetch_stats['known_history_current_refresh']:,}
- Older-year work items used only to fill missing merits: {fetch_stats['known_history_backfill_merits']:,}
- Older known links skipped because a newer merits result already exists / was invalidated: {fetch_stats['known_history_skipped_existing_merits']:,}
- Known links skipped because the same pair was already confirmed by this year's discovery: {fetch_stats['known_history_skipped_duplicate_discovery']:,}

For older backfill years, known cases are intentionally cheap: if the registry already has a newer substantive merits act, the older package is not sent through Gemini merely to reconstruct redundant history. If the registry lacks merits, the newest historical `Рішення/Постанова` candidates are checked. For current/newer years, known `cause_num` documents can update status even when they no longer repeat the AMCU decision number.

## Gemini challenge classification / resume

- Model: `{gemini_model}`
- Normal challenge calls used this run: {gemini_calls:,}/{args.max_gemini_calls:,}
- Targeted single-candidate retry calls: {targeted_retry_calls:,}/{args.max_targeted_retry_calls:,}
- Challenge checkpoint hits: {ai_stats['challenge_cache_hits']:,}
- Approved v6 seed hits: {ai_stats['challenge_seed_hits']:,}
- Targeted retries recovered: {ai_stats['challenge_targeted_retry_recovered']:,}
- Persistent AI checkpoint entries after run: {len(ai_cache.get('entries') or {}):,}
- NEW-case discovery confirmed direct challenge pairs (`YES`): {new_discovery_yes_count:,}
- NEW-case discovery rejected mentions/indirect cases (`NO`): {new_discovery_no_count:,}
- Total yearly work rows entering registry merge after known-case history enrichment: {len(yes_rows):,}
- Weak-YES safeguard calls: {safeguard_gemini_calls:,}/{args.max_safeguard_gemini_calls:,}
- Weak YES rejected by safeguard: {fetch_stats['weak_yes_rejected']:,}

## Substantive merits verification

- Additional Gemini calls this run: {merits_gemini_calls:,}/{args.max_merits_gemini_calls:,}
- Merits checkpoint hits: {ai_stats['merits_cache_hits']:,}
- Approved v6 merits/status seed hits: {ai_stats['merits_seed_hits']:,}
- Safeguard checkpoint hits: {ai_stats['safeguard_cache_hits']:,}
- Confirmed challenges with a verified latest merits act: {merits_found_count:,}
- Confirmed challenges with no substantive merits act found yet: {pending_no_merits_count:,}
- Confirmed challenges with a prior merits act but a newer active review: {review_ongoing_after_merits_count:,}
- Confirmed challenges whose merits check was not completed technically/budget: {merits_not_verified_count:,}
- Merits-verification audit rows: {len(merits_verification_rows):,}

## Later-act current-status verification

- Eligible pairs with a newer active act after verified merits: {current_status_eligible_pairs:,}
- Gemini calls this run: {current_status_gemini_calls:,}/{args.max_current_status_gemini_calls:,}
- Checkpoint hits: {ai_stats['current_status_cache_hits']:,}
- Audit rows: {len(current_status_verification_rows):,}
- Coverage gap: {current_status_coverage_gap:,}
- Later acts classified as active review: {sum(1 for r in current_status_verification_rows if r.get('status') == 'ONGOING'):,}
- Later acts leaving prior merits final: {sum(1 for r in current_status_verification_rows if r.get('status') == 'FINAL_UNCHANGED'):,}
- Later acts invalidating prior merits: {sum(1 for r in current_status_verification_rows if r.get('status') == 'INVALIDATES_PRIOR'):,}
- Current status ongoing: {outcome_counts.get('ongoing', 0):,}
- Current status AMCU upheld: {outcome_counts.get('upheld', 0):,}
- Current status overturned: {outcome_counts.get('overturned', 0):,}
- Current status partially overturned: {outcome_counts.get('partially_overturned', 0):,}

## Technical completeness

- Run technically complete: {'YES' if technically_complete else 'NO'}
- Registry write blocked: {'YES' if registry_write_blocked_reason else 'NO'}
- Block reason: {registry_write_blocked_reason or 'none'}
- Not processed because of budget/technical response: {len(not_processed_rows):,}
- Gemini request errors: {len(gemini_errors):,}
- Current-status coverage gap: {current_status_coverage_gap:,}

Gemini legal classification is only `YES` or `NO`. Budget exhaustion, API errors, missing candidate IDs or invalid responses are recorded separately in `diagnostics.json`; they are never treated as a legal result. The persistent registry is written only when the run is not dry-run and the full technical scan is complete. Any incomplete challenge classification, weak-YES safeguard, merits verification or court-text fetch blocks the registry write, but diagnostics and the AI checkpoint are still written before the workflow fails.
{focus_md}
"""
        (out_dir / "report.md").write_text(report, encoding="utf-8")

    if not args.keep_zip:
        zip_path.unlink(missing_ok=True)

    if registry_write_blocked_reason:
        # Delayed failure: workflow can upload diagnostics and persist the checkpoint first.
        raise RuntimeError(registry_write_blocked_reason)

    log(
        f"Done: candidates_before_negative={fetch_stats['candidate_pairs_before_negative_filter']}; "
        f"negative_dropped={fetch_stats['negative_prefilter_pairs']}; "
        f"Gemini_queue={len(candidate_rows)}; known_pairs_reused={fetch_stats['known_confirmed_pairs_reused']}; "
        f"history_work_items={fetch_stats['known_history_work_items']}; "
        f"challenge_Gemini={gemini_calls}; safeguard_Gemini={safeguard_gemini_calls}; merits_Gemini={merits_gemini_calls}; current_status_Gemini={current_status_gemini_calls}; "
        f"YES={len(yes_rows)}; NO={len(no_rows)}; merits_found={merits_found_count}; "
        f"pending_no_merits={pending_no_merits_count}; merits_not_verified={merits_not_verified_count}; "
        f"not_processed={len(not_processed_rows)}; fetch_errors={len(fetch_errors)}"
    )
    log(f"Artifacts: {out_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
