import * as cheerio from "cheerio";
import { getText } from "../http.js";
import { htmlToText, pickApplyEmail, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const BASE = "https://observerjobs.lk";

interface ObserverJob {
    id: number;
    title: string;
    slug: string;
    company: { name: string; is_name_withheld: boolean; email_address: string; is_email_withheld: boolean } | null;
    deadline: string | null;
    categories: { name: string }[];
    salary: string | null;
    location: string | null;
    type: string | null;
    description: string | null;
    contact_email: string | null;
    minimum_qualification: string | null;
    years_experience: string | null;
    created_at: string | null;
}

// The site is a Laravel + Inertia app: page data is embedded as JSON in a data-page attribute
function readInertiaProps(html: string): Record<string, any> {
    const raw = cheerio.load(html)("[data-page]").attr("data-page");
    if (!raw) throw new Error("observerjobs: data-page payload not found");
    return JSON.parse(raw).props;
}

function toPosting(job: ObserverJob): JobPosting {
    // The advert itself is usually an attached notice (image/PDF), so the description is often
    // empty; the structured requirement fields are the only text available for matching then.
    const requirements = [
        job.minimum_qualification && `Minimum qualification: ${job.minimum_qualification}`,
        job.years_experience && `Experience: ${job.years_experience}`,
    ].filter(Boolean);
    const description = [htmlToText(job.description), ...requirements].filter(Boolean).join("\n") || null;
    const salary = job.salary && job.salary !== "0" ? job.salary : null;
    const companyEmail = job.company && !job.company.is_email_withheld ? squash(job.company.email_address) : "";

    return {
        source: "observerjobs",
        externalId: String(job.id),
        url: `${BASE}/vacancy/${job.id}/${job.slug}`,
        title: squash(job.title),
        company: job.company && !job.company.is_name_withheld ? squash(job.company.name) : null,
        location: squash(job.location) || null,
        description,
        jobType: job.type,
        salary,
        category: job.categories?.[0]?.name ?? null,
        postedAt: toIsoDate(job.created_at),
        closingAt: toIsoDate(job.deadline),
        applyEmail: pickApplyEmail(job.contact_email, companyEmail, description),
        applyUrl: `${BASE}/vacancy/${job.id}/${job.slug}`,
    };
}

export const observerjobs: JobSource = {
    id: "observerjobs",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];

        for (let page = 1; page <= maxPages; page++) {
            onProgress?.(jobs.length);
            const props = readInertiaProps(await getText(`${BASE}/vacancies?page=${page}`));
            const results = props.jobs ?? props.results;
            const batch: ObserverJob[] = results?.data ?? [];

            // The site sometimes serves an empty first page while later pages are populated
            if (batch.length === 0) {
                if (page === 1) continue;
                break;
            }

            jobs.push(...batch.map(toPosting));
            if (!results.next_page_url) break;
        }

        return jobs;
    },

    async enrich(job) {
        const props = readInertiaProps(await getText(job.url));
        const detail: ObserverJob | undefined = props.vacancy ?? props.job;
        if (!detail) return job;

        const full = toPosting(detail);
        return { ...job, description: full.description ?? job.description, applyEmail: full.applyEmail ?? job.applyEmail };
    },
};
