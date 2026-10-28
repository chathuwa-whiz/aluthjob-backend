import multure from "multer";
import type { RequestHandler } from "express";
import { currentUser } from "../auth/middleware.js";
import { RateLimiter } from "../auth/rate-limit.js";
import { BadRequestError, RuleError } from "../errors.js";
import { getAnalysis } from "../services/analysis-tracker.js";
import { WorkBudget } from "../security/work-budget.js";

const uploads = new RateLimiter(10, 60 * 60_000, "resume uploads");
const receiving = new WorkBudget(4, "Resume uploads");
const uploadingUsers = new Set<number>();

/** Reserve before multer allocates buffers, including on chunked requests. */
export const guardResumeUpload: RequestHandler = (req, res, next) => {
    const user = currentUser(req);
    if (uploadingUsers.has(user.id) || getAnalysis(user.id)?.status === "running") throw new RuleError("Your CV is still being read. Wait for it to finish before uploading another");
    const length = Number(req.get("content-length") ?? 0);
    if (length > 5 * 1024 * 1024 + 65536) throw new BadRequestError("The uploaded CV must be at most 5 MB");
    uploads.assertAllowed(String(user.id));
    const release = receiving.acquire();
    uploads.record(String(user.id));
    uploadingUsers.add(user.id);
    const timer = setTimeout(() => req.destroy(), 30_000);
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        uploadingUsers.delete(user.id);
        release();
    };
    res.once("finish", finish);
    res.once("close", finish);
    req.once("aborted", finish);
    next();
};

export const uploadResume = multure({
    storage: multure.memoryStorage(),

    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 1, // Only one file allowed
        fields: 0,
        parts: 2, // busboy counts the terminating part as well
        fieldNameSize: 100,
        fieldSize: 1024,
    },

    fileFilter: (_req, file, callback) => {
        const allowed = [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ];

        if (!allowed.includes(file.mimetype)) {
            return callback(
                new BadRequestError("Only PDF and Word documents are allowed."),
            )
        }

        callback(null, true);
    }
})
