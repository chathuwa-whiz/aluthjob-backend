import * as cheerio from "cheerio";
import { getText } from "../http.js";
import { absoluteUrl, findApplyEmail, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const BASE = "https://governmentjobs.lk/";

// Titles read "<Post> - <Institution>"; the second heading of each entry is a Sinhala
// rendering in a legacy font, which is useless as text and skipped.
function splitTitle(title: string): { post: string; institution: string | null } {
    const index = title.lastIndexOf(" - ");
    if (index < 0) return { post: title, institution: null };
    return { post: title.slice(0, index).trim(), institution: title.slice(index + 3).trim() };
}

export const governmentjobs: JobSource = {
    id: "governmentjobs",

    // The home page lists the newest gazette and newspaper vacancies; older ones are not paged
    async fetchListings() {
        const $ = cheerio.load(await getText(`${BASE}index.php`));
        const jobs: JobPosting[] = [];
        const seen = new Set<string>();

        $("a[href^='vacancy_details.php']:not(.sinhala)").each((_, element) => {
            const link = $(element);
            const href = link.attr("href");
            const id = href?.match(/aid=([^&]+)/)?.[1];
            const title = squash(link.text());
            if (!href || !id || !title || seen.has(id)) return;
            seen.add(id);

            const { post, institution } = splitTitle(title);
            const url = absoluteUrl(href, BASE)!;

            jobs.push({
                source: "governmentjobs",
                externalId: id,
                url,
                title: post,
                company: institution,
                location: null,
                description: null,
                jobType: null,
                salary: null,
                category: "Government",
                postedAt: null,
                closingAt: null,
                applyEmail: null,
                applyUrl: url,
            });
        });

        return jobs;
    },

    async enrich(job) {
        const $ = cheerio.load(await getText(job.url));
        const text = squash($(".container, #content, body").first().text());

        const closing = text.match(/Closing Date:\s*(\d{4}-\d{2}-\d{2})/)?.[1];
        const published = text.match(/Published Date:\s*(\d{4}-\d{2}-\d{2})/)?.[1];

        return {
            ...job,
            closingAt: toIsoDate(closing) ?? job.closingAt,
            postedAt: toIsoDate(published) ?? job.postedAt,
            description: text.match(/Applications are now being called[\s\S]*/)?.[0].slice(0, 2000) ?? job.description,
            applyEmail: findApplyEmail(text),
        };
    },
};
