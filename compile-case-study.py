"""Compile frozen research, retrieved source status, and adjudication into HTML and JSON."""
import argparse
from collections import Counter, defaultdict
from html import escape
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
P = argparse.ArgumentParser(description=__doc__)
P.add_argument("--output", default="index.html", type=Path)
args = P.parse_args()


def data(name):
    return json.loads((DATA / name).read_text())


def links(urls):
    return " ".join(f'<a href="{escape(url, quote=True)}" target="_blank" rel="noopener">[{i}]</a>'
                    for i, url in enumerate(urls, 1) if url.startswith("https://"))


def baseline():
    # The frozen input already reflects prior AI desk research. Preserve the original values for audit.
    for line in (DATA / "first-pass.md").read_text().splitlines():
        if not re.match(r"^\| \d+ \|", line):
            continue
        id_, app, auth, test, live, api, mcp, verdict, evidence = line.strip()[1:-1].split(" | ")
        title, purpose = app.strip().split("<br>", 1)
        yield dict(id=int(id_), title=title.strip("*"), purpose=purpose, auth=auth, test=test,
                   live=live, api=api, mcp=mcp, verdict=verdict.replace("**", ""),
                   urls=re.findall(r"\]\((https://[^)]+)\)", evidence), detail="")


first_pass = {row["id"]: row for row in baseline()}
manifest = {row["id"]: row for row in data("apps.json")}
assert set(first_pass) == set(manifest), "First-pass IDs must match the assignment manifest"
audit = data("audit.json")
retrieval = data("retrieval.json")
read = {p["requested_url"] for p in retrieval["pages"] if p["status"] == "read"}
checks = defaultdict(list)
for check in audit["checks"]:
    checks[check[0]].append(check)
pilot = {b["id"]: b for b in data("pilot-briefs.json")}
rows = []
for id_, first in first_pass.items():
    row = {**first, "category": manifest[id_]["category"], **audit["updates"].get(str(id_), {})}
    if id_ in pilot:
        b = pilot[id_]
        row["title"] = b["product"]
        row["detail"] = b["integration"]["blocker_next_step"]
        if id_ == 82:
            row["mcp"] = "Vendor diagnostics and developer MCP"
        if id_ == 91:
            row["test"] = "Time-limited trial"
        if id_ == 98:
            row["mcp"] = "Community wrapper"
    row["checked_urls"] = [url for url in first["urls"] if url in read]
    row["urls"] = list(dict.fromkeys(first["urls"] + [c[-1] for c in checks[id_]]))
    row["review"] = ("Expanded pilot" if id_ in pilot else "Source audit" if checks[id_]
                     else "Evidence retrieved" if row["checked_urls"] else "Retrieval gap")
    row["first_pass"] = first
    rows.append(row)

N = len(rows)
assert len(set(r["id"] for r in rows)) == N
auth = Counter(a.strip() for r in rows for a in r["auth"].split(","))
test = Counter(r["test"] for r in rows)
live = Counter(r["live"] for r in rows)
free_live = live["Free or limited free usage"] + live["Local or self-managed"]
testable = sum(test[k] for k in ("Free developer, sandbox or quota path", "Time-limited trial", "Local or self-managed"))
gated_labels = {"Paid or metered", "Admin or platform setup", "Review or activation required", "Contract or sales"}
gated = sum(live[k] for k in gated_labels)
common_gate = max(sorted(gated_labels), key=live.get)
coverage = sum(bool(r["checked_urls"]) for r in rows)
counts = [Counter(c[i] for c in audit["checks"]) for i in [2, 3]]


def category_rows():
    for category in dict.fromkeys(r["category"] for r in rows):
        group = [r for r in rows if r["category"] == category]
        yield (category, sum(r["live"] in {"Free or limited free usage", "Local or self-managed"} for r in group),
               sum(r["live"] in {"Paid or metered", "Admin or platform setup", "Review or activation required", "Contract or sales"} for r in group))


def app_rows():
    for r in rows:
        b = pilot.get(r["id"])
        technical = ""
        if b:
            technical = "<dl>" + "".join(f"<dt>{escape(k.replace('_',' ').capitalize())}</dt><dd>{escape(v)}</dd>"
                                          for k, v in b["integration"].items()) + "</dl>"
            technical += "<h4>Starter actions</h4><ul>" + "".join(
                f"<li><code>{escape(a['operation'])}</code> · {escape(a['intent'])}. {escape(a['scopes'])} {links([a['source_url']])}</li>"
                for a in b["actions"]) + "</ul>"
        verdict, _, extra = r["verdict"].partition(". ")
        detail = r["detail"]
        yield f'''<tr data-category="{escape(r['category'])}" data-live="{escape(r['live'])}">
<td><span class="num">{r['id']:02d}</span> <strong>{escape(r['title'])}</strong><small>{escape(r['purpose'])}</small></td>
<td>{escape(r['auth'])}</td><td>{escape(r['test'])}</td><td>{escape(r['live'])}</td>
<td>{escape(r['api'])}<small>MCP · {escape(r['mcp'])}</small></td>
<td><details><summary>{escape(verdict)}</summary><p>{escape(detail)}</p><p>{escape(extra)}</p>{technical}</details></td>
<td><small>{escape(r['review'])}</small><div class="links">{links(r['urls'])}</div></td></tr>'''


def audit_rows():
    for id_, question, before, after, note, url in audit["checks"]:
        yield "<tr>" + "".join(f"<td>{escape(str(x))}</td>" for x in
                   (first_pass[id_]["title"], question, before.title(), after.title(), note)) + f"<td>{links([url])}</td></tr>"


def bar(value, total):
    return f'<span class="bar" aria-hidden="true"><i style="width:{100*value/total:g}%"></i></span>'


metrics = dict(apps=N, auth=dict(auth), test=dict(test), live=dict(live), retrieved_apps=coverage,
               audit={stage: dict(c) for stage, c in zip(("first","reviewed"), counts)})
live_run = data("live-run.json")
embedded = json.dumps({"metrics": metrics, "apps": rows, "audit": audit, "pilot": list(pilot.values()),
                       "live_run": live_run}, ensure_ascii=False).replace("<","\\u003c")
replacements = {
    "APP_COUNT": str(N), "AUTH_COUNT": str(auth["OAuth 2.0"]), "TEST_COUNT": str(testable), "LIVE_COUNT": str(free_live), "GATED_COUNT": str(gated),
    "COVERAGE": str(coverage), "PAGE_COUNT": str(len(read)), "COMMON_GATE": f'{live[common_gate]} of {N} · {escape(common_gate)}',
    "CATEGORY_OPTIONS": "".join(f"<option>{escape(c)}</option>" for c,*_ in category_rows()),
    "LIVE_OPTIONS": "".join(f"<option>{escape(x)}</option>" for x in sorted(live)),
    "APP_ROWS": "\n".join(app_rows()), "AUDIT_ROWS": "\n".join(audit_rows()),
    "AUDIT_BEFORE": str(counts[0]["pass"]), "AUDIT_AFTER": str(counts[1]["pass"]), "AUDIT_TOTAL": str(len(audit["checks"])),
    "AUDIT_PARTIAL": str(counts[0]["partial"]), "AUDIT_FAIL": str(counts[0]["fail"]),
    "LIVE_RUN_DETAIL": escape(live_run["detail"]),
    "CATEGORY_ROWS": "".join(f'<tr><td>{escape(c)}</td><td>{bar(f,10)} {f}</td><td>{bar(g,10)} {g}</td></tr>' for c,f,g in category_rows()),
    "EMBEDDED_DATA": embedded
}
template = (ROOT / "case-study-template.html").read_text()
page = re.sub(r"%%([A-Z_]+)%%", lambda m: replacements[m[1]], template)
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(page)
args.output.with_suffix(".json").write_text(embedded + "\n")
print(json.dumps(metrics, indent=2))
