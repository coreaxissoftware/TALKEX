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
  // South Asia
  { iso: "IN", dial: "+91", name: "India", len: 10 },
  { iso: "PK", dial: "+92", name: "Pakistan", len: 10 },
  { iso: "BD", dial: "+880", name: "Bangladesh", len: 10 },
  { iso: "LK", dial: "+94", name: "Sri Lanka", len: 9 },
  { iso: "NP", dial: "+977", name: "Nepal", len: 10 },
  { iso: "AF", dial: "+93", name: "Afghanistan", len: 9 },
  { iso: "MV", dial: "+960", name: "Maldives", len: 7 },
  // North America
  { iso: "US", dial: "+1", name: "United States", len: 10 },
  { iso: "CA", dial: "+1", name: "Canada", len: 10 },
  { iso: "MX", dial: "+52", name: "Mexico", len: 10 },
  // Europe
  { iso: "GB", dial: "+44", name: "United Kingdom", len: 10 },
  { iso: "DE", dial: "+49", name: "Germany", len: 11 },
  { iso: "FR", dial: "+33", name: "France", len: 9 },
  { iso: "IT", dial: "+39", name: "Italy", len: 10 },
  { iso: "ES", dial: "+34", name: "Spain", len: 9 },
  { iso: "PT", dial: "+351", name: "Portugal", len: 9 },
  { iso: "NL", dial: "+31", name: "Netherlands", len: 9 },
  { iso: "BE", dial: "+32", name: "Belgium", len: 9 },
  { iso: "CH", dial: "+41", name: "Switzerland", len: 9 },
  { iso: "AT", dial: "+43", name: "Austria", len: 10 },
  { iso: "SE", dial: "+46", name: "Sweden", len: 9 },
  { iso: "NO", dial: "+47", name: "Norway", len: 8 },
  { iso: "DK", dial: "+45", name: "Denmark", len: 8 },
  { iso: "FI", dial: "+358", name: "Finland", len: 10 },
  { iso: "PL", dial: "+48", name: "Poland", len: 9 },
  { iso: "IE", dial: "+353", name: "Ireland", len: 9 },
  { iso: "GR", dial: "+30", name: "Greece", len: 10 },
  { iso: "RO", dial: "+40", name: "Romania", len: 9 },
  { iso: "CZ", dial: "+420", name: "Czech Republic", len: 9 },
  { iso: "HU", dial: "+36", name: "Hungary", len: 9 },
  { iso: "UA", dial: "+380", name: "Ukraine", len: 9 },
  { iso: "RU", dial: "+7", name: "Russia", len: 10 },
  { iso: "TR", dial: "+90", name: "Turkey", len: 10 },
  // Middle East
  { iso: "AE", dial: "+971", name: "UAE", len: 9 },
  { iso: "SA", dial: "+966", name: "Saudi Arabia", len: 9 },
  { iso: "QA", dial: "+974", name: "Qatar", len: 8 },
  { iso: "KW", dial: "+965", name: "Kuwait", len: 8 },
  { iso: "BH", dial: "+973", name: "Bahrain", len: 8 },
  { iso: "OM", dial: "+968", name: "Oman", len: 8 },
  { iso: "JO", dial: "+962", name: "Jordan", len: 9 },
  { iso: "LB", dial: "+961", name: "Lebanon", len: 8 },
  { iso: "IQ", dial: "+964", name: "Iraq", len: 10 },
  { iso: "IR", dial: "+98", name: "Iran", len: 10 },
  { iso: "IL", dial: "+972", name: "Israel", len: 9 },
  { iso: "EG", dial: "+20", name: "Egypt", len: 10 },
  // Africa
  { iso: "ZA", dial: "+27", name: "South Africa", len: 9 },
  { iso: "NG", dial: "+234", name: "Nigeria", len: 10 },
  { iso: "KE", dial: "+254", name: "Kenya", len: 9 },
  { iso: "GH", dial: "+233", name: "Ghana", len: 9 },
  { iso: "TZ", dial: "+255", name: "Tanzania", len: 9 },
  { iso: "ET", dial: "+251", name: "Ethiopia", len: 9 },
  { iso: "UG", dial: "+256", name: "Uganda", len: 9 },
  { iso: "MA", dial: "+212", name: "Morocco", len: 9 },
  { iso: "DZ", dial: "+213", name: "Algeria", len: 9 },
  { iso: "TN", dial: "+216", name: "Tunisia", len: 8 },
  // East & Southeast Asia
  { iso: "CN", dial: "+86", name: "China", len: 11 },
  { iso: "JP", dial: "+81", name: "Japan", len: 10 },
  { iso: "KR", dial: "+82", name: "South Korea", len: 10 },
  { iso: "SG", dial: "+65", name: "Singapore", len: 8 },
  { iso: "MY", dial: "+60", name: "Malaysia", len: 10 },
  { iso: "ID", dial: "+62", name: "Indonesia", len: 11 },
  { iso: "PH", dial: "+63", name: "Philippines", len: 10 },
  { iso: "TH", dial: "+66", name: "Thailand", len: 9 },
  { iso: "VN", dial: "+84", name: "Vietnam", len: 9 },
  { iso: "MM", dial: "+95", name: "Myanmar", len: 9 },
  { iso: "KH", dial: "+855", name: "Cambodia", len: 9 },
  { iso: "TW", dial: "+886", name: "Taiwan", len: 9 },
  { iso: "HK", dial: "+852", name: "Hong Kong", len: 8 },
  // Oceania
  { iso: "AU", dial: "+61", name: "Australia", len: 9 },
  { iso: "NZ", dial: "+64", name: "New Zealand", len: 9 },
  // South America
  { iso: "BR", dial: "+55", name: "Brazil", len: 11 },
  { iso: "AR", dial: "+54", name: "Argentina", len: 10 },
  { iso: "CO", dial: "+57", name: "Colombia", len: 10 },
  { iso: "CL", dial: "+56", name: "Chile", len: 9 },
  { iso: "PE", dial: "+51", name: "Peru", len: 9 },
  { iso: "VE", dial: "+58", name: "Venezuela", len: 10 },
  { iso: "EC", dial: "+593", name: "Ecuador", len: 9 },
  { iso: "UY", dial: "+598", name: "Uruguay", len: 8 },
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
