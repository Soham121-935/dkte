/** @type {import('tailwindcss').Config} */
const withAlpha = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: withAlpha('--c-canvas'),
        surface: withAlpha('--c-surface'),
        'surface-2': withAlpha('--c-surface-2'),
        'surface-3': withAlpha('--c-surface-3'),
        line: withAlpha('--c-line'),
        'line-strong': withAlpha('--c-line-strong'),
        ink: withAlpha('--c-ink'),
        'ink-2': withAlpha('--c-ink-2'),
        'ink-3': withAlpha('--c-ink-3'),
        brand: withAlpha('--c-brand'),
        'brand-2': withAlpha('--c-brand-2'),
        teal: withAlpha('--c-teal'),
        amber: withAlpha('--c-amber'),
        danger: withAlpha('--c-danger'),
        info: withAlpha('--c-info'),
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(var(--c-line) / 1)',
        pop: '0 12px 32px -8px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(var(--c-line-strong) / 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(2px)' }, to: { opacity: 1, transform: 'none' } },
        pulse2: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.45 } },
      },
      animation: { 'fade-in': 'fade-in 180ms ease-out', pulse2: 'pulse2 1.6s ease-in-out infinite' },
    },
  },
  plugins: [],
};
