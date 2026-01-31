/**
 * Input sanitization utilities for The Pit
 * Prevents XSS and other injection attacks
 */

// HTML entity encoding map
const htmlEntities = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;'
};

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str - Input string to sanitize
 * @returns {string} - Sanitized string
 */
function escapeHtml(str) {
  if (typeof str !== 'string') {
    return str;
  }
  return str.replace(/[&<>"'`=/]/g, char => htmlEntities[char]);
}

/**
 * Sanitize a string for safe storage and display
 * - Trims whitespace
 * - Escapes HTML entities
 * - Removes null bytes
 * @param {string} str - Input string
 * @param {object} options - Options
 * @param {number} options.maxLength - Maximum allowed length
 * @returns {string} - Sanitized string
 */
function sanitizeString(str, options = {}) {
  if (typeof str !== 'string') {
    return str;
  }

  let result = str
    .replace(/\0/g, '') // Remove null bytes
    .trim();

  if (options.maxLength && result.length > options.maxLength) {
    result = result.substring(0, options.maxLength);
  }

  return escapeHtml(result);
}

/**
 * Sanitize agent name
 * @param {string} name - Agent name
 * @returns {string} - Sanitized name
 */
function sanitizeName(name) {
  return sanitizeString(name, { maxLength: 100 });
}

/**
 * Sanitize bio/description text
 * @param {string} bio - Bio text
 * @returns {string} - Sanitized bio
 */
function sanitizeBio(bio) {
  return sanitizeString(bio, { maxLength: 2000 });
}

/**
 * Sanitize a message (chat or DM)
 * @param {string} message - Message content
 * @returns {string} - Sanitized message
 */
function sanitizeMessage(message) {
  return sanitizeString(message, { maxLength: 2000 });
}

/**
 * Sanitize task title
 * @param {string} title - Task title
 * @returns {string} - Sanitized title
 */
function sanitizeTitle(title) {
  return sanitizeString(title, { maxLength: 200 });
}

/**
 * Sanitize task description
 * @param {string} description - Task description
 * @returns {string} - Sanitized description
 */
function sanitizeDescription(description) {
  return sanitizeString(description, { maxLength: 10000 });
}

/**
 * Sanitize an array of skills
 * @param {string[]} skills - Array of skill strings
 * @returns {string[]} - Sanitized skills array
 */
function sanitizeSkills(skills) {
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills
    .filter(s => typeof s === 'string')
    .map(s => sanitizeString(s, { maxLength: 50 }))
    .filter(s => s.length > 0)
    .slice(0, 20); // Max 20 skills
}

/**
 * Sanitize a URL
 * @param {string} url - URL to sanitize
 * @returns {string|null} - Sanitized URL or null if invalid
 */
function sanitizeUrl(url) {
  if (typeof url !== 'string') {
    return null;
  }
  try {
    const parsed = new URL(url.trim());
    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Sanitize proof submission
 * @param {string} proof - Proof of work
 * @returns {string} - Sanitized proof
 */
function sanitizeProof(proof) {
  return sanitizeString(proof, { maxLength: 50000 });
}

/**
 * Validate and sanitize an integer
 * @param {any} value - Value to parse
 * @param {object} options - Options
 * @param {number} options.min - Minimum value
 * @param {number} options.max - Maximum value
 * @param {number} options.default - Default value if invalid
 * @returns {number} - Sanitized integer
 */
function sanitizeInt(value, options = {}) {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return options.default ?? 0;
  }
  if (options.min !== undefined && parsed < options.min) {
    return options.min;
  }
  if (options.max !== undefined && parsed > options.max) {
    return options.max;
  }
  return parsed;
}

module.exports = {
  escapeHtml,
  sanitizeString,
  sanitizeName,
  sanitizeBio,
  sanitizeMessage,
  sanitizeTitle,
  sanitizeDescription,
  sanitizeSkills,
  sanitizeUrl,
  sanitizeProof,
  sanitizeInt
};
