# Design system: austere cloud public pages

Covers `/` (signed out) and `/security`. The signed-in `/` is austere-axi's hub shell (see Components, Hub).

## Direction

The review sheet. The agent's plan is the drawing, reviewers' notes are redline marks, the owner signs off. Dark is the default: black ground, graphite panels, near-white ink. Light is the whiteprint, one click away through a no-script toggle. One red pencil does the markup: revision clouds, delta marks, leader lines, revoked links, focus rings. It is retuned for black in dark. Square corners, ruled title blocks. No glow, bento grid or floating terminal.

## Where it lives

| File | Role |
|---|---|
| `src/site.ts` | Tokens and all CSS, head metadata, nav, footer, `cmd()` command block, CSP |
| `src/landing.ts` | `/` body and its metadata and JSON-LD |
| `src/security.ts` | `/security` body |
| `src/seo.ts` | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/favicon.svg`, `/apple-touch-icon.png`, `/og.png` |
| `src/og.png`, `src/apple-touch-icon.png` | Generated PNGs, bundled as binary through the `[[rules]] type = "Data"` rule in `wrangler.toml` (`src/assets.d.ts` types the import) |
| `scripts/og/` | `og.html` template and `render.sh` (headless Chrome; writes both PNGs) |

Static HTML and CSS, no build step, no script. CSP: `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`. `form-action 'self'` is for the theme toggle. `img-src 'self'` is for the favicon (Firefox applies it). JSON-LD is a data block and is not blocked.

## Theme

Dark is the default for every visitor and does not depend on `prefers-color-scheme`. The visitor can switch to light and the choice persists, with no script:

1. The toggle is a `<form method="post" action="/theme">` with a hidden `return_to` and one `<button name="theme" value="<target>">`. Its accessible name is "Switch to light theme" or "Switch to dark theme". Visible cells always read Dark | Light; the current one is filled.
2. `POST /theme` (`src/web.ts`) sets the `austere_theme` cookie (`dark` or `light`, 1 year, `Path=/`, `SameSite=Lax`, `HttpOnly`) and answers 303 to `returnPath(return_to)`: a same-origin path, else `/`. An unknown theme is a 400.
3. Every page renders `<html data-theme="…">` from the cookie (`themeOf()` in `src/theme.ts`; no cookie or an unknown value is dark), one `<meta name="color-scheme">` with that theme, and one `<meta name="theme-color">` (`#000000` dark, `#F3F5F7` light).
4. The toggle sits in the nav on `/` and `/security` (after the links, before Sign In) and first in the account group of the error pages. Error pages without an account show it alone. It returns to the page it was on; on private pages that is `/`.
5. `/security` is `private, max-age=3600` with `Vary: cookie`, since its HTML depends on the cookie. `/` and the private pages are `no-store`.

`/favicon.svg`, `/og.png` and `/apple-touch-icon.png` are rendered in the dark default only.

## Tokens

Three layers, all CSS custom properties on `:root` in `src/site.ts`: primitives (`--p-*`), semantic (`--color-*`), component (`--btn-*`, `--revcloud-*`, `--delta-size`). `:root` holds the light values. `:root[data-theme="dark"]` re-maps only the semantic layer.

Border colors have their own tokens, so borders and text can differ in dark: `--color-line` (hairlines and 1.5 px rules), `--color-line-heavy` (3 px rules), `--color-line-control` (borders that identify a control: `.btn`, `.field`, the theme toggle). In light all three are ink.

| Token | Light | Dark |
|---|---|---|
| `--color-ground` | #F3F5F7 | #000000 |
| `--color-sheet` | #FFFFFF | #0A0A0A |
| `--color-panel`, `--color-grid` | #E6EBF0, #E3E9EF | #111113 |
| `--color-line` | #13223A | #222226 |
| `--color-line-heavy` | #13223A | #3F3F46 |
| `--color-line-control` | #13223A | #71717A |
| `--color-ink` | #13223A | #EDEDED |
| `--color-ink-2` | #3B4A62 | #D4D4D8 |
| `--color-muted` | #56657B | #A1A1AA |
| `--color-markup` | #BF2E18 | #F2553C |
| `--color-markup-strong` (red text) | #9E2412 | #FF6A4D |
| `--color-action` / `--color-on-action` | #13223A / #F3F5F7 | #EDEDED / #000000 |
| `--color-held` (HELD tag only) | #F3DD4A | same |
| `--color-inverse` / `--color-on-inverse` (one band) | #0D2741 / #EDF3F9 | #EDEDED / #0A0A0A |
| `--shadow-mock` | shipped | none |

Contrast, measured by the designer (WCAG 2.x), dark: ink on ground / sheet / panel 17.94 / 16.91 / 16.11; ink-2 on ground 14.21; muted on ground / sheet / panel 8.19 / 7.72 / 7.36; markup-strong on ground 7.42; markup on ground 6.14 (needs 3); on-inverse on inverse 16.91; line-control on ground 4.35 (needs 3). Light: ink on paper 14.58, ink-2 8.21, muted 5.42, markup-strong 7.08, markup 5.31. Every text pair is at least 4.5:1 in both themes. Hairlines (`--color-line`, `--color-grid`) are below 3:1 on purpose: they are decoration, and every boundary that identifies a control uses `--color-line-control`. The sample sheet's product chrome uses `--p-app-*` (the real austere-axi review page colors) in both themes.

Retired: the cyanotype (Prussian blue) dark palette and its `prefers-color-scheme` block. The light inverse band still uses `--p-prussian-900`, `--p-chalk-50` and `--p-chalk-200`.

**Type** (system faces only, CSP blocks web fonts):
- Display: `"DIN Condensed","Bahnschrift Condensed","Bahnschrift","Display Fallback",system-ui`, weight 700, `font-stretch:75%`. The h1 and h2 use it. `Display Fallback` is an `@font-face` over local Arial, Helvetica, Liberation Sans, Roboto, Segoe UI or DejaVu Sans Bold with `size-adjust:69%`, which matches the width of Bahnschrift at 75%. Machines with neither DIN nor Bahnschrift get the same line breaks.
- Body: `system-ui` stack. Mono: `ui-monospace` stack.
- One hero scale: `--text-hero` `clamp(3rem,1.6rem + 6vw,7rem)` for every face. The h1 has `max-width:none; text-wrap:balance` (not a `ch` measure, since `ch` follows the face). Do not set `overflow:hidden` on headings: DIN on macOS sits low on its line box.
- Scale: hero `--text-hero`, h2 `clamp(2rem,…,3.5rem)`, h3 22px, lede 19px, body 17px, label 12px 600 uppercase.

**Space and layout:** 4 px base (`--space-1..9`), `--section-y` clamp 72 to 128 px, page max 1200 px, gutter clamp 16 to 40 px. Drafting grid: 24 px, hero and final CTA bands only.

**Lines:** hairline 1 px, ink 1.5 px, heavy 3 px (title block outer). Radius 0; only the product mock uses 8 px.

## Components

- **Nav:** sticky, 1.5 px bottom rule. How It Works, Security, Docs, GitHub, the theme toggle. **Sign In** (ghost) only when accounts are on.
- **Theme toggle `.theme`:** a two-cell ruled segment, "Dark | Light", 40 px (44 px below 640 px). The current cell is filled with `--color-action`; the other is muted and takes a panel fill on hover. Border is `--color-line-control`.
- **Buttons:** 48 px, square. Primary = solid ink; ghost = 1.5 px ink border. Hover changes background only. Red is never a fill.
- **Command block `cmd()`:** sheet fill, 1.5 px ink border, mono. The prompt (`$`, `›`) is `user-select:none`; the command is `user-select:all`. Scrolls horizontally instead of wrapping, so 375 px never breaks `austere-axi` at the hyphen.
- **Revision cloud `.revcloud`:** `::after` radial-gradient scallops, masked to the box edge with `mask-composite: exclude` (`-webkit-mask-composite: xor`). Gradient stops are in px (calc stops did not render). Leave `--revcloud-r` (10 px) clear around the target. Use it twice: hero row 3 and outcome 3.
- **Delta mark `.delta`:** inline SVG triangle, 2 px stroke in markup red, number in display type. Numbers the three outcomes.
- **Sample sheet:** product mock inside a ruled sheet with `role="img"` and an `aria-label`; contents are `aria-hidden`. Register table below it (ISSUED TO, LINK, STATUS), LINK column hidden under 640 px. `Revoked` is red with a 2 px strikethrough.
- **HELD tag:** label type on `--color-held`. SENT is plain muted text. State is never color alone.
- **Title block (footer):** 3-column ruled grid ≥640 px, stacked below.
- **Inverse band:** the one committed color field; flips to #EDEDED in dark. If that is too bright, retune three tokens: `--color-inverse`, `--color-on-inverse`, `--color-on-inverse-2`.
- **FAQ:** native `<details>`, no JS.
- **Focus:** 2 px `--color-markup` outline, 3 px offset, on links, buttons and `summary`.
- **Hub** (signed-in `/`, `src/hub.ts`): not this design system. It is austere-axi's hub shell in cloud mode (`chrome/shell.js` and `shell.css` of the pinned release, `HUB_VERSION`), dark only, loaded through `/rt`. Its look belongs to austere-axi; this repo serves it and answers its `/hub/api`. The theme toggle stays on the public pages.

## Motion

One sequence on the hero sheet at load, about 1.4 s, then still: cloud reveals left to right (`clip-path`, 700 ms), delta pops, leader grows, held note rises, HELD stamps. `animation-fill-mode: backwards`, so the end state is the default. `prefers-reduced-motion: reduce` removes all of it. No infinite animations.

## Responsive

≥1024 px: hero is 6 + 6 columns, primary action above the fold at 1280×800. Below: sheet stacks under the CTA; register drops LINK below 640 px. Verified in Chromium and Firefox: no horizontal scroll at 320 to 768 px (`.steps li` needs `grid-template-columns:minmax(0,1fr)`, or Firefox sizes the column to the nowrap command). The nav is sticky from 640 px up and static below. Hero on the fallback face: 3 lines and the primary button above the fold at 1280×800 (bottom 792 px) and 1440×900 (806 px).

## Metadata and SEO

- Canonical host `https://austere.blundertech.com`. Each page has `<title>`, description, `canonical`, Open Graph, Twitter `summary_large_image`, and one `theme-color` that follows the rendered theme.
- `/` JSON-LD: `WebSite` and `SoftwareApplication`. No `offers` or `aggregateRating` until pricing exists. `/security`: `WebPage`.
- `/` and `/security` carry no `noindex`. `/p/*`, `/api/*`, `/auth/*`, `/hub/*`, `/rt/*`, `/pk/*` are disallowed in `robots.txt` and the HTML ones send `x-robots-tag: noindex`.
- `sitemap.xml` lists `/` and `/security`, with no `lastmod`.
- `apple-touch-icon.png` (180 px) is rendered from the favicon art by the same script.
- `og.png` is rendered from `scripts/og/og.html` with Barlow Condensed Bold (OFL) for the raster only: `scripts/og/render.sh path/to/BarlowCondensed-Bold.ttf`. Commit the regenerated PNGs.

## Copy rules

Curly quotes. No em dashes in prose. Sentence-case headings, title-case nav labels. Facts only from the austere-axi and austere-cloud docs: no invented pricing, logos, testimonials or metrics. The site says what is not built yet (`/security`, "Not built yet").

## Not verified

The dark theme and the toggle (RLM-459) were rendered in Chromium only, at 1280 px and 375 px, dark and light. Safari and Firefox were not checked for them. WebKit does not launch on the build machine (missing system libraries), so Safari rendering of the mask and DIN metrics on macOS are unchecked.
