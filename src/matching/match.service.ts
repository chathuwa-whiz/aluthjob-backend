import { getCandidate } from "../candidates/candidate.repository.js";
import { NotFoundError, RuleError } from "../errors.js";
import { ensureVacancies } from "../jobs/collection.service.js";
import { enrichJob, type SiteEvent } from "../jobs/ingest.service.js";
import { listJobs, type StoredJob } from "../jobs/job.repository.js";
import { buildSubject, draftCoverLetter } from "./cover-letter.service.js";
import { getMatch, listMatches, saveConfirmedEmail, saveDraft, saveMatches, setStatus, type Match, type NewMatch } from "./match.repository.js";
import { buildCorpus, buildProfileModel, scoreJob } from "./scoring.js";

export interface MatchRunOptions {
    /** Suggestions scoring below this are not stored. */
    minScore: number;
    /** At most this many suggestions are kept. */
    limit: number;
    /** Detail pages are fetched for this many best listings that only have a teaser, then rescored. */
    enrichTop: number;
    /** Cover letters are drafted for this many best suggestions that have none yet. */
    draftTop: number;
}

export const DEFAULT_RUN_OPTIONS: MatchRunOptions = { minScore: 35, limit: 100, enrichTop: 20, draftTop: 0 };

export interface MatchRunSummary {
    considered: number;
    matched: number;
    enriched: number;
    drafted: number;
    topScore: number | null;
    /** Vacancies collected from the job sites as part of this search (only on a first search, when there were none). */
    collected: number;
    /** Job sites that could not be read during that collection. */
    sourcesFailed: number;
}

/** The advert a step of a search is working on right now. */
export interface RunJobRef {
    title: string;
    company: string | null;
    source: string;
}

/** What a search reports while it works, for showing progress. */
export type RunEvent =
    | { type: "phase"; phase: "collecting" | "ranking" | "reading" | "drafting" }
    | { type: "site"; site: SiteEvent }
    | { type: "ranked"; considered: number }
    | { type: "advert"; done: number; total: number; job: RunJobRef }
    | { type: "letter"; done: number; total: number; job: RunJobRef }
    | { type: "matched"; matched: number; topScore: number | null };

const STALE_AFTER_DAYS = 14;

const refOf = (job: { title: string; company: string | null; source: string }): RunJobRef => ({ title: job.title, company: job.company, source: job.source });

export async function runMatching(
    candidateId: number,
    overrides: Partial<MatchRunOptions> = {},
    report: (event: RunEvent) => void = () => {},
): Promise<MatchRunSummary> {
    const options = { ...DEFAULT_RUN_OPTIONS, ...overrides };

    const candidate = await getCandidate(candidateId);
    if (!candidate) throw new NotFoundError("Candidate not found");

    // A fresh install has no vacancies yet: collect them now rather than "searching" nothing
    report({ type: "phase", phase: "collecting" });
    const collection = await ensureVacancies((site) => report({ type: "site", site }));

    report({ type: "phase", phase: "ranking" });

    const seenSince = new Date(Date.now() - STALE_AFTER_DAYS * 864e5).toISOString();
    const jobs = new Map<number, StoredJob>(
        (await listJobs({ openOnly: true, seenSince, limit: 100_000 })).map((job) => [job.id, job]),
    );

    const model = buildProfileModel(candidate.profile);
    const corpus = buildCorpus([...jobs.values()]);

    const scoreAll = () =>
        [...jobs.values()]
            .map((job) => ({ job, result: scoreJob(model, job, corpus) }))
            .sort((a, b) => b.result.score - a.result.score);

    let ranked = scoreAll();
    report({ type: "ranked", considered: ranked.length });

    // Listings are often only a teaser; read the full advert of the most promising ones and rank again
    let enriched = 0;
    const toRead = ranked.slice(0, options.enrichTop).filter(({ job }) => !job.enrichedAt);
    if (toRead.length > 0) report({ type: "phase", phase: "reading" });

    for (const [index, { job }] of toRead.entries()) {
        report({ type: "advert", done: index, total: toRead.length, job: refOf(job) });

        try {
            const full = await enrichJob(job.id);
            if (full) {
                jobs.set(job.id, full);
                enriched++;
            }
        } catch (error) {
            console.warn(`Could not read advert of job ${job.id} (${job.source}):`, error instanceof Error ? error.message : error);
        }
    }
    if (enriched > 0) ranked = scoreAll();

    const selected: NewMatch[] = ranked
        .filter(({ result }) => result.score >= options.minScore)
        .slice(0, options.limit)
        .map(({ job, result: { score, ...details } }) => ({ jobId: job.id, score, details }));

    await saveMatches(candidateId, selected);
    report({ type: "matched", matched: selected.length, topScore: selected[0]?.score ?? null });

    let drafted = 0;
    if (options.draftTop > 0) {
        const toDraft = (await listMatches(candidateId, { limit: options.draftTop })).filter((match) => !match.coverLetter);
        if (toDraft.length > 0) report({ type: "phase", phase: "drafting" });

        for (const [index, match] of toDraft.entries()) {
            report({ type: "letter", done: index, total: toDraft.length, job: refOf(match.job) });
            await writeCoverLetter(match.id);
            drafted++;
        }
    }

    return {
        considered: ranked.length,
        matched: selected.length,
        enriched,
        drafted,
        topScore: selected[0]?.score ?? null,
        collected: collection.collected,
        sourcesFailed: collection.sourcesFailed,
    };
}

/** (Re)writes the cover letter of a suggestion. Any earlier approval is withdrawn by the repository. */
export async function writeCoverLetter(matchId: number): Promise<Match> {
    const match = await getMatch(matchId);
    if (!match) throw new NotFoundError("Match not found");

    const candidate = await getCandidate(match.candidateId);
    if (!candidate) throw new NotFoundError("Candidate not found");

    const letter = await draftCoverLetter(candidate.profile, match.job, match.details.matchedSkills);
    await saveDraft(matchId, letter.subject, letter.text);

    return (await getMatch(matchId))!;
}

export async function editCoverLetter(matchId: number, edits: { subject?: string; coverLetter?: string }): Promise<Match> {
    const match = await getMatch(matchId);
    if (!match) throw new NotFoundError("Match not found");

    const candidate = await getCandidate(match.candidateId);
    await saveDraft(
        matchId,
        edits.subject ?? match.subject ?? (candidate ? buildSubject(candidate.profile, match.job) : match.job.title),
        edits.coverLetter ?? match.coverLetter ?? "",
    );

    return (await getMatch(matchId))!;
}

/** The user's confirmation. Nothing is ever sent for a match that has not been approved. */
export async function approveMatch(matchId: number): Promise<Match> {
    const match = await getMatch(matchId);
    if (!match) throw new NotFoundError("Match not found");

    if (!match.coverLetter?.trim()) throw new RuleError("Write or generate a cover letter before approving");
    if (match.job.closingAt && match.job.closingAt < new Date().toISOString()) {
        throw new RuleError("This vacancy has already closed");
    }

    await setStatus(matchId, "approved");
    return (await getMatch(matchId))!;
}

export async function rejectMatch(matchId: number): Promise<Match> {
    if (!(await getMatch(matchId))) throw new NotFoundError("Match not found");

    await setStatus(matchId, "rejected");
    return (await getMatch(matchId))!;
}

/**
 * For addresses that were read from a picture: the user types the address back after looking at the
 * original advert. Typing it (not just clicking OK) is what catches a misread character.
 */
export async function confirmAddress(matchId: number, address: string): Promise<Match> {
    const match = await getMatch(matchId);
    if (!match) throw new NotFoundError("Match not found");
    if (!match.job.applyEmail) throw new RuleError("This vacancy has no employer address to confirm");

    if (address.trim().toLowerCase() !== match.job.applyEmail.toLowerCase()) {
        throw new RuleError("That does not match the address on file. Check the original advert and type the address exactly as printed there");
    }

    await saveConfirmedEmail(matchId, match.job.applyEmail);
    return (await getMatch(matchId))!;
}
