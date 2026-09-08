# DevAssess — Developer Assessment & Coding Platform

Backend for a developer screening platform. Companies build a problem bank, assemble timed assessments, spend **paid invitation credits** to invite candidates, and receive auto-scored, comparable results — with a full audit trail.

> **PH-B7 Assignment 6** · Project #4 — Developer Assessment Platform

---

## Submission

```text
Project Name    : DevAssess — Developer Assessment & Coding Platform
Backend Repo    : https://github.com/Samin1362/PH-B7-Assignemnt-6-Backend
Live API        : https://REPLACE-AFTER-DEPLOY.vercel.app
API Docs        : postman/DevAssess-API.postman_collection.json  (import into Postman)
Demo Video      : REPLACE-WITH-VIDEO-LINK
Admin Email     : admin@devassess.com
Admin Password  : Admin@1234
```

## Demo credentials

| Role | Email | Password |
|---|---|---|
| **ADMIN** | `admin@devassess.com` | `Admin@1234` |
| **COMPANY** | `company@devassess.com` | `Company@1234` |
| **CANDIDATE** | `candidate@devassess.com` | `Candidate@1234` |
| **CANDIDATE** | `candidate2@devassess.com` | `Candidate@1234` |

Dedicated evaluation accounts — not personal credentials.

---

## Why credits

Inviting a candidate is the platform's unit of value, so it costs a credit, and credits come only from Stripe. Payment therefore **gates real business logic** rather than sitting beside it — and it creates a genuine concurrency problem (two requests racing the same balance) that the invitation endpoint has to solve correctly.

```
COMPANY                                        CANDIDATE
   │
   ├─ buys credit pack ──► Stripe Checkout
   │                          └─► webhook ──► credits += N   (idempotent)
   │
   ├─ creates Problems ──► builds Assessment ──► PUBLISH
   │
   ├─ invites candidates ──► 1 credit each  (atomic, 402 when short)
   │                              └─► Invitation (token, expiry)
   │                                                 ├─ starts Attempt (server-side timer)
   │                                                 ├─ autosaves answers
   │                                                 └─ submits ──► auto-scored
   ├─ evaluates written answers ◄────────────────────────────────┘
   └─ reads report + leaderboard (Redis cached)
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 18+ · TypeScript (strict) · Express 4 |
| Database | PostgreSQL (Neon) + Prisma 6 — 17 models, 8 enums, 41 indexes |
| Validation | Zod 4 on every POST / PATCH / PUT |
| Auth | bcrypt + JWT (access 15 m / refresh 30 d, rotated) + Google OAuth |
| Payments | Stripe Checkout + signature-verified webhooks |
| Cache & limits | Redis (Upstash) — report/leaderboard cache, distributed rate limiting |
| Security | helmet · CORS allowlist · express-rate-limit |
| Deployment | Vercel serverless |

## The three roles

| | CANDIDATE | COMPANY | ADMIN |
|---|:-:|:-:|:-:|
| Manage problem bank & assessments | ❌ | ✅ own | ✅ all |
| Buy credits, invite candidates | ❌ | ✅ | ❌ |
| Sit assessments, see own results | ✅ | ❌ | ❌ |
| Evaluate answers, reports, leaderboard | ❌ | ✅ own | ✅ all |
| Manage users, roles, credits, audit logs | ❌ | ❌ | ✅ |

A COMPANY is scoped to its own rows everywhere; cross-tenant access returns **403**, never a misleading 404.

---

## Response contract

Every endpoint, without exception.

**Success**
```json
{ "success": true, "message": "Operation successful", "data": {} }
```

**Error**
```json
{ "success": false, "message": "Something went wrong",
  "errors": [{ "path": "email", "message": "Provide a valid email address" }] }
```

List endpoints add `meta: { page, limit, total, totalPage }`.

---

## API — 56 endpoints under `/api/v1`

<details open>
<summary><b>Authentication (6)</b></summary>

| Method | Path | Access |
|---|---|---|
| POST | `/auth/register` | public |
| POST | `/auth/login` | public |
| POST | `/auth/google` | public (Google ID token) |
| POST | `/auth/refresh-token` | public |
| POST | `/auth/logout` | any |
| POST | `/auth/change-password` | any |
</details>

<details>
<summary><b>Users & Profiles (5)</b></summary>

`GET /users/me` · `PATCH /users/me` · `GET /users/me/profile` · `PUT /users/me/candidate-profile` · `PUT /users/me/company-profile`
</details>

<details>
<summary><b>Problem Bank (7)</b> — COMPANY / ADMIN</summary>

`POST /problems` · `GET /problems` · `GET /problems/:id` · `PATCH /problems/:id` · `DELETE /problems/:id` · `POST /problems/:id/test-cases` · `DELETE /problems/:id/test-cases/:testCaseId`

List supports `?page=&limit=&q=&type=&difficulty=&tags=&sortBy=&sortOrder=`
</details>

<details>
<summary><b>Assessments (8)</b></summary>

`POST /assessments` · `GET /assessments` · `GET /assessments/:id` · `PATCH /assessments/:id` · `DELETE /assessments/:id` · `POST /assessments/:id/problems` · `DELETE /assessments/:id/problems/:problemId` · `PATCH /assessments/:id/status`
</details>

<details>
<summary><b>Invitations (4)</b></summary>

`POST /assessments/:id/invitations` · `GET /assessments/:id/invitations` · `PATCH /invitations/:id/revoke` · `GET /invitations/my`
</details>

<details>
<summary><b>Attempts & Submissions (7)</b></summary>

`POST /attempts/start` · `GET /attempts/:id` · `POST /attempts/:id/answers` · `POST /attempts/:id/submit` · `GET /attempts/my` · `GET /assessments/:id/attempts` · `PATCH /submissions/:id/evaluate`
</details>

<details>
<summary><b>Results & Analytics (3)</b></summary>

`GET /attempts/:id/result` · `GET /assessments/:id/report` *(cached)* · `GET /assessments/:id/leaderboard` *(cached)*
</details>

<details>
<summary><b>Payments & Credits (9)</b></summary>

`GET /credit-packs` · `POST /payments/checkout-session` · `POST /payments/webhook` · `GET /payments` · `GET /payments/:id` · `GET /payments/success` · `GET /payments/cancel` · `GET /credits/balance` · `GET /credits/transactions`
</details>

<details>
<summary><b>Admin (7)</b></summary>

`GET /admin/users` · `PATCH /admin/users/:id/role` · `PATCH /admin/users/:id/status` · `DELETE /admin/users/:id` · `POST /admin/credits/adjust` · `GET /admin/dashboard-stats` *(cached)* · `GET /admin/audit-logs`
</details>

Plus `GET /` and `GET /health` (real database round-trip).

---

## Engineering decisions worth defending

### Idempotent payment fulfilment
The webhook grants credits with a **compare-and-swap**, not a read-then-check:

```ts
const claimed = await tx.payment.updateMany({
  where: { id, status: 'PENDING' },   // scoped to still-pending rows
  data:  { status: 'PAID', ... },
});
if (claimed.count === 0) return { status: 'duplicate' };
```

Stripe redelivers events. A `findUnique` followed by `if (status === 'PAID')` passes a sequential replay test and still double-credits under concurrent delivery. Verified: **five identical webhooks fired simultaneously credited the account exactly once.**

### Atomic credit spend
Inviting deducts with the guard inside the statement, so the check and the deduction cannot be separated:

```sql
UPDATE credit_accounts SET balance = balance - $cost
WHERE "companyId" = $id AND balance >= $cost RETURNING balance
```

Zero rows back means insufficient funds → **402**. Verified: **balance 5, ten concurrent invites → exactly 5 succeeded, 5 rejected**, balance never negative.

> An earlier version used `SELECT … FOR UPDATE` plus a separate `UPDATE`. It was *correct* but not *available*: five round trips inside the lock exceeded Prisma's 5 s transaction timeout under load, and 7 of 10 requests died mid-flight. Collapsing it to one statement, moving the audit write after commit, and mapping Prisma **P2028 → 503** fixed it.

### Constraints carry the business rules
| Constraint | What it prevents |
|---|---|
| `Attempt @@unique([assessmentId, candidateId])` | Two live timers for one candidate |
| `Submission @@unique([attemptId, problemId])` | Autosave read-then-write races |
| `Invitation @@unique([assessmentId, email])` | Spending two credits on one person |
| `Payment.stripeSessionId @unique` | A replayed webhook double-crediting |

### Assessment state machine
`DRAFT → PUBLISHED → CLOSED → ARCHIVED`. Illegal transitions return **409 naming the allowed set**. Once published, `durationMinutes` and `passingScore` freeze — candidates may have attempts in flight and changing either would retroactively alter how their work is scored.

### Scoring
| Type | Auto | Rule |
|---|---|---|
| MCQ | yes | exactly one correct option → all-or-nothing |
| CODING | yes | output matched line-for-line against **visible** test cases, weighted → partial credit |
| WRITTEN | no | awaits `PATCH /submissions/:id/evaluate` |

Only visible test cases auto-score: the platform does not execute code, so a candidate cannot produce output for inputs they were never shown. Hidden cases are retained for the evaluator, who can override any auto score. Manual evaluation **re-totals the attempt from its submissions**, so the headline score cannot drift from the sum of its parts.

### Security
- Login returns an identical message for an unknown email and a wrong password — no account enumeration.
- `ADMIN` is absent from the registration role enum; privilege is granted, never self-selected.
- The auth middleware re-reads the user row per request, so **blocking takes effect immediately** rather than lingering until the access token expires.
- Refresh tokens are stored as SHA-256 digests and rotated on use; changing a password revokes every session.
- Admins cannot modify their own account, so a lone admin cannot lock themselves out.
- Rate limiting **fails open** on a Redis outage — refusing every request would turn a cache outage into a full outage.
- Caching is likewise best-effort: a Redis failure degrades the API to "always compute", never to "returns an error".

---

## Running locally

```bash
git clone https://github.com/Samin1362/PH-B7-Assignemnt-6-Backend.git
cd PH-B7-Assignemnt-6-Backend
npm install
cp .env.example .env          # fill in the values below
npx prisma migrate deploy
npm run db:seed
npm run dev                   # http://localhost:5050
```

> **macOS note:** the default port is **5050**, not 5000 — AirPlay Receiver occupies 5000 and returns 403.

### Environment variables

| Variable | Required | Notes |
|---|:-:|---|
| `DATABASE_URL` | ✅ | Neon **pooled** connection string |
| `DIRECT_URL` | ✅ | Same string without `-pooler` — migrations only |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | ✅ | ≥32 chars each; separate secrets |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | | Default `15m` / `30d` |
| `BCRYPT_SALT_ROUNDS` | | Default `12` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | | Social login; degrades to 503 when unset |
| `STRIPE_SECRET_KEY` | | Payments; degrades to 503 when unset |
| `STRIPE_WEBHOOK_SECRET` | | From `stripe listen` locally, or the dashboard in production |
| `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | | Post-checkout redirects |
| `REDIS_URL` | | `rediss://` for Upstash (TLS). Absent → no cache, in-memory rate limits |
| `CORS_ORIGINS` | | Comma-separated allowlist |
| `RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MINUTES` | | Default `100` / `10` / `15` |

Every variable is parsed through a Zod schema at boot — a missing or malformed value fails immediately with a readable report rather than surfacing as an `undefined` deep inside a handler.

### Stripe webhooks locally

```bash
stripe listen --forward-to localhost:5050/api/v1/payments/webhook
# copy the printed whsec_… into STRIPE_WEBHOOK_SECRET, then restart
```

Test card **4242 4242 4242 4242**, any future expiry, any CVC.

---

## Deploying to Vercel

1. Push to GitHub.
2. Vercel → **Add New → Project** → import the repo. The included `vercel.json` routes everything to `api/index.ts`; no framework preset is needed.
3. Add every environment variable above under **Settings → Environment Variables**.
4. Deploy. `postinstall` runs `prisma generate`, and `binaryTargets` includes `rhel-openssl-3.0.x` for Vercel's runtime.
5. Apply migrations against production once:
   ```bash
   DATABASE_URL="<neon-pooled>" DIRECT_URL="<neon-direct>" npx prisma migrate deploy
   DATABASE_URL="<neon-pooled>" npm run db:seed
   ```
6. Stripe → **Developers → Webhooks → Add endpoint** → `https://<your-app>.vercel.app/api/v1/payments/webhook`, subscribe to `checkout.session.completed`, `checkout.session.expired`, `payment_intent.payment_failed`, then put the signing secret into Vercel and redeploy.
7. Add `https://<your-app>.vercel.app` to the Google OAuth client's authorized origins.
8. Smoke test: `curl https://<your-app>.vercel.app/health`

---

## API documentation

```
postman/
├── DevAssess-API.postman_collection.json    76 requests across 10 folders
├── DevAssess-Local.postman_environment.json
└── DevAssess-Production.postman_environment.json
```

Import both files into Postman, select an environment, then run **01 · Authentication → Login** for the role you want — the token is captured into a collection variable automatically, so nothing needs copy-pasting. Ids created along the way (`problemId`, `assessmentId`, `invitationToken`, `attemptId`) flow into later requests.

The collection includes deliberate **negative cases** — 403s, 409s and validation failures — so role enforcement and the state machine can be demonstrated, not just described.

---

## Project structure

```
src/
├── app.ts                 helmet, CORS, rate limits, routes, error handler
├── server.ts              local listener + graceful shutdown
├── config/                env (Zod-validated), prisma, redis, stripe, google
├── middlewares/           auth · validateRequest · globalErrorHandler · notFound · rateLimiter
├── modules/               auth · user · problem · assessment · invitation
│                          attempt · result · payment · credit · admin
│                          └── each: route · controller · service · validation
├── utils/                 sendResponse · ApiError · catchAsync · jwt · audit · cache · queryBuilder
prisma/                    schema.prisma · migrations/ · seed.ts
postman/                   collection + environments
api/index.ts               Vercel serverless entry
```

Routes → controllers → services → Prisma. Controllers never touch the database; services never touch `req`/`res`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch mode via tsx |
| `npm run build` | `prisma generate && tsc` |
| `npm start` | Run the compiled build |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply migrations (production) |
| `npm run db:seed` | Idempotent seed — safe to re-run |
| `npm run db:studio` | Prisma Studio |
