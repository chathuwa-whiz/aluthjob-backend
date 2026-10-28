import * as cheerio from "cheerio";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// Addresses on these domains belong to the portals themselves, never to the employer
const PORTAL_DOMAINS = new Set([
    "topjobs.lk",
    "observerjobs.lk",
    "jobpal.lk",
    "governmentjobs.lk",
    "dreamjobs.lk",
    "ikman.lk",
    "xpress.jobs",
    "findmyjob.lk",
    "finders.lk",
    "rooster.jobs",
    "mytutor.lk",
    "efuturetech.com",
]);

export const isPortalEmail = (email: string) => PORTAL_DOMAINS.has(email.split("@")[1]?.toLowerCase() ?? "");

export const squash = (value: string | null | undefined) =>
    (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

/** HTML fragment -> readable plain text with paragraph breaks preserved. */
export function htmlToText(html: string | null | undefined): string {
    if (!html) return "";

    const $ = cheerio.load(`<div id="root">${html}</div>`);
    $("script, style").remove();
    $("br").replaceWith("\n");
    $("p, div, li, h1, h2, h3, h4, h5, h6, tr").each((_, element) => {
        $(element).append("\n");
    });

    return $("#root")
        .text()
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** Some ads obfuscate addresses as "name [at] company [dot] lk". */
function deobfuscate(text: string): string {
    return text
        .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@")
        .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");
}

export function findApplyEmail(text: string | null | undefined): string | null {
    if (!text) return null;

    const emails = deobfuscate(text).match(EMAIL_RE) ?? [];
    return emails.map((email) => email.toLowerCase()).find((email) => !isPortalEmail(email)) ?? null;
}

/** First employer address among already-extracted candidates (mailto targets, contact fields). */
export function pickApplyEmail(...candidates: (string | null | undefined)[]): string | null {
    for (const candidate of candidates) {
        const email = findApplyEmail(candidate);
        if (email) return email;
    }
    return null;
}

export function absoluteUrl(href: string | undefined, base: string): string | null {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

/** Parses "Sat Nov 07 2026", "November 16, 2026", "2026-11-07T01:53:33" ... into an ISO date. */
export function toIsoDate(value: string | null | undefined): string | null {
    const text = squash(value);
    if (!text) return null;

    const time = Date.parse(text);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** "2 days ago", "3 hours ago" -> ISO timestamp relative to now. */
export function relativeToIso(value: string | null | undefined, now = Date.now()): string | null {
    const match = squash(value).match(/(\d+|an?|one)\s*(minute|hour|day|week|month)s?\s+ago/i);
    if (!match) return null;

    const amount = /^\d+$/.test(match[1]!) ? Number(match[1]) : 1;
    const unitMs = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[match[2]!.toLowerCase() as "day"];
    return new Date(now - amount * unitMs).toISOString();
}
