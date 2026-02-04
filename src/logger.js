/**
 * Global logger module for thelaby-cipher
 *
 * This module provides a centralized logging mechanism that can be shared
 * across all cipher modules (page.js, labyrinth.js, image.js).
 *
 * Usage:
 *   In upload.js:
 *     const { setLogger } = require('./src/logger');
 *     setLogger(log);  // Pass the configured logger
 *
 *   In other modules:
 *     const { log } = require('./logger');
 *     log.verbose('message');
 */

// Default logger (no-op for most, error always outputs)
let _logger = {
    info: () => {},
    verbose: () => {},
    error: console.error,
    section: () => {},
    progress: () => {},
    item: () => {},
    subitem: () => {},
    success: () => {},
    fail: console.error
};

/**
 * Set the global logger instance
 * @param {Object} logger - Logger object with info, verbose, error, etc. methods
 */
function setLogger(logger) {
    _logger = logger;
}

/**
 * Get the current logger instance
 * Wrapped in a Proxy to allow dynamic access after setLogger() is called
 */
const log = new Proxy({}, {
    get(target, prop) {
        if (_logger && typeof _logger[prop] === 'function') {
            return _logger[prop];
        }
        // Fallback for unknown methods
        return () => {};
    }
});

module.exports = {
    setLogger,
    log
};
