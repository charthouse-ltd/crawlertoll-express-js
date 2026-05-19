# Changelog

All notable changes to `@crawlertoll/express` are documented here.

The package follows [Semantic Versioning](https://semver.org/) and tracks the `@crawlertoll/core` major version.

## [0.1.0] — 2026-05-19

Initial release. Ships alongside `@crawlertoll/core` v0.1.0.

### Added

- `crawlertoll(options)` Express middleware factory.
- Supports inline RSL 1.0 policy via `options.policy: RslPolicy | string` (raw robots.txt is parsed once and cached).
- Per-request decision attached to `req.crawlertoll` for downstream handlers, logging, and dashboards.
- `onDecision` telemetry hook.
- `decisionOverride` hook to short-circuit the pipeline (e.g. for whitelisted internal services).
- `verifyAuth` (default true) and `trustVerifiedBots` (default false) toggles.
- Express 4.x and 5.x compatible (peer dependency).

### Conformance

- 8/8 supertest end-to-end tests passing.
- Re-uses `@crawlertoll/core`'s 47-test conformance suite indirectly through the decision engine.
