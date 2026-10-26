import type { Config } from 'tailwindcss';

/**
 * Configuração Tailwind com modo escuro padrão e paleta semântica do TradePilot AI.
 *
 * @spec SPEC-18
 * @rnf RNF-23
 * @rnf RNF-24
 */
const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          950: '#090d16',
          900: '#111827',
          800: '#1f2937',
        },
        profit: '#10b981',
        loss: '#ef4444',
        fiscal: '#f59e0b',
      },
    },
  },
  plugins: [],
};

export default config;
