#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import html
import io
import json
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

USER_AGENT = "amku-court-challenge-probe/0.5"
PASSPORT_URL_TEMPLATE = "https://dsa.court.gov.ua/open_data_json.php?json={dataset_id}"
DATASET_IDS = {2025: 879, 2026: 7636}
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
            "Diagnostic POC: metadata-prefilter EDRSR cases, find exact AMCU decision-number "
            "mentions, and use Gemini only to classify whether that decision is the subject of challenge."
        )
    )
    p.add_argument("--year", type=int, default=2026, choices=sorted(DATASET_IDS))
    p.add_argument("--dataset-id", type=int, default=0, help="Override DSA dataset id.")
    p.add_argument("--practice", default="data/practice/amku_practice.json")
    p.add_argument("--out-dir", default="data/tmp/amku_court_challenge_probe")
    p.add_argument("--cache-dir", default="data/tmp/amku_court_challenge_cache/v4")
    p.add_argument("--max-cases", type=int, default=0, help="0 = all prefiltered cases.")
    p.add_argument("--workers", type=int, default=4, help="Concurrent EDRSR text fetch workers.")
    p.add_argument("--request-delay-ms", type=int, default=0)
    p.add_argument("--request-timeout", type=int, default=45)
    p.add_argument("--retries", type=int, default=4)
    p.add_argument("--max-gemini-calls", type=int, default=30)
    p.add_argument("--gemini-rpm-limit", type=int, default=5)
    p.add_argument("--gemini-max-text-chars", type=int, default=30000)
    p.add_argument("--skip-gemini", action="store_true")
    p.add_argument(
        "--focus-decision",
        default="",
        help="Optional AMCU decision number for report/debug emphasis only; does not alter case selection.",
    )
    p.add_argument("--keep-zip", action="store_true")
    return p.parse_args()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


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
        row_id = clean(row.get("id")) or clean(row.get("decision_id")) or f"practice-{idx}"
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
) -> tuple[dict[str, list[DocRow]], dict[str, int], dict[str, dict[str, Any]], dict[str, int]]:
    """Cheap metadata filter: active + exact relevant category + commercial jurisdiction + cause_num."""
    member = find_zip_member(zf, "documents.csv")
    cases: dict[str, list[DocRow]] = defaultdict(list)
    stats = {
        "rows_total": 0,
        "active": 0,
        "category_match": 0,
        "commercial_match": 0,
        "with_cause_num": 0,
        "cases": 0,
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

            doc = doc_from_row(row)
            if not doc.cause_num:
                continue
            stats["with_cause_num"] += 1
            cases[doc.cause_num].append(doc)
            category_stats[cat]["cases"].add(doc.cause_num)

    stats["cases"] = len(cases)
    return cases, stats, category_stats, dict(justice_stats)

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

ЗАВДАННЯ:
Для КОЖНОГО candidate визнач лише YES або NO: чи є саме зазначене рішення АМКУ ПРЕДМЕТОМ СУДОВОГО ОСКАРЖЕННЯ У ПОТОЧНІЙ СУДОВІЙ СПРАВІ {cause_num}.

Важливо:
- Формулювання позовної вимоги може бути будь-яким: визнання незаконним, протиправним, неправомірним, недійсним, скасування, оскарження, повністю або в частині тощо. НЕ вимагай конкретної сталої фрази.
- YES: поточна справа спрямована на судову перевірку/оспорювання саме цього рішення АМКУ, повністю або в частині.
- NO: рішення лише згадується як передумова, доказ, історія іншої справи; або поточна справа стосується стягнення штрафу/пені, виконання рішення чи іншої вимоги, а саме рішення тут не оскаржується.
- Якщо оскаржується інше рішення АМКУ, а candidate лише згадується або був ним підтверджений/залишений без змін, поверни NO.
- Збіг повного номера рішення вже перевірений кодом. Назва порушника і дата — лише допоміжні ознаки.
- Обов'язково дай YES або NO для кожного candidate. Не використовуй UNCERTAIN/RELATED або інші статуси.

Поверни ТІЛЬКИ валідний JSON без markdown:
{{
  "results": [
    {{
      "candidate_id": "...",
      "classification": "YES|NO",
      "confidence": "high|medium|low",
      "challenger": "коротка назва позивача/скаржника або порожньо",
      "reason": "дуже коротко, чому"
    }}
  ]
}}

Суд: {court_name}
Номер поточної справи: {cause_num}
Дата документа: {doc.adjudication_date}
Doc ID: {doc.doc_id}

CANDIDATES:
{json.dumps(compact_candidates, ensure_ascii=False, indent=2)}

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
    candidates: list[dict[str, Any]],
    text: str,
    api_key: str,
    model: str,
    timeout: int,
    retries: int,
    max_text_chars: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    excerpt = text_excerpt_for_gemini(text, candidates, max_text_chars)
    prompt = build_gemini_prompt(cause_num, court_name, doc, candidates, excerpt)
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
        classified.append({
            **by_id[cid],
            "classification": cls,
            "gemini_confidence": conf,
            "challenger": clean(item.get("challenger")),
            "reason": clean(item.get("reason"))[:600],
        })

    for cid, candidate in by_id.items():
        if cid not in seen:
            not_processed.append({
                **candidate,
                "not_processed_reason": "Gemini did not return this candidate_id.",
            })

    return classified, not_processed, excerpt

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


def main() -> int:
    args = parse_args()
    year = args.year
    dataset_id = args.dataset_id or DATASET_IDS[year]
    practice_path = Path(args.practice)
    out_dir = Path(args.out_dir)
    cache_dir = Path(args.cache_dir)
    ensure_dir(out_dir)
    ensure_dir(cache_dir)

    practice = load_practice(practice_path)
    number_index = build_number_index(practice)
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
        "gemini_results": [],
        "not_processed": [],
        "fetch_failures": [],
    }

    log(f"Practice rows: {len(practice):,}; unique decision numbers: {len(number_index):,}")
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
        "fallback_candidate_cases": 0,
        "candidate_documents_before_negative_filter": 0,
        "candidate_pairs_before_negative_filter": 0,
        "negative_prefilter_cases": 0,
        "negative_prefilter_pairs": 0,
        "candidate_documents": 0,
        "candidate_pairs": 0,
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

        cases, stats, category_stats, justice_stats = scan_prefilter(
            zf,
            cat_codes,
            commercial_codes,
        )

        log(
            "Prefilter: "
            f"rows={stats['rows_total']:,}; "
            f"active={stats['active']:,}; "
            f"category={stats['category_match']:,}; "
            f"commercial={stats['commercial_match']:,}; "
            f"with_case={stats['with_cause_num']:,}; "
            f"cases={stats['cases']:,}"
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

                    if negative.get("exclude"):
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
                                "reason": "Latest substantive/current document explicitly identifies AMCU as plaintiff and shows no counterclaim against AMCU.",
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
        if candidate_docs and not args.skip_gemini and not api_key:
            raise RuntimeError("GEMINI_API_KEY is required because exact-number candidates were found.")

        yes_rows: list[dict[str, Any]] = []
        no_rows: list[dict[str, Any]] = []
        not_processed_rows: list[dict[str, Any]] = []
        gemini_errors: list[dict[str, Any]] = []
        gemini_calls = 0
        min_call_interval = 60.0 / max(1, args.gemini_rpm_limit) if args.gemini_rpm_limit > 0 else 0.0
        last_call_started = 0.0

        for entry in candidate_docs:
            doc: DocRow = entry["doc"]
            merits: DocRow | None = entry["latest_merits"]
            text = text_cache_for_gemini.get(doc.doc_id, "")
            candidates = entry["candidates"]

            classified: list[dict[str, Any]] = []
            technical_not_processed: list[dict[str, Any]] = []

            if args.skip_gemini:
                technical_not_processed = [
                    {**c, "not_processed_reason": "Gemini skipped by --skip-gemini."}
                    for c in candidates
                ]
            elif gemini_calls >= args.max_gemini_calls:
                technical_not_processed = [
                    {**c, "not_processed_reason": f"Gemini call budget exceeded ({args.max_gemini_calls})."}
                    for c in candidates
                ]
            else:
                elapsed = time.monotonic() - last_call_started
                if last_call_started and min_call_interval > 0 and elapsed < min_call_interval:
                    time.sleep(min_call_interval - elapsed)
                last_call_started = time.monotonic()
                gemini_calls += 1
                log(
                    f"Gemini {gemini_calls}/{args.max_gemini_calls}: case {entry['cause_num']}; "
                    f"candidate(s)={len(candidates)}"
                )
                try:
                    classified, technical_not_processed, _excerpt = classify_candidates_with_gemini(
                        entry["cause_num"],
                        entry["court"],
                        doc,
                        candidates,
                        text,
                        api_key,
                        gemini_model,
                        args.request_timeout,
                        args.retries,
                        args.gemini_max_text_chars,
                    )
                except Exception as exc:  # noqa: BLE001
                    gemini_errors.append({
                        "cause_num": entry["cause_num"],
                        "doc_id": doc.doc_id,
                        "error": str(exc),
                        "candidates": candidates,
                    })
                    technical_not_processed = [
                        {**c, "not_processed_reason": f"Gemini error: {str(exc)[:300]}"}
                        for c in candidates
                    ]

            for result in classified:
                row = {
                    "decision_number": result["decision_number"],
                    "decision_date": result["decision_date"],
                    "liable_parties": result["liable_parties"],
                    "prefilter_strength": result["strength"],
                    "signals": result["signals"],
                    "classification": result["classification"],
                    "gemini_confidence": result["gemini_confidence"],
                    "challenger": result["challenger"],
                    "reason": result["reason"],
                    "cause_num": entry["cause_num"],
                    "matched_on_doc_id": doc.doc_id,
                    "matched_on_source": entry["candidate_source"],
                    "primary_doc_id": entry["primary_doc"].doc_id,
                    "primary_kind": entry["primary_kind"],
                    "court": entry["court"],
                    "category_code": entry["category_code"],
                    "category_name": entry["category_name"],
                    "latest_merits_doc_id": merits.doc_id if merits else "",
                    "latest_merits_type": judgment_forms.get(merits.judgment_code, "") if merits else "",
                    "latest_merits_date": merits.adjudication_date if merits else "",
                    "latest_merits_url": PUBLIC_EDRSR_URL.format(doc_id=merits.doc_id) if merits else "",
                    "challenge_status": "merits_found" if merits else "pending_no_merits",
                }
                if row["classification"] == "YES":
                    yes_rows.append(row)
                else:
                    no_rows.append(row)
                if focus_norm and normalized_number(row["decision_number"]) == focus_norm:
                    focus_debug["gemini_results"].append(row)

            for result in technical_not_processed:
                row = {
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

        summary = {
            "schema": "amku_court_challenge_probe_v5",
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "year": year,
            "dataset_id": dataset_id,
            "zip_url": zip_url,
            "practice_rows": len(practice),
            "unique_decision_numbers": len(number_index),
            "commercial_justice_codes": sorted(commercial_codes),
            "prefilter": stats,
            "cases_scanned": len(jobs),
            "text_fetch": fetch_stats,
            "candidate_documents_before_negative_filter": fetch_stats["candidate_documents_before_negative_filter"],
            "candidate_pairs_before_negative_filter": fetch_stats["candidate_pairs_before_negative_filter"],
            "negative_prefilter_cases": fetch_stats["negative_prefilter_cases"],
            "negative_prefilter_pairs": fetch_stats["negative_prefilter_pairs"],
            "candidate_documents_sent_to_gemini_queue": len(candidate_docs),
            "candidate_pairs_sent_to_gemini_queue": len(candidate_rows),
            "gemini_model": gemini_model,
            "gemini_calls": gemini_calls,
            "gemini_call_limit": args.max_gemini_calls,
            "confirmed_challenges": len(yes_rows),
            "rejected_mentions": len(no_rows),
            "not_processed": len(not_processed_rows),
            "gemini_errors": len(gemini_errors),
            "focus_decision": args.focus_decision,
            "focus_confirmed": [
                row for row in yes_rows
                if focus_norm and normalized_number(row["decision_number"]) == focus_norm
            ],
        }

        (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "matches.json").write_text(json.dumps(yes_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "rejected.json").write_text(json.dumps(no_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "not_processed.json").write_text(json.dumps(not_processed_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "negative_prefilter.json").write_text(json.dumps(negative_prefilter_rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "fetch_errors.json").write_text(json.dumps(fetch_errors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "gemini_errors.json").write_text(json.dumps(gemini_errors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (out_dir / "focus_debug.json").write_text(json.dumps(focus_debug, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        common_result_columns = [
            "decision_date", "decision_number", "liable_parties", "cause_num", "classification",
            "gemini_confidence", "challenger", "prefilter_strength", "signals", "reason",
            "court", "category_code", "category_name", "matched_on_doc_id", "matched_on_source",
            "primary_doc_id", "primary_kind", "challenge_status", "latest_merits_doc_id",
            "latest_merits_type", "latest_merits_date", "latest_merits_url",
        ]
        write_csv(out_dir / "matches.csv", yes_rows, common_result_columns)
        write_csv(out_dir / "rejected.csv", no_rows, common_result_columns)
        write_csv(
            out_dir / "not_processed.csv",
            not_processed_rows,
            [
                "decision_date", "decision_number", "liable_parties", "cause_num", "prefilter_strength",
                "signals", "court", "matched_on_doc_id", "matched_on_source", "primary_doc_id",
                "primary_kind", "not_processed_reason",
            ],
        )
        write_csv(
            out_dir / "negative_prefilter.csv",
            negative_prefilter_rows,
            [
                "decision_date", "decision_number", "liable_parties", "cause_num", "strength", "signals",
                "matched_on_doc_id", "matched_on_source", "primary_doc_id", "primary_kind",
                "negative_prefilter", "reason",
            ],
        )
        write_csv(
            out_dir / "candidates.csv",
            candidate_rows,
            [
                "decision_date", "decision_number", "liable_parties", "cause_num", "strength", "signals",
                "doc_id", "doc_date", "candidate_source", "primary_doc_id", "primary_kind", "court",
                "category_code", "category_name", "latest_merits_doc_id", "latest_merits_date",
            ],
        )
        write_csv(
            out_dir / "prefilter_cases.csv",
            prefilter_rows,
            [
                "cause_num", "documents", "category_code", "category_name", "justice_kind", "primary_kind",
                "primary_doc_id", "primary_date", "earliest_doc_id", "earliest_date", "latest_active_doc_id",
                "latest_active_date", "latest_merits_doc_id", "latest_merits_date", "latest_merits_form",
            ],
        )
        write_csv(
            out_dir / "category_stats.csv",
            matched_category_rows,
            [
                "category_code", "name", "primary_challenge_category", "active_documents",
                "commercial_documents", "cases",
            ],
        )
        write_csv(
            out_dir / "justice_stats.csv",
            justice_rows,
            ["justice_kind", "name", "category_matched_documents"],
        )
        write_csv(
            out_dir / "fetch_errors.csv",
            fetch_errors,
            ["cause_num", "role", "doc_id", "doc_url", "error", "attempts"],
        )
        write_csv(
            out_dir / "gemini_errors.csv",
            gemini_errors,
            ["cause_num", "doc_id", "error", "candidates"],
        )

        focus_md = ""
        if args.focus_decision:
            focus_confirmed = summary["focus_confirmed"]
            focus_md = (
                f"\n## Focus `{args.focus_decision}`\n\n"
                f"- Candidate document(s) after exact-number search: {len(focus_debug['candidate_hits'])}\n"
                f"- Dropped by AMCU-plaintiff negative prefilter: {len(focus_debug['negative_prefilter_hits'])}\n"
                f"- Gemini-confirmed challenge(s): {len(focus_confirmed)}\n"
                f"- Not processed technically/budget: {len(focus_debug['not_processed'])}\n"
            )
            for h in focus_confirmed:
                focus_md += (
                    f"- case `{h['cause_num']}`, status `{h['challenge_status']}`, "
                    f"latest merits `{h['latest_merits_doc_id'] or 'none'}`\n"
                )

        report = f"""# AMCU court challenge probe v5 — {year}

Generated: {summary['generated_at']}

## Pipeline

`EDRSR metadata -> active + exact competition category + commercial jurisdiction -> latest merits (else latest active) -> exact AMCU decision number -> cautious AMCU-plaintiff negative prefilter -> Gemini YES/NO`

If the primary latest document contains no exact AMCU practice decision number, the earliest active document is fetched once as a fallback. Party/date matches remain corroborating signals only.

## Metadata prefilter

- Practice rows: {len(practice):,}
- Unique AMCU decision numbers: {len(number_index):,}
- EDRSR rows: {stats['rows_total']:,}
- Active rows: {stats['active']:,}
- Exact competition-category rows: {stats['category_match']:,}
- Commercial-jurisdiction rows: {stats['commercial_match']:,}
- Rows with case number: {stats['with_cause_num']:,}
- Unique prefiltered cases: {stats['cases']:,}
- Cases actually scanned: {len(jobs):,}

## Candidate discovery

- Court texts requested: {fetch_stats['documents_requested']:,}
- Primary latest texts: {fetch_stats['primary_documents']:,}
- Earliest fallback texts: {fetch_stats['fallback_documents']:,}
- Cases where fallback found the exact number: {fetch_stats['fallback_candidate_cases']:,}
- Validated court texts: {fetch_stats['validated_documents']:,}
- Persistent/cache hits: {fetch_stats['cache_hits']:,}
- Fetch errors: {fetch_stats['fetch_errors']:,}
- Candidate cases before AMCU-plaintiff negative filter: {fetch_stats['candidate_documents_before_negative_filter']:,}
- Candidate pairs before negative filter: {fetch_stats['candidate_pairs_before_negative_filter']:,}
- Cases dropped because the latest document clearly shows AMCU as plaintiff and no counterclaim against AMCU: {fetch_stats['negative_prefilter_cases']:,}
- Candidate pairs dropped by that negative filter: {fetch_stats['negative_prefilter_pairs']:,}
- Candidate cases remaining for Gemini queue: {len(candidate_docs):,}
- Candidate pairs remaining for Gemini queue: {len(candidate_rows):,}

## Gemini classification

- Model: `{gemini_model}`
- Calls used: {gemini_calls:,}/{args.max_gemini_calls:,}
- Confirmed challenge pairs (`YES`): {len(yes_rows):,}
- Rejected mentions (`NO`): {len(no_rows):,}
- Not processed because of budget/technical response: {len(not_processed_rows):,}
- Gemini request errors: {len(gemini_errors):,}

Gemini is required to return only `YES` or `NO`. Budget exhaustion, API errors, missing candidate IDs or invalid classifications are recorded separately in `not_processed.csv`; they are not treated as a legal classification.
{focus_md}
"""
        (out_dir / "report.md").write_text(report, encoding="utf-8")

    if not args.keep_zip:
        zip_path.unlink(missing_ok=True)

    log(
        f"Done: candidates_before_negative={fetch_stats['candidate_pairs_before_negative_filter']}; "
        f"negative_dropped={fetch_stats['negative_prefilter_pairs']}; "
        f"Gemini_queue={fetch_stats['candidate_pairs']}; Gemini={gemini_calls}; "
        f"YES={len(yes_rows)}; NO={len(no_rows)}; not_processed={len(not_processed_rows)}; "
        f"fetch_errors={len(fetch_errors)}"
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
