ALTER TABLE "edges" ADD COLUMN "node_low_id" TEXT;
ALTER TABLE "edges" ADD COLUMN "node_high_id" TEXT;
UPDATE "edges"
SET "node_low_id" = LEAST("from_node_id", "to_node_id"),
    "node_high_id" = GREATEST("from_node_id", "to_node_id");
ALTER TABLE "edges" ALTER COLUMN "node_low_id" SET NOT NULL;
ALTER TABLE "edges" ALTER COLUMN "node_high_id" SET NOT NULL;
CREATE INDEX "edges_floor_id_node_low_id_node_high_id_idx"
  ON "edges"("floor_id", "node_low_id", "node_high_id");
CREATE UNIQUE INDEX "edges_active_undirected_pair_key"
  ON "edges"("floor_id", "node_low_id", "node_high_id")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "elevator_links" ADD COLUMN "node_low_id" TEXT;
ALTER TABLE "elevator_links" ADD COLUMN "node_high_id" TEXT;
ALTER TABLE "elevator_links" ADD COLUMN "deleted_at" TIMESTAMP(3);
UPDATE "elevator_links"
SET "node_low_id" = LEAST("node_id_from", "node_id_to"),
    "node_high_id" = GREATEST("node_id_from", "node_id_to");
ALTER TABLE "elevator_links" ALTER COLUMN "node_low_id" SET NOT NULL;
ALTER TABLE "elevator_links" ALTER COLUMN "node_high_id" SET NOT NULL;
CREATE INDEX "elevator_links_building_id_node_low_id_node_high_id_idx"
  ON "elevator_links"("building_id", "node_low_id", "node_high_id");
CREATE UNIQUE INDEX "elevator_links_active_undirected_pair_key"
  ON "elevator_links"("building_id", "node_low_id", "node_high_id")
  WHERE "deleted_at" IS NULL;
