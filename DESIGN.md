# Haku interface direction

## Overview

The Mini App should feel like a quiet illustrated reading room: intimate and calm for end users, clear and measured for operators. Its reader is a six-panel, moonlit comic with a recurring lantern, riverside setting, and Haku companion. The comic framing is the public surface's visual signature. Admin surfaces use the same paper-and-forest palette with tighter spacing and tabular numbers.

The source of truth for the current prototype tokens is the `:root` block in `haku.html`. It defines the paper, surface, ink, muted, line, green, plum, coral, gold, shadow, sans, and serif tokens. The interface supports `en`, `vi`, `zh`, `km`, and `th`, in that display order. Vietnamese uses Fraunces for titles and Be Vietnam Pro for body text; Khmer and Thai use their Noto Sans families with system fallbacks. No separate generated token artifact exists yet.

## Colors

- Paper `#f4f1e9`: page background.
- Surface `#fffdf8`: cards and controls.
- Ink `#243331`: primary text.
- Muted `#71807b`: supporting text.
- Forest `#416b5b`: actions and product identity.
- Soft forest `#e4ede5`: selected and status backgrounds.
- Plum `#79576f`: small expressive accents.
- Coral `#bb684f`: focus ring accent.
- Gold `#c29a53`: moon illustration and caution marker.

Keep semantic status distinct from decorative colors. Always pair status color with a text label.

## Telegram dark theme

When Telegram reports `colorScheme: dark`, apply the `telegram-dark` root class and read valid hex colors from `themeParams`. Map `bg_color`, `section_bg_color` (falling back to `secondary_bg_color`), `text_color`, `hint_color`, `section_separator_color`, `button_color`, and `button_text_color` to the page background, cards, primary text, supporting text, borders, forest action color, and action text. Listen for `themeChanged` and update the same tokens. Ignore malformed color values.

The fallback dark palette follows the forest identity: page `#16231f`, surface `#202e29`, raised surface `#293a33`, ink `#f1f3ed`, muted text `#bdc9c1`, border `#40544a`, forest action `#79a58a`, selected surface `#2c4137`, plum `#c6a9bc`, coral `#e5987f`, and gold `#e1c17a`. Preserve the illustrated comic caption's warm paper surface as part of the story artwork; keep its ink dark for legibility.

## Typography

- Display: Fraunces, reserved for headlines and the Haku mark.
- Interface: DM Sans by default, Be Vietnam Pro for Vietnamese, with Noto Sans Khmer and Noto Sans Thai ahead of generic sans fallbacks.
- Data: interface sans with tabular numerals for IDs, rates, and counts.

## Layout

The Mini App moves from an illustrated cover into five short questions, a single-panel comic reader, and a small feedback close. On phones the comic occupies most of the available width and uses explicit previous/next controls as well as swipe. Telegram account state stays available on the cover and does not interrupt the reading. The operator view uses a compact navigation rail, four summary metrics, a seven-day activity chart, a searchable account table, and a Bot availability panel.

## Elevation & Depth

Cards use a low contrast border and a soft ambient shadow. Controls remain flat. Avoid stacked floating surfaces.

## Shapes

Use rounded rectangles (9–18px) for cards and controls. The avatar and moon use circles or arches to reinforce the reading-room motif.

## Components

- Primary action: forest fill, white text, clear verb.
- Account consent: explicit checkbox next to the exact fields retained.
- Identity: always distinguish Telegram's client-side user data from a server-verified identity.
- Comic reading: one panel per step, short captions, persistent page count, explicit next/back controls, keyboard arrows, and touch swipe.
- Telegram navigation: use the native BackButton only with nonempty `initData` and a client version that supports it; show it during questions, comic pages, and feedback, and hide it on the cover and admin view. Its action matches the in-page back action.
- Page turns: use `HapticFeedback.selectionChanged()` when available, for buttons, page dots, keyboard navigation, and swipe. Do not require haptics for the reader to work.
- Accessibility: give the unknown-time checkbox and feedback options explicit names using their localized labels. When a user row has no name, show the Telegram ID once.
- Reading answers: keep in current-page memory only; never persist them with account data.
- Operator data: use sample labels when disconnected; live data requires an authenticated admin API.
- Bot availability: status is informational in live mode; sample toggles only affect local demo state.

## Do's and Don'ts

- Keep the Mini App easy to read on a narrow phone.
- Keep bot tokens off the client.
- Do not treat Telegram `initDataUnsafe` as proof of identity.
- Do not use Bot switching to evade Telegram enforcement.
- Do not store reading answers in the account dashboard.
- Do not use names or usernames in account records unless a later product requirement and consent explicitly need them.
