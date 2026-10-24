import * as cheerio from "cheerio";
import { getText } from "../http.js";
import { findApplyEmail, htmlToText, squash } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const BASE = "https://ikman.lk";

export const ikman: JobSource = {
    id: "ikman",

    async fetchListings({ maxPages, onProgress }) {
        const jobs: JobPosting[] = [];
        const seen = new Set<string>();

        for (let page = 1; page <= maxPages; page++) {
            onProgress?.(jobs.length);
            const $ = cheerio.load(await getText(`${BASE}/en/ads/sri-lanka/jobs?sort=date_desc&page=${page}`));
            let added = 0;

            $("li.gtm-normal-ad").each((_, element) => {
                const card = $(element);
                const href = card.find("a[data-testid='ad-card-link']").first().attr("href");
                const slug = href?.match(/\/en\/ad\/([^/?#]+)/)?.[1];
                if (!href || !slug || seen.has(slug)) return;
                seen.add(slug);

                // Card body: <div>employer</div><div class="description">District, Category</div>
                const body = card.find("[data-testid='ad-meta'] a").first().children("div").first();
                const company = squash(body.children("div").first().text());
                const [district, category] = squash(body.find("[class^='description']").text()).split(/,\s*/);

                jobs.push({
                    source: "ikman",
                    externalId: slug,
                    url: `${BASE}${href}`,
                    title: squash(card.find("h2").first().text()),
                    company: company || null,
                    location: district || null,
                    description: null,
                    jobType: null,
                    salary: null,
                    category: category || null,
                    postedAt: null,
                    closingAt: null,
                    applyEmail: null,
                    applyUrl: `${BASE}${href}`,
                });
                added++;
            });

            if (added === 0) break;
        }

        return jobs;
    },

    async enrich(job) {
        const $ = cheerio.load(await getText(job.url));

        for (const script of $("script[type='application/ld+json']").toArray()) {
            try {
                const data = JSON.parse($(script).html() ?? "");
                const entries: any[] = Array.isArray(data) ? data : [data];
                const posting = entries.find((entry) => entry?.description);
                if (!posting) continue;

                const description = htmlToText(String(posting.description)) || job.description;
                return { ...job, description, applyEmail: findApplyEmail(description) };
            } catch {
                // not the JSON-LD block we are looking for
            }
        }

        return job;
    },
};
