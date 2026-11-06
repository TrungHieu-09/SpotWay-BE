-- Owners buy a plan before a workspace (tenant) is provisioned.
ALTER TYPE "ServicePackage" ADD VALUE IF NOT EXISTS 'STARTER';

CREATE TYPE "OrderKind" AS ENUM ('NEW_WORKSPACE', 'RENEWAL');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'CANCELLED');

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan_expires_at" TIMESTAMP(3);

CREATE TABLE "plan_orders" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT,
  "kind" "OrderKind" NOT NULL,
  "plan" "ServicePackage" NOT NULL,
  "months" INTEGER NOT NULL,
  "amount_vnd" INTEGER NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "workspace_name" TEXT,
  "subdomain" TEXT,
  "payment_ref" TEXT,
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plan_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plan_orders_payment_ref_key" ON "plan_orders"("payment_ref");
CREATE INDEX "plan_orders_user_id_status_idx" ON "plan_orders"("user_id", "status");
CREATE INDEX "plan_orders_tenant_id_status_idx" ON "plan_orders"("tenant_id", "status");

ALTER TABLE "plan_orders" ADD CONSTRAINT "plan_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_orders" ADD CONSTRAINT "plan_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing tenants keep working: give them an expiry one year from this migration.
UPDATE "tenants" SET "plan_expires_at" = CURRENT_TIMESTAMP + INTERVAL '1 year' WHERE "plan_expires_at" IS NULL;
