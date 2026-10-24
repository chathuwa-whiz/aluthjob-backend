import { findApplyEmail } from "../jobs/text.js";
import { domainAcceptsMail, type DnsLookup } from "./mail-dns.js";
import type { OcrResult } from "./ocr.service.js";

// A misread character in an address would send someone's CV to a stranger, so addresses read from
// images must pass several independent checks before they are even offered to the user.

/**
 * Below this word confidence the address is not trusted at all. Deliberately low: correct addresses on
 * coloured or stylised posters often score 45-60, and the domain check plus the user's own confirmation
 * are the real safeguards. Garbage typically scores below 30.
 */
export const MIN_EMAIL_CONFIDENCE = () => Number(process.env.OCR_MIN_EMAIL_CONFIDENCE ?? 40);

const COMMON_TLDS = new Set([
    "com", "net", "org", "biz", "info", "edu", "gov", "lk", "co", "io", "uk", "us", "in", "au", "sg", "ae", "asia", "global", "online", "tech", "lanka",
]);

/** Real top-level domain: a country code or one of the common generic ones. An OCR slip ("blz", "c0m") fails here. */
export function hasPlausibleTld(email: string): boolean {
    const tld = email.split(".").pop()?.toLowerCase() ?? "";
    return tld.length === 2 ? /^[a-z]{2}$/.test(tld) : COMMON_TLDS.has(tld);
}

export interface OcrEmail {
    email: string;
    confidence: number;
}

const EMAIL_IN_WORD_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/** Every employer-looking address in the recognised text, with the engine's confidence in the word it came from. */
export function emailsFromOcr(result: OcrResult): OcrEmail[] {
    const found = new Map<string, number>();

    for (const word of result.words) {
        for (const match of word.text.match(EMAIL_IN_WORD_RE) ?? []) {
            const email = findApplyEmail(match);
            if (email) found.set(email, Math.max(found.get(email) ?? 0, word.confidence));
        }
    }

    // addresses the word list missed (split across words) are kept, but with no confidence at all
    const fromText = findApplyEmail(result.text);
    if (fromText && !found.has(fromText)) found.set(fromText, 0);

    return [...found].map(([email, confidence]) => ({ email, confidence }));
}

/** DNS could not be reached, so an address could not be checked. Retrying later may succeed. */
export class DnsUnavailableError extends Error {
    constructor(email: string) {
        super(`Could not verify the mail domain of ${email}: DNS is unreachable`);
    }
}

/** One-letter local parts ("a@...") are what a half-read address looks like. */
const hasPlausibleLocalPart = (email: string) => (email.split("@")[0]?.length ?? 0) >= 2;

/** Addresses from the ad pictures that pass every check, best first, each address once. */
export async function trustedEmails(results: OcrResult[], dns?: DnsLookup): Promise<OcrEmail[]> {
    const candidates = results.flatMap(emailsFromOcr).sort((a, b) => b.confidence - a.confidence);
    const trusted: OcrEmail[] = [];

    for (const candidate of candidates) {
        if (trusted.some((existing) => existing.email === candidate.email)) continue;
        if (candidate.confidence < MIN_EMAIL_CONFIDENCE()) continue;
        if (!hasPlausibleLocalPart(candidate.email) || !hasPlausibleTld(candidate.email)) continue;

        const domain = await domainAcceptsMail(candidate.email.split("@")[1]!, dns);
        if (domain === "no") continue;
        // Without an answer the address cannot be vetted. Failing the whole read makes the caller try the ad again later.
        if (domain === "unknown") throw new DnsUnavailableError(candidate.email);

        trusted.push(candidate);
    }

    return trusted;
}

/**
 * The one address to offer for an ad, or null. An ad with several addresses (one per position, say)
 * is ambiguous: guessing would send the CV to the wrong person, so none is chosen.
 */
export async function pickTrustedEmail(results: OcrResult[], dns?: DnsLookup): Promise<OcrEmail | null> {
    const trusted = await trustedEmails(results, dns);
    return trusted.length === 1 ? trusted[0]! : null;
}

const WATERMARK_RE = /t[o0]pj[o0]bs\s*\.?\s*[lI1]k/gi;

/** Plain, readable text from OCR output: no watermark, no lines of stray symbols. */
export function cleanOcrText(text: string): string {
    return text
        .replace(WATERMARK_RE, " ")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " ").trim())
        .filter((line) => (line.match(/[a-z0-9]/gi) ?? []).length >= 3)
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

export { domainAcceptsMail, type DnsLookup, type MailDomainCheck } from "./mail-dns.js";
