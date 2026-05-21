# @crawlertoll/express

Express middleware for the AI-crawler economy. One line wires up bot detection, Web Bot Auth verification, RSL 1.0 policy enforcement, and HTTP 402 issuance with a structured payment offer.

- **License**: Apache-2.0
- **Express**: 4.x or 5.x (peer dependency)
- **Node**: 20+
- **Core**: [`@crawlertoll/core`](https://www.npmjs.com/package/@crawlertoll/core) — all the standards work happens there; this package is the thin Express bridge.

[![npm](https://img.shields.io/npm/v/%40crawlertoll%2Fexpress.svg)](https://www.npmjs.com/package/@crawlertoll/express)
[![license](https://img.shields.io/npm/l/%40crawlertoll%2Fexpress.svg)](./LICENSE)

---

## Install

```bash
npm install @crawlertoll/express @crawlertoll/core express
```

---

## Sixty seconds

```ts
import express from "express";
import { crawlertoll } from "@crawlertoll/express";

const app = express();

app.use(crawlertoll({
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
  },
  contextLicenseUrl: "https://example.com/.well-known/context-license.json",
  termsUrl: "https://example.com/ai-terms",
}));

app.get("/", (req, res) => res.send("hello"));

app.listen(3000);
```

Any AI crawler hitting your endpoints gets a 402 with Cloudflare-shape `Crawler-Price` headers and a JSON payment offer. Browsers pass through.

---

## With an RSL 1.0 policy

The middleware accepts your robots.txt body directly. Policy is parsed once on first request, then cached.

```ts
import { readFileSync } from "node:fs";
import express from "express";
import { crawlertoll } from "@crawlertoll/express";

const app = express();

const robotsTxt = readFileSync("./public/robots.txt", "utf8");

app.use(crawlertoll({
  policy: robotsTxt,     // ← parsed, cached, applied per-request
  offer: {
    rail: "x402",
    priceMicros: 5000,
    currency: "USD",
    paymentUrl: "https://pay.example.com/abc",
  },
}));
```

Your `robots.txt`:

```
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /
Allow: /public
License: https://example.com/ai-license
Permits: ai-search, rag
Prohibits: ai-training
Compensation: per-crawl 5000 micros USD
Standard: RSL/1.0

User-agent: *
Disallow:
```

Behaviour:

- GPTBot or ClaudeBot hits `/articles` → **402** with the payment offer (Disallow + Compensation = charge)
- GPTBot hits `/public/anything` → **200** (Allow override)
- Random browser → **200** (`*` catch-all is Disallow:)

---

## Per-request decision API

The middleware attaches the structured decision to `req.crawlertoll`. Downstream handlers can inspect it for logging, dashboards, or fine-grained policy.

```ts
app.use(crawlertoll({ /* ... */ }));

app.get("/articles/:id", (req, res, next) => {
  const decision = req.crawlertoll;
  if (decision?.bot.isBot) {
    console.log("bot", decision.bot.entry?.name, "→", decision.action);
  }
  next();
});
```

---

## All options

```ts
crawlertoll({
  /** Payment offer surfaced when the decision is 402. */
  offer?: PaymentOffer,

  /** RSL 1.0 policy. Pass parsed `RslPolicy` or raw robots.txt text. */
  policy?: RslPolicy | string,

  /** Convenience: terms-of-use URL injected as Link rel="terms-of-service". */
  termsUrl?: string,

  /** Convenience: /.well-known/context-license.json URL injected as Link rel="describedby". */
  contextLicenseUrl?: string,

  /** Run Web Bot Auth verification when signature headers are present. Default true. */
  verifyAuth?: boolean,

  /** Trust verified bots even when policy would charge them. Default false. */
  trustVerifiedBots?: boolean,

  /** Called after every decision. Telemetry hook. */
  onDecision?: (decision, req, res) => void | Promise<void>,

  /** Short-circuit the decision pipeline. Return a Decision to override; return null to fall through. */
  decisionOverride?: (req) => Decision | null | Promise<Decision | null>,

  /** Pass-through options to build402(). */
  buildOptions?: Omit<Build402Options, "offer">,
})
```

---

## Telemetry hook

`onDecision` runs on every request after the decision is reached. Use for dashboards, anonymised analytics, or routing custom metrics. Errors thrown here are caught and emitted as `process.emitWarning` — they never break the request.

```ts
app.use(crawlertoll({
  offer: { rail: "x402", priceMicros: 5000, currency: "USD" },
  onDecision: (decision, req, _res) => {
    metrics.increment("crawler.decision", {
      action: decision.action,
      operator: decision.bot.entry?.operator ?? "unknown",
      verified: decision.authVerified?.valid ?? false,
    });
  },
}));
```

---

## Conformance

8 supertest end-to-end tests cover:

- Browser request passes through
- Known bot → 402 with correct headers + body
- Bot allow-list (no offer configured) → 200
- `req.crawlertoll` populated on every request
- RSL policy: blocked → 403, charge model → 402, Allow override → 200
- `onDecision` telemetry hook called for every request
- `decisionOverride` short-circuits the pipeline

Run them:

```bash
git clone https://github.com/charthouse-ltd/crawlertoll-express-js
cd crawlertoll-express-js
npm install
npm test
```

---

## Compatible frameworks

This package is the Express adapter. Other framework adapters use the same `@crawlertoll/core` engine — semantics are identical, only the request/response shim differs.

- `@crawlertoll/express` (this package)
- `@crawlertoll/fastify` (Day 30)
- `@crawlertoll/hono` (Day 30 — unlocks Cloudflare Workers + Bun + Deno + Vercel Edge in one shot)
- `@crawlertoll/next` (Day 30 — Next.js `middleware.ts`)

If your framework isn't listed, use `@crawlertoll/core`'s `decide()` directly — it's framework-agnostic.

---

## License

[Apache-2.0](./LICENSE). All specs implemented are open standards under their own licenses.

## Trademark

CrawlerToll™ is a trademark of Charthouse Ltd.
