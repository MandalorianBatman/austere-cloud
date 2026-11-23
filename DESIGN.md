# Design system: austere cloud public pages

Covers `/` (signed out), `/security` and the signed-in dashboard at `/`.

## Direction

The review sheet. The agent's plan is the drawing, reviewers' notes are redline marks, the owner signs off. Light mode is a whiteprint; dark mode is a cyanotype blueprint (`prefers-color-scheme`, no toggle). One red pencil does the markup: revision clouds, delta marks, leader lines, revoked links, focus rings. Square corners, ruled title blocks. No near-black page, glow, bento grid or floating terminal.

## Where it lives

| File | Role |
|---|---|
| `src/site.ts` | Tokens and all CSS, head metadata, nav, footer, `cmd()` command block, CSP |
| `src/landing.ts` | `/` body and its metadata and JSON-LD |
| `src/security.ts` | `/security` body |
| `src/seo.ts` | `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/favicon.svg`, `/apple-touch-icon.png`, `/og.png` |
| `src/og.png`, `src/apple-touch-icon.png` | Generated PNGs, bundled as binary through the `[[rules]] type = "Data"` rule in `wrangler.toml` (`src/assets.d.ts` types the import) |
| `scripts/og/` | `og.html` template and `render.sh` (headless Chrome; writes both PNGs) |

Static HTML and CSS, no build step, no script. CSP: `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`. `img-src 'self'` is for the favicon (Firefox applies it). JSON-LD is a data block and is not blocked.

## Tokens

Three layers, all CSS custom properties on `:root` in `src/site.ts`: primitives (`--p-*`), semantic (`--color-*`), component (`--btn-*`, `--revcloud-*`, `--delta-size`). Dark mode only re-maps the semantic layer.

| Token | Light | Dark |
|---|---|---|
| `--color-ground` | #F3F5F7 | #0D2741 |
| `--color-sheet` | #FFFFFF | #11304F |
| `--color-ink` | #13223A | #EDF3F9 |
| `--color-ink-2` | #3B4A62 | #BFD0E2 |
| `--color-muted` | #56657B | #9BB3CC |
| `--color-markup` | #BF2E18 | #FF8466 |
| `--color-held` (HELD tag only) | #F3DD4A | same |
| `--color-inverse` (one band) | #0D2741 | #F3F5F7 |

Contrast, measured by the designer: ink on paper 14.6, ink-2 8.2, muted 5.4, markup on paper 5.3, dark chalk on prussian 13.6, dark muted 7.0, dark coral 6.3. The sample sheet's product chrome uses `--p-app-*` (the real austere-axi review page colors) in both modes.

**Type** (system faces only, CSP blocks web fonts):
- Display: `"DIN Condensed","Bahnschrift Condensed","Bahnschrift","Display Fallback",system-ui`, weight 700, `font-stretch:75%`. The h1 and h2 use it. `Display Fallback` is an `@font-face` over local Arial, Helvetica, Liberation Sans, Roboto, Segoe UI or DejaVu Sans Bold with `size-adjust:69%`, which matches the width of Bahnschrift at 75%. Machines with neither DIN nor Bahnschrift get the same line breaks.
- Body: `system-ui` stack. Mono: `ui-monospace` stack.
- One hero scale: `--text-hero` `clamp(3rem,1.6rem + 6vw,7rem)` for every face. The h1 has `max-width:none; text-wrap:balance` (not a `ch` measure, since `ch` follows the face). Do not set `overflow:hidden` on headings: DIN on macOS sits low on its line box.
- Scale: hero `--text-hero`, h2 `clamp(2rem,…,3.5rem)`, h3 22px, lede 19px, body 17px, label 12px 600 uppercase.

**Space and layout:** 4 px base (`--space-1..9`), `--section-y` clamp 72 to 128 px, page max 1200 px, gutter clamp 16 to 40 px. Drafting grid: 24 px, hero and final CTA bands only.

**Lines:** hairline 1 px, ink 1.5 px, heavy 3 px (title block outer). Radius 0; only the product mock uses 8 px.

## Components

- **Nav:** sticky, 1.5 px bottom rule. How It Works, Security, Docs, GitHub. **Sign In** (ghost) only when accounts are on.
- **Buttons:** 48 px, square. Primary = solid ink; ghost = 1.5 px ink border. Hover changes background only. Red is never a fill.
- **Command block `cmd()`:** sheet fill, 1.5 px ink border, mono. The prompt (`$`, `›`) is `user-select:none`; the command is `user-select:all`. Scrolls horizontally instead of wrapping, so 375 px never breaks `austere-axi` at the hyphen.
- **Revision cloud `.revcloud`:** `::after` radial-gradient scallops, masked to the box edge with `mask-composite: exclude` (`-webkit-mask-composite: xor`). Gradient stops are in px (calc stops did not render). Leave `--revcloud-r` (10 px) clear around the target. Use it twice: hero row 3 and outcome 3.
- **Delta mark `.delta`:** inline SVG triangle, 2 px stroke in markup red, number in display type. Numbers the three outcomes.
- **Sample sheet:** product mock inside a ruled sheet with `role="img"` and an `aria-label`; contents are `aria-hidden`. Register table below it (ISSUED TO, LINK, STATUS), LINK column hidden under 640 px. `Revoked` is red with a 2 px strikethrough.
- **HELD tag:** label type on `--color-held`. SENT is plain muted text. State is never color alone.
- **Title block (footer):** 3-column ruled grid ≥640 px, stacked below.
- **Inverse band:** the one committed color field; flips to paper in dark mode.
- **FAQ:** native `<details>`, no JS.
- **Focus:** 2 px `--color-markup` outline, 3 px offset, on links, buttons and `summary`.
- **Dashboard** (signed-in `/`, `src/dashboard.ts`): the drawing register. Private head (`noindex`, no canonical, Open Graph or JSON-LD) and nav (Docs, Security, GitHub, the account email above 640 px, **Sign Out** ghost `sm`). h1 "Your pages" at `--text-h2`; 8/4 columns from 1100 px, one column below, Shared under Your pages.
  - **Register entry:** one `<article>` per page, a sheet with 1.5 px ink border and square corners. Head: h3 title link (22 px), label-type meta (expiry, notes), the page URL in mono, `user-select:all`, scrolling by itself. Then the access register: a real `<table>` (Account, Access, owner row first, one row per grant with a ghost `sm` Revoke), a muted note, and the grant form. Below 640 px rows stack and targets are 44 px.
  - **Input:** `.field`, same 1.5 px ink border, square corners and sheet fill as the buttons, visible label above. In error: `aria-invalid` and a 2 px markup border.
  - **Notices:** a ruled row inside the entry, above the register; `role=status` or `role=alert`. Errors add a 3 px markup bar and markup-strong text. Expiry at 3 days or less, or less than 24 h, is markup-strong at weight 600 and says so in words ("Expires in 2 days", "Expires today").
  - Not used here: revision cloud, delta mark, grid background, inverse band, shadow, motion.

## Motion

One sequence on the hero sheet at load, about 1.4 s, then still: cloud reveals left to right (`clip-path`, 700 ms), delta pops, leader grows, held note rises, HELD stamps. `animation-fill-mode: backwards`, so the end state is the default. `prefers-reduced-motion: reduce` removes all of it. No infinite animations.

## Responsive

≥1024 px: hero is 6 + 6 columns, primary action above the fold at 1280×800. Below: sheet stacks under the CTA; register drops LINK below 640 px. Verified in Chromium and Firefox: no horizontal scroll at 320 to 768 px (`.steps li` needs `grid-template-columns:minmax(0,1fr)`, or Firefox sizes the column to the nowrap command). The nav is sticky from 640 px up and static below. Hero on the fallback face: 3 lines and the primary button above the fold at 1280×800 (bottom 792 px) and 1440×900 (806 px).

## Metadata and SEO

- Canonical host `https://austere.blundertech.com`. Each page has `<title>`, description, `canonical`, Open Graph, Twitter `summary_large_image`, `theme-color` for both schemes.
- `/` JSON-LD: `WebSite` and `SoftwareApplication`. No `offers` or `aggregateRating` until pricing exists. `/security`: `WebPage`.
- `/` and `/security` carry no `noindex`. `/p/*`, `/api/*`, `/auth/*`, `/dash/*`, `/rt/*`, `/pk/*` are disallowed in `robots.txt` and the HTML ones send `x-robots-tag: noindex`.
- `sitemap.xml` lists `/` and `/security`, with no `lastmod`.
- `apple-touch-icon.png` (180 px) is rendered from the favicon art by the same script.
- `og.png` is rendered from `scripts/og/og.html` with Barlow Condensed Bold (OFL) for the raster only: `scripts/og/render.sh path/to/BarlowCondensed-Bold.ttf`. Commit the regenerated PNGs.

## Copy rules

Curly quotes. No em dashes in prose. Sentence-case headings, title-case nav labels. Facts only from the austere-axi and austere-cloud docs: no invented pricing, logos, testimonials or metrics. The site says what is not built yet (`/security`, "Not built yet").

## Not verified

WebKit does not launch on the build machine (missing system libraries), so Safari rendering of the mask and DIN metrics on macOS are unchecked. Chromium and Firefox were checked at 1280 px and 375 px, light and dark.
