import type { Resume } from "../schemas/resume.schema.js";
import type { JobPosting } from "../jobs/types.js";
import { contentTerms, isMatchableSkillKey, skillKey, skillKeysIn, titleTerms } from "./text-utils.js";

export interface ScoreBreakdown {
    /** Share of the resume's skills the ad asks for, 0..1 */
    skills: number;
    /** How close the job title is to the candidate's past roles and field, 0..1 */
    title: number;
    /** Overall vocabulary overlap between resume and ad, weighted by how rare each word is, 0..1 */
    content: number;
    /** Required experience vs. the candidate's years of experience, 0..1 */
    experience: number;
    /** Same city / remote / same country, 0..1 */
    location: number;
}

export interface MatchScore {
    /** 0..100 */
    score: number;
    breakdown: ScoreBreakdown;
    matchedSkills: string[];
    reasons: string[];
    warnings: string[];
}

export interface Corpus {
    documentCount: number;
    documentFrequency: Map<string, number>;
}

export interface ProfileModel {
    /** skill key -> name as written in the resume */
    skills: Map<string, string>;
    /** term sets of past job titles (kind "role") and of degrees/fields of study (kind "education") */
    roleTitles: { label: string; terms: Set<string>; kind: "role" | "education" }[];
    /** every informative term in the resume */
    terms: Set<string>;
    /** work history with the dates in months; `span` is null when the dates could not be read */
    positions: { titleTerms: Set<string>; skillKeys: Set<string>; span: Span | null }[];
    yearsOfExperience: number;
    cityTokens: Set<string>;
    country: string | null;
}

type Span = readonly [startMonth: number, endMonthExclusive: number];

const WEIGHTS: ScoreBreakdown = { skills: 0.3, title: 0.25, content: 0.25, experience: 0.1, location: 0.1 };

// Cosine similarity of resume and ad vocabularies rarely exceeds this even for a very good match
const CONTENT_SATURATION = 0.3;
const SKILL_SATURATION = 3;
const NEUTRAL = 0.6;

export function buildCorpus(jobs: Pick<JobPosting, "title" | "description" | "category">[]): Corpus {
    const documentFrequency = new Map<string, number>();

    for (const job of jobs) {
        for (const term of jobTerms(job)) {
            documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
        }
    }

    return { documentCount: jobs.length, documentFrequency };
}

const jobTerms = (job: Pick<JobPosting, "title" | "description" | "category">) =>
    contentTerms(`${job.title} ${job.title} ${job.category ?? ""} ${job.description ?? ""}`);

function idf(corpus: Corpus, term: string): number {
    const df = corpus.documentFrequency.get(term) ?? 0;
    return Math.log((corpus.documentCount + 1) / (df + 1)) + 1;
}

// ---- profile ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Month number (year * 12 + month) of a resume date. The model is asked for YYYY-MM but often
 * writes "Dec 2024", "12/2024" or just "2021"; a bare year means January when it starts a job
 * and December when it ends one.
 */
export function parseMonth(value: string | null, now: Date, edge: "start" | "end" = "start"): number | null {
    const text = value?.trim().toLowerCase();
    if (!text) return null;
    if (/^(present|current|now|ongoing|till date|to date|date)\b/.test(text)) return now.getFullYear() * 12 + now.getMonth();

    const named = text.match(/\b([a-z]{3})[a-z]*\.?,?\s+(\d{4})\b/);
    if (named && MONTHS.includes(named[1]!)) return Number(named[2]) * 12 + MONTHS.indexOf(named[1]!);

    const yearFirst = text.match(/\b(\d{4})[-/.](\d{1,2})\b/);
    if (yearFirst) return Number(yearFirst[1]) * 12 + Math.min(Number(yearFirst[2]), 12) - 1;

    const monthFirst = text.match(/\b(\d{1,2})[-/.](\d{4})\b/);
    if (monthFirst) return Number(monthFirst[2]) * 12 + Math.min(Number(monthFirst[1]), 12) - 1;

    const year = text.match(/\b((?:19|20)\d{2})\b/);
    return year ? Number(year[1]) * 12 + (edge === "end" ? 11 : 0) : null;
}

function toSpan(job: Resume["experience"][number], now: Date): Span | null {
    const start = parseMonth(job.startDate, now, "start");
    if (start === null) return null;

    const end = parseMonth(job.endDate, now, "end") ?? start;
    return [start, Math.max(start, end) + 1];
}

/** Months covered by the spans; overlapping spans are counted once. */
function coveredMonths(spans: Span[]): number {
    let months = 0;
    let coveredUntil = -Infinity;

    for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
        months += Math.max(0, end - Math.max(start, coveredUntil));
        coveredUntil = Math.max(coveredUntil, end);
    }

    return months;
}

const toYears = (months: number) => Math.round((months / 12) * 10) / 10;

/** Years of work covered by the experience entries; overlapping jobs are counted once. */
export function yearsOfExperience(experience: Resume["experience"], now = new Date()): number {
    return toYears(coveredMonths(experience.map((job) => toSpan(job, now)).filter((span): span is Span => span !== null)));
}

export function buildProfileModel(profile: Resume, now = new Date()): ProfileModel {
    const skills = new Map<string, string>();
    for (const skill of profile.skills) {
        const key = skillKey(skill);
        if (isMatchableSkillKey(key) && !skills.has(key)) skills.set(key, skill);
    }

    // school-level qualifications say nothing about a career field
    const schoolLevel = /\b(g\.?c\.?e\.?|advanced level|ordinary level|a\/l|o\/l|school)\b/i;

    const roleTitles = [
        ...profile.experience.map((job) => ({ kind: "role" as const, label: job.position, text: job.position })),
        ...profile.education
            .filter((edu) => !schoolLevel.test(edu.degree ?? ""))
            .map((edu) => ({ kind: "education" as const, label: edu.degree, text: [edu.degree, edu.field].filter(Boolean).join(" ") })),
    ]
        .map(({ kind, label, text }) => ({ kind, label: label ?? text ?? "", terms: titleTerms(text ?? "") }))
        .filter((role) => role.label && role.terms.size > 0);

    const positions = profile.experience.map((job) => ({
        titleTerms: titleTerms(job.position ?? ""),
        skillKeys: new Set([...skillKeysIn([job.position, ...job.responsibilities].filter(Boolean).join("\n"))].filter((key) => skills.has(key))),
        span: toSpan(job, now),
    }));

    const text = [
        ...profile.skills,
        ...profile.experience.flatMap((job) => [job.position, ...job.responsibilities]),
        ...profile.education.flatMap((edu) => [edu.degree, edu.field]),
        ...profile.certifications,
        ...profile.achievements.map((achievement) => achievement.description),
    ]
        .filter(Boolean)
        .join("\n");

    const locationParts = (profile.personalInfo.location ?? "")
        .toLowerCase()
        .split(/[,/]/)
        .map((part) => part.trim())
        .filter(Boolean);

    // "Colombo, Sri Lanka" -> city Colombo, country Sri Lanka; a lone "Colombo" is a city
    const cityParts = locationParts.length > 1 ? locationParts.slice(0, -1) : locationParts;

    return {
        skills,
        roleTitles,
        positions,
        terms: contentTerms(text),
        yearsOfExperience: yearsOfExperience(profile.experience, now),
        cityTokens: new Set(cityParts.flatMap((part) => part.split(/\s+/))),
        country: locationParts.length > 1 ? locationParts[locationParts.length - 1]! : null,
    };
}

// ---- components ------------------------------------------------------------------------

function scoreSkills(model: ProfileModel, job: JobPosting) {
    const inTitle = skillKeysIn(job.title);
    const inText = skillKeysIn(`${job.title}\n${job.description ?? ""}`);

    const matched: string[] = [];
    const matchedKeys = new Set<string>();
    let weighted = 0;

    for (const [key, name] of model.skills) {
        if (!inText.has(key)) continue;
        matched.push(name);
        matchedKeys.add(key);
        // a skill named in the job title is the heart of the role
        weighted += inTitle.has(key) ? 2 : 1;
    }

    return { value: 1 - Math.exp(-weighted / SKILL_SATURATION), matched, matchedKeys };
}

function scoreTitle(model: ProfileModel, job: JobPosting) {
    const jobTitle = titleTerms(job.title);
    if (jobTitle.size === 0) return { value: 0, closestRole: null, closestKind: null };

    let best = 0;
    let closestRole: string | null = null;
    let closestKind: "role" | "education" | null = null;

    for (const role of model.roleTitles) {
        const shared = [...jobTitle].filter((term) => role.terms.has(term)).length;
        const dice = (2 * shared) / (jobTitle.size + role.terms.size);

        if (dice > best) {
            best = dice;
            closestRole = role.label;
            closestKind = role.kind;
        }
    }

    // Fraction of the title's words that occur anywhere in the resume ("Customer Care ..." for
    // someone who did customer care in a longer-titled role)
    const coverage = [...jobTitle].filter((term) => model.terms.has(term)).length / jobTitle.size;

    return { value: Math.min(1, Math.max(best, 0.8 * coverage)), closestRole, closestKind };
}

function scoreContent(model: ProfileModel, job: JobPosting, corpus: Corpus) {
    const terms = jobTerms(job);
    if (terms.size === 0 || model.terms.size === 0) return 0;

    let dot = 0;
    let jobNorm = 0;
    let profileNorm = 0;

    for (const term of terms) {
        const weight = idf(corpus, term) ** 2;
        jobNorm += weight;
        if (model.terms.has(term)) dot += weight;
    }
    for (const term of model.terms) profileNorm += idf(corpus, term) ** 2;

    return Math.min(1, dot / Math.sqrt(jobNorm * profileNorm) / CONTENT_SATURATION);
}

const SENIOR_TITLE_RE = /\b(senior|sr\.?|lead|principal|head|manager|director|chief|architect)\b/i;
const JUNIOR_TITLE_RE = /\b(junior|jr\.?|trainee|intern|internship|graduate|fresher|entry[- ]level|apprentice)\b/i;
const YEARS_RE = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|to)\s*\d{1,2}\s*)?(?:years?|yrs?)\b[^.\n]{0,40}?experience|experience[^.\n]{0,30}?(\d{1,2})\s*(?:\+|plus)?\s*(?:years?|yrs?)/gi;

export function requiredYears(job: Pick<JobPosting, "title" | "description">): number | null {
    // Ads that state several figures ("2 years in X, minimum 5 years overall") are read at their strictest
    const stated = [...(job.description ?? "").matchAll(YEARS_RE)]
        .map((match) => Number(match[1] ?? match[2]))
        .filter((years) => years <= 30);
    if (stated.length > 0) return Math.max(...stated);

    if (JUNIOR_TITLE_RE.test(job.title)) return 0;
    if (SENIOR_TITLE_RE.test(job.title)) return 4;
    return null;
}

/**
 * Years of the candidate's work that relate to this job: positions with a similar title or that
 * used skills the ad asks for. Null when the resume's dates could not be read.
 */
export function relevantYears(model: ProfileModel, job: Pick<JobPosting, "title">, matchedKeys: Set<string>): number | null {
    if (model.positions.length === 0) return 0;
    if (model.positions.every((position) => position.span === null)) return null;

    const jobTitle = titleTerms(job.title);
    const relevant = model.positions.filter(
        (position) =>
            position.span !== null &&
            ([...jobTitle].some((term) => position.titleTerms.has(term)) || [...matchedKeys].some((key) => position.skillKeys.has(key))),
    );

    return toYears(coveredMonths(relevant.map((position) => position.span!)));
}

function scoreExperience(model: ProfileModel, job: JobPosting, matchedKeys: Set<string>) {
    const required = requiredYears(job);
    const relevant = relevantYears(model, job, matchedKeys);

    // Neither the ad nor the resume says enough to judge
    if (required === null || relevant === null) return { value: 0.7, required, relevant, gap: 0, warning: null };

    const gap = required - relevant;

    if (gap > 0) {
        return {
            value: Math.exp(-gap / 2),
            required,
            relevant,
            gap,
            warning: `Asks for about ${required} years of experience; your resume shows ${relevant} in related work`,
        };
    }

    // far more experienced than an entry-level ad wants
    const overqualified = JUNIOR_TITLE_RE.test(job.title) && relevant >= 4;
    return {
        value: overqualified ? 0.6 : 1,
        required,
        relevant,
        gap,
        warning: overqualified ? "Entry-level role; you may be overqualified" : null,
    };
}

const REMOTE_RE = /\b(remote|work from home|wfh|anywhere)\b/i;

function scoreLocation(model: ProfileModel, job: JobPosting) {
    const location = (job.location ?? "").toLowerCase();
    const remote = REMOTE_RE.test(`${location} ${job.title}`);

    if (remote) return { value: 1, foreign: false, label: "remote" };
    if (!location) return { value: NEUTRAL, foreign: false, label: null };

    const parts = location.split(",").map((part) => part.trim());
    const jobCountry = parts.length > 1 ? parts[parts.length - 1]! : null;

    // "Colombo, Sri Lanka" vs "Mumbai, India": a different country is not a commute
    if (jobCountry && model.country && !jobCountry.includes(model.country) && !model.country.includes(jobCountry)) {
        return { value: 0, foreign: true, label: job.location };
    }

    const sameCity = [...model.cityTokens].some((token) => token.length > 2 && location.includes(token));
    if (sameCity) return { value: 1, foreign: false, label: job.location };

    return { value: model.cityTokens.size === 0 ? NEUTRAL : 0.4, foreign: false, label: job.location };
}

// ---- combination -----------------------------------------------------------------------

export function scoreJob(model: ProfileModel, job: JobPosting, corpus: Corpus): MatchScore {
    const skills = scoreSkills(model, job);
    const title = scoreTitle(model, job);
    const content = scoreContent(model, job, corpus);
    const experience = scoreExperience(model, job, skills.matchedKeys);
    const location = scoreLocation(model, job);

    const breakdown: ScoreBreakdown = {
        skills: skills.value,
        title: title.value,
        content,
        experience: experience.value,
        location: location.value,
    };

    // A resume without a skills section must not be capped by an empty component
    const weights = { ...WEIGHTS };
    if (model.skills.size === 0) {
        weights.content += weights.skills / 2;
        weights.title += weights.skills / 2;
        weights.skills = 0;
    }

    let score = 100 * (Object.keys(weights) as (keyof ScoreBreakdown)[]).reduce((sum, key) => sum + weights[key] * breakdown[key], 0);

    const warnings: string[] = [];
    if (experience.warning) warnings.push(experience.warning);

    if (location.foreign) {
        warnings.push(`Located outside ${model.country}: ${job.location}`);
        score = Math.min(score, 25);
    }
    // an ad asking for much more experience than the candidate has is a long shot whatever the keywords say
    if (experience.gap >= 5) score = Math.min(score, 30);
    else if (experience.gap >= 3) score = Math.min(score, 45);

    const reasons: string[] = [];
    if (skills.matched.length > 0) {
        reasons.push(`Ad mentions ${skills.matched.length} of your skills: ${skills.matched.slice(0, 6).join(", ")}`);
    }
    if (title.closestRole && title.value >= 0.4) {
        reasons.push(
            title.closestKind === "education" ? `Fits your studies: ${title.closestRole}` : `Title is close to your past role: ${title.closestRole}`,
        );
    }
    if (location.value === 1 && location.label) reasons.push(location.label === "remote" ? "Remote position" : `Location fits: ${location.label}`);
    if (experience.required !== null && experience.relevant !== null && experience.value === 1) {
        reasons.push(experience.required === 0 ? "Entry-level role" : "Your related experience meets the stated requirement");
    }

    return {
        score: Math.round(score),
        breakdown,
        matchedSkills: skills.matched,
        reasons,
        warnings,
    };
}
