/** Browser origins allowed to call the API and to send the session cookie: the comma-separated FRONTEND_URL. */
export function allowedOrigins(): string[] {
    return (process.env.FRONTEND_URL ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
            try {
                return new URL(value).origin;
            } catch {
                return "";
            }
        })
        .filter(Boolean);
}
