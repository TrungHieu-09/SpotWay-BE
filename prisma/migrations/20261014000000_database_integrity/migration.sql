-- Preserve floor-number reuse after a floor has been soft-deleted.
ALTER TABLE "floors" DROP CONSTRAINT "floors_building_id_floor_number_key";

CREATE UNIQUE INDEX "floors_active_building_floor_number_key"
  ON "floors" ("building_id", "floor_number")
  WHERE "deleted_at" IS NULL;

-- A Store Owner can manage only one active store in the MVP.
CREATE UNIQUE INDEX "stores_active_owner_id_key"
  ON "stores" ("owner_id")
  WHERE "owner_id" IS NOT NULL AND "deleted_at" IS NULL;

-- Graph endpoints must refer to real nodes. Restrict physical deletion because
-- application-level deletion is soft and preserves graph history.
ALTER TABLE "edges"
  ADD CONSTRAINT "edges_from_node_id_fkey"
  FOREIGN KEY ("from_node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "edges_to_node_id_fkey"
  FOREIGN KEY ("to_node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "elevator_links"
  ADD CONSTRAINT "elevator_links_node_id_from_fkey"
  FOREIGN KEY ("node_id_from") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "elevator_links_node_id_to_fkey"
  FOREIGN KEY ("node_id_to") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
