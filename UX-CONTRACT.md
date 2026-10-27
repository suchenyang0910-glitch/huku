# Haku UX contract

## Product context

Haku is a Telegram Mini App for a quiet, illustrated self-reflection reading. The public Mini App and account controls support `en`, `vi`, `zh`, `km`, and `th`; the separate admin host is an operational surface. The canonical visual tokens and runtime components live in `haku.html`, with durable direction in `DESIGN.md`.

## Canonical surfaces

| Surface | Route | Entry | Exit |
| --- | --- | --- | --- |
| Home and reading | `/` | Mini App launch | Telegram/browser navigation |
| My account | `/#/me` | Verified Telegram user's header entry or direct URL | In-page Back, browser Back, Telegram BackButton |
| Admin | Admin host | Direct URL | Admin logout |

My account owns identity display, verification/saved status, Telegram ID copy, privacy details, account export, save, and delete. Home owns the Begin the story action. A verified, unsaved user also sees the default-selected Save account control below it; saved, unverified, and non-Telegram users do not.

## Consent and mutation states

- Loading or verifying a Telegram session never creates an account record.
- Begin the story calls the consent endpoint exactly once only for a verified, unsaved user while Save account remains selected. Clearing it results in no write. A failed save shows an error and still opens the questionnaire.
- Save account is available to verified, unsaved users in My account.
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
