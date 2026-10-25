import { createHash } from "node:crypto";
import { extractResumeContent, type ResumeLink } from "./text-extraction.service.js";
import { extractCandidateProfile, type ExtractionEvent } from "./ai-extraction.service.js";
import { createCandidate, findCandidateByHash } from "../candidates/candidate.repository.js";

/**
 * Identifies an upload for re-upload detection. The owner is part of the key: the same CV uploaded by
 * two accounts must produce two separate records, never one shared one.
 */
export function resumeKey(userId: number, text: string, links: ResumeLink[]): string {
    return createHash("sha256").update(String(userId)).update("\0").update(text).update("\0").update(JSON.stringify(links)).digest("hex");
}

/** What reading a CV reports while it works, for showing progress. */
export type AnalysisEvent =
    | { type: "phase"; phase: "reading" | "understanding" | "saving" }
    | { type: "text"; characters: number; links: number }
    | { type: "reused" }
    | ExtractionEvent;

export async function analyzeResume(
    userId: number,
    file: Express.Multer.File,
    report: (event: AnalysisEvent) => void = () => {},
) {
    report({ type: "phase", phase: "reading" });
    const resume = await extractResumeContent(file);
    report({ type: "text", characters: resume.text.length, links: resume.links.length });
    const resumeText = resume.text;

    // Same user + same text -> same candidate, so re-uploads skip the slow model call and keep any
    // corrections the user made to the stored profile
    const hash = resumeKey(userId, resumeText, resume.links);

    let candidate = await findCandidateByHash(userId, hash);
    if (candidate) {
        report({ type: "reused" });
    } else {
        report({ type: "phase", phase: "understanding" });
        const profile = await extractCandidateProfile(resume, report);

        report({ type: "phase", phase: "saving" });
        candidate = await createCandidate({ userId, hash, fileName: file.originalname, mimeType: file.mimetype, fileData: file.buffer, profile });
    }

    return {
        candidateId: candidate.id,
        profile: candidate.profile,
        metadata: {
            fileName: file.originalname,
            extractedCharacters: resumeText.length,
            processedAt: new Date().toISOString(),
        },
    };
}
