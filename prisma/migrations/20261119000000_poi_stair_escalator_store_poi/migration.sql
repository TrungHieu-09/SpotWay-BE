-- POI thang bộ / thang cuốn, và liên kết gian hàng với POI để tự đồng bộ tên khi publish.
ALTER TYPE "PoiCategory" ADD VALUE IF NOT EXISTS 'STAIR';
ALTER TYPE "PoiCategory" ADD VALUE IF NOT EXISTS 'ESCALATOR';

ALTER TABLE "stores" ADD COLUMN "poi_id" TEXT;
CREATE UNIQUE INDEX "stores_poi_id_key" ON "stores"("poi_id");
ALTER TABLE "stores" ADD CONSTRAINT "stores_poi_id_fkey" FOREIGN KEY ("poi_id") REFERENCES "pois"("id") ON DELETE SET NULL ON UPDATE CASCADE;
