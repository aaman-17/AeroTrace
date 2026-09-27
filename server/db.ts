import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, ReconstructionJob, reconstructionJobs, User, users } from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;
let localJobId = 1;
const localJobs: ReconstructionJob[] = [];

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); }
    catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  if (user.lastSignedIn !== undefined) { values.lastSignedIn = user.lastSignedIn; updateSet.lastSignedIn = user.lastSignedIn; }
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  values.lastSignedIn ??= new Date();
  updateSet.lastSignedIn ??= new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string): Promise<User | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function createReconstructionJob(input: typeof reconstructionJobs.$inferInsert): Promise<ReconstructionJob | undefined> {
  const db = await getDb();
  if (!db && ENV.localGuestMode) {
    const now = new Date();
    const job = { ...input, id: localJobId++, createdAt: now, updatedAt: now } as ReconstructionJob;
    localJobs.unshift(job);
    return job;
  }
  if (!db) return undefined;
  const result = await db.insert(reconstructionJobs).values(input);
  const id = Number(result[0].insertId);
  const created = await db.select().from(reconstructionJobs).where(eq(reconstructionJobs.id, id)).limit(1);
  return created[0];
}

export async function updateReconstructionJob(id: number, userId: number, update: Partial<Pick<ReconstructionJob, "status" | "progress" | "message">>) {
  const db = await getDb();
  if (!db && ENV.localGuestMode) {
    const job = localJobs.find((item) => item.id === id && item.userId === userId);
    if (!job) return undefined;
    Object.assign(job, update, { updatedAt: new Date() });
    return job;
  }
  if (!db) return undefined;
  await db.update(reconstructionJobs).set(update).where(eq(reconstructionJobs.id, id));
  return getReconstructionJob(id, userId);
}

export async function getReconstructionJob(id: number, userId: number): Promise<ReconstructionJob | undefined> {
  const db = await getDb();
  if (!db && ENV.localGuestMode) return localJobs.find((job) => job.id === id && job.userId === userId);
  if (!db) return undefined;
  const result = await db.select().from(reconstructionJobs).where(eq(reconstructionJobs.id, id)).limit(1);
  return result[0]?.userId === userId ? result[0] : undefined;
}

export async function listReconstructionJobs(userId: number): Promise<ReconstructionJob[]> {
  const db = await getDb();
  if (!db && ENV.localGuestMode) return localJobs.filter((job) => job.userId === userId);
  if (!db) return [];
  return db.select().from(reconstructionJobs).where(eq(reconstructionJobs.userId, userId)).orderBy(desc(reconstructionJobs.createdAt));
}
