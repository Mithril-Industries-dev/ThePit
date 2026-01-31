/**
 * Random name generator for The Pit agents
 * Generates unique, memorable names for AI agents
 */

const adjectives = [
  // Power/Strength
  'Iron', 'Steel', 'Titanium', 'Diamond', 'Obsidian', 'Granite', 'Platinum',
  // Speed/Agility
  'Swift', 'Quick', 'Rapid', 'Flash', 'Nimble', 'Agile', 'Blazing',
  // Intelligence
  'Sharp', 'Keen', 'Bright', 'Clever', 'Wise', 'Cunning', 'Shrewd',
  // Stealth/Mystery
  'Shadow', 'Silent', 'Ghost', 'Phantom', 'Stealth', 'Cryptic', 'Enigma',
  // Nature/Elements
  'Storm', 'Thunder', 'Frost', 'Ember', 'Solar', 'Lunar', 'Cosmic',
  // Color
  'Crimson', 'Azure', 'Onyx', 'Silver', 'Golden', 'Jade', 'Cobalt',
  // Attitude
  'Bold', 'Fierce', 'Brave', 'Rogue', 'Noble', 'Savage', 'Apex',
  // Tech
  'Cyber', 'Quantum', 'Digital', 'Binary', 'Neural', 'Atomic', 'Vector',
  // Misc
  'Prime', 'Ultra', 'Omega', 'Alpha', 'Zero', 'Nexus', 'Void'
];

const nouns = [
  // Animals
  'Wolf', 'Hawk', 'Viper', 'Panther', 'Falcon', 'Cobra', 'Raven',
  'Phoenix', 'Dragon', 'Tiger', 'Lynx', 'Mantis', 'Scorpion', 'Shark',
  // Roles
  'Hunter', 'Seeker', 'Walker', 'Runner', 'Striker', 'Watcher', 'Guardian',
  'Sentinel', 'Trader', 'Dealer', 'Broker', 'Agent', 'Operator', 'Maven',
  // Objects
  'Blade', 'Arrow', 'Hammer', 'Shield', 'Spear', 'Dagger', 'Saber',
  // Tech
  'Core', 'Node', 'Pulse', 'Circuit', 'Matrix', 'Proxy', 'Daemon',
  'Bot', 'Synth', 'Mech', 'Droid', 'Unit', 'System', 'Engine',
  // Abstract
  'Mind', 'Spirit', 'Force', 'Echo', 'Spark', 'Edge', 'Flux',
  // Misc
  'Ace', 'Sage', 'Scout', 'Ghost', 'Wraith', 'Specter', 'Cipher'
];

/**
 * Generate a random integer between min and max (inclusive)
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pick a random element from an array
 */
function randomPick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}

/**
 * Generate a random agent name
 * Format: Adjective + Noun + optional number suffix
 * @param {boolean} withNumber - Whether to append a random number
 * @returns {string} - Generated name
 */
function generateName(withNumber = false) {
  const adjective = randomPick(adjectives);
  const noun = randomPick(nouns);

  if (withNumber) {
    const num = randomInt(1, 999);
    return `${adjective}${noun}${num}`;
  }

  return `${adjective}${noun}`;
}

/**
 * Generate a unique name by checking against existing names
 * @param {Function} checkExists - Async function that returns true if name exists
 * @param {number} maxAttempts - Maximum attempts before adding numbers
 * @returns {string} - Unique generated name
 */
function generateUniqueName(checkExists, maxAttempts = 5) {
  // First try without numbers
  for (let i = 0; i < maxAttempts; i++) {
    const name = generateName(false);
    if (!checkExists(name)) {
      return name;
    }
  }

  // If all attempts failed, add numbers to ensure uniqueness
  for (let i = 0; i < 100; i++) {
    const name = generateName(true);
    if (!checkExists(name)) {
      return name;
    }
  }

  // Last resort: use timestamp
  const adjective = randomPick(adjectives);
  const noun = randomPick(nouns);
  return `${adjective}${noun}${Date.now().toString(36)}`;
}

/**
 * Get the total number of possible name combinations
 * @returns {number}
 */
function getTotalCombinations() {
  return adjectives.length * nouns.length;
}

module.exports = {
  generateName,
  generateUniqueName,
  getTotalCombinations,
  adjectives,
  nouns
};
