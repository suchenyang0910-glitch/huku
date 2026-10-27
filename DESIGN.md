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

The Mini App moves from a full-width illustrated cover into five short questions, a single-panel comic reader, and a small feedback close. On phones the primary reading action sits directly below the cover copy, the optional account-saving control follows it, and the cover illustration remains in document flow below both. The compact language menu and account entry share one header row. The comic occupies most of the available width and uses explicit previous/next controls as well as swipe. Telegram account state is summarized by the compact header entry and managed on My account (`#/me`), so it does not interrupt the reading. The operator view uses a compact navigation rail, four summary metrics, a seven-day activity chart, a searchable account table, and a Bot availability panel.

## Elevation & Depth

Cards use a low contrast border and a soft ambient shadow. Controls remain flat. Avoid stacked floating surfaces.

## Shapes

Use rounded rectangles (9–18px) for cards and controls. The avatar and moon use circles or arches to reinforce the reading-room motif.

## Components

- Primary action: forest fill, white text, clear verb.
- Account consent: verified, unsaved users see an explicit checkbox selected by default below the cover action. Loading or verifying never saves; only activating Begin the story saves while the checkbox remains selected. A failed save is reported but never blocks reading.
- Language menu: use the authored compact header menu so every user, including people outside Telegram, can change locale before reading. On phones the trigger shows only the locale abbreviation; the popup keeps the full language names and keyboard operation.
- Identity: always distinguish Telegram's client-side user data from a server-verified identity.
- Account entry: show only when Telegram user data is available on the Mini App host. Use a photo with an initials fallback, hide text at narrow widths, and encode unverified, verified, and saved states in both the status label and dot treatment.
- Account navigation: `#/me` is a real history entry when opened from the header. Browser Back and Telegram BackButton return home; a direct `#/me` visit uses an in-page back action that replaces the hash.
- Account deletion: use the app-owned confirmation dialog, keep focus inside it, and restore focus to the trigger after cancel or completion.
- Birth date and time: reuse one authored bottom-sheet wheel component for year/month/day and hour/minute listboxes. Keep drafts local until Confirm (defaulting to 1990-01-01 and 12:00), clamp invalid and future dates, trap focus, restore it to the trigger, and let Escape or Telegram BackButton dismiss the sheet before navigating.
- Comic reading: one panel per step, short captions, persistent page count, explicit next/back controls, keyboard arrows, and touch swipe.
- Telegram navigation: use the native BackButton only with nonempty `initData` and a client version that supports it; show it in My account, during questions, comic pages, and feedback, and hide it on the cover and admin view. Its action matches the in-page back action.
- Telegram primary action: use MainButton only with nonempty `initData` and an available native API. Show it on the home cover, keep its localized label aligned with the in-page Begin the story action, and hide it everywhere else.
- Page turns: use `HapticFeedback.selectionChanged()` when available, for buttons, page dots, keyboard navigation, and swipe. Do not require haptics for the reader to work.
- Accessibility: give the unknown-time checkbox and feedback options explicit names using their localized labels. When a user row has no name, show the Telegram ID once.
- Reading answers: keep them in current-page memory without current v4 consent. With v4 consent, save the specified fields in the separate `reading_profiles` record for prefill and story generation; My account owns edit and delete controls.
- Five-element ties: show every tied strongest or weakest element. Page 6 still needs one action; when weakest elements tie, choose by their relationship to the day master in this fixed order: generates me (生我), same as me (同我), I generate (我生), I control (我克), controls me (克我).
- Historical birth times: resolve each birthplace through its IANA time zone. Use the actual instant for solar-term boundaries, but subtract any daylight-saving offset before calculating the hour pillar and the 23:00 day rollover. If a daylight-saving jump skipped the entered wall time, use the first valid local minute after the gap; if a repeated wall time is ambiguous, use its earlier occurrence. Show the applied rule in the questionnaire and reading whenever it applies.
- Operator data: use sample labels when disconnected; live data requires an authenticated admin API.
- Bot availability: status is informational in live mode; sample toggles only affect local demo state.

## Do's and Don'ts

- Keep the Mini App easy to read on a narrow phone.
- Keep bot tokens off the client.
- Do not treat Telegram `initDataUnsafe` as proof of identity.
- Do not use Bot switching to evade Telegram enforcement.
- Do not expose reading answers in the account list. Only an owner may open an individual profile, and each view must be audited.
- Do not use names or usernames in account records unless a later product requirement and consent explicitly need them.
