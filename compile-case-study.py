"""Compile the agent run, held-out audit and manifest into one HTML page."""
import argparse, json, re
from collections import Counter
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
P = argparse.ArgumentParser(description=__doc__)
P.add_argument("--output", default="index.html", type=Path)
args = P.parse_args()
data = lambda name: json.loads((ROOT / "data" / name).read_text())

manifest = {a["id"]: a for a in data("apps.json")}
run, held, old = data("agent-run.json"), data("heldout-audit.json"), data("audit.json")
FIELDS = ("auth", "test_access", "production_access", "interfaces", "mcp", "buildability")
NAMES = {"oauth2": "OAuth 2.0", "api_key": "API key", "client_secret": "Client secret", "personal_token": "Personal token",
         "product_token": "Product token", "basic": "Basic", "http_rpc": "HTTP RPC", "graphql": "GraphQL", "rest": "REST",
         "sdk": "SDK", "cli": "CLI", "grpc": "gRPC"}
nice = lambda l: NAMES.get(l, l.replace("_", " ").capitalize())


def links(urls):
    return " ".join(f'<a href="{escape(u, quote=True)}" target="_blank" rel="noopener">[{i}]</a>'
                    for i, u in enumerate(urls, 1) if u.startswith("https://"))


def access(c):
    if set(c["production_access"]["labels"]) & {"free_tier", "local"}:
        return "Free live route"
    if set(c["test_access"]["labels"]) & {"free_sandbox", "trial", "local"}:
        return "Trial or sandbox only"
    return "No free route documented"


rows = []
for a in run["apps"]:
    b = a.get("verified") or a["first"]
    claims = json.loads(json.dumps(b["claims"]))
    fixes = held["updates"].get(str(a["id"]), {})
    for field, change in fixes.items():
        claims[field].update(change)
    rows.append(dict(id=a["id"], name=manifest[a["id"]]["name"], product=b["product"], category=manifest[a["id"]]["category"],
                     purpose=b["description"], claims=claims, access=access(claims), blocker=b["blocker"], actions=b["actions"],
                     urls=list(dict.fromkeys(u for f in FIELDS for u in claims[f]["urls"])),
                     status=("Two passes" if "verified" in a else "First pass only") + (" + held-out fix" if fixes else "")))
assert {r["id"] for r in rows} == set(manifest), "Run must cover every manifest ID"

N = len(rows)
verified = [a for a in run["apps"] if "verified" in a]
missing = [r for r in rows if r["status"].startswith("First")]
label = lambda f: Counter(l for r in rows for l in r["claims"][f]["labels"])
auth, prod, mcp = label("auth"), label("production_access"), label("mcp")
tiers = Counter(r["access"] for r in rows)
vendor_mcp = sum(bool(set(r["claims"]["mcp"]["labels"]) & {"vendor_data", "vendor_developer", "vendor_beta"}) for r in rows)
gate = {k: prod[k] for k in ("paid", "admin", "approval", "partner")}
changed = {f: sum(sorted(a["first"]["claims"][f]["labels"]) != sorted(a["verified"]["claims"][f]["labels"]) for a in verified) for f in FIELDS}
score = [Counter(c[i] for c in held["checks"]) for i in (2, 3)]
H = len(held["checks"])
by_field = {f: [sum(c[1] == f and c[i] == "pass" for c in held["checks"]) for i in (2, 3)] for f in ("auth", "test_access", "production_access", "mcp")}
old_before, old_after = (sum(c[i] == "pass" for c in old["checks"]) for i in (2, 3))
categories = list(dict.fromkeys(r["category"] for r in rows))
TIERS = ("Free live route", "Trial or sandbox only", "No free route documented")
bar = lambda v, t: f'<span class="bar" aria-hidden="true"><i style="width:{100*v/t:g}%"></i></span>'
cells = {c: [sum(r["category"] == c and r["access"] == t for r in rows) for t in TIERS] for c in categories}
best = sorted(categories, key=lambda c: -cells[c][0])[:3]


def app_rows():
    for r in rows:
        c = r["claims"]
        labels = lambda f: escape(", ".join(nice(x) for x in c[f]["labels"]) or "Unresolved")
        cell = lambda f: f'<details><summary>{labels(f)}</summary><p>{escape(c[f]["summary"])}</p></details>'
        acts = "".join(f"<li><code>{escape(x)}</code></li>" for x in r["actions"])
        yield f'''<tr data-category="{escape(r['category'])}" data-live="{escape(r['access'])}">
<td><span class="num">{r['id']:02d}</span> <strong>{escape(r['name'])}</strong><small>{escape(r['product'])}</small><details><summary>About</summary><p>{escape(r['purpose'])}</p></details></td>
<td>{cell('auth')}</td><td><strong>{escape(r['access'])}</strong>{cell('test_access')}</td><td>{cell('production_access')}</td>
<td>{cell('interfaces')}<small>MCP</small>{cell('mcp')}</td>
<td>{cell('buildability')}<details><summary>Blocker and next step</summary><p>{escape(r['blocker'])}</p><ul>{acts}</ul></details></td>
<td><small>{escape(r['status'])}</small><div class="links">{links(r['urls'][:8])}</div></td></tr>'''


def audit_rows():
    for id_, field, before, after, note, url in held["checks"]:
        yield "<tr>" + "".join(f"<td>{escape(x)}</td>" for x in (manifest[id_]["name"], field.replace("_", " "), before, after, note)) + f"<td>{links([url])}</td></tr>"


timeouts = sum("timeout" in f["message"] for f in run["failures"])
tokens = run["usage_saved_passes"]
embedded = json.dumps({"run": run["run"], "models": run["models"], "apps": rows, "heldout": held, "tuning_audit": old,
                       "failures": run["failures"]}, ensure_ascii=False).replace("<", "\\u003c")
values = {
    "APP_COUNT": N, "VERIFIED": len(verified), "OAUTH": auth["oauth2"], "APIKEY": auth["api_key"], "FREE": tiers[TIERS[0]],
    "TRIAL": tiers[TIERS[1]], "GATED": tiers[TIERS[2]], "VENDOR_MCP": vendor_mcp,
    "GATES": ", ".join(f"{nice(k)} {v}" for k, v in sorted(gate.items(), key=lambda x: -x[1])),
    "TOP_GATE": nice(max(gate, key=gate.get)), "TOP_GATE_COUNT": max(gate.values()),
    "BEST": escape(", ".join(f"{c} ({cells[c][0]}/10)" for c in best)),
    "GATED_LIST": escape(", ".join(r["name"] for r in rows if r["access"] == TIERS[2])),
    "SUPPORT_FREE": cells["Support and Helpdesk"][0],
    "MISSING": escape(", ".join(r["name"] for r in missing) or "none"), "MISSING_COUNT": len(missing),
    "MODELS": escape("; ".join(f"{k}: {v}" for k, v in run["models"].items())),
    "INPUT_M": f"{tokens['input_tokens']/1e6:.1f}", "CACHED_PCT": f"{100*tokens['cached_input_tokens']/tokens['input_tokens']:.0f}",
    "FAILS": len(run["failures"]), "TIMEOUTS": timeouts,
    "CHANGED": ", ".join(f"{f.replace('_', ' ')} {n}" for f, n in sorted(changed.items(), key=lambda x: -x[1])),
    "H": H, "H_BEFORE": score[0]["pass"], "H_AFTER": score[1]["pass"], "H_PCT_BEFORE": f"{100*score[0]['pass']/H:.0f}",
    "H_PCT_AFTER": f"{100*score[1]['pass']/H:.0f}", "H_FAIL": score[1]["fail"], "H_PARTIAL": score[1]["partial"],
    "BY_FIELD": "".join(f"<tr><td>{f.replace('_', ' ')}</td><td>{b}/10</td><td>{a}/10</td></tr>" for f, (b, a) in by_field.items()),
    "METHOD": escape(held["method"]), "OLD": f"{old_before}/{len(old['checks'])} to {old_after}/{len(old['checks'])}",
    "CATEGORY_OPTIONS": "".join(f"<option>{escape(c)}</option>" for c in categories),
    "LIVE_OPTIONS": "".join(f"<option>{t}</option>" for t in TIERS),
    "CATEGORY_ROWS": "".join(f"<tr><td>{escape(c)}</td>" + "".join(f"<td>{bar(v, 10)} {v}</td>" for v in cells[c]) + "</tr>" for c in categories),
    "APP_ROWS": "\n".join(app_rows()), "AUDIT_ROWS": "\n".join(audit_rows()), "EMBEDDED_DATA": embedded,
}
page = re.sub(r"%%([A-Z_]+)%%", lambda m: str(values[m[1]]), (ROOT / "case-study-template.html").read_text())
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(page)
print({k: v for k, v in values.items() if len(str(v)) < 400})
