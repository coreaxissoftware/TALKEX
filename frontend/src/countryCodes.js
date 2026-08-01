/**
 * Shared between every screen that collects a phone number (login, phone
 * change in Settings, contacts) so the calling code and the digit-count cap
 * stay in exactly one place instead of drifting apart across screens.
 *
 * A short, curated list rather than all ~195 countries — covers the
 * audience this app actually has today. India first since that's who
 * DLT/MSG91 delivery is registered for.
 *
 * `len` is the expected local-number length for that country — used to cap
 * what can be typed so the field can't grow into an obviously-wrong number.
 */
export const COUNTRY_CODES = [
  { iso: "IN", dial: "+91", name: "India", len: 10 },
  { iso: "US", dial: "+1", name: "United States", len: 10 },
  { iso: "GB", dial: "+44", name: "United Kingdom", len: 10 },
  { iso: "AE", dial: "+971", name: "UAE", len: 9 },
  { iso: "SA", dial: "+966", name: "Saudi Arabia", len: 9 },
  { iso: "SG", dial: "+65", name: "Singapore", len: 8 },
  { iso: "AU", dial: "+61", name: "Australia", len: 9 },
  { iso: "CA", dial: "+1", name: "Canada", len: 10 },
  { iso: "DE", dial: "+49", name: "Germany", len: 11 },
  { iso: "FR", dial: "+33", name: "France", len: 9 },
  { iso: "NP", dial: "+977", name: "Nepal", len: 10 },
  { iso: "BD", dial: "+880", name: "Bangladesh", len: 10 },
  { iso: "PK", dial: "+92", name: "Pakistan", len: 10 },
  { iso: "LK", dial: "+94", name: "Sri Lanka", len: 9 },
];

// A natural-looking example number ("9876543210") rather than a single
// digit repeated to fill the length — used as every phone field's
// placeholder so it reads like a real number, not a mechanically padded one.
const SAMPLE_DIGITS = "98765432109876543210";
export function samplePlaceholder(len) {
  return SAMPLE_DIGITS.slice(0, len);
}

// Regional-indicator Unicode trick: each letter A-Z has a matching
// "regional indicator symbol" codepoint: two of them next to each other
// render as that country's flag in every modern OS/browser, no image
// asset or icon font needed.
export function flagFor(iso) {
  return [...iso.toUpperCase()].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join("");
}

/** Splits a full "+91XXXXXXXXXX"-style number back into {country, local} for
 * pre-filling the picker when editing an existing number. Falls back to
 * India + the raw digits if nothing matches (e.g. a number saved before
 * this picker existed, with no recognizable dial code prefix). */
export function splitPhone(fullPhone) {
  const digits = (fullPhone || "").replace(/\D/g, "");
  const match = COUNTRY_CODES
    .filter((c) => digits.startsWith(c.dial.slice(1)))
    .sort((a, b) => b.dial.length - a.dial.length)[0];
  if (!match) return { country: COUNTRY_CODES[0], local: digits.slice(-10) };
  return { country: match, local: digits.slice(match.dial.length - 1) };
}
