import { createHash, randomBytes } from "node:crypto";
import { BadRequestError, RuleError, UnauthorizedError } from "../errors.js";
import { assertSystemMailAvailable, getSystemMailer, type OutgoingMail } from "../mail/system-mailer.js";
import { alreadyRegisteredMessage, passwordChangedMessage, passwordResetMessage, verificationMessage } from "../mail/system-messages.js";
import { consumeEmailToken, issueEmailToken, peekEmailToken, purgeExpiredEmailTokens, revokeEmailTokens } from "./email-token.repository.js";
import { assertAcceptablePassword, decoyHash, hashPassword, verifyPassword } from "./password.js";
import { RateLimiter } from "./rate-limit.js";
import * as users from "./user.repository.js";

export interface RequestContext {
    ip: string;
    userAgent: string | null;
}

export interface Signup {
    user: users.User;
    /** The raw session token. Only its hash is stored, so this is the one chance to hand it out. */
    token: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sessionMs = () => Number(process.env.SESSION_DAYS ?? 30) * 24 * HOUR;

// Short-lived on purpose: a reset link is a password, a confirmation link is only a proof of ownership
const VERIFY_HOURS = 24;
const RESET_MINUTES = 60;

// A wrong password costs the attacker one of these tries. Per account+address stops guessing one account
// from one place; per address alone stops spraying many accounts.
export const limits = {
    loginPerAccount: new RateLimiter(8, 15 * MINUTE, "failed sign-in attempts"),
    loginPerAddress: new RateLimiter(40, 15 * MINUTE, "failed sign-in attempts"),
    registerPerAddress: new RateLimiter(10, HOUR, "sign-ups from this address"),
    sensitivePerUser: new RateLimiter(5, 15 * MINUTE, "failed confirmations"),
    // email: a signed-in user asking for another confirmation link
    resendPerUser: new RateLimiter(3, HOUR, "confirmation emails"),
    // email: password-reset requests from one place (answered 429, which reveals nothing about any account)
    forgotPerAddress: new RateLimiter(10, HOUR, "password reset requests"),
    // email: messages sent TO one address on behalf of strangers; excess is silently dropped so the owner is not flooded
    mailPerRecipient: new RateLimiter(3, HOUR, "emails to this address"),
    // wrong or expired links tried from one place
    badLinkPerAddress: new RateLimiter(30, HOUR, "invalid link attempts"),
};

export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function issueSession(userId: number, context: RequestContext): string {
    const token = randomBytes(32).toString("base64url");
    users.createSession(userId, hashToken(token), new Date(Date.now() + sessionMs()), context.userAgent);
    return token;
}

// ---- sending ---------------------------------------------------------------------------

const pendingMail = new Set<Promise<void>>();

/**
 * Sends without making the caller wait. This matters for security, not speed: if a request for an address
 * that has an account took longer (it sends a mail) than one for an address that has none, the response
 * time would reveal which addresses are registered. Failures are logged, never shown to the caller.
 */
function sendInBackground(mail: OutgoingMail): void {
    const sending = (async () => getSystemMailer().send(mail))()
        .catch((error: unknown) => console.error(`Could not send "${mail.subject}":`, error instanceof Error ? error.message : error))
        .finally(() => pendingMail.delete(sending));

    pendingMail.add(sending);
}

/** Tests: resolves when every email started so far has been handed to the mailer. */
export const whenMailSettled = async () => void (await Promise.all([...pendingMail]));

/** Counts a message to a stranger-controlled address; false means "enough already, skip it". */
function mayMail(email: string): boolean {
    try {
        limits.mailPerRecipient.assertAllowed(email);
        limits.mailPerRecipient.record(email);
        return true;
    } catch {
        return false;
    }
}

// ---- registration and email verification -----------------------------------------------

/**
 * Creates an account and emails a confirmation link. It never signs the person in and answers identically
 * whether or not the address already has an account (the owner of an existing account gets a notice
 * instead), so nobody can use this form to find out who is registered. The account is useless until the
 * link is followed.
 */
export async function register(emailInput: string, password: string, context: RequestContext): Promise<void> {
    assertSystemMailAvailable();
    limits.registerPerAddress.assertAllowed(context.ip);
    limits.registerPerAddress.record(context.ip);

    const email = normalizeEmail(emailInput);
    assertAcceptablePassword(password, email);

    // hashed even when the address turns out to be taken, so both outcomes cost the same time
    const user = users.createUser(email, await hashPassword(password));

    if (user) {
        sendInBackground(verificationMessage(email, issueEmailToken(user.id, "verify", email, VERIFY_HOURS * HOUR), VERIFY_HOURS));
    } else if (mayMail(email)) {
        sendInBackground(alreadyRegisteredMessage(email));
    }
}

/** Confirms an address from the emailed link. Single use. Does not sign anyone in. */
export function verifyEmail(token: string, context: RequestContext): void {
    limits.badLinkPerAddress.assertAllowed(context.ip);

    const used = consumeEmailToken("verify", token);
    const user = used && users.getUser(used.userId);

    // a link only counts for the address it was sent to
    if (!used || !user || user.email !== used.email) {
        limits.badLinkPerAddress.record(context.ip);
        throw new BadRequestError("This confirmation link is invalid or has expired. Sign in and ask for a new one");
    }

    users.markEmailVerified(user.id);
    revokeEmailTokens(user.id, "verify");
}

/** A signed-in but unverified user asking for a fresh link (the old one stops working). */
export function resendVerification(user: users.User): void {
    if (user.emailVerified) throw new RuleError("Your email address is already confirmed");

    assertSystemMailAvailable();
    limits.resendPerUser.assertAllowed(String(user.id));
    limits.resendPerUser.record(String(user.id));

    sendInBackground(verificationMessage(user.email, issueEmailToken(user.id, "verify", user.email, VERIFY_HOURS * HOUR), VERIFY_HOURS));
}

// ---- sign in and out -------------------------------------------------------------------

export async function login(emailInput: string, password: string, context: RequestContext): Promise<Signup> {
    const email = normalizeEmail(emailInput);
    const accountKey = `${context.ip}|${email}`;

    limits.loginPerAccount.assertAllowed(accountKey);
    limits.loginPerAddress.assertAllowed(context.ip);

    const found = users.findUserWithHash(email);
    // Always do the expensive comparison, even for an unknown address, so timing does not reveal which emails have accounts
    const correct = await verifyPassword(password, found?.passwordHash ?? (await decoyHash()));

    if (!found || !correct) {
        limits.loginPerAccount.record(accountKey);
        limits.loginPerAddress.record(context.ip);
        throw new UnauthorizedError("Incorrect email or password");
    }

    limits.loginPerAccount.clear(accountKey);
    users.touchLogin(found.id);

    const { passwordHash: _passwordHash, ...user } = found;
    return { user, token: issueSession(found.id, context) };
}

export const logout = (token: string) => users.deleteSession(hashToken(token));

/** The user a session token belongs to, or undefined for unknown, expired or revoked tokens. */
export const authenticate = (token: string) => users.findSessionUser(hashToken(token));

// ---- passwords -------------------------------------------------------------------------

async function confirmPassword(userId: number, password: string): Promise<void> {
    limits.sensitivePerUser.assertAllowed(String(userId));

    const stored = users.getPasswordHash(userId);
    if (!stored || !(await verifyPassword(password, stored))) {
        limits.sensitivePerUser.record(String(userId));
        throw new UnauthorizedError("Incorrect password");
    }

    limits.sensitivePerUser.clear(String(userId));
}

/** Changes the password and signs the account out everywhere else, in case the old password was stolen. */
export async function changePassword(user: users.User, current: string, next: string, currentToken: string): Promise<void> {
    await confirmPassword(user.id, current);
    assertAcceptablePassword(next, user.email);

    users.setPasswordHash(user.id, await hashPassword(next));
    users.deleteSessionsOf(user.id, hashToken(currentToken));
    revokeEmailTokens(user.id, "reset");

    // so the owner hears about it even if someone else did this with a hijacked session
    sendInBackground(passwordChangedMessage(user.email, "change"));
}

/**
 * "Forgot password". Always answers the same way, whether or not the address has an account, and never
 * waits for the email to be sent, so neither the response nor its timing says who is registered.
 */
export function requestPasswordReset(emailInput: string, context: RequestContext): void {
    assertSystemMailAvailable();
    limits.forgotPerAddress.assertAllowed(context.ip);
    limits.forgotPerAddress.record(context.ip);

    const email = normalizeEmail(emailInput);
    const user = users.findUserWithHash(email);

    if (user && mayMail(email)) {
        sendInBackground(passwordResetMessage(email, issueEmailToken(user.id, "reset", email, RESET_MINUTES * MINUTE), RESET_MINUTES));
    }
}

/**
 * Sets a new password from the emailed link. The link works once; afterwards the account is signed out
 * everywhere (whoever had a session, including an intruder, loses it) and, since the link proves the
 * owner reads this mailbox, the address counts as verified.
 */
export async function resetPassword(token: string, newPassword: string, context: RequestContext): Promise<void> {
    limits.badLinkPerAddress.assertAllowed(context.ip);

    const invalid = () => {
        limits.badLinkPerAddress.record(context.ip);
        return new BadRequestError("This reset link is invalid or has expired. Request a new one");
    };

    const pending = peekEmailToken("reset", token);
    if (!pending) throw invalid();

    // checked before the link is spent: a too-weak password must not cost the user their only link
    assertAcceptablePassword(newPassword, pending.email);
    const hash = await hashPassword(newPassword);

    const used = consumeEmailToken("reset", token);
    const user = used && users.getUser(used.userId);
    if (!used || !user || user.email !== used.email) throw invalid();

    users.setPasswordHash(user.id, hash);
    users.markEmailVerified(user.id);
    users.deleteSessionsOf(user.id);
    revokeEmailTokens(user.id, "reset");

    sendInBackground(passwordChangedMessage(user.email, "reset"));
}

/** Permanently removes the account and every resume, match, mailbox and application that belongs to it. */
export async function deleteAccount(user: users.User, password: string): Promise<void> {
    await confirmPassword(user.id, password);
    users.deleteUser(user.id);
}

export const purgeExpiredSessions = users.purgeExpiredSessions;
export const purgeExpiredTokens = purgeExpiredEmailTokens;
