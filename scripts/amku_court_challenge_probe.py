#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import shutil
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

USER_AGENT = "amku-court-challenge-probe/0.2"
PASSPORT_URL_TEMPLATE = "https://dsa.court.gov.ua/open_data_json.php?json={dataset_id}"
DATASET_IDS = {
    2025: 879,
    2026: 7636,
}
PUBLIC_EDRSR_URL = "https://reyestr.court.gov.ua/Review/{doc_id}"

# Select only categories whose *own name* is relevant.
# IMPORTANT: do not expand numeric-code prefixes as descendants. The EDRSR
# classifier is not safe to traverse with simple startswith() logic.
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
COMMERCIAL_JUSTICE_RE = re.compile(r"господар", re.IGNORECASE)

CHALLENGE_PATTERNS = [
    re.compile(r"про\s+визнання\s+недійсн\w*\s+(?:та\s+)?скасуван\w*\s+рішен", re.I),
    re.compile(r"визнан\w*\s+недійсн\w*.{0,120}скасуван\w*.{0,120}рішен", re.I | re.S),
    re.compile(r"визнан\w*\s+протиправн\w*.{0,120}скасуван\w*.{0,120}рішен", re.I | re.S),
    re.compile(r"скасуван\w*.{0,120}рішен\w*\s+антимонопольн", re.I | re.S),
    re.compile(r"оскаржен\w*.{0,160}рішен\w*\s+антимонопольн", re.I | re.S),
]

AMCU_RE = re.compile(r"антимонопольн\w*\s+комітет\w*\s+україн", re.I)

MERITS_FORM_RE = re.compile(r"(?:^|\s)(рішення|постанова)(?:\s|$)", re.I)


@dataclass
class PracticeRow:
    raw: dict[str, Any]
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


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Diagnostic POC: find court challenges of AMCU practice decisions in EDRSR open data."
    )
    p.add_argument("--year", type=int, default=2026, choices=sorted(DATASET_IDS))
    p.add_argument("--dataset-id", type=int, default=0, help="Override DSA dataset id.")
    p.add_argument("--practice", default="data/practice/amku_practice.json")
    p.add_argument("--out-dir", default="data/tmp/amku_court_challenge_probe")
    p.add_argument("--cache-dir", default="data/tmp/amku_court_challenge_cache")
    p.add_argument("--max-cases", type=int, default=0, help="0 = all prefiltered cases.")
    p.add_argument("--request-delay-ms", type=int, default=150)
    p.add_argument("--request-timeout", type=int, default=45)
    p.add_argument("--retries", type=int, default=4)
    p.add_argument(
        "--focus-decision",
        default="",
        help="Optional AMCU decision number. When set, max-cases is ignored so the full prefilter is scanned.",
    )
    p.add_argument(
        "--keep-zip",
        action="store_true",
        help="Keep downloaded yearly ZIP in cache after the run.",
    )
    return p.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def http_bytes(url: str, timeout: int, retries: int) -> bytes:
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.read()
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


def clean(v: Any) -> str:
    return str(v or "").replace("\ufeff", "").strip()


def normalize_text(v: Any) -> str:
    raw = clean(v).replace("№", " ")
    s = unicodedata.normalize("NFKC", raw).lower()
    s = s.replace("ґ", "г")
    s = re.sub(r"[’'`ʼ«»“”„]", " ", s)
    s = re.sub(r"[‐‑‒–—−]", "-", s)
    s = re.sub(r"[^0-9a-zа-яіїєг/\-]+", " ", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


def normalized_number(v: Any) -> str:
    # Canonical form for equality/reporting only. Keep slash structure so
    # 30-р is NOT treated as equivalent to 72/30-р/к.
    s = unicodedata.normalize("NFKC", clean(v)).lower().replace("№", "")
    s = s.replace("ґ", "г")
    s = re.sub(r"[‐‑‒–—−]", "-", s)
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[^0-9a-zа-яіїєг/\-]", "", s, flags=re.I)
    return s


def decision_number_regex(v: Any) -> re.Pattern[str]:
    """Compile a structure-preserving AMCU decision-number matcher.

    Examples:
      393-р     matches №393-р / 393 р
      30-р      does NOT match 72/30-р/к
      72/30-р/к matches the full compound number
    """
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
            # Court texts sometimes omit the dash before a letter suffix.
            body.append(r"\s*[-‐‑‒–—−]?\s*")
        else:
            body.append(re.escape(part))

    # Slash is explicitly forbidden next to the match. This is what prevents
    # a short number (30-р) from matching inside 72/30-р/к.
    return re.compile(
        r"(?<![0-9a-zа-яіїєг/])" + "".join(body) + r"(?![0-9a-zа-яіїєг/])",
        re.I,
    )


def date_variants(iso_date: str) -> list[str]:
    m = re.fullmatch(r"(20\d{2})-(\d{2})-(\d{2})", iso_date or "")
    if not m:
        return []
    y, mo, d = m.groups()
    month_names = {
        "01": "січня", "02": "лютого", "03": "березня", "04": "квітня",
        "05": "травня", "06": "червня", "07": "липня", "08": "серпня",
        "09": "вересня", "10": "жовтня", "11": "листопада", "12": "грудня",
    }
    raw = [
        f"{d}.{mo}.{y}",
        f"{int(d)}.{int(mo)}.{y}",
        f"{y}-{mo}-{d}",
        f"{int(d)} {month_names.get(mo, mo)} {y}",
    ]
    return sorted({normalize_text(x) for x in raw if x})


def load_practice(path: Path) -> list[PracticeRow]:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))

    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, dict):
        rows = []
        for key in ("rows", "results", "items", "practice", "data"):
            if isinstance(raw.get(key), list):
                rows = raw[key]
                break
    else:
        rows = []

    out: list[PracticeRow] = []
    for row in rows:
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
        out.append(
            PracticeRow(
                raw=row,
                decision_number=num,
                decision_date=date,
                liable_parties=parties,
                decision_number_norm=normalized_number(num),
                decision_number_pattern=decision_number_regex(num),
                party_norms=[normalize_text(x) for x in parties if normalize_text(x)],
            )
        )
    return out


def category_name_is_relevant(name: str) -> bool:
    return any(pattern.search(name or "") for pattern in CATEGORY_PATTERNS)


def relevant_category_codes(categories: dict[str, str]) -> set[str]:
    # Exact category-name selection only. No numeric-prefix descendant expansion.
    return {
        code for code, name in categories.items()
        if category_name_is_relevant(name)
    }


def primary_challenge_category_codes(categories: dict[str, str]) -> set[str]:
    return {
        code for code, name in categories.items()
        if PRIMARY_CHALLENGE_CATEGORY_RE.search(name or "")
    }


def commercial_justice_codes(justice: dict[str, str]) -> set[str]:
    return {code for code, name in justice.items() if COMMERCIAL_JUSTICE_RE.search(name or "")}


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
    s = clean(v)
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%Y-%m-%d %H:%M:%S"):
        try:
            return (1, datetime.strptime(s[:19], fmt).isoformat())
        except ValueError:
            pass
    return (0, s)


def doc_sort_key(d: DocRow) -> tuple[Any, ...]:
    return (
        date_sort_value(d.adjudication_date),
        date_sort_value(d.receipt_date),
        int(d.doc_id) if d.doc_id.isdigit() else 0,
    )


def scan_prefilter(
    zf: zipfile.ZipFile,
    relevant_categories: set[str],
    commercial_codes: set[str],
) -> tuple[dict[str, list[DocRow]], dict[str, int], dict[str, dict[str, Any]]]:
    member = find_zip_member(zf, "documents.csv")
    cases: dict[str, list[DocRow]] = defaultdict(list)
    stats = {
        "rows_total": 0,
        "active": 0,
        "category_match": 0,
        "commercial_and_category": 0,
        "cases": 0,
    }
    category_stats: dict[str, dict[str, Any]] = {
        code: {
            "category_code": code,
            "active_documents": 0,
            "commercial_documents": 0,
            "commercial_cases": set(),
        }
        for code in relevant_categories
    }

    with open_tsv_member(zf, member) as f:
        reader = csv.DictReader(f, delimiter="\t", quotechar='"')
        for row in reader:
            stats["rows_total"] += 1
            status = clean(row.get("status"))
            if status != "1":
                continue
            stats["active"] += 1

            cat = clean(row.get("category_code"))
            if cat not in relevant_categories:
                continue
            stats["category_match"] += 1
            category_stats[cat]["active_documents"] += 1

            justice = clean(row.get("justice_kind"))
            if justice not in commercial_codes:
                continue
            stats["commercial_and_category"] += 1
            category_stats[cat]["commercial_documents"] += 1

            doc = doc_from_row(row)
            if doc.cause_num:
                cases[doc.cause_num].append(doc)
                category_stats[cat]["commercial_cases"].add(doc.cause_num)

    stats["cases"] = len(cases)
    return cases, stats, category_stats


def html_to_text(raw: bytes) -> str:
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r"(?is)<script\b.*?</script>", " ", text)
    text = re.sub(r"(?is)<style\b.*?</style>", " ", text)
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p\s*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return html.unescape(text)


def fetch_doc_text(doc: DocRow, cache_dir: Path, timeout: int, retries: int) -> str:
    ensure_dir(cache_dir)
    cache = cache_dir / f"{doc.doc_id}.txt"
    if cache.exists() and cache.stat().st_size > 50:
        return cache.read_text(encoding="utf-8", errors="replace")

    urls = [doc.doc_url]
    public_url = PUBLIC_EDRSR_URL.format(doc_id=doc.doc_id)
    if public_url not in urls:
        urls.append(public_url)

    last: Exception | None = None
    for url in [u for u in urls if u]:
        try:
            body = http_bytes(url, timeout, retries)
            text = html_to_text(body)
            if len(text.strip()) < 100:
                raise RuntimeError(f"Very short document body from {url}")
            cache.write_text(text, encoding="utf-8")
            return text
        except Exception as exc:  # noqa: BLE001
            last = exc
            continue
    raise RuntimeError(f"Could not fetch doc {doc.doc_id}: {last}")


def is_merits_doc(doc: DocRow, judgment_forms: dict[str, str]) -> bool:
    name = normalize_text(judgment_forms.get(doc.judgment_code, ""))
    if "ухвала" in name or "судовий наказ" in name:
        return False
    return bool(MERITS_FORM_RE.search(name))


def representative_docs(docs: list[DocRow], judgment_forms: dict[str, str]) -> list[DocRow]:
    # Prefer earliest doc because opening-proceeding rulings usually state plaintiff,
    # defendant and the exact challenged AMCU decision. Also inspect latest merits doc
    # (if different) because it is the desired dashboard link.
    active = [d for d in docs if d.status == "1"]
    if not active:
        return []
    earliest = min(active, key=doc_sort_key)
    merits = [d for d in active if is_merits_doc(d, judgment_forms)]
    latest_merits = max(merits, key=doc_sort_key) if merits else None
    out = [earliest]
    if latest_merits and latest_merits.doc_id != earliest.doc_id:
        out.append(latest_merits)
    return out


def contains_challenge_signal(text_norm: str) -> bool:
    return any(p.search(text_norm) for p in CHALLENGE_PATTERNS)


def party_match_score(text_norm: str, party_norms: Iterable[str]) -> tuple[bool, str]:
    for party in party_norms:
        if len(party) >= 6 and party in text_norm:
            return True, party

        # Fallback: strip common legal-form words and require all remaining substantial tokens.
        tokens = [
            t
            for t in party.split()
            if len(t) >= 4
            and t not in {
                "товариство", "обмеженою", "відповідальністю", "приватне",
                "акціонерне", "публічне", "підприємство", "компанія", "фірма",
            }
        ]
        if tokens and all(t in text_norm for t in tokens[:5]):
            return True, " ".join(tokens[:5])
    return False, ""


def match_practice(text: str, practice: list[PracticeRow]) -> list[dict[str, Any]]:
    text_norm = normalize_text(text)
    has_amcu = bool(AMCU_RE.search(text_norm))
    has_challenge = contains_challenge_signal(text_norm)

    if not has_amcu:
        return []

    matches: list[dict[str, Any]] = []
    padded = f" {text_norm} "

    for row in practice:
        if not row.decision_number_norm:
            continue

        # Structure-preserving exact number match. This prevents e.g. 30-р from
        # matching inside a different compound number such as 72/30-р/к.
        num_hit = bool(row.decision_number_pattern.search(text_norm))
        party_hit, party_needle = party_match_score(text_norm, row.party_norms)
        date_hit = any(f" {v} " in padded for v in date_variants(row.decision_date))

        # High confidence now requires corroboration beyond the number itself:
        # AMCU + explicit challenge language + exact full decision number + (date OR liable party).
        if num_hit and has_challenge and (party_hit or date_hit):
            confidence = "high"
        elif num_hit and has_challenge:
            confidence = "review"
        elif has_challenge and party_hit and date_hit:
            confidence = "medium"
        elif num_hit and (party_hit or date_hit):
            confidence = "review"
        else:
            continue

        matches.append({
            "decision_number": row.decision_number,
            "decision_date": row.decision_date,
            "liable_parties": row.liable_parties,
            "confidence": confidence,
            "signals": {
                "amcu": has_amcu,
                "challenge": has_challenge,
                "decision_number": num_hit,
                "decision_date": date_hit,
                "liable_party": party_hit,
                "party_needle": party_needle,
            },
        })

    return matches


def latest_merits(docs: list[DocRow], judgment_forms: dict[str, str]) -> DocRow | None:
    merits = [d for d in docs if d.status == "1" and is_merits_doc(d, judgment_forms)]
    return max(merits, key=doc_sort_key) if merits else None


def csv_cell(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def write_csv(path: Path, rows: list[dict[str, Any]], columns: list[str]) -> None:
    ensure_dir(path.parent)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        w.writeheader()
        for row in rows:
            w.writerow({k: csv_cell(row.get(k)) for k in columns})


def main() -> int:
    args = parse_args()
    year = args.year
    dataset_id = args.dataset_id or DATASET_IDS[year]
    practice_path = Path(args.practice)
    out_dir = Path(args.out_dir)
    cache_dir = Path(args.cache_dir)
    ensure_dir(out_dir)
    ensure_dir(cache_dir)

    if not practice_path.exists():
        raise FileNotFoundError(f"Practice file not found: {practice_path}")

    practice = load_practice(practice_path)
    log(f"Practice rows loaded: {len(practice):,}")

    zip_url = fetch_passport_zip_url(year, dataset_id, args.request_timeout, args.retries)
    log(f"EDRSR ZIP URL resolved from passport: {zip_url}")
    zip_path = cache_dir / f"edrsr_data_{year}.zip"
    download_file(zip_url, zip_path, max(120, args.request_timeout), args.retries)

    with zipfile.ZipFile(zip_path) as zf:
        categories = read_dict_tsv(zf, "cause_categories.csv", "category_code")
        justice = read_dict_tsv(zf, "justice_kinds.csv", "justice_kind")
        judgment_forms = read_dict_tsv(zf, "judgment_forms.csv", "judgment_code")
        courts = read_dict_tsv(zf, "courts.csv", "court_code")

        cat_codes = relevant_category_codes(categories)
        primary_cat_codes = primary_challenge_category_codes(categories)
        comm_codes = commercial_justice_codes(justice)

        if not cat_codes:
            raise RuntimeError("No antimonopoly/competition categories found in cause_categories.csv")
        if not comm_codes:
            raise RuntimeError("No commercial justice code found in justice_kinds.csv")

        log("Matched justice kinds:")
        for code in sorted(comm_codes):
            log(f"  {code}: {justice.get(code, '')}")
        log(f"Relevant category codes (exact name matches only): {len(cat_codes)}")
        for code in sorted(cat_codes)[:40]:
            log(f"  {code}: {categories.get(code, '')}")
        if len(cat_codes) > 40:
            log(f"  ... +{len(cat_codes) - 40} more")

        cases, stats, category_stats = scan_prefilter(zf, cat_codes, comm_codes)
        log(
            "Prefilter: "
            f"rows={stats['rows_total']:,}; active={stats['active']:,}; "
            f"category={stats['category_match']:,}; "
            f"commercial+category={stats['commercial_and_category']:,}; "
            f"cases={stats['cases']:,}"
        )

        def case_priority(item: tuple[str, list[DocRow]]) -> tuple[Any, ...]:
            _cause_num, docs = item
            primary = any(d.category_code in primary_cat_codes for d in docs)
            latest = max((doc_sort_key(d) for d in docs), default=((0, ""), (0, ""), 0))
            return (1 if primary else 0, latest)

        ordered_cases = sorted(cases.items(), key=case_priority, reverse=True)

        if args.focus_decision:
            if args.max_cases > 0 and len(ordered_cases) > args.max_cases:
                log(
                    f"Focus mode `{args.focus_decision}`: ignoring --max-cases={args.max_cases}; "
                    f"scanning all {len(ordered_cases):,} prefiltered cases."
                )
        elif args.max_cases > 0:
            ordered_cases = ordered_cases[: args.max_cases]

        prefilter_rows: list[dict[str, Any]] = []
        match_rows: list[dict[str, Any]] = []
        review_rows: list[dict[str, Any]] = []
        fetch_errors: list[dict[str, Any]] = []

        for idx, (cause_num, docs) in enumerate(ordered_cases, start=1):
            reps = representative_docs(docs, judgment_forms)
            merits = latest_merits(docs, judgment_forms)
            earliest = min(docs, key=doc_sort_key)

            prefilter_rows.append({
                "cause_num": cause_num,
                "documents": len(docs),
                "earliest_doc_id": earliest.doc_id,
                "earliest_date": earliest.adjudication_date,
                "latest_merits_doc_id": merits.doc_id if merits else "",
                "latest_merits_date": merits.adjudication_date if merits else "",
                "latest_merits_form": judgment_forms.get(merits.judgment_code, "") if merits else "",
            })

            if idx == 1 or idx % 25 == 0:
                log(f"Text scan case {idx}/{len(ordered_cases)}: {cause_num}")

            case_matches: dict[tuple[str, str], dict[str, Any]] = {}
            inspected_doc_ids: list[str] = []

            for rep in reps:
                try:
                    text = fetch_doc_text(rep, cache_dir / "texts", args.request_timeout, args.retries)
                    inspected_doc_ids.append(rep.doc_id)
                except Exception as exc:  # noqa: BLE001
                    fetch_errors.append({
                        "cause_num": cause_num,
                        "doc_id": rep.doc_id,
                        "doc_url": rep.doc_url,
                        "error": str(exc),
                    })
                    continue

                for m in match_practice(text, practice):
                    key = (m["decision_date"], m["decision_number"])
                    existing = case_matches.get(key)
                    rank = {"high": 3, "medium": 2, "review": 1}
                    if not existing or rank[m["confidence"]] > rank[existing["confidence"]]:
                        case_matches[key] = {**m, "matched_on_doc_id": rep.doc_id}

                if args.request_delay_ms > 0:
                    time.sleep(args.request_delay_ms / 1000)

            for m in case_matches.values():
                target = match_rows if m["confidence"] == "high" else review_rows
                target.append({
                    "decision_number": m["decision_number"],
                    "decision_date": m["decision_date"],
                    "liable_parties": m["liable_parties"],
                    "confidence": m["confidence"],
                    "cause_num": cause_num,
                    "matched_on_doc_id": m["matched_on_doc_id"],
                    "inspected_doc_ids": inspected_doc_ids,
                    "court": courts.get(earliest.court_code, ""),
                    "latest_merits_doc_id": merits.doc_id if merits else "",
                    "latest_merits_type": judgment_forms.get(merits.judgment_code, "") if merits else "",
                    "latest_merits_date": merits.adjudication_date if merits else "",
                    "latest_merits_url": PUBLIC_EDRSR_URL.format(doc_id=merits.doc_id) if merits else "",
                    "challenge_status": "merits_found" if merits else "pending_no_merits",
                    "signals": m["signals"],
                })

        # One AMCU decision should normally map to one court case, but preserve all matches
        # in the diagnostic artifact so duplicates/multiple proceedings are visible.
        match_rows.sort(key=lambda x: (x["decision_date"], x["decision_number"], x["cause_num"]), reverse=True)
        review_rows.sort(key=lambda x: (x["decision_date"], x["decision_number"], x["cause_num"]), reverse=True)

        matched_category_rows = []
        category_stat_rows = []
        for code in sorted(cat_codes):
            stat = category_stats.get(code, {})
            row = {
                "category_code": code,
                "name": categories.get(code, ""),
                "primary_challenge_category": code in primary_cat_codes,
                "active_documents": int(stat.get("active_documents", 0)),
                "commercial_documents": int(stat.get("commercial_documents", 0)),
                "commercial_cases": len(stat.get("commercial_cases", set())),
            }
            matched_category_rows.append(row)
            category_stat_rows.append(row)
        category_stat_rows.sort(
            key=lambda r: (r["commercial_cases"], r["commercial_documents"], r["category_code"]),
            reverse=True,
        )

        summary = {
            "schema": "amku_court_challenge_probe_v2",
            "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "year": year,
            "dataset_id": dataset_id,
            "zip_url": zip_url,
            "practice_rows": len(practice),
            "prefilter": stats,
            "cases_scanned": len(ordered_cases),
            "high_confidence_matches": len(match_rows),
            "manual_review_matches": len(review_rows),
            "fetch_errors": len(fetch_errors),
            "commercial_justice_codes": [
                {"code": code, "name": justice.get(code, "")} for code in sorted(comm_codes)
            ],
            "relevant_category_codes_count": len(cat_codes),
            "primary_challenge_category_codes": [
                {"code": code, "name": categories.get(code, "")}
                for code in sorted(primary_cat_codes)
            ],
            "focus_decision": args.focus_decision,
            "focus_hits": [
                row for row in match_rows + review_rows
                if args.focus_decision and normalized_number(row["decision_number"]) == normalized_number(args.focus_decision)
            ],
        }

        (out_dir / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (out_dir / "matches.json").write_text(
            json.dumps(match_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (out_dir / "manual_review.json").write_text(
            json.dumps(review_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        (out_dir / "fetch_errors.json").write_text(
            json.dumps(fetch_errors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

        write_csv(
            out_dir / "matches.csv",
            match_rows,
            [
                "decision_date", "decision_number", "liable_parties", "cause_num", "confidence",
                "challenge_status", "court", "matched_on_doc_id", "latest_merits_doc_id",
                "latest_merits_type", "latest_merits_date", "latest_merits_url", "signals",
            ],
        )
        write_csv(
            out_dir / "manual_review.csv",
            review_rows,
            [
                "decision_date", "decision_number", "liable_parties", "cause_num", "confidence",
                "challenge_status", "court", "matched_on_doc_id", "latest_merits_doc_id",
                "latest_merits_type", "latest_merits_date", "latest_merits_url", "signals",
            ],
        )
        write_csv(
            out_dir / "prefilter_cases.csv",
            prefilter_rows,
            [
                "cause_num", "documents", "earliest_doc_id", "earliest_date",
                "latest_merits_doc_id", "latest_merits_date", "latest_merits_form",
            ],
        )
        write_csv(
            out_dir / "matched_categories.csv",
            matched_category_rows,
            [
                "category_code", "name", "primary_challenge_category",
                "active_documents", "commercial_documents", "commercial_cases",
            ],
        )
        write_csv(
            out_dir / "category_stats.csv",
            category_stat_rows,
            [
                "category_code", "name", "primary_challenge_category",
                "active_documents", "commercial_documents", "commercial_cases",
            ],
        )
        write_csv(
            out_dir / "fetch_errors.csv",
            fetch_errors,
            ["cause_num", "doc_id", "doc_url", "error"],
        )

        focus_md = ""
        if args.focus_decision:
            focus_hits = summary["focus_hits"]
            if focus_hits:
                focus_md = f"\n## Focus `{args.focus_decision}`\n\nFound {len(focus_hits)} hit(s).\n"
                for h in focus_hits:
                    focus_md += (
                        f"- case `{h['cause_num']}`, confidence `{h['confidence']}`, "
                        f"status `{h['challenge_status']}`, latest merits `{h['latest_merits_doc_id'] or 'none'}`\n"
                    )
            else:
                focus_md = f"\n## Focus `{args.focus_decision}`\n\nNo hit found.\n"

        report = f"""# AMCU court challenge probe — {year}

Generated: {summary['generated_at']}

## Prefilter

- Practice rows: {len(practice):,}
- EDRSR rows: {stats['rows_total']:,}
- Active rows: {stats['active']:,}
- Competition-category rows: {stats['category_match']:,}
- Commercial + competition rows: {stats['commercial_and_category']:,}
- Unique prefiltered cases: {stats['cases']:,}
- Cases actually scanned: {len(ordered_cases):,}

## Matching

- High-confidence AMCU challenge matches: {len(match_rows):,}
- Manual-review matches: {len(review_rows):,}
- Text fetch errors: {len(fetch_errors):,}

High confidence means the inspected court text contains the AMCU name, an explicit challenge/cancellation signal, the exact full AMCU decision number, and at least one corroborating signal: the AMCU decision date or a liable party.

Decision-number matching preserves slash structure, so a short number such as `30-р` is not accepted inside a different compound number such as `72/30-р/к`.

`pending_no_merits` means the challenge is found but the case has no active `Рішення`/`Постанова` in this yearly EDRSR archive yet.
{focus_md}
"""
        (out_dir / "report.md").write_text(report, encoding="utf-8")

    if not args.keep_zip:
        zip_path.unlink(missing_ok=True)

    log(f"High-confidence matches: {len(match_rows)}")
    log(f"Manual review: {len(review_rows)}")
    log(f"Fetch errors: {len(fetch_errors)}")
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
