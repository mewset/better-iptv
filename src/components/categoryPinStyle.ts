// Colour classes for the pin on a category chip. They live here, as literal class strings, so
// Tailwind compiles them and src/test/styles/categoryPinContrast.test.ts measures exactly these
// against the chip: every state clears 3:1 in both themes, and the faint pin at rest uses the
// lowest opacity (in steps of 5 %) that does. Change an opacity here and that test re-checks it.

/** Unpinned pin at rest, on an unselected chip */
export const PIN_REST = 'text-text-muted/70 dark:text-text-muted/55';
/** Unpinned pin at rest, on the selected (inverted) chip; same opacities as PIN_REST */
export const PIN_REST_ON_SELECTED = 'text-bg/70 dark:text-bg/55';
/** Pinned pin, on an unselected chip: filled, in the theme's accent text colour */
export const PIN_PINNED = 'fill-current text-accent-text';
/** Pinned pin, on the selected chip: the accent that contrasts with an inverted surface */
export const PIN_PINNED_ON_SELECTED = 'fill-current text-accent-text-inverse';
/**
 * Hovering a pin shows the pinned colour. Tailwind orders `dark:` after `hover:`, so the dark rest
 * colour would win over a plain `hover:` one; each hover class has its `dark:hover:` twin.
 */
export const PIN_HOVER = 'hover:text-accent-text dark:hover:text-accent-text';
export const PIN_HOVER_ON_SELECTED =
  'hover:text-accent-text-inverse dark:hover:text-accent-text-inverse';
