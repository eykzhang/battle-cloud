# Database

Postgres. Three tables and a queue, with the queue living in the `jobs` table rather than
in a broker (see `notes/decision-postgres-skip-locked-over-redis.md`).

## Status

Applied and tested against Postgres 16.15 on 2026-09-06. `db/tests/` has 31 tests covering
the schema constraints and every queue transition, including a two-connection test that
proves `SKIP LOCKED` hands concurrent claimers different rows. That last one cannot be
verified by reading SQL, which is why it is executed rather than reviewed.

## Running

```
createdb battlecloud
DATABASE_URL=postgres:///battlecloud python db/migrate.py up
DATABASE_URL=postgres:///battlecloud python db/migrate.py status
DATABASE_URL=postgres:///battlecloud python -m pytest db/tests -q
```

`migrate.py` owns `schema_migrations` itself rather than having a migration create it, so
the bookkeeping table cannot be dropped by its own `down`.

## Layout

- `migrations/` — numbered, each with a matching `.down.sql`. A test asserts the pairing.
- `queries/` — the queue's statements, one per file, all using bound parameters. A test
  asserts no file interpolates a value, since replay ids and perspectives arrive from
  untrusted submissions.

## The two constraints worth knowing about

`analyses_identity_key` covers eight columns, `seed` included. Schema v1 does not carry
the seed, so without that column two analyses of one replay at different seeds would
collide and one would be lost.

`jobs_active_identity_key` is a **partial** unique index over the same eight columns,
`WHERE status IN ('queued','running')`. It is what makes submission idempotent: a resubmit
while a job is live conflicts and `enqueue_job.sql` turns the conflict into the existing
job's id rather than a second core-minute of identical search. Partial so a finished job
does not block asking the same question again later.
