import type { Request, Response, NextFunction } from "express";
import { currentUser } from "../auth/middleware.js";
import { getAnalysis, startAnalysis } from "../services/analysis-tracker.js";

// Reading takes a minute or more, so it runs in the background: this answers at once and the screen follows it with GET
export function analyzeResumeController(req: Request, res: Response, next: NextFunction) {
    try {
        const user = currentUser(req);

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded",
            });
        }

        return res.status(202).json({ success: true, data: startAnalysis(user.id, req.file) });
    } catch (error) {
        next(error);
    }
}

/** The latest CV this person uploaded (null when none since the server started). */
export function analysisStatusController(req: Request, res: Response) {
    res.json({ success: true, data: getAnalysis(currentUser(req).id) });
}
