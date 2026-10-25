import { Router } from "express";
import { currentUser } from "../auth/middleware.js";
import { ownedApplication } from "../auth/ownership.js";
import { cancelApplication, retryApplication } from "../mail/application.service.js";

const router = Router();

router.get("/:id", async (req, res) => {
    res.json({ success: true, data: await ownedApplication(currentUser(req), req.params.id) });
});

// Only possible while the application is still waiting in the queue
router.post("/:id/cancel", async (req, res) => {
    res.json({ success: true, data: await cancelApplication((await ownedApplication(currentUser(req), req.params.id)).id) });
});

router.post("/:id/retry", async (req, res) => {
    res.json({ success: true, data: await retryApplication((await ownedApplication(currentUser(req), req.params.id)).id) });
});

export default router;
