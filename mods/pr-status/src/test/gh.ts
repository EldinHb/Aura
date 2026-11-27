// Canned GitHub CLI output for the daemon tests: what `gh api -i` prints.
export interface Canned {
  status?: number;
  headers?: Record<string, string | number>;
  body?: unknown;
}

const REASON: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 304: "Not Modified", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 422: "Unprocessable Entity", 502: "Bad Gateway" };

/** A `gh api -i` response: status line, headers, blank line, body; and gh's exit code (1 from 400 on). */
export function ghReply({ status = 200, headers = {}, body }: Canned = {}) {
  const lines = [`HTTP/2.0 ${status} ${REASON[status] ?? ""}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return { code: status >= 400 ? 1 : 0, stdout: `${lines.join("\r\n")}\r\n\r\n${text}`, stderr: status >= 400 ? `gh: ${REASON[status]} (HTTP ${status})` : "" };
}

/** Rate-limit headers of one resource. */
export const rate = (resource: string, remaining: number, limit = 5000, reset = 1_900_000_000) => ({
  "X-RateLimit-Resource": resource, "X-RateLimit-Limit": limit, "X-RateLimit-Remaining": remaining, "X-RateLimit-Reset": reset,
});
