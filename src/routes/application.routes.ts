import { Router } from "express";
import { currentUser } from "../auth/middleware.js";
import { ownedApplication } from "../auth/ownership.js";
import { cancelApplication, retryApplication } from "../mail/application.service.js";

const router = Router();

router.get("/:id", (req, res) => {
    res.json({ success: true, data: ownedApplication(currentUser(req), req.params.id) });
});

// Only possible while the application is still waiting in the queue
router.post("/:id/cancel", (req, res) => {
    res.json({ success: true, data: cancelApplication(ownedApplication(currentUser(req), req.params.id).id) });
});

router.post("/:id/retry", (req, res) => {
    res.json({ success: true, data: retryApplication(ownedApplication(currentUser(req), req.params.id).id) });
});

export default router;
