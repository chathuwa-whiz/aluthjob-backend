import { Router } from "express";
import { z } from "zod";
import { currentUser } from "../auth/middleware.js";
import { ownedCandidate } from "../auth/ownership.js";
import { getCandidateFile, listCandidatesOf, updateCandidateProfile } from "../candidates/candidate.repository.js";
import { NotFoundError } from "../errors.js";
import { listApplications } from "../mail/application.repository.js";
import { queueApproved } from "../mail/application.service.js";
import { deleteMailAccount, getMailAccount } from "../mail/mail-account.repository.js";
import { connectMailbox } from "../mail/mail-account.service.js";
import { listMatches } from "../matching/match.repository.js";
import { getRun, startRun } from "../matching/run-tracker.js";
import { ResumeSchema } from "../schemas/resume.schema.js";

// Every handler starts from ownedCandidate(): it answers 404 unless the candidate belongs to the
// signed-in user, so nothing below can be reached with somebody else's id.
const router = Router();

const RunBody = z.object({
    minScore: z.number().int().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    enrichTop: z.number().int().min(0).max(100).optional(),
    draftTop: z.number().int().min(0).max(20).optional(),
});

const ListQuery = z.object({
    status: z.enum(["suggested", "approved", "rejected"]).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});

// The signed-in user's resumes
router.get("/", (req, res) => {
    const candidates = listCandidatesOf(currentUser(req).id).map((candidate) => ({
        id: candidate.id,
        fileName: candidate.fileName,
        fullName: candidate.profile.personalInfo.fullName,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt,
    }));

    res.json({ success: true, data: candidates });
});

router.get("/:id", (req, res) => {
    res.json({ success: true, data: ownedCandidate(currentUser(req), req.params.id) });
});

// The profile is extracted by a small model and can be wrong; matching uses whatever is stored here
router.put("/:id/profile", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.json({ success: true, data: updateCandidateProfile(candidate.id, ResumeSchema.parse(req.body)) });
});

router.get("/:id/resume", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);
    const file = getCandidateFile(candidate.id);
    if (!file) throw new NotFoundError("Candidate not found");

    // A CV is personal data: it must not be cached by shared proxies, and the browser must not guess its type
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    res.type(file.mimeType).attachment(file.fileName).send(file.data);
});

// The search takes minutes (it reads job sites and adverts), so it runs in the background: this answers at once
// with its progress, and the screen follows it with GET.
router.post("/:id/matches/run", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.status(202).json({ success: true, data: startRun(candidate.id, RunBody.parse(req.body ?? {})) });
});

// The latest search of this CV (null when none has run since the server started)
router.get("/:id/matches/run", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.json({ success: true, data: getRun(candidate.id) });
});

const MailboxBody = z.object({
    email: z.email().max(254),
    password: z.string().min(1).max(200),
    fromName: z.string().trim().max(100).optional(),
    // only needed for providers without a built-in preset (Gmail, Outlook, Yahoo, Zoho)
    host: z.string().trim().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    username: z.string().trim().min(1).max(254).optional(),
});

// Logs in to the mailbox before saving; the password is stored encrypted and is never returned
router.put("/:id/mail-account", async (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.json({ success: true, data: await connectMailbox(candidate.id, MailboxBody.parse(req.body)) });
});

router.get("/:id/mail-account", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    const account = getMailAccount(candidate.id);
    if (!account) throw new NotFoundError("No mailbox connected");

    res.json({ success: true, data: account });
});

router.delete("/:id/mail-account", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.json({ success: true, data: { removed: deleteMailAccount(candidate.id) } });
});

const QueueBody = z.object({ matchIds: z.array(z.number().int().positive()).max(200).optional() });

// Queues every approved match that has an employer email. Sending happens in the background, paced.
// (matchIds only narrows the choice among this candidate's own matches; ids of other people's are ignored.)
router.post("/:id/applications/queue", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.status(202).json({ success: true, data: queueApproved(candidate.id, QueueBody.parse(req.body ?? {}).matchIds) });
});

router.get("/:id/applications", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    const { status } = z.object({ status: z.enum(["queued", "sending", "sent", "failed", "cancelled"]).optional() }).parse(req.query);
    res.json({ success: true, data: listApplications(candidate.id, status) });
});

router.get("/:id/matches", (req, res) => {
    const candidate = ownedCandidate(currentUser(req), req.params.id);

    res.json({ success: true, data: listMatches(candidate.id, ListQuery.parse(req.query)) });
});

export default router;
