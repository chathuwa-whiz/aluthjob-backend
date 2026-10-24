import { Router, type Request, type Response } from "express";
import { z } from "zod";
import * as auth from "../auth/auth.service.js";
import { clearSessionCookie, currentUser, requireAuth, sessionTokenOf, setSessionCookie } from "../auth/middleware.js";
import type { User } from "../auth/user.repository.js";

const router = Router();

const Email = z.email().max(254);
// length rules for a NEW password live in the password policy; this only keeps absurd inputs out of the hasher
const AnyPassword = z.string().min(1).max(1000);
// what a link from an email carries: long, URL-safe random text
const LinkToken = z.string().min(20).max(200);

const Credentials = z.object({
    email: Email,
    password: AnyPassword,
    /** For scripts and other servers: return a bearer token in the body instead of setting the browser cookie. */
    issueToken: z.boolean().optional(),
});

const contextOf = (req: Request): auth.RequestContext => ({ ip: req.ip ?? "unknown", userAgent: req.get("user-agent") ?? null });

const publicUser = ({ id, email, role, createdAt, emailVerified }: User) => ({ id, email, role, createdAt, emailVerified });

function respondSignedIn(res: Response, { user, token }: auth.Signup, issueToken: boolean | undefined) {
    // A browser gets an HttpOnly cookie that page scripts cannot read. A script that asked for a token gets it in
    // the body instead and no cookie, so the token is never exposed to a browser page by accident.
    if (issueToken) return res.status(200).json({ success: true, data: { user: publicUser(user), token } });

    setSessionCookie(res, token);
    return res.status(200).json({ success: true, data: { user: publicUser(user) } });
}

// The same answer whether the address is new or already has an account, and no session is created: the
// person must follow the link emailed to the address before they can sign in and use anything.
const CHECK_YOUR_EMAIL = "If that address can be registered, we have sent a message to it. Follow the link in it to finish creating your account";

router.post("/register", async (req, res) => {
    const body = z.object({ email: Email, password: AnyPassword }).parse(req.body);
    await auth.register(body.email, body.password, contextOf(req));

    res.status(202).json({ success: true, data: { message: CHECK_YOUR_EMAIL } });
});

// POST, not GET: mail scanners and link previews fetch every link in a message, which would use up a one-time token
router.post("/verify-email", (req, res) => {
    auth.verifyEmail(z.object({ token: LinkToken }).parse(req.body).token, contextOf(req));
    res.json({ success: true, data: { verified: true } });
});

router.post("/login", async (req, res) => {
    const body = Credentials.parse(req.body);
    respondSignedIn(res, await auth.login(body.email, body.password, contextOf(req)), body.issueToken);
});

// Works without a valid session on purpose: signing out must always succeed and clear the cookie
router.post("/logout", (req, res) => {
    const token = sessionTokenOf(req);
    if (token) auth.logout(token);

    clearSessionCookie(res);
    res.json({ success: true, data: { signedOut: true } });
});

// "Forgot password": identical answer for known and unknown addresses
router.post("/forgot-password", (req, res) => {
    auth.requestPasswordReset(z.object({ email: Email }).parse(req.body).email, contextOf(req));

    res.status(202).json({ success: true, data: { message: "If that address has an account, we have sent a message to it with a link to choose a new password" } });
});

router.post("/reset-password", async (req, res) => {
    const body = z.object({ token: LinkToken, newPassword: AnyPassword }).parse(req.body);
    await auth.resetPassword(body.token, body.newPassword, contextOf(req));

    res.json({ success: true, data: { reset: true, message: "Your password was changed and every device was signed out. Sign in with the new password" } });
});

// ---- signed in (these work even before the email address is confirmed) -----------------

router.get("/me", requireAuth, (req, res) => {
    res.json({ success: true, data: { user: publicUser(currentUser(req)) } });
});

router.post("/resend-verification", requireAuth, (req, res) => {
    auth.resendVerification(currentUser(req));
    res.status(202).json({ success: true, data: { sent: true } });
});

router.post("/change-password", requireAuth, async (req, res) => {
    const body = z.object({ currentPassword: AnyPassword, newPassword: AnyPassword }).parse(req.body);
    await auth.changePassword(currentUser(req), body.currentPassword, body.newPassword, req.sessionToken!);

    res.json({ success: true, data: { changed: true, otherSessionsSignedOut: true } });
});

// Deletes the account and everything stored for it: resumes, matches, mailbox, applications
router.delete("/account", requireAuth, async (req, res) => {
    const body = z.object({ password: AnyPassword }).parse(req.body);
    await auth.deleteAccount(currentUser(req), body.password);

    clearSessionCookie(res);
    res.json({ success: true, data: { deleted: true } });
});

export default router;
