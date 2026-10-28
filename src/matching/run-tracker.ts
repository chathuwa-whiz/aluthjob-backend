import { NotFoundError, RuleError } from "../errors.js";
import type { SiteEvent } from "../jobs/ingest.service.js";
import { runMatching, type MatchRunOptions, type MatchRunSummary, type RunEvent, type RunJobRef } from "./match.service.js";

export type RunPhase = "starting" | "collecting" | "ranking" | "reading" | "drafting" | "done" | "failed";

export interface RunStep {
    done: number;
    total: number;
    /** The advert being worked on right now (null between adverts and once finished). */
    current: RunJobRef | null;
}

export interface RunActivity {
    at: string;
    text: string;
}

/** A snapshot of one search, for the progress screen. Safe to hand out as is: it holds no personal data. */
export interface RunProgress {
    candidateId: number;
    status: "running" | "done" | "failed";
    phase: RunPhase;
    startedAt: string;
    /** Time the search has taken so far (or took in total), so the screen needs no synchronised clock. */
    elapsedMs: number;
    /** What each job site is doing; empty when saved vacancies were fresh enough to need no collecting. */
    sites: SiteEvent[];
    /** Vacancies compared against the CV (null until the ranking step has counted them). */
    considered: number | null;
    adverts: RunStep;
    letters: RunStep;
    /** Suggestions kept so far (known once ranking ends). */
    matched: number | null;
    topScore: number | null;
    /** The latest things that happened, newest last. */
    activity: RunActivity[];
    summary: MatchRunSummary | null;
    error: string | null;
}

interface Run extends Omit<RunProgress, "elapsedMs"> {
    startedMs: number;
    finishedMs: number | null;
}

const MAX_ACTIVITY = 8;
const SITE_NAME: Record<string, string> = {
    topjobs: "TopJobs",
    observerjobs: "ObserverJobs",
    jobpal: "Jobpal",
    governmentjobs: "GovernmentJobs",
    rooster: "Rooster",
    dreamjobs: "DreamJobs",
    ikman: "ikman",
    xpress: "Xpress",
    findmyjob: "FindMyJob",
    finders: "Finders",
};
const siteName = (source: string) => SITE_NAME[source] ?? source;

/** The latest search of each person's CV. A new search replaces the previous one; nothing is kept across restarts. */
const runs = new Map<number, Run>();

function note(run: Run, text: string) {
    run.activity.push({ at: new Date().toISOString(), text });
    if (run.activity.length > MAX_ACTIVITY) run.activity.shift();
}

function apply(run: Run, event: RunEvent) {
    switch (event.type) {
        case "phase":
            run.phase = event.phase;
            break;

        case "site": {
            const previous = run.sites.findIndex((site) => site.source === event.site.source);
            if (previous === -1) run.sites.push(event.site);
            else run.sites[previous] = event.site;

            if (event.site.state === "done") note(run, `${siteName(event.site.source)}: found ${event.site.fetched} vacancies`);
            if (event.site.state === "failed") note(run, `${siteName(event.site.source)} could not be read`);
            break;
        }

        case "ranked":
            run.considered = event.considered;
            note(run, `Compared your CV with ${event.considered} vacancies`);
            break;

        case "advert":
            run.adverts = { done: event.done, total: event.total, current: event.job };
            break;

        case "letter":
            run.letters = { done: event.done, total: event.total, current: event.job };
            break;

        case "matched":
            run.matched = event.matched;
            run.topScore = event.topScore;
            note(run, `Kept ${event.matched} matches`);
            break;
    }
}

export function describeRun(run: Run, now = Date.now()): RunProgress {
    const { startedMs, finishedMs, ...rest } = run;
    return { ...rest, sites: [...rest.sites], activity: [...rest.activity], elapsedMs: (finishedMs ?? now) - startedMs };
}

/** The latest search of this CV, or null when it has never been searched since the server started. */
export function getRun(candidateId: number): RunProgress | null {
    const run = runs.get(candidateId);
    return run ? describeRun(run) : null;
}

/**
 * Starts a search in the background and returns straight away; poll getRun() for progress.
 * Asking again while one is running just returns the running one, so a double click or a second tab cannot start a second search.
 */
export function startRun(candidateId: number, options: Partial<MatchRunOptions> = {}): RunProgress {
    const existing = runs.get(candidateId);
    if (existing?.status === "running") return describeRun(existing);

    const run: Run = {
        candidateId,
        status: "running",
        phase: "starting",
        startedAt: new Date().toISOString(),
        startedMs: Date.now(),
        finishedMs: null,
        sites: [],
        considered: null,
        adverts: { done: 0, total: 0, current: null },
        letters: { done: 0, total: 0, current: null },
        matched: null,
        topScore: null,
        activity: [],
        summary: null,
        error: null,
    };
    runs.set(candidateId, run);

    runMatching(candidateId, options, (event) => apply(run, event)).then(
        (summary) => {
            run.status = "done";
            run.phase = "done";
            run.summary = summary;
            run.adverts.current = null;
            run.letters.current = null;
            run.finishedMs = Date.now();
        },
        (error: unknown) => {
            run.status = "failed";
            run.phase = "failed";
            run.finishedMs = Date.now();
            // Messages meant for the person are safe to show; anything else is logged and kept generic
            if (error instanceof RuleError || error instanceof NotFoundError) {
                run.error = error.message;
            } else {
                console.error("Search failed:", error);
                run.error = "The search stopped because of a problem on the server. Please try again";
            }
        },
    );

    return describeRun(run);
}

/** For tests. */
export const forgetRuns = () => runs.clear();
