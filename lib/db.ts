// Shared Prisma client (Neon / Postgres = app system of record).
// Import this everywhere; never instantiate PrismaClient ad hoc.
// Prisma 7 requires a driver adapter; we use @prisma/adapter-pg (node-postgres)
// over the pooled DATABASE_URL. Chosen over adapter-neon because the app runs on
// Vercel Fluid Compute (regular Node.js) — pg works identically local and in prod
// with no WebSocket dependency. Singleton avoids exhausting connections on
// hot-reload.
//
// The pool is built here rather than inside the adapter so its "connect" event can be
// counted (lib/db-connections.ts); its settings are pg's defaults, as before.
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { countConnectionOpened } from "@/lib/db-connections";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("connect", countConnectionOpened);
  // disposeExternalPool: $disconnect() still ends the pool, as when the adapter owned it.
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
