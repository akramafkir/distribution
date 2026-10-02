/** @type {import('tailwindcss').Config} */

const token = (name) => `rgb(var(--yf-${name}-rgb) / <alpha-value>)`;
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        yf: {
          primary: token('primary'),
          green: token('green'),
          red: token('red'),
          orange: token('orange'),
          tint: token('tint'),
        },
        neutral: Object.fromEntries(STEPS.map((s) => [s, token(`neutral-${s}`)])),
      },
      minHeight: {
        touch: '2.75rem',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Noto Sans', 'Noto Naskh Arabic', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
