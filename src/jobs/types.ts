export type JobSourceId =
    | "topjobs"
    | "observerjobs"
    | "jobpal"
    | "governmentjobs"
    | "rooster"
    | "dreamjobs"
    | "ikman"
    | "xpress";

/** A vacancy normalised across all sources. */
export interface JobPosting {
    source: JobSourceId;
    /** Id of the vacancy inside its source; (source, externalId) is unique. */
    externalId: string;
    url: string;
    title: string;
    company: string | null;
    location: string | null;
    /** Plain-text description. May be only a teaser until enriched from the detail page. */
    description: string | null;
    jobType: string | null;
    salary: string | null;
    category: string | null;
    postedAt: string | null;
    closingAt: string | null;
    /** Employer address to send an application to, when the ad publishes one. */
    applyEmail: string | null;
    /**
     * How applyEmail was found. "image" means it was read from a picture by OCR and may contain a
     * misread character, so the user must confirm it before anything is sent. Treated as "page" when omitted.
     */
    applyEmailSource?: "page" | "image" | null;
    /** Where to apply online, when the ad points to an external form or portal. */
    applyUrl: string | null;
}

export interface FetchOptions {
    /** Maximum number of listing pages to walk per source. */
    maxPages: number;
    /** Called as the source works through its pages with the number of vacancies found so far. */
    onProgress?: (found: number) => void;
}

export interface JobSource {
    id: JobSourceId;
    /** Walks the newest listings of the source. */
    fetchListings(options: FetchOptions): Promise<JobPosting[]>;
    /** Loads the detail page to fill in description and apply contacts. Optional. */
    enrich?(job: JobPosting): Promise<JobPosting>;
}
