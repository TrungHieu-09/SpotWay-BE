-- Registration passwords used to be kept in plain text in email_otps until the OTP was verified.
-- New OTP rows store a bcrypt hash and are cleared on use. Remove the plain passwords that are no longer needed:
-- every used or expired row. Rows that are still pending keep working (the service hashes legacy plain values on verify).
-- The table is guarded because some databases were created without a migration for it.
DO $$
BEGIN
  IF to_regclass('public.email_otps') IS NOT NULL THEN
    UPDATE "email_otps"
    SET "password" = NULL
    WHERE "password" IS NOT NULL
      AND ("used_at" IS NOT NULL OR "expires_at" < CURRENT_TIMESTAMP);
  END IF;
END $$;
