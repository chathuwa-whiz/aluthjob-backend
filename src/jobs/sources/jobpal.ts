import * as cheerio from "cheerio";
import { getJson, getText } from "../http.js";
import { htmlToText, pickApplyEmail, relativeToIso, squash } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const API = "https://jobpal.lk/jm-ajax/get_listings/";
const PAGE_SIZE = 30;

interface JobpalResponse {
    html: string;
    max_num_pages: number;
}

function parseListings(html: string): JobPosting[] {
    const $ = cheerio.load(html);
    const jobs: JobPosting[] = [];

    $("li.job_listing").each((_, element) => {
        const item = $(element);
        const url = item.attr("data-href") ?? item.find("a.job_listing-clickbox").attr("href");
        const id = item.attr("id")?.replace("job_listing-", "");
        if (!url || !id) return;

        jobs.push({
            source: "jobpal",
            externalId: id,
            url,
            title: squash(item.find(".job_listing-title").text()),
            company: squash(item.find(".job_listing-company").text()) || null,
            location: squash(item.find(".job_listing-location").text()) || null,
            description: null,
            jobType: squash(item.find(".job_listing-type").text()) || null,
            salary: squash(item.find(".job_listing-salary").text()) || null,
            category: item.attr("class")?.match(/job_listing_category-(\S+)/)?.[1]?.replace(/-/g, " ") ?? null,
            postedAt: relativeToIso(item.find(".job_listing-date").text()),
            closingAt: null,
            applyEmail: null,
            applyUrl: url,
        });
    });

    return jobs;
}

export const jobpal: JobSource = {
    id: "jobpal",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];

        for (let page = 1; page <= maxPages; page++) {
            onProgress?.(jobs.length);
            const response = await getJson<JobpalResponse>(API, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body: new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page), orderby: "date" }),
            });

            jobs.push(...parseListings(response.html));
            if (page >= response.max_num_pages) break;
        }

        return jobs;
    },

    async enrich(job) {
        const $ = cheerio.load(await getText(job.url));
        const description = htmlToText($(".job_listing-description").first().html()) || null;

        // WP Job Manager keeps the employer's address in the (collapsed) application block;
        // the page footer has portal mailto links, which pickApplyEmail filters out.
        const application = $(".job_application").html();

        return { ...job, description, applyEmail: pickApplyEmail(application, description) };
    },
};
