import { Router } from "express";
import { z } from "zod";
import { requireAdmin } from "../auth/middleware.js";
import { collectVacancies } from "../jobs/collection.service.js";
import { enrichJob } from "../jobs/ingest.service.js";
import { countJobsBySource, getJob, listJobs } from "../jobs/job.repository.js";
import { sourceIds } from "../jobs/sources/index.js";

const router = Router();

const ListQuery = z.object({
    source: z.enum(sourceIds as [string, ...string[]]).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    hasEmail: z.enum(["true", "false"]).optional(),
    openOnly: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

router.get("/", async (req, res) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return res.status(400).json({ success: false, message: z.prettifyError(query.error) });

    const { hasEmail, openOnly, source, ...rest } = query.data;
    const jobs = await listJobs({
        ...rest,
        ...(source && { source: source as (typeof sourceIds)[number] }),
        hasEmail: hasEmail === "true",
        openOnly: openOnly === "true",
    });

    res.json({ success: true, data: jobs, counts: await countJobsBySource() });
});

router.get("/:id", async (req, res, next) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: "Invalid job id" });

        // Detail pages are fetched lazily, the first time a vacancy is opened
        const job = (await enrichJob(id)) ?? (await getJob(id));
        if (!job) return res.status(404).json({ success: false, message: "Job not found" });

        res.json({ success: true, data: job });
    } catch (error) {
        next(error);
    }
});

// Fetches from every job site, which is heavy and hits third-party servers: administrators only
router.post("/ingest", requireAdmin, async (_req, res, next) => {
    try {
        res.json({ success: true, data: await collectVacancies() });
    } catch (error) {
        next(error);
    }
});

export default router;
