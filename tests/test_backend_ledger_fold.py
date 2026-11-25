"""Ledger invariants (lock, continuous seq, gap refused) and the fold cache."""

from __future__ import annotations

import json
import shutil
import sys
import threading
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

from teamapp import fold, identity, ledger, send  # noqa: E402


def test_append_assigns_continuous_seq(tmp_path):
    assert [ledger.append(tmp_path, "control.jsonl", "app/started", "app", {}) for _ in range(3)] == [1, 2, 3]
    assert [r["seq"] for r in ledger.read(tmp_path, "control.jsonl")] == [1, 2, 3]
    assert [r["seq"] for r in ledger.read(tmp_path, "control.jsonl", since_seq=2)] == [3]


def test_gap_is_an_error_not_a_skip(tmp_path):
    for _ in range(3):
        ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    path = tmp_path / "control.jsonl"
    lines = path.read_text().splitlines(keepends=True)
    path.write_text(lines[0] + lines[2])  # drop seq 2
    with pytest.raises(ledger.LedgerCorrupt, match="seq 3, expected 2"):
        ledger.read(tmp_path, "control.jsonl")
    # and the next append refuses rather than writing seq 3 again
    with pytest.raises(ledger.LedgerCorrupt):
        ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})


def test_torn_line_and_bad_json_refused(tmp_path):
    ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    with open(tmp_path / "control.jsonl", "ab") as f:
        f.write(b'{"seq": 2')
    with pytest.raises(ledger.LedgerCorrupt, match="torn"):
        ledger.read(tmp_path, "control.jsonl")


def test_bad_names_and_authors_write_nothing(tmp_path):
    for bad in ("../x.jsonl", "/etc/passwd", "channels/G-zz.jsonl", "members/L-1.jsonl"):
        with pytest.raises(ledger.LedgerError):
            ledger.append(tmp_path, bad, "a/b", "app", {})
    with pytest.raises(ledger.LedgerError):
        ledger.append_many(tmp_path, [("control.jsonl", "app/started", "app", {}),
                                      ("control.jsonl", "app/started", "lead:mallory", {})])
    assert ledger.read(tmp_path, "control.jsonl") == []


def test_parallel_writers_never_collide(tmp_path):
    def worker():
        for _ in range(25):
            ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    ts = [threading.Thread(target=worker) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert [r["seq"] for r in ledger.read(tmp_path, "control.jsonl")] == list(range(1, 101))


def test_transaction_is_reentrant(tmp_path):
    with ledger.transaction(tmp_path):
        with ledger.transaction(tmp_path):
            ledger.append(tmp_path, "control.jsonl", "app/started", "app", {})
    assert ledger.tail_seq(tmp_path, "control.jsonl") == 1


def _group(root):
    a = identity.register(root, "chat-a", "alpha")
    b = identity.register(root, "chat-b", "beta")
    c = identity.register(root, "chat-c", "gamma")
    g = send.open_group(root, a, "room", [a, b, c])["channel_id"]
    return a, b, c, g


def test_fold_cache_rebuilds_to_the_same_state(tmp_path):
    a, b, c, g = _group(tmp_path)
    r = send.post(tmp_path, a, channel_id=g, text="root", now=1000)
    send.post(tmp_path, b, channel_id=g, text="in thread", thread="new", root_seq=r["seq"], now=1001)
    send.post(tmp_path, c, channel_id=g, text="please", mentions=[a], now=1002)
    fresh = fold.fold_channel(tmp_path, g, use_cache=False)
    cached = fold.fold_channel(tmp_path, g)  # writes the cache
    assert (tmp_path / "cache" / "channels" / f"{g}.json").exists()
    assert fold.fold_channel(tmp_path, g) == fresh == cached
    # delete the cache: same answer
    shutil.rmtree(tmp_path / "cache")
    assert fold.fold_channel(tmp_path, g) == fresh
    # a cache whose row digest no longer matches the file is ignored
    p = tmp_path / "cache" / "channels" / f"{g}.json"
    data = json.loads(p.read_text())
    data["state"]["title"] = "forged"
    data["digest"] = "0" * 64
    p.write_text(json.dumps(data))
    assert fold.fold_channel(tmp_path, g)["title"] == "room"
    # cache taken earlier, then more rows: replays only the tail and matches
    send.post(tmp_path, b, channel_id=g, text="later", now=1003)
    assert fold.fold_channel(tmp_path, g) == fold.fold_channel(tmp_path, g, use_cache=False)


def test_unread_and_ack_after_read(tmp_path):
    from teamapp import wake
    a, b, c, g = _group(tmp_path)
    send.post(tmp_path, a, channel_id=g, text="one", now=1000)
    send.post(tmp_path, b, channel_id=g, text="two", now=1001)
    assert [i["data"]["text"] for i in fold.unread(tmp_path, c)] == ["one", "two"]
    out = wake.inbox_read(tmp_path, c, limit=1)
    assert [i["body"].split(">", 1)[1].split("<")[0] for i in out["items"]] == ["one"]
    assert out["remaining"] == 1
    assert [i["data"]["text"] for i in fold.unread(tmp_path, c)] == ["two"]
    wake.inbox_read(tmp_path, c)
    assert fold.unread(tmp_path, c) == []
