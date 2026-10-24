CREATE TABLE "oauth_codes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "oauth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "oauth_codes_code_hash_key" ON "oauth_codes"("code_hash");
CREATE INDEX "oauth_codes_expires_at_used_at_idx" ON "oauth_codes"("expires_at", "used_at");
