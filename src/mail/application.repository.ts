import { getDatabase } from "../db/database.js";

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

export function getApplication(id: number): Application | undefined {
    const row = db().prepare("SELECT * FROM applications WHERE id = ?").get(id) as unknown as ApplicationRow | undefined;
    return row && toApplication(row);
}

export function getApplicationByMatch(matchId: number): Application | undefined {
    const row = db().prepare("SELECT * FROM applications WHERE match_id = ?").get(matchId) as unknown as ApplicationRow | undefined;
    return row && toApplication(row);
}

export function listApplications(candidateId: number, status?: ApplicationStatus): Application[] {
    const rows = db()
        .prepare(`SELECT * FROM applications WHERE candidate_id = ? ${status ? "AND status = ?" : ""} ORDER BY id DESC LIMIT 200`)
        .all(...(status ? [candidateId, status] : [candidateId])) as unknown as ApplicationRow[];

    return rows.map(toApplication);
}

/** Puts a match in the queue. The UNIQUE(match_id) constraint makes queueing idempotent. */
export function enqueue(matchId: number, candidateId: number, toEmail: string): { application: Application; created: boolean } {
    const existing = getApplicationByMatch(matchId);
    if (existing) return { application: existing, created: false };

    const at = now();
    const result = db()
        .prepare(`
            INSERT INTO applications (match_id, candidate_id, to_email, status, next_attempt_at, queued_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, ?)
        `)
        .run(matchId, candidateId, toEmail, at, at, at);

    return { application: getApplication(Number(result.lastInsertRowid))!, created: true };
}

/** The next queued application that is due, oldest first. */
export function nextDue(): Application | undefined {
    const row = db()
        .prepare("SELECT * FROM applications WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 1")
        .get(now()) as unknown as ApplicationRow | undefined;

    return row && toApplication(row);
}

/**
 * Atomically takes an application for sending. The conditional UPDATE means that even two
 * workers racing for the same row cannot both win, so no message is ever sent twice.
 */
export function claim(id: number): Application | undefined {
    const result = db()
        .prepare("UPDATE applications SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(now(), id);

    return result.changes === 1 ? getApplication(id) : undefined;
}

export function markSent(id: number, details: { messageId: string; subject: string; body: string }): void {
    const at = now();
    db()
        .prepare(`
            UPDATE applications
            SET status = 'sent', error = NULL, message_id = ?, sent_subject = ?, sent_body = ?, sent_at = ?, updated_at = ?
            WHERE id = ?
        `)
        .run(details.messageId, details.subject, details.body, at, at, id);
}

export function markFailed(id: number, error: string): void {
    db().prepare("UPDATE applications SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, now(), id);
}

export function requeue(id: number, error: string | null, notBefore: Date): void {
    db()
        .prepare("UPDATE applications SET status = 'queued', error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?")
        .run(error, notBefore.toISOString(), now(), id);
}

/** Only queued applications can be cancelled; once sending has started it cannot be taken back. */
export function cancel(id: number, reason: string | null = null): boolean {
    return (
        db()
            .prepare("UPDATE applications SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
            .run(reason, now(), id).changes === 1
    );
}

/** A user-requested retry of a failed application. */
export function retry(id: number): boolean {
    return (
        db()
            .prepare("UPDATE applications SET status = 'queued', error = NULL, attempts = 0, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'failed'")
            .run(now(), now(), id).changes === 1
    );
}

/** Messages sent (or being sent) for a candidate since the given time; drives the daily limit. */
export function countSentSince(candidateId: number, since: Date): number {
    const row = db()
        .prepare("SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ? AND status IN ('sent', 'sending') AND updated_at >= ?")
        .get(candidateId, since.toISOString()) as unknown as { n: number };

    return row.n;
}

export function lastSentAt(candidateId: number): Date | undefined {
    const row = db()
        .prepare("SELECT MAX(updated_at) AS at FROM applications WHERE candidate_id = ? AND status IN ('sent', 'sending')")
        .get(candidateId) as unknown as { at: string | null };

    return row.at ? new Date(row.at) : undefined;
}

/**
 * After a crash an application can be left in 'sending' with no way to know whether the mail
 * left the building. It is never retried automatically: the user is told to check the Sent
 * folder and can retry by hand.
 */
export function failInterrupted(): number {
    return db()
        .prepare("UPDATE applications SET status = 'failed', error = ?, updated_at = ? WHERE status = 'sending'")
        .run("Interrupted while sending. Check the Sent folder of your mailbox before retrying, to avoid a duplicate.", now()).changes as number;
}
