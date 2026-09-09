-- Roles: the user/system boundary, enforced by the database.
--
-- This file is the entire reason the Postgres migration is worth doing. In the
-- SQLite design canon and story rows shared one table, so "the play path must
-- never corrupt canon" could only ever be a convention — a thing reviewers
-- checked for and `SetupService.reset()` got wrong twice (it silently omitted
-- `illustrations`, then `stories`, from its hand-maintained delete list, and
-- both omissions were found by the integrity checker rather than by reading).
--
-- Here it is a privilege. `fabulist_play` — the role every request that serves
-- a turn connects as — holds SELECT on canon and no write grant at all. A bug
-- that tries to UPDATE a canon row does not corrupt 33,332 ingested entities;
-- it raises `permission denied for table canon_entities` and fails the request.
--
-- Two roles, matching the two kinds of data:
--
--   fabulist_play    reads canon, writes stories.  The web/MCP request path.
--   fabulist_ingest  writes canon.                 Ingest, refresh, repair.
--
-- Deliberately NOT three: there is no separate "admin" database role, because
-- admin-ness is about *which people* may trigger an ingest (AuthConfig.adminEmails,
-- src/auth/config.ts) rather than about what SQL is legal. Adding a third role
-- would imply the database could answer a question only WorkOS can.
--
-- ## Why every statement here is dynamic
--
-- The grants apply to `current_schema()`, not to a hardcoded `public`. That is
-- not generality for its own sake: the test harness gives every test its own
-- schema (Postgres has no `:memory:`, see test/pg-harness.ts), and
-- `GRANT ... ON ALL TABLES IN SCHEMA public` silently grants nothing there —
-- it is evaluated once, against one named schema, for the tables that exist at
-- that moment. Caught by a test asserting the play role can still *read* canon,
-- which failed with `has_table_privilege(...) = false` in a fresh schema.
--
-- The same property matters in production for a different reason: `ALL TABLES`
-- is a snapshot, so a table added by a later migration gets no grant and the
-- play path breaks on it at runtime, on a write, with a permission error. The
-- DEFAULT PRIVILEGES block at the bottom is what covers that case.
--
-- Run after schema-pg.sql, with the target schema first on `search_path`.
-- Idempotent: re-running is harmless, so it can go in a deploy script.

-- ---------------------------------------------------------------- the roles
-- NOLOGIN group roles. The actual login user (whatever the connection string
-- names) is GRANTed these, so credentials stay a deployment concern and this
-- file stays about capability. Passwords never appear here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabulist_play') THEN
    CREATE ROLE fabulist_play NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabulist_ingest') THEN
    CREATE ROLE fabulist_ingest NOLOGIN;
  END IF;
END
$$;

DO $$
DECLARE
  sch TEXT := current_schema();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO fabulist_play, fabulist_ingest', sch);

  -- Read is broad. Canon is not secret from the play path — it is the source
  -- material every turn is built from; the point is that it is read-*only*
  -- there. Per-user isolation of story data is enforced by `owner_user_id` in
  -- the application (CurrentStory.worldFor), not by these grants, because one
  -- connection pool serves every user.
  EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO fabulist_play, fabulist_ingest', sch);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO fabulist_play, fabulist_ingest', sch);
END
$$;

-- Write grants are issued per table, schema-qualified, because a table list and
-- a schema-wide grant are different statements — `GRANT ... ON <list> IN SCHEMA`
-- is not valid syntax.
--
-- fabulist_play gets the user tables only. Note what is absent —
-- canon_entities, canon_edges, canon_sheets, worlds, world_sources,
-- world_meta, ingest_pages. That absence is the safety property. `worlds` being
-- readable but not writable is why creating a world is an ingest operation: a
-- world is system data even when it is empty.
DO $$
DECLARE
  sch TEXT := current_schema();
  t   TEXT;
  user_tables TEXT[] := ARRAY[
    'stories', 'story_sources', 'story_id_aliases', 'chron_entities', 'chron_edges',
    'chron_sheets', 'relationships', 'facts', 'fact_knowledge', 'threads', 'events',
    'consequences', 'turns', 'scenes', 'chapters', 'directives', 'divergences',
    'style_anchors', 'prose_blocklist', 'illustrations'];
  system_tables TEXT[] := ARRAY[
    'worlds', 'world_sources', 'world_meta', 'canon_entities', 'canon_edges',
    'canon_sheets', 'ingest_pages', 'migrations', 'sqlite_import_log'];
BEGIN
  FOREACH t IN ARRAY user_tables LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON %I.%I TO fabulist_play', sch, t);
    -- The importer legitimately writes both halves: it is moving existing user
    -- stories into Postgres, not playing them. Granted explicitly and narrowly
    -- rather than by making the importer a superuser.
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON %I.%I TO fabulist_ingest', sch, t);
  END LOOP;

  FOREACH t IN ARRAY system_tables LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON %I.%I TO fabulist_ingest', sch, t);
  END LOOP;
END
$$;

-- ------------------------------------------------------------------ defaults
-- Tables created later (a new migration) inherit these grants automatically.
-- Without this, every future schema addition needs a matching grant statement
-- or the play path breaks on it at runtime — a failure that only surfaces on a
-- write, in production.
--
-- ALTER DEFAULT PRIVILEGES applies to objects created by a specific role, so
-- this is scoped to whoever runs migrations (`current_user` at this moment).
-- Read-only by default: a new table becomes readable automatically, but its
-- write grant is a deliberate decision about whether it is user or system data,
-- and defaulting that would quietly erode the boundary this file exists to draw.

DO $$
DECLARE
  sch     TEXT := current_schema();
  creator TEXT := current_user;
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT ON TABLES TO fabulist_play, fabulist_ingest',
    creator, sch);
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO fabulist_play, fabulist_ingest',
    creator, sch);
END
$$;
