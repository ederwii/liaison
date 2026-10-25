#!/bin/bash
# State and config files (JSON, python3 is the engine). Sourced, never executed.
# Needs LIAISON_STATE_DIR (set by bin/liaison; default $LIAISON_OFFICE/.liaison).

_state_file()  { echo "$LIAISON_STATE_DIR/state.json"; }
_config_file() { echo "$LIAISON_STATE_DIR/config.json"; }

_require_python() { command -v python3 >/dev/null 2>&1 || { echo "liaison: python3 is required" >&2; return 1; }; }

# state_get <step>: prints ok | missing | skipped (missing when never set).
state_get() {
  _require_python || return 1
  LS_FILE="$(_state_file)" LS_STEP="$1" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["LS_FILE"]))
    print(d[os.environ["LS_STEP"]]["status"])
except Exception:
    print("missing")'
}

# state_detail <step>: prints the detail text, empty when none.
state_detail() {
  _require_python || return 1
  LS_FILE="$(_state_file)" LS_STEP="$1" python3 -c '
import json, os
try:
    print(json.load(open(os.environ["LS_FILE"]))[os.environ["LS_STEP"]].get("detail", ""))
except Exception:
    print("")'
}

# state_set <step> <ok|missing|skipped> [detail]
state_set() {
  _require_python || return 1
  case "$2" in ok|missing|skipped) ;; *) echo "liaison: bad status '$2'" >&2; return 1 ;; esac
  mkdir -p "$LIAISON_STATE_DIR" || return 1
  LS_FILE="$(_state_file)" LS_STEP="$1" LS_STATUS="$2" LS_DETAIL="${3:-}" python3 -c '
import json, os, time
f = os.environ["LS_FILE"]
try:
    d = json.load(open(f))
except Exception:
    d = {}
d[os.environ["LS_STEP"]] = {"status": os.environ["LS_STATUS"],
    "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "detail": os.environ["LS_DETAIL"]}
json.dump(d, open(f + ".tmp", "w"), indent=2)
os.replace(f + ".tmp", f)'
}

# config_get <key>: scalars print raw, lists/objects print JSON; defaults when unset.
config_get() {
  _require_python || return 1
  LS_FILE="$(_config_file)" LS_KEY="$1" python3 -c '
import json, os
D = {"language": "en", "office_channel": "liaison-office", "owner_user_ids": [], "permission_mode": "supervised", "advanced": False}
try:
    d = json.load(open(os.environ["LS_FILE"]))
except Exception:
    d = {}
v = d.get(os.environ["LS_KEY"], D.get(os.environ["LS_KEY"], ""))
print(v if isinstance(v, str) else json.dumps(v, separators=(",", ":")))'
}

# config_set <key> <value>: a value starting with [ or { is stored as JSON, anything else as a string.
config_set() {
  _require_python || return 1
  mkdir -p "$LIAISON_STATE_DIR" || return 1
  LS_FILE="$(_config_file)" LS_KEY="$1" LS_VAL="$2" python3 -c '
import json, os
D = {"language": "en", "office_channel": "liaison-office", "owner_user_ids": [], "permission_mode": "supervised", "advanced": False}
f = os.environ["LS_FILE"]
try:
    d = json.load(open(f))
except Exception:
    d = {}
for k in D:
    d.setdefault(k, D[k])
v = os.environ["LS_VAL"]
if os.environ["LS_KEY"] == "permission_mode" and v not in ("supervised", "unattended"):
    raise SystemExit("liaison: permission_mode must be supervised or unattended, got " + v)
if os.environ["LS_KEY"] == "advanced":
    if v not in ("true", "false"):
        raise SystemExit("liaison: advanced must be true or false, got " + v)
    d["advanced"] = (v == "true")
else:
    d[os.environ["LS_KEY"]] = json.loads(v) if v[:1] in ("[", "{") else v
json.dump(d, open(f + ".tmp", "w"), indent=2)
os.replace(f + ".tmp", f)'
}

# config_add_project <name> <abs-path> <channel>: appends {name,path,channel} to config.json projects[].
# Idempotent by name: prints "added" or "exists" (an existing entry is left as it is).
config_add_project() {
  _require_python || return 1
  mkdir -p "$LIAISON_STATE_DIR" || return 1
  LS_FILE="$(_config_file)" LS_NAME="$1" LS_PATH="$2" LS_CHAN="$3" python3 -c '
import json, os
D = {"language": "en", "office_channel": "liaison-office", "owner_user_ids": [], "permission_mode": "supervised", "advanced": False}
f = os.environ["LS_FILE"]
try:
    d = json.load(open(f))
except Exception:
    d = {}
for k in D:
    d.setdefault(k, D[k])
ps = d.setdefault("projects", [])
if any(p.get("name") == os.environ["LS_NAME"] for p in ps):
    print("exists")
else:
    ps.append({"name": os.environ["LS_NAME"], "path": os.environ["LS_PATH"], "channel": os.environ["LS_CHAN"]})
    json.dump(d, open(f + ".tmp", "w"), indent=2)
    os.replace(f + ".tmp", f)
    print("added")'
}

# config_project_path <name>: prints the registered path of a project, empty when not registered.
config_project_path() {
  _require_python || return 1
  LS_FILE="$(_config_file)" LS_NAME="$1" python3 -c '
import json, os
try:
    for p in json.load(open(os.environ["LS_FILE"])).get("projects", []):
        if p.get("name") == os.environ["LS_NAME"]:
            print(p.get("path", ""))
            break
except Exception:
    pass'
}
