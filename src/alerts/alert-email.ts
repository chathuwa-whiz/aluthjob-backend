import type { OutgoingMail } from "../mail/system-mailer.js";

// The job-alert email. A pure function of its input (no database, no clock unless passed in), so it can be
// unit-tested and previewed without sending anything (`npm run alerts:preview`).
//
// "Interactive" in an email cannot mean scripts or forms: mail apps strip both. What works everywhere is
// links that do something. Every button here is a link; the ones that change anything (hide a job, switch to
// weekly, pause, unsubscribe) lead to a small confirmation page in the app, never act on a bare GET, because
// mail scanners open every link in a message.
//
// Rules this template keeps so the message stays welcome rather than spam:
//   - one email per digest, never one per job, and only when there is something new
//   - the reason each job was picked is on the card (skills that matched, not marketing copy)
//   - no tracking pixel, no remote images, no link redirector: the only image is attached to the message
//   - unsubscribe is one click, in the footer and in the mail app's own button (List-Unsubscribe)

export interface AlertJob {
    matchId: number;
    title: string;
    company: string | null;
    location: string | null;
    /** 0..100 */
    score: number;
    jobType: string | null;
    salary: string | null;
    /** ISO date the vacancy closes, when known. */
    closingAt: string | null;
    /** Why it matched: short sentences from the matcher. */
    reasons: string[];
    matchedSkills: string[];
    /** Things to check before applying (e.g. needs more years of experience). */
    warnings: string[];
    applyMethod: "email" | "portal";
}

export interface AlertLinks {
    /** The app's home, for "see all matches". */
    app: string;
    preferences: string;
    /** Opens one match in the app. */
    match(matchId: number): string;
    /** Confirmation page that hides one match. */
    hide(matchId: number): string;
    /** Confirmation pages for the footer controls. */
    pause: string;
    daily: string;
    weekly: string;
    unsubscribe: string;
    /** Target of the mail app's own unsubscribe button (RFC 8058 one-click POST). */
    oneClickUnsubscribe: string;
}

export interface AlertEmailInput {
    to: string;
    /** First name for the greeting, when the resume had one. */
    firstName: string | null;
    jobs: AlertJob[];
    /** Further new matches that did not fit in the email. */
    moreCount: number;
    frequency: "daily" | "weekly";
    links: AlertLinks;
    /** Whether the logo image is attached (cid:aluthjob-logo). The email reads fine without it. */
    logo: boolean;
    now?: Date;
}

export const LOGO_CID = "aluthjob-logo";

// ---- colours: the app's design tokens (client/src/styles/tokens.css) converted from oklch, which mail apps do not read ----
const C = {
    canvas: "#f2f7f3",
    card: "#ffffff",
    well: "#eff4f0",
    line: "#dce1de",
    ink: "#111b14",
    ink2: "#354039",
    muted: "#545d57",
    brand: "#00be61",
    primary: "#007f3f",
    primarySoft: "#e2fae8",
    primaryLine: "#a9e1b8",
    link: "#00692f",
    warnBg: "#fff5d0",
    warnInk: "#633f0c",
    warnLine: "#eace8c",
};

const FONT = `'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans Sinhala','Nirmala UI','Noto Sans Tamil','Helvetica Neue',Arial,sans-serif`;

const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Scraped text can be long or odd; keep a card readable. */
const clip = (value: string, max: number) => {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};

// ---- small facts ----------------------------------------------------------------------------------------------

export function daysUntil(iso: string | null, now: Date): number | null {
    if (!iso) return null;
    const closes = Date.parse(iso);
    if (Number.isNaN(closes)) return null;

    // a vacancy "closing on the 30th" is open through the 30th
    const day = 86_400_000;
    return Math.ceil((closes - now.getTime()) / day);
}

export function closingLabel(iso: string | null, now: Date): { text: string; urgent: boolean } | null {
    const days = daysUntil(iso, now);
    if (days === null || days < 0) return null;
    if (days === 0) return { text: "Closes today", urgent: true };
    if (days === 1) return { text: "Closes tomorrow", urgent: true };
    return { text: `Closes in ${days} days`, urgent: days <= 3 };
}

const fit = (score: number) => (score >= 80 ? "Excellent fit" : score >= 65 ? "Strong fit" : "Good fit");
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export function alertSubject(jobs: AlertJob[], moreCount: number): string {
    const top = jobs[0];
    if (!top) return "New jobs for you on AluthJob";

    const total = jobs.length + moreCount;
    const where = top.company ? `${top.title} at ${top.company}` : top.title;
    const lead = total === 1 ? "New match" : `${total} new matches`;

    // under the length where mail apps start cutting subjects
    return `${lead}: ${clip(where, 62)} (${Math.round(top.score)}%)`;
}

function greeting(firstName: string | null): string {
    return firstName ? `Hi ${firstName},` : "Hi,";
}

function headline(input: AlertEmailInput): string {
    const total = input.jobs.length + input.moreCount;
    return total === 1 ? "A new job matches your CV" : `${total} new jobs match your CV`;
}

function intro(input: AlertEmailInput): string {
    const since = input.frequency === "weekly" ? "this week" : "since your last update";
    return `Fresh ${since}, best match first. Nothing is sent to an employer until you read the cover letter and approve it.`;
}

// ---- HTML ----------------------------------------------------------------------------------------------------

const link = (href: string, label: string, style: string) => `<a href="${escapeHtml(href)}" style="${style}">${label}</a>`;

function button(href: string, label: string, kind: "primary" | "quiet"): string {
    const base = `display:inline-block;padding:12px 20px;border-radius:10px;font:600 15px/1.2 ${FONT};text-decoration:none;margin:0 8px 8px 0;`;
    return kind === "primary"
        ? link(href, label, `${base}background:${C.primary};color:#ffffff;border:1px solid ${C.primary};`).replace("<a ", `<a class="btn-primary" `)
        : link(href, label, `${base}background:${C.card};color:${C.ink2};border:1px solid ${C.line};font-weight:500;`).replace("<a ", `<a class="btn-quiet" `);
}

const chip = (label: string, tone: "plain" | "warn" | "ok" = "plain") => {
    const tones = {
        plain: `background:${C.well};color:${C.ink2};border:1px solid ${C.line};`,
        ok: `background:${C.primarySoft};color:${C.link};border:1px solid ${C.primaryLine};`,
        warn: `background:${C.warnBg};color:${C.warnInk};border:1px solid ${C.warnLine};`,
    };
    return `<span class="chip chip-${tone}" style="display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border-radius:999px;font:500 12px/1.4 ${FONT};${tones[tone]}">${escapeHtml(label)}</span>`;
};

function jobCard(job: AlertJob, input: AlertEmailInput, now: Date): string {
    const { links } = input;
    const score = Math.max(0, Math.min(100, Math.round(job.score)));
    const closing = closingLabel(job.closingAt, now);
    const where = [job.company, job.location].filter(Boolean).map((part) => clip(part!, 60)).join("  ·  ");

    const facts = [
        closing && chip(closing.text, closing.urgent ? "warn" : "plain"),
        job.jobType && chip(clip(job.jobType, 30)),
        job.salary && chip(clip(job.salary, 36)),
        chip(job.applyMethod === "email" ? "Apply by email" : "Apply on the job site"),
    ].filter(Boolean);

    const skills = job.matchedSkills.slice(0, 5).map((skill) => chip(clip(skill, 24), "ok")).join("");
    const reason = job.reasons[0] ? clip(job.reasons[0], 140) : null;
    const warning = job.warnings[0] ? clip(job.warnings[0], 140) : null;

    return `
<tr><td style="padding:0 0 14px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-job" style="background:${C.card};border:1px solid ${C.line};border-radius:14px;">
    <tr>
      <td style="padding:18px 18px 6px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td valign="top" style="padding:0 14px 0 0;width:64px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="score" style="width:64px;background:${C.primarySoft};border:1px solid ${C.primaryLine};border-radius:12px;">
              <tr><td align="center" style="padding:9px 0 2px 0;font:700 22px/1 ${FONT};color:${C.link};" class="score-num">${score}<span style="font-size:12px;">%</span></td></tr>
              <tr><td align="center" style="padding:0 4px 9px 4px;font:600 10px/1.2 ${FONT};letter-spacing:.04em;text-transform:uppercase;color:${C.link};" class="score-num">match</td></tr>
            </table>
          </td>
          <td valign="top" style="font-family:${FONT};">
            <div style="font:700 17px/1.3 ${FONT};color:${C.ink};" class="ink">${link(links.match(job.matchId), escapeHtml(clip(job.title, 110)), `color:${C.ink};text-decoration:none;`).replace("<a ", `<a class="ink" `)}</div>
            ${where ? `<div style="margin-top:3px;font:400 14px/1.45 ${FONT};color:${C.muted};" class="muted">${escapeHtml(where)}</div>` : ""}
            <div style="margin-top:4px;font:600 12px/1.4 ${FONT};color:${C.link};" class="link">${fit(score)}</div>
          </td>
        </tr></table>
      </td>
    </tr>
    <tr><td style="padding:6px 18px 0 18px;">${facts.join("")}</td></tr>
    ${
        reason || skills
            ? `<tr><td style="padding:2px 18px 4px 18px;">
        ${reason ? `<div style="font:400 14px/1.55 ${FONT};color:${C.ink2};margin:0 0 8px 0;" class="ink2"><strong style="font-weight:600;">Why it fits:</strong> ${escapeHtml(reason)}</div>` : ""}
        ${skills ? `<div>${skills}</div>` : ""}
      </td></tr>`
            : ""
    }
    ${
        warning
            ? `<tr><td style="padding:2px 18px 6px 18px;"><div class="warn" style="padding:8px 12px;border-radius:10px;background:${C.warnBg};border:1px solid ${C.warnLine};font:400 13px/1.5 ${FONT};color:${C.warnInk};"><strong style="font-weight:600;">Check first:</strong> ${escapeHtml(warning)}</div></td></tr>`
            : ""
    }
    <tr><td style="padding:10px 18px 12px 18px;">
      ${button(links.match(job.matchId), "Review &amp; apply", "primary")}${button(links.hide(job.matchId), "Not for me", "quiet")}
    </td></tr>
  </table>
</td></tr>`;
}

function frequencyPills(input: AlertEmailInput): string {
    const { links, frequency } = input;
    const pill = (label: string, href: string, active: boolean) =>
        active
            ? `<span class="pill-on" style="display:inline-block;padding:6px 14px;border-radius:999px;background:${C.primary};color:#ffffff;font:600 13px/1.3 ${FONT};margin:0 6px 6px 0;">${label} &#10003;</span>`
            : `<a class="pill-off" href="${escapeHtml(href)}" style="display:inline-block;padding:5px 13px;border-radius:999px;border:1px solid ${C.line};color:${C.ink2};font:500 13px/1.3 ${FONT};text-decoration:none;margin:0 6px 6px 0;">${label}</a>`;

    return pill("Daily", links.daily, frequency === "daily") + pill("Weekly", links.weekly, frequency === "weekly");
}

const STYLE = `
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0;mso-table-rspace:0;}
  img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
  a{color:${C.link};}
  a.btn-primary:hover{background:#006c32 !important;border-color:#006c32 !important;}
  a.btn-quiet:hover{background:${C.well} !important;}
  a.pill-off:hover{background:${C.well} !important;}
  @media only screen and (max-width:620px){
    .shell{width:100% !important;}
    .pad{padding-left:14px !important;padding-right:14px !important;}
    .headline{font-size:22px !important;}
  }
  @media (prefers-color-scheme:dark){
    body,.bg-canvas{background:#090c0a !important;}
    .bg-card,.card-job{background:#141715 !important;border-color:#282d2a !important;}
    .ink,.ink a{color:#e7ede9 !important;}
    .ink2{color:#c6ccc8 !important;}
    .muted{color:#a2aaa4 !important;}
    .link,.link a,a.link{color:#66d98f !important;}
    .line{border-color:#282d2a !important;}
    .score{background:#102d1a !important;border-color:#15552f !important;}
    .score-num{color:#66d98f !important;}
    .chip-plain{background:#1b1f1c !important;color:#c6ccc8 !important;border-color:#282d2a !important;}
    .chip-ok{background:#102d1a !important;color:#66d98f !important;border-color:#15552f !important;}
    .chip-warn,.warn{background:#322405 !important;color:#eed592 !important;border-color:#5a4412 !important;}
    a.btn-primary{background:#008944 !important;border-color:#008944 !important;color:#ffffff !important;}
    a.btn-quiet,a.pill-off{background:#141715 !important;color:#c6ccc8 !important;border-color:#3a413d !important;}
    .tip{background:#102d1a !important;border-color:#15552f !important;color:#c6ccc8 !important;}
    .pill-on{background:#008944 !important;}
  }
`;

export function renderAlertHtml(input: AlertEmailInput): string {
    const now = input.now ?? new Date();
    const { links } = input;
    const total = input.jobs.length + input.moreCount;
    const dateLabel = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Colombo" }).format(now);
    const preheader = input.jobs[0]
        ? `${clip(input.jobs[0].title, 60)}${input.jobs[0].company ? ` at ${clip(input.jobs[0].company, 40)}` : ""} and ${Math.max(0, total - 1)} more. Review and apply in one tap.`
        : "New jobs matched to your CV.";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(alertSubject(input.jobs, input.moreCount))}</title>
<style>${STYLE}</style>
</head>
<body class="bg-canvas" style="margin:0;padding:0;background:${C.canvas};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(preheader)}${"&#8199;&#847; ".repeat(30)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg-canvas" style="background:${C.canvas};">
<tr><td align="center" style="padding:24px 12px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="shell" style="width:600px;max-width:600px;">

    <tr><td class="pad" style="padding:0 6px 14px 6px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" style="font:700 18px/1 ${FONT};color:${C.ink};" class="ink">
          ${input.logo ? `<img src="cid:${LOGO_CID}" width="26" height="26" alt="" style="vertical-align:middle;margin-right:8px;border-radius:6px;">` : ""}<span style="vertical-align:middle;">AluthJob</span>
        </td>
        <td align="right" style="font:400 13px/1 ${FONT};color:${C.muted};" class="muted">${input.frequency === "weekly" ? "Weekly" : "Daily"} update &middot; ${escapeHtml(dateLabel)}</td>
      </tr></table>
    </td></tr>

    <tr><td class="bg-card" style="background:${C.card};border:1px solid ${C.line};border-radius:18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td class="pad" style="padding:28px 28px 8px 28px;">
          <div style="font:400 15px/1.5 ${FONT};color:${C.muted};margin:0 0 6px 0;" class="muted">${escapeHtml(greeting(input.firstName))}</div>
          <h1 class="headline ink" style="margin:0;font:700 26px/1.2 ${FONT};color:${C.ink};letter-spacing:-.01em;">${escapeHtml(headline(input))}</h1>
          <p class="ink2" style="margin:10px 0 0 0;font:400 15px/1.6 ${FONT};color:${C.ink2};">${escapeHtml(intro(input))}</p>
        </td></tr>

        <tr><td class="pad" style="padding:18px 22px 4px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            ${input.jobs.map((job) => jobCard(job, input, now)).join("")}
          </table>
        </td></tr>

        ${
            input.moreCount > 0
                ? `<tr><td class="pad" align="center" style="padding:2px 28px 18px 28px;">
          ${button(links.app, `See ${plural(input.moreCount, "more match", "more matches")} in AluthJob`, "quiet")}
        </td></tr>`
                : ""
        }

        <tr><td class="pad" style="padding:0 28px 26px 28px;">
          <div class="tip" style="padding:12px 14px;border-radius:12px;background:${C.primarySoft};border:1px solid ${C.primaryLine};font:400 13px/1.55 ${FONT};color:${C.ink2};">
            <strong style="font-weight:600;">You stay in control.</strong> We never send an application for you. Open a match, read the letter, edit it if you like, then approve.
          </div>
        </td></tr>
      </table>
    </td></tr>

    <tr><td class="pad" style="padding:20px 12px 0 12px;">
      <div class="muted" style="font:600 12px/1.4 ${FONT};letter-spacing:.04em;text-transform:uppercase;color:${C.muted};margin:0 0 8px 0;">How often should we write?</div>
      <div>${frequencyPills(input)}</div>
      <div class="muted" style="margin-top:6px;font:400 13px/1.7 ${FONT};color:${C.muted};">
        ${link(links.pause, "Pause for 7 days", `color:${C.link};`).replace("<a ", `<a class="link" `)} &nbsp;&middot;&nbsp;
        ${link(links.preferences, "Change what I receive", `color:${C.link};`).replace("<a ", `<a class="link" `)} &nbsp;&middot;&nbsp;
        ${link(links.unsubscribe, "Unsubscribe", `color:${C.link};`).replace("<a ", `<a class="link" `)}
      </div>
      <div class="muted line" style="margin-top:14px;padding-top:14px;border-top:1px solid ${C.line};font:400 12px/1.6 ${FONT};color:${C.muted};">
        You get this because you have an AluthJob account with a CV, sent to ${escapeHtml(input.to)}. We only write when there is a new match, and never share your address.
        Matches come from public job adverts; check the details with the employer before you apply.
      </div>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}

// ---- plain text: complete on its own, for people and mail apps that do not show HTML --------------------------

export function renderAlertText(input: AlertEmailInput): string {
    const now = input.now ?? new Date();
    const { links } = input;

    const jobs = input.jobs.map((job, index) => {
        const closing = closingLabel(job.closingAt, now);
        const where = [job.company, job.location].filter(Boolean).join(", ");
        const lines = [
            `${index + 1}. ${job.title}  [${Math.round(job.score)}% match, ${fit(job.score).toLowerCase()}]`,
            where && `   ${where}`,
            "   " + [closing?.text, job.jobType, job.salary, job.applyMethod === "email" ? "Apply by email" : "Apply on the job site"].filter(Boolean).join(" | "),
            job.reasons[0] && `   Why it fits: ${job.reasons[0]}`,
            job.warnings[0] && `   Check first: ${job.warnings[0]}`,
            `   Review & apply: ${links.match(job.matchId)}`,
            `   Not for me:     ${links.hide(job.matchId)}`,
        ];
        return lines.filter(Boolean).join("\n");
    });

    return [
        greeting(input.firstName),
        "",
        `${headline(input)}. ${intro(input)}`,
        "",
        jobs.join("\n\n"),
        input.moreCount > 0 ? `\n+ ${plural(input.moreCount, "more match", "more matches")} waiting: ${links.app}` : "",
        "",
        "You stay in control: we never send an application for you. Open a match, read the letter, then approve.",
        "",
        "-- Your update settings",
        `Daily:     ${links.daily}`,
        `Weekly:    ${links.weekly}`,
        `Pause 7d:  ${links.pause}`,
        `Settings:  ${links.preferences}`,
        `Unsubscribe: ${links.unsubscribe}`,
        "",
        `You get this because you have an AluthJob account with a CV (${input.to}). We only write when there is a new match.`,
    ]
        .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
        .join("\n");
}

export function buildAlertMail(input: AlertEmailInput, logoPath?: string): OutgoingMail {
    return {
        to: input.to,
        subject: alertSubject(input.jobs, input.moreCount),
        text: renderAlertText(input),
        html: renderAlertHtml(input),
        headers: {
            // The mail app's own "unsubscribe" button. The https form is a POST (RFC 8058), so a scanner that merely
            // opens links cannot unsubscribe anyone by accident.
            "List-Unsubscribe": `<${input.links.oneClickUnsubscribe}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            // marks it as bulk-but-wanted so auto-replies are not generated
            Precedence: "bulk",
            "Auto-Submitted": "auto-generated",
        },
        ...(input.logo && logoPath && { attachments: [{ filename: "aluthjob.png", path: logoPath, cid: LOGO_CID }] }),
    };
}
