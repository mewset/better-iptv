/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Semantic colours backed by the CSS variables in src/index.css, so a
      // component says what a colour is *for* (bg-surface) instead of pairing
      // a literal with its dark twin (bg-white dark:bg-gray-800). The default
      // palette is untouched, so existing gray-* classes keep working and the
      // migration can happen a component at a time.
      colors: {
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        'surface-hover': 'rgb(var(--color-surface-hover) / <alpha-value>)',
        text: 'rgb(var(--color-text) / <alpha-value>)',
        'text-muted': 'rgb(var(--color-text-muted) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          hover: 'rgb(var(--color-accent-hover) / <alpha-value>)',
        },
      },
      // Type that scales with the viewport. The app is used on a TV as well as
      // a desktop monitor, and clamp() covers both ends continuously - no
      // separate "TV mode" to maintain. Not yet applied to components.
      fontSize: {
        'fluid-xs': 'clamp(0.75rem, 0.65rem + 0.3vw, 0.9rem)',
        'fluid-sm': 'clamp(0.875rem, 0.75rem + 0.4vw, 1.125rem)',
        'fluid-base': 'clamp(1rem, 0.85rem + 0.5vw, 1.375rem)',
        'fluid-lg': 'clamp(1.125rem, 0.95rem + 0.65vw, 1.625rem)',
        'fluid-xl': 'clamp(1.375rem, 1.1rem + 1vw, 2rem)',
        'fluid-2xl': 'clamp(1.75rem, 1.3rem + 1.5vw, 2.75rem)',
        'fluid-3xl': 'clamp(2.25rem, 1.6rem + 2.25vw, 3.75rem)',
      },
    },
  },
  plugins: [],
}
