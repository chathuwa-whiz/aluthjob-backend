import type Mail from "nodemailer/lib/mailer/index.js";
import { getCandidate, getCandidateFile } from "../candidates/candidate.repository.js";
import { NotFoundError, RuleError } from "../errors.js";
import { isPortalEmail } from "../jobs/text.js";
import { getMatch, listMatches, type Match } from "../matching/match.repository.js";
import * as applications from "./application.repository.js";
import { getMailAccount, getSmtpSettings } from "./mail-account.repository.js";
import { classifySmtpError, createTransport } from "./smtp.js";

// A job seeker sending dozens of identical-looking mails an hour gets the mailbox flagged as spam,
// which would hurt every later application. These defaults are deliberately conservative.
const DAILY_LIMIT = () => Number(process.env.MAIL_DAILY_LIMIT ?? 20);
const MIN_GAP_MS = () => Number(process.env.MAIL_SEND_GAP_SECONDS ?? 60) * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 10 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** Single line, so a stray newline in an edited subject can never inject a header. */
const singleLine = (text: string) => text.replace(/[\r\n]+/g, " ").trim();

export function isSendableAddress(address: string, ownAddress?: string): boolean {
    return (
        address.length <= 254 &&
        EMAIL_RE.test(address) &&
        !isPortalEmail(address) &&
        address.toLowerCase() !== ownAddress?.toLowerCase()
    );
}

/** OCR-read addresses are only trusted once the user confirmed exactly this address. */
export function needsAddressConfirmation(match: Match): boolean {
    const address = match.job.applyEmail?.toLowerCase();
    return Boolean(address) && match.job.applyEmailSource === "image" && match.confirmedEmail?.toLowerCase() !== address;
}

/** Everything that currently stops this match from being emailed. Empty means it can go out. */
export function sendProblems(match: Match, hasMailbox: boolean, ownAddress?: string): string[] {
    const problems: string[] = [];

    if (match.status !== "approved") problems.push("Approve the match first");
    if (!match.coverLetter?.trim()) problems.push("The cover letter is empty");
    if (!match.job.applyEmail) problems.push("This vacancy publishes no employer email; apply on the job site instead");
    else if (!isSendableAddress(match.job.applyEmail, ownAddress)) problems.push("The employer address on this vacancy is not usable");
    if (needsAddressConfirmation(match)) {
        problems.push(
            "This address was read from a picture and may contain a misread character. Open the original advert, check it, then confirm the address",
        );
    }
    if (match.job.closingAt && match.job.closingAt < new Date().toISOString()) problems.push("This vacancy has already closed");
    if (!hasMailbox) problems.push("Connect your mailbox first");

    return problems;
}

// ---- message ---------------------------------------------------------------------------

export interface PreparedMessage {
    from: string;
    to: string;
    subject: string;
    body: string;
    attachment: { fileName: string; bytes: number };
    /** "image": the address was read from a picture by OCR. */
    addressSource: "page" | "image";
    /** Where the original advert can be checked when the address came from an image. */
    verifyAt: string | null;
    addressConfirmed: boolean;
}

/** `to` is the address validated and stored when the application was queued; the ad's own is used for previews. */
async function prepare(match: Match, to = match.job.applyEmail) {
    const [candidate, file, account] = await Promise.all([getCandidate(match.candidateId), getCandidateFile(match.candidateId), getMailAccount(match.candidateId)]);
    if (!candidate || !file) throw new NotFoundError("Candidate not found");

    const fromName = account?.fromName ?? candidate.profile.personalInfo.fullName ?? undefined;

    const mail: Mail.Options = {
        from: account ? { name: fromName ?? "", address: account.email } : undefined,
        to: to ?? undefined,
        replyTo: account?.email,
        subject: singleLine(match.subject ?? `Application for ${match.job.title}`),
        text: match.coverLetter ?? "",
        attachments: [
            {
                // the original upload, under a harmless file name
                filename: file.fileName.replace(/[\\/:*?"<>|\r\n]+/g, "_"),
                content: file.data,
                contentType: file.mimeType,
            },
        ],
    };

    return { mail, account, file };
}

/** The exact message that would be sent, plus whatever currently blocks it. */
export async function previewMessage(matchId: number): Promise<{ message: PreparedMessage; problems: string[] }> {
    const match = await getMatch(matchId);
    if (!match) throw new NotFoundError("Match not found");

    const { mail, account, file } = await prepare(match);

    return {
        message: {
            from: account ? `${account.fromName ? `${account.fromName} ` : ""}<${account.email}>` : "(connect a mailbox)",
            to: match.job.applyEmail ?? "",
            subject: mail.subject ?? "",
            body: match.coverLetter ?? "",
            attachment: { fileName: file.fileName, bytes: file.data.length },
            addressSource: match.job.applyEmailSource ?? "page",
            verifyAt: match.job.applyEmailSource === "image" ? match.job.url : null,
            addressConfirmed: !needsAddressConfirmation(match),
        },
        problems: sendProblems(match, Boolean(account), account?.email),
    };
}

// ---- queueing --------------------------------------------------------------------------

/** Queues one approved match. Queueing the same match twice is harmless. */
export async function queueMatch(matchId: number): Promise<{ application: applications.Application; created: boolean }> {
    const match = await getMatch(matchId);
    if (!match) throw new NotFoundError("Match not found");

    const account = await getMailAccount(match.candidateId);
    const [problem] = sendProblems(match, Boolean(account), account?.email);
    if (problem) throw new RuleError(problem);

    return applications.enqueue(match.id, match.candidateId, match.job.applyEmail!.toLowerCase());
}

export interface QueueResult {
    queued: applications.Application[];
    /** Approved matches that were left out, with the reason. */
    skipped: { matchId: number; title: string; reason: string }[];
}

/** Queues every approved match of a candidate that has an employer email. */
export async function queueApproved(candidateId: number, matchIds?: number[]): Promise<QueueResult> {
    const result: QueueResult = { queued: [], skipped: [] };
    const wanted = matchIds && new Set(matchIds);

    for (const match of await listMatches(candidateId, { status: "approved", limit: 200 })) {
        if (wanted && !wanted.has(match.id)) continue;

        try {
            const { application, created } = await queueMatch(match.id);
            if (created) result.queued.push(application);
            else result.skipped.push({ matchId: match.id, title: match.job.title, reason: `Already ${application.status}` });
        } catch (error) {
            if (!(error instanceof RuleError)) throw error;
            result.skipped.push({ matchId: match.id, title: match.job.title, reason: error.message });
        }
    }

    return result;
}

export async function cancelApplication(id: number): Promise<applications.Application> {
    const application = await applications.getApplication(id);
    if (!application) throw new NotFoundError("Application not found");

    if (!(await applications.cancel(id, "Cancelled by you"))) {
        throw new RuleError(application.status === "sent" ? "This application has already been sent" : `Cannot cancel an application that is ${application.status}`);
    }
    return (await applications.getApplication(id))!;
}

export async function retryApplication(id: number): Promise<applications.Application> {
    const application = await applications.getApplication(id);
    if (!application) throw new NotFoundError("Application not found");

    if (!(await applications.retry(id))) throw new RuleError(`Only failed applications can be retried; this one is ${application.status}`);
    return (await applications.getApplication(id))!;
}

// ---- sending ---------------------------------------------------------------------------

export type ProcessResult = "idle" | "sent" | "deferred" | "failed" | "cancelled";

/**
 * Handles the next due application: re-checks that sending is still allowed, respects the daily
 * limit and the pause between messages, sends, and records the outcome. Meant to be called
 * repeatedly by the worker; safe to call concurrently because claiming a row is atomic.
 */
export async function processNext(now = new Date()): Promise<ProcessResult> {
    const due = await applications.nextDue();
    if (!due) return "idle";

    // Everything is re-checked at send time: the user may have rejected, edited or disconnected since queueing
    const match = await getMatch(due.matchId);
    const account = await getMailAccount(due.candidateId);
    const problems = match ? sendProblems(match, Boolean(account), account?.email) : ["The match no longer exists"];

    if (problems.length > 0 || match?.job.applyEmail?.toLowerCase() !== due.toEmail) {
        await applications.cancel(due.id, problems[0] ?? "The employer address changed after you queued this application");
        return "cancelled";
    }

    const sentToday = await applications.countSentSince(due.candidateId, new Date(now.getTime() - DAY_MS));
    if (sentToday >= DAILY_LIMIT()) {
        await applications.requeue(due.id, `Daily limit of ${DAILY_LIMIT()} applications reached; will continue tomorrow`, new Date(now.getTime() + 60 * 60_000));
        return "deferred";
    }

    const last = await applications.lastSentAt(due.candidateId);
    if (last && now.getTime() - last.getTime() < MIN_GAP_MS()) {
        await applications.requeue(due.id, null, new Date(last.getTime() + MIN_GAP_MS()));
        return "deferred";
    }

    let settings;
    try {
        settings = (await getSmtpSettings(due.candidateId))!;
    } catch (error) {
        // server configuration problem (MAIL_SECRET changed), not the application's fault
        await applications.requeue(due.id, error instanceof Error ? error.message : String(error), new Date(now.getTime() + 30 * 60_000));
        return "deferred";
    }

    const claimed = await applications.claim(due.id);
    if (!claimed) return "idle"; // another worker got there first

    const { mail } = await prepare(match!, due.toEmail);
    let messageId: string;
    let transport;

    try {
        transport = await createTransport(settings);
        messageId = String((await transport.sendMail(mail)).messageId);
    } catch (error) {
        const failure = classifySmtpError(error);

        if (failure.retryable && claimed.attempts < MAX_ATTEMPTS) {
            await applications.requeue(claimed.id, failure.message, new Date(Date.now() + RETRY_BACKOFF_MS * claimed.attempts));
            return "deferred";
        }

        await applications.markFailed(claimed.id, failure.message);
        return "failed";
    } finally {
        transport?.close();
    }

    // Outside the try block on purpose: once the server has accepted the mail, a bookkeeping
    // problem must never make it look like a failed send that could be retried (a duplicate).
    await applications.markSent(claimed.id, { messageId, subject: String(mail.subject), body: String(mail.text) });
    return "sent";
}
