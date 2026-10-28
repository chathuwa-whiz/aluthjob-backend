import { getDatabase, isUniqueViolation } from "../db/database.js";
import { getJob, getJobsByIds, type StoredJob } from "../jobs/job.repository.js";
import type { MatchScore } from "./scoring.js";

export type MatchStatus = "suggested" | "approved" | "rejected";
export type ApplyMethod = "email" | "portal";

export interface MatchDetails extends Omit<MatchScore, "score"> {}

export interface Match {
    id: number;
    candidateId: number;
    jobId: number;
    score: number;
    details: MatchDetails;
    status: MatchStatus;
    subject: string | null;
    coverLetter: string | null;
    draftedAt: string | null;
    decidedAt: string | null;
    /** The user explicitly confirmed completing an application on the employer's site. */
    appliedOnSiteAt: string | null;
    /** The employer address the user checked against the original advert; only counts while it equals the job's address. */
    confirmedEmail: string | null;
    createdAt: string;
    updatedAt: string;
    /** "email": the ad publishes an employer address. "portal": apply on the job site itself. */
    applyMethod: ApplyMethod;
    job: StoredJob;
}

interface MatchRow {
    id: number;
    candidate_id: number;
    job_id: number;
    score: number;
    details_json: string;
    status: MatchStatus;
    subject: string | null;
    cover_letter: string | null;
    drafted_at: string | null;
    decided_at: string | null;
    applied_on_site_at: string | null;
    confirmed_email: string | null;
    created_at: string;
    updated_at: string;
}

function toMatch(row: MatchRow, job: StoredJob): Match {
    return {
        id: row.id,
        candidateId: row.candidate_id,
        jobId: row.job_id,
        score: row.score,
        details: JSON.parse(row.details_json) as MatchDetails,
        status: row.status,
        subject: row.subject,
        coverLetter: row.cover_letter,
        draftedAt: row.drafted_at,
        decidedAt: row.decided_at,
        appliedOnSiteAt: row.applied_on_site_at,
        confirmedEmail: row.confirmed_email,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        applyMethod: job.applyEmail ? "email" : "portal",
        job,
    };
}

export interface NewMatch {
    jobId: number;
    score: number;
    details: MatchDetails;
}

/** Oracle accepts at most 1000 items in an IN list. */
const CHUNK = 500;

/**
 * Stores the outcome of a matching run. Scores and explanations are refreshed, but a user's
 * decision and any drafted letter survive. Suggestions the user never touched that no longer
 * qualify are dropped, so the list always reflects the latest run.
 */
export async function saveMatches(candidateId: number, matches: NewMatch[]): Promise<void> {
    const now = new Date().toISOString();

    await getDatabase().transaction(async (tx) => {
        const keep = new Set(matches.map((match) => match.jobId));
        const untouched = await tx.all<{ job_id: number }>(
            "SELECT job_id FROM matches WHERE candidate_id = ? AND status = 'suggested' AND cover_letter IS NULL",
            [candidateId],
        );
        const stale = untouched.map((row) => row.job_id).filter((jobId) => !keep.has(jobId));

        for (let i = 0; i < stale.length; i += CHUNK) {
            const part = stale.slice(i, i + CHUNK);
            await tx.run(`DELETE FROM matches WHERE candidate_id = ? AND job_id IN (${part.map(() => "?").join(",")})`, [candidateId, ...part]);
        }

        for (const match of matches) {
            const details = JSON.stringify(match.details);
            const refresh = () =>
                tx.run("UPDATE matches SET score = ?, details_json = ?, updated_at = ? WHERE candidate_id = ? AND job_id = ?", [match.score, details, now, candidateId, match.jobId]);

            if ((await refresh()).changes === 0) {
                try {
                    await tx.run(
                        "INSERT INTO matches (candidate_id, job_id, score, details_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                        [candidateId, match.jobId, match.score, details, now, now],
                    );
                } catch (error) {
                    // two searches of the same CV at once: the other one inserted it first (its commit is what released us)
                    if (!isUniqueViolation(error)) throw error;
                    await refresh();
                }
            }
        }
    });
}

export async function getMatch(id: number): Promise<Match | undefined> {
    const row = await getDatabase().get<MatchRow>("SELECT * FROM matches WHERE id = ?", [id]);
    if (!row) return undefined;

    const job = await getJob(row.job_id);
    return job && toMatch(row, job);
}

export interface MatchFilter {
    status?: MatchStatus;
    minScore?: number;
    limit?: number;
    offset?: number;
}

export async function listMatches(candidateId: number, filter: MatchFilter = {}): Promise<Match[]> {
    const where = ["candidate_id = :candidateId"];
    const params: Record<string, string | number> = { candidateId };

    if (filter.status) {
        where.push("status = :status");
        params.status = filter.status;
    }
    if (filter.minScore !== undefined) {
        where.push("score >= :minScore");
        params.minScore = filter.minScore;
    }

    const rows = await getDatabase().all<MatchRow>(
        `SELECT * FROM matches WHERE ${where.join(" AND ")}
         ORDER BY score DESC, id ASC OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`,
        { ...params, lim: filter.limit ?? 50, off: filter.offset ?? 0 },
    );

    // one query for all the vacancies, not one per match: every round trip to a cloud database costs time
    const jobs = await getJobsByIds(rows.map((row) => row.job_id));

    return rows.flatMap((row) => {
        const job = jobs.get(row.job_id);
        return job ? [toMatch(row, job)] : [];
    });
}

export async function saveDraft(id: number, subject: string, coverLetter: string): Promise<void> {
    const now = new Date().toISOString();

    // Email approval covers the exact letter; external completion records a real-world
    // action and must survive edits to an optional letter.
    await getDatabase().run(
        `UPDATE matches
         SET subject = ?, cover_letter = ?, drafted_at = ?, updated_at = ?,
             status = CASE WHEN status = 'approved' AND applied_on_site_at IS NULL THEN 'suggested' ELSE status END,
             decided_at = CASE WHEN status = 'approved' AND applied_on_site_at IS NULL THEN NULL ELSE decided_at END
         WHERE id = ?`,
        [subject, coverLetter, now, now, id],
    );
}

export async function setStatus(id: number, status: MatchStatus): Promise<void> {
    const now = new Date().toISOString();

    await getDatabase().run("UPDATE matches SET status = ?, decided_at = ?, updated_at = ?, applied_on_site_at = CASE WHEN ? = 'approved' THEN applied_on_site_at ELSE NULL END WHERE id = ?", [status, status === "suggested" ? null : now, now, status, id]);
}

/** Only a vacancy without an employer email can acquire external-application authority. */
export async function recordPortalApplication(id: number): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await getDatabase().run(
        `UPDATE matches SET status = 'approved',
             decided_at = COALESCE(applied_on_site_at, ?),
             applied_on_site_at = COALESCE(applied_on_site_at, ?), updated_at = ?
         WHERE id = ? AND (applied_on_site_at IS NOT NULL OR
             EXISTS (SELECT 1 FROM jobs WHERE jobs.id = matches.job_id AND jobs.apply_email IS NULL))`,
        [now, now, now, id],
    );
    return result.changes === 1;
}

/** Records that the user checked this address against the original advert. */
export async function saveConfirmedEmail(id: number, address: string): Promise<void> {
    await getDatabase().run("UPDATE matches SET confirmed_email = ?, updated_at = ? WHERE id = ?", [address.toLowerCase(), new Date().toISOString(), id]);
}
