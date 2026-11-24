# @oculus/admin

The staff admin in the browser (D-073): React 19 on Vite 7, React Router 8,
TanStack Query 5 and React Aria Components styled with the design tokens
(`design/DESIGN.md`) through CSS Modules. Fonts are served from the admin
itself (`public/fonts`, SIL Open Font License 1.1 for the font files only,
listed in `FONTS.json`).

Today it has the sign-in screens and the frame (T-045, D-081): Login, the
code from the authenticator app (or a recovery code), setting up two-step
sign-in (QR code drawn in the browser with `uqr`, recovery codes shown once),
choosing an organization, "Forgot your password?" and choosing a new password
from a link (`/reset#<token>`), then the sidebar with the site selector and
the top bar with the person and signing out. A site's home page is an empty
placeholder until T-046.

## Running it

- `npm run build` at the repository root builds every package, this one
  last (`dist/`). The admin's server (`npm run admin`, `packages/api`'s
  `admin-cli.ts`) serves `dist/` on `OCULUS_ADMIN_ORIGIN` with its own CSP
  (`script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'
  data:`), beside the API.
- In development, run the admin's server with `NODE_ENV=development` on
  port 3000, `OCULUS_ORIGINS=http://localhost:5173` and
  `OCULUS_ADMIN_ORIGIN=http://localhost:5173`, then `npm run dev -w
  @oculus/admin`: Vite forwards `/api` to it on the same origin, so the
  Origin, cookie and CSRF checks run unchanged.
- Tests: the screen tests run with the rest (`npx vitest run packages/admin`,
  jsdom); `npm run e2e` at the root builds and runs Playwright against the
  built admin and a throwaway database, with Siteimprove Alfa's rules (WCAG
  A and AA, plus best practices) on every screen it passes.

## Manual accessibility checklist (WCAG 2.1 AA)

Alfa and the screen tests check names, roles, contrast and structure. These
need a person, before each release that changes a screen. Use the keyboard
alone first, then a screen reader (NVDA with Firefox or Chrome on Windows,
VoiceOver with Safari on macOS or iOS).

Keyboard (no mouse at all):

- [ ] Tab from the top of each screen: the first stop is "Skip to main
      content", and Enter on it moves focus to the form or page.
- [ ] Every control is reached in reading order, and the focus ring is
      always visible (dark blue outline), including on the site selector,
      the account button and the radio and checkbox cards.
- [ ] Login: type the address and password, Enter submits. "Forgot your
      password?" opens with Enter.
- [ ] Code screen: the code field has focus on arrival; "Use a recovery code
      instead" switches the field and focus stays sensible.
- [ ] Choosing an organization: arrow keys move between the choices, Space
      selects, Tab leaves the group.
- [ ] Set-up: the QR code is skipped; the key can be selected and copied;
      the code field and Confirm are reachable. On the recovery codes screen,
      Space ticks "I have saved these codes", then "Continue to Oculus".
- [ ] Frame: the site selector opens with Enter or Space or Alt+Down, arrows
      move, Enter chooses, Escape closes and returns focus to it. The account
      button opens its menu with Enter; arrows move; Escape closes.
- [ ] Nothing traps focus; nothing moves focus unexpectedly while typing.

Screen reader:

- [ ] Each screen's heading is announced and is the only h1; the page has a
      `main` landmark, and the frame a navigation landmark named "Oculus".
- [ ] Each field announces its label, whether it is required, and its help
      text; after a wrong code or password the message is announced at once
      (role alert) without moving focus.
- [ ] The QR code is announced as "QR code to add Oculus to your
      authenticator app", and the key that follows can be read character by
      character.
- [ ] The recovery codes are announced as a list of 10.
- [ ] The site selector announces its label "Site", the chosen site, and the
      organization headings inside the list.
- [ ] Signing out everywhere else announces how many sessions ended.

Zoom and reflow:

- [ ] At 200% browser zoom and at 400% (320 CSS pixels wide), nothing is cut
      off or overlaps and no sideways scrolling is needed; the sidebar wraps
      above the content.
- [ ] With the browser's default text size raised, the paragraph text grows
      (it is set in rem).
