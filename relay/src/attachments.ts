import {
  ATTACHMENT_ID_PATTERN,
  ATTACHMENT_MAX_OBJECT_BYTES,
  ATTACHMENT_OVERHEAD_BYTES,
  ATTACHMENT_PATH,
  quote,
  type AttachmentHttpCode,
} from "@seance/shared";
import type { UploadVerdict } from "./allowance.ts";
import { bearerToken, tokenMatches } from "./auth.ts";
import type { Env } from "./env.ts";

/** Chromium caps a preflight's cache at two hours. */
const PREFLIGHT_MAX_AGE_S = 7200;

/**
 * `*`, not the PWA's origin: the socket upgrade already takes any origin holding
 * the token, and nothing here rides on ambient credentials (DESIGN.md, "The relay:
 * R2 and the routes"). GET answers carry none: only daemons download.
 */
const CORS_PUT = { "access-control-allow-origin": "*" } as const;

const STATUS: Readonly<Record<AttachmentHttpCode, number>> = {
  stored: 201,
  invalid_length: 400,
  unauthorized: 401,
  invalid_id: 404,
  not_found: 404,
  method_not_allowed: 405,
  exists: 409,
  length_required: 411,
  too_large: 413,
  allowance_exhausted: 429,
  storage_error: 503,
};

export function isAttachmentPath(pathname: string): boolean {
  return pathname.startsWith(ATTACHMENT_PATH);
}

/**
 * `PUT` and `GET /attachments/<id>`. The relay never reads a body: a `PUT` streams
 * into R2 held to its declared length by the runtime, a `GET` streams out. No line
 * for an accepted transfer — that would be the timeline the store refuses too.
 */
export async function handleAttachment(
  req: Request,
  env: Env,
  reserveUpload: (bytes: number) => Promise<UploadVerdict>,
): Promise<Response> {
  const { method } = req;
  // A preflight never carries the token, and answering it wakes nothing.
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS_PUT,
        "access-control-allow-methods": "PUT",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
      },
    });
  }
  const cors = method === "PUT" ? CORS_PUT : {};
  const id = new URL(req.url).pathname.slice(ATTACHMENT_PATH.length);

  // Unlogged, as an unauthenticated upgrade is: the id would be the caller's junk.
  if (!tokenMatches(bearerToken(req), env.BEARER_TOKEN)) return answer("unauthorized", cors);

  if (method !== "PUT" && method !== "GET")
    return refuse(method, id, "method_not_allowed", { ...cors, allow: "GET, PUT, OPTIONS" });
  if (!ATTACHMENT_ID_PATTERN.test(id)) return refuse(method, id, "invalid_id", cors);
  if (method === "GET") return download(env, id);

  const declared = req.headers.get("content-length");
  if (declared === null) return refuse(method, id, "length_required", cors);
  const length = /^\d{1,12}$/u.test(declared) ? Number(declared) : Number.NaN;
  if (Number.isNaN(length) || length < ATTACHMENT_OVERHEAD_BYTES) return refuse(method, id, "invalid_length", cors);
  if (length > ATTACHMENT_MAX_OBJECT_BYTES) return refuse(method, id, "too_large", cors);

  // A Hub that cannot answer is a storage failure too: one 503, one line, not an uncaught 500.
  try {
    const verdict = await reserveUpload(length);
    if (!verdict.ok) {
      console.log(
        `attachment refused method=${quote(method)} id=${quote(id)} code=allowance_exhausted window=${verdict.window}`,
      );
      return answer(
        "allowance_exhausted",
        { ...cors, "retry-after": String(verdict.retryAfter) },
        { window: verdict.window, retryAfter: verdict.retryAfter },
      );
    }
    // `req.body` is non-null: a declared length of at least the overhead means a body.
    const stored = await env.ATTACHMENTS.put(id, req.body, { onlyIf: new Headers({ "if-none-match": "*" }) });
    return stored === null ? refuse(method, id, "exists", cors) : answer("stored", cors);
  } catch (err) {
    console.log(`attachment failed method=${quote(method)} id=${quote(id)} err=${quote(String(err))}`);
    return answer("storage_error", cors);
  }
}

async function download(env: Env, id: string): Promise<Response> {
  try {
    const object = await env.ATTACHMENTS.get(id);
    if (object === null) return refuse("GET", id, "not_found", {});
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(object.size),
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.log(`attachment failed method="GET" id=${quote(id)} err=${quote(String(err))}`);
    return answer("storage_error", {});
  }
}

function refuse(method: string, id: string, code: AttachmentHttpCode, headers: Record<string, string>): Response {
  console.log(`attachment refused method=${quote(method)} id=${quote(id)} code=${code}`);
  return answer(code, headers);
}

function answer(
  code: AttachmentHttpCode,
  headers: Record<string, string>,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { code, ...extra },
    { status: STATUS[code], headers: { ...headers, "cache-control": "no-store" } },
  );
}
