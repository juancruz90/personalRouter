#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "tickets.json"
BOARD_PATH = ROOT / "board.html"


def sanitize_project(name: str) -> str:
    raw = (name or "default").strip().lower()
    safe = "".join(ch for ch in raw if ch.isalnum() or ch in ("-", "_"))
    return safe or "default"


def db_path_for(project: str) -> Path:
    p = sanitize_project(project)
    return DB_PATH if p == "default" else ROOT / f"tickets.{p}.json"

PRIORITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
VALID_PRIORITY = set(PRIORITY_ORDER.keys())
VALID_STATUS = {"todo", "in_progress", "blocked", "review", "done"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_db(project: str = "default") -> dict:
    path = db_path_for(project)
    if not path.exists():
        return {"next_id": 1, "tickets": [], "events": []}
    return json.loads(path.read_text(encoding="utf-8"))


def save_db(db: dict, project: str = "default") -> None:
    path = db_path_for(project)
    path.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")


def add_event(db: dict, ticket_id: int, actor: str, action: str, payload: dict) -> None:
    db["events"].append(
        {
            "ts": now_iso(),
            "ticket_id": ticket_id,
            "actor": actor,
            "action": action,
            "payload": payload,
        }
    )


def find_ticket(db: dict, ticket_id: int) -> dict:
    for t in db["tickets"]:
        if t["id"] == ticket_id:
            return t
    raise KeyError(f"Ticket #{ticket_id} no existe")


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _text(self, code: int, text: str, content_type="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query or "")
        project = sanitize_project((q.get("project", ["default"])[0]))

        if path in ("/", "/board", "/board.html"):
            html = BOARD_PATH.read_text(encoding="utf-8") if BOARD_PATH.exists() else "<h1>board.html no encontrado</h1>"
            return self._text(200, html, "text/html; charset=utf-8")

        if path == "/api/health":
            return self._json(200, {"ok": True, "ts": now_iso()})

        if path == "/api/projects":
            names = []
            if (ROOT / "tickets.json").exists():
                names.append("default")
            for p in ROOT.glob("tickets*.json"):
                n = p.name
                if n == "tickets.json":
                    continue
                if n.startswith("tickets.") and n.endswith(".json"):
                    names.append(n[len("tickets."):-len(".json")])
            return self._json(200, {"projects": sorted(set(names))})

        if path == "/api/tickets":
            db = load_db(project)
            tickets = sorted(db["tickets"], key=lambda t: (t["status"] == "done", PRIORITY_ORDER.get(t["priority"], 99), t["id"]))
            return self._json(200, {"project": project, "tickets": tickets, "eventsCount": len(db.get("events", [])), "next_id": db.get("next_id", 1)})

        if path.startswith("/api/tickets/"):
            try:
                tid = int(path.split("/")[-1])
                db = load_db(project)
                t = find_ticket(db, tid)
                return self._json(200, t)
            except Exception as e:
                return self._json(404, {"ok": False, "error": str(e)})

        if path == "/tickets.json":
            db = load_db(project)
            return self._json(200, db)

        return self._json(404, {"ok": False, "error": "Ruta no encontrada"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query or "")
        project = sanitize_project((q.get("project", ["default"])[0]))

        if path == "/api/tickets":
            try:
                body = self._read_json()
                title = str(body.get("title", "")).strip()
                description = str(body.get("description", "")).strip()
                priority = str(body.get("priority", "medium")).lower()
                by = str(body.get("by", "florencia")).strip() or "florencia"
                assignee = body.get("assignee")
                tags = body.get("tags", [])

                if not title:
                    return self._json(400, {"ok": False, "error": "title requerido"})
                if not description:
                    return self._json(400, {"ok": False, "error": "description requerido"})
                if priority not in VALID_PRIORITY:
                    return self._json(400, {"ok": False, "error": "priority inválida"})

                db = load_db(project)
                ticket = {
                    "id": db["next_id"],
                    "title": title,
                    "description": description,
                    "priority": priority,
                    "status": "todo",
                    "created_at": now_iso(),
                    "updated_at": now_iso(),
                    "created_by": by,
                    "assignee": assignee,
                    "tags": [str(t).strip() for t in tags if str(t).strip()],
                    "comments": [],
                    "resolution": None,
                }
                db["tickets"].append(ticket)
                add_event(db, ticket["id"], by, "ticket_created", {"title": title})
                db["next_id"] += 1
                save_db(db, project)
                return self._json(201, {"ok": True, "ticket": ticket})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        if path.endswith("/claim") and path.startswith("/api/tickets/"):
            try:
                tid = int(path.split("/")[-2])
                body = self._read_json()
                agent = str(body.get("agent", "")).strip()
                if not agent:
                    return self._json(400, {"ok": False, "error": "agent requerido"})
                db = load_db(project)
                t = find_ticket(db, tid)
                if t["status"] == "done":
                    return self._json(409, {"ok": False, "error": "Ticket ya está done"})
                t["assignee"] = agent
                t["status"] = "in_progress"
                t["updated_at"] = now_iso()
                add_event(db, tid, agent, "ticket_claimed", {})
                save_db(db, project)
                return self._json(200, {"ok": True, "ticket": t})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        if path.endswith("/comment") and path.startswith("/api/tickets/"):
            try:
                tid = int(path.split("/")[-2])
                body = self._read_json()
                by = str(body.get("by", "florencia")).strip() or "florencia"
                text = str(body.get("text", "")).strip()
                if not text:
                    return self._json(400, {"ok": False, "error": "text requerido"})
                db = load_db(project)
                t = find_ticket(db, tid)
                c = {"ts": now_iso(), "by": by, "text": text}
                t["comments"].append(c)
                t["updated_at"] = now_iso()
                add_event(db, tid, by, "comment", {"text": text})
                save_db(db, project)
                return self._json(200, {"ok": True, "ticket": t})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        return self._json(404, {"ok": False, "error": "Ruta no encontrada"})

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query or "")
        project = sanitize_project((q.get("project", ["default"])[0]))

        if path.startswith("/api/tickets/"):
            try:
                tid = int(path.split("/")[-1])
                body = self._read_json()
                db = load_db(project)
                t = find_ticket(db, tid)

                actor = str(body.get("by", "florencia")).strip() or "florencia"
                if "status" in body:
                    status = str(body["status"]).lower()
                    if status not in VALID_STATUS:
                        return self._json(400, {"ok": False, "error": "status inválido"})
                    old = t["status"]
                    t["status"] = status
                    add_event(db, tid, actor, "status_changed", {"from": old, "to": status})

                if "assignee" in body:
                    t["assignee"] = body["assignee"]
                    add_event(db, tid, actor, "assignee_changed", {"to": body["assignee"]})

                if "resolution" in body and body["resolution"]:
                    t["resolution"] = {"by": actor, "ts": now_iso(), "text": str(body["resolution"]).strip()}
                    t["status"] = "done"
                    add_event(db, tid, actor, "resolved", {"resolution": str(body["resolution"]).strip()})

                t["updated_at"] = now_iso()
                save_db(db, project)
                return self._json(200, {"ok": True, "ticket": t})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})

        return self._json(404, {"ok": False, "error": "Ruta no encontrada"})


def main():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Solo crea default si no existe ningún proyecto todavía
    if not any(ROOT.glob("tickets*.json")):
        save_db({"next_id": 1, "tickets": [], "events": []})

    host = "127.0.0.1"
    port = 8787
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Project Hub server on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
