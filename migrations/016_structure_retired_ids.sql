CREATE TABLE structure_retired_node_ids (
  structure_id TEXT NOT NULL REFERENCES structures(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY(structure_id, node_id)
);

CREATE TABLE structure_retired_edge_ids (
  structure_id TEXT NOT NULL REFERENCES structures(id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  retired_at TEXT NOT NULL,
  PRIMARY KEY(structure_id, edge_id)
);
