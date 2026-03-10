/**
 * Normalize Argentine phone numbers to a consistent format: 54 + area code + number
 * (without the mobile "9" prefix).
 *
 * Supported inputs:
 *   +54 9 11 1234-5678   -> 541112345678
 *   +54 11 1234 5678     -> 541112345678
 *   54 9 11 12345678     -> 541112345678
 *   011 15 12345678      -> 541112345678
 *   011 12345678         -> 541112345678
 *   11 12345678          -> 541112345678
 *   15 12345678          -> 541112345678
 */

function normalizePhone(phone) {
  if (!phone) return null;

  // Strip everything that is not a digit
  let digits = String(phone).replace(/\D/g, '');

  if (!digits || digits.length < 8) return null;

  // Remove leading country code "54"
  if (digits.startsWith('54')) {
    digits = digits.slice(2);
  }

  // Remove mobile indicator "9" that sits right after country code
  // At this point digits could start with 9 + area code (e.g. 91112345678)
  // Area codes in Argentina are 2-4 digits; Buenos Aires is "11".
  // The "9" is only a mobile routing prefix and must be stripped.
  if (digits.startsWith('9') && digits.length >= 11) {
    digits = digits.slice(1);
  }

  // Remove trunk prefix "0" used in local dialing (e.g. 011...)
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  // Remove "15" prefix (local mobile prefix used colloquially)
  // "15" only applies when it appears before the subscriber number,
  // i.e. the remaining digits are area code(2-4) + 15 + subscriber(8 digits total expected).
  // Common shorthand: "15 1234 5678" meaning Buenos Aires mobile.
  // If digits is exactly "15..." with 10 digits, treat 15 as the prefix for BA.
  if (digits.startsWith('15') && digits.length === 10) {
    // 15 + 8-digit subscriber -> assume Buenos Aires (area code 11)
    digits = '11' + digits.slice(2);
  }

  // Also handle area code + 15 + number (e.g. 11 15 12345678 -> 11 12345678)
  // Area code 11 is 2 digits; others can be 3-4 digits.
  // We look for "15" right after common area code lengths.
  const areaCodeLengths = [2, 3, 4];
  for (const len of areaCodeLengths) {
    const areaCode = digits.slice(0, len);
    const rest = digits.slice(len);
    if (rest.startsWith('15') && (digits.length - 2) === 10) {
      digits = areaCode + rest.slice(2);
      break;
    }
  }

  // At this point we expect 10 digits: area code + subscriber number
  if (digits.length !== 10) return null;

  return '54' + digits;
}

module.exports = { normalizePhone };
