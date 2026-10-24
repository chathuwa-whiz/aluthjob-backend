import { getCandidate, type Candidate } from "../candidates/candidate.repository.js";
import { NotFoundError } from "../errors.js";
import { getApplication, type Application } from "../mail/application.repository.js";
import { getMatch, type Match } from "../matching/match.repository.js";
import type { User } from "./user.repository.js";

// Every record in this system hangs off a candidate, and every candidate belongs to one user. These are
// the only ways routes load user data by id, and each answers 404 (never 403) for somebody else's
// record, so the response does not even reveal that the id exists.

const positive = (value: string | string[] | undefined) => {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : undefined;
};

export function ownedCandidate(user: User, rawId: string | string[] | undefined): Candidate {
    const id = positive(rawId);
    const candidate = id === undefined ? undefined : getCandidate(id);

    if (!candidate || candidate.userId !== user.id) throw new NotFoundError("Candidate not found");
    return candidate;
}

export function ownedMatch(user: User, rawId: string | string[] | undefined): Match {
    const id = positive(rawId);
    const match = id === undefined ? undefined : getMatch(id);

    if (!match || getCandidate(match.candidateId)?.userId !== user.id) throw new NotFoundError("Match not found");
    return match;
}

export function ownedApplication(user: User, rawId: string | string[] | undefined): Application {
    const id = positive(rawId);
    const application = id === undefined ? undefined : getApplication(id);

    if (!application || getCandidate(application.candidateId)?.userId !== user.id) throw new NotFoundError("Application not found");
    return application;
}
