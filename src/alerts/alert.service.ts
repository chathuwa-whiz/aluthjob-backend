import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getCandidate } from "../candidates/candidate.repository.js";
import { BadRequestError } from "../errors.js";
import { getSystemMailer, systemMailAvailable } from "../mail/system-mailer.js";
import { appUrl } from "../mail/system-messages.js";
import { getMatch, type Match } from "../matching/match.repository.js";
import { rejectMatch, runMatching } from "../matching/match.service.js";
import { limits } from "../auth/auth.service.js";
import { getUser } from "../auth/user.repository.js";
import { signAlertToken, verifyAlertToken, type AlertAction, type AlertTokenPayload } from "./alert-token.js";
import { buildAlertMail, type AlertJob, type AlertLinks } from "./alert-email.js";
import {
    getPreferences,
    latestCandidateId,
    listRecipients,
    ownsMatch,
    pendingMatches,
    recordAlerted,
    savePreferences,
    type AlertFrequency,
    type AlertPreferences,
    type Recipient,
} from "./alert.repository.js";

// How many jobs one email shows. More than this stops being a message and becomes a list to wade through;
// the rest is counted ("and 7 more") and waits in the app.
const MAX_JOBS_PER_EMAIL = 5;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A little under the period so a check that ran slightly late yesterday is not pushed to the day after tomorrow
const MIN_GAP: Record<Exclude<AlertFrequency, "off">, number> = { daily: 20 * HOUR, weekly: 6.5 * DAY };
const PAUSE_DAYS = 7;

// People who stopped coming back should stop hearing from us, without having to find an unsubscribe link:
// after a month away the emails slow to weekly, after three months they stop until the person signs in again.
const SLOW_AFTER_DAYS = 30;
const STOP_AFTER_DAYS = 90;

const LOGO_PATH = resolve(process.cwd(), "assets", "aluthjob-logo.png");

const enabled = () => process.env.JOB_ALERTS === "on";
/** Hour of the day (Sri Lanka time) from which the daily round may run. */
const sendHour = () => Number(process.env.ALERT_SEND_HOUR ?? 8);
const colomboHour = (now: Date) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Asia/Colombo" }).format(now));

// ---- links ---------------------------------------------------------------------------------------------------

// The token rides in the fragment (#token=...), which browsers never send to a server: it stays out of access
// logs, proxies and Referer headers. The page reads it and posts it to the API.
const actionLink = (userId: number, action: AlertAction, matchId?: number) =>
    `${appUrl()}/email-action#token=${signAlertToken({ userId, action, ...(matchId !== undefined && { matchId }) })}`;

/** Public address of the API, for the one-click unsubscribe POST. Defaults to the front end's own /api, which is how the app is served. */
const apiUrl = () => (process.env.API_URL ?? `${appUrl()}/api/v1`).replace(/\/+$/, "");

export function linksFor(userId: number): AlertLinks {
    return {
        app: appUrl(),
        preferences: `${appUrl()}/account#alerts`,
        match: (matchId) => `${appUrl()}/matches/${matchId}`,
        hide: (matchId) => actionLink(userId, "hide", matchId),
        pause: actionLink(userId, "pause"),
        daily: actionLink(userId, "daily"),
        weekly: actionLink(userId, "weekly"),
        unsubscribe: actionLink(userId, "off"),
        oneClickUnsubscribe: `${apiUrl()}/alerts/unsubscribe?t=${encodeURIComponent(signAlertToken({ userId, action: "off" }))}`,
    };
}

// ---- building one email --------------------------------------------------------------------------------------

export const toAlertJob = (match: Match): AlertJob => ({
    matchId: match.id,
    title: match.job.title,
    company: match.job.company,
    location: match.job.location,
    score: match.score,
    jobType: match.job.jobType,
    salary: match.job.salary,
    closingAt: match.job.closingAt,
    reasons: match.details.reasons,
    matchedSkills: match.details.matchedSkills,
    warnings: match.details.warnings,
    applyMethod: match.applyMethod,
});

const firstNameOf = (fullName: string | null | undefined) => {
    const first = fullName?.trim().split(/\s+/)[0] ?? "";
    return first.length >= 2 && first.length <= 30 ? first : null;
};

// ---- who is due ----------------------------------------------------------------------------------------------

/** The cadence this person should get right now, or null for "leave them alone". Pure, so it is easy to test. */
export function effectiveFrequency(recipient: Pick<Recipient, "frequency" | "pausedUntil" | "lastLoginAt" | "createdAt">, now: Date): Exclude<AlertFrequency, "off"> | null {
    if (recipient.frequency === "off") return null;
    if (recipient.pausedUntil && recipient.pausedUntil > now.toISOString()) return null;

    const lastSeen = Date.parse(recipient.lastLoginAt ?? recipient.createdAt);
    const away = Number.isNaN(lastSeen) ? 0 : (now.getTime() - lastSeen) / DAY;

    if (away > STOP_AFTER_DAYS) return null;
    if (away > SLOW_AFTER_DAYS) return "weekly";
    return recipient.frequency;
}

export function isDue(recipient: Recipient, now: Date): Exclude<AlertFrequency, "off"> | null {
    const frequency = effectiveFrequency(recipient, now);
    if (!frequency) return null;
    if (!recipient.lastCheckedAt) return frequency;

    return now.getTime() - Date.parse(recipient.lastCheckedAt) >= MIN_GAP[frequency] ? frequency : null;
}

// ---- one person ----------------------------------------------------------------------------------------------

export type DigestResult = "sent" | "nothing-new" | "baseline" | "no-resume";

/**
 * Looks for news for one person and emails it if there is any.
 *
 * The first look at a person never sends: whatever matches they already have were visible in the app, so
 * announcing them by email would be noise. Those are recorded silently, and from then on only matches that
 * appear after that moment are news.
 */
export async function sendDigest(recipient: Recipient, frequency: Exclude<AlertFrequency, "off">, now = new Date()): Promise<DigestResult> {
    const candidateId = await latestCandidateId(recipient.userId);
    if (!candidateId) return "no-resume";

    const first = recipient.lastCheckedAt === null;

    if (first) {
        const existing = await pendingMatches(recipient.userId, 0);
        await recordAlerted(recipient.userId, [], existing.map((match) => match.id));
        await savePreferences(recipient.userId, { lastCheckedAt: now.toISOString() });
        return "baseline";
    }

    // New vacancies are matched against the CV (quick: no pages are fetched and no letters are written here)
    await runMatching(candidateId, { enrichTop: 0, draftTop: 0 });

    const pending = await pendingMatches(recipient.userId, recipient.minScore);
    if (pending.length === 0) {
        await savePreferences(recipient.userId, { lastCheckedAt: now.toISOString() });
        return "nothing-new";
    }

    const shown = pending.slice(0, MAX_JOBS_PER_EMAIL);
    const matches = (await Promise.all(shown.map((item) => getMatch(item.id)))).filter((match): match is Match => Boolean(match));
    if (matches.length === 0) return "nothing-new";

    const candidate = await getCandidate(candidateId);
    const logo = existsSync(LOGO_PATH);

    const mail = buildAlertMail(
        {
            to: recipient.email,
            firstName: firstNameOf(candidate?.profile.personalInfo.fullName),
            jobs: matches.map(toAlertJob),
            moreCount: pending.length - matches.length,
            frequency,
            links: linksFor(recipient.userId),
            logo,
            now,
        },
        LOGO_PATH,
    );

    await getSystemMailer().send(mail);

    // After sending: a failure above leaves everything as it was, so the next round tries again
    await recordAlerted(recipient.userId, matches.map((match) => match.id), pending.filter((item) => !matches.some((match) => match.id === item.id)).map((item) => item.id));
    await savePreferences(recipient.userId, { lastCheckedAt: now.toISOString(), lastSentAt: now.toISOString() });

    return "sent";
}

// ---- the round -----------------------------------------------------------------------------------------------

export interface AlertCycleSummary {
    considered: number;
    sent: number;
    baselined: number;
    failed: number;
}

let cycleRunning = false;
// A failing mail server must not be hammered once an hour per person
const failedAt = new Map<number, number>();
const RETRY_AFTER = 6 * HOUR;

export async function runAlertCycle(now = new Date(), options: { ignoreHour?: boolean } = {}): Promise<AlertCycleSummary | "off" | "busy" | "too-early"> {
    if (!enabled()) return "off";
    if (cycleRunning) return "busy";
    if (!options.ignoreHour && colomboHour(now) < sendHour()) return "too-early";

    cycleRunning = true;
    const summary: AlertCycleSummary = { considered: 0, sent: 0, baselined: 0, failed: 0 };

    try {
        for (const recipient of await listRecipients()) {
            const frequency = isDue(recipient, now);
            if (!frequency) continue;
            if (now.getTime() - (failedAt.get(recipient.userId) ?? 0) < RETRY_AFTER) continue;

            summary.considered++;

            try {
                const result = await sendDigest(recipient, frequency, now);
                failedAt.delete(recipient.userId);
                if (result === "sent") summary.sent++;
                if (result === "baseline") summary.baselined++;
            } catch (error) {
                summary.failed++;
                failedAt.set(recipient.userId, now.getTime());
                console.error(`Job alert for user ${recipient.userId} failed:`, error instanceof Error ? error.message : error);
            }
        }
    } finally {
        cycleRunning = false;
    }

    return summary;
}

export const jobAlertsStatus = () => ({ enabled: enabled(), mailReady: systemMailAvailable(), sendHour: sendHour() });

// ---- the buttons in the email -------------------------------------------------------------------------------

export interface ActionPreview {
    action: AlertAction;
    /** What pressing the button will do, in a sentence. */
    summary: string;
    confirmLabel: string;
    /** The job a "hide" refers to. */
    jobTitle: string | null;
}

function readToken(token: string, ip: string): AlertTokenPayload {
    limits.badLinkPerAddress.assertAllowed(ip);

    const payload = verifyAlertToken(token);
    if (!payload) {
        limits.badLinkPerAddress.record(ip);
        throw new BadRequestError("This link is invalid or has expired. Open Settings in AluthJob to change your email updates");
    }

    return payload;
}

const SUMMARY: Record<Exclude<AlertAction, "hide">, { summary: string; confirmLabel: string }> = {
    off: { summary: "Stop emailing you about new jobs. You can turn updates back on in Settings whenever you like.", confirmLabel: "Unsubscribe" },
    pause: { summary: `Pause job emails for ${PAUSE_DAYS} days. They start again by themselves afterwards.`, confirmLabel: `Pause for ${PAUSE_DAYS} days` },
    daily: { summary: "Send you at most one email a day, and only when there is a new match.", confirmLabel: "Email me daily" },
    weekly: { summary: "Send you at most one email a week with your best new matches.", confirmLabel: "Email me weekly" },
};

/** Says what a link would do, without doing it (a mail scanner or a curious click changes nothing). */
export async function previewAction(token: string, ip: string): Promise<ActionPreview> {
    const payload = readToken(token, ip);

    if (payload.action === "hide") {
        const match = await getMatch(payload.matchId!);
        const owned = match && (await ownsMatch(payload.userId, match.id));
        return { action: "hide", summary: "Hide this job from your matches. It will not come back.", confirmLabel: "Hide this job", jobTitle: owned ? match.job.title : null };
    }

    return { action: payload.action, ...SUMMARY[payload.action], jobTitle: null };
}

export interface ActionResult {
    action: AlertAction;
    message: string;
}

export async function performAction(token: string, ip: string): Promise<ActionResult> {
    const payload = readToken(token, ip);
    const { userId, action } = payload;

    if (!(await getUser(userId))) throw new BadRequestError("This account no longer exists");

    switch (action) {
        case "hide": {
            const match = await getMatch(payload.matchId!);
            if (!match || !(await ownsMatch(userId, match.id))) throw new BadRequestError("That job is no longer in your matches");

            // only a suggestion the person never acted on: an approved or sent application is not undone from an email
            if (match.status === "suggested") await rejectMatch(match.id);
            return { action, message: "Hidden. We will not show it again." };
        }
        case "off":
            await savePreferences(userId, { frequency: "off" });
            return { action, message: "You are unsubscribed. We will not email you about new jobs." };
        case "pause":
            await savePreferences(userId, { pausedUntil: new Date(Date.now() + PAUSE_DAYS * DAY).toISOString() });
            return { action, message: `Paused for ${PAUSE_DAYS} days.` };
        case "daily":
        case "weekly":
            await savePreferences(userId, { frequency: action, pausedUntil: null });
            return { action, message: action === "daily" ? "Daily updates, only when there is something new." : "Weekly updates, only when there is something new." };
    }
}

/** The mail app's own unsubscribe button: a POST that must work without a page, so it applies at once. */
export async function oneClickUnsubscribe(token: string, ip: string): Promise<void> {
    const payload = readToken(token, ip);
    if (payload.action !== "off") throw new BadRequestError("This link cannot be used to unsubscribe");

    await performAction(token, ip);
}

// ---- settings page ------------------------------------------------------------------------------------------

export const readPreferences = (userId: number): Promise<AlertPreferences> => getPreferences(userId);
