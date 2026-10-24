#!/usr/bin/env python3
"""
task_pipeline_lib.py — deterministic parsing/selection helpers for the task-implementer spine.

Pure functions, no LLM, no network. This is the "clerical" work the spine does at 0 credits so
the single Opus node only spends tokens on the judgment step (writing the code). It owns:

  * loading + validating the per-run YAML config (run.yml)
  * parsing a Kiro spec's tasks.md into an ordered task list
  * selecting which tasks to implement (all | range | list) under the optional/done rules
  * mapping a friendly model name (opus/sonnet/...) to the exact kiro-cli model id
  * reading the IMPL-EXEC hand-off block the implement node emits

Only optional dependency is PyYAML (used for the config + tasks fallback). The IMPL-EXEC block is
flat key:value and parses with the regex fallback if PyYAML is absent, but the run config needs
YAML — the loader raises a clear error if PyYAML is missing.

Run `python3 task_pipeline_lib.py` for a self-test against a built-in sample tasks.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

try:
    import yaml  # PyYAML
except ImportError:  # pragma: no cover
    yaml = None


class ConfigError(ValueError):
    """Raised for an invalid/incomplete run config — the spine treats this as a hard-gate STOP."""


# --------------------------------------------------------------------------------------
# YAML loading — prefer PyYAML, fall back to a small stdlib parser (keeps the "no venv" promise)
# --------------------------------------------------------------------------------------

def _yaml_load(text: str) -> Any:
    """Parse YAML with PyYAML when present, else a minimal indentation parser.

    The fallback supports exactly the subset these configs use: comments, nested block mappings,
    block sequences (`- item`), inline flow lists (`[a, b]`) and maps (`{k: v}`), quoted/bare
    scalars, booleans, ints, floats, and null. It intentionally mirrors PyYAML for these — notably
    an unquoted `15.4` becomes a float (which the task-id coercion then rejects with a hint).
    """
    if yaml is not None:
        return yaml.safe_load(text)
    return _stdlib_yaml_load(text)


def _strip_inline_comment(line: str) -> str:
    in_s = in_d = False
    for i, ch in enumerate(line):
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        elif ch == "#" and not in_s and not in_d and (i == 0 or line[i - 1] in " \t"):
            return line[:i]
    return line


def _flow_depth_delta(s: str) -> int:
    """Net flow-collection bracket balance of a (comment-stripped) fragment, ignoring quotes."""
    depth = 0
    in_s = in_d = False
    for ch in s:
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        elif not in_s and not in_d:
            if ch in "[{":
                depth += 1
            elif ch in "]}":
                depth -= 1
    return depth


def _tokenize_yaml(text: str) -> list[tuple[int, str]]:
    """Logical-line tokenizer: (indent, content), comments stripped, blank lines dropped.

    Physical lines inside an unclosed flow collection (`[ ... ]` / `{ ... }` spanning multiple
    lines, as produced by editors/prettier wrapping long lists) are JOINED into one logical line
    so the flow-scalar parser sees the whole `[a, b, c]`. Without this, a `paths: [` line would be
    read as the scalar `"["` and the continuation lines would desync the whole document.
    """
    out: list[tuple[int, str]] = []
    buf = ""
    buf_indent = 0
    depth = 0
    for raw in text.splitlines():
        line = _strip_inline_comment(raw.replace("\t", "    "))
        stripped = line.strip()
        if depth == 0:
            if not stripped:
                continue
            buf_indent = len(line) - len(line.lstrip(" "))
            buf = stripped
        elif stripped:
            buf += " " + stripped
        depth += _flow_depth_delta(stripped)
        if depth <= 0:
            depth = 0
            if buf.strip():
                out.append((buf_indent, buf.strip()))
            buf = ""
    if buf.strip():                     # unterminated flow collection — emit what we have
        out.append((buf_indent, buf.strip()))
    return out


def _split_flow(s: str) -> list[str]:
    parts, buf, depth, in_s, in_d = [], "", 0, False, False
    for ch in s:
        if ch == "'" and not in_d:
            in_s = not in_s
        elif ch == '"' and not in_s:
            in_d = not in_d
        if not in_s and not in_d:
            if ch in "[{":
                depth += 1
            elif ch in "]}":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append(buf.strip())
                buf = ""
                continue
        buf += ch
    if buf.strip():
        parts.append(buf.strip())
    return parts


def _unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and ((s[0] == s[-1] == '"') or (s[0] == s[-1] == "'")):
        return s[1:-1]
    return s


def _yaml_scalar(s: str) -> Any:
    s = s.strip()
    if not s:
        return None
    if (s[0] == s[-1] == '"' and len(s) >= 2) or (s[0] == s[-1] == "'" and len(s) >= 2):
        return s[1:-1]
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [_yaml_scalar(x) for x in _split_flow(inner)] if inner else []
    if s.startswith("{") and s.endswith("}"):
        inner = s[1:-1].strip()
        out: dict[str, Any] = {}
        for part in (_split_flow(inner) if inner else []):
            k, _, v = part.partition(":")
            out[_unquote(k)] = _yaml_scalar(v.strip())
        return out
    low = s.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "none", "~"):
        return None
    if re.fullmatch(r"-?\d+", s):
        return int(s)
    if re.fullmatch(r"-?\d+\.\d+", s):
        return float(s)
    return s


def _stdlib_yaml_load(text: str) -> Any:
    lines = _tokenize_yaml(text)
    value, _ = _parse_yaml_block(lines, 0, lines[0][0] if lines else 0)
    return value


def _parse_yaml_block(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[Any, int]:
    if i >= len(lines):
        return None, i
    if lines[i][1].startswith("- "):
        return _parse_yaml_seq(lines, i, indent)
    return _parse_yaml_map(lines, i, indent)


def _parse_yaml_map(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[dict, int]:
    d: dict[str, Any] = {}
    while i < len(lines):
        cur_indent, content = lines[i]
        if cur_indent != indent or content.startswith("- "):
            break
        key, sep, rest = content.partition(":")
        if not sep:
            i += 1
            continue
        key = _unquote(key)
        rest = rest.strip()
        if rest == "":
            j = i + 1
            if j < len(lines) and lines[j][0] > indent:
                child = lines[j][1]
                if child.startswith("- ") or _MAP_ENTRY_RE.match(child):
                    # nested block sequence or mapping
                    d[key], i = _parse_yaml_block(lines, j, lines[j][0])
                else:
                    # scalar value wrapped onto the next line(s) (e.g. `key:\n  "value"`).
                    child_indent = lines[j][0]
                    parts, k = [], j
                    while (k < len(lines) and lines[k][0] >= child_indent
                           and not lines[k][1].startswith("- ")
                           and not _MAP_ENTRY_RE.match(lines[k][1])):
                        parts.append(lines[k][1])
                        k += 1
                    d[key] = _yaml_scalar(" ".join(parts)) if parts else None
                    i = k
            else:
                d[key] = None
                i += 1
        else:
            d[key] = _yaml_scalar(rest)
            i += 1
    return d, i


_MAP_ENTRY_RE = re.compile(r"^[\w.\-]+:(\s|$)")


def _parse_yaml_seq(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[list, int]:
    arr: list[Any] = []
    while i < len(lines):
        cur_indent, content = lines[i]
        if cur_indent != indent or not content.startswith("- "):
            break
        first = content[2:].strip()
        item_indent = indent + 2   # column of the item's content (after "- ")
        if first == "":
            # "-" then a nested block on the following, more-indented lines
            j = i + 1
            if j < len(lines) and lines[j][0] > indent:
                val, i = _parse_yaml_block(lines, j, lines[j][0])
                arr.append(val)
            else:
                arr.append(None)
                i += 1
        elif _MAP_ENTRY_RE.match(first):
            # compact block mapping as a sequence item: "- key: val" + deeper-indented keys.
            # Rewrite this line as the map's first entry, then parse the map at item_indent.
            lines[i] = (item_indent, first)
            val, i = _parse_yaml_map(lines, i, item_indent)
            arr.append(val)
        else:
            arr.append(_yaml_scalar(first))
            i += 1
    return arr, i


# --------------------------------------------------------------------------------------
# Model mapper (friendly alias -> exact kiro-cli model id; see `kiro-cli chat --list-models`)
# --------------------------------------------------------------------------------------

# Friendly aliases the config accepts. Add new rows here as models are released — the config
# stays stable (`model: opus`) while the exact id it maps to can evolve.
MODEL_ALIASES: dict[str, str] = {
    "opus": "claude-opus-4.8",
    "sonnet": "claude-sonnet-4.6",
    "haiku": "claude-haiku-4.5",
    "auto": "auto",
}

# Exact ids we recognize today (for case-insensitive pass-through). Unknown ids still pass through
# verbatim so a brand-new model id works without a code change.
KNOWN_EXACT_MODELS: set[str] = {
    "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-opus-4.5",
    "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4",
    "claude-haiku-4.5", "auto",
}

DEFAULT_MODEL_ALIAS = "opus"


def resolve_model(name: str | None) -> str:
    """Map a config `model` value to the exact kiro-cli model id passed to `--model`.

    - Known alias (opus/sonnet/haiku/auto) -> its exact id.
    - Known exact id (any case) -> canonical exact id.
    - Anything else -> returned verbatim (future model id pass-through).
    - Empty/None -> the default alias (opus).
    """
    if not name:
        name = DEFAULT_MODEL_ALIAS
    key = str(name).strip().lower()
    if key in MODEL_ALIASES:
        return MODEL_ALIASES[key]
    for exact in KNOWN_EXACT_MODELS:
        if key == exact.lower():
            return exact
    return str(name).strip()


# --------------------------------------------------------------------------------------
# Run config (the per-run YAML)
# --------------------------------------------------------------------------------------

@dataclass
class SpecLocation:
    """Where the Kiro spec (the folder containing tasks.md) lives."""
    location: str = "repo"       # "repo" (default) | "local"
    path: str = ""               # repo-relative path (repo) or absolute path (local) to spec dir
    branch: str = ""             # for location=repo; "" => read from source_branch


@dataclass
class TaskSelection:
    """Which tasks to implement. Exactly one of: all (default) | range | list."""
    include_optional: bool = False
    range_from: Optional[str] = None
    range_to: Optional[str] = None
    explicit_list: list[str] = field(default_factory=list)

    @property
    def mode(self) -> str:
        # Precedence (documented in README): list > range > all.
        if self.explicit_list:
            return "list"
        if self.range_from and self.range_to:
            return "range"
        return "all"


@dataclass
class ReferenceRepo:
    """A read-only GitLab repo cloned for grounding context (never edited)."""
    url: str
    branch: str = ""                    # "" => the repo's default branch
    paths: list[str] = field(default_factory=list)     # optional sub-paths to scope to
    keywords: list[str] = field(default_factory=list)  # optional per-repo grounding keywords


@dataclass
class ReferenceLocal:
    """A read-only local file or directory used for grounding context."""
    path: str
    paths: list[str] = field(default_factory=list)     # optional sub-paths if `path` is a dir
    keywords: list[str] = field(default_factory=list)  # optional per-source grounding keywords


@dataclass
class ReferencesSpec:
    """All grounding references for a run. Optional — empty means no references."""
    keywords: list[str] = field(default_factory=list)  # global keywords, applied to every source
    repos: list[ReferenceRepo] = field(default_factory=list)
    local: list[ReferenceLocal] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.repos and not self.local


@dataclass
class JiraGatherSpec:
    """Controls the deterministic Jira/Confluence history gather (see jira_gather.py)."""
    enabled: bool = True
    max_depth: int = 3
    max_tickets: int = 40
    project_prefixes: list[str] = field(default_factory=list)   # e.g. ["DT", "VP"]
    confluence: bool = True             # also fetch linked Confluence page content
    max_confluence: int = 20            # cap on Confluence pages fetched


@dataclass
class RunConfig:
    jira_id: str
    repo_url: str
    source_branch: str
    branch_name: str = "auto"           # "auto" => <jira_id>-<kebab-slug-of-summary>
    target_branch: str = ""             # "" => same as source_branch
    spec: SpecLocation = field(default_factory=SpecLocation)
    tasks: TaskSelection = field(default_factory=TaskSelection)
    references: ReferencesSpec = field(default_factory=ReferencesSpec)
    jira: JiraGatherSpec = field(default_factory=JiraGatherSpec)
    unit_tests: bool = True             # false => skip test-only tasks + coverage gate
    create_mr: bool = False             # true => push + open MR; false => push only
    testing_artifacts: bool = False     # true => emit verification manifest + render pack
    model: str = DEFAULT_MODEL_ALIAS
    reviewers: list[str] = field(default_factory=list)
    test_command: str = ""              # optional explicit test command (else repo default)

    def effective_target_branch(self) -> str:
        return self.target_branch or self.source_branch

    def resolved_model(self) -> str:
        return resolve_model(self.model)


REQUIRED_FIELDS = ("jira_id", "repo_url", "source_branch")


def _as_bool(v: Any, default: bool) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("true", "yes", "y", "1"):
        return True
    if s in ("false", "no", "n", "0"):
        return False
    raise ConfigError(f"expected a boolean, got {v!r}")


def _coerce_task_id(v: Any) -> str:
    """Coerce a YAML task-id value to a string, rejecting the float-corruption footgun.

    In YAML `15.4` parses as a float and `15.10` becomes 15.1 (data loss). We accept ints
    (safe: str(15) == '15') and strings, but reject floats with a message telling the user to
    quote task ids.
    """
    if isinstance(v, bool):
        raise ConfigError(f"invalid task id: {v!r}")
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, float):
        raise ConfigError(
            f"task id {v!r} was parsed as a number and may be corrupted "
            f"(e.g. 15.10 -> 15.1). Quote task ids in the YAML, e.g. \"{v}\"."
        )
    raise ConfigError(f"invalid task id: {v!r}")


def _parse_range(raw: Any) -> tuple[Optional[str], Optional[str]]:
    """Accept range as {from, to} (preferred) or a "from-to" string."""
    if raw is None:
        return None, None
    if isinstance(raw, dict):
        rf = raw.get("from")
        rt = raw.get("to")
        return (_coerce_task_id(rf) if rf is not None else None,
                _coerce_task_id(rt) if rt is not None else None)
    if isinstance(raw, str):
        parts = raw.split("-")
        if len(parts) != 2:
            raise ConfigError(f"range string must look like 'FROM-TO', got {raw!r}")
        return parts[0].strip(), parts[1].strip()
    raise ConfigError(f"tasks.range must be a mapping or a 'FROM-TO' string, got {raw!r}")


def _as_str_list(v: Any, field_name: str) -> list[str]:
    """Coerce a scalar-or-list YAML value into a list of non-empty strings."""
    if v is None:
        return []
    if isinstance(v, (str, int, float, bool)):
        v = [v]
    if not isinstance(v, list):
        raise ConfigError(f"{field_name} must be a string or a list of strings, got {v!r}")
    return [str(x).strip() for x in v if str(x).strip()]


def _parse_references(raw: Any) -> ReferencesSpec:
    if raw is None:
        return ReferencesSpec()
    if not isinstance(raw, dict):
        raise ConfigError("`references` must be a mapping")
    global_keywords = _as_str_list(raw.get("keywords"), "references.keywords")

    repos: list[ReferenceRepo] = []
    for i, r in enumerate(raw.get("repos") or []):
        if not isinstance(r, dict) or not r.get("url"):
            raise ConfigError(f"references.repos[{i}] must be a mapping with a 'url'")
        repos.append(ReferenceRepo(
            url=str(r["url"]).strip(),
            branch=str(r.get("branch", "") or "").strip(),
            paths=_as_str_list(r.get("paths"), f"references.repos[{i}].paths"),
            keywords=_as_str_list(r.get("keywords"), f"references.repos[{i}].keywords"),
        ))

    local: list[ReferenceLocal] = []
    for i, l in enumerate(raw.get("local") or []):
        if isinstance(l, str):
            l = {"path": l}
        if not isinstance(l, dict) or not l.get("path"):
            raise ConfigError(f"references.local[{i}] must be a path string or a mapping with 'path'")
        local.append(ReferenceLocal(
            path=str(l["path"]).strip(),
            paths=_as_str_list(l.get("paths"), f"references.local[{i}].paths"),
            keywords=_as_str_list(l.get("keywords"), f"references.local[{i}].keywords"),
        ))

    return ReferencesSpec(keywords=global_keywords, repos=repos, local=local)


def _parse_jira(raw: Any) -> JiraGatherSpec:
    if raw is None:
        return JiraGatherSpec()
    if not isinstance(raw, dict):
        raise ConfigError("`jira` must be a mapping")

    def _as_int(v: Any, default: int, name: str) -> int:
        if v is None:
            return default
        try:
            return int(v)
        except (TypeError, ValueError):
            raise ConfigError(f"jira.{name} must be an integer, got {v!r}")

    return JiraGatherSpec(
        enabled=_as_bool(raw.get("gather"), True),
        max_depth=_as_int(raw.get("max_depth"), 3, "max_depth"),
        max_tickets=_as_int(raw.get("max_tickets"), 40, "max_tickets"),
        project_prefixes=[p.upper() for p in
                          _as_str_list(raw.get("project_prefixes"), "jira.project_prefixes")],
        confluence=_as_bool(raw.get("confluence"), True),
        max_confluence=_as_int(raw.get("max_confluence"), 20, "max_confluence"),
    )


def load_run_config(path: str | Path, overrides: Optional[dict[str, Any]] = None) -> RunConfig:
    """Load + validate the per-run YAML config into a RunConfig. Raises ConfigError on problems."""
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"run config not found: {p}")
    try:
        data = _yaml_load(p.read_text()) or {}
    except Exception as e:  # malformed YAML
        raise ConfigError(f"could not parse run config {p}: {e}") from e
    if not isinstance(data, dict):
        raise ConfigError("run config must be a YAML mapping")
    if overrides:
        # Shallow CLI overrides of top-level scalar fields (e.g. jira_id, branch_name, model).
        data = {**data, **{k: v for k, v in overrides.items() if v is not None}}

    missing = [f for f in REQUIRED_FIELDS if not data.get(f)]
    if missing:
        raise ConfigError(f"missing required config field(s): {', '.join(missing)}")

    spec_raw = data.get("spec") or {}
    if not isinstance(spec_raw, dict):
        raise ConfigError("`spec` must be a mapping")
    location = str(spec_raw.get("location", "repo")).strip().lower()
    if location not in ("repo", "local"):
        raise ConfigError(f"spec.location must be 'repo' or 'local', got {location!r}")
    if not spec_raw.get("path"):
        raise ConfigError("spec.path is required (folder containing tasks.md)")
    spec = SpecLocation(
        location=location,
        path=str(spec_raw["path"]).strip(),
        branch=str(spec_raw.get("branch", "") or "").strip(),
    )

    tasks_raw = data.get("tasks") or {}
    if not isinstance(tasks_raw, dict):
        raise ConfigError("`tasks` must be a mapping")
    range_from, range_to = _parse_range(tasks_raw.get("range"))
    explicit_list_raw = tasks_raw.get("list") or []
    if explicit_list_raw and not isinstance(explicit_list_raw, list):
        raise ConfigError("tasks.list must be a list of task ids")
    explicit_list = [_coerce_task_id(v) for v in explicit_list_raw]
    if explicit_list and (range_from or range_to):
        # Not fatal — precedence handles it — but surface the ambiguity loudly.
        pass
    tasks = TaskSelection(
        include_optional=_as_bool(tasks_raw.get("optional"), False),
        range_from=range_from,
        range_to=range_to,
        explicit_list=explicit_list,
    )

    reviewers_raw = data.get("reviewers") or []
    if isinstance(reviewers_raw, str):
        reviewers_raw = [reviewers_raw]

    return RunConfig(
        jira_id=str(data["jira_id"]).strip(),
        repo_url=str(data["repo_url"]).strip(),
        source_branch=str(data["source_branch"]).strip(),
        branch_name=str(data.get("branch_name", "auto") or "auto").strip(),
        target_branch=str(data.get("target_branch", "") or "").strip(),
        spec=spec,
        tasks=tasks,
        references=_parse_references(data.get("references")),
        jira=_parse_jira(data.get("jira")),
        unit_tests=_as_bool(data.get("unit_tests"), True),
        create_mr=_as_bool(data.get("create_mr"), False),
        testing_artifacts=_as_bool(data.get("testing_artifacts"), False),
        model=str(data.get("model", DEFAULT_MODEL_ALIAS) or DEFAULT_MODEL_ALIAS).strip(),
        reviewers=[str(r).strip() for r in reviewers_raw if str(r).strip()],
        test_command=str(data.get("test_command", "") or "").strip(),
    )


# --------------------------------------------------------------------------------------
# tasks.md parsing
# --------------------------------------------------------------------------------------

@dataclass
class Task:
    id: str                 # "15", "15.4", "15.4.1"
    title: str
    optional: bool          # marked with `[ ]*` / `[ ]\*`
    done: bool              # `[x]` / `[X]`
    order: int              # document order (0-based)
    indent: int             # leading whitespace width (informational)
    line_no: int            # 1-based line number of the checkbox

    def as_dict(self) -> dict[str, Any]:
        return {"id": self.id, "title": self.title, "optional": self.optional,
                "done": self.done, "order": self.order, "line_no": self.line_no}


# Matches a Kiro tasks.md checkbox line, e.g.:
#   - [ ] 15.4 Implement InsufficiencyFulfillmentClient
#   - [ ]* 15.5 (Optional) Property test ...
#   - [ ]\* 15.5 ...            (escaped asterisk, as markdown renders it literally)
#   - [x] 3.2 Wire the accessor
#   1. Set up project        (also tolerated: numbered list w/o checkbox is NOT a task)
_TASK_LINE_RE = re.compile(
    r"^(?P<indent>\s*)-\s*\[(?P<status>[ xX\-~])\]\s*"      # "- [ ]" / "- [x]" / "- [-]"
    r"(?P<opt>\\?\*)?\s*"                                     # optional marker: * or \*
    r"(?P<id>\d+(?:\.\d+)*)\.?\s+"                            # task id: 15 / 15.4 (opt trailing dot)
    r"(?P<title>.*)$"
)


def parse_tasks(md_text: str) -> list[Task]:
    """Parse tasks.md into an ordered list of Task (document order preserved)."""
    tasks: list[Task] = []
    order = 0
    for i, line in enumerate(md_text.splitlines(), 1):
        m = _TASK_LINE_RE.match(line)
        if not m:
            continue
        status = m.group("status")
        tasks.append(Task(
            id=m.group("id"),
            title=m.group("title").strip(),
            optional=bool(m.group("opt")),
            done=status in ("x", "X"),
            order=order,
            indent=len(m.group("indent")),
            line_no=i,
        ))
        order += 1
    return tasks


def parse_tasks_file(tasks_path: str | Path) -> list[Task]:
    p = Path(tasks_path)
    if not p.exists():
        raise ConfigError(f"tasks.md not found at {p}")
    return parse_tasks(p.read_text())


_TEST_TASK_HINT = re.compile(r"\b(unit test|property test|test coverage|write.*tests?)\b", re.I)


def looks_like_test_task(task: Task) -> bool:
    """Heuristic: is this task purely about writing tests? Used only for annotation/warnings.

    The final decision to skip a test-only task under `unit_tests: false` is the agent's — it
    reads the full task body. This is a hint, never a hard filter.
    """
    return bool(_TEST_TASK_HINT.search(task.title))


# --------------------------------------------------------------------------------------
# Task selection (all | range | list)
# --------------------------------------------------------------------------------------

@dataclass
class TaskSelectionResult:
    selected: list[Task]                        # in execution order
    skipped_done: list[str] = field(default_factory=list)
    skipped_optional: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)   # non-empty => hard-gate STOP
    mode: str = "all"

    @property
    def ok(self) -> bool:
        return not self.errors and bool(self.selected)


def _descendants(task_id: str, all_tasks: list[Task]) -> list[Task]:
    """Tasks whose id is a child of task_id (e.g. 15 -> 15.1, 15.4, 15.4.1)."""
    prefix = task_id + "."
    return [t for t in all_tasks if t.id.startswith(prefix)]


def select_tasks(all_tasks: list[Task], sel: TaskSelection) -> TaskSelectionResult:
    """Resolve a TaskSelection against the parsed task list.

    Rules (documented in README):
      * `list`  — exactly the named ids, in the given order; selecting a parent auto-includes its
                  descendants (document order). Optional tasks are NOT filtered (explicit choice).
                  `[x]` done tasks are skipped (recorded). Unknown ids => error (STOP).
      * `range` — the document-order inclusive slice [from..to]. Optional tasks are NOT filtered
                  (the boundaries are an explicit choice). `[x]` done tasks are skipped. A missing
                  boundary or from-after-to => error (STOP).
      * `all`   — every task in document order; optional (`[ ]*`) tasks are included only when
                  `include_optional` is true. `[x]` done tasks are skipped.
    """
    by_id = {t.id: t for t in all_tasks}
    res = TaskSelectionResult(selected=[], mode=sel.mode)

    if sel.mode == "list":
        seen: set[str] = set()
        for tid in sel.explicit_list:
            if tid not in by_id:
                res.errors.append(f"task id not found in tasks.md: {tid}")
                continue
            group = [by_id[tid]] + _descendants(tid, all_tasks)
            group.sort(key=lambda t: t.order)
            for t in group:
                if t.id in seen:
                    continue
                seen.add(t.id)
                if t.done:
                    res.skipped_done.append(t.id)
                    continue
                res.selected.append(t)

    elif sel.mode == "range":
        if sel.range_from not in by_id:
            res.errors.append(f"range.from id not found in tasks.md: {sel.range_from}")
        if sel.range_to not in by_id:
            res.errors.append(f"range.to id not found in tasks.md: {sel.range_to}")
        if not res.errors:
            o1, o2 = by_id[sel.range_from].order, by_id[sel.range_to].order
            if o1 > o2:
                res.errors.append(
                    f"range.from ({sel.range_from}) comes after range.to ({sel.range_to}) "
                    f"in tasks.md")
            else:
                for t in all_tasks:
                    if o1 <= t.order <= o2:
                        if t.done:
                            res.skipped_done.append(t.id)
                            continue
                        res.selected.append(t)

    else:  # all
        for t in all_tasks:
            if t.done:
                res.skipped_done.append(t.id)
                continue
            if t.optional and not sel.include_optional:
                res.skipped_optional.append(t.id)
                continue
            res.selected.append(t)

    return res


# --------------------------------------------------------------------------------------
# Branch-name derivation + workspace slug
# --------------------------------------------------------------------------------------

def derive_branch_name(jira_id: str, summary: str = "") -> str:
    """`branch_name: auto` -> <JIRA-ID>-<kebab-slug-of-summary> (deterministic; avoids typos)."""
    slug = re.sub(r"[^a-z0-9]+", "-", (summary or "").lower()).strip("-")
    slug = re.sub(r"-{2,}", "-", slug)[:50].strip("-")
    return f"{jira_id}-{slug}" if slug else jira_id


def slugify_branch(branch: str) -> str:
    """Filesystem-safe slug for a branch name (branches may contain '/', e.g. feature/DT-1)."""
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", branch).strip("-")
    return s or "work"


# --------------------------------------------------------------------------------------
# Repo URL helpers (shared by the spine + reference_gather; never echo the token)
# --------------------------------------------------------------------------------------

def repo_name_from_url(url: str) -> str:
    """Last path segment of a repo URL, minus `.git` (e.g. .../group/repo.git -> repo)."""
    u = re.sub(r"\.git$", "", url.strip())
    if u.startswith("git@") and ":" in u:
        seg = u.split(":", 1)[1]
    else:
        seg = re.sub(r"^[a-zA-Z]+://[^/]+/", "", u)
    name = seg.rstrip("/").split("/")[-1]
    return name or "repo"


def token_clone_url(url: str, token: str) -> str:
    """Normalize a repo URL to an https clone URL carrying the PAT (so `origin` can push).

    Accepts https (with/without userinfo) and git@host:group/repo(.git) SSH forms.
    Raises ValueError if the URL can't be parsed (callers decide how to surface it).
    """
    u = url.strip()
    m = re.match(r"^git@([^:]+):(.+?)(?:\.git)?$", u)
    if m:
        return f"https://oauth2:{token}@{m.group(1)}/{m.group(2)}.git"
    m = re.match(r"^https?://(?:[^@/]+@)?([^/]+)/(.+?)(?:\.git)?$", u)
    if m:
        return f"https://oauth2:{token}@{m.group(1)}/{m.group(2)}.git"
    raise ValueError(f"could not parse repo url {url!r} — expected https://host/group/repo "
                     f"or git@host:group/repo")


# --------------------------------------------------------------------------------------
# Delimited EXEC-block parsing (IMPL-EXEC hand-off the implement node emits)
# --------------------------------------------------------------------------------------

def extract_exec_block(text: str, name: str) -> str | None:
    """Return the raw body between `# --- <NAME> ---` and `# --- END <NAME> ---`, or None."""
    start = re.escape(f"# --- {name} ---")
    end = re.escape(f"# --- END {name} ---")
    m = re.search(rf"{start}\s*\n(.*?)\n\s*{end}", text, re.DOTALL)
    return m.group(1) if m else None


def parse_exec_block(text: str, name: str) -> dict[str, Any]:
    """Extract a delimited EXEC block and parse it as YAML (flat key:value fallback)."""
    body = extract_exec_block(text, name)
    if body is None:
        raise ValueError(f"{name} block not found")
    try:
        data = _yaml_load(body)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return _parse_flat_kv(body)


def _parse_flat_kv(body: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in body.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        out[key.strip()] = _coerce_scalar(val.strip())
    return out


def _coerce_scalar(v: str) -> Any:
    low = v.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("none", "null", ""):
        return None
    if v.isdigit():
        return int(v)
    return v.strip('"').strip("'")


def read_impl_status(impl_path: str | Path) -> dict[str, Any]:
    """Read IMPL-EXEC from the implement node's implementation.md. Missing => 'absent'."""
    p = Path(impl_path)
    if not p.exists():
        return {"status": "absent"}
    try:
        return parse_exec_block(p.read_text(), "IMPL-EXEC")
    except ValueError:
        return {"status": "absent"}


# --------------------------------------------------------------------------------------
# Self-test (`python3 task_pipeline_lib.py`)
# --------------------------------------------------------------------------------------

_SAMPLE_TASKS = """\
# Implementation Plan

- [x] 1. Scaffold the module
    - _Requirements: 1.1_

- [ ] 15. Insufficiency fulfillment
    - [ ] 15.4 Implement `InsufficiencyFulfillmentClient` — POST /insufficiencyFulfillment
        - _Requirements: 6.2, 6.5_
    - [ ]* 15.5 (Optional) Property test — create-case payload carries applicant + moheId
        - _Validates: Requirements 1.1_
    - [ ]\\* 15.6 (Optional) Property test — idempotent push
        - _Validates: Requirements 6.5_

- [ ] 16. Wire the controller route
    - _Requirements: 7.1_
"""


def _selftest() -> None:
    print("== model mapper ==")
    for n in ("opus", "sonnet", "haiku", "auto", "claude-opus-4.8", "future-model-9", None):
        print(f"  {n!r:24} -> {resolve_model(n)}")

    print("\n== tasks parse ==")
    tasks = parse_tasks(_SAMPLE_TASKS)
    for t in tasks:
        flags = "".join(["x" if t.done else ".", "*" if t.optional else "-"])
        print(f"  [{flags}] {t.id:8} (line {t.line_no}) {t.title[:48]}")

    print("\n== select: all (optional off) ==")
    r = select_tasks(tasks, TaskSelection(include_optional=False))
    print("  selected:", [t.id for t in r.selected],
          "| skipped_done:", r.skipped_done, "| skipped_optional:", r.skipped_optional)

    print("== select: all (optional on) ==")
    r = select_tasks(tasks, TaskSelection(include_optional=True))
    print("  selected:", [t.id for t in r.selected])

    print("== select: range 15.4..16 ==")
    r = select_tasks(tasks, TaskSelection(range_from="15.4", range_to="16"))
    print("  selected:", [t.id for t in r.selected], "| errors:", r.errors)

    print("== select: list [15] (parent expands to descendants) ==")
    r = select_tasks(tasks, TaskSelection(explicit_list=["15"]))
    print("  selected:", [t.id for t in r.selected])

    print("== select: list [15.6, 15.4] (explicit order, optional included) ==")
    r = select_tasks(tasks, TaskSelection(explicit_list=["15.6", "15.4"]))
    print("  selected:", [t.id for t in r.selected])

    print("== select: list [99.9] (unknown => error) ==")
    r = select_tasks(tasks, TaskSelection(explicit_list=["99.9"]))
    print("  selected:", [t.id for t in r.selected], "| errors:", r.errors)

    print("\n== branch derivation ==")
    print("  ", derive_branch_name("DT-46443", "Preserve remark on autoclose"))
    print("  ", slugify_branch("feature/DT-46443-thing"))

    print("\n== IMPL-EXEC read ==")
    impl = ("# --- IMPL-EXEC ---\nschema_version: 1\nstatus: implemented\n"
            "tests_passed: true\n# --- END IMPL-EXEC ---")
    print("  ", parse_exec_block(impl, "IMPL-EXEC"))


if __name__ == "__main__":
    _selftest()
