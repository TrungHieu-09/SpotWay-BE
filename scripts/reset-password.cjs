/**
 * Dev helper: set a new password for an existing account.
 *
 *   npm run reset-password -- <email> <newPassword>
 *
 * The password is stored as a bcrypt hash (same cost as the app) and all existing
 * refresh sessions of that user are revoked.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

async function main() {
  const [emailArg, newPassword] = process.argv.slice(2);
  if (!emailArg || !newPassword) {
    console.error('Usage: npm run reset-password -- <email> <newPassword>');
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const email = emailArg.trim().toLowerCase();
    const user = await prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (!user) {
      console.error(`No active account found for ${email}`);
      process.exit(1);
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(newPassword, 12) },
    });
    const revoked = await prisma.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    console.log(`Password updated for ${email}. Revoked ${revoked.count} active session(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

