import { NotFoundError, RuleError } from "../errors.js";
import { analyzeResume, type AnalysisEvent } from "./resume.service.js";

export type AnalysisPhase = "reading" | "understanding" | "saving" | "done" | "failed";

/** Output pieces a typical profile takes; only used to draw a bar, so it is an estimate and never reaches 100% before the end. */
export const EXPECTED_TOKENS = 600;

/** A snapshot of one CV being read, for the progress screen. */
export interface AnalysisProgress {
    status: "running" | "done" | "failed";
    phase: AnalysisPhase;
    fileName: string;
    startedAt: string;
    /** Time taken so far (or in total), so the screen needs no synchronised clock. */
    elapsedMs: number;
    /** Known once the file's text has been read. */
    characters: number | null;
    links: number | null;
    /** Skills found by the fast parser before the model runs. */
    skills: number | null;
    /** True when this exact CV was read before, so the slow step is skipped. */
    reused: boolean;
    /** 0 to 1: how far the model's writing is, estimated from its output so far. */
    writing: number;
    result: Awaited<ReturnType<typeof analyzeResume>> | null;
    error: string | null;
}

interface Analysis extends Omit<AnalysisProgress, "elapsedMs"> {
    startedMs: number;
    finishedMs: number | null;
}

/** The latest CV each person uploaded. A new upload replaces it; nothing is kept across restarts. */
const analyses = new Map<number, Analysis>();

function apply(analysis: Analysis, event: AnalysisEvent) {
    switch (event.type) {
        case "phase":
            analysis.phase = event.phase;
            break;
        case "text":
            analysis.characters = event.characters;
            analysis.links = event.links;
            break;
        case "reused":
            analysis.reused = true;
            break;
        case "skills":
            analysis.skills = event.count;
            break;
        case "writing":
            analysis.writing = Math.min(event.tokens / EXPECTED_TOKENS, 0.95);
            break;
    }
}

const describe = ({ startedMs, finishedMs, ...rest }: Analysis, now = Date.now()): AnalysisProgress => ({
    ...rest,
    elapsedMs: (finishedMs ?? now) - startedMs,
});

export function getAnalysis(userId: number): AnalysisProgress | null {
    const analysis = analyses.get(userId);
    return analysis ? describe(analysis) : null;
}

/**
 * Starts reading a CV in the background and returns straight away; poll getAnalysis() for progress.
 * One at a time per person: the local model is busy for a minute or more with each.
 */
export function startAnalysis(userId: number, file: Express.Multer.File): AnalysisProgress {
    if (analyses.get(userId)?.status === "running") {
        throw new RuleError("Your CV is still being read. Wait for it to finish before uploading another");
    }

    const analysis: Analysis = {
        status: "running",
        phase: "reading",
        fileName: file.originalname,
        startedAt: new Date().toISOString(),
        startedMs: Date.now(),
        finishedMs: null,
        characters: null,
        links: null,
        skills: null,
        reused: false,
        writing: 0,
        result: null,
        error: null,
    };
    analyses.set(userId, analysis);

    analyzeResume(userId, file, (event) => apply(analysis, event)).then(
        (result) => {
            analysis.status = "done";
            analysis.phase = "done";
            analysis.writing = 1;
            analysis.result = result;
            analysis.finishedMs = Date.now();
        },
        (error: unknown) => {
            analysis.status = "failed";
            analysis.phase = "failed";
            analysis.finishedMs = Date.now();
            if (error instanceof RuleError || error instanceof NotFoundError) {
                analysis.error = error.message;
            } else {
                console.error("Reading the CV failed:", error);
                analysis.error = "This CV could not be read. Check that it is a text-based PDF or Word file, then try again";
            }
        },
    );

    return describe(analysis);
}

/** For tests. */
export const forgetAnalyses = () => analyses.clear();
