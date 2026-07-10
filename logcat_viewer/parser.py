"""Parse `adb logcat -v threadtime` output lines into structured entries."""
from __future__ import annotations

import re

# Android log priorities (matches android.util.Log constants).
PRIORITY = {"V": 2, "D": 3, "I": 4, "W": 5, "E": 6, "F": 7, "S": 8}
LEVEL_NAMES = {2: "Verbose", 3: "Debug", 4: "Info", 5: "Warn", 6: "Error", 7: "Fatal", 8: "Silent"}

# Unparseable lines are treated as Verbose so the most permissive level still
# shows them, but any raised level threshold hides the noise.
UNKNOWN_PRIORITY = PRIORITY["V"]

# 07-09 14:23:01.123  1234  1250 D BActivityThread: message text
_THREADTIME = re.compile(
    r"^(?P<time>\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+"
    r"(?P<pid>\d+)\s+(?P<tid>\d+)\s+"
    r"(?P<level>[VDIWEFS])\s+"
    r"(?P<tag>.*?): ?(?P<msg>.*)$"
)


class LogEntry:
    """One parsed logcat line. Uses __slots__ because we hold hundreds of thousands."""

    __slots__ = ("time", "pid", "tid", "level", "priority", "tag", "msg", "raw", "search")

    def __init__(self, time, pid, tid, level, priority, tag, msg, raw):
        self.time = time
        self.pid = pid
        self.tid = tid
        self.level = level
        self.priority = priority
        self.tag = tag
        self.msg = msg
        self.raw = raw
        # Precomputed lowercase haystack for case-insensitive substring filtering.
        self.search = (tag + " " + msg).lower()


def parse_line(line: str) -> LogEntry | None:
    """Return a LogEntry, or None for lines that carry no log content (dividers/blank)."""
    if not line or line.startswith("--------- "):
        return None
    m = _THREADTIME.match(line)
    if m:
        level = m.group("level")
        return LogEntry(
            time=m.group("time"),
            pid=int(m.group("pid")),
            tid=int(m.group("tid")),
            level=level,
            priority=PRIORITY.get(level, UNKNOWN_PRIORITY),
            tag=m.group("tag").rstrip(),
            msg=m.group("msg"),
            raw=line,
        )
    # Non-threadtime line (rare malformed output): keep it, don't lose data.
    return LogEntry(
        time="",
        pid=0,
        tid=0,
        level="?",
        priority=UNKNOWN_PRIORITY,
        tag="",
        msg=line,
        raw=line,
    )
