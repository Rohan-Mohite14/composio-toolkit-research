"""Export a compact, publishable copy of an agent run from the SQLite checkpoints."""
import json, sqlite3, sys
from collections import Counter
from pathlib import Path

db, run = sys.argv[1], sys.argv[2]
out = Path(__file__).resolve().parent / "data" / "agent-run.json"
con = sqlite3.connect(db)
apps, usage, models = {}, Counter(), Counter()
for id_, stage, app, brief, trace, saved in con.execute(
        "SELECT id, stage, app, brief, trace, saved_at FROM briefs WHERE run=? ORDER BY id, stage", (run,)):
    b, t = json.loads(brief), json.loads(trace)
    model = t.get("model") or "gpt-6.1-sol"  # traces before model pinning used the CLI config default
    models[f"{model} {stage}"] += 1
    for u in t.get("usage") or []:
        usage.update({k: u.get(k, 0) for k in ("input_tokens", "cached_input_tokens", "output_tokens")})
    row = apps.setdefault(id_, {"id": id_})
    row[stage] = {"product": b["product"], "description": b["description"], "saved_at": saved, "model": model,
                  "claims": {k: {"labels": v["labels"], "summary": v["summary"],
                                 "urls": list(dict.fromkeys(e["url"] for e in v["evidence"]))} for k, v in b["claims"].items()},
                  "blocker": b["integration"]["blocker_next_step"],
                  "actions": [a["operation"] for a in b["actions"]], "ledger_rows": len(b["evidence_ledger"])}
fails = [dict(id=i, stage=s, message=m, at=at) for i, s, m, at in con.execute(
    "SELECT id, stage, message, failed_at FROM failures WHERE run=? ORDER BY failed_at", (run,))]
out.write_text(json.dumps({"run": run, "models": models, "usage_saved_passes": usage, "failures": fails,
                           "apps": list(apps.values())}, indent=1))
print(out, len(apps), "apps,", sum("verified" in a for a in apps.values()), "verified,", len(fails), "failure records")
