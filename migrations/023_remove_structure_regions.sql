-- Remove only the retired presentation metadata; graph identities and review data survive.
UPDATE structures
SET graph_json = json_remove(graph_json, '$.presentation.regions')
WHERE json_type(graph_json, '$.presentation') = 'object';

DROP TABLE structure_retired_region_ids;
