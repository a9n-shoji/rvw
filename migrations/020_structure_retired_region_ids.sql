CREATE TABLE structure_retired_region_ids (
  structure_id TEXT NOT NULL REFERENCES structures(id) ON DELETE CASCADE,
  region_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY(structure_id, region_id)
);
