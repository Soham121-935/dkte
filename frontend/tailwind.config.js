/** @type {import('tailwindcss').Config} */
const withAlpha = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
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
        spore: withAlpha('--c-spore'),
        'spore-ink': withAlpha('--c-spore-ink'),
        'cap-ink': withAlpha('--c-cap-ink'),
      },
      fontFamily: {
        sans: ['Figtree Variable', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        display: ['Young Serif', 'Iowan Old Style', 'Palatino Linotype', 'Georgia', 'serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(18 32 28 / 0.06), 0 0 0 1px rgb(var(--c-line) / 1)',
        pop: '0 12px 32px -8px rgb(18 32 28 / 0.22), 0 0 0 1px rgb(var(--c-line-strong) / 1)',
      },
      keyframes: {
        'fade-in': { from: { opacity: 0, transform: 'translateY(2px)' }, to: { opacity: 1, transform: 'none' } },
        pulse2: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.45 } },
        glow: {
          '0%': { boxShadow: '0 0 0 0 rgb(var(--c-spore) / 0.55), 0 10px 30px rgb(18 32 28 / 0.18)' },
          '70%, 100%': { boxShadow: '0 0 0 20px rgb(var(--c-spore) / 0), 0 10px 30px rgb(18 32 28 / 0.18)' },
        },
        'pop-in': { from: { opacity: 0, transform: 'translateY(24px) scale(0.96)' }, to: { opacity: 1, transform: 'none' } },
        blink: { '50%': { opacity: 0.25 } },
      },
      animation: {
        'fade-in': 'fade-in 180ms ease-out',
        pulse2: 'pulse2 1.6s ease-in-out infinite',
        glow: 'glow 3.4s ease-out infinite',
        'pop-in': 'pop-in 220ms ease-out',
        'spin-slow': 'spin 1.1s linear infinite',
        blink: 'blink 1s infinite',
      },
    },
  },
  plugins: [],
};
