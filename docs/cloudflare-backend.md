# Existing Cloudflare backend boundary

## Audit

Previously `/api/chat`, `/api/jobs`, `/api/files`, `/api/artifacts/*`, and six `src/lib/cloud/*.functions.ts` modules executed in the server hosting the frontend. AI provider calls, Drive refresh/upload/read/delete, D1 HTTP queries, research/search, fact-check page reads, repository API reads, runtime GitHub dispatch, fonts for PDF generation and tool APIs consequently ran there. Only OAuth provider exchange, SMTP delivery and runtime runner relay were already executed by the existing `vision` Worker.

Browser REST callers: `cloud/chat-stream.ts`, `builder/jobs-client.ts`, `download.ts`, `pages/project-detail/index.tsx`. Browser RPC callers are routed centrally by `start.ts` (native TanStack serialization unchanged). `cloud/client.ts` initiated OAuth on the frontend host. `useBackgroundTasks.ts` still referenced a retired external task-worker; it now uses existing authenticated `/api/jobs`.

## Implemented path

Frontend → configured Cloudflare endpoint → `cloudflare.entry.ts` → existing application API/RPC handlers → existing provider integrations. Gateway OAuth/mail/runtime handlers remain on the same Worker. Root SSR is disabled and frontend-host API execution returns 503 rather than running with preview credentials. D1 prefers the existing `DB` binding; HTTP access remains a server-side compatibility fallback. No database schema or integration is replaced.

`VITE_CLOUDFLARE_API_URL` is a **public** HTTPS endpoint, defaulting to `https://vision.tusharkantidasofficial.workers.dev`. The existing Worker `ALLOWED_RETURN_ORIGINS` lists exact frontend origins for CORS, CSRF and OAuth returns, including the Worker itself for the app-side `/api/oauth-callback/:provider` return. Never put service credentials in `VITE_*` variables. Native RPC now uses stable handler names across checkout paths; dev IDs are normalized without changing serialization. The Worker still needs the corresponding version of every callable function.

## Remaining runtime step (not an application migration)

The currently served gateway does not implement the application's chat/files/RPC endpoints. Updating request URLs cannot add those handlers. Use the standard production build's `dist/server/index.mjs` with `cloudflare.entry.ts`, then update the **existing `vision` Worker** using `auth-gateway/wrangler.toml`. Its DB and SMTP Secrets Store declarations are retained; retain all currently configured secrets, variables, AI/service bindings and origin entries. No credentials are copied to frontend hosting, no new backend is created, no database is moved. This task does not publish or update a live Worker.

The Worker must retain NVIDIA_API_KEY, GROQ_API_KEY, existing Workers AI binding or REST configuration, Drive OAuth credentials/folder, security hash key, runtime GitHub key and mail authorization configuration as applicable. Secret presence and successful external calls are not established by source code.

## Browser exceptions and limitations

Static fonts/CDN scripts, locally executed PDF/FFmpeg converters, sandboxed generated web previews, ordinary outbound links, and browser speech recognition are frontend resource/OS functions, not privileged application service calls. They are not rerouted as arbitrary API proxies. Google/GitHub OAuth redirects remain intentional browser redirects; exchange/verification/session creation run on Cloudflare.

Cross-origin partitioned cookies are retained. Existing frontend-origin sessions do not automatically transfer to the API origin; users must sign in there. OAuth top-level navigation plus partitioned embedded sessions needs real-browser verification; do not claim OAuth success from unit tests. A different frontend top-level site may require its own sign-in because partitioned cookies are site-scoped.