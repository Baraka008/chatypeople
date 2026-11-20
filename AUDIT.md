# Repository audit — first pass

## Findings
- Node application with PostgreSQL/Neon, Vercel Functions, Web Push, and a custom build script.
- Vercel is a plausible target, but verify that `server.js` and all runtime routes are compatible with serverless execution; long-lived sockets/background processes need a separate service.
- Review authentication, authorization, message privacy, SQL parameterization, push-subscription handling, rate limits, and database migrations.
- Never commit Neon credentials or VAPID private keys; configure them as Vercel environment variables.

## Verification
Package manifest and root structure inspected; build and database checks not run.