import { createContext, useContext, useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "talkex_lang";
const DEFAULT_LANG = "en";

const I18nContext = createContext({ t: (k) => k, lang: DEFAULT_LANG, setLang: () => {} });

const LOCALES = {};

export function registerLocale(code, strings) {
  LOCALES[code] = strings;
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG);

  const setLang = useCallback((code) => {
    localStorage.setItem(STORAGE_KEY, code);
    setLangState(code);
  }, []);

  const t = useCallback((key, replacements) => {
    const strings = LOCALES[lang] || LOCALES[DEFAULT_LANG] || {};
    let val = strings[key] ?? LOCALES[DEFAULT_LANG]?.[key] ?? key;
    if (replacements) {
      for (const [k, v] of Object.entries(replacements)) {
        val = val.replace(new RegExp(`\\{${k}\\}`, "g"), v);
      }
    }
    return val;
  }, [lang]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <I18nContext.Provider value={{ t, lang, setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useT() {
  return useContext(I18nContext);
}

export const LANGUAGES = [
  { code: "en", label: "English", nativeLabel: "English" },
  { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
];
