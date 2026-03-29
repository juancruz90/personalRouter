#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "tickets.json"

PRIORITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
VALID_STATUS = {"todo", "in_progress", "blocked", "review", "done"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_ticket(t: Dict[str, Any]) -> Dict[str, Any]:
    t.setdefault("comments", [])
    t.setdefault("resolution", None)
    t.setdefault("collaborators", [])
    t.setdefault("blocked_meta", None)
    t.setdefault("created_at", now_iso())
    t.setdefault("updated_at", t["created_at"])
    return t


def load_db() -> Dict[str, Any]:
    if not DB_PATH.exists():
        return {"next_id": 1, "tickets": [], "events": []}
    db = json.loads(DB_PATH.read_text(encoding="utf-8"))
    db.setdefault("next_id", 1)
    db.setdefault("tickets", [])
    db.setdefault("events", [])
    db["tickets"] = [normalize_ticket(t) for t in db["tickets"]]
    return db


def save_db(db: Dict[str, Any]) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")


def add_event(db: Dict[str, Any], ticket_id: int, actor: str, action: str, payload: Dict[str, Any]) -> None:
    db["events"].append({"ts": now_iso(), "ticket_id": ticket_id, "actor": actor, "action": action, "payload": payload})


def find_ticket(db: Dict[str, Any], ticket_id: int) -> Dict[str, Any]:
    for t in db["tickets"]:
        if t["id"] == ticket_id:
            return t
    raise SystemExit(f"Ticket #{ticket_id} no existe")


def cmd_init(_: argparse.Namespace) -> None:
    if DB_PATH.exists():
        print(f"Ya existe: {DB_PATH}")
        return
    save_db({"next_id": 1, "tickets": [], "events": []})
    print(f"Inicializado: {DB_PATH}")


def cmd_add(args: argparse.Namespace) -> None:
    db = load_db()
    priority = args.priority.lower()
    if priority not in PRIORITY_ORDER:
        raise SystemExit("priority debe ser: critical|high|medium|low")

    ts = now_iso()
    ticket = normalize_ticket(
        {
            "id": db["next_id"],
            "title": args.title.strip(),
            "description": args.description.strip(),
            "priority": priority,
            "status": "todo",
            "created_at": ts,
            "updated_at": ts,
            "created_by": args.by,
            "assignee": args.assignee,
            "tags": [t.strip() for t in (args.tags or []) if t.strip()],
            "collaborators": [c.strip() for c in (args.collaborators or []) if c.strip()],
        }
    )
    db["tickets"].append(ticket)
    add_event(db, ticket["id"], args.by, "ticket_created", {"title": ticket["title"]})
    db["next_id"] += 1
    save_db(db)
    print(f"Ticket creado: #{ticket['id']} [{ticket['priority']}] {ticket['title']}")


def format_ticket(t: Dict[str, Any]) -> str:
    assignee = t.get("assignee") or "-"
    return f"#{t['id']:03d} | {t['status']:<11} | {t['priority']:<8} | {assignee:<12} | {t['title']}"


def cmd_list(args: argparse.Namespace) -> None:
    db = load_db()
    tickets: List[Dict[str, Any]] = db["tickets"]
    if args.status:
        tickets = [t for t in tickets if t["status"] == args.status]
    if args.assignee:
        tickets = [t for t in tickets if (t.get("assignee") or "") == args.assignee]
    tickets.sort(key=lambda t: (t["status"] == "done", PRIORITY_ORDER[t["priority"]], t["id"]))

    if not tickets:
        print("Sin tickets")
        return
    print("ID   | STATUS      | PRIORITY | ASSIGNEE     | TITLE")
    print("-" * 78)
    for t in tickets:
        print(format_ticket(t))


def pick_next_ticket(db: Dict[str, Any], agent: str) -> Dict[str, Any]:
    candidates = [t for t in db["tickets"] if t["status"] in {"todo", "blocked"} and (t.get("assignee") in (None, "", agent))]
    if not candidates:
        raise SystemExit("No hay tickets disponibles para tomar")
    candidates.sort(key=lambda t: (PRIORITY_ORDER[t["priority"]], t["id"]))
    return candidates[0]


def cmd_claim(args: argparse.Namespace) -> None:
    db = load_db()
    ticket = find_ticket(db, args.id) if args.id else pick_next_ticket(db, args.agent)
    if ticket["status"] == "done":
        raise SystemExit("No podés tomar un ticket terminado")
    ticket["assignee"] = args.agent
    ticket["status"] = "in_progress"
    ticket["updated_at"] = now_iso()
    add_event(db, ticket["id"], args.agent, "ticket_claimed", {})
    save_db(db)
    print(f"{args.agent} tomó ticket #{ticket['id']}: {ticket['title']}")


def cmd_move(args: argparse.Namespace) -> None:
    db = load_db()
    ticket = find_ticket(db, args.id)
    new_status = args.status.lower()
    if new_status not in VALID_STATUS:
        raise SystemExit("Estado inválido")

    actor = args.by
    if args.assignee:
        ticket["assignee"] = args.assignee
    old = ticket["status"]
    ticket["status"] = new_status
    if new_status != "blocked":
        ticket["blocked_meta"] = None
    ticket["updated_at"] = now_iso()
    add_event(db, ticket["id"], actor, "status_changed", {"from": old, "to": new_status})
    save_db(db)
    print(f"Ticket #{ticket['id']} {old} -> {new_status}")


def cmd_comment(args: argparse.Namespace) -> None:
    db = load_db()
    ticket = find_ticket(db, args.id)
    entry = {"ts": now_iso(), "by": args.by, "text": args.text.strip()}
    ticket["comments"].append(entry)
    ticket["updated_at"] = now_iso()
    add_event(db, ticket["id"], args.by, "comment", {"text": args.text.strip()})
    save_db(db)
    print(f"Comentario agregado a #{ticket['id']}")


def cmd_block(args: argparse.Namespace) -> None:
    db = load_db()
    t = find_ticket(db, args.id)
    t["status"] = "blocked"
    t["blocked_meta"] = {
        "type": args.type,
        "evidence": args.evidence.strip(),
        "unblock_definition": args.unblock.strip(),
        "unblock_owner": args.unblock_owner.strip(),
        "eta_unblock": args.eta.strip(),
        "next_action_at": args.next_action_at.strip() if args.next_action_at else "",
        "updated_by": args.by,
        "updated_at": now_iso(),
    }
    t["updated_at"] = now_iso()
    add_event(db, t["id"], args.by, "blocked_updated", t["blocked_meta"])
    save_db(db)
    print(f"Ticket #{t['id']} marcado como blocked con protocolo anti-bloqueo")


def cmd_add_collab(args: argparse.Namespace) -> None:
    db = load_db()
    t = find_ticket(db, args.id)
    existing = set(t.get("collaborators") or [])
    for c in args.collaborators:
        c = c.strip()
        if c and c != t.get("assignee"):
            existing.add(c)
    t["collaborators"] = sorted(existing)
    t["updated_at"] = now_iso()
    add_event(db, t["id"], args.by, "collaborators_updated", {"collaborators": t["collaborators"]})
    save_db(db)
    print(f"Ticket #{t['id']} colaboradores: {', '.join(t['collaborators']) if t['collaborators'] else '-'}")


def cmd_resolve(args: argparse.Namespace) -> None:
    db = load_db()
    ticket = find_ticket(db, args.id)
    ticket["status"] = "done"
    ticket["blocked_meta"] = None
    ticket["resolution"] = {"by": args.by, "ts": now_iso(), "text": args.resolution.strip()}
    ticket["updated_at"] = now_iso()
    add_event(db, ticket["id"], args.by, "resolved", {"resolution": args.resolution.strip()})
    save_db(db)
    print(f"Ticket #{ticket['id']} resuelto")


def cmd_show(args: argparse.Namespace) -> None:
    db = load_db()
    t = find_ticket(db, args.id)
    print(json.dumps(t, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Gestor simple de tickets para orquestación multiagente")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init"); s.set_defaults(func=cmd_init)

    s = sub.add_parser("add")
    s.add_argument("--title", required=True)
    s.add_argument("--description", required=True)
    s.add_argument("--priority", default="medium")
    s.add_argument("--by", default="juan")
    s.add_argument("--assignee", default=None)
    s.add_argument("--tags", nargs="*", default=[])
    s.add_argument("--collaborators", nargs="*", default=[])
    s.set_defaults(func=cmd_add)

    s = sub.add_parser("list"); s.add_argument("--status", default=None); s.add_argument("--assignee", default=None); s.set_defaults(func=cmd_list)

    s = sub.add_parser("claim"); s.add_argument("--agent", required=True); s.add_argument("--id", type=int, default=None); s.set_defaults(func=cmd_claim)

    s = sub.add_parser("move")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--status", required=True)
    s.add_argument("--by", required=True)
    s.add_argument("--assignee", default=None)
    s.set_defaults(func=cmd_move)

    s = sub.add_parser("comment"); s.add_argument("--id", type=int, required=True); s.add_argument("--by", required=True); s.add_argument("--text", required=True); s.set_defaults(func=cmd_comment)

    s = sub.add_parser("block")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--by", required=True)
    s.add_argument("--type", required=True, help="dep_ticket|externo_api|infra|qa|scope|otro")
    s.add_argument("--evidence", required=True)
    s.add_argument("--unblock", required=True)
    s.add_argument("--unblock-owner", required=True)
    s.add_argument("--eta", required=True)
    s.add_argument("--next-action-at", default="")
    s.set_defaults(func=cmd_block)

    s = sub.add_parser("add-collab")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--by", required=True)
    s.add_argument("--collaborators", nargs="+", required=True)
    s.set_defaults(func=cmd_add_collab)

    s = sub.add_parser("resolve"); s.add_argument("--id", type=int, required=True); s.add_argument("--by", required=True); s.add_argument("--resolution", required=True); s.set_defaults(func=cmd_resolve)

    s = sub.add_parser("show"); s.add_argument("--id", type=int, required=True); s.set_defaults(func=cmd_show)
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
