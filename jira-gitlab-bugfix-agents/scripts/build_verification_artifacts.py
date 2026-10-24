#!/usr/bin/env python3
"""
build_verification_artifacts.py — render developer-verification artifacts from a compact manifest.

The fixer agent authors a small machine-only manifest (verification-manifest.json); this script
does all the human-facing rendering (no LLM tokens). It emits, into --out:

  verification-guide.md      human table grouped by scenario kind (with evidence + gaps columns)
  openapi.json               OpenAPI 3.1 contract (importable into Postman)
  postman_collection.json    Postman Collection v2.1 (variables, requests, tests/assertions, capture)
  postman_environment.json   Postman environment (the declared variables)
  stats.json                 counts per kind + gaps (for the MR description)

Stdlib only — no venv needed.

Manifest schema (see the fixer prompt Step 6.5 for the authoritative copy):
  {
    "issue": "DT-123",
    "variables": [{"name":"baseUrl","example":"https://...","secret":false}, ...],
    "scenarios": [{
      "id":"bugfix-1","kind":"bugfix|regression|feature_flag","title":"...",
      "preconditions":{"feature_flag":{"name":"X","state":"on"},"data":"..."},
      "request":{"method":"POST","path":"/x/{caseId}","headers":{...},"body":{...},"query":{...}},
      "assertions":[{"type":"status","expect":200},
                    {"type":"json_path","path":"$.a.b","matcher":"contains|equals|exists","value":...}],
      "capture":[{"from":"$.id","into":"caseId"}],
      "evidence":"follow-up.e2e-test.ts","confidence":"high|inferred","gaps":null
    }]
  }
"""

import argparse
import json
import os
import re
import sys

KIND_ORDER = ["bugfix", "regression", "feature_flag"]
KIND_LABEL = {"bugfix": "Bug-fix scenarios", "regression": "Regression points",
              "feature_flag": "Feature-flag flows"}


def _fail(msg):
    print(f"[build_verification_artifacts] ERROR: {msg}", file=sys.stderr)
    sys.exit(2)


def load_manifest(path):
    if not os.path.exists(path):
        _fail(f"manifest not found: {path}")
    with open(path) as fh:
        try:
            return json.load(fh)
        except json.JSONDecodeError as e:
            _fail(f"manifest is not valid JSON: {e}")


def _md_escape(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def _fmt_request(req):
    q = req.get("query")
    path = req.get("path", "")
    if q:
        path += "?" + "&".join(f"{k}={v}" for k, v in q.items())
    return f"`{req.get('method','GET')} {path}`"


def _fmt_assertions(assertions):
    out = []
    for a in assertions or []:
        t = a.get("type")
        if t == "status":
            out.append(f"status == {a.get('expect')}")
        elif t == "json_path":
            out.append(f"`{a.get('path')}` {a.get('matcher','equals')} {a.get('value')!r}")
        else:
            out.append(json.dumps(a))
    return "; ".join(out) if out else "—"


# ---------------------------------------------------------------------------
# verification-guide.md
# ---------------------------------------------------------------------------
def render_guide(m):
    lines = [f"# Verification guide — {m.get('issue','')}", ""]
    lines.append("Generated from `verification-manifest.json`. Every row cites its evidence "
                 "source; rows marked with a gap are not fully verifiable and need manual attention.")
    lines.append("")

    if m.get("variables"):
        lines.append("## Variables")
        lines.append("")
        lines.append("| Variable | Example | Secret |")
        lines.append("| --- | --- | --- |")
        for v in m["variables"]:
            lines.append(f"| `{v['name']}` | {_md_escape(v.get('example','—'))} | "
                         f"{'yes' if v.get('secret') else 'no'} |")
        lines.append("")

    scenarios = m.get("scenarios", [])
    for kind in KIND_ORDER:
        group = [s for s in scenarios if s.get("kind") == kind]
        if not group:
            continue
        lines.append(f"## {KIND_LABEL[kind]}")
        lines.append("")
        lines.append("| # | Scenario | Preconditions | Request | Assertions | Evidence | Gaps |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for i, s in enumerate(group, 1):
            pre = s.get("preconditions", {}) or {}
            flag = pre.get("feature_flag")
            pre_txt = []
            if flag:
                pre_txt.append(f"flag `{flag.get('name')}`={flag.get('state')}")
            if pre.get("data"):
                pre_txt.append(_md_escape(pre["data"]))
            gap = s.get("gaps")
            gap_txt = f"⚠️ {_md_escape(gap)}" if gap else "—"
            conf = s.get("confidence", "")
            ev = _md_escape(s.get("evidence", "—"))
            if conf:
                ev = f"{ev} ({conf})"
            lines.append(
                f"| {i} | {_md_escape(s.get('title',''))} | {'; '.join(pre_txt) or '—'} | "
                f"{_md_escape(_fmt_request(s.get('request',{})))} | "
                f"{_md_escape(_fmt_assertions(s.get('assertions')))} | {ev} | {gap_txt} |")
        lines.append("")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# openapi.json (3.1) — contract only (no assertions/chaining; those go to Postman)
# ---------------------------------------------------------------------------
def render_openapi(m):
    paths = {}
    for s in m.get("scenarios", []):
        req = s.get("request", {})
        raw = req.get("path", "/")
        method = req.get("method", "GET").lower()
        # OpenAPI path params use {name}; keep {caseId} style as-is.
        entry = paths.setdefault(raw, {})
        op = {
            "summary": s.get("title", s.get("id", "")),
            "operationId": s.get("id", ""),
            "responses": {"200": {"description": "OK"}},
        }
        # path params
        params = []
        for pname in re.findall(r"\{([^}]+)\}", raw):
            params.append({"name": pname, "in": "path", "required": True,
                           "schema": {"type": "string"}})
        if params:
            op["parameters"] = params
        body = req.get("body")
        if body is not None and method in ("post", "put", "patch"):
            op["requestBody"] = {
                "content": {"application/json": {"example": body}}
            }
        entry[method] = op
    base_example = next((v.get("example") for v in m.get("variables", [])
                         if v.get("name") == "baseUrl"), "https://your-env.example.com")
    return {
        "openapi": "3.1.0",
        "info": {"title": f"Verification — {m.get('issue','')}", "version": "1.0.0"},
        "servers": [{"url": "{baseUrl}", "variables": {"baseUrl": {"default": base_example}}}],
        "paths": paths,
    }


# ---------------------------------------------------------------------------
# Postman collection v2.1 (variables + requests + tests + capture)
# ---------------------------------------------------------------------------
def _postman_url(req):
    path = req.get("path", "/")
    segments = [seg for seg in path.strip("/").split("/") if seg != ""]
    url = {
        "raw": "{{baseUrl}}" + path,
        "host": ["{{baseUrl}}"],
        "path": segments,
    }
    if req.get("query"):
        url["query"] = [{"key": k, "value": str(v)} for k, v in req["query"].items()]
    return url


def _postman_tests(s):
    js = []
    for a in s.get("assertions", []) or []:
        t = a.get("type")
        if t == "status":
            js.append(f"pm.test('status {a.get('expect')}', function () {{ "
                      f"pm.response.to.have.status({int(a.get('expect', 200))}); }});")
        elif t == "json_path":
            path = a.get("path", "$")
            prop = path.lstrip("$").lstrip(".")
            accessor = "".join(f"[{json.dumps(p)}]" for p in prop.split(".") if p)
            matcher = a.get("matcher", "equals")
            val = json.dumps(a.get("value"))
            expr = f"pm.response.json(){accessor}"
            if matcher == "exists":
                js.append(f"pm.test({json.dumps('has '+path)}, function () {{ "
                          f"pm.expect({expr}).to.exist; }});")
            elif matcher == "contains":
                js.append(f"pm.test({json.dumps(path+' contains')}, function () {{ "
                          f"pm.expect(String({expr})).to.include({val}); }});")
            else:
                js.append(f"pm.test({json.dumps(path+' equals')}, function () {{ "
                          f"pm.expect({expr}).to.eql({val}); }});")
    for c in s.get("capture", []) or []:
        frm = c.get("from", "$").lstrip("$").lstrip(".")
        accessor = "".join(f"[{json.dumps(p)}]" for p in frm.split(".") if p)
        into = c.get("into")
        js.append(f"pm.collectionVariables.set({json.dumps(into)}, "
                  f"pm.response.json(){accessor});")
    return js


def render_postman_collection(m):
    items = []
    for s in m.get("scenarios", []):
        req = s.get("request", {})
        headers = [{"key": k, "value": v} for k, v in (req.get("headers") or {}).items()]
        request = {
            "method": req.get("method", "GET"),
            "header": headers,
            "url": _postman_url(req),
        }
        if req.get("body") is not None:
            request["body"] = {"mode": "raw",
                               "raw": json.dumps(req["body"], indent=2),
                               "options": {"raw": {"language": "json"}}}
        tests = _postman_tests(s)
        item = {
            "name": f"[{s.get('kind')}] {s.get('title', s.get('id',''))}",
            "request": request,
            "event": [],
        }
        if tests:
            item["event"].append({"listen": "test",
                                   "script": {"type": "text/javascript", "exec": tests}})
        items.append(item)
    variables = [{"key": v["name"], "value": str(v.get("example", ""))}
                 for v in m.get("variables", [])]
    return {
        "info": {
            "name": f"Verification — {m.get('issue','')}",
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "item": items,
        "variable": variables,
    }


def render_postman_environment(m):
    return {
        "name": f"Verification env — {m.get('issue','')}",
        "values": [{"key": v["name"], "value": str(v.get("example", "")),
                    "type": "secret" if v.get("secret") else "default", "enabled": True}
                   for v in m.get("variables", [])],
    }


def compute_stats(m):
    scenarios = m.get("scenarios", [])
    by_kind = {k: 0 for k in KIND_ORDER}
    gaps = 0
    for s in scenarios:
        by_kind[s.get("kind", "bugfix")] = by_kind.get(s.get("kind", "bugfix"), 0) + 1
        if s.get("gaps"):
            gaps += 1
    return {"issue": m.get("issue", ""), "total_scenarios": len(scenarios),
            "by_kind": by_kind, "gaps": gaps}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    m = load_manifest(args.manifest)
    if "scenarios" not in m or not isinstance(m["scenarios"], list):
        _fail("manifest must contain a 'scenarios' array")
    os.makedirs(args.out, exist_ok=True)

    def _w(name, content, as_json=False):
        p = os.path.join(args.out, name)
        with open(p, "w") as fh:
            if as_json:
                json.dump(content, fh, indent=2)
            else:
                fh.write(content)
        return p

    _w("verification-guide.md", render_guide(m))
    _w("openapi.json", render_openapi(m), as_json=True)
    _w("postman_collection.json", render_postman_collection(m), as_json=True)
    _w("postman_environment.json", render_postman_environment(m), as_json=True)
    stats = compute_stats(m)
    _w("stats.json", stats, as_json=True)

    print(f"[build_verification_artifacts] wrote 5 files to {args.out} — "
          f"{stats['total_scenarios']} scenarios, {stats['gaps']} gap(s): {stats['by_kind']}")


if __name__ == "__main__":
    main()
