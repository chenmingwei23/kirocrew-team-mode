"""Append-only JSONL ledger under one exclusive write lock.

Every file below ``root`` is a list of rows ``{"v", "seq", "ts", "type", "by", "data"}``
with ``seq`` starting at 1 and increasing by exactly 1. A reader that finds a gap,
a duplicate, an unparseable row or a torn last line raises :class:`LedgerCorrupt`
instead of skipping, so a fold never silently drops a message.

All writes in both processes (gateway hooks and each lead's stdio MCP server) go
through ``root/.lock`` (``fcntl.flock`` exclusive). :func:`transaction` holds the
lock across a read-check-write so a limit is checked and charged in one critical
section. The lock is re-entrant inside one process (a thread-local depth count), so
helpers that append can be called from inside a transaction.

shortcut: one global lock and full-file reads per append; fine for a demo with at
most 6 leads, upgrade to per-file locks and a tail-seq cache if it grows.

Standard library only: this module is imported by the gateway hook (which may not
import ``kiro_crew``) and by the stdio MCP server and cron probe.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Iterator

VERSION = 1

# Files a caller may name. Everything is relative to root; no "..", no absolute path.
_FILE_RE = re.compile(
    r"^(directory|cases|control|decisions|peers)\.jsonl$"
    r"|^channels/[GD]-[0-9a-f]{8}\.jsonl$"
    r"|^members/L-[0-9a-f]{8}\.jsonl$"
)
# ``peer:P-x`` is another owner's gateway (cross-owner groups, ``peer.py``): on a mirror
# it stands where the hub's own ``owner`` stood, so the two owners never read as one.
_BY_RE = re.compile(r"^(owner|app|lead:L-[0-9a-f]{8}|peer:P-[0-9a-f]{8}|bar_raiser:[A-Za-z0-9_-]{1,64}"
                    r"|secretary:[A-Za-z0-9_-]{1,64})$")
_TYPE_RE = re.compile(r"^[a-z_]+/[a-z_]+$")

MAX_ROW_BYTES = 256 * 1024


class LedgerError(Exception):
    """A write was refused (bad file name, bad row)."""


class LedgerCorrupt(LedgerError):
    """A file on disk breaks the seq / JSON invariant. Never skipped."""


_local = threading.local()
_proc_lock = threading.RLock()


def _depth() -> dict:
    d = getattr(_local, "held", None)
    if d is None:
        d = {}
        _local.held = d
    return d


def check_file(file: str) -> str:
    if not isinstance(file, str) or not _FILE_RE.match(file):
        raise LedgerError(f"bad ledger file name: {file!r}")
    return file


@contextlib.contextmanager
def transaction(root: Path) -> Iterator[None]:
    """Hold the single exclusive write lock for ``root`` (re-entrant per thread)."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = str(root.resolve())
    held = _depth()
    if held.get(key):
        held[key] += 1
        try:
            yield
        finally:
            held[key] -= 1
        return
    with _proc_lock:
        fd = os.open(root / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            held[key] = 1
            try:
                yield
            finally:
                held.pop(key, None)
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def _parse(path: Path, file: str) -> list[dict]:
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return []
    if not raw:
        return []
    if not raw.endswith(b"\n"):
        raise LedgerCorrupt(f"{file}: torn last line")
    rows: list[dict] = []
    for n, line in enumerate(raw.split(b"\n")[:-1], start=1):
        try:
            row = json.loads(line)
        except (ValueError, UnicodeDecodeError) as exc:
            raise LedgerCorrupt(f"{file}: line {n} is not JSON") from exc
        if not isinstance(row, dict) or row.get("seq") != n:
            raise LedgerCorrupt(f"{file}: line {n} has seq {row.get('seq') if isinstance(row, dict) else None!r}, expected {n}")
        rows.append(row)
    return rows


def read(root: Path, file: str, since_seq: int = 0) -> list[dict]:
    """Rows with ``seq > since_seq``. Raises :class:`LedgerCorrupt` on any gap."""
    check_file(file)
    rows = _parse(Path(root) / file, file)
    return rows[since_seq:] if since_seq > 0 else rows


def tail_seq(root: Path, file: str) -> int:
    check_file(file)
    return len(_parse(Path(root) / file, file))


def _row(seq: int, type: str, by: str, data: dict, now: float | None) -> bytes:
    if not isinstance(type, str) or not _TYPE_RE.match(type):
        raise LedgerError(f"bad row type: {type!r}")
    if not isinstance(by, str) or not _BY_RE.match(by):
        raise LedgerError(f"bad row author: {by!r}")
    if not isinstance(data, dict):
        raise LedgerError("row data must be an object")
    row = {"v": VERSION, "seq": seq, "ts": round(time.time() if now is None else now, 3),
           "type": type, "by": by, "data": data}
    line = json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(line) > MAX_ROW_BYTES:
        raise LedgerError("row too large")
    return line


def _write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    try:
        view = memoryview(payload)
        while view:
            n = os.write(fd, view)
            view = view[n:]
        os.fsync(fd)
    finally:
        os.close(fd)


def _mirror_marker(root: Path, file: str) -> Path:
    return Path(root) / "mirrors" / Path(file).name


def is_mirror(root: Path, file: str) -> bool:
    """True for a channel this gateway only mirrors (another owner hosts it): only
    :func:`append_copy` writes it, so its seqs stay the hub's."""
    return _mirror_marker(root, file).exists()


def mark_mirror(root: Path, file: str) -> None:
    check_file(file)
    path = _mirror_marker(root, file)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.touch(mode=0o600, exist_ok=True)


def append(root: Path, file: str, type: str, by: str, data: dict, *, now: float | None = None) -> int:
    """Append one row; return its seq. Taken under the write lock."""
    return append_many(root, [(file, type, by, data)], now=now)[0]


def append_many(root: Path, rows: list[tuple[str, str, str, dict]], *, now: float | None = None) -> list[int]:
    """Append several rows (possibly to several files) under one lock hold.

    Every row is validated before any byte is written, so a bad row writes nothing.
    """
    root = Path(root)
    with transaction(root):
        tails: dict[str, int] = {}
        out: list[tuple[str, bytes]] = []
        seqs: list[int] = []
        for file, type, by, data in rows:
            check_file(file)
            if is_mirror(root, file):
                raise LedgerError(f"{file}: mirror of another owner's group; only the host writes it")
            if file not in tails:
                tails[file] = tail_seq(root, file)
            tails[file] += 1
            out.append((file, _row(tails[file], type, by, data, now)))
            seqs.append(tails[file])
        grouped: dict[str, bytes] = {}
        for file, line in out:
            grouped[file] = grouped.get(file, b"") + line
        for file, payload in grouped.items():
            _write(root / file, payload)
        return seqs


def append_copy(root: Path, file: str, rows: list[dict]) -> int:
    """Append rows another gateway already numbered (a cross-owner mirror, ``peer.py``).

    Each row keeps its own ``seq`` and ``ts``; the first must be the file's tail + 1 and
    the rest follow by exactly 1, else :class:`LedgerError` and nothing is written.
    Returns the new tail seq."""
    root = Path(root)
    with transaction(root):
        check_file(file)
        tail = tail_seq(root, file)
        payload = b""
        for row in rows:
            if not isinstance(row, dict) or row.get("seq") != tail + 1:
                raise LedgerError(f"{file}: copied row out of order (want seq {tail + 1})")
            line = _row(tail + 1, row.get("type"), row.get("by"), row.get("data"), float(row.get("ts") or 0))
            payload += line
            tail += 1
        if payload:
            _write(root / file, payload)
        return tail


def list_files(root: Path, prefix: str) -> list[str]:
    """Relative names of existing ledger files under ``channels`` or ``members``."""
    d = Path(root) / prefix
    if not d.is_dir():
        return []
    names = sorted(f"{prefix}/{p.name}" for p in d.iterdir() if p.is_file())
    return [n for n in names if _FILE_RE.match(n)]
