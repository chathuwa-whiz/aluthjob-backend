import { Router } from "express";

import { guardResumeUpload, uploadResume } from "../middleware/upload.middleware.js";

import { analysisStatusController, analyzeResumeController } from "../controllers/resume.controller.js";

const router = Router();

router.post("/analyze", guardResumeUpload, uploadResume.single("resume"), analyzeResumeController);
router.get("/analyze", analysisStatusController);

export default router;
