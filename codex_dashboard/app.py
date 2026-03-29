import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

WORKSPACE = Path(r"C:\Users\juanc\.openclaw\workspace\orquestacion")
BASE = WORKSPACE / "codex_dashboard"
STATIC = BASE / "static"
CONFIG = BASE / "config"
ROUTING_FILE = CONFIG / "routing.json"
PROJECTS_FILE = CONFIG / "projects.json"
AGENTS_DIR = Path.home() / ".openclaw" / "agents"

CONFIG.mkdir(parents=True, exist_ok=True)
STATIC.mkdir(parents=True, exist_ok=True)

if not ROUTING_FILE.exists():
    ROUTING_FILE.write_text(json.dumps({"assignments": {}}, indent=2), encoding="utf-8")
if not PROJECTS_FILE.exists():
    PROJECTS_FILE.write_text(json.dumps({"projects": {}}, indent=2), encoding="utf-8")


def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True, shell=True)
    return p.returncode, p.stdout, p.stderr


def list_agents_meta():
    rc, out, _ = run("openclaw agents list --json")
    if rc != 0:
        return []
    try:
        data = json.loads(out)
    except Exception:
        return []
    agents = data.get("agents", []) if isinstance(data, dict) else []
    meta = []
    for a in agents:
        ws = a.get("workspace") or ""
        project = Path(ws).name if ws else "unknown"
        meta.append({"id": a.get("id"), "workspace": ws, "project": project})
    return [m for m in meta if m.get("id")]


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def routing_path_for(project_name: str):
    safe = project_name.replace("..", "").replace("/", "_").replace("\\", "_")
    if not safe or safe == "all":
        return ROUTING_FILE
    return CONFIG / f"routing.{safe}.json"


def read_auth_profiles(agent):
    p = AGENTS_DIR / agent / "agent" / "auth-profiles.json"
    if not p.exists():
        return {}
    return read_json(p, {})


def get_agent_model_status(agent):
    rc, out, _ = run(f'openclaw models --agent {agent} status --json')
    if rc != 0:
        return {"error": True}
    try:
        return json.loads(out)
    except Exception:
        return {"error": True}


def get_projects(agents_meta):
    saved = read_json(PROJECTS_FILE, {"projects": {}}).get("projects", {})
    auto = {}
    for m in agents_meta:
        auto.setdefault(m["project"], []).append(m["id"])

    merged = {"all": sorted([m["id"] for m in agents_meta])}
    for k, v in auto.items():
        merged[k] = sorted(set(v))
    for k, v in saved.items():
        merged[k] = sorted(set(v))
    return merged


def build_state(project_name="all"):
    agents_meta = list_agents_meta()
    projects = get_projects(agents_meta)
    allowed_agents = set(projects.get(project_name, projects.get("all", [])))

    route_file = routing_path_for(project_name)
    routing = read_json(route_file, {"assignments": {}})

    state = {
        "project": project_name,
        "projects": projects,
        "agents": [],
        "accounts": {},
        "routing": routing,
    }

    for m in agents_meta:
        agent = m["id"]
        if agent not in allowed_agents:
            continue

        auth = read_auth_profiles(agent)
        profiles = auth.get("profiles", {}) if isinstance(auth, dict) else {}
        codex_profiles = []
        for pid, pdata in profiles.items():
            if not str(pid).startswith("openai-codex:"):
                continue
            account_id = pdata.get("accountId") or "unknown"
            codex_profiles.append({
                "profileId": pid,
                "accountId": account_id,
                "expires": pdata.get("expires"),
            })
            state["accounts"].setdefault(account_id, {"accountId": account_id, "profiles": []})
            state["accounts"][account_id]["profiles"].append({"agent": agent, "profileId": pid})

        model_status = get_agent_model_status(agent)
        state["agents"].append({
            "id": agent,
            "workspace": m["workspace"],
            "project": m["project"],
            "codexProfiles": codex_profiles,
            "defaultModel": model_status.get("defaultModel"),
            "resolvedDefault": model_status.get("resolvedDefault"),
            "contextTokens": model_status.get("contextTokens"),
        })

    state["accounts"] = list(state["accounts"].values())
    return state


def apply_routing(assignments):
    results = []
    for agent, profiles in assignments.items():
        if not profiles:
            continue
        joined = " ".join(profiles)
        cmd = f"openclaw models auth order set --agent {agent} --provider openai-codex {joined}"
        rc, out, err = run(cmd)
        results.append({"agent": agent, "ok": rc == 0, "stdout": out.strip(), "stderr": err.strip(), "cmd": cmd})
    return results


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, status=200):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        q = parse_qs(parsed.query or "")
        project = q.get("project", ["all"])[0]

        if parsed.path == "/api/state":
            self._json(build_state(project))
            return
        if parsed.path in ["/", "/index.html", "/board.html"]:
            page = "board.html" if parsed.path == "/board.html" else "index.html"
            html = (STATIC / page).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            payload = {}

        project = payload.get("project", "all")
        route_file = routing_path_for(project)

        if parsed.path == "/api/projects/save":
            data = {"projects": payload.get("projects", {})}
            PROJECTS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
            self._json({"ok": True, "saved": str(PROJECTS_FILE)})
            return

        if parsed.path == "/api/routing/save":
            route_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            self._json({"ok": True, "saved": str(route_file)})
            return

        if parsed.path == "/api/routing/apply":
            assignments = payload.get("assignments", {})
            route_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            results = apply_routing(assignments)
            self._json({"ok": True, "results": results})
            return

        self._json({"ok": False, "error": "not_found"}, status=404)


if __name__ == "__main__":
    port = int(os.environ.get("CODEX_DASHBOARD_PORT", "8787"))
    server = HTTPServer(("127.0.0.1", port), Handler)
    print(f"Codex dashboard running at http://127.0.0.1:{port}")
    server.serve_forever()
