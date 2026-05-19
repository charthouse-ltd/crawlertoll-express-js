/**
 * Express-adapter end-to-end test.
 *
 * Spin up an Express app with the middleware, fire real HTTP requests
 * via supertest, assert on status codes, headers, and the structured
 * 402 body. Confirms the adapter correctly translates Express semantics
 * into the core's DecideInput shape and applies decisions back to the
 * Express response.
 */

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { crawlertoll } from "../src/index.js";

function makeApp(opts: Parameters<typeof crawlertoll>[0]) {
  const app = express();
  app.use(crawlertoll(opts));
  app.get("/", (_req, res) => {
    res.send("ok");
  });
  app.get("/articles/:id", (_req, res) => {
    res.send("article");
  });
  app.get("/public/x", (_req, res) => {
    res.send("public");
  });
  return app;
}

describe("@crawlertoll/express", () => {
  it("passes browser requests through", async () => {
    const app = makeApp({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await request(app)
      .get("/")
      .set(
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15",
      );
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });

  it("returns 402 with crawler-price header to a known bot", async () => {
    const app = makeApp({
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      contextLicenseUrl: "https://example.com/.well-known/context-license.json",
      termsUrl: "https://example.com/ai-terms",
    });
    const res = await request(app).get("/articles/1").set("user-agent", "GPTBot/1.2");
    expect(res.status).toBe(402);
    expect(res.headers["crawler-price"]).toBe("5000 micros USD");
    expect(res.headers["crawler-price-rail"]).toBe("x402");
    expect(res.headers["link"]).toContain('rel="describedby"');
    expect(res.headers["link"]).toContain('rel="terms-of-service"');

    const body = JSON.parse(res.text) as {
      error: string;
      offer: { rail: string; priceMicros: number };
    };
    expect(body.error).toBe("payment_required");
    expect(body.offer.priceMicros).toBe(5000);
  });

  it("allows bots when no offer is configured (default-allow)", async () => {
    const app = makeApp({});
    const res = await request(app).get("/").set("user-agent", "ClaudeBot/2.0");
    expect(res.status).toBe(200);
  });

  it("annotates req.crawlertoll on every request", async () => {
    const captured: Array<unknown> = [];
    const app = express();
    app.use(
      crawlertoll({
        offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
      }),
    );
    app.get("/", (req, res) => {
      captured.push(req.crawlertoll);
      res.send("ok");
    });
    await request(app)
      .get("/")
      .set(
        "user-agent",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
      );
    expect(captured).toHaveLength(1);
    const decision = captured[0] as { action: string; bot: { isBot: boolean } };
    expect(decision.action).toBe("allow");
    expect(decision.bot.isBot).toBe(false);
  });

  it("respects RSL policy string passed inline", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Allow: /public

User-agent: *
Disallow:
`;
    const app = makeApp({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });

    const blocked = await request(app)
      .get("/articles/1")
      .set("user-agent", "GPTBot/1.2");
    // Disallow:/ with no Compensation → block (403)
    expect(blocked.status).toBe(403);

    const allowed = await request(app)
      .get("/public/x")
      .set("user-agent", "GPTBot/1.2");
    expect(allowed.status).toBe(200);
  });

  it("charges (402) when RSL declares per-crawl compensation", async () => {
    const policy = `
User-agent: GPTBot
Disallow: /
Compensation: per-crawl 5000 micros USD
`;
    const app = makeApp({
      policy,
      offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
    });
    const res = await request(app)
      .get("/articles/1")
      .set("user-agent", "GPTBot/1.2");
    expect(res.status).toBe(402);
  });

  it("calls onDecision telemetry hook for every request", async () => {
    const seen: string[] = [];
    const app = express();
    app.use(
      crawlertoll({
        offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
        onDecision: (decision) => {
          seen.push(decision.action);
        },
      }),
    );
    app.get("/", (_req, res) => res.send("ok"));
    await request(app).get("/").set("user-agent", "GPTBot/1.2");
    await request(app)
      .get("/")
      .set("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2)");
    expect(seen).toEqual(["402", "allow"]);
  });

  it("decisionOverride can short-circuit the decision", async () => {
    const app = express();
    app.use(
      crawlertoll({
        offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
        decisionOverride: () => ({
          action: "allow",
          bot: {
            isBot: true,
            entry: null,
            userAgent: "test",
            hasSignatureHeaders: false,
            signatureAgent: null,
            reasons: Object.freeze(["override"]),
          },
          reasons: Object.freeze(["override"]),
        }),
      }),
    );
    app.get("/", (_req, res) => res.send("ok"));
    const res = await request(app).get("/").set("user-agent", "GPTBot/1.2");
    // Without override this would be 402; with override it's 200.
    expect(res.status).toBe(200);
  });
});
