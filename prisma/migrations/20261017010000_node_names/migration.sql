ALTER TABLE "nodes" ADD COLUMN IF NOT EXISTS "name" TEXT;
CREATE INDEX IF NOT EXISTS "nodes_floor_id_name_idx" ON "nodes"("floor_id", "name");
