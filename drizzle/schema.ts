import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const reconstructionJobs = mysqlTable("reconstruction_jobs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  originalName: varchar("originalName", { length: 255 }).notNull(),
  inputKey: varchar("inputKey", { length: 512 }).notNull(),
  inputUrl: varchar("inputUrl", { length: 1024 }).notNull(),
  status: mysqlEnum("status", ["queued", "processing", "complete", "partial", "awaiting_gpu", "error"]).default("queued").notNull(),
  progress: int("progress").default(0).notNull(),
  message: text("message"),
  resultGlbUrl: varchar("resultGlbUrl", { length: 1024 }),
  resultObjUrl: varchar("resultObjUrl", { length: 1024 }),
  resultPlyUrl: varchar("resultPlyUrl", { length: 1024 }),
  resultLasUrl: varchar("resultLasUrl", { length: 1024 }),
  reportUrl: varchar("reportUrl", { length: 1024 }),
  points: int("points"),
  vertices: int("vertices"),
  triangles: int("triangles"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type ReconstructionJob = typeof reconstructionJobs.$inferSelect;
export type InsertReconstructionJob = typeof reconstructionJobs.$inferInsert;
