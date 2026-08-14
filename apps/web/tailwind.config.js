/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        mono: ['"DM Mono"', 'monospace'],
      },
      colors: {
        surface: '#ffffff',
        'surface-2': '#f2f4f8',
        bg: '#f7f8fa',
        border: '#e4e7ed',
        'border-2': '#d0d5e0',
        txt: '#0f1117',
        'txt-2': '#4b5263',
        'txt-3': '#8891a4',
        accent: '#2563eb',
        'accent-2': '#16a34a',
        warn: '#d97706',
        danger: '#dc2626',
      },
      borderRadius: {
        sm: '6px',
        DEFAULT: '10px',
        lg: '14px',
      },
      boxShadow: {
        sm: '0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)',
        DEFAULT: '0 4px 12px rgba(0,0,0,.07), 0 1px 3px rgba(0,0,0,.04)',
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fadeUp .35s ease both',
      },
      maxWidth: {
        container: '1440px',
      },
    },
  },
  plugins: [],
};
