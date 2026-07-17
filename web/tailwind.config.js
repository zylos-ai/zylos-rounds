import animate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'media',
  content: ['./index.html', './talk.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Inter',
          '"SF Pro Text"',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"Noto Sans SC"',
          '"PingFang SC"',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        background: 'var(--bg)',
        foreground: 'var(--text)',
        card: { DEFAULT: 'var(--panel)', foreground: 'var(--text)' },
        popover: { DEFAULT: 'var(--panel)', foreground: 'var(--text)' },
        primary: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          foreground: '#ffffff',
          soft: 'var(--accent-soft)',
          line: 'var(--accent-line)',
        },
        secondary: { DEFAULT: 'var(--panel)', foreground: 'var(--text)' },
        muted: { DEFAULT: 'var(--hover)', foreground: 'var(--muted)' },
        accent: { DEFAULT: 'var(--hover)', foreground: 'var(--text)' },
        destructive: {
          DEFAULT: 'var(--danger)',
          hover: 'var(--danger-hover)',
          soft: 'var(--danger-soft)',
          foreground: '#ffffff',
        },
        success: {
          DEFAULT: 'var(--success)',
          soft: 'var(--success-soft)',
          line: 'var(--success-line)',
        },
        faint: 'var(--faint)',
        border: 'var(--line)',
        'border-strong': 'var(--line-strong)',
        input: 'var(--line-strong)',
        ring: 'var(--accent-line)',
      },
      borderRadius: {
        md: '8px',
        lg: '12px',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
      },
    },
  },
  plugins: [animate],
};
