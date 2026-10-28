import { NotFoundError, RuleError } from "../errors.js";
import { saveMailAccount, type MailAccount } from "./mail-account.repository.js";
import { presetFor, verifySmtp } from "./smtp.js";
import { RateLimiter } from "../auth/rate-limit.js";
import { getCandidate } from "../candidates/candidate.repository.js";
import { WorkBudget } from "../security/work-budget.js";

const connectionAttempts = new RateLimiter(10, 60 * 60_000, "mailbox connection attempts");
const connections = new WorkBudget(4, "Connecting mailboxes");

export interface ConnectMailboxInput {
    email: string;
    password: string;
    fromName?: string | undefined;
    /** Needed only for providers without a built-in preset. */
    host?: string | undefined;
    port?: number | undefined;
    secure?: boolean | undefined;
    username?: string | undefined;
}

/**
 * Logs in to the mailbox first and stores it only if that works, so a typo is reported
 * immediately and not when the first application silently fails.
 */
export async function connectMailbox(candidateId: number, input: ConnectMailboxInput, expectedOwnerId?: number): Promise<MailAccount> {
    return connections.run(async () => {
        const ownerId = expectedOwnerId ?? (await getCandidate(candidateId))?.userId;
        if (ownerId === undefined || ownerId === null) throw new NotFoundError("Candidate not found");
        // Count before DNS or SMTP starts, including failures and simultaneous requests.
        connectionAttempts.assertAllowed(String(ownerId));
        connectionAttempts.record(String(ownerId));
        return connectMailboxNow(candidateId, input, ownerId);
    });
}

async function connectMailboxNow(candidateId: number, input: ConnectMailboxInput, expectedOwnerId: number): Promise<MailAccount> {
    const email = input.email.trim().toLowerCase();
    const preset = presetFor(email);

    const host = input.host?.trim() || preset?.host;
    if (!host) throw new RuleError("Enter your mail provider's SMTP server (host and port); this address has no built-in settings");

    const port = input.port ?? preset?.port ?? 587;
    const secure = input.secure ?? preset?.secure ?? port === 465;

    // Google shows app passwords in groups of four separated by spaces
    const password = preset?.host === "smtp.gmail.com" ? input.password.replace(/\s+/g, "") : input.password;
    const username = input.username?.trim() || email;

    await verifySmtp({ host, port, secure, username, password });

    return saveMailAccount({
        candidateId,
        email,
        fromName: input.fromName?.trim() || null,
        host,
        port,
        secure,
        username,
        password,
    }, expectedOwnerId);
}
