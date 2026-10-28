-- Graph v2 foundation (additive). See docs/REFACTOR_NODE_POI_EXECUTION_PLAN.md, Phase 1.
-- Rollback: drop the objects created below and restore edges_{from,to}_node_id_fkey (edges.from/to_node_id -> nodes.id).
-- Deliberately NOT backfilled: floors.meters_per_pixel and edges.weight_meters stay NULL until the floor is calibrated.

-- 0. Fail early with a readable message if existing edges cross floors (they would break the composite FKs below).
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad
  FROM "edges" e
  LEFT JOIN "nodes" f ON f."id" = e."from_node_id" AND f."floor_id" = e."floor_id"
  LEFT JOIN "nodes" t ON t."id" = e."to_node_id" AND t."floor_id" = e."floor_id"
  WHERE f."id" IS NULL OR t."id" IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION 'graph_v2_foundation: % edge(s) reference a node outside the edge floor; fix or soft-delete them first (SELECT e.id FROM edges e LEFT JOIN nodes f ON f.id=e.from_node_id AND f.floor_id=e.floor_id LEFT JOIN nodes t ON t.id=e.to_node_id AND t.floor_id=e.floor_id WHERE f.id IS NULL OR t.id IS NULL)', bad;
  END IF;
END $$;

-- 1. Enum
CREATE TYPE "ConnectorKind" AS ENUM ('ELEVATOR', 'STAIR', 'ESCALATOR');

-- 2. Columns
ALTER TABLE "floors"
  ADD COLUMN "graph_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "meters_per_pixel" DOUBLE PRECISION,
  ADD CONSTRAINT "floors_meters_per_pixel_positive" CHECK ("meters_per_pixel" IS NULL OR ("meters_per_pixel" > 0 AND "meters_per_pixel" < 'Infinity'::float8));

ALTER TABLE "edges"
  ADD COLUMN "weight_meters" DOUBLE PRECISION,
  ADD CONSTRAINT "edges_weight_meters_non_negative" CHECK ("weight_meters" IS NULL OR ("weight_meters" >= 0 AND "weight_meters" < 'Infinity'::float8));

ALTER TABLE "pois"
  ADD COLUMN "x" DOUBLE PRECISION,
  ADD COLUMN "y" DOUBLE PRECISION,
  ADD COLUMN "snap_distance_meters" DOUBLE PRECISION,
  ADD CONSTRAINT "pois_xy_both_or_neither" CHECK (("x" IS NULL) = ("y" IS NULL)),
  ADD CONSTRAINT "pois_snap_distance_non_negative" CHECK ("snap_distance_meters" IS NULL OR "snap_distance_meters" >= 0);

-- 3. POI own coordinates start at their anchor node's position.
UPDATE "pois" p SET "x" = n."x", "y" = n."y" FROM "nodes" n WHERE n."id" = p."node_id";

-- 4. New tables
CREATE TABLE "connectors" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "building_id" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "name" TEXT NOT NULL,
    "accessible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    CONSTRAINT "connectors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "connector_stops" (
    "id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "floor_id" TEXT NOT NULL,
    "node_id" TEXT NOT NULL,
    CONSTRAINT "connector_stops_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "graph_draft_applications" (
    "id" TEXT NOT NULL,
    "floor_id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "graph_draft_applications_pkey" PRIMARY KEY ("id")
);

-- 5. Indexes
CREATE UNIQUE INDEX "nodes_id_floor_id_key" ON "nodes"("id", "floor_id");
CREATE INDEX "nodes_floor_id_type_idx" ON "nodes"("floor_id", "type");
CREATE INDEX "edges_from_node_id_idx" ON "edges"("from_node_id");
CREATE INDEX "edges_to_node_id_idx" ON "edges"("to_node_id");
CREATE INDEX "pois_node_id_idx" ON "pois"("node_id");
CREATE INDEX "stores_node_id_idx" ON "stores"("node_id");
CREATE INDEX "qr_anchors_node_id_idx" ON "qr_anchors"("node_id");
CREATE INDEX "connectors_building_id_deleted_at_idx" ON "connectors"("building_id", "deleted_at");
CREATE INDEX "connectors_tenant_id_deleted_at_idx" ON "connectors"("tenant_id", "deleted_at");
CREATE INDEX "connector_stops_floor_id_idx" ON "connector_stops"("floor_id");
CREATE UNIQUE INDEX "connector_stops_node_id_key" ON "connector_stops"("node_id");
CREATE UNIQUE INDEX "connector_stops_connector_id_floor_id_key" ON "connector_stops"("connector_id", "floor_id");
CREATE UNIQUE INDEX "connector_stops_node_id_floor_id_key" ON "connector_stops"("node_id", "floor_id");
CREATE UNIQUE INDEX "graph_draft_applications_floor_id_draft_id_key" ON "graph_draft_applications"("floor_id", "draft_id");

-- 6. Foreign keys: edges can only join nodes of their own floor.
ALTER TABLE "edges" DROP CONSTRAINT "edges_from_node_id_fkey";
ALTER TABLE "edges" DROP CONSTRAINT "edges_to_node_id_fkey";
ALTER TABLE "edges" ADD CONSTRAINT "edges_from_node_id_floor_id_fkey" FOREIGN KEY ("from_node_id", "floor_id") REFERENCES "nodes"("id", "floor_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "edges" ADD CONSTRAINT "edges_to_node_id_floor_id_fkey" FOREIGN KEY ("to_node_id", "floor_id") REFERENCES "nodes"("id", "floor_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "connector_stops" ADD CONSTRAINT "connector_stops_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "connector_stops" ADD CONSTRAINT "connector_stops_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "connector_stops" ADD CONSTRAINT "connector_stops_node_id_floor_id_fkey" FOREIGN KEY ("node_id", "floor_id") REFERENCES "nodes"("id", "floor_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "graph_draft_applications" ADD CONSTRAINT "graph_draft_applications_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
