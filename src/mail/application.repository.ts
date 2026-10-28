import { getDatabase, isUniqueViolation } from "../db/database.js";
import { createHash } from "node:crypto";

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

/**
 * Puts an application that was already sent (or cancelled) back in the queue, on the user's explicit request.
 * The row is reused because there is one application per match; `sent_at` and the stored copy of the earlier
 * message stay until the new send replaces them, so "sent before" is never lost, even if the new attempt fails.
 * Returns false when the application is in any other state (e.g. a second click while it is already queued).
 */
export async function restart(id: number, toEmail: string): Promise<boolean> {
    const at = now();
    return (
        await db().run(
            "UPDATE applications SET status = 'queued', error = NULL, attempts = 0, to_email = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status IN ('sent', 'cancelled')",
            [toEmail, at, at, id],
        )
    ).changes === 1;
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

/** A pacing decision must never overwrite another worker's already claimed send. */
export async function deferQueued(id: number, error: string | null, notBefore: Date): Promise<void> {
    await db().run("UPDATE applications SET error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'", [cut(error, 4000), notBefore.toISOString(), now(), id]);
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

const mailboxKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
const smtpKey = (host: string, username: string) => createHash("sha256").update(host.trim().toLowerCase()).update("\0").update(username.trim().toLowerCase()).digest("hex");

export type SendReservation = { kind: "claimed"; eventId: number; application: Application }
    | { kind: "deferred"; reason: "daily" | "gap"; notBefore: Date }
    | { kind: "stale" };

/** Reserves a user's and mailbox's shared allowance and claims the application in one short transaction.
 * The table lock serializes reservations across API processes, but is released before any SMTP I/O.
 */
export async function reserveSend(id: number, ownerId: number | null, email: string, at: Date, dailyLimit: number, gapMs: number, expectedMatchVersion?: string): Promise<SendReservation> {
    return db().transaction(async (tx) => {
        await tx.run("LOCK TABLE mail_send_events IN EXCLUSIVE MODE");
        const application = await tx.get<ApplicationRow>("SELECT * FROM applications WHERE id = ?", [id]);
        if (!application || application.status !== "queued") return { kind: "stale" };
        const candidate = await tx.get<{ user_id: number | null }>("SELECT user_id FROM candidates WHERE id = ? FOR UPDATE", [application.candidate_id]);
        const account = await tx.get<{ email: string; host: string; username: string }>("SELECT email, host, username FROM mail_accounts WHERE candidate_id = ?", [application.candidate_id]);
        if (!candidate || candidate.user_id !== ownerId || !account || account.email.toLowerCase() !== email.toLowerCase()) return { kind: "stale" };
        // Claiming marks the start of sending. An edit/rejection committed before that boundary
        // must invalidate the prepared message rather than sending the stale approved copy.
        if (expectedMatchVersion !== undefined) {
            const match = await tx.get<{ status: string; updated_at: string }>("SELECT status, updated_at FROM matches WHERE id = ? FOR UPDATE", [application.match_id]);
            if (!match || match.status !== "approved" || match.updated_at !== expectedMatchVersion) return { kind: "stale" };
        }

        const since = new Date(at.getTime() - 86_400_000).toISOString();
        await tx.run("DELETE FROM mail_send_events WHERE started_at < ?", [since]);
        // Upgrade existing installations without resetting the allowance for their recent sends.
        const legacy = await tx.all<{ id: number; user_id: number | null; email: string; host: string; username: string; started_at: string }>(
            `SELECT a.id, c.user_id, m.email, m.host, m.username, COALESCE(a.sent_at, a.updated_at) AS started_at
             FROM applications a JOIN candidates c ON c.id = a.candidate_id JOIN mail_accounts m ON m.candidate_id = c.id
             WHERE (a.sent_at >= ? OR (a.status = 'sending' AND a.updated_at >= ?))
             AND NOT EXISTS (SELECT 1 FROM mail_send_events e WHERE e.application_id = a.id)`, [since, since]);
        for (const previous of legacy) await tx.run("INSERT INTO mail_send_events (application_id, user_id, mailbox_key, smtp_key, status, started_at) VALUES (?, ?, ?, ?, 'sent', ?)", [previous.id, previous.user_id, mailboxKey(previous.email), smtpKey(previous.host, previous.username), previous.started_at]);

        const key = mailboxKey(email);
        const identity = smtpKey(account.host, account.username);
        const usage = await tx.get<{ n: number; latest: string | null }>(
            "SELECT COUNT(*) AS n, MAX(started_at) AS latest FROM mail_send_events WHERE (user_id = ? OR mailbox_key = ? OR smtp_key = ?) AND status IN ('sending', 'sent') AND started_at >= ?", [ownerId, key, identity, since]);
        if (usage!.n >= dailyLimit) return { kind: "deferred", reason: "daily", notBefore: new Date(at.getTime() + 3_600_000) };
        if (usage?.latest && at.getTime() - new Date(usage.latest).getTime() < gapMs) return { kind: "deferred", reason: "gap", notBefore: new Date(new Date(usage.latest).getTime() + gapMs) };

        const claimed = await tx.run("UPDATE applications SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'", [at.toISOString(), id]);
        if (claimed.changes !== 1) return { kind: "stale" };
        const eventId = await tx.insert("INSERT INTO mail_send_events (application_id, user_id, mailbox_key, smtp_key, status, started_at) VALUES (?, ?, ?, ?, 'sending', ?)", [id, ownerId, key, identity, at.toISOString()]);
        return { kind: "claimed", eventId, application: toApplication({ ...application, status: "sending", attempts: application.attempts + 1, updated_at: at.toISOString() }) };
    });
}

export async function finishSendReservation(eventId: number, sent: boolean): Promise<void> {
    await db().run("UPDATE mail_send_events SET status = ? WHERE id = ?", [sent ? "sent" : "failed", eventId]);
}

/**
 * After a crash an application can be left in 'sending' with no way to know whether the mail
 * left the building. It is never retried automatically: the user is told to check the Sent
 * folder and can retry by hand.
 */
export async function refreshSending(id: number): Promise<void> {
    await db().run("UPDATE applications SET updated_at = ? WHERE id = ? AND status = 'sending'", [now(), id]);
}

export async function failInterrupted(staleBefore = new Date(Date.now() - 5 * 60_000)): Promise<number> {
    return (
        await db().run("UPDATE applications SET status = 'failed', error = ?, updated_at = ? WHERE status = 'sending' AND updated_at < ?", [
            "Interrupted while sending. Check the Sent folder of your mailbox before retrying, to avoid a duplicate.",
            now(),
            staleBefore.toISOString(),
        ])
    ).changes;
}
