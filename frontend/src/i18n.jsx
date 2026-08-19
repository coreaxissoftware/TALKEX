import { createContext, useContext, useState, useCallback, useEffect } from "react";

const STORAGE_KEY = "talkex_lang";
const DEFAULT_LANG = "en";

const I18nContext = createContext({ t: (k) => k, lang: DEFAULT_LANG, setLang: () => {} });

const LOCALES = {};

const LOCALE_LOADERS = {
  es: () => import('./locales/es.js'),
  fr: () => import('./locales/fr.js'),
  pt: () => import('./locales/pt.js'),
  ar: () => import('./locales/ar.js'),
  bn: () => import('./locales/bn.js'),
  ur: () => import('./locales/ur.js'),
  de: () => import('./locales/de.js'),
  ja: () => import('./locales/ja.js'),
  ko: () => import('./locales/ko.js'),
  zh: () => import('./locales/zh.js'),
  id: () => import('./locales/id.js'),
  tr: () => import('./locales/tr.js'),
};

export function registerLocale(code, strings) {
  LOCALES[code] = strings;
}

export function ensureLocaleLoaded(code) {
  if (code && !LOCALES[code] && LOCALE_LOADERS[code]) {
    LOCALE_LOADERS[code]();
  }
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(() => localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG);

  const setLang = useCallback((code) => {
    localStorage.setItem(STORAGE_KEY, code);
    if (!LOCALES[code] && LOCALE_LOADERS[code]) {
      LOCALE_LOADERS[code]().then(() => setLangState(code));
    } else {
      setLangState(code);
    }
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
    const rtl = LANGUAGES.find((l) => l.code === lang)?.rtl;
    document.documentElement.dir = rtl ? "rtl" : "ltr";
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
  { code: "es", label: "Spanish", nativeLabel: "Español" },
  { code: "fr", label: "French", nativeLabel: "Français" },
  { code: "pt", label: "Portuguese", nativeLabel: "Português" },
  { code: "de", label: "German", nativeLabel: "Deutsch" },
  { code: "ar", label: "Arabic", nativeLabel: "العربية", rtl: true },
  { code: "bn", label: "Bengali", nativeLabel: "বাংলা" },
  { code: "ur", label: "Urdu", nativeLabel: "اردو", rtl: true },
  { code: "ja", label: "Japanese", nativeLabel: "日本語" },
  { code: "ko", label: "Korean", nativeLabel: "한국어" },
  { code: "zh", label: "Chinese", nativeLabel: "中文" },
  { code: "id", label: "Indonesian", nativeLabel: "Bahasa Indonesia" },
  { code: "tr", label: "Turkish", nativeLabel: "Türkçe" },
];
