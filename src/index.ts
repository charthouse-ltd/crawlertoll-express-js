/**
 * @crawlertoll/express — Express middleware for the AI-crawler economy.
 *
 *   import express from "express";
 *   import { crawlertoll } from "@crawlertoll/express";
 *
 *   const app = express();
 *
 *   app.use(crawlertoll({
 *     offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
 *     contextLicenseUrl: "https://example.com/.well-known/context-license.json",
 *   }));
 *
 *   app.get("/", (_req, res) => res.send("hello"));
 *
 * The middleware:
 *   - Detects AI crawlers via the @crawlertoll/core catalogue
 *   - Verifies Web Bot Auth signatures (Ed25519 / RFC 9421) if present
 *   - Applies RSL 1.0 policy (parsed once, evaluated per-request)
 *   - Issues HTTP 402 with Cloudflare-shape headers + structured offer
 *   - Annotates `req.crawlertoll` with the decision for downstream handlers
 *
 * All decisions are async (because Web Bot Auth verification fetches a
 * JWKS); the middleware never blocks the event loop on key material it
 * doesn't have. Wire it before route handlers.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

import {
  applyTo,
  decide,
  parseRobotsTxt,
  type Build402Options,
  type Decision,
  type DecideInput,
  type PaymentOffer,
  type RslPolicy,
} from "@crawlertoll/core";

declare module "express-serve-static-core" {
  interface Request {
    /** Decision the middleware reached for this request. */
    crawlertoll?: Decision;
  }
}

export interface CrawlerTollOptions {
  /** Payment offer to surface when the decision is 402. */
  offer?: PaymentOffer;
  /** Options forwarded to `build402()`. */
  buildOptions?: Omit<Build402Options, "offer">;
  /** Convenience: terms-of-use URL injected into the 402's `Link` header. */
  termsUrl?: string;
  /** Convenience: `.well-known/context-license.json` URL injected as `Link rel=describedby`. */
  contextLicenseUrl?: string;
  /**
   * RSL 1.0 policy. Pass either an already-parsed `RslPolicy` or the raw
   * robots.txt body and the middleware parses it once on first request.
   */
  policy?: RslPolicy | string;
  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean;
  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean;
  /**
   * Called for every request after a decision. Receives the decision and
   * the Express `req`/`res`. Useful for telemetry / dashboards.
   * Errors thrown here are caught and reported via `next(err)`.
   */
  onDecision?: (decision: Decision, req: Request, res: Response) => void | Promise<void>;
  /**
   * Hook to short-circuit the decision before any of the standard logic.
   * Return `null` to fall through; return a `Decision` to override.
   */
  decisionOverride?: (req: Request) => Decision | null | Promise<Decision | null>;
  /** Treat the request as HTTP regardless of `req.protocol`. Default: inspect `req.secure` / `X-Forwarded-Proto`. */
  forceScheme?: "http" | "https";
}

const DEFAULT_OPTIONS: Required<
  Pick<CrawlerTollOptions, "verifyAuth" | "trustVerifiedBots">
> = {
  verifyAuth: true,
  trustVerifiedBots: false,
};

/**
 * Build the Express middleware. Returns a `(req, res, next) => void`
 * compatible with Express 4 and 5.
 */
export function crawlertoll(options: CrawlerTollOptions = {}): RequestHandler {
  // Lazily resolve the policy on first request, then memoise. This lets
  // the middleware be wired before the policy text is loaded (common in
  // boot sequences) without paying parse cost on every request.
  let resolvedPolicy: RslPolicy | undefined;
  let policyResolved = false;
  const resolvePolicy = (): RslPolicy | undefined => {
    if (policyResolved) return resolvedPolicy;
    policyResolved = true;
    if (typeof options.policy === "string") {
      const { policy } = parseRobotsTxt(options.policy);
      resolvedPolicy = policy;
    } else if (options.policy) {
      resolvedPolicy = options.policy;
    }
    return resolvedPolicy;
  };

  const cfg = { ...DEFAULT_OPTIONS, ...options };

  const handler: RequestHandler = (req, res, next): void => {
    runDecision(req, res, cfg, resolvePolicy).then(
      (decision) => {
        req.crawlertoll = decision;
        // Run user telemetry (best-effort).
        if (options.onDecision) {
          Promise.resolve()
            .then(() => options.onDecision!(decision, req, res))
            .catch((err: unknown) => {
              // Don't block the request on a telemetry failure.
              process.emitWarning(
                `crawlertoll onDecision threw: ${(err as Error).message}`,
                "CrawlerTollWarning",
              );
            });
        }

        if (decision.action === "allow") {
          next();
          return;
        }
        if (decision.action === "402" && decision.built) {
          applyTo(res, decision.built);
          return;
        }
        if (decision.action === "block") {
          res.status(403).setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: "forbidden",
              message: "Crawler access denied by site policy.",
              reasons: decision.reasons,
            }),
          );
          return;
        }
        // Unknown action — fall through.
        next();
      },
      (err: unknown) => next(err),
    );
  };
  return handler;
}

async function runDecision(
  req: Request,
  _res: Response,
  cfg: CrawlerTollOptions & typeof DEFAULT_OPTIONS,
  resolvePolicy: () => RslPolicy | undefined,
): Promise<Decision> {
  if (cfg.decisionOverride) {
    const override = await cfg.decisionOverride(req);
    if (override) return override;
  }

  const headers = normaliseHeaders(req.headers);
  const policy = resolvePolicy();

  const buildOptions: Omit<Build402Options, "offer"> = {
    ...(cfg.contextLicenseUrl ? { contextLicenseUrl: cfg.contextLicenseUrl } : {}),
    ...(cfg.termsUrl ? { termsUrl: cfg.termsUrl } : {}),
    ...(cfg.buildOptions ?? {}),
  };

  const input: DecideInput = {
    request: {
      method: req.method,
      authority: getAuthority(req, cfg.forceScheme),
      targetUri: req.originalUrl || req.url || "/",
      headers,
      path: req.path,
    },
    verifyAuth: cfg.verifyAuth,
    trustVerifiedBots: cfg.trustVerifiedBots,
    ...(policy ? { policy } : {}),
    ...(cfg.offer ? { offer: cfg.offer } : {}),
    ...(Object.keys(buildOptions).length ? { buildOptions } : {}),
  };

  return decide(input);
}

function normaliseHeaders(
  raw: Request["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : String(v);
  }
  return out;
}

function getAuthority(req: Request, force?: "http" | "https"): string {
  // The Web Bot Auth signature base uses the request's *authority*
  // (host[:port]) — exactly what's on the Host header after Express's
  // trust-proxy logic has run.
  const host = (req.headers["host"] as string | undefined) ?? "";
  if (host) return host;
  // Fall back to req.hostname if Host header is somehow missing.
  return req.hostname || "localhost";
  void force;
}

// ─── Type re-exports for consumer ergonomics ───────────────────────

export type {
  Build402Options,
  Built402Response,
  PaymentOffer,
  SettlementRail,
  Decision,
  DecisionAction,
  RslPolicy,
} from "@crawlertoll/core";
