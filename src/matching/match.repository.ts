import { getDatabase } from "../db/database.js";
import { getJob, type StoredJob } from "../jobs/job.repository.js";
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

/**
 * Stores the outcome of a matching run. Scores and explanations are refreshed, but a user's
 * decision and any drafted letter survive. Suggestions the user never touched that no longer
 * qualify are dropped, so the list always reflects the latest run.
 */
export function saveMatches(candidateId: number, matches: NewMatch[]): void {
    const db = getDatabase();
    const now = new Date().toISOString();

    const upsert = db.prepare(`
        INSERT INTO matches (candidate_id, job_id, score, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (candidate_id, job_id) DO UPDATE SET
            score = excluded.score, details_json = excluded.details_json, updated_at = excluded.updated_at
    `);

    db.exec("BEGIN");
    try {
        if (matches.length === 0) {
            db.prepare("DELETE FROM matches WHERE candidate_id = ? AND status = 'suggested' AND cover_letter IS NULL").run(candidateId);
        } else {
            const keep = matches.map(() => "?").join(",");
            db.prepare(`
                DELETE FROM matches
                WHERE candidate_id = ? AND status = 'suggested' AND cover_letter IS NULL AND job_id NOT IN (${keep})
            `).run(candidateId, ...matches.map((match) => match.jobId));
        }

        for (const match of matches) {
            upsert.run(candidateId, match.jobId, match.score, JSON.stringify(match.details), now, now);
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

export function getMatch(id: number): Match | undefined {
    const row = getDatabase().prepare("SELECT * FROM matches WHERE id = ?").get(id) as unknown as MatchRow | undefined;
    if (!row) return undefined;

    const job = getJob(row.job_id);
    return job && toMatch(row, job);
}

export interface MatchFilter {
    status?: MatchStatus;
    minScore?: number;
    limit?: number;
    offset?: number;
}

export function listMatches(candidateId: number, filter: MatchFilter = {}): Match[] {
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

    const rows = getDatabase()
        .prepare(`
            SELECT * FROM matches WHERE ${where.join(" AND ")}
            ORDER BY score DESC, id ASC LIMIT :limit OFFSET :offset
        `)
        .all({ ...params, limit: filter.limit ?? 50, offset: filter.offset ?? 0 }) as unknown as MatchRow[];

    return rows.flatMap((row) => {
        const job = getJob(row.job_id);
        return job ? [toMatch(row, job)] : [];
    });
}

export function saveDraft(id: number, subject: string, coverLetter: string): void {
    const now = new Date().toISOString();

    // A new draft must be looked at again, so any earlier approval is withdrawn
    getDatabase()
        .prepare(`
            UPDATE matches
            SET subject = ?, cover_letter = ?, drafted_at = ?, updated_at = ?,
                status = CASE WHEN status = 'approved' THEN 'suggested' ELSE status END,
                decided_at = CASE WHEN status = 'approved' THEN NULL ELSE decided_at END
            WHERE id = ?
        `)
        .run(subject, coverLetter, now, now, id);
}

export function setStatus(id: number, status: MatchStatus): void {
    const now = new Date().toISOString();

    getDatabase()
        .prepare("UPDATE matches SET status = ?, decided_at = ?, updated_at = ? WHERE id = ?")
        .run(status, status === "suggested" ? null : now, now, id);
}

/** Records that the user checked this address against the original advert. */
export function saveConfirmedEmail(id: number, address: string): void {
    getDatabase()
        .prepare("UPDATE matches SET confirmed_email = ?, updated_at = ? WHERE id = ?")
        .run(address.toLowerCase(), new Date().toISOString(), id);
}
