import { getJson } from "../http.js";
import { findApplyEmail, htmlToText, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const API = "https://xpress.jobs/api/jobs/searchJobs";
const PAGE_SIZE = 50;

interface XpressJob {
    jobId: number;
    jobTitle: string;
    organizationName: string | null;
    overview: string | null;
    expiryDateOnWebsite: string | null;
    jobType: string | null;
    locations: string | null;
    organizationSeoName: string | null;
    isGovernmentJob: boolean;
    remote: boolean;
}

interface XpressDetail {
    jobInfo: string | null;
    education: string | null;
    experience: string | null;
    salaryRange: string | null;
}

export const xpress: JobSource = {
    id: "xpress",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];

        for (let page = 1; page <= maxPages; page++) {
            onProgress?.(jobs.length);
            const query = new URLSearchParams({
                page: String(page),
                pageSize: String(PAGE_SIZE),
                keyword: "",
                locations: "",
                sectors: "",
                jobTypes: "",
                careerLevels: "",
                sortBy: "SortedCreateDate DESC",
                byCVLess: "false",
                byWalkIn: "false",
            });

            const batch = await getJson<XpressJob[]>(`${API}?${query}`);
            if (!Array.isArray(batch) || batch.length === 0) break;

            for (const job of batch) {
                jobs.push({
                    source: "xpress",
                    externalId: String(job.jobId),
                    url: `https://xpress.jobs/jobs/view/${job.jobId}`,
                    title: squash(job.jobTitle),
                    company: squash(job.organizationName) || null,
                    location: squash(job.locations) || null,
                    description: squash(job.overview) || null,
                    jobType: job.jobType,
                    salary: null,
                    category: job.isGovernmentJob ? "Government" : null,
                    postedAt: null,
                    closingAt: toIsoDate(job.expiryDateOnWebsite),
                    applyEmail: findApplyEmail(job.overview),
                    applyUrl: `https://xpress.jobs/jobs/view/${job.jobId}`,
                });
            }

        }

        return jobs;
    },

    async enrich(job) {
        const detail = await getJson<XpressDetail>(`https://xpress.jobs/api/jobs/publishedJob?jobId=${job.externalId}`);

        const requirements = [
            detail.education && detail.education !== "Any" && `Education: ${detail.education}`,
            detail.experience && detail.experience !== "Any" && `Experience: ${detail.experience}`,
        ].filter(Boolean);
        const description = [htmlToText(detail.jobInfo), ...requirements].filter(Boolean).join("\n") || job.description;
        const salary = detail.salaryRange && detail.salaryRange !== "Any" ? detail.salaryRange : job.salary;

        return { ...job, description, salary, applyEmail: findApplyEmail(description) };
    },
};
