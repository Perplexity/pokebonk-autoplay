-- Schema version 1: batches of episodes, per-episode summaries, every build / strategy decision, errors.
-- Conventions (docs/storage.md): times are ISO 8601 UTC text, booleans are 0 / 1, *_json columns hold JSON text,
-- game times are seconds of the run clock, wall times are seconds of real time.

CREATE TABLE batches (
  id                  INTEGER PRIMARY KEY,
  started_at          TEXT    NOT NULL,
  finished_at         TEXT,
  status              TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  label               TEXT,
  policy_name         TEXT    NOT NULL,
  policy_version      TEXT    NOT NULL,
  config_json         TEXT    NOT NULL,
  game_build          TEXT,
  game_version        TEXT,
  bundle_sha256       TEXT,
  shim_hash           TEXT,
  observation_schema  INTEGER,
  action_schema       INTEGER,
  decision_schema     INTEGER,
  snapshot_schema     INTEGER,
  profile_preset      TEXT,
  ranked              INTEGER,
  hz                  INTEGER NOT NULL,
  action_repeat       INTEGER NOT NULL,
  reward_version      TEXT,
  host_json           TEXT    NOT NULL,
  metadata_json       TEXT,
  episodes_planned    INTEGER NOT NULL,
  episodes_done       INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  wall_seconds        REAL
);

CREATE TABLE episodes (
  id                    INTEGER PRIMARY KEY,
  batch_id              INTEGER NOT NULL REFERENCES batches(id),
  seed                  INTEGER NOT NULL,
  species               INTEGER NOT NULL,
  final_species         INTEGER NOT NULL,
  map                   TEXT    NOT NULL,
  tier                  INTEGER NOT NULL,
  ranked                INTEGER NOT NULL,
  end_cause             TEXT    NOT NULL,
  end_how               TEXT,
  terminated            INTEGER NOT NULL,
  truncated             INTEGER NOT NULL,
  victory               INTEGER NOT NULL,
  game_time             REAL    NOT NULL,
  kills                 INTEGER NOT NULL,
  overtime_started      INTEGER NOT NULL,
  overtime_bonus        INTEGER NOT NULL,
  overtime_rounds       INTEGER NOT NULL,
  overtime_cashed       INTEGER NOT NULL,
  level                 INTEGER NOT NULL,
  zone                  INTEGER NOT NULL,
  guardians_defeated    INTEGER NOT NULL,
  legendaries_defeated  INTEGER NOT NULL,
  seals_kept            INTEGER NOT NULL,
  steps                 INTEGER NOT NULL,
  sim_steps             INTEGER NOT NULL,
  decision_count        INTEGER NOT NULL,
  wall_seconds          REAL    NOT NULL,
  reset_seconds         REAL    NOT NULL,
  final_build_json      TEXT    NOT NULL,
  counters_json         TEXT    NOT NULL,
  record_json           TEXT,
  blocked_network       INTEGER NOT NULL,
  blocked_network_json  TEXT,
  worker_id             INTEGER NOT NULL,
  worker_pid            INTEGER NOT NULL,
  worker_episode        INTEGER NOT NULL,
  worker_rss_mb         INTEGER NOT NULL,
  started_at            TEXT    NOT NULL,
  finished_at           TEXT    NOT NULL,
  UNIQUE (batch_id, seed)
);
CREATE INDEX episodes_by_batch ON episodes (batch_id);
CREATE INDEX episodes_by_setup ON episodes (species, map, tier, seed);

CREATE TABLE decisions (
  id            INTEGER PRIMARY KEY,
  episode_id    INTEGER NOT NULL REFERENCES episodes(id),
  serial        INTEGER NOT NULL,
  step          INTEGER NOT NULL,
  game_time     REAL    NOT NULL,
  zone          INTEGER NOT NULL,
  level         INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  method        TEXT    NOT NULL,
  options_json  TEXT    NOT NULL,
  context_json  TEXT    NOT NULL,
  mask_json     TEXT    NOT NULL,
  chosen_json   TEXT    NOT NULL,
  chosen_id     TEXT    NOT NULL,
  UNIQUE (episode_id, serial)
);
CREATE INDEX decisions_by_kind ON decisions (kind);

CREATE TABLE errors (
  id            INTEGER PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  episode_id    INTEGER REFERENCES episodes(id),
  seed          INTEGER,
  worker_id     INTEGER,
  kind          TEXT    NOT NULL,
  occurred_at   TEXT    NOT NULL,
  message       TEXT    NOT NULL,
  details_json  TEXT    NOT NULL
);
CREATE INDEX errors_by_batch ON errors (batch_id);
