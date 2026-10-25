import { getDatabase, isUniqueViolation } from "../db/database.js";

export type ApplicationStatus = "queued" | "sending" | "sent" | "failed" | "cancelled";

export interface Application {
    id: number;
    matchId: number;
    candidateId: number;
    toEmail: string;
    status: ApplicationStatus;
    attempts: number;
    nextAttemptAt: string;
    error: string | null;
    messageId: string | null;
    sentSubject: string | null;
    sentBody: string | null;
    queuedAt: string;
    sentAt: string | null;
    updatedAt: string;
}

interface ApplicationRow {
    id: number;
    match_id: number;
    candidate_id: number;
    to_email: string;
    status: ApplicationStatus;
    attempts: number;
    next_attempt_at: string;
    error: string | null;
    message_id: string | null;
    sent_subject: string | null;
    sent_body: string | null;
    queued_at: string;
    sent_at: string | null;
    updated_at: string;
}

const toApplication = (row: ApplicationRow): Application => ({
    id: row.id,
    matchId: row.match_id,
    candidateId: row.candidate_id,
    toEmail: row.to_email,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    messageId: row.message_id,
    sentSubject: row.sent_subject,
    sentBody: row.sent_body,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
});

const db = () => getDatabase();
const now = () => new Date().toISOString();
/** The error column holds 4000 characters; a longer message must not make recording a failure fail. */
const cut = (text: string | null, max: number) => (text === null ? null : text.slice(0, max));

export async function getApplication(id: number): Promise<Application | undefined> {
    const row = await db().get<ApplicationRow>("SELECT * FROM applications WHERE id = ?", [id]);
    return row && toApplication(row);
}

export async function getApplicationByMatch(matchId: number): Promise<Application | undefined> {
    const row = await db().get<ApplicationRow>("SELECT * FROM applications WHERE match_id = ?", [matchId]);
    return row && toApplication(row);
}

export async function listApplications(candidateId: number, status?: ApplicationStatus): Promise<Application[]> {
    const rows = await db().all<ApplicationRow>(
        `SELECT * FROM applications WHERE candidate_id = ? ${status ? "AND status = ?" : ""} ORDER BY id DESC FETCH FIRST 200 ROWS ONLY`,
        status ? [candidateId, status] : [candidateId],
    );

    return rows.map(toApplication);
}

/** Puts a match in the queue. The UNIQUE(match_id) constraint makes queueing idempotent. */
export async function enqueue(matchId: number, candidateId: number, toEmail: string): Promise<{ application: Application; created: boolean }> {
    const existing = await getApplicationByMatch(matchId);
    if (existing) return { application: existing, created: false };

    const at = now();
    try {
        const id = await db().insert(
            `INSERT INTO applications (match_id, candidate_id, to_email, status, next_attempt_at, queued_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
            [matchId, candidateId, toEmail, at, at, at],
        );

        return { application: (await getApplication(id))!, created: true };
    } catch (error) {
        // two requests queued the same match at once; the loser gets the winner's row
        const raced = isUniqueViolation(error) ? await getApplicationByMatch(matchId) : undefined;
        if (raced) return { application: raced, created: false };
        throw error;
    }
}

/** The next queued application that is due, oldest first. */
export async function nextDue(): Promise<Application | undefined> {
    const row = await db().get<ApplicationRow>(
        "SELECT * FROM applications WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id FETCH FIRST 1 ROWS ONLY",
        [now()],
    );

    return row && toApplication(row);
}

/**
 * Atomically takes an application for sending. The conditional UPDATE means that even two
 * workers racing for the same row cannot both win, so no message is ever sent twice.
 */
export async function claim(id: number): Promise<Application | undefined> {
    const result = await db().run("UPDATE applications SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'", [now(), id]);

    return result.changes === 1 ? getApplication(id) : undefined;
}

export async function markSent(id: number, details: { messageId: string; subject: string; body: string }): Promise<void> {
    const at = now();
    await db().run(
        `UPDATE applications
         SET status = 'sent', error = NULL, message_id = ?, sent_subject = ?, sent_body = ?, sent_at = ?, updated_at = ?
         WHERE id = ?`,
        [cut(details.messageId, 500), cut(details.subject, 1000), details.body, at, at, id],
    );
}

export async function markFailed(id: number, error: string): Promise<void> {
    await db().run("UPDATE applications SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [cut(error, 4000), now(), id]);
}

export async function requeue(id: number, error: string | null, notBefore: Date): Promise<void> {
    await db().run("UPDATE applications SET status = 'queued', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?", [cut(error, 4000), notBefore.toISOString(), now(), id]);
}

/** Only queued applications can be cancelled; once sending has started it cannot be taken back. */
export async function cancel(id: number, reason: string | null = null): Promise<boolean> {
    return (await db().run("UPDATE applications SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [cut(reason, 4000), now(), id])).changes === 1;
}

/** A user-requested retry of a failed application. */
export async function retry(id: number): Promise<boolean> {
    const at = now();
    return (
        await db().run("UPDATE applications SET status = 'queued', error = NULL, attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'", [at, at, id])
    ).changes === 1;
}

/** Messages sent (or being sent) for a candidate since the given time; drives the daily limit. */
export async function countSentSince(candidateId: number, since: Date): Promise<number> {
    const row = await db().get<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ? AND status IN ('sent', 'sending') AND updated_at >= ?", [candidateId, since.toISOString()]);

    return row!.n;
}

export async function lastSentAt(candidateId: number): Promise<Date | undefined> {
    const row = await db().get<{ latest: string | null }>("SELECT MAX(updated_at) AS latest FROM applications WHERE candidate_id = ? AND status IN ('sent', 'sending')", [candidateId]);

    return row?.latest ? new Date(row.latest) : undefined;
}

/**
 * After a crash an application can be left in 'sending' with no way to know whether the mail
 * left the building. It is never retried automatically: the user is told to check the Sent
 * folder and can retry by hand.
 */
export async function failInterrupted(): Promise<number> {
    return (
        await db().run("UPDATE applications SET status = 'failed', error = ?, updated_at = ? WHERE status = 'sending'", [
            "Interrupted while sending. Check the Sent folder of your mailbox before retrying, to avoid a duplicate.",
            now(),
        ])
    ).changes;
}
