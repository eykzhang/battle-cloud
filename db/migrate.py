"""Forward-only migration runner.

Deliberately small. It applies numbered `.up.sql` files in order inside one transaction
each, and records what it applied. It owns `schema_migrations` itself rather than having
a migration create it, so the bookkeeping table cannot be dropped by its own `down`.

    python db/migrate.py up      --database-url postgres://...
    python db/migrate.py down    --database-url postgres://...   # reverses the last one
    python db/migrate.py status  --database-url postgres://...
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List, Tuple

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

BOOTSTRAP = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text        PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
)
"""


def discover() -> List[Tuple[str, Path, Path]]:
    """Every migration, as (version, up, down), ordered by version."""
    found = []
    for up in sorted(MIGRATIONS_DIR.glob("*.up.sql")):
        version = up.name[: -len(".up.sql")]
        down = up.with_name(f"{version}.down.sql")
        if not down.exists():
            raise SystemExit(f"migration {version} has no .down.sql; every up needs a reverse")
        found.append((version, up, down))
    return found


def applied(conn: psycopg.Connection) -> List[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations ORDER BY version")
        return [row[0] for row in cur.fetchall()]


def up(conn: psycopg.Connection) -> int:
    done = set(applied(conn))
    count = 0
    for version, up_path, _ in discover():
        if version in done:
            continue
        # One transaction per migration: a failure leaves the database on the last
        # complete version rather than halfway through a broken one.
        with conn.transaction():
            conn.execute(up_path.read_text())
            conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (version,))
        print(f"applied {version}")
        count += 1
    return count


def down(conn: psycopg.Connection) -> int:
    done = applied(conn)
    if not done:
        print("nothing to reverse")
        return 0
    version = done[-1]
    _, _, down_path = next(m for m in discover() if m[0] == version)
    with conn.transaction():
        conn.execute(down_path.read_text())
        conn.execute("DELETE FROM schema_migrations WHERE version = %s", (version,))
    print(f"reversed {version}")
    return 1


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("up", "down", "status"))
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""))
    args = parser.parse_args(argv)

    if not args.database_url:
        print("error: --database-url or DATABASE_URL is required", file=sys.stderr)
        return 1

    with psycopg.connect(args.database_url, autocommit=True) as conn:
        conn.execute(BOOTSTRAP)
        if args.command == "up":
            print(f"{up(conn)} migration(s) applied")
        elif args.command == "down":
            down(conn)
        else:
            done = set(applied(conn))
            for version, _, _ in discover():
                print(f"{'applied' if version in done else 'pending'}  {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
