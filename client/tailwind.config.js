export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          '"Liberation Mono"',
          '"Courier New"',
          'monospace'
        ]
      },
      colors: {
        amber: {
          50: 'rgb(var(--amber-50) / <alpha-value>)',
          100: 'rgb(var(--amber-100) / <alpha-value>)',
          200: 'rgb(var(--amber-200) / <alpha-value>)',
          300: 'rgb(var(--amber-300) / <alpha-value>)',
          400: 'rgb(var(--amber-400) / <alpha-value>)',
          500: 'rgb(var(--amber-500) / <alpha-value>)',
          600: 'rgb(var(--amber-600) / <alpha-value>)',
          700: 'rgb(var(--amber-700) / <alpha-value>)',
          800: 'rgb(var(--amber-800) / <alpha-value>)',
          900: 'rgb(var(--amber-900) / <alpha-value>)',
          950: 'rgb(var(--amber-950) / <alpha-value>)'
        },
        orange: {
          50: 'rgb(var(--orange-50) / <alpha-value>)',
          100: 'rgb(var(--orange-100) / <alpha-value>)',
          200: 'rgb(var(--orange-200) / <alpha-value>)',
          300: 'rgb(var(--orange-300) / <alpha-value>)',
          400: 'rgb(var(--orange-400) / <alpha-value>)',
          500: 'rgb(var(--orange-500) / <alpha-value>)',
          600: 'rgb(var(--orange-600) / <alpha-value>)',
          700: 'rgb(var(--orange-700) / <alpha-value>)',
          800: 'rgb(var(--orange-800) / <alpha-value>)',
          900: 'rgb(var(--orange-900) / <alpha-value>)',
          950: 'rgb(var(--orange-950) / <alpha-value>)'
        },
        neon: {
          gold: 'rgb(var(--neon-gold-rgb) / <alpha-value>)',
          purple: 'rgb(var(--neon-purple-rgb) / <alpha-value>)',
          cyan: 'rgb(var(--neon-cyan-rgb) / <alpha-value>)',
          green: '#22c55e'
        }
      }
    }
  },
  plugins: [],
  darkMode: 'class'
};
