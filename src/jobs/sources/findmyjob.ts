import * as cheerio from "cheerio";
import { getText, request } from "../http.js";
import { htmlToText, pickApplyEmail, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

// FindMyJob.lk is a WordPress site (WP Job Manager add-on "awsm"); its public REST API lists the vacancies
const API = "https://findmyjob.lk/wp-json/wp/v2/awsm_job_openings";
const PAGE_SIZE = 100;

interface FindMyJobPost {
    id: number;
    date: string;
    link: string;
    slug: string;
    title: { rendered: string };
    content: { rendered: string };
    class_list: string[];
}

/** The API only exposes company, place, category and type as CSS-style slugs ("job-location-colombo-7"). */
function term(classes: string[], prefix: string, notPrefix?: string): string | null {
    const found = classes.find((name) => name.startsWith(prefix) && !(notPrefix && name.startsWith(notPrefix)));
    const slug = found?.slice(prefix.length);
    return slug ? slug.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") : null;
}

/** Cloudflare hides addresses in the page as "[email protected]"; the real one is XOR-encoded in data-cfemail. */
function decodeCloudflareEmail(encoded: string): string {
    const key = parseInt(encoded.slice(0, 2), 16);
    let email = "";
    for (let i = 2; i < encoded.length; i += 2) email += String.fromCharCode(parseInt(encoded.slice(i, i + 2), 16) ^ key);
    return email;
}

export const findmyjob: JobSource = {
    id: "findmyjob",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];

        for (let page = 1; page <= maxPages; page++) {
            onProgress?.(jobs.length);
            const query = new URLSearchParams({
                per_page: String(PAGE_SIZE),
                page: String(page),
                _fields: "id,date,link,slug,title,content,class_list",
            });

            const response = await request(`${API}?${query}`);
            const batch = (await response.json()) as FindMyJobPost[];
            if (!Array.isArray(batch) || batch.length === 0) break;

            for (const post of batch) {
                const classes = post.class_list ?? [];
                const description = htmlToText(post.content?.rendered) || null;

                jobs.push({
                    source: "findmyjob",
                    externalId: String(post.id),
                    url: post.link,
                    title: squash(htmlToText(post.title?.rendered)),
                    company: term(classes, "company-", "company-email-"),
                    location: term(classes, "job-location-"),
                    description,
                    jobType: term(classes, "job-type-"),
                    salary: null,
                    category: term(classes, "job-category-"),
                    postedAt: toIsoDate(post.date),
                    closingAt: null,
                    applyEmail: pickApplyEmail(description),
                    applyUrl: post.link,
                });
            }

            if (page >= Number(response.headers.get("x-wp-totalpages") ?? page)) break;
        }

        return jobs;
    },

    /** The listing only has slugs; the advert page has the real company name, its email and the closing date. */
    async enrich(job) {
        const $ = cheerio.load(await getText(job.url));
        $("[data-cfemail]").each((_, element) => {
            $(element).replaceWith(decodeCloudflareEmail($(element).attr("data-cfemail") ?? ""));
        });

        const spec = (name: string) => squash($(`.awsm-job-specification-${name} .awsm-job-specification-term`).first().text()) || null;
        const description = htmlToText($(".awsm-job-entry-content").first().html()) || job.description;

        return {
            ...job,
            description,
            company: spec("company") ?? job.company,
            location: spec("job-location") ?? job.location,
            category: spec("job-category") ?? job.category,
            jobType: spec("job-type") ?? job.jobType,
            closingAt: toIsoDate($(".awsm-job-expiration-content").first().text()) ?? job.closingAt,
            applyEmail: pickApplyEmail(spec("company-email"), description),
        };
    },
};
