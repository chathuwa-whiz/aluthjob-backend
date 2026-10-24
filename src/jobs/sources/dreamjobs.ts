import * as cheerio from "cheerio";
import { getText } from "../http.js";
import { htmlToText, pickApplyEmail, relativeToIso, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const BASE = "https://www.dreamjobs.lk";

// Listing pages only show a few vacancies each, so every industry page is walked as well
async function collectLinks(path: string, jobs: Map<string, JobPosting>) {
    const $ = cheerio.load(await getText(`${BASE}${path}`));

    $("a[href^='/jobs/']").each((_, element) => {
        const link = $(element);
        const href = link.attr("href")!;
        const title = squash(link.find(".job-title").text());
        const slug = href.replace(/^\/jobs\//, "");
        if (!title || !slug || jobs.has(slug)) return;

        jobs.set(slug, {
            source: "dreamjobs",
            externalId: slug,
            url: `${BASE}${href}`,
            title,
            company: null,
            location: null,
            description: null,
            jobType: null,
            salary: null,
            category: path.startsWith("/industry/") ? path.replace("/industry/", "").replace(/-/g, " ") : null,
            postedAt: relativeToIso(link.find(".time-posted").text()),
            closingAt: null,
            applyEmail: null,
            applyUrl: `${BASE}${href}`,
        });
    });

    return $("a[href^='/industry/']")
        .map((_, element) => $(element).attr("href")!)
        .get();
}

export const dreamjobs: JobSource = {
    id: "dreamjobs",

    async fetchListings({ maxPages }) {
        const jobs = new Map<string, JobPosting>();

        const industries = [
            ...(await collectLinks("/jobs", jobs)),
            ...(await collectLinks("/", jobs)),
            ...(await collectLinks("/closing-soon", jobs)),
            ...(await collectLinks("/topjobs", jobs)),
            ...(await collectLinks("/entry-level", jobs)),
            ...(await collectLinks("/foreign-jobs", jobs)),
        ];

        for (const path of [...new Set(industries)].slice(0, maxPages * 10)) {
            await collectLinks(path, jobs);
        }

        return [...jobs.values()];
    },

    async enrich(job) {
        const $ = cheerio.load(await getText(job.url));

        for (const script of $("script[type='application/ld+json']").toArray()) {
            try {
                const data = JSON.parse($(script).html() ?? "");
                if (data?.["@type"] !== "JobPosting") continue;

                const description = htmlToText(String(data.description ?? "")) || null;
                const mailto = $("a[href^='mailto:']").map((_, a) => $(a).attr("href")).get().join(" ");

                return {
                    ...job,
                    description,
                    company: data.hiringOrganization?.name ?? job.company,
                    location: data.jobLocation?.address?.addressLocality ?? job.location,
                    jobType: data.employmentType ?? job.jobType,
                    postedAt: toIsoDate(data.datePosted) ?? job.postedAt,
                    closingAt: toIsoDate(data.validThrough) ?? job.closingAt,
                    applyEmail: pickApplyEmail(mailto, description),
                };
            } catch {
                // malformed JSON-LD block
            }
        }

        return job;
    },
};
