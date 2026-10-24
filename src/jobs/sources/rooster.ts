import { getJson } from "../http.js";
import { findApplyEmail, htmlToText, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const API = "https://api.rooster.jobs/jobSearch/jobs/search";
const PAGE_SIZE = 50;

interface RoosterJob {
    id: number;
    title: string;
    description: string | null;
    job_type: string | null;
    location: string | null;
    created_at: string | null;
    company_name: string | null;
    subsidiary_company_name: string | null;
    min_salary: number | null;
    max_salary: number | null;
    salary_currency: string | null;
    salary_frequency: string | null;
    class: string | null;
}

interface RoosterResponse {
    body: { count: number; data: RoosterJob[] };
}

function salaryRange(job: RoosterJob): string | null {
    if (!job.min_salary && !job.max_salary) return null;

    const range = [job.min_salary, job.max_salary].filter(Boolean).join(" - ");
    return squash(`${job.salary_currency ?? ""} ${range} ${job.salary_frequency ?? ""}`);
}

export const rooster: JobSource = {
    id: "rooster",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];

        for (let page = 1; page <= maxPages; page++) {
            onProgress?.(jobs.length);
            const response = await getJson<RoosterResponse>(API, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ query: [], limit: PAGE_SIZE, page, filters: {} }),
            });

            const batch = response.body?.data ?? [];
            if (batch.length === 0) break;

            for (const job of batch) {
                const description = htmlToText(job.description) || null;

                jobs.push({
                    source: "rooster",
                    externalId: String(job.id),
                    url: `https://rooster.jobs/jobs/${job.id}`,
                    title: squash(job.title),
                    company: squash(job.subsidiary_company_name ?? job.company_name) || null,
                    location: squash(job.location) || null,
                    description,
                    jobType: job.job_type,
                    salary: salaryRange(job),
                    category: job.class,
                    // timestamps are UTC without a zone marker
                    postedAt: toIsoDate(job.created_at ? `${job.created_at.replace(" ", "T")}Z` : null),
                    closingAt: null,
                    applyEmail: findApplyEmail(description),
                    applyUrl: `https://rooster.jobs/jobs/${job.id}`,
                });
            }

            // pages come back slightly short (47-50 of 50) when the API drops duplicates, so only an empty page ends the walk
        }

        return jobs;
    },
};
