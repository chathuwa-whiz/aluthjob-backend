import type { ResumeLink } from "./text-extraction.service.js";

export interface ContactInfo {
    email: string | null;
    phone: string | null;
    linkedin: string | null;
    portfolio: string | null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/[^\s,;)\]]+/i;
const PORTFOLIO_RE = /(?:https?:\/\/|www\.)[^\s,;)\]]+|(?:github\.com|gitlab\.com|behance\.net|dribbble\.com)\/[^\s,;)\]]+/gi;
const PHONE_RE = /\+?\(?\d[\d\s().-]{7,}\d/g;
const DATE_RANGE_RE = /^\d{4}\s*[-–]\s*\d{4}$/;

const trimTrailingPunctuation = (value: string) => value.replace(/[.,;:]+$/, "");

function findPhone(text: string): string | null {
    for (const match of text.matchAll(PHONE_RE)) {
        const candidate = match[0].trim();
        const digits = candidate.replace(/\D/g, "");

        if (digits.length < 9 || digits.length > 15) continue;
        if (DATE_RANGE_RE.test(candidate)) continue;

        return candidate;
    }

    return null;
}

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

export function extractContactInfo(text: string, links: ResumeLink[] = []): ContactInfo {
    // Hyperlinked words such as "LinkedIn" only exist as annotations, never in the text
    const webLinks = links.filter((link) => isWebUrl(link.url));
    const linkedinLink = webLinks.find((link) => /linkedin\.com/i.test(link.url));
    const portfolioLink =
        webLinks.find((link) => /portfolio|website|personal/i.test(link.text) && !/linkedin\.com/i.test(link.url)) ??
        webLinks.find((link) => !/linkedin\.com|github\.com|gitlab\.com/i.test(link.url));

    const email = text.match(EMAIL_RE)?.[0] ?? null;

    const linkedinMatch = text.match(LINKEDIN_RE)?.[0];
    const linkedin = linkedinMatch ? trimTrailingPunctuation(linkedinMatch) : (linkedinLink?.url ?? null);

    const portfolioMatch = [...text.matchAll(PORTFOLIO_RE)]
        .map((match) => trimTrailingPunctuation(match[0]))
        .find((url) => !/linkedin\.com/i.test(url));

    return {
        email,
        phone: findPhone(text),
        linkedin,
        portfolio: portfolioMatch ?? portfolioLink?.url ?? null,
    };
}
