/**
 * Theme / Skin definitions for the UI.
 *
 * Each theme overrides the CSS custom properties defined in :root across all HTML files.
 * The `default` theme is null (no overrides — uses the original hardcoded values).
 */

export interface ThemePalette {
  'bg-primary': string;
  'bg-secondary': string;
  'bg-tertiary': string;
  'border': string;
  'text-primary': string;
  'text-secondary': string;
  'text-muted': string;
  'accent': string;
  'accent-secondary': string;
  'accent-hover': string;
  'error': string;
  'success': string;
  'warning': string;
  'orange': string;
  'user-bubble': string;
  'user-bubble-solid': string;
  'assistant-bubble': string;
}

export interface ThemeDefinition {
  id: string;
  name: string;
  palette: ThemePalette | null; // null = default (no overrides)
}

export const THEMES: Record<string, ThemeDefinition> = {
  default: {
    id: 'default',
    name: 'Default',
    palette: null,
  },

  light: {
    id: 'light',
    name: 'Daylight',
    palette: {
      'bg-primary': '#f5f5f7',
      'bg-secondary': '#ffffff',
      'bg-tertiary': '#e8e8ed',
      'border': '#d1d1d6',
      'text-primary': '#1d1d1f',
      'text-secondary': '#6e6e73',
      'text-muted': '#aeaeb2',
      'accent': '#8b5cf6',
      'accent-secondary': '#d946ef',
      'accent-hover': '#7c3aed',
      'error': '#dc2626',
      'success': '#16a34a',
      'warning': '#d97706',
      'orange': '#ea580c',
      'user-bubble': 'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
      'user-bubble-solid': '#8b5cf6',
      'assistant-bubble': '#e8e8ed',
    },
  },

  emerald: {
    id: 'emerald',
    name: 'Emerald',
    palette: {
      'bg-primary': '#0d1117',
      'bg-secondary': '#161b22',
      'bg-tertiary': '#1c2333',
      'border': '#2d3748',
      'text-primary': '#e6edf3',
      'text-secondary': '#8b949e',
      'text-muted': '#6e7681',
      'accent': '#10b981',
      'accent-secondary': '#34d399',
      'accent-hover': '#6ee7b7',
      'error': '#f87171',
      'success': '#4ade80',
      'warning': '#fbbf24',
      'orange': '#fb923c',
      'user-bubble': 'linear-gradient(135deg, #10b981 0%, #34d399 100%)',
      'user-bubble-solid': '#10b981',
      'assistant-bubble': '#1c2333',
    },
  },

  sandstone: {
    id: 'sandstone',
    name: 'Sandstone',
    palette: {
      'bg-primary': '#1a1612',
      'bg-secondary': '#231f1a',
      'bg-tertiary': '#2d2721',
      'border': '#3d352d',
      'text-primary': '#f5ede4',
      'text-secondary': '#b8a99a',
      'text-muted': '#7a6e62',
      'accent': '#c2703e',
      'accent-secondary': '#d4956a',
      'accent-hover': '#d9845a',
      'error': '#e57373',
      'success': '#81c784',
      'warning': '#ffb74d',
      'orange': '#ff8a65',
      'user-bubble': 'linear-gradient(135deg, #c2703e 0%, #d4956a 100%)',
      'user-bubble-solid': '#c2703e',
      'assistant-bubble': '#2d2721',
    },
  },

  ocean: {
    id: 'ocean',
    name: 'Ocean',
    palette: {
      'bg-primary': '#0b1622',
      'bg-secondary': '#0f1d2e',
      'bg-tertiary': '#162a3e',
      'border': '#1e3a54',
      'text-primary': '#e8f1f8',
      'text-secondary': '#8badc4',
      'text-muted': '#5a7d96',
      'accent': '#0ea5e9',
      'accent-secondary': '#38bdf8',
      'accent-hover': '#7dd3fc',
      'error': '#f87171',
      'success': '#34d399',
      'warning': '#fbbf24',
      'orange': '#fb923c',
      'user-bubble': 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)',
      'user-bubble-solid': '#0ea5e9',
      'assistant-bubble': '#162a3e',
    },
  },

  rose: {
    id: 'rose',
    name: 'Ros\u00e9',
    palette: {
      'bg-primary': '#18101a',
      'bg-secondary': '#201622',
      'bg-tertiary': '#2c1f2e',
      'border': '#3e2d40',
      'text-primary': '#f5e8f0',
      'text-secondary': '#c4a0b8',
      'text-muted': '#8a6a7e',
      'accent': '#f472b6',
      'accent-secondary': '#f9a8d4',
      'accent-hover': '#fbcfe8',
      'error': '#fb7185',
      'success': '#86efac',
      'warning': '#fde68a',
      'orange': '#fdba74',
      'user-bubble': 'linear-gradient(135deg, #ec4899 0%, #f9a8d4 100%)',
      'user-bubble-solid': '#ec4899',
      'assistant-bubble': '#2c1f2e',
    },
  },

  nord: {
    id: 'nord',
    name: 'Nord',
    palette: {
      'bg-primary': '#2e3440',
      'bg-secondary': '#3b4252',
      'bg-tertiary': '#434c5e',
      'border': '#4c566a',
      'text-primary': '#eceff4',
      'text-secondary': '#d8dee9',
      'text-muted': '#7b88a1',
      'accent': '#88c0d0',
      'accent-secondary': '#81a1c1',
      'accent-hover': '#8fbcbb',
      'error': '#bf616a',
      'success': '#a3be8c',
      'warning': '#ebcb8b',
      'orange': '#d08770',
      'user-bubble': 'linear-gradient(135deg, #5e81ac 0%, #88c0d0 100%)',
      'user-bubble-solid': '#5e81ac',
      'assistant-bubble': '#434c5e',
    },
  },

  cyberpunk: {
    id: 'cyberpunk',
    name: 'Cyberpunk',
    palette: {
      'bg-primary': '#0a0a12',
      'bg-secondary': '#10101c',
      'bg-tertiary': '#1a1a2e',
      'border': '#2a2a44',
      'text-primary': '#eaf0ff',
      'text-secondary': '#9ba8c8',
      'text-muted': '#5c6688',
      'accent': '#00f0ff',
      'accent-secondary': '#e040fb',
      'accent-hover': '#76ffff',
      'error': '#ff5252',
      'success': '#69f0ae',
      'warning': '#ffab40',
      'orange': '#ff6e40',
      'user-bubble': 'linear-gradient(135deg, #e040fb 0%, #00f0ff 100%)',
      'user-bubble-solid': '#e040fb',
      'assistant-bubble': '#1a1a2e',
    },
  },

  tavern: {
    id: 'tavern',
    name: 'Tavern',
    palette: {
      'bg-primary': '#140e08',
      'bg-secondary': '#1e150c',
      'bg-tertiary': '#2a1e12',
      'border': '#3e2e1a',
      'text-primary': '#f0dfc0',
      'text-secondary': '#c4a06a',
      'text-muted': '#8a6d42',
      'accent': '#d4a030',
      'accent-secondary': '#e8c05a',
      'accent-hover': '#f0d070',
      'error': '#c0392b',
      'success': '#6b8e23',
      'warning': '#d4a030',
      'orange': '#cc6600',
      'user-bubble': 'linear-gradient(135deg, #b8860b 0%, #d4a030 100%)',
      'user-bubble-solid': '#b8860b',
      'assistant-bubble': '#2a1e12',
    },
  },
};
