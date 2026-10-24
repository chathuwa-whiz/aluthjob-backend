// Words that carry no information about what a job is: English function words plus the
// boilerplate every Sri Lankan job ad repeats ("applications close", "experience", ...).
const STOP_WORDS = new Set(
    `a about above across after again all also an and any are as at be been being both but by can could did do does done
    each etc for from had has have having he her his how i if in into is it its just may me more most must my no nor not
    of on one only or other our out over own per same she should so some such than that the their them then there these
    they this those through to too two under until up us use used using very was we were what when where which while who
    whom why will with within would you your
    job jobs apply applying applicant applicants application applications vacancy vacancies position positions post
    company candidate candidates looking hiring required requirement requirements require preferred preferably must
    able ability good strong excellent knowledge skill skills experience experienced years year work working team
    least well new based including include please refer further information advert details detail opportunity join
    role roles responsibilities responsibility duties duty qualification qualifications education closing date email
    send cv resume attach attached contact salary monthly basis full time part sri lanka lankan colombo`
        .split(/\s+/)
        .filter(Boolean),
);

// Level words in titles: they say how senior a job is, not what field it is in
const GENERIC_TITLE_WORDS = new Set(
    `senior junior trainee intern internship associate assistant executive officer manager lead head chief principal
    entry level graduate fresher apprentice team grade the and of for in to at a an`.split(/\s+/),
);

export const isStopWord = (word: string) => STOP_WORDS.has(word);
export const isGenericTitleWord = (word: string) => GENERIC_TITLE_WORDS.has(word);

/** Lower-cased word tokens; keeps the characters that are part of tech names (c++, c#, node.js). */
export function tokenize(text: string): string[] {
    return (
        text
            .toLowerCase()
            // ".net" would otherwise be indistinguishable from the English word "net"
            .replace(/(?<![a-z0-9])\.net\b/g, " dotnet ")
            .replace(/\basp\.net\b/g, " aspdotnet ")
            .match(/[a-z0-9][a-z0-9+#]*(?:\.[a-z0-9+#]+)*/g) ?? []
    ).map((token) => token.replace(/\.+$/, ""));
}

const SUFFIXES = ["ments", "ment", "ings", "ing", "ers", "er", "ed", "ions", "ion", "es", "s"];
const MIN_STEM = 4;

/** Crude suffix stripping so that develop / developer / developing / development share a term. */
export function stem(word: string): string {
    // identifiers such as "c++", "node.js", "2024" must stay exactly as written
    if (!/^[a-z]+$/.test(word)) return word;

    let current = word;
    let changed = true;

    while (changed) {
        changed = false;

        for (const suffix of SUFFIXES) {
            if (current.endsWith(suffix) && current.length - suffix.length >= MIN_STEM) {
                current = current.slice(0, -suffix.length);
                changed = true;
                break;
            }
        }

        if (current.endsWith("e") && current.length > MIN_STEM) {
            current = current.slice(0, -1);
            changed = true;
        }
    }

    return current;
}

/** Distinct, stemmed, informative terms of a text. */
export function contentTerms(text: string): Set<string> {
    const terms = new Set<string>();

    for (const token of tokenize(text)) {
        if (token.length < 3 || isStopWord(token) || /^\d+$/.test(token)) continue;
        terms.add(stem(token));
    }

    return terms;
}

/** Terms of a job title or position name, without seniority words. */
export function titleTerms(title: string): Set<string> {
    const terms = new Set<string>();

    for (const token of tokenize(title)) {
        if (token.length < 3 || isStopWord(token) || isGenericTitleWord(token)) continue;
        terms.add(stem(token));
    }

    return terms;
}

const SKILL_ALIASES: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    nodejs: "node",
    reactjs: "react",
    vuejs: "vue",
    nextjs: "next",
    nuxtjs: "nuxt",
    expressjs: "express",
    angularjs: "angular",
    postgres: "postgresql",
    mongo: "mongodb",
    k8s: "kubernetes",
    ml: "machinelearning",
    ai: "artificialintelligence",
    csharp: "c#",
    golang: "go",
    py: "python",
    msexcel: "excel",
    microsoftexcel: "excel",
    msword: "word",
    microsoftword: "word",
};

/** Canonical form of a skill name so that "Node.js", "NodeJS" and "node js" compare equal. */
export function skillKey(skill: string): string {
    const compact = skill
        .toLowerCase()
        .replace(/(?<![a-z0-9])\.net\b/g, "dotnet")
        .replace(/[\s._\-/]+/g, "");

    return SKILL_ALIASES[compact] ?? compact;
}

/** A skill key is usable for text matching only if it cannot collide with ordinary words. */
export function isMatchableSkillKey(key: string): boolean {
    if (key.length < 2) return false;
    if (key.length === 2 && !/[+#]/.test(key)) return false;
    return !isStopWord(key);
}

/** Every 1-3 word phrase of a text as a skill key, for set lookups against a skill list. */
export function skillKeysIn(text: string): Set<string> {
    const tokens = tokenize(text);
    const keys = new Set<string>();

    for (let start = 0; start < tokens.length; start++) {
        let phrase = "";

        for (let length = 0; length < 3 && start + length < tokens.length; length++) {
            phrase += (length ? " " : "") + tokens[start + length];
            keys.add(skillKey(phrase));
        }
    }

    return keys;
}
