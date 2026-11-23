"""Inventory a locally retrieved OpenAPI or Google Discovery document."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}


def openapi_operations(doc):
    for path, item in doc["paths"].items():
        if "$ref" in item:
            raise ValueError(f"Resolve path-item reference before counting {path}")
        for method, op in item.items():
            if method.lower() in METHODS:
                yield {"family": path.strip("/").split("/")[0], "operation": op.get("operationId"),
                       "method": method.upper(), "path": path,
                       "security": op.get("security", doc.get("security", []))}


def discovery_operations(resource, family):
    for op in resource.get("methods", {}).values():
        yield {"family": family, "operation": op["id"], "method": op["httpMethod"],
               "path": op["path"], "scopes": op.get("scopes", [])}
    for name, child in resource.get("resources", {}).items():
        yield from discovery_operations(child, ".".join(filter(None, (family, name))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--resource", help="Discovery resource path, e.g. projects.locations.notebooks")
    args = parser.parse_args()
    raw = args.spec.read_bytes()
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError:
        import yaml
        doc = yaml.safe_load(raw)
    if "openapi" in doc or "swagger" in doc:
        if args.resource:
            parser.error("--resource applies only to Google Discovery documents")
        ops = list(openapi_operations(doc))
        version = doc.get("info", {}).get("version")
    elif doc.get("kind") == "discovery#restDescription":
        resource = doc
        for segment in (args.resource or "").split("."):
            if segment:
                resource = resource["resources"][segment]
        ops = list(discovery_operations(resource, args.resource or ""))
        version = {"version": doc.get("version"), "revision": doc.get("revision")}
    else:
        parser.error("Unrecognized specification format")
    print(json.dumps({"source": args.source, "version": version, "sha256": hashlib.sha256(raw).hexdigest(),
                      "operation_count": len(ops), "by_family": Counter(o["family"] for o in ops),
                      "operations": ops}, indent=2))
