import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import * as admin from "../admin/admin.repository.js";
import { enrichmentStatus, startEnrichment, systemInfo } from "../admin/admin.operations.js";
import { normalizeEmail, requestPasswordReset } from "../auth/auth.service.js";
import { currentUser } from "../auth/middleware.js";
import { assertAcceptablePassword, hashPassword } from "../auth/password.js";
import * as users from "../auth/user.repository.js";
import { deleteCandidate, getCandidate, getCandidateFile, setCandidateOwner, updateCandidateProfile } from "../candidates/candidate.repository.js";
import { BadRequestError, NotFoundError, RuleError } from "../errors.js";
import { collectVacancies, collectionStatus } from "../jobs/collection.service.js";
import { enrichJob } from "../jobs/ingest.service.js";
import { sourceIds } from "../jobs/sources/index.js";
import type { JobSourceId } from "../jobs/types.js";
import * as applications from "../mail/application.repository.js";
import { retryApplication } from "../mail/application.service.js";
import { deleteMailAccount, getMailAccount } from "../mail/mail-account.repository.js";
import { getMatch, setStatus } from "../matching/match.repository.js";
import { editCoverLetter } from "../matching/match.service.js";
import { getRun, startRun } from "../matching/run-tracker.js";
import { ResumeSchema } from "../schemas/resume.schema.js";

// The administrators' console. app.ts mounts this behind requireAuth, requireVerified and requireAdmin, so every
// handler here may assume an administrator. These routes work across accounts, which the ordinary routes
// deliberately never do. Every change is written to the audit trail.
//
// Not offered here, on purpose: approving a cover letter, confirming an address read from a picture, and queueing
// an application. Those are the applicant's own consent before anything leaves their mailbox in their name.
const router = Router();

// ---- helpers ---------------------------------------------------------------------------

const ok = <T>(data: T) => ({ success: true, data });

function idOf(req: Request, name = "id"): number {
    const parsed = z.coerce.number().int().positive().safeParse(req.params[name]);
    if (!parsed.success) throw new BadRequestError("Invalid id");
    return parsed.data;
}

const bool = z.enum(["true", "false"]).transform((value) => value === "true");
const Paging = {
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
};
const Search = z.string().trim().min(1).max(100).optional();
const SourceId = z.enum(sourceIds as [JobSourceId, ...JobSourceId[]]);

/** Records what an administrator did. A failure to write the record is logged but never undoes the action. */
async function audit(req: Request, action: string, target?: { type: string; id: string | number }, summary?: string): Promise<void> {
    const actor = currentUser(req);

    try {
        await admin.writeAudit({
            adminId: actor.id,
            adminEmail: actor.email,
            action,
            targetType: target?.type ?? null,
            targetId: target ? String(target.id) : null,
            summary: summary ?? null,
            ip: req.ip ?? null,
        });
    } catch (error) {
        console.error("Could not write the admin audit trail:", error instanceof Error ? error.message : error);
    }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// ---- overview and system ---------------------------------------------------------------

router.get("/overview", async (_req, res) => {
    res.json(ok(await admin.getOverview(30)));
});

router.get("/system", async (_req, res) => {
    res.json(ok(await systemInfo()));
});

router.get("/audit", async (req, res) => {
    const query = z.object({ ...Paging, search: Search, action: z.string().trim().max(80).optional() }).parse(req.query);
    res.json(ok(await admin.listAudit(query)));
});

router.get("/audit/actions", async (_req, res) => {
    res.json(ok(await admin.auditActions()));
});

// ---- users -----------------------------------------------------------------------------

router.get("/users", async (req, res) => {
    const query = z
        .object({
            ...Paging,
            search: Search,
            role: z.enum(["user", "admin"]).optional(),
            verified: bool.optional(),
            sort: z.enum(["newest", "oldest", "recent_login", "email"]).optional(),
        })
        .parse(req.query);

    res.json(ok(await admin.listUsers(query)));
});

router.post("/users", async (req, res) => {
    const body = z
        .object({ email: z.email().max(254), password: z.string().min(1).max(1000), role: z.enum(["user", "admin"]).default("user"), verified: z.boolean().default(true) })
        .parse(req.body);

    const email = normalizeEmail(body.email);
    assertAcceptablePassword(body.password, email);

    const created = await users.createUser(email, await hashPassword(body.password));
    if (!created) throw new RuleError("An account with that email address already exists");

    if (body.verified) await users.markEmailVerified(created.id);
    if (body.role === "admin") await users.setRole(created.id, "admin");

    await audit(req, "user.create", { type: "user", id: created.id }, `${email} as ${body.role}${body.verified ? "" : ", not verified"}`);
    res.status(201).json(ok(await admin.getAdminUser(created.id)));
});

async function existingUser(req: Request) {
    const user = await admin.getAdminUser(idOf(req));
    if (!user) throw new NotFoundError("User not found");
    return user;
}

router.get("/users/:id", async (req, res) => {
    const user = await existingUser(req);
    res.json(ok({ user, ...(await admin.getUserFootprint(user.id)) }));
});

router.patch("/users/:id", async (req, res) => {
    const user = await existingUser(req);
    const body = z
        .object({ role: z.enum(["user", "admin"]).optional(), emailVerified: z.literal(true).optional() })
        .refine((value) => value.role !== undefined || value.emailVerified !== undefined, "Nothing to change")
        .parse(req.body);

    if (body.role !== undefined && body.role !== user.role) {
        if (user.id === currentUser(req).id) throw new RuleError("You cannot change your own role. Ask another administrator");

        await users.setRole(user.id, body.role);
        await audit(req, body.role === "admin" ? "user.promote" : "user.demote", { type: "user", id: user.id }, user.email);
    }
    if (body.emailVerified && !user.emailVerified) {
        await users.markEmailVerified(user.id);
        await audit(req, "user.verify-email", { type: "user", id: user.id }, user.email);
    }

    res.json(ok(await admin.getAdminUser(user.id)));
});

router.post("/users/:id/sign-out", async (req, res) => {
    const user = await existingUser(req);
    const signedOut = await users.deleteSessionsOf(user.id);

    await audit(req, "user.sign-out", { type: "user", id: user.id }, `${user.email}: ${signedOut} session(s) ended`);
    res.json(ok({ signedOut }));
});

// The person chooses their own new password from the emailed link; an administrator never sets or sees one
router.post("/users/:id/send-reset", async (req, res) => {
    const user = await existingUser(req);
    await requestPasswordReset(user.email, { ip: `admin:${currentUser(req).id}`, userAgent: null });

    await audit(req, "user.send-reset", { type: "user", id: user.id }, user.email);
    res.status(202).json(ok({ sent: true }));
});

router.delete("/users/:id", async (req, res) => {
    const user = await existingUser(req);
    if (user.id === currentUser(req).id) throw new RuleError("You cannot delete your own account. Ask another administrator");

    await users.deleteUser(user.id);
    await audit(req, "user.delete", { type: "user", id: user.id }, `${user.email} with ${user.resumes} resume(s)`);
    res.json(ok({ deleted: true }));
});

// ---- resumes ---------------------------------------------------------------------------

router.get("/candidates", async (req, res) => {
    const query = z.object({ ...Paging, search: Search, userId: z.coerce.number().int().positive().optional(), orphaned: bool.optional() }).parse(req.query);
    res.json(ok(await admin.listCandidates(query)));
});

async function existingCandidate(req: Request) {
    const id = idOf(req);
    const candidate = await getCandidate(id);
    const summary = await admin.getAdminCandidate(id);
    if (!candidate || !summary) throw new NotFoundError("Resume not found");
    return { candidate, summary };
}

router.get("/candidates/:id", async (req, res) => {
    const { candidate, summary } = await existingCandidate(req);

    res.json(ok({ ...summary, profile: candidate.profile, mailbox: (await getMailAccount(candidate.id)) ?? null, run: getRun(candidate.id) }));
});

router.get("/candidates/:id/resume", async (req, res) => {
    const { candidate, summary } = await existingCandidate(req);
    const file = await getCandidateFile(candidate.id);
    if (!file) throw new NotFoundError("Resume not found");

    await audit(req, "resume.download", { type: "resume", id: candidate.id }, summary.ownerEmail ?? "no owner");
    // A CV is personal data: it must not be cached by shared proxies, and the browser must not guess its type
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.type(file.mimeType).attachment(file.fileName).send(file.data);
});

router.put("/candidates/:id/profile", async (req, res) => {
    const { candidate, summary } = await existingCandidate(req);
    const updated = await updateCandidateProfile(candidate.id, ResumeSchema.parse(req.body));

    await audit(req, "resume.edit-profile", { type: "resume", id: candidate.id }, summary.ownerEmail ?? "no owner");
    res.json(ok(updated));
});

router.put("/candidates/:id/owner", async (req, res) => {
    const { candidate, summary } = await existingCandidate(req);
    const { userId } = z.object({ userId: z.number().int().positive().nullable() }).parse(req.body);

    const owner = userId === null ? undefined : await users.getUser(userId);
    if (userId !== null && !owner) throw new NotFoundError("User not found");

    await setCandidateOwner(candidate.id, userId);
    await audit(req, "resume.reassign", { type: "resume", id: candidate.id }, `${summary.ownerEmail ?? "no owner"} to ${owner?.email ?? "no owner"}`);
    res.json(ok(await admin.getAdminCandidate(candidate.id)));
});

router.delete("/candidates/:id", async (req, res) => {
    const { candidate, summary } = await existingCandidate(req);
    await deleteCandidate(candidate.id);

    await audit(req, "resume.delete", { type: "resume", id: candidate.id }, `${summary.fileName} of ${summary.ownerEmail ?? "no owner"}, with ${summary.matches} match(es)`);
    res.json(ok({ deleted: true }));
});

const RunBody = z.object({
    minScore: z.number().int().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    enrichTop: z.number().int().min(0).max(100).optional(),
    draftTop: z.number().int().min(0).max(20).optional(),
});

router.post("/candidates/:id/matches/run", async (req, res) => {
    const { candidate, summary } = await existingCandidate(req);
    const progress = startRun(candidate.id, RunBody.parse(req.body ?? {}));

    await audit(req, "resume.run-search", { type: "resume", id: candidate.id }, summary.ownerEmail ?? "no owner");
    res.status(202).json(ok(progress));
});

router.get("/candidates/:id/matches/run", async (req, res) => {
    const { candidate } = await existingCandidate(req);
    res.json(ok(getRun(candidate.id)));
});

// ---- vacancies -------------------------------------------------------------------------

router.get("/jobs", async (req, res) => {
    const query = z
        .object({
            ...Paging,
            search: Search,
            source: SourceId.optional(),
            hasEmail: bool.optional(),
            openOnly: bool.optional(),
            closedOnly: bool.optional(),
            enriched: bool.optional(),
            emailSource: z.enum(["page", "image"]).optional(),
            sort: z.enum(["newest", "first_seen", "last_seen", "closing", "most_matched"]).optional(),
        })
        .parse(req.query);

    res.json(ok(await admin.listAdminJobs(query)));
});

router.get("/jobs/:id", async (req, res) => {
    const job = await admin.getAdminJob(idOf(req));
    if (!job) throw new NotFoundError("Vacancy not found");
    res.json(ok(job));
});

/** Empty text means "clear it"; a date given without a time closes at the end of that day. */
const text = (max: number) =>
    z
        .string()
        .trim()
        .max(max)
        .transform((value) => (value === "" ? null : value))
        .nullable()
        .optional();

const dateText = z
    .string()
    .trim()
    .transform((value, ctx) => {
        if (value === "") return null;
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value;
        if (Number.isNaN(Date.parse(iso))) {
            ctx.addIssue({ code: "custom", message: "Use a valid date" });
            return z.NEVER;
        }
        return new Date(iso).toISOString();
    })
    .nullable()
    .optional();

const JobEdit = z.object({
    title: z.string().trim().min(1).max(1000).optional(),
    company: text(1000),
    location: text(1000),
    jobType: text(200),
    salary: text(500),
    category: text(500),
    postedAt: dateText,
    closingAt: dateText,
    applyEmail: z
        .string()
        .trim()
        .toLowerCase()
        .max(320)
        .transform((value) => (value === "" ? null : value))
        .refine((value) => value === null || z.email().safeParse(value).success, "Use a valid email address")
        .nullable()
        .optional(),
    applyUrl: z
        .string()
        .trim()
        .max(2000)
        .transform((value) => (value === "" ? null : value))
        .refine((value) => value === null || /^https?:\/\/\S+$/i.test(value), "Use an address that starts with http:// or https://")
        .nullable()
        .optional(),
    description: text(200_000),
});

router.patch("/jobs/:id", async (req, res) => {
    const id = idOf(req);
    const job = await admin.getAdminJob(id);
    if (!job) throw new NotFoundError("Vacancy not found");

    const body = JobEdit.parse(req.body);
    const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as Partial<Record<admin.JobField, string | null>>;
    if (Object.keys(changes).length === 0) throw new BadRequestError("Nothing to change");

    await admin.updateJobFields(id, changes);
    await audit(req, "job.edit", { type: "job", id }, `${job.title}: ${Object.keys(changes).join(", ")}`);
    res.json(ok(await admin.getAdminJob(id)));
});

router.post("/jobs/:id/enrich", async (req, res) => {
    const id = idOf(req);
    const job = await admin.getAdminJob(id);
    if (!job) throw new NotFoundError("Vacancy not found");

    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});
    if (force) await admin.resetEnrichment(id);

    await enrichJob(id);
    await audit(req, "job.enrich", { type: "job", id }, `${job.title}${force ? " (read again)" : ""}`);
    res.json(ok(await admin.getAdminJob(id)));
});

router.delete("/jobs/:id", async (req, res) => {
    const id = idOf(req);
    const job = await admin.getAdminJob(id);
    if (!job) throw new NotFoundError("Vacancy not found");

    await admin.deleteJob(id);
    await audit(req, "job.delete", { type: "job", id }, `${job.title}, with ${job.matches} match(es)`);
    res.json(ok({ deleted: true }));
});

router.post("/jobs/delete", async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).parse(req.body);
    const deleted = await admin.deleteJobs(ids);

    await audit(req, "job.delete-many", undefined, `${deleted} vacancies`);
    res.json(ok({ deleted }));
});

router.post("/jobs/purge-closed", async (req, res) => {
    const { days, source } = z.object({ days: z.number().int().min(0).max(3650), source: SourceId.optional() }).parse(req.body);
    const deleted = await admin.purgeClosedJobs(days, source);

    await audit(req, "job.purge-closed", undefined, `${deleted} vacancies closed more than ${days} day(s) ago${source ? ` from ${source}` : ""}`);
    res.json(ok({ deleted }));
});

// ---- collecting vacancies --------------------------------------------------------------

router.get("/collection", (_req, res) => {
    res.json(ok({ ...collectionStatus(), sources: sourceIds, enrichment: enrichmentStatus() }));
});

// The collection takes minutes and hits third-party sites, so it runs in the background and the screen follows it
router.post("/collection/run", async (req, res) => {
    const body = z.object({ sources: z.array(SourceId).min(1).optional(), maxPages: z.number().int().min(1).max(20).optional() }).parse(req.body ?? {});
    if (collectionStatus().running) throw new RuleError("A collection is already running");

    collectVacancies({ ...body, trigger: `administrator ${currentUser(req).email}` }).catch((error: unknown) =>
        console.error("Collection started from the console failed:", error instanceof Error ? error.message : error),
    );

    await audit(req, "collection.run", undefined, body.sources ? body.sources.join(", ") : "all sources");
    res.status(202).json(ok(collectionStatus()));
});

router.post("/collection/enrich", async (req, res) => {
    const body = z.object({ sources: z.array(SourceId).min(1).default(["topjobs"]), limit: z.number().int().min(1).max(200).default(40) }).parse(req.body ?? {});
    const status = startEnrichment(body.sources, body.limit);

    await audit(req, "collection.enrich", undefined, `${body.sources.join(", ")}, up to ${body.limit} each`);
    res.status(202).json(ok(status));
});

// ---- matches ---------------------------------------------------------------------------

router.get("/matches", async (req, res) => {
    const query = z
        .object({
            ...Paging,
            search: Search,
            status: z.enum(["suggested", "approved", "rejected"]).optional(),
            minScore: z.coerce.number().int().min(0).max(100).optional(),
            candidateId: z.coerce.number().int().positive().optional(),
            jobId: z.coerce.number().int().positive().optional(),
            sort: z.enum(["score", "newest"]).optional(),
        })
        .parse(req.query);

    res.json(ok(await admin.listAdminMatches(query)));
});

async function existingMatch(req: Request) {
    const match = await getMatch(idOf(req));
    const owner = match && (await admin.matchOwner(match.id));
    if (!match || !owner) throw new NotFoundError("Match not found");
    return { match, owner };
}

router.get("/matches/:id", async (req, res) => {
    const { match, owner } = await existingMatch(req);
    const application = await applications.getApplicationByMatch(match.id);

    res.json(ok({ match, owner, application: application ?? null }));
});

// Saving a changed letter withdraws the applicant's approval, so nothing edited here is ever sent unseen
router.patch("/matches/:id", async (req, res) => {
    const { match, owner } = await existingMatch(req);
    const body = z
        .object({ subject: z.string().trim().min(1).max(200).optional(), coverLetter: z.string().trim().min(1).max(8000).optional() })
        .refine((value) => value.subject !== undefined || value.coverLetter !== undefined, "Nothing to change")
        .parse(req.body);

    const updated = await editCoverLetter(match.id, body);
    await audit(req, "match.edit-letter", { type: "match", id: match.id }, `${match.job.title} for ${owner.ownerEmail ?? "no owner"}`);
    res.json(ok(updated));
});

router.post("/matches/:id/reject", async (req, res) => {
    const { match, owner } = await existingMatch(req);
    await setStatus(match.id, "rejected");

    await audit(req, "match.reject", { type: "match", id: match.id }, `${match.job.title} for ${owner.ownerEmail ?? "no owner"}`);
    res.json(ok(await getMatch(match.id)));
});

router.post("/matches/:id/reopen", async (req, res) => {
    const { match, owner } = await existingMatch(req);
    await setStatus(match.id, "suggested");

    await audit(req, "match.reopen", { type: "match", id: match.id }, `${match.job.title} for ${owner.ownerEmail ?? "no owner"}`);
    res.json(ok(await getMatch(match.id)));
});

router.delete("/matches/:id", async (req, res) => {
    const { match, owner } = await existingMatch(req);
    await admin.deleteMatch(match.id);

    await audit(req, "match.delete", { type: "match", id: match.id }, `${match.job.title} for ${owner.ownerEmail ?? "no owner"}`);
    res.json(ok({ deleted: true }));
});

// ---- applications (the send queue) -----------------------------------------------------

router.get("/applications", async (req, res) => {
    const query = z
        .object({
            ...Paging,
            search: Search,
            status: z.enum(["queued", "sending", "sent", "failed", "cancelled"]).optional(),
            candidateId: z.coerce.number().int().positive().optional(),
        })
        .parse(req.query);

    res.json(ok(await admin.listAdminApplications(query)));
});

async function existingApplication(req: Request) {
    const application = await admin.getAdminApplication(idOf(req));
    if (!application) throw new NotFoundError("Application not found");
    return application;
}

router.get("/applications/:id", async (req, res) => {
    res.json(ok(await existingApplication(req)));
});

router.post("/applications/cancel-queued", async (req, res) => {
    const cancelled = await admin.cancelAllQueued("Cancelled by an administrator");

    await audit(req, "application.cancel-all-queued", undefined, `${cancelled} application(s)`);
    res.json(ok({ cancelled }));
});

router.post("/applications/:id/cancel", async (req, res) => {
    const application = await existingApplication(req);
    if (!(await applications.cancel(application.id, "Cancelled by an administrator"))) {
        throw new RuleError(application.status === "sent" ? "This application has already been sent" : `Cannot cancel an application that is ${application.status}`);
    }

    await audit(req, "application.cancel", { type: "application", id: application.id }, `${application.jobTitle} to ${application.toEmail}`);
    res.json(ok(await admin.getAdminApplication(application.id)));
});

router.post("/applications/:id/retry", async (req, res) => {
    const application = await existingApplication(req);
    await retryApplication(application.id);

    await audit(req, "application.retry", { type: "application", id: application.id }, `${application.jobTitle} to ${application.toEmail}`);
    res.json(ok(await admin.getAdminApplication(application.id)));
});

router.delete("/applications/:id", async (req, res) => {
    const application = await existingApplication(req);
    if (!(await admin.deleteApplication(application.id))) throw new RuleError("An application that is being sent cannot be deleted");

    await audit(req, "application.delete", { type: "application", id: application.id }, `${application.status}: ${application.jobTitle} to ${application.toEmail}`);
    res.json(ok({ deleted: true }));
});

// ---- mailboxes -------------------------------------------------------------------------

router.get("/mailboxes", async (req, res) => {
    const query = z.object({ ...Paging, search: Search }).parse(req.query);
    res.json(ok(await admin.listMailboxes(query)));
});

router.delete("/mailboxes/:candidateId", async (req, res) => {
    const candidateId = idOf(req, "candidateId");
    const account = await getMailAccount(candidateId);
    if (!account) throw new NotFoundError("No mailbox connected");

    await deleteMailAccount(candidateId);
    await audit(req, "mailbox.disconnect", { type: "resume", id: candidateId }, account.email);
    res.json(ok({ removed: true }));
});

// ---- sessions --------------------------------------------------------------------------

router.get("/sessions", async (req, res) => {
    const query = z.object({ ...Paging, search: Search, userId: z.coerce.number().int().positive().optional() }).parse(req.query);
    res.json(ok(await admin.listSessions(query, sha256(req.sessionToken ?? ""))));
});

router.post("/sessions/purge-expired", async (req, res) => {
    const purged = await users.purgeExpiredSessions();

    await audit(req, "session.purge-expired", undefined, `${purged} session(s)`);
    res.json(ok({ purged }));
});

router.delete("/sessions/:id", async (req, res) => {
    const id = idOf(req);
    if (!(await admin.deleteSessionById(id))) throw new NotFoundError("Session not found");

    await audit(req, "session.revoke", { type: "session", id });
    res.json(ok({ revoked: true }));
});

export default router;
