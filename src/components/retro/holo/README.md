# Spare Holo

The design system for the Spare desktop: pastel sky, holographic chrome,
chunky pixel headlines with an iridescent fill and a deep-indigo outline, Win98
bevels in pastel, and deep-indigo "screens" for dense data.

```ts
import { HoloHero, HoloCard, HoloButton, HoloSegmented, HOLO, INK } from '@/components/retro/holo';
```

- **Stateful CSS** (hover, pressed, focus, media queries, animation) lives in
  `holo.css`. It is imported once from `src/index.css`, so every component works
  wherever it renders.
- **Fonts** come from Google Fonts in `src/index.css`. There are no other
  external resources.
- **Shared chrome** (window frame, title bar, menu bar, taskbar, Start menu,
  tray, dialogs, desktop icons) is built from the same tokens, so an app only
  lays out its own window body.

---

## 1. Conventions

1. **Start every app with `<AppCanvas>`** (from `apps/spare/SpareUi`) or
   `<HoloWindowBody>`. It paints the pastel canvas and sets the ink context.
2. **Group content in `HoloCard`s.** Open an app with **one** `HoloHero`.
3. **Text is indigo on pastel.** Use `INK.*` (or `HOLO.ink*`), and never grey or
   black. Light text belongs only on deep-indigo screens.
4. **Deep indigo is for emphasis and data**: `HoloScreen`, `HoloBadge
   variant="solid"`, selected keys, and `HoloCard tone="screen"`. Use it as an
   accent, never as a whole window.
5. **Pixel fonts need room.** Use `FONT_CHROME` (Jersey 10) at 16–22px and
   **always at `fontWeight: 400`**, because faux bold smears the pixels. Use
   `FONT_DISPLAY` (Press Start 2P) only through `HoloTitle` / `HoloStat`.
6. **Mobile (≤767px) must work at 375px.** Every component wraps or shrinks. Put
   grids behind `repeat(auto-fit, minmax(220px, 1fr))`, and don't set fixed
   widths wider than about 330px.

---

## 2. Tokens (`tokens.ts`)

### Colour: `HOLO`

| group | keys |
|---|---|
| sky (brand gradient stops) | `cream #FFF1E6` `peach #FFD9C2` `pink #FFB8E0` `lilac #C9B6FF` `periwinkle #9FB4FF` |
| iridescent tints | `butter` `gold` `sky` `mint` `white` |
| surfaces | `paper` (input/table well) `face` (control face) `faceDeep` (pressed) `frame` (chrome face) |
| ink (text on pastel) | `ink #2A1B6E` body · `inkSoft #4B36B8` labels · `inkMuted #5140B8` hints · `inkFaint` rules only |
| bevel | `bevelHi` `bevelMid` `bevelLo #A897EC` `bevelHard #2A1B6E` |
| screens (deep indigo) | `screen #1B1450` `screenDeep` `screenRaised` `screenLine` · text `onScreen` `onScreenMuted` `onScreenSubtle` |
| semantic | `goodInk/goodLit/goodFill` · `warnInk/warnLit/warnFill` · `badInk/badLit/badFill` · `infoInk/infoLit/infoFill` · `link/linkLit` |

*Ink* reads on pastel (all ≥ 4.8:1 on the canvas), *Lit* reads on screens, and
*Fill* is for dots, bars and chips. Helpers: `holoInk(tone)`, `holoLit(tone)`,
`holoFill(tone)`.

`HoloTone = 'holo' | 'ink' | 'good' | 'warn' | 'bad' | 'info' | 'muted'`.

### Ink context: `INK`, `INK_ON_LIGHT`, `INK_ON_SCREEN`

`INK.body | soft | muted | good | warn | bad | info | link` are CSS variables
that fall back to pastel-surface values. Every Holo surface sets the right
values for its contents. **Text styled with `INK.*` therefore reads correctly on a card
and inside a screen without any props.** That is how `HINT` / `KEY_LABEL` /
`NOTE` in `apps/spare/styles.ts` work. Use `inkFor(tone)` for a tone.

If you build a custom dark block, spread `INK_ON_SCREEN` onto it. For a custom
light block, spread `INK_ON_LIGHT`.

### Type

| token | face | use |
|---|---|---|
| `FONT_DISPLAY` | Press Start 2P | headlines + big numerals (through `HoloTitle` / `HoloStat`) |
| `FONT_PIXEL` | Silkscreen | pixel caps: eyebrows, chips, table heads, sub-headlines ("ROUNDUP ENGINE") |
| `FONT_CHROME` | Jersey 10 | title bars, menus, buttons, field labels. **16–22px, weight 400** |
| `FONT_TEXT` | Space Mono | body copy, values, inputs, addresses ("Round to $1 / $5 / $10") |

### Gradients, bevels, shadows, textures

- `GRADIENT.sky` (hero), `.canvas` (window body), `.holoText` (clip to text),
  `.chrome` (primary controls), `.face`, `.card`, `.titleBar` / `.titleBarIdle`,
  `.cardBar` / `.cardBarLilac` / `.cardBarPink` / `.cardBarInk`, `.menuBar`,
  `.taskbar`, `.screen`, `.meter*`.
- `BEVEL_RAISED`, `BEVEL_PRESSED`, `BEVEL_SUNKEN`, `BEVEL_WELL`, `BEVEL_WINDOW`
  are Win98 bevels in pastel: white highlight, lilac shadow and a 1px indigo
  hard edge.
- `SHADOW.card` (hard 4px pixel drop), `.window`, `.pop`, `.textOutline` (white
  text over busy art), `.titleText`.
- `TEXTURE.dither` / `.ditherLight` (4px tile, layer it:
  `` `${TEXTURE.dither} 0 0 / 4px 4px, ${GRADIENT.card}` ``), `.halftone` +
  `.halftoneSize`, `.checker` (indigo/white band), `.gridLayers` (screen grid).
- `SPARKLE_PATH`, `sparkleUrl()`, `pixelPath(rows)`, `PIXEL_X_PATH`,
  `PIXEL_CHECK_PATH`, …
- `HOLO_STYLE.screen | well | text | label` are ready-made style fragments.

---

## 3. Components

### `HoloWindowBody` (and `AppCanvas`)
The pastel canvas an app paints inside its window: a soft sky gradient, dither,
two corner sparkles and a halftone horizon at the bottom. It stacks children
with `gap`.
```tsx
<HoloWindowBody sparkles padding={14} gap={12}>…</HoloWindowBody>
```
`AppCanvas` (from `apps/spare/SpareUi`) renders exactly this.

### `HoloHero`
The header an app opens with. Use one per app, at the top.
```tsx
<HoloHero
  art="/icons/spare/roundup-rules.png"      // or a node, or null; default = HoloStar
  kicker="From payments to stocks"          // pixel caps above
  title="Round-Up Rules"                    // holo pixel headline
  subtitle="Roundup engine"                 // cream pixel sub-headline
  description="Every eligible payment rounds up to $1, $5 or $10."
  aside={<HoloBadge label="ON-CHAIN" variant="solid" />}
  compact={false} size="lg" seed={11} sparkles planet shimmer={false}
>{/* optional chips / controls under the copy */}</HoloHero>
```
Art ships in `public/icons/spare/*.png` (fund-wallet, spare-balance,
link-wallet, roundup-rules, stock-mix, auto-invest, spare-activity, viewing-key,
stock-desk, after-hours, portfolio-xray, docs, roadmap). Use `compact` for secondary screens.

### `HoloTitle`
A holographic pixel headline: iridescent fill, indigo outline and extrusion,
and a cream rim.
```tsx
<HoloTitle size="xl">Turbo round-ups</HoloTitle>                  // xs 12 · sm 16 · md 24 · lg 32 · xl 44 (smaller on mobile)
<HoloTitle size="sm" font="pixel" fill="cream">Roundup engine</HoloTitle>
<HoloTitle size="md" fill="ink">With every payment</HoloTitle>   // indigo letters, white outline
<HoloTitle fill="good" | "warn" | "bad" /> <HoloTitle shimmer as="h1" align="center" outline="#…" />
```
The base copy is the accessible text and the fill copy is `aria-hidden`. It
renders UPPERCASE. A decimal point between two digits ("$5.00", "0.25", "1.5x")
is wrapped in `.holo-title__dot` automatically: it keeps the outline but drops
the extrusion and rim, which would otherwise smear Press Start 2P's baseline
square into a comma ("$5,00"). This works for string, number, array and
fragment children.

### `HoloCard`
A dialog card: 2px indigo frame, white inner keyline, pastel mini title bar,
and a pastel body with a dither drift in the corner. The bar's right corner is a
real `[×]` button only when `onClose` is passed; otherwise it shows a small
outlined sparkle, so no card ever carries a control that does nothing.
```tsx
<HoloCard
  title="Round-up rule"            // omit for a bare bar
  icon="/icons/spare/stock-mix.png" // or a node
  accent="$5 · 2×" accentTone="info"  // string → HoloBadge in the bar (solid); or pass a node
  bar="holo" | "lilac" | "pink" | "ink"
  tone="light" | "screen"          // screen = deep-indigo body for dense data
  onClose={fn}                     // renders a real [×] button; without it the corner is a sparkle
  closeBox={false} compact flat    // closeBox={false} drops the corner piece entirely
  footer={<><HoloButton>Cancel</HoloButton><HoloButton variant="primary">Save</HoloButton></>}
>…</HoloCard>
```
The body is a flex column with a 10px gap.

### `HoloPanel` / `HoloScreen`
```tsx
<HoloPanel variant="raised" | "sunken" | "glass" | "flat" tone="light" | "screen" texture="dither" | "halftone" | "grid" | "none" padding={12} gap={8} />
<HoloScreen center grid padding="10px 12px">…</HoloScreen>   // deep-indigo sunken well
```
`glass` is the frosted card for content over busy art. `HoloScreen` is the
home for real data readouts: dense numbers, logs, the address well, the keeper
verdict. Empty and loading states are **not** screens; use `MutedWell` (a
pastel sunken panel), so "nothing to show" never becomes a dark slab.

### `HoloButton`
```tsx
<HoloButton variant="primary" | "secondary" | "danger" | "ghost" size="sm" | "md" | "lg" active block icon={…} {...buttonProps} />
```
A primary button has the chrome face, an indigo ring and a corner sparkle; use
**one per view**. `active` latches the pressed bevel and sets `aria-pressed`.
Buttons are taller on mobile.

### `HoloSegmented`
The "$1 / $5 / $10" picker: a sunken tray of keys where the chosen one
is a deep-indigo key with a sparkle. It is a `radiogroup` with arrow-key
navigation.
```tsx
<HoloSegmented value={roundTo} onChange={setRoundTo} options={ROUND_TO_VALUES} format={(v) => `$${v}`} ariaLabel="Round up to" />
<HoloSegmented size="sm" value={m} onChange={setM} options={[{ value: 1, label: '1×', hint: 'no multiplier' }, …]} block />
```
`T` is inferred from `options` / `value`, so a `useState` setter fits directly.

### `HoloInput` / `HoloSelect` / `HoloToggle`
```tsx
<HoloInput prefix="$" suffix="USDG" value={cap} onChange={(e) => setCap(e.target.value)} invalid={bad} inputSize="md" width={140} block inputMode="decimal" />
<HoloSelect value={v} onChange={(e) => setV(e.target.value)} options={[{ value: 'w', label: 'Weekly' }]} />
<HoloToggle checked={on} onChange={setOn} label="Round-ups on" detail="Pausing stops new accrual." />
```
Inputs use a sunken paper well in Space Mono. `invalid` adds a pink ring plus
`aria-invalid`. Fields switch to 16px on mobile so iOS doesn't zoom. The whole
toggle row is the hit target (`role="checkbox"`).

### `HoloBadge` / `HoloChip`
```tsx
<HoloBadge label="CONFIRMED" tone="good" />                 // soft: pastel chip + pixel dot
<HoloBadge label="ROUND UP" variant="solid" />               // deep-indigo tag with cream pixel caps
<HoloBadge label="PENDING" tone="warn" variant="fill" pulse />
<HoloChip selected={t === 'SPY'} onClick={() => pick('SPY')}>SPY</HoloChip>
<HoloChip onRemove={() => drop('TSLA')}>TSLA</HoloChip>
```
### `HoloStat`
```tsx
<HoloStat label="Spare balance" value="$12.40" size="xl" sub="USDG · on-chain" tone="holo" | "good" | "warn" | "bad" | "ink" />
```
`lg` / `xl` sizes render a holographic numeral; `sm` / `md` render bold
Space Mono for dense rows. Numbers never wrap.

### `HoloProgress`
```tsx
<HoloProgress value={62} label="Weekly cap used" showValue segments={20} tone="holo" | "good" | "warn" | "bad" />
<HoloProgress indeterminate height={10} ariaLabel="Waiting for Robinhood Chain" />
<HoloProgress value={40} onScreen />   // on a deep-indigo screen
```
A Win98 segmented bar with a holographic fill that snaps to whole blocks.

### `HoloTable` / `HoloList` / `HoloListRow`
```tsx
<HoloTable columns={[{ key: 'when', label: 'When', width: 110 }, { key: 'amt', label: 'Amount', align: 'right', render: (r) => fmt(r.amt) }]}
           rows={rows} rowKey={(r) => r.id} selectedKey={sel} onSelectRow={setSel} dense minWidth={520} maxHeight={320} emptyMessage="No round-ups yet." />
<HoloList>
  <HoloListRow label="Round to" value="$5" hint="the next boundary each payment is lifted to" />
  <HoloListRow label="Linked wallets" value="2" right={<HoloButton size="sm">Manage</HoloButton>} onClick={…} />
</HoloList>
```
`HoloTable` has a sticky pixel header and
scrolls sideways inside its well on narrow windows (set `minWidth`). Rows are
keyboard-selectable. A trailing row-action column (empty header, or key
`action` / `actions`) is pinned to the well's right edge while the table
scrolls sideways, so its buttons never sit off-screen on a phone; set
`pin: 'right'` on any trailing column to pin it, or `pin: false` to opt out.

### `HoloNotice`
```tsx
<HoloNotice tone="info" | "warn" | "error" | "success" title="Viewing Key is not built" action={<HoloButton size="sm">Switch</HoloButton>} compact live="status" | "alert" | "none">
  No shielded pool exists yet.
</HoloNotice>
```
A Win98 message box with a pixel icon tile. Use it for status messages and
inline errors (`live="alert"` for errors that block an action).

### `HoloLabel` / `HoloText` / `HoloDivider`
```tsx
<HoloLabel>Round up to</HoloLabel>                       // Silkscreen caps
<HoloLabel font="chrome">Round-up rule</HoloLabel>       // Jersey 10 sentence case
<HoloText tone="muted" size="sm" bold as="span">…</HoloText>
<HoloDivider /> <HoloDivider variant="etched" /> <HoloDivider variant="checker" label="or" />
```

### Decorative: `HoloSparkle` / `HoloSparkles` / `HoloStar` / glyphs
```tsx
<HoloSparkle size={12} twinkle />                          // one ✦
<div style={{ position: 'relative' }}><HoloSparkles count={7} seed={3} avoidCenter={0.5} /></div>
<HoloStar size={88} animated />                            // the Spare mark in holographic chrome
<HoloMessageIcon kind="warn" size={16} />  <GlyphClose /> <GlyphCheck /> <GlyphMin /> <GlyphMax /> <GlyphRestore /> <GlyphArrowDown /> <GlyphGlobe />
<PixelGlyph kind="doc" scale={2} />   // 7x7: globe doc flag mail prompt spark window grid power
<HoloGlyphTile kind="flag" />          // chrome key + indigo pictogram (menu rows)
```
These are all `aria-hidden` (except `HoloStar` with a `title`), and twinkle
stops under `prefers-reduced-motion`.

---

## 4. The Spare kit (`apps/spare/SpareUi.tsx`, `styles.ts`)

Shared pieces for the Spare apps, built on Holo:

| export | what it renders |
|---|---|
| `AppCanvas` | `HoloWindowBody` |
| `MutedWell` | Pastel sunken panel (cream → lilac-white, `BEVEL_WELL`, halftone drifting in from the corner) with a periwinkle sparkle and Space Mono `INK.muted` copy. `center` stacks the sparkle over the copy and twinkles it (loading states). Children must use `INK.*` colours, which read on it |
| `Hint` / `Hint warn` | Space Mono, `INK.muted` / `INK.warn` + pixel warn icon |
| `AddrLink` / `TxLink` | Space Mono, `INK.link`, dotted underline, Blockscout |
| `DeployingNotice` | `HoloCard` "SPARE Contracts" (+ indeterminate progress while checking) |
| `ConnectPrompt` | `HoloCard` "Wallet" · `HoloStar` + "CONNECT A WALLET" + primary button + `WalletPicker variant="holo"` |
| `SpendingWalletNotice` | `HoloCard` "Spending Wallet" / READ-ONLY (pink bar) |
| `TxStatus` | pastel status strip: solid badge (pulsing while pending), step text, `view tx ↗`, OK, indeterminate bar while busy |
| `ROW` / `STACK` | flex row / column layout atoms |
| `KEY_LABEL` / `HINT` / `NOTE` | Jersey 10 / Space Mono with **ink-context colours**, so they read on cards *and* in screens |
| `Tone` | `up` / `down` / `warn` / `info` / `mono` / `muted`: the status tone an app derives before mapping it to a `HoloTone` |

---

## 5. Shared chrome

- `AppWindow` has a pastel bevelled frame and a holo title bar with a white
  Jersey 10 title and sparkle. The min/max/close keys (`.holo-winbtn`, close is
  pink) use pixel glyphs. The menu bar is cream and the status bar has a
  green "online" pip. The content ground is deep indigo, so apps that paint
  nothing stay legible.
- `Taskbar` is a lilac bar with an indigo edge. It has a chrome Start key with
  the Spare mark, pastel window keys, `ZoomControl` (hidden on phones), the
  chrome language key
  (`LanguageToggle variant="tray"`, globe only on phones) and `SystemTray`
  (pastel sunken pills in Space Mono: Chainlink ETH price, `$SPARE SOON`,
  wallet, clock). The Spare-mark mascot stands on the bar's top edge left of
  the zoom control, at z 15, so every window (z 21–90) covers it; phones hide
  it.
- `LanguageToggle variant="bar"` sits in every public page's title bar
  (PublicShell, LivePageFrame, HoloPageWindow), menu dropping down.
- `LanguageToggle` on the BIOS and login is the floating chrome pill
  (bottom-centre); it hides itself while the desktop taskbar or a title-bar key
  is mounted.
- `StartMenu` has a sky sidebar ("SPARE", star and sparkle), pixel section
  heads (Programs · Markets · Resources · Web · System) and `.holo-menu-item`
  rows with a holo hover. Web rows (from `lib/publicRoutes`) use
  `HoloGlyphTile` pictograms; the Spare essentials show first and the rest sit
  behind "More pages". It is capped below the live ticker and scrolls inside
  itself.
- `WindowManager` fits each window to the viewport when it opens and again on
  browser resize or desktop zoom (never under the ticker or taskbar), and keeps
  window z-order between 21 and 90.
- `Win98Dialog` is a holo dialog over an indigo dither scrim with Holo
  buttons. The first-run `SpareWelcome` dialog uses it, with the `$SPARE SOON`
  chip as a deep-indigo screen.
- Desktop icon labels are white Jersey 10 with a pixel indigo outline, and
  hover shows a pill.
- The ticker (`LiveTickerBanner`) is a deep-indigo band: a chrome chip (LIVE /
  MARKET CLOSED) and the Spare stock tape from `lib/stockBoard`.
- Scrollbars inside windows, menus and `[data-holo-scroll]` are pastel Win98.
