CREATE TYPE "PromotionStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "buildings" ADD COLUMN "default_floor_height" DOUBLE PRECISION NOT NULL DEFAULT 4;
ALTER TABLE "floors" ADD COLUMN "elevation" DOUBLE PRECISION;

CREATE TABLE "promotions" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "start_at" TIMESTAMP(3) NOT NULL,
  "end_at" TIMESTAMP(3) NOT NULL,
  "status" "PromotionStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "promotions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promotions_end_after_start" CHECK ("end_at" > "start_at"),
  CONSTRAINT "promotions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "promotions_tenant_id_deleted_at_idx" ON "promotions"("tenant_id", "deleted_at");
CREATE INDEX "promotions_store_id_deleted_at_start_at_end_at_idx" ON "promotions"("store_id", "deleted_at", "start_at", "end_at");

CREATE TABLE "qr_anchors" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "building_id" TEXT NOT NULL,
  "floor_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  CONSTRAINT "qr_anchors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qr_anchors_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "qr_anchors_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qr_anchors_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qr_anchors_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "qr_anchors_building_id_node_id_deleted_at_idx" ON "qr_anchors"("building_id", "node_id", "deleted_at");
CREATE INDEX "qr_anchors_tenant_id_deleted_at_idx" ON "qr_anchors"("tenant_id", "deleted_at");

CREATE TABLE "outbox_events" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "outbox_events_processed_at_created_at_idx" ON "outbox_events"("processed_at", "created_at");

CREATE TABLE "floor_map_revisions" (
  "id" TEXT NOT NULL,
  "floor_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "editor_state" JSONB NOT NULL,
  "created_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  CONSTRAINT "floor_map_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "floor_map_revisions_floor_id_version_key" UNIQUE ("floor_id", "version"),
  CONSTRAINT "floor_map_revisions_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "floor_map_revisions_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "buildings_tenant_status_active_idx" ON "buildings"("tenant_id", "status") WHERE "deleted_at" IS NULL;
CREATE INDEX "floors_building_publish_active_idx" ON "floors"("building_id", "publish_status") WHERE "deleted_at" IS NULL;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "stores_name_trgm_idx" ON "stores" USING GIN ("name" gin_trgm_ops) WHERE "deleted_at" IS NULL;
CREATE INDEX "pois_name_trgm_idx" ON "pois" USING GIN ("name" gin_trgm_ops) WHERE "deleted_at" IS NULL;
