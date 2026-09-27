import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { createReconstructionJob, getReconstructionJob, listReconstructionJobs, updateReconstructionJob } from "./db";
import { storagePut } from "./storage";
import { TRPCError } from "@trpc/server";
import { detectPipelineCapabilities } from "./reconstruction/pipeline";
import { launchReconstructionWorker } from "./reconstruction/pipeline";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const uploadInput = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.enum(["video/mp4", "video/webm", "video/quicktime", "image/jpeg", "image/png", "image/webp"]),
  base64: z.string().min(100).max(180_000_000),
  complete360: z.boolean().default(true),
});

export const appRouter = router({
  system: systemRouter,
  pipeline: router({
    capabilities: publicProcedure.query(() => detectPipelineCapabilities()),
  }),
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  reconstruction: router({
    list: protectedProcedure.query(({ ctx }) => listReconstructionJobs(ctx.user.id)),
    status: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }: { ctx: any; input: { id: number } }) => {
      const job = await getReconstructionJob(input.id, ctx.user.id);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Reconstruction job not found" });
      if (process.env.NODE_ENV !== "production" && process.env.LOCAL_GUEST_MODE !== "false") {
        try {
          const raw = await readFile(path.resolve(process.cwd(), ".aerotrace", "jobs", String(input.id), "stage.json"), "utf8");
          return { job, stage: JSON.parse(raw) as { stage: string; status: string; message: string } };
        } catch { return { job, stage: null }; }
      }
      return { job, stage: null };
    }),
    get: protectedProcedure.input(z.object({ id: z.number().int().positive() })).query(async ({ ctx, input }: { ctx: any; input: { id: number } }) => {
      const job = await getReconstructionJob(input.id, ctx.user.id);
      if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Reconstruction job not found" });
      return job;
    }),
    upload: protectedProcedure.input(uploadInput).mutation(async ({ ctx, input }: { ctx: any; input: z.infer<typeof uploadInput> }) => {
      const data = Buffer.from(input.base64, "base64");
      const stored = await storagePut(`${ctx.user.id}/reconstruction-inputs/${input.filename}`, data, input.mimeType);
      const job = await createReconstructionJob({
        userId: ctx.user.id,
        originalName: input.filename,
        inputKey: stored.key,
        inputUrl: stored.url,
        status: "awaiting_gpu",
        progress: 8,
        message: input.complete360 ? "Upload received. Native segmentation, COLMAP, dense MVS, Poisson, and 360° completion were requested; waiting for the connected reconstruction worker." : "Upload received in observed-only mode. Native segmentation, COLMAP, dense MVS, and Poisson require a connected reconstruction worker.",
      });
      if (!job) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database is not available" });
      if (process.env.NODE_ENV !== "production" && process.env.LOCAL_GUEST_MODE !== "false") {
        const jobRoot = path.resolve(process.cwd(), ".aerotrace", "jobs", String(job.id));
        const sourcePath = path.join(jobRoot, input.filename);
        await mkdir(jobRoot, { recursive: true });
        await writeFile(sourcePath, data);
        await updateReconstructionJob(job.id, ctx.user.id, { status: "processing", progress: 12, message: "Native worker launched. Follow .aerotrace/jobs/<id>/stage.json and pipeline.log." });
        await launchReconstructionWorker({ sourcePath, outputDir: jobRoot, jobId: job.id });
      }
      return job;
    }),
  }),
});

export type AppRouter = typeof appRouter;
