import { Router, type Request } from "express";
import { z } from "zod";
import { currentUser } from "../auth/middleware.js";
import { ownedMatch } from "../auth/ownership.js";
import { previewMessage, queueMatch } from "../mail/application.service.js";
import { approveMatch, confirmAddress, editCoverLetter, rejectMatch, writeCoverLetter } from "../matching/match.service.js";

const router = Router();

const EditBody = z
    .object({
        subject: z.string().trim().min(1).max(200).optional(),
        coverLetter: z.string().trim().min(1).max(8000).optional(),
    })
    .refine((body) => body.subject !== undefined || body.coverLetter !== undefined, "Nothing to change");

// The id of the match in the URL, once it is known to belong to the signed-in user (404 otherwise)
const matchIdOf = async (req: Request) => (await ownedMatch(currentUser(req), req.params.id)).id;

router.get("/:id", async (req, res) => {
    res.json({ success: true, data: await ownedMatch(currentUser(req), req.params.id) });
});

// Generating can take a while on a CPU-only model; (re)writes the letter and withdraws any approval
router.post("/:id/cover-letter", async (req, res, next) => {
    try {
        res.json({ success: true, data: await writeCoverLetter(await matchIdOf(req)) });
    } catch (error) {
        next(error);
    }
});

router.patch("/:id", async (req, res) => {
    const id = await matchIdOf(req);
    res.json({ success: true, data: await editCoverLetter(id, EditBody.parse(req.body)) });
});

router.post("/:id/approve", async (req, res) => {
    res.json({ success: true, data: await approveMatch(await matchIdOf(req)) });
});

// The exact email that would go out, and whatever currently blocks it
router.get("/:id/email-preview", async (req, res) => {
    res.json({ success: true, data: await previewMessage(await matchIdOf(req)) });
});

// Addresses read from a picture must be confirmed by typing them back after checking the original advert
router.post("/:id/confirm-address", async (req, res) => {
    const id = await matchIdOf(req);
    const { address } = z.object({ address: z.string().trim().min(3).max(254) }).parse(req.body);

    res.json({ success: true, data: await confirmAddress(id, address) });
});

// Queues this one approved match for sending (paced, in the background). `again: true` is the person's explicit
// "send it a second time" after an application was already sent.
router.post("/:id/send", async (req, res) => {
    const id = await matchIdOf(req);
    const { again } = z.object({ again: z.boolean().optional() }).parse(req.body ?? {});
    const { application, created } = await queueMatch(id, { again });
    res.status(created ? 202 : 200).json({ success: true, data: application });
});

router.post("/:id/reject", async (req, res) => {
    res.json({ success: true, data: await rejectMatch(await matchIdOf(req)) });
});

export default router;
