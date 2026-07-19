/**
 * Admin-SPA language context. Purely client-side: the viewer's choice is
 * persisted in localStorage (default guessed from the browser language) and
 * is independent of both the team default language and per-member languages.
 *
 * Convention: each page keeps its own { zh, en } dict next to the JSX and
 * selects with `useLangDict(DICT)`; only the language state is shared here.
 */
import { createContext, useContext, useState, useCallback } from 'react';

const STORAGE_KEY = 'rounds_admin_lang';

const initialLang = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* storage unavailable */ }
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
};

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(initialLang);
  const setLang = useCallback((l) => {
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* storage unavailable */ }
    setLangState(l);
  }, []);
  return (
    <I18nContext.Provider value={{ lang, setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export const useI18n = () => useContext(I18nContext);

/** Select a page-local { zh, en } dict by the current language. */
export function useLangDict(dict) {
  const { lang } = useI18n();
  return dict[lang] || dict.zh;
}
