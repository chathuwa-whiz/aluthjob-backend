import { dreamjobs } from "./dreamjobs.js";
import { governmentjobs } from "./governmentjobs.js";
import { ikman } from "./ikman.js";
import { jobpal } from "./jobpal.js";
import { observerjobs } from "./observerjobs.js";
import { rooster } from "./rooster.js";
import { topjobs } from "./topjobs.js";
import { xpress } from "./xpress.js";
import type { JobSource, JobSourceId } from "../types.js";

export const sources: Record<JobSourceId, JobSource> = {
    topjobs,
    observerjobs,
    jobpal,
    governmentjobs,
    rooster,
    dreamjobs,
    ikman,
    xpress,
};

export const sourceIds = Object.keys(sources) as JobSourceId[];
