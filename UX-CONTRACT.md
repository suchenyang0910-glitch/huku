# Haku UX contract

## Product context

Haku is a Telegram Mini App for a quiet, illustrated self-reflection reading. The public Mini App and account controls support `en`, `vi`, `zh`, `km`, and `th`; the separate admin host is an operational surface. The canonical visual tokens and runtime components live in `haku.html`, with durable direction in `DESIGN.md`.

## Canonical surfaces

| Surface | Route | Entry | Exit |
| --- | --- | --- | --- |
| Home and reading | `/` | Mini App launch | Telegram/browser navigation |
| My account | `/#/me` | Verified Telegram user's header entry or direct URL | In-page Back, browser Back, Telegram BackButton |
| Zi Wei chart | `/#/ziwei` | Final story panel or My account when a birth time exists | Returns to the story or My account; direct URL returns home |
| Admin | Admin host | Direct URL | Admin logout |

My account owns identity display, verification/saved status, Telegram ID copy, privacy details, account export/delete, and reading-profile edit/delete. Home owns Begin the story. A verified user without current v5 consent sees the default-selected account and reading-profile consent control; users with current consent, unverified users, and non-Telegram users do not.

## Consent and mutation states

- Loading or verifying a Telegram session never creates an account record.
- Begin the story calls the consent endpoint exactly once only for a verified user without current v5 consent while Save remains selected. Clearing it results in no account/profile write. A failed save shows an error and still opens the questionnaire.
- Save or renew consent is available to verified users without current v5 consent in My account.
- Completing the final question saves one complete reading profile only with current v5 consent. Failure is non-blocking. A saved profile prefills the questionnaire and can be edited or deleted from My account. Optional gender affects only Zi Wei decade-cycle direction; chart calculation stays in the browser.
- Account deletion uses the localized app dialog, traps focus, disables the destructive action while pending, keeps failures in context, and restores focus on close.
- Export and delete are available only for a verified, saved account.

## Identity states

| State | Header indicator | My account |
| --- | --- | --- |
| Telegram user, unverified | Amber dot | Unverified status; save unavailable |
| Verified, unsaved | Green outlined dot | Save account available |
| Verified, saved | Solid green dot | Export and delete available |

The header entry is rendered only on the Mini App host when Telegram user information exists. It uses the Telegram photo when available and initials when absent or when the image fails. At 360px, its text is visually hidden and the localized `aria-label` remains.

## Responsive acceptance

- At 1440px, the hero copy, primary action, and optional consent occupy the left side and the complete fox-and-lantern illustration occupies the right without overlap.
- At 390×750 and 360×640, the primary action is visible without scrolling. The optional consent is also fully visible at 390×750; at 360×640 the primary action remains the hard minimum. The illustration follows the controls in document flow, the header stays on one row, the account entry shows only avatar and status, and no surface scrolls horizontally.
- Browser Back and Telegram BackButton return from My account to home, including a safe in-page return for a direct `/#/me` visit.
- Telegram MainButton is shown only on home when signed Telegram context and the native API are available. It runs the same save-then-read action as the in-page button and follows locale changes.
- The first reading question opens an in-app year/month/day wheel instead of the platform date input. Its initial 1990-01-01 draft is not an answer until Confirm; Cancel, Escape, and Telegram BackButton dismiss it without changing the saved answer, and focus returns to the date field.
