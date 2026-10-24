-- Prisma migration history is infrastructure metadata, never application data.
-- Direct Prisma connections run as the table owner; browser/Data API roles must not read it.
ALTER TABLE "public"."_prisma_migrations" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."_prisma_migrations" FROM anon, authenticated, service_role;
