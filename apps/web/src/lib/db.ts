import { PrismaClient } from "@prisma/client";

// Next.js dev-mode hot-reloads modules on every save. Without this guard, a
// fresh PrismaClient (and its connection pool) would be created on every
// reload, quickly exhausting the database's connection limit. Stashing the
// client on `globalThis` survives module reloads in dev while still giving
// each production process a clean singleton.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
