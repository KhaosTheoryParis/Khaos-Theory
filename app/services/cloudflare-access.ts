import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const CLOUDFLARE_ACCESS_ISSUER = "https://blue-violet-81d6.cloudflareaccess.com";
const CLOUDFLARE_ACCESS_JWKS = createRemoteJWKSet(
  new URL(`${CLOUDFLARE_ACCESS_ISSUER}/cdn-cgi/access/certs`),
);

type RequestHeaders = Pick<Headers, "get">;

export type CloudflareAccessIdentity = {
  subject: string;
  email?: string;
  claims: JWTPayload;
};

export type CloudflareAccessVerification =
  | { ok: true; identity: CloudflareAccessIdentity }
  | { ok: false };

export async function verifyCloudflareAccess(
  requestHeaders: RequestHeaders,
): Promise<CloudflareAccessVerification> {
  const token = requestHeaders.get("cf-access-jwt-assertion")?.trim();

  if (!token) return { ok: false };

  const { env } = getCloudflareContext();
  const audience = env.CLOUDFLARE_ACCESS_AUD?.trim();

  if (!audience) return { ok: false };

  try {
    const { payload } = await jwtVerify(token, CLOUDFLARE_ACCESS_JWKS, {
      algorithms: ["RS256"],
      issuer: CLOUDFLARE_ACCESS_ISSUER,
      audience,
    });

    if (payload.type !== "app" || typeof payload.sub !== "string" || !payload.sub) {
      return { ok: false };
    }

    return {
      ok: true,
      identity: {
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        claims: payload,
      },
    };
  } catch {
    return { ok: false };
  }
}
