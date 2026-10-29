# Willder — Deploy Checklist

Step-by-step for taking Willder from local dev to a live Vercel deployment.
Work through each section in order — later sections depend on earlier ones.

---

## 1. Vercel project

- [ ] `vercel link` — link the repo to a Vercel project
- [ ] Set **Node.js version** to 20+ in project settings
- [ ] Set **Root directory** to `.` (monorepo root)
- [ ] Leave the build command at its default, `npm run build`. It runs `build.sh`,
  which applies pending migrations when a database URL is set and the build is a
  Vercel deploy (or `ALLOW_PRISMA_MIGRATE_DEPLOY=1`), then runs `prisma generate`
  and `next build`. Overriding it with `prisma generate && next build` skips the
  migrations.

---

## 2. Environment variables

Copy every key from `.env` into Vercel (Settings → Environment Variables).
Critical ones that must be set before the app boots:

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Neon dashboard → Connection string (pooled) |
| `DATABASE_URL_UNPOOLED` | Neon dashboard → Connection string (direct) |
| `NEO4J_URI` | Neo4j AuraDB dashboard |
| `NEO4J_USERNAME` | Neo4j AuraDB dashboard |
| `NEO4J_PASSWORD` | Neo4j AuraDB dashboard |
| `GRAPHITI_SERVICE_URL` | Your deployed memory-service URL |
| `GRAPHITI_SERVICE_API_KEY` | Any secret string you choose |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API Keys |
| `CLERK_SECRET_KEY` | Clerk dashboard → API Keys |
| `OPENAI_API_KEY` | platform.openai.com |
| `INNGEST_SIGNING_KEY` | Inngest dashboard → your app |
| `INNGEST_EVENT_KEY` | Inngest dashboard → your app |
| `NEXT_PUBLIC_APP_URL` | Your Vercel production URL, e.g. `https://your-app.vercel.app` |

---

## 3. Clerk — production instance

- [ ] Create a **Production** Clerk instance (separate from dev)
- [ ] Set allowed redirect URLs to your Vercel domain
- [ ] Enable **Organizations** (Configure → Organizations, Membership = optional)
- [ ] Update `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` to the production keys

---

## 4. Database — run migrations

```bash
# From your local machine with DATABASE_URL pointing at Neon prod:
npx prisma migrate deploy
```

---

## 5. Memory service — deploy

The Python FastAPI memory service needs its own deployment (Railway, Fly.io, or a Vercel Python function).

- [ ] Deploy `memory-service/` as a separate service
- [ ] Set its env vars: `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `OPENAI_API_KEY`, `GRAPHITI_SERVICE_API_KEY`, `BLOB_READ_WRITE_TOKEN` (same value as Vercel's — `/extract` fetches private Blob URLs server-side and needs it to authenticate)
- [ ] Set `GRAPHITI_SERVICE_URL` in Vercel to the deployed memory-service URL
- [ ] Verify `/health` returns `{ "status": "ok", "neo4j": true }`

---

## 6. Inngest — production

- [ ] Create a production Inngest app at app.inngest.com
- [ ] Set `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` in Vercel
- [ ] After first deploy, go to Inngest dashboard → Sync → paste your Vercel app URL (`https://your-app.vercel.app/api/inngest`)
- [ ] Verify all functions appear: `memoryIngest`, `campaignStart`, `draftProspect`, `researchAgent`, etc.

---

## 7. Gmail OAuth — real credentials

- [ ] `MAILBOX_OAUTH_MOCK=false` in Vercel env vars
- [ ] `GOOGLE_CLIENT_ID` — from Google Cloud Console → Credentials
- [ ] `GOOGLE_CLIENT_SECRET` — from Google Cloud Console → Credentials
- [ ] `APP_ENCRYPTION_KEY` — 64-char hex string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- [ ] Add your Vercel URL to **Authorized redirect URIs** in Google Cloud Console:
  `https://your-app.vercel.app/api/integrations/gmail/callback`
- [ ] Add your Vercel domain to **Authorized JavaScript origins**

---

## 8. Mailbox permissions — identity only

A mailbox connection requests only the account's identity (`services/integrations/mailbox.ts`,
`MAILBOX_SCOPES`): Gmail `openid email`, Outlook `openid email User.Read`. There is no inbox
watch, so no Pub/Sub topic or Graph subscription is needed.

- [ ] Google Cloud Console → OAuth consent screen → **Data access**: list only `openid` and
  `.../auth/userinfo.email`. Remove `gmail.send` and `gmail.readonly` if they are listed.

---

## 9. Outlook OAuth — real credentials

- [ ] `MICROSOFT_CLIENT_ID` — from Microsoft Entra (Azure Portal → App registrations → your app → Application (client) ID)
- [ ] `MICROSOFT_CLIENT_SECRET` — from Azure Portal → App registrations → your app → Certificates & secrets → New client secret (copy the **Value**, not the ID)
- [ ] `APP_ENCRYPTION_KEY` — same key used for Gmail (already set in §7)
- [ ] In Azure Portal → **Authentication** → add both redirect URIs:
  - `http://localhost:3000/api/integrations/outlook/callback` (local dev)
  - `https://your-app.vercel.app/api/integrations/outlook/callback` (production)
- [ ] In Azure Portal → **API permissions** → delegated Microsoft Graph permissions:
  - `openid`, `email`, `User.Read` only; remove `Mail.Send`, `Mail.Read` and `offline_access` if present
- [ ] Supported account types: **"Accounts in any organizational directory and personal Microsoft accounts"** (covers Outlook.com + work/school accounts)

**After this is set**, the Outlook connect button in Integrations → Mailboxes will run the real OAuth flow.

---

## 11. Optional services

| Service | Env var | Purpose |
|---|---|---|
| Exa | `EXA_API_KEY` | Web research for enrichment |
| Firecrawl | `FIRECRAWL_API_KEY` | Site scraping for enrichment |
| Apollo | `APOLLO_API_KEY` + `ENRICH_APOLLO_ENABLED=1` | Contact data enrichment |
| Langfuse | `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | Draft quality tracing |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` | File uploads to memory |
| Google Drive | `GDRIVE_MOCK=false` + `GOOGLE_CLIENT_ID/SECRET` | Picked-folder sync to memory. Not yet verified live that Google grants the files inside; a sync that lists none shows "No files synced" on the source |

---

## 12. Smoke test after deploy

- [ ] Sign up → org creates in Postgres
- [ ] Connect Gmail → redirects to `/inbox?connected=1`, integration shows `connected`
- [ ] Create a contact + campaign → start campaign → draft appears in Inbox
- [ ] Approve & Send → email arrives in Gmail sent folder
- [ ] Reply from the recipient → appears in Conversations tab within ~30s
- [ ] Memory page → Ask a question → answer cites facts from memory
- [ ] Audit page → shows memory read entries
