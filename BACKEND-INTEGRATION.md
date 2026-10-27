# Haku Telegram and admin API contract

This workspace contains a front-end prototype only. The API base is supplied at runtime as `window.HAKU_API_BASE`; without it, Telegram sign-in reports preview mode and admin screens use clearly labeled sample data. No Bot token or Telegram user ID is written to local storage.

## Telegram Mini App

1. On open, the client reads the displayed user ID from Telegram WebApp data. Treat `initDataUnsafe` as display-only and untrusted.
2. When `HAKU_API_BASE` is configured, the client sends the raw `Telegram.WebApp.initData` to `POST /api/telegram/auth` automatically. The server validates Telegram's signature using the expected Bot secret, checks `auth_date` freshness, and checks the validated user ID against the client-displayed ID.
3. Successful verification creates a short-lived server session using a `Secure`, `HttpOnly`, `SameSite` cookie. Return the verified user and a CSRF token; do not return Bot secrets.
4. The user must opt in before a durable account record is created. The checked consent form calls `POST /api/telegram/consent` with `{ "accepted": true, "locale": "en|km|th|zh" }` and the CSRF token. Record consent version and time. Reject calls without an authenticated session or explicit acceptance.
5. Retain only Telegram ID, selected locale, first/last-seen timestamps, consent state/version, and the approved Bot source ID needed for service delivery. Do not retain private reading answers in the account table. Define a deletion and retention policy before launch.

The Mini App launch URL or server-side route configuration identifies which approved Bot configuration is expected for that entry point. Telegram `initData` proves the user context when its signature validates; it is not a universal Bot identifier. Never infer trust from a query parameter supplied by the client.

## Admin API

The implementation uses a server-configured admin password and a signed, `HttpOnly` session cookie. Login attempts are rate limited. Admin writes require the session CSRF token; every `/api/admin/*` route checks the server session. Hiding the admin tab in the client is not access control. For a team deployment, replace the single admin password with named staff accounts, role authorization, and an audit trail.

### `POST /api/admin/login`

Request: `{ "password": "..." }`. On success, sets the admin session cookie and returns `{ "authenticated": true, "csrfToken": "..." }`. Configure the password through `HAKU_ADMIN_PASSWORD`; never put it in the HTML or a client environment variable.

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

## Current storage and limits

- SQLite stores only consented account records: Telegram ID, locale, source Bot, first/last seen, and consent time/version. The comic answers and feedback remain in page memory and are not sent to the server.
- Sessions are held in process memory. A server restart expires all user and admin sessions.
- The current server targets one Node process and one persistent SQLite file. Multi-instance operation needs a shared data and session store.
- Account deletion/export and a scheduled retention policy are not implemented yet; define them before public launch.

## Multiple Bot availability

- Assign each Mini App launch link to an allowlisted Bot configuration. Keep each Bot token server-side and rotate secrets through deployment secret management.
- Bind each user session to its verified Telegram user ID and the approved Bot entry route. Bot selection for outbound messages must consider the user's prior start/consent state and Telegram delivery errors.
- A user generally needs to start a Bot before it can message them. Moving traffic between Bots cannot guarantee that a user is reachable on the backup Bot.
- Use health checks, rate limits, retry queues, and clear service status for resilience. Do not rotate Bots to bypass a platform ban, spam restriction, or enforcement action; pause the affected route and resolve the platform issue.
