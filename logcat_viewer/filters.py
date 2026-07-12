"""Filter specification and matching, logcat-style (level / tag / PID / regex text)."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .parser import LogEntry, PRIORITY


@dataclass
class FilterSpec:
    """User-facing filter settings. Call compile() once, then match() per entry."""

    min_priority: int = PRIORITY["V"]      # keep entries with priority >= this
    tag_query: str = ""
    tag_regex: bool = False
    pids: str = ""                         # comma/space separated PIDs; empty = any
    package: str = ""                      # selected app (label only)
    package_pids: "frozenset[int] | None" = None  # None = no app filter; else pid must be in set
    text_query: str = ""                   # include: tag+msg must match
    text_regex: bool = False
    exclude_query: str = ""                # exclude: hide if tag+msg matches
    exclude_regex: bool = False

    # populated by compile()
    _tag_re: "re.Pattern | None" = field(default=None, init=False, repr=False)
    _text_re: "re.Pattern | None" = field(default=None, init=False, repr=False)
    _exclude_re: "re.Pattern | None" = field(default=None, init=False, repr=False)
    # substring OR-terms (lowercased, split on "|"); empty list => field inactive
    _tag_terms: "list[str]" = field(default_factory=list, init=False, repr=False)
    _text_terms: "list[str]" = field(default_factory=list, init=False, repr=False)
    _exclude_terms: "list[str]" = field(default_factory=list, init=False, repr=False)
    _pid_set: "frozenset[int]" = field(default=frozenset(), init=False, repr=False)
    errors: "dict[str, str]" = field(default_factory=dict, init=False, repr=False)

    def compile(self) -> "FilterSpec":
        """Precompile regexes / parse PIDs. Invalid regex in a field disables that
        field (pass-through) and records an error message under its key."""
        self.errors = {}
        self._tag_re, self._tag_terms = self._compile_field(
            "tag", self.tag_query, self.tag_regex)
        self._text_re, self._text_terms = self._compile_field(
            "text", self.text_query, self.text_regex)
        self._exclude_re, self._exclude_terms = self._compile_field(
            "exclude", self.exclude_query, self.exclude_regex)

        pids = set()
        for tok in re.split(r"[\s,]+", self.pids.strip()):
            if tok.isdigit():
                pids.add(int(tok))
            elif tok:
                self.errors["pid"] = f"not a PID: {tok}"
        self._pid_set = frozenset(pids)
        return self

    def _compile_field(self, key: str, query: str, is_regex: bool):
        """Return (compiled_regex_or_None, substring_terms). In substring mode a
        query is split on "|" into OR-terms — `error|success` matches lines with
        either word; empty terms (e.g. a trailing `|`) are ignored."""
        if not query:
            return None, []
        if not is_regex:
            terms = [t for t in (p.strip().lower() for p in query.split("|")) if t]
            return None, terms
        try:
            return re.compile(query, re.IGNORECASE), []
        except re.error as exc:
            self.errors[key] = str(exc)
            return None, []  # invalid -> treat field as inactive so log keeps flowing

    def has_error(self, key: str) -> bool:
        return key in self.errors

    def match(self, e: LogEntry) -> bool:
        if e.priority < self.min_priority:
            return False

        if self.package_pids is not None and e.pid not in self.package_pids:
            return False

        if self._pid_set and e.pid not in self._pid_set:
            return False

        if self._tag_re is not None:
            if not self._tag_re.search(e.tag):
                return False
        elif self._tag_terms:  # substring OR: keep if the tag has ANY term
            tag = e.tag.lower()
            if not any(t in tag for t in self._tag_terms):
                return False

        if self._text_re is not None:
            if not self._text_re.search(e.raw):
                return False
        elif self._text_terms:  # substring OR: keep if a term is in tag+message
            if not any(t in e.search for t in self._text_terms):
                return False

        if self._exclude_re is not None:
            if self._exclude_re.search(e.raw):
                return False
        elif self._exclude_terms:  # substring OR: hide if ANY term is present
            if any(t in e.search for t in self._exclude_terms):
                return False

        return True
