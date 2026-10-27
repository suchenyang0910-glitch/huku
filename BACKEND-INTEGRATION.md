# Haku Telegram and admin API contract

This workspace contains a front-end prototype only. The API base is supplied at runtime as `window.HAKU_API_BASE`; without it, Telegram sign-in reports preview mode and admin screens use clearly labeled sample data. No Bot token or Telegram user ID is written to local storage.

## Telegram Mini App

1. On open, the client reads the displayed user ID from Telegram WebApp data. Treat `initDataUnsafe` as display-only and untrusted.
2. When `HAKU_API_BASE` is configured, the client sends the raw `Telegram.WebApp.initData` to `POST /api/telegram/auth` automatically. The server validates Telegram's signature using the expected Bot secret, checks `auth_date` freshness, and checks the validated user ID against the client-displayed ID.
3. Successful verification creates a short-lived server session using a `Secure`, `HttpOnly`, `SameSite` cookie. Return the verified user and a CSRF token; do not return Bot secrets.
4. The user must opt in before a durable account record is created. The checked consent form calls `POST /api/telegram/consent` with `{ "accepted": true, "locale": "en|km|th|zh" }` and the CSRF token. Record consent version and time. Reject calls without an authenticated session or explicit acceptance.
5. Retain only Telegram ID, selected locale, first/last-seen timestamps, consent state/version, and the approved Bot source ID needed for service delivery. Do not retain private reading answers in the account table. Define a deletion and retention policy before launch.

The Mini App launch URL or server-side route configuration identifies which approved Bot configuration is expected for that entry point. Telegram `initData` proves the user context when its signature validates; it is not a universal Bot identifier. Never infer trust from a query parameter supplied by the client.

### `GET /api/telegram/account`

Requires the current verified Telegram user session. Returns only that user's saved account record, with exactly these fields: `telegram_id`, `locale`, `source_bot_id`, `first_seen`, `last_seen`, `consent_at`, and `consent_version`. Returns `404` if the authenticated user has not consented or the record was deleted. The response is suitable for the user's JSON export.

### `POST /api/telegram/account/delete`

Requires the verified Telegram user session and `X-CSRF-Token`. Deletes the record matching that session's Telegram ID and returns `{ "deleted": true }`. Missing sessions receive `401`; a missing or invalid CSRF token receives `403`. The endpoint does not accept a target ID from the request body.

Saved records are automatically deleted when `last_seen` is older than `HAKU_RETENTION_DAYS` (default `365`). Cleanup runs once at service startup and every 24 hours. Successful Telegram authentication refreshes `last_seen` for an existing record. This account record excludes birth details, relationship answers, and reading feedback.

## Admin API

The admin API uses named accounts and a signed, `HttpOnly` session cookie. Passwords are stored as salted scrypt hashes. Login attempts are rate limited. Owners can perform administrative writes; viewers can read the overview only. Admin writes require the session CSRF token, and authorization is enforced by the server. Both roles can log out.

### `POST /api/admin/login`

Request: `{ "username": "...", "password": "..." }`. On success, sets the admin session cookie and returns `{ "authenticated": true, "csrfToken": "...", "admin": { "id": "...", "username": "...", "role": "owner|viewer" } }`. Neither password nor password hash is returned by any API.

Create an account with `node server.mjs create-admin <username> <owner|viewer>`. The password is read from standard input, not command-line arguments or logs. Usernames are 3�C32 characters and may contain letters, digits, `.`, `_`, and `-`.

For migration from the previous shared-password setup, `HAKU_ADMIN_PASSWORD` is accepted only when the `admins` table is empty and the submitted username is `owner`. A successful login creates a salted scrypt owner account. Remove the legacy environment variable after that first login. When any named account exists, the legacy password is ignored.

### `POST /api/admin/logout`

Requires the admin session cookie and `X-CSRF-Token`. Clears the current session cookie.

### `GET /api/admin/overview`

Returns only records the current staff role may view:

```json
{
  "metrics": { "totalUsers": 1284, "newUsers7d": 96, "consentRate": 91 },
  "dailyNewUsers": [14, 20, 17, 29, 22, 38, 31],
  "dailyDates": ["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"],
  "users": [
    { "id": "1082457361", "bot": "Haku Main", "locale": "en", "date": "2026-10-27", "consent": true }
  ],
  "bots": [
    { "id": "bot-main", "name": "Haku Main", "handle": "@haku_story_bot", "role": "Mini App", "active": true }
  ],
  "csrfToken": "session-bound-token"
}
```

`dailyNewUsers` contains seven counts for the rolling seven days ending today, oldest first. `dailyDates` holds the matching UTC dates (`YYYY-MM-DD`); the client derives each bar's weekday label from these dates. Paginate the user list in production when the account volume requires it; the prototype currently renders the returned page and filters it locally by Telegram ID.

### Bot status configuration

The UI displays live Bot status as read-only. The active Bot list is configured through `HAKU_BOTS_JSON` and takes effect after a server restart. Keep Bot tokens in server environment or secret storage. Do not add a client-side token field.

### Roles and audit log

The `admins` table stores `id`, `username`, `password_hash`, `role` (`owner` or `viewer`), `created_at`, and `disabled`. A viewer can read `GET /api/admin/overview`; write requests under `/api/admin/` return `403` for viewers. The `audit_log` table stores `id`, nullable `admin_id`, `action`, `target`, `at`, and `ip`. It records successful and failed admin logins, admin logout, and account data exports. Once an address exceeds the login rate limit, only the first blocked attempt in each 15-minute window is recorded (`admin_login_rate_limited`); further blocked attempts return `429` without writing to the log. Self-service account exports have a null `admin_id` and use a generic target so the audit record does not retain the user's Telegram ID.

## Telegram Bot webhook

`POST /api/telegram/webhook/:botId` accepts Telegram webhook updates only for a Bot whose `id` exists in `HAKU_BOTS_JSON` and is active. A Bot is active unless its `active` value is `false`; `scripts/set-webhook.mjs` uses the same rule. Requests must include `X-Telegram-Bot-Api-Secret-Token`. The expected value is `base64url(HMAC-SHA256(key=HAKU_SESSION_SECRET, message="webhook:" + botId))`; comparison is timing-safe. Unknown or inactive Bots receive `404`; missing or invalid secrets receive `401`. The JSON body limit is 64 KiB.

The handler acknowledges updates with `200 {"ok":true}` and processes them asynchronously. It only replies to a `message.text` beginning with `/start` in a private chat (exact `/start`, `/start ` followed by payload, or `/start@...`). Locale is selected from the sender's `language_code` prefix (`km`, `th`, `zh`; all other values use English). Duplicate update IDs are ignored in memory, and each chat is limited to five replies per minute.

The webhook only sends the fixed localized welcome copy and an Open Haku button. It does not store or log message content, Telegram user IDs, usernames, or chat IDs, and it creates no account record. The de-duplication and rate-limit state is in memory and is cleared when the process restarts. Telegram API failures are logged with the Bot ID and error type only.

Register active Bots after each deployment or when adding a Bot with `node scripts/set-webhook.mjs` (use `--dry-run` to preview). The script also configures the menu button and localized Bot profile copy. `HAKU_TELEGRAM_API_BASE` defaults to `https://api.telegram.org` and usually does not need to be changed. The deployment Caddy example forwards all routes; if a proxy allowlists paths, allow `/api/telegram/webhook/`.

### Reverse proxy client IP

When `HAKU_TRUSTED_PROXY=true`, the server uses the last IP in `X-Forwarded-For` for admin login rate limiting and audit records. The proxy must replace the incoming header with exactly one verified visitor IP. With Cloudflare, configure Caddy to trust only Cloudflare's published IPv4/IPv6 ranges, read `CF-Connecting-IP` as the client IP header, and send `X-Forwarded-For: {client_ip}` upstream. Never trust a visitor-supplied `X-Forwarded-For` value or expose port 4173 publicly.

The public health endpoint supports unauthenticated `GET` and `HEAD` requests and returns status 200. If the currently deployed server responds with `UNAUTHENTICATED`, it is not running the expected handler version.

## Current storage and limits

- SQLite stores only consented account records: Telegram ID, locale, source Bot, first/last seen, and consent time/version. The comic answers and feedback remain in page memory and are not sent to the server.
- Sessions are held in process memory. A server restart expires all user and admin sessions.
- The current server targets one Node process and one persistent SQLite file. Multi-instance operation needs a shared data and session store.
- Users can export or delete their account through the Telegram account endpoints. The retention period is configured with `HAKU_RETENTION_DAYS` and defaults to 365 days since last activity.

## Multiple Bot availability

- Assign each Mini App launch link to an allowlisted Bot configuration. Keep each Bot token server-side and rotate secrets through deployment secret management.
- Bind each user session to its verified Telegram user ID and the approved Bot entry route. Bot selection for outbound messages must consider the user's prior start/consent state and Telegram delivery errors.
- A user generally needs to start a Bot before it can message them. Moving traffic between Bots cannot guarantee that a user is reachable on the backup Bot.
- Use health checks, rate limits, retry queues, and clear service status for resilience. Do not rotate Bots to bypass a platform ban, spam restriction, or enforcement action; pause the affected route and resolve the platform issue.

