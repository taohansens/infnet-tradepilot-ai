'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import PositionCalculatorDrawer from './PositionCalculatorDrawer';

/**
 * Provedor global de Tema (Dracula padrão / Tema Claro, inspirado no Taometria)
 * e atalho global de teclado `Alt+C` / `Ctrl+K` para a Calculadora Passiva de Posição (`SPEC-22`).
 *
 * @spec SPEC-18
 * @spec SPEC-22
 * @rf RF-M7-2
 * @rnf RNF-23
 * @rnf RNF-24
 * @rnf RNF-28
 */

export type AppTheme = 'dracula' | 'light';

interface ThemeContextValue {
  theme: AppTheme;
  toggleTheme: () => void;
  calculatorOpen: boolean;
  openCalculator: () => void;
  closeCalculator: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dracula',
  toggleTheme: () => {},
  calculatorOpen: false,
  openCalculator: () => {},
  closeCalculator: () => {},
});

const THEME_STORAGE_KEY = 'tradepilot_theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<AppTheme>('dracula');
  const [calculatorOpen, setCalculatorOpen] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dracula') {
      setTheme(stored);
    }
  }, []);

  useEffect(() => {
    const html = document.documentElement;
    html.dataset.theme = theme;
    if (theme === 'dracula') {
      html.classList.add('dark');
    } else {
      html.classList.remove('dark');
    }
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Atalho global Alt+C ou Ctrl+K para invocar a Calculadora Passiva de Posição (SPEC-22)
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isCtrlK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
      const isAltC = event.altKey && event.key.toLowerCase() === 'c';
      if (isCtrlK || isAltC) {
        event.preventDefault();
        setCalculatorOpen((prev) => !prev);
      } else if (event.key === 'Escape') {
        setCalculatorOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'dracula' ? 'light' : 'dracula'));
  }, []);

  const openCalculator = useCallback(() => setCalculatorOpen(true), []);
  const closeCalculator = useCallback(() => setCalculatorOpen(false), []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        toggleTheme,
        calculatorOpen,
        openCalculator,
        closeCalculator,
      }}
    >
      {children}
      <PositionCalculatorDrawer
        open={calculatorOpen}
        onClose={closeCalculator}
      />
    </ThemeContext.Provider>
  );
}

export function useAppTheme() {
  return useContext(ThemeContext);
}
