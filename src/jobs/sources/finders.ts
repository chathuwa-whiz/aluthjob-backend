import * as cheerio from "cheerio";
import { getText } from "../http.js";
import { findApplyEmail, htmlToText, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const BASE = "https://www.finders.lk";
// A page holds only 10 vacancies (the other sources 30-100), so walk proportionally more of them
const PAGES_PER_UNIT = 4;

function parseListings(html: string): JobPosting[] {
    const $ = cheerio.load(html);
    const jobs: JobPosting[] = [];

    $("a.listing").each((_, element) => {
        const card = $(element);
        const url = card.attr("href");
        const slug = url?.match(/\/job\/([^/?#]+)/)?.[1];
        if (!url || !slug) return;

        const type = squash(card.find(".listing-type").text());
        const title = card.find("h4").first().clone();
        title.find(".listing-type").remove();
        // each facet is <li><i class="ln ln-icon-Map2"></i> Colombo 05</li>
        const facet = (icon: string) => squash(card.find(`li:has(i.ln-icon-${icon})`).text()) || null;

        jobs.push({
            source: "finders",
            externalId: slug,
            url,
            title: squash(title.text()),
            company: facet("Management"),
            location: facet("Map2"),
            description: null,
            jobType: type || null,
            salary: facet("Money-2"),
            category: null,
            postedAt: null,
            closingAt: null,
            applyEmail: null,
            applyUrl: url,
        });
    });

    return jobs;
}

export const finders: JobSource = {
    id: "finders",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];
        const seen = new Set<string>();

        for (let page = 1; page <= maxPages * PAGES_PER_UNIT; page++) {
            onProgress?.(jobs.length);
            const fresh = parseListings(await getText(`${BASE}/job?page=${page}`)).filter((job) => !seen.has(job.externalId));
            if (fresh.length === 0) break;

            for (const job of fresh) seen.add(job.externalId);
            jobs.push(...fresh);
        }

        return jobs;
    },

    /** The listing is a teaser; the advert page carries the description and the real dates. */
    async enrich(job) {
        const $ = cheerio.load(await getText(job.url));
        const posting = $("script[type='application/ld+json']")
            .toArray()
            .map((script) => $(script).html() ?? "")
            .find((json) => json.includes('"JobPosting"'));
        if (!posting) return job;

        // The block is not valid JSON (it contains // comments), so the fields are read one by one
        const field = (name: string): string | null => {
            const raw = posting.match(new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`))?.[1];
            if (!raw) return null;
            try {
                return JSON.parse(raw) as string;
            } catch {
                return null;
            }
        };

        // the description is HTML that was escaped once more ("&lt;p&gt;...")
        const description = htmlToText(cheerio.load(field("description") ?? "").text()) || job.description;
        return {
            ...job,
            description,
            postedAt: toIsoDate(field("datePosted")) ?? job.postedAt,
            closingAt: toIsoDate(field("validThrough")) ?? job.closingAt,
            applyEmail: findApplyEmail(description),
        };
    },
};
