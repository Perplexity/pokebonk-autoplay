-- Schema version 2: training runs, their checkpoints, per-episode rewards, evaluations and the model registry.
-- Written by the Python trainer (python/pokebonk_rl/storage.py), which applies these same files; episodes played
-- while training or evaluating go into `batches` / `episodes` / `decisions` like every other episode.

-- One training run = one model being trained, possibly over several sessions (start, resume, resume …).
CREATE TABLE training_runs (
  id                        INTEGER PRIMARY KEY,
  name                      TEXT    NOT NULL UNIQUE,
  created_at                TEXT    NOT NULL,
  algorithm                 TEXT    NOT NULL,
  config_json               TEXT    NOT NULL,
  reward_version            TEXT    NOT NULL,
  reward_json               TEXT    NOT NULL,
  observation_layout_hash   TEXT    NOT NULL,
  action_layout_hash        TEXT    NOT NULL,
  game_build                TEXT    NOT NULL,
  dir                       TEXT    NOT NULL
);

-- One launch of the trainer on a run. Its episodes are the rows of `episodes` with this session's batch_id.
CREATE TABLE training_sessions (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER NOT NULL REFERENCES training_runs(id),
  batch_id         INTEGER NOT NULL REFERENCES batches(id),
  started_at       TEXT    NOT NULL,
  finished_at      TEXT,
  status           TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
  resumed_from     TEXT,
  start_timesteps  INTEGER NOT NULL,
  end_timesteps    INTEGER,
  host_json        TEXT    NOT NULL
);

CREATE TABLE checkpoints (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES training_runs(id),
  session_id  INTEGER NOT NULL REFERENCES training_sessions(id),
  created_at  TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('periodic', 'final', 'interrupt')),
  timesteps   INTEGER NOT NULL,
  episodes    INTEGER NOT NULL,
  path        TEXT    NOT NULL,
  sha256      TEXT    NOT NULL
);
CREATE INDEX checkpoints_by_run ON checkpoints (run_id, timesteps);

-- The reward an episode earned under one reward version, split into its components (sums over the episode, already
-- weighted and scaled; `raw_json` holds the unweighted quantities).
CREATE TABLE episode_rewards (
  episode_id       INTEGER PRIMARY KEY REFERENCES episodes(id),
  reward_version   TEXT    NOT NULL,
  total            REAL    NOT NULL,
  components_json  TEXT    NOT NULL,
  raw_json         TEXT    NOT NULL,
  timesteps        INTEGER
);

-- One evaluation of one model file on a fixed list of seeds. Its episodes are the rows of its batch.
CREATE TABLE evaluations (
  id               INTEGER PRIMARY KEY,
  created_at       TEXT    NOT NULL,
  batch_id         INTEGER NOT NULL REFERENCES batches(id),
  model_path       TEXT    NOT NULL,
  model_sha256     TEXT    NOT NULL,
  run_id           INTEGER REFERENCES training_runs(id),
  timesteps        INTEGER,
  deterministic    INTEGER NOT NULL,
  seeds_json       TEXT    NOT NULL,
  scenario_json    TEXT    NOT NULL,
  summary_json     TEXT    NOT NULL,
  reference        TEXT,
  comparison_json  TEXT,
  passed           INTEGER
);
CREATE INDEX evaluations_by_model ON evaluations (model_sha256);

-- Model files outside a run's checkpoint folder. A stable model is never overwritten or deleted by this code: a
-- promotion adds a row and a folder, the previous stable one becomes 'retired' and stays on disk.
CREATE TABLE models (
  id             INTEGER PRIMARY KEY,
  role           TEXT    NOT NULL CHECK (role IN ('candidate', 'stable', 'retired')),
  created_at     TEXT    NOT NULL,
  path           TEXT    NOT NULL UNIQUE,
  sha256         TEXT    NOT NULL,
  run_id         INTEGER REFERENCES training_runs(id),
  timesteps      INTEGER,
  evaluation_id  INTEGER REFERENCES evaluations(id),
  note           TEXT
);

CREATE TABLE model_events (
  id                  INTEGER PRIMARY KEY,
  at                  TEXT    NOT NULL,
  action              TEXT    NOT NULL CHECK (action IN ('register', 'promote', 'rollback')),
  model_id            INTEGER NOT NULL REFERENCES models(id),
  previous_stable_id  INTEGER REFERENCES models(id),
  evaluation_id       INTEGER REFERENCES evaluations(id),
  note                TEXT
);
