import { getDatabase, isUniqueViolation } from "../db/database.js";

export type AlertFrequency = "daily" | "weekly" | "off";

export interface AlertPreferences {
    frequency: AlertFrequency;
    /** Only matches scoring at least this are announced. */
    minScore: number;
    pausedUntil: string | null;
    lastCheckedAt: string | null;
    lastSentAt: string | null;
}

export const DEFAULT_MIN_SCORE = 55;

interface PreferenceRow {
    frequency: AlertFrequency;
    min_score: number;
    paused_until: string | null;
    last_checked_at: string | null;
    last_sent_at: string | null;
}

const toPreferences = (row: PreferenceRow | undefined): AlertPreferences => ({
    frequency: row?.frequency ?? "daily",
    minScore: row?.min_score ?? DEFAULT_MIN_SCORE,
    pausedUntil: row?.paused_until ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
    lastSentAt: row?.last_sent_at ?? null,
});

const db = () => getDatabase();

export async function getPreferences(userId: number): Promise<AlertPreferences> {
    return toPreferences(await db().get<PreferenceRow>("SELECT * FROM alert_preferences WHERE user_id = ?", [userId]));
}

export interface PreferenceChange {
    frequency?: AlertFrequency;
    minScore?: number;
    /** A time to stay quiet until, or null to lift a pause. */
    pausedUntil?: string | null;
    lastCheckedAt?: string;
    lastSentAt?: string;
}

const COLUMNS: Record<keyof PreferenceChange, string> = {
    frequency: "frequency",
    minScore: "min_score",
    pausedUntil: "paused_until",
    lastCheckedAt: "last_checked_at",
    lastSentAt: "last_sent_at",
};

/** Creates the row on first use, then changes only the fields given. */
export async function savePreferences(userId: number, change: PreferenceChange): Promise<AlertPreferences> {
    const now = new Date().toISOString();
    const fields = (Object.keys(change) as (keyof PreferenceChange)[]).filter((name) => change[name] !== undefined);

    const update = () =>
        db().run(`UPDATE alert_preferences SET ${[...fields.map((name) => `${COLUMNS[name]} = ?`), "updated_at = ?"].join(", ")} WHERE user_id = ?`, [
            ...fields.map((name) => change[name]),
            now,
            userId,
        ]);

    if ((await update()).changes === 0) {
        try {
            await db().run("INSERT INTO alert_preferences (user_id, updated_at) VALUES (?, ?)", [userId, now]);
        } catch (error) {
            if (!isUniqueViolation(error)) throw error; // two requests created it at once
        }
        await update();
    }

    return getPreferences(userId);
}

// ---- who to look at -----------------------------------------------------------------------------------------

export interface Recipient extends AlertPreferences {
    userId: number;
    email: string;
    createdAt: string;
    lastLoginAt: string | null;
}

/** Confirmed accounts that have a CV and have not switched alerts off. Pausing and pacing are decided by the caller. */
export async function listRecipients(): Promise<Recipient[]> {
    const rows = await db().all<PreferenceRow & { id: number; email: string; created_at: string; last_login_at: string | null }>(
        `SELECT u.id, u.email, u.created_at, u.last_login_at,
                COALESCE(p.frequency, 'daily') AS frequency, COALESCE(p.min_score, ${DEFAULT_MIN_SCORE}) AS min_score,
                p.paused_until, p.last_checked_at, p.last_sent_at
         FROM users u LEFT JOIN alert_preferences p ON p.user_id = u.id
         WHERE u.email_verified_at IS NOT NULL
           AND COALESCE(p.frequency, 'daily') <> 'off'
           AND EXISTS (SELECT 1 FROM candidates c WHERE c.user_id = u.id)
         ORDER BY u.id`,
    );

    return rows.map((row) => ({ ...toPreferences(row), userId: row.id, email: row.email, createdAt: row.created_at, lastLoginAt: row.last_login_at }));
}

/** The user's most recently uploaded CV: the one new jobs are matched against. */
export async function latestCandidateId(userId: number): Promise<number | undefined> {
    return (await db().get<{ id: number }>("SELECT id FROM candidates WHERE user_id = ? ORDER BY id DESC FETCH FIRST 1 ROWS ONLY", [userId]))?.id;
}

// ---- what is new --------------------------------------------------------------------------------------------

export interface PendingMatch {
    id: number;
    score: number;
}

/**
 * Suggestions that qualify, are still open, and were never put in an alert (or counted in an "and N more"),
 * best first. Rejected and approved matches are the user's own business and never come back as news.
 */
export async function pendingMatches(userId: number, minScore: number): Promise<PendingMatch[]> {
    return db().all<PendingMatch>(
        `SELECT m.id, m.score
         FROM matches m
         JOIN candidates c ON c.id = m.candidate_id
         JOIN jobs j ON j.id = m.job_id
         WHERE c.user_id = :userId
           AND m.status = 'suggested'
           AND m.score >= :minScore
           AND (j.closing_at IS NULL OR j.closing_at >= :now)
           AND NOT EXISTS (SELECT 1 FROM match_alerts a WHERE a.match_id = m.id)
         ORDER BY m.score DESC, m.id ASC
         FETCH FIRST 500 ROWS ONLY`,
        { userId, minScore, now: new Date().toISOString() },
    );
}

/** Remembers that these matches were announced (`shown`) or only counted, so none is announced twice. */
export async function recordAlerted(userId: number, shown: number[], counted: number[]): Promise<void> {
    const now = new Date().toISOString();

    await db().transaction(async (tx) => {
        for (const [ids, flag] of [[shown, 1], [counted, 0]] as const) {
            for (const matchId of ids) {
                try {
                    await tx.run("INSERT INTO match_alerts (match_id, user_id, shown, sent_at) VALUES (?, ?, ?, ?)", [matchId, userId, flag, now]);
                } catch (error) {
                    if (!isUniqueViolation(error)) throw error;
                }
            }
        }
    });
}

/** Whether this match belongs to the user, for the "not for me" link. */
export async function ownsMatch(userId: number, matchId: number): Promise<boolean> {
    return Boolean(await db().get("SELECT 1 FROM matches m JOIN candidates c ON c.id = m.candidate_id WHERE m.id = ? AND c.user_id = ?", [matchId, userId]));
}
