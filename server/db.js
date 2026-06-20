// Mega Mindikot 5v5 — database access.
// A lazily-instantiated singleton PrismaClient so the whole server shares one
// connection pool. Postgres is the one intentional runtime dependency.
//
// If DATABASE_URL is unset, prisma stays null and authConfigured() returns false,
// so the server boots and the game plays anonymously exactly as before.

import { PrismaClient } from "@prisma/client";

let prisma = null;

/** @returns {PrismaClient | null} the shared client, or null if DB isn't configured. */
export function getDb() {
  if (prisma) return prisma;
  if (!process.env.DATABASE_URL) return null;
  prisma = new PrismaClient();
  return prisma;
}

/** Call on shutdown to close the connection pool cleanly. */
export async function closeDb() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}
