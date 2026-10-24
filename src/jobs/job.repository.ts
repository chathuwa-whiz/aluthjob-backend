import { getDatabase } from "../db/database.js";
import type { JobPosting, JobSourceId } from "./types.js";

export interface StoredJob extends JobPosting {
    id: number;
    enrichedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
}

interface JobRow {
    id: number;
    source: JobSourceId;
    external_id: string;
    url: string;
    title: string;
    company: string | null;
    location: string | null;
    description: string | null;
    job_type: string | null;
    salary: string | null;
    category: string | null;
    posted_at: string | null;
    closing_at: string | null;
    apply_email: string | null;
    apply_url: string | null;
    apply_email_source: "page" | "image" | null;
    enriched_at: string | null;
    first_seen_at: string;
    last_seen_at: string;
}

const toStoredJob = (row: JobRow): StoredJob => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    description: row.description,
    jobType: row.job_type,
    salary: row.salary,
    category: row.category,
    postedAt: row.posted_at,
    closingAt: row.closing_at,
    applyEmail: row.apply_email,
    applyUrl: row.apply_url,
    applyEmailSource: row.apply_email ? (row.apply_email_source ?? "page") : null,
    enrichedAt: row.enriched_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
});

/**
 * Inserts new vacancies and refreshes the ones already known. Columns that a listing
 * does not provide (description, apply email) are kept from an earlier detail fetch.
 */
export function upsertJobs(jobs: JobPosting[]): { inserted: number; updated: number } {
    const db = getDatabase();
    const now = new Date().toISOString();

    const exists = db.prepare("SELECT 1 FROM jobs WHERE source = ? AND external_id = ?");
    const upsert = db.prepare(`
        INSERT INTO jobs (source, external_id, url, title, company, location, description, job_type, salary,
                          category, posted_at, closing_at, apply_email, apply_email_source, apply_url, first_seen_at, last_seen_at)
        VALUES (:source, :externalId, :url, :title, :company, :location, :description, :jobType, :salary,
                :category, :postedAt, :closingAt, :applyEmail, :applyEmailSource, :applyUrl, :now, :now)
        ON CONFLICT (source, external_id) DO UPDATE SET
            url         = excluded.url,
            title       = excluded.title,
            company     = COALESCE(excluded.company, company),
            location    = COALESCE(excluded.location, location),
            description = CASE WHEN enriched_at IS NULL THEN COALESCE(excluded.description, description) ELSE description END,
            job_type    = COALESCE(excluded.job_type, job_type),
            salary      = COALESCE(excluded.salary, salary),
            category    = COALESCE(excluded.category, category),
            posted_at   = COALESCE(excluded.posted_at, posted_at),
            closing_at  = COALESCE(excluded.closing_at, closing_at),
            apply_email = COALESCE(excluded.apply_email, apply_email),
            apply_email_source = CASE WHEN excluded.apply_email IS NOT NULL THEN excluded.apply_email_source ELSE apply_email_source END,
            apply_url   = COALESCE(excluded.apply_url, apply_url),
            last_seen_at = excluded.last_seen_at
    `);

    let inserted = 0;
    let updated = 0;

    db.exec("BEGIN");
    try {
        for (const job of jobs) {
            if (exists.get(job.source, job.externalId)) updated++;
            else inserted++;

            upsert.run({ ...job, applyEmailSource: job.applyEmail ? (job.applyEmailSource ?? "page") : null, now } as unknown as Record<string, string | null>);
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }

    return { inserted, updated };
}

export function saveEnrichment(id: number, job: JobPosting): void {
    getDatabase()
        .prepare(`
            UPDATE jobs SET description = :description, apply_email = COALESCE(:applyEmail, apply_email),
                            apply_email_source = CASE WHEN :applyEmail IS NOT NULL THEN :applyEmailSource ELSE apply_email_source END,
                            company = COALESCE(:company, company), location = COALESCE(:location, location),
                            posted_at = COALESCE(:postedAt, posted_at), closing_at = COALESCE(:closingAt, closing_at),
                            enriched_at = :now
            WHERE id = :id
        `)
        .run({
            id,
            description: job.description,
            applyEmail: job.applyEmail,
            applyEmailSource: job.applyEmail ? (job.applyEmailSource ?? "page") : null,
            company: job.company,
            location: job.location,
            postedAt: job.postedAt,
            closingAt: job.closingAt,
            now: new Date().toISOString(),
        });
}

const MAX_ENRICH_FAILURES = 3;

export function recordEnrichmentFailure(id: number): void {
    getDatabase().prepare("UPDATE jobs SET enrich_failures = enrich_failures + 1 WHERE id = ?").run(id);
}

/** Open vacancies of a source whose detail page has not been read yet, newest first. */
export function listUnenriched(source: JobSourceId, limit: number): StoredJob[] {
    const rows = getDatabase()
        .prepare(`
            SELECT * FROM jobs
            WHERE source = :source AND enriched_at IS NULL AND enrich_failures < :maxFailures AND (closing_at IS NULL OR closing_at >= :today)
            ORDER BY first_seen_at DESC, id DESC LIMIT :limit
        `)
        .all({ source, today: new Date().toISOString(), limit, maxFailures: MAX_ENRICH_FAILURES }) as unknown as JobRow[];

    return rows.map(toStoredJob);
}

export function getJob(id: number): StoredJob | undefined {
    const row = getDatabase().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    return row && toStoredJob(row);
}

export interface JobFilter {
    source?: JobSourceId;
    search?: string;
    hasEmail?: boolean;
    openOnly?: boolean;
    /** ISO timestamp; skips vacancies that have vanished from their site since then. */
    seenSince?: string;
    limit?: number;
    offset?: number;
}

export function listJobs(filter: JobFilter = {}): StoredJob[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (filter.source) {
        where.push("source = :source");
        params.source = filter.source;
    }
    if (filter.search) {
        where.push("(title LIKE :search OR company LIKE :search OR description LIKE :search)");
        params.search = `%${filter.search}%`;
    }
    if (filter.hasEmail) where.push("apply_email IS NOT NULL");
    if (filter.seenSince) {
        where.push("last_seen_at >= :seenSince");
        params.seenSince = filter.seenSince;
    }
    if (filter.openOnly) {
        where.push("(closing_at IS NULL OR closing_at >= :today)");
        params.today = new Date().toISOString();
    }

    const sql = `
        SELECT * FROM jobs
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY COALESCE(posted_at, first_seen_at) DESC
        LIMIT :limit OFFSET :offset
    `;

    const rows = getDatabase()
        .prepare(sql)
        .all({ ...params, limit: filter.limit ?? 50, offset: filter.offset ?? 0 }) as unknown as JobRow[];

    return rows.map(toStoredJob);
}

export function countJobsBySource(): Record<string, number> {
    const rows = getDatabase().prepare("SELECT source, COUNT(*) AS n FROM jobs GROUP BY source").all() as unknown as {
        source: string;
        n: number;
    }[];
    return Object.fromEntries(rows.map((row) => [row.source, row.n]));
}
