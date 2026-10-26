import { Router, type Request } from "express";
import { z } from "zod";
import { performAction, oneClickUnsubscribe, previewAction, readPreferences } from "../alerts/alert.service.js";
import { savePreferences } from "../alerts/alert.repository.js";
import { currentUser } from "../auth/middleware.js";

const LinkToken = z.string().min(20).max(500);
const ipOf = (req: Request) => req.ip ?? "unknown";

/**
 * Reached from the buttons in a job-alert email, signed in or not: the signed token in the link is the
 * authority, and it can only do the one small, repeatable thing it names. Mounted before the sign-in guard.
 */
export const alertLinkRoutes = Router();

// POST, not GET: mail scanners and link previews open every link in a message
alertLinkRoutes.post("/preview", async (req, res) => {
    const { token } = z.object({ token: LinkToken }).parse(req.body);
    res.json({ success: true, data: await previewAction(token, ipOf(req)) });
});

alertLinkRoutes.post("/act", async (req, res) => {
    const { token } = z.object({ token: LinkToken }).parse(req.body);
    res.json({ success: true, data: await performAction(token, ipOf(req)) });
});

// The mail app's own "Unsubscribe" button (RFC 8058): it POSTs "List-Unsubscribe=One-Click" to the address in the
// message's List-Unsubscribe header. The token travels in the query because the body is form-encoded, not JSON.
alertLinkRoutes.post("/unsubscribe", async (req, res) => {
    await oneClickUnsubscribe(LinkToken.parse(req.query.t), ipOf(req));
    res.json({ success: true, data: { unsubscribed: true } });
});

/** The signed-in person's own settings (Account page). Mounted behind the sign-in guard. */
export const alertPreferenceRoutes = Router();

const Body = z
    .object({
        frequency: z.enum(["daily", "weekly", "off"]).optional(),
        minScore: z.number().int().min(35).max(95).optional(),
        /** true = pause for a week, false = lift the pause */
        paused: z.boolean().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, "Nothing to change");

alertPreferenceRoutes.get("/preferences", async (req, res) => {
    res.json({ success: true, data: await readPreferences(currentUser(req).id) });
});

alertPreferenceRoutes.put("/preferences", async (req, res) => {
    const body = Body.parse(req.body);
    const userId = currentUser(req).id;

    const saved = await savePreferences(userId, {
        ...(body.frequency && { frequency: body.frequency }),
        ...(body.minScore !== undefined && { minScore: body.minScore }),
        ...(body.paused !== undefined && { pausedUntil: body.paused ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null }),
    });

    res.json({ success: true, data: saved });
});
