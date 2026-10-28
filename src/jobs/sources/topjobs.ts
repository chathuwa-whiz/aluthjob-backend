import * as cheerio from "cheerio";
import { cleanOcrText, pickTrustedEmail } from "../../ocr/ocr-email.js";
import { recognizeImage, type OcrResult } from "../../ocr/ocr.service.js";
import { getText, request, ResponseTooLargeError } from "../http.js";
import { absoluteUrl, htmlToText, pickApplyEmail, squash, toIsoDate } from "../text.js";
import type { JobPosting, JobSource } from "../types.js";

const BASE = "https://www.topjobs.lk";
const LISTING_URL = `${BASE}/applicant/vacancybyfunctionalarea.jsp?jst=OPEN`;

// createAlert('rowIndex','ac','jc','ec','token') is the row's onclick handler
const ONCLICK_RE = /createAlert\('[^']*','([^']*)','([^']*)','([^']*)'/;

function advertUrl(ac: string, jc: string, ec: string): string {
    return `${BASE}/employer/JobAdvertismentServlet?rid=0&ac=${ac}&jc=${jc}&ec=${ec}&pg=applicant/vacancybyfunctionalarea.jsp`;
}

export const topjobs: JobSource = {
    id: "topjobs",

    // The whole list of open vacancies is one server-rendered page, so there is no paging.
    async fetchListings() {
        const $ = cheerio.load(await getText(LISTING_URL));
        const jobs: JobPosting[] = [];

        $("tr[onclick^='createAlert']").each((_, row) => {
            const tr = $(row);
            const match = tr.attr("onclick")?.match(ONCLICK_RE);
            if (!match) return;

            const [, ac, jc, ec] = match as unknown as [string, string, string, string];
            const cells = tr.children("td");
            const title = squash(cells.eq(2).find("h2").text());
            if (!title) return;

            const url = advertUrl(ac, jc, ec);

            jobs.push({
                source: "topjobs",
                externalId: jc,
                url,
                title,
                company: squash(cells.eq(2).find("h1").text()) || null,
                location: squash(cells.eq(6).text()) || null,
                description: squash(cells.eq(3).text()).replace(/\s*\.{2,}\s*$/, "") || null,
                jobType: null,
                salary: null,
                category: null,
                postedAt: toIsoDate(cells.eq(4).text()),
                closingAt: toIsoDate(cells.eq(5).text()),
                applyEmail: null,
                applyUrl: url,
            });
        });

        return jobs;
    },

    async enrich(job) {
        const page = parseAdPage(await getText(job.url), job.url);
        const pageEmail = pickApplyEmail(...page.mailtos, page.text);

        // Most employers upload their advert as a picture, so the page itself has no text at all
        let imageText: string[] = [];
        let imageEmail: string | null = null;

        if (page.text.length < TEXT_AD_MIN_CHARS && page.imageUrls.length > 0) {
            const results = await readAdImages(page.imageUrls);
            imageText = results.map((result) => cleanOcrText(result.text)).filter(Boolean);
            imageEmail = (await pickTrustedEmail(results))?.email ?? null;
        }

        const description = [page.text, ...imageText].filter(Boolean).join("\n\n").slice(0, MAX_DESCRIPTION_CHARS) || job.description;
        const applyEmail = pageEmail ?? imageEmail;

        return { ...job, description, applyEmail, applyEmailSource: applyEmail ? (pageEmail ? "page" : "image") : null };
    },
};

// ---- advert page -----------------------------------------------------------------------

// A page whose advert body has less text than this is a picture advert
const TEXT_AD_MIN_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 12_000;
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface AdPage {
    /** Text of the advert body; empty for picture adverts. */
    text: string;
    mailtos: string[];
    /** Absolute URLs of the advert pictures (never the company logos or site icons). */
    imageUrls: string[];
}

/** The advert body is `#remark`: either the employer's text, or a picture of their poster. */
export function parseAdPage(html: string, pageUrl: string): AdPage {
    const $ = cheerio.load(html);
    const body = $("#remark");

    const imageUrls: string[] = [];
    body.find("img").each((_, element) => {
        const url = absoluteUrl($(element).attr("src"), pageUrl);
        if (!url) return;

        const { host, pathname } = new URL(url);
        // Only the site's own uploads: /logo/<employer>/<file>.png|jpg; "<id>_small" files are logos
        if (host !== "www.topjobs.lk" || !/^\/logo\/[^/]+\/[^/]+\.(?:png|jpe?g)$/i.test(pathname)) return;
        if (!imageUrls.includes(url)) imageUrls.push(url);
    });

    return {
        text: htmlToText(body.html()),
        mailtos: body
            .find("a[href^='mailto:']")
            .map((_, anchor) => $(anchor).attr("href")!.replace(/^mailto:/i, "").split("?")[0]!)
            .get(),
        imageUrls: imageUrls.slice(0, MAX_IMAGES),
    };
}

async function readAdImages(urls: string[]): Promise<OcrResult[]> {
    const results: OcrResult[] = [];

    for (const url of urls) {
        try {
            const response = await request(url, {}, MAX_IMAGE_BYTES);
            const image = Buffer.from(await response.arrayBuffer());
            results.push(await recognizeImage(image));
        } catch (error) {
            if (!(error instanceof ResponseTooLargeError)) throw error;
        }
    }

    return results;
}
