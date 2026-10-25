import { getDatabase } from "../db/database.js";

// Read and write access for the administrators' console. Everything here works across accounts, so it is only
// ever reached through routes that sit behind requireAdmin (see routes/admin.routes.ts).
//
// Oracle notes that shape these queries: named binds that a statement does not use are dropped by the database
// layer, so a count query can share the bind object of its list query; text dates are ISO-8601 and compare as
// text; a CLOB can be searched with LIKE but is never selected in a list, only its length.

type Bind = string | number | null;
type Binds = Record<string, Bind>;

const db = () => getDatabase();
const now = () => new Date().toISOString();
const DAY_MS = 86_400_000;

/** Builds a WHERE clause from independent conditions. */
class Filter {
    private readonly clauses: string[] = [];
    readonly binds: Binds = {};

    add(clause: string, binds: Binds = {}): this {
        this.clauses.push(clause);
        Object.assign(this.binds, binds);
        return this;
    }

    get sql(): string {
        return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
    }
}

/** Oracle's LIKE is case-sensitive, so both sides are lowercased. */
const like = (text: string) => `%${text.trim().toLowerCase()}%`;

export interface Paging {
    limit: number;
    offset: number;
}

export interface Page<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}

async function paged<R, T>(
    query: { select: string; from: string; filter: Filter; order: string; binds?: Binds },
    paging: Paging,
    map: (row: R) => T,
): Promise<Page<T>> {
    const binds = { ...query.binds, ...query.filter.binds };
    const [rows, count] = await Promise.all([
        db().all<R>(`SELECT ${query.select} FROM ${query.from} ${query.filter.sql} ORDER BY ${query.order} OFFSET :off ROWS FETCH NEXT :lim ROWS ONLY`, {
            ...binds,
            off: paging.offset,
            lim: paging.limit,
        }),
        db().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${query.from} ${query.filter.sql}`, binds),
    ]);

    return { items: rows.map(map), total: count?.n ?? 0, limit: paging.limit, offset: paging.offset };
}

const flag = (value: unknown) => Number(value) === 1;

// ---- overview --------------------------------------------------------------------------

export interface DailyPoint {
    date: string;
    signups: number;
    jobs: number;
    sent: number;
    matches: number;
}

export interface SourceBreakdown {
    source: string;
    total: number;
    open: number;
    withEmail: number;
    unenriched: number;
    lastSeenAt: string | null;
}

export interface Overview {
    users: { total: number; verified: number; admins: number; last7Days: number; last30Days: number; liveSessions: number };
    candidates: { total: number; withoutOwner: number; mailboxes: number };
    jobs: { total: number; open: number; withEmail: number; unenriched: number; last24Hours: number; lastSeenAt: string | null };
    matches: Record<string, number>;
    applications: Record<string, number>;
    sources: SourceBreakdown[];
    daily: DailyPoint[];
}

/** One bucket per UTC day, oldest first, with days that had no rows filled in as zero. */
async function dailyCounts(table: string, column: string, days: number, condition = ""): Promise<Map<string, number>> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const since = new Date(start.getTime() - (days - 1) * DAY_MS).toISOString();

    const rows = await db().all<{ bucket: string; n: number }>(
        `SELECT SUBSTR(${column}, 1, 10) AS bucket, COUNT(*) AS n FROM ${table} WHERE ${column} >= :since ${condition} GROUP BY SUBSTR(${column}, 1, 10)`,
        { since },
    );

    return new Map(rows.map((row) => [row.bucket, row.n]));
}

export async function getOverview(days = 30): Promise<Overview> {
    const at = now();
    const t = Date.parse(at);

    const [totals, matchRows, applicationRows, sourceRows, signups, jobs, sent, matches] = await Promise.all([
        db().get<Record<string, number | string | null>>(
            `SELECT
                (SELECT COUNT(*) FROM users) AS users_total,
                (SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL) AS users_verified,
                (SELECT COUNT(*) FROM users WHERE role = 'admin') AS users_admins,
                (SELECT COUNT(*) FROM users WHERE created_at >= :d7) AS users_7d,
                (SELECT COUNT(*) FROM users WHERE created_at >= :d30) AS users_30d,
                (SELECT COUNT(*) FROM sessions WHERE expires_at > :ts) AS live_sessions,
                (SELECT COUNT(*) FROM candidates) AS candidates_total,
                (SELECT COUNT(*) FROM candidates WHERE user_id IS NULL) AS candidates_orphaned,
                (SELECT COUNT(*) FROM mail_accounts) AS mailboxes,
                (SELECT COUNT(*) FROM jobs) AS jobs_total,
                (SELECT COUNT(*) FROM jobs WHERE closing_at IS NULL OR closing_at >= :ts) AS jobs_open,
                (SELECT COUNT(*) FROM jobs WHERE apply_email IS NOT NULL) AS jobs_email,
                (SELECT COUNT(*) FROM jobs WHERE enriched_at IS NULL) AS jobs_unenriched,
                (SELECT COUNT(*) FROM jobs WHERE first_seen_at >= :d1) AS jobs_24h,
                (SELECT MAX(last_seen_at) FROM jobs) AS jobs_last_seen
             FROM dual`,
            { ts: at, d1: new Date(t - DAY_MS).toISOString(), d7: new Date(t - 7 * DAY_MS).toISOString(), d30: new Date(t - 30 * DAY_MS).toISOString() },
        ),
        db().all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM matches GROUP BY status"),
        db().all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM applications GROUP BY status"),
        db().all<{ source: string; total: number; open_jobs: number; with_email: number; unenriched: number; last_seen: string | null }>(
            `SELECT source,
                    COUNT(*) AS total,
                    SUM(CASE WHEN closing_at IS NULL OR closing_at >= :ts THEN 1 ELSE 0 END) AS open_jobs,
                    SUM(CASE WHEN apply_email IS NOT NULL THEN 1 ELSE 0 END) AS with_email,
                    SUM(CASE WHEN enriched_at IS NULL THEN 1 ELSE 0 END) AS unenriched,
                    MAX(last_seen_at) AS last_seen
             FROM jobs GROUP BY source ORDER BY COUNT(*) DESC`,
            { ts: at },
        ),
        dailyCounts("users", "created_at", days),
        dailyCounts("jobs", "first_seen_at", days),
        dailyCounts("applications", "sent_at", days, "AND status = 'sent'"),
        dailyCounts("matches", "created_at", days),
    ]);

    const n = (key: string) => Number(totals?.[key] ?? 0);

    const daily: DailyPoint[] = [];
    const today = new Date(at);
    today.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10);
        daily.push({ date, signups: signups.get(date) ?? 0, jobs: jobs.get(date) ?? 0, sent: sent.get(date) ?? 0, matches: matches.get(date) ?? 0 });
    }

    return {
        users: { total: n("users_total"), verified: n("users_verified"), admins: n("users_admins"), last7Days: n("users_7d"), last30Days: n("users_30d"), liveSessions: n("live_sessions") },
        candidates: { total: n("candidates_total"), withoutOwner: n("candidates_orphaned"), mailboxes: n("mailboxes") },
        jobs: {
            total: n("jobs_total"),
            open: n("jobs_open"),
            withEmail: n("jobs_email"),
            unenriched: n("jobs_unenriched"),
            last24Hours: n("jobs_24h"),
            lastSeenAt: (totals?.jobs_last_seen as string | null) ?? null,
        },
        matches: Object.fromEntries(matchRows.map((row) => [row.status, row.n])),
        applications: Object.fromEntries(applicationRows.map((row) => [row.status, row.n])),
        sources: sourceRows.map((row) => ({
            source: row.source,
            total: Number(row.total),
            open: Number(row.open_jobs),
            withEmail: Number(row.with_email),
            unenriched: Number(row.unenriched),
            lastSeenAt: row.last_seen,
        })),
        daily,
    };
}

// ---- users -----------------------------------------------------------------------------

export interface AdminUser {
    id: number;
    email: string;
    role: "user" | "admin";
    createdAt: string;
    lastLoginAt: string | null;
    emailVerified: boolean;
    resumes: number;
    liveSessions: number;
}

interface AdminUserRow {
    id: number;
    email: string;
    role: "user" | "admin";
    created_at: string;
    last_login_at: string | null;
    email_verified_at: string | null;
    resumes: number;
    live_sessions: number;
}

const USER_SELECT = `u.id, u.email, u.role, u.created_at, u.last_login_at, u.email_verified_at,
    (SELECT COUNT(*) FROM candidates c WHERE c.user_id = u.id) AS resumes,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > :ts) AS live_sessions`;

const toAdminUser = (row: AdminUserRow): AdminUser => ({
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    emailVerified: row.email_verified_at !== null,
    resumes: row.resumes,
    liveSessions: row.live_sessions,
});

const USER_ORDER = {
    newest: "u.id DESC",
    oldest: "u.id ASC",
    recent_login: "u.last_login_at DESC NULLS LAST, u.id DESC",
    email: "LOWER(u.email) ASC",
} as const;
export type UserSort = keyof typeof USER_ORDER;

export interface UserFilter extends Paging {
    search?: string;
    role?: "user" | "admin";
    verified?: boolean;
    sort?: UserSort;
}

export function listUsers(filter: UserFilter): Promise<Page<AdminUser>> {
    const where = new Filter();
    if (filter.search) where.add("LOWER(u.email) LIKE :search", { search: like(filter.search) });
    if (filter.role) where.add("u.role = :role", { role: filter.role });
    if (filter.verified !== undefined) where.add(filter.verified ? "u.email_verified_at IS NOT NULL" : "u.email_verified_at IS NULL");

    return paged<AdminUserRow, AdminUser>({ select: USER_SELECT, from: "users u", filter: where, order: USER_ORDER[filter.sort ?? "newest"], binds: { ts: now() } }, filter, toAdminUser);
}

export async function getAdminUser(id: number): Promise<AdminUser | undefined> {
    const row = await db().get<AdminUserRow>(`SELECT ${USER_SELECT} FROM users u WHERE u.id = :id`, { id, ts: now() });
    return row && toAdminUser(row);
}

export interface UserResume {
    id: number;
    fileName: string;
    fileBytes: number;
    createdAt: string;
    updatedAt: string;
    matches: number;
    sent: number;
    hasMailbox: boolean;
}

export interface UserSession {
    id: number;
    createdAt: string;
    expiresAt: string;
    userAgent: string | null;
    expired: boolean;
}

export async function getUserFootprint(id: number): Promise<{ resumes: UserResume[]; sessions: UserSession[] }> {
    const at = now();
    const [resumes, sessions] = await Promise.all([
        db().all<{ id: number; file_name: string; file_bytes: number; created_at: string; updated_at: string; match_count: number; sent_count: number; has_mailbox: number }>(
            `SELECT c.id, c.file_name, DBMS_LOB.GETLENGTH(c.file_data) AS file_bytes, c.created_at, c.updated_at,
                    (SELECT COUNT(*) FROM matches m WHERE m.candidate_id = c.id) AS match_count,
                    (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id AND a.status = 'sent') AS sent_count,
                    CASE WHEN EXISTS (SELECT 1 FROM mail_accounts ma WHERE ma.candidate_id = c.id) THEN 1 ELSE 0 END AS has_mailbox
             FROM candidates c WHERE c.user_id = :id ORDER BY c.id DESC`,
            { id },
        ),
        db().all<{ id: number; created_at: string; expires_at: string; user_agent: string | null }>(
            "SELECT id, created_at, expires_at, user_agent FROM sessions WHERE user_id = :id ORDER BY id DESC FETCH FIRST 50 ROWS ONLY",
            { id },
        ),
    ]);

    return {
        resumes: resumes.map((row) => ({
            id: row.id,
            fileName: row.file_name,
            fileBytes: Number(row.file_bytes ?? 0),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            matches: row.match_count,
            sent: row.sent_count,
            hasMailbox: flag(row.has_mailbox),
        })),
        sessions: sessions.map((row) => ({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, userAgent: row.user_agent, expired: row.expires_at <= at })),
    };
}

// ---- candidates (resumes) --------------------------------------------------------------

export interface AdminCandidate {
    id: number;
    userId: number | null;
    ownerEmail: string | null;
    fileName: string;
    mimeType: string;
    fileBytes: number;
    fullName: string | null;
    createdAt: string;
    updatedAt: string;
    matches: number;
    sent: number;
    hasMailbox: boolean;
}

interface AdminCandidateRow {
    id: number;
    user_id: number | null;
    owner_email: string | null;
    file_name: string;
    mime_type: string;
    file_bytes: number;
    profile_json: string;
    created_at: string;
    updated_at: string;
    match_count: number;
    sent_count: number;
    has_mailbox: number;
}

const CANDIDATE_FROM = "candidates c LEFT JOIN users u ON u.id = c.user_id";
const CANDIDATE_SELECT = `c.id, c.user_id, u.email AS owner_email, c.file_name, c.mime_type, DBMS_LOB.GETLENGTH(c.file_data) AS file_bytes,
    c.profile_json, c.created_at, c.updated_at,
    (SELECT COUNT(*) FROM matches m WHERE m.candidate_id = c.id) AS match_count,
    (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = c.id AND a.status = 'sent') AS sent_count,
    CASE WHEN EXISTS (SELECT 1 FROM mail_accounts ma WHERE ma.candidate_id = c.id) THEN 1 ELSE 0 END AS has_mailbox`;

/** The name read from a CV. A profile that does not parse is still listed; the detail screen shows what is stored. */
function profileName(profileJson: string): string | null {
    try {
        return (JSON.parse(profileJson) as { personalInfo?: { fullName?: string | null } }).personalInfo?.fullName ?? null;
    } catch {
        return null;
    }
}

function toAdminCandidate(row: AdminCandidateRow): AdminCandidate {
    const fullName = profileName(row.profile_json);

    return {
        id: row.id,
        userId: row.user_id,
        ownerEmail: row.owner_email,
        fileName: row.file_name,
        mimeType: row.mime_type,
        fileBytes: Number(row.file_bytes ?? 0),
        fullName,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        matches: row.match_count,
        sent: row.sent_count,
        hasMailbox: flag(row.has_mailbox),
    };
}

export interface CandidateFilter extends Paging {
    search?: string;
    userId?: number;
    orphaned?: boolean;
}

export function listCandidates(filter: CandidateFilter): Promise<Page<AdminCandidate>> {
    const where = new Filter();
    if (filter.search) {
        where.add("(LOWER(c.file_name) LIKE :search OR LOWER(u.email) LIKE :search OR LOWER(c.profile_json) LIKE :search)", { search: like(filter.search) });
    }
    if (filter.userId !== undefined) where.add("c.user_id = :userId", { userId: filter.userId });
    if (filter.orphaned) where.add("c.user_id IS NULL");

    return paged<AdminCandidateRow, AdminCandidate>({ select: CANDIDATE_SELECT, from: CANDIDATE_FROM, filter: where, order: "c.id DESC" }, filter, toAdminCandidate);
}

export async function getAdminCandidate(id: number): Promise<AdminCandidate | undefined> {
    const row = await db().get<AdminCandidateRow>(`SELECT ${CANDIDATE_SELECT} FROM ${CANDIDATE_FROM} WHERE c.id = :id`, { id });
    return row && toAdminCandidate(row);
}

// ---- jobs ------------------------------------------------------------------------------

export interface AdminJob {
    id: number;
    source: string;
    externalId: string;
    url: string;
    title: string;
    company: string | null;
    location: string | null;
    jobType: string | null;
    category: string | null;
    postedAt: string | null;
    closingAt: string | null;
    applyEmail: string | null;
    applyEmailSource: "page" | "image" | null;
    enrichedAt: string | null;
    enrichFailures: number;
    firstSeenAt: string;
    lastSeenAt: string;
    descriptionChars: number;
    matches: number;
}

interface AdminJobRow {
    id: number;
    source: string;
    external_id: string;
    url: string;
    title: string;
    company: string | null;
    location: string | null;
    job_type: string | null;
    category: string | null;
    posted_at: string | null;
    closing_at: string | null;
    apply_email: string | null;
    apply_email_source: "page" | "image" | null;
    enriched_at: string | null;
    enrich_failures: number;
    first_seen_at: string;
    last_seen_at: string;
    description_chars: number | null;
    match_count: number;
}

const JOB_SELECT = `j.id, j.source, j.external_id, j.url, j.title, j.company, j.location, j.job_type, j.category, j.posted_at, j.closing_at,
    j.apply_email, j.apply_email_source, j.enriched_at, j.enrich_failures, j.first_seen_at, j.last_seen_at,
    DBMS_LOB.GETLENGTH(j.description) AS description_chars,
    (SELECT COUNT(*) FROM matches m WHERE m.job_id = j.id) AS match_count`;

const toAdminJob = (row: AdminJobRow): AdminJob => ({
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    company: row.company,
    location: row.location,
    jobType: row.job_type,
    category: row.category,
    postedAt: row.posted_at,
    closingAt: row.closing_at,
    applyEmail: row.apply_email,
    applyEmailSource: row.apply_email ? (row.apply_email_source ?? "page") : null,
    enrichedAt: row.enriched_at,
    enrichFailures: row.enrich_failures,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    descriptionChars: Number(row.description_chars ?? 0),
    matches: row.match_count,
});

const JOB_ORDER = {
    newest: "COALESCE(j.posted_at, j.first_seen_at) DESC, j.id DESC",
    first_seen: "j.first_seen_at DESC, j.id DESC",
    last_seen: "j.last_seen_at DESC, j.id DESC",
    closing: "j.closing_at ASC NULLS LAST, j.id DESC",
    most_matched: "(SELECT COUNT(*) FROM matches m WHERE m.job_id = j.id) DESC, j.id DESC",
} as const;
export type JobSort = keyof typeof JOB_ORDER;

export interface AdminJobFilter extends Paging {
    source?: string;
    search?: string;
    hasEmail?: boolean;
    openOnly?: boolean;
    closedOnly?: boolean;
    enriched?: boolean;
    emailSource?: "page" | "image";
    sort?: JobSort;
}

export function listAdminJobs(filter: AdminJobFilter): Promise<Page<AdminJob>> {
    const where = new Filter();
    if (filter.source) where.add("j.source = :source", { source: filter.source });
    if (filter.search) {
        where.add("(LOWER(j.title) LIKE :search OR LOWER(j.company) LIKE :search OR LOWER(j.location) LIKE :search OR LOWER(j.apply_email) LIKE :search)", {
            search: like(filter.search),
        });
    }
    if (filter.hasEmail !== undefined) where.add(filter.hasEmail ? "j.apply_email IS NOT NULL" : "j.apply_email IS NULL");
    if (filter.openOnly) where.add("(j.closing_at IS NULL OR j.closing_at >= :today)", { today: now() });
    if (filter.closedOnly) where.add("(j.closing_at IS NOT NULL AND j.closing_at < :today)", { today: now() });
    if (filter.enriched !== undefined) where.add(filter.enriched ? "j.enriched_at IS NOT NULL" : "j.enriched_at IS NULL");
    if (filter.emailSource === "image") where.add("(j.apply_email IS NOT NULL AND j.apply_email_source = 'image')");
    if (filter.emailSource === "page") where.add("(j.apply_email IS NOT NULL AND (j.apply_email_source IS NULL OR j.apply_email_source = 'page'))");

    return paged<AdminJobRow, AdminJob>({ select: JOB_SELECT, from: "jobs j", filter: where, order: JOB_ORDER[filter.sort ?? "newest"] }, filter, toAdminJob);
}

export async function getAdminJob(id: number): Promise<(AdminJob & { description: string | null; salary: string | null; applyUrl: string | null }) | undefined> {
    const row = await db().get<AdminJobRow & { description: string | null; salary: string | null; apply_url: string | null }>(
        `SELECT ${JOB_SELECT}, j.description, j.salary, j.apply_url FROM jobs j WHERE j.id = :id`,
        { id },
    );

    return row && { ...toAdminJob(row), description: row.description, salary: row.salary, applyUrl: row.apply_url };
}

/** Fields an administrator may correct by hand, with the size of the column that holds each. */
export const JOB_FIELDS = {
    title: { column: "title", max: 1000 },
    company: { column: "company", max: 1000 },
    location: { column: "location", max: 1000 },
    jobType: { column: "job_type", max: 200 },
    salary: { column: "salary", max: 500 },
    category: { column: "category", max: 500 },
    postedAt: { column: "posted_at", max: 40 },
    closingAt: { column: "closing_at", max: 40 },
    applyEmail: { column: "apply_email", max: 320 },
    applyUrl: { column: "apply_url", max: 2000 },
    description: { column: "description", max: 200_000 },
} as const;
export type JobField = keyof typeof JOB_FIELDS;

export async function updateJobFields(id: number, changes: Partial<Record<JobField, string | null>>): Promise<boolean> {
    const sets: string[] = [];
    const binds: Binds = { id };

    for (const [field, value] of Object.entries(changes) as [JobField, string | null][]) {
        const spec = JOB_FIELDS[field];
        sets.push(`${spec.column} = :${field}`);
        binds[field] = value;
    }
    if (sets.length === 0) return false;

    // A new employer address keeps the way it was found ("image" still has to be confirmed by the applicant)
    if ("applyEmail" in changes) sets.push("apply_email_source = CASE WHEN :applyEmail IS NULL THEN NULL ELSE COALESCE(apply_email_source, 'page') END");

    return (await db().run(`UPDATE jobs SET ${sets.join(", ")} WHERE id = :id`, binds)).changes === 1;
}

/** Makes a vacancy read again: forgets the earlier read and the failures that parked it. */
export async function resetEnrichment(id: number): Promise<void> {
    await db().run("UPDATE jobs SET enriched_at = NULL, enrich_failures = 0 WHERE id = :id", { id });
}

export async function deleteJob(id: number): Promise<boolean> {
    return (await db().run("DELETE FROM jobs WHERE id = :id", { id })).changes > 0;
}

export async function deleteJobs(ids: number[]): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        deleted += (await db().run(`DELETE FROM jobs WHERE id IN (${part.map(() => "?").join(",")})`, part)).changes;
    }
    return deleted;
}

/** Removes vacancies whose closing date passed more than `days` days ago, together with their matches. */
export async function purgeClosedJobs(days: number, source?: string): Promise<number> {
    const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
    return (
        await db().run(`DELETE FROM jobs WHERE closing_at IS NOT NULL AND closing_at < :cutoff ${source ? "AND source = :source" : ""}`, {
            cutoff,
            ...(source ? { source } : {}),
        })
    ).changes;
}

// ---- matches ---------------------------------------------------------------------------

export interface AdminMatch {
    id: number;
    candidateId: number;
    jobId: number;
    score: number;
    status: string;
    hasLetter: boolean;
    createdAt: string;
    decidedAt: string | null;
    jobTitle: string;
    company: string | null;
    source: string;
    candidateName: string | null;
    ownerEmail: string | null;
    applicationStatus: string | null;
}

interface AdminMatchRow {
    id: number;
    candidate_id: number;
    job_id: number;
    score: number;
    status: string;
    has_letter: number;
    created_at: string;
    decided_at: string | null;
    job_title: string;
    company: string | null;
    source: string;
    file_name: string;
    profile_json: string;
    owner_email: string | null;
    application_status: string | null;
}

const MATCH_FROM = `matches m
    JOIN jobs j ON j.id = m.job_id
    JOIN candidates c ON c.id = m.candidate_id
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN applications a ON a.match_id = m.id`;

const MATCH_SELECT = `m.id, m.candidate_id, m.job_id, m.score, m.status,
    CASE WHEN m.cover_letter IS NULL THEN 0 ELSE 1 END AS has_letter,
    m.created_at, m.decided_at, j.title AS job_title, j.company, j.source, c.file_name, c.profile_json,
    u.email AS owner_email, a.status AS application_status`;

function toAdminMatch(row: AdminMatchRow): AdminMatch {
    return {
        id: row.id,
        candidateId: row.candidate_id,
        jobId: row.job_id,
        score: row.score,
        status: row.status,
        hasLetter: flag(row.has_letter),
        createdAt: row.created_at,
        decidedAt: row.decided_at,
        jobTitle: row.job_title,
        company: row.company,
        source: row.source,
        candidateName: profileName(row.profile_json) ?? row.file_name,
        ownerEmail: row.owner_email,
        applicationStatus: row.application_status,
    };
}

export interface AdminMatchFilter extends Paging {
    status?: string;
    minScore?: number;
    candidateId?: number;
    jobId?: number;
    search?: string;
    sort?: "score" | "newest";
}

export function listAdminMatches(filter: AdminMatchFilter): Promise<Page<AdminMatch>> {
    const where = new Filter();
    if (filter.status) where.add("m.status = :status", { status: filter.status });
    if (filter.minScore !== undefined) where.add("m.score >= :minScore", { minScore: filter.minScore });
    if (filter.candidateId !== undefined) where.add("m.candidate_id = :candidateId", { candidateId: filter.candidateId });
    if (filter.jobId !== undefined) where.add("m.job_id = :jobId", { jobId: filter.jobId });
    if (filter.search) where.add("(LOWER(j.title) LIKE :search OR LOWER(j.company) LIKE :search OR LOWER(u.email) LIKE :search OR LOWER(c.file_name) LIKE :search)", { search: like(filter.search) });

    return paged<AdminMatchRow, AdminMatch>(
        { select: MATCH_SELECT, from: MATCH_FROM, filter: where, order: filter.sort === "newest" ? "m.id DESC" : "m.score DESC, m.id DESC" },
        filter,
        toAdminMatch,
    );
}

export async function matchOwner(id: number): Promise<{ candidateId: number; ownerEmail: string | null; candidateName: string | null; applicationId: number | null } | undefined> {
    const row = await db().get<{ candidate_id: number; owner_email: string | null; file_name: string; profile_json: string; application_id: number | null }>(
        `SELECT m.candidate_id, u.email AS owner_email, c.file_name, c.profile_json, a.id AS application_id
         FROM matches m JOIN candidates c ON c.id = m.candidate_id LEFT JOIN users u ON u.id = c.user_id LEFT JOIN applications a ON a.match_id = m.id
         WHERE m.id = :id`,
        { id },
    );
    if (!row) return undefined;

    return { candidateId: row.candidate_id, ownerEmail: row.owner_email, candidateName: profileName(row.profile_json) ?? row.file_name, applicationId: row.application_id };
}

export async function deleteMatch(id: number): Promise<boolean> {
    return (await db().run("DELETE FROM matches WHERE id = :id", { id })).changes > 0;
}

// ---- applications (the send queue) -----------------------------------------------------

export interface AdminApplication {
    id: number;
    matchId: number;
    candidateId: number;
    toEmail: string;
    status: string;
    attempts: number;
    nextAttemptAt: string;
    error: string | null;
    queuedAt: string;
    sentAt: string | null;
    updatedAt: string;
    jobTitle: string;
    company: string | null;
    ownerEmail: string | null;
}

interface AdminApplicationRow {
    id: number;
    match_id: number;
    candidate_id: number;
    to_email: string;
    status: string;
    attempts: number;
    next_attempt_at: string;
    error: string | null;
    queued_at: string;
    sent_at: string | null;
    updated_at: string;
    job_title: string;
    company: string | null;
    owner_email: string | null;
}

const APPLICATION_FROM = `applications a
    JOIN matches m ON m.id = a.match_id
    JOIN jobs j ON j.id = m.job_id
    JOIN candidates c ON c.id = a.candidate_id
    LEFT JOIN users u ON u.id = c.user_id`;

const APPLICATION_SELECT = `a.id, a.match_id, a.candidate_id, a.to_email, a.status, a.attempts, a.next_attempt_at, a.error, a.queued_at, a.sent_at, a.updated_at,
    j.title AS job_title, j.company, u.email AS owner_email`;

const toAdminApplication = (row: AdminApplicationRow): AdminApplication => ({
    id: row.id,
    matchId: row.match_id,
    candidateId: row.candidate_id,
    toEmail: row.to_email,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
    jobTitle: row.job_title,
    company: row.company,
    ownerEmail: row.owner_email,
});

export interface AdminApplicationFilter extends Paging {
    status?: string;
    candidateId?: number;
    search?: string;
}

export function listAdminApplications(filter: AdminApplicationFilter): Promise<Page<AdminApplication>> {
    const where = new Filter();
    if (filter.status) where.add("a.status = :status", { status: filter.status });
    if (filter.candidateId !== undefined) where.add("a.candidate_id = :candidateId", { candidateId: filter.candidateId });
    if (filter.search) where.add("(LOWER(a.to_email) LIKE :search OR LOWER(j.title) LIKE :search OR LOWER(j.company) LIKE :search OR LOWER(u.email) LIKE :search)", { search: like(filter.search) });

    return paged<AdminApplicationRow, AdminApplication>({ select: APPLICATION_SELECT, from: APPLICATION_FROM, filter: where, order: "a.id DESC" }, filter, toAdminApplication);
}

export async function getAdminApplication(id: number): Promise<(AdminApplication & { messageId: string | null; sentSubject: string | null; sentBody: string | null }) | undefined> {
    const row = await db().get<AdminApplicationRow & { message_id: string | null; sent_subject: string | null; sent_body: string | null }>(
        `SELECT ${APPLICATION_SELECT}, a.message_id, a.sent_subject, a.sent_body FROM ${APPLICATION_FROM} WHERE a.id = :id`,
        { id },
    );

    return row && { ...toAdminApplication(row), messageId: row.message_id, sentSubject: row.sent_subject, sentBody: row.sent_body };
}

/** Everything still waiting is cancelled at once: the emergency brake. Applications already sending cannot be stopped. */
export async function cancelAllQueued(reason: string): Promise<number> {
    return (await db().run("UPDATE applications SET status = 'cancelled', error = :reason, updated_at = :ts WHERE status = 'queued'", { reason, ts: now() })).changes;
}

export async function deleteApplication(id: number): Promise<boolean> {
    return (await db().run("DELETE FROM applications WHERE id = :id AND status <> 'sending'", { id })).changes > 0;
}

export async function queueDepth(): Promise<{ queued: number; dueNow: number; oldestQueuedAt: string | null }> {
    const row = await db().get<{ queued: number; due_now: number; oldest: string | null }>(
        `SELECT COUNT(*) AS queued, SUM(CASE WHEN next_attempt_at <= :ts THEN 1 ELSE 0 END) AS due_now, MIN(queued_at) AS oldest
         FROM applications WHERE status = 'queued'`,
        { ts: now() },
    );

    return { queued: Number(row?.queued ?? 0), dueNow: Number(row?.due_now ?? 0), oldestQueuedAt: row?.oldest ?? null };
}

// ---- mailboxes -------------------------------------------------------------------------

export interface AdminMailbox {
    candidateId: number;
    email: string;
    fromName: string | null;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    verifiedAt: string;
    updatedAt: string;
    resume: string;
    ownerEmail: string | null;
    sent: number;
}

/** Never includes the stored password, encrypted or not. */
export function listMailboxes(filter: Paging & { search?: string }): Promise<Page<AdminMailbox>> {
    const where = new Filter();
    if (filter.search) where.add("(LOWER(ma.email) LIKE :search OR LOWER(ma.host) LIKE :search OR LOWER(u.email) LIKE :search)", { search: like(filter.search) });

    return paged<
        { candidate_id: number; email: string; from_name: string | null; host: string; port: number; secure: number; username: string; verified_at: string; updated_at: string; file_name: string; owner_email: string | null; sent_total: number },
        AdminMailbox
    >(
        {
            select: `ma.candidate_id, ma.email, ma.from_name, ma.host, ma.port, ma.secure, ma.username, ma.verified_at, ma.updated_at, c.file_name, u.email AS owner_email,
                (SELECT COUNT(*) FROM applications a WHERE a.candidate_id = ma.candidate_id AND a.status = 'sent') AS sent_total`,
            from: "mail_accounts ma JOIN candidates c ON c.id = ma.candidate_id LEFT JOIN users u ON u.id = c.user_id",
            filter: where,
            order: "ma.updated_at DESC",
        },
        filter,
        (row) => ({
            candidateId: row.candidate_id,
            email: row.email,
            fromName: row.from_name,
            host: row.host,
            port: row.port,
            secure: flag(row.secure),
            username: row.username,
            verifiedAt: row.verified_at,
            updatedAt: row.updated_at,
            resume: row.file_name,
            ownerEmail: row.owner_email,
            sent: row.sent_total,
        }),
    );
}

// ---- sessions --------------------------------------------------------------------------

export interface AdminSession {
    id: number;
    userId: number;
    email: string;
    role: string;
    createdAt: string;
    expiresAt: string;
    userAgent: string | null;
    current: boolean;
}

export function listSessions(filter: Paging & { userId?: number; search?: string }, currentTokenHash: string): Promise<Page<AdminSession>> {
    const where = new Filter().add("s.expires_at > :ts", { ts: now() });
    if (filter.userId !== undefined) where.add("s.user_id = :userId", { userId: filter.userId });
    if (filter.search) where.add("LOWER(u.email) LIKE :search", { search: like(filter.search) });

    return paged<{ id: number; user_id: number; email: string; role: string; created_at: string; expires_at: string; user_agent: string | null; is_current: number }, AdminSession>(
        {
            select: "s.id, s.user_id, u.email, u.role, s.created_at, s.expires_at, s.user_agent, CASE WHEN s.token_hash = :me THEN 1 ELSE 0 END AS is_current",
            from: "sessions s JOIN users u ON u.id = s.user_id",
            filter: where,
            order: "s.id DESC",
            binds: { me: currentTokenHash },
        },
        filter,
        (row) => ({
            id: row.id,
            userId: row.user_id,
            email: row.email,
            role: row.role,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            userAgent: row.user_agent,
            current: flag(row.is_current),
        }),
    );
}

export async function deleteSessionById(id: number): Promise<boolean> {
    return (await db().run("DELETE FROM sessions WHERE id = :id", { id })).changes > 0;
}

// ---- audit trail -----------------------------------------------------------------------

export interface AuditEntry {
    id: number;
    adminId: number;
    adminEmail: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    summary: string | null;
    ip: string | null;
    createdAt: string;
}

export async function writeAudit(entry: Omit<AuditEntry, "id" | "createdAt">): Promise<void> {
    await db().run(
        "INSERT INTO admin_audit (admin_id, admin_email, action, target_type, target_id, summary, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            entry.adminId,
            entry.adminEmail,
            entry.action.slice(0, 80),
            entry.targetType?.slice(0, 40) ?? null,
            entry.targetId?.slice(0, 80) ?? null,
            entry.summary?.slice(0, 1000) ?? null,
            entry.ip?.slice(0, 80) ?? null,
            now(),
        ],
    );
}

export function listAudit(filter: Paging & { search?: string; action?: string }): Promise<Page<AuditEntry>> {
    const where = new Filter();
    if (filter.action) where.add("action = :action", { action: filter.action });
    if (filter.search) where.add("(LOWER(admin_email) LIKE :search OR LOWER(summary) LIKE :search OR LOWER(target_id) LIKE :search OR LOWER(action) LIKE :search)", { search: like(filter.search) });

    return paged<{ id: number; admin_id: number; admin_email: string; action: string; target_type: string | null; target_id: string | null; summary: string | null; ip: string | null; created_at: string }, AuditEntry>(
        { select: "id, admin_id, admin_email, action, target_type, target_id, summary, ip, created_at", from: "admin_audit", filter: where, order: "id DESC" },
        filter,
        (row) => ({
            id: row.id,
            adminId: row.admin_id,
            adminEmail: row.admin_email,
            action: row.action,
            targetType: row.target_type,
            targetId: row.target_id,
            summary: row.summary,
            ip: row.ip,
            createdAt: row.created_at,
        }),
    );
}

export async function auditActions(): Promise<string[]> {
    return (await db().all<{ action: string }>("SELECT DISTINCT action FROM admin_audit ORDER BY action")).map((row) => row.action);
}
