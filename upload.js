/**
 * The Labyrinth Auto Upload Script
 *
 * Usage: node upload.js [options] <content-folder>
 * Example: node upload.js ./example
 *
 * Options:
 *   --show-browser    Show browser window (for debugging)
 *   --verbose         Show detailed logs
 *   --help            Show help message
 *
 * Reads config from <content-folder>/labyrinth.json
 * Reads credentials from <content-folder>/account.json
 * Creates labyrinth if labyrinth.meta doesn't exist
 * Uploads pages based on {page}.html files with matching {page}.json metadata
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// CLI Options
// ============================================================

/**
 * Parse command line arguments
 * @returns {{ contentFolder: string|null, showBrowser: boolean, verbose: boolean, quiet: boolean, help: boolean }}
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        contentFolder: null,
        showBrowser: false,
        verbose: false,
        quiet: false,
        help: false
    };

    for (const arg of args) {
        if (arg === '--show-browser') {
            options.showBrowser = true;
        } else if (arg === '--verbose') {
            options.verbose = true;
        } else if (arg === '--quiet' || arg === '-q') {
            options.quiet = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (!arg.startsWith('-')) {
            options.contentFolder = arg;
        }
    }

    return options;
}

/**
 * Show help message
 */
function showHelp() {
    console.log(`
사용법: node upload.js [옵션] <콘텐츠-폴더>

옵션:
  --show-browser    브라우저 창을 표시합니다 (디버깅용)
  --verbose         상세 로그를 출력합니다
  --quiet, -q       에러만 출력합니다
  --help, -h        도움말을 표시합니다

예시:
  node upload.js ./example
  node upload.js --show-browser ./my-labyrinth
  node upload.js --verbose ./my-labyrinth
`);
}

// Global options (set in main)
let OPTIONS = { verbose: false, quiet: false };

/**
 * Logging utilities
 */
const log = {
    // Always shown (unless quiet)
    info: (msg) => {
        if (!OPTIONS.quiet) console.log(msg);
    },
    // Always shown
    error: (msg) => console.error(msg),

    // Only shown in verbose mode
    verbose: (msg) => {
        if (OPTIONS.verbose && !OPTIONS.quiet) console.log(msg);
    },

    // Section headers (unless quiet)
    section: (step, total, msg) => {
        if (!OPTIONS.quiet) console.log(`[${step}/${total}] ${msg}`);
    },

    // Progress within a section (e.g., [3/10] 페이지)
    progress: (current, total, msg) => {
        if (!OPTIONS.quiet) console.log(`  [${current}/${total}] ${msg}`);
    },

    // Indented messages
    item: (msg) => {
        if (!OPTIONS.quiet) console.log(`  ${msg}`);
    },
    subitem: (msg) => {
        if (!OPTIONS.quiet) console.log(`    ${msg}`);
    },

    // Success/failure
    success: (msg) => {
        if (!OPTIONS.quiet) console.log(`  완료: ${msg}`);
    },
    fail: (msg) => console.error(`  실패: ${msg}`)
};

// ============================================================
// Retry Utility
// ============================================================

/**
 * Retry configuration
 */
const RETRY_CONFIG = {
    maxRetries: 3,
    delayMs: 1000,
    // Error patterns that indicate network/timeout issues worth retrying
    retryableErrors: [
        /timeout/i,
        /exceeded/i,
        /Waiting failed/i,
        /ECONNRESET/i,
        /ECONNREFUSED/i,
        /ETIMEDOUT/i,
        /net::/i,
        /Navigation failed/i,
        /Protocol error/i,
        /Target closed/i
    ]
};

/**
 * Check if an error is retryable (network/timeout related)
 * @param {Error} error
 * @returns {boolean}
 */
function isRetryableError(error) {
    const message = error.message || '';
    return RETRY_CONFIG.retryableErrors.some(pattern => pattern.test(message));
}

/**
 * Execute an async function with retry logic
 * @param {Function} fn - Async function to execute
 * @param {string} description - Description for logging
 * @param {number} [maxRetries] - Override max retries
 * @returns {Promise<any>}
 */
async function withRetry(fn, description, maxRetries = RETRY_CONFIG.maxRetries) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (!isRetryableError(error) || attempt === maxRetries) {
                throw error;
            }

            const delay = RETRY_CONFIG.delayMs * attempt;
            log.verbose(`  ${description} 실패 (${attempt}/${maxRetries}), ${delay}ms 후 재시도...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    throw lastError;
}

const { login, logout } = require('./src/login');
const { createLabyrinth, updateLabyrinth, computeLabyrinthHash, validateConfig } = require('./src/labyrinth');
const {
    navigateToCreatePage,
    navigateToEditPage,
    fillPageForm,
    addAnswer,
    submitPageForm,
    getPageList,
    setParentConnection,
    clearParentConnections,
    deletePage,
    setEditorContent
} = require('./src/page');
const {
    calculateChecksum,
    uploadImage
} = require('./src/image');
const { setLogger } = require('./src/logger');

/**
 * Load account credentials from account.json
 * @param {string} contentPath - Path to content folder
 * @returns {{ email: string, password: string }}
 */
function loadAccount(contentPath) {
    const accountPath = path.join(contentPath, 'account.json');
    if (!fs.existsSync(accountPath)) {
        log.error(`account.json 파일을 찾을 수 없습니다: ${accountPath}`);
        log.error('account.json 파일을 생성해주세요.');
        log.error('형식: { "email": "이메일", "password": "비밀번호" }');
        process.exit(1);
    }

    let account;
    try {
        account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));
    } catch (e) {
        log.error(`account.json 파일을 읽을 수 없습니다: ${e.message}`);
        log.error('JSON 형식이 올바른지 확인해주세요.');
        process.exit(1);
    }

    // Support both "email" and "id" fields
    const userId = account.email || account.id;
    if (!userId || !account.password) {
        log.error('account.json에 이메일과 비밀번호가 필요합니다.');
        log.error('형식: { "email": "이메일", "password": "비밀번호" }');
        process.exit(1);
    }

    return { email: userId, password: account.password };
}

/**
 * Find all page HTML files in content directory
 * @param {string} contentPath - Path to content directory
 * @returns {string[]} Array of page paths (relative to contentPath, without .html extension)
 */
function findPageHtmlFiles(contentPath) {
    const results = [];
    const excludeDirs = ['node_modules', 'lib', '.git', 'preview'];

    function scanDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (!excludeDirs.includes(item)) {
                    scanDir(fullPath);
                }
            } else if (item.endsWith('.html')) {
                const relativePath = path.relative(contentPath, fullPath).replace(/\\/g, '/').replace('.html', '');
                results.push(relativePath);
            }
        }
    }

    scanDir(contentPath);
    return results;
}

/**
 * Find all page JSON files in content directory
 * @param {string} contentPath - Path to content directory
 * @returns {string[]} Array of page paths (relative to contentPath, without .json extension)
 */
function findPageJsonFiles(contentPath) {
    const results = [];
    const excludeDirs = ['node_modules', 'lib', '.git', 'preview'];
    const excludeFiles = ['labyrinth.json', 'account.json'];

    function scanDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (!excludeDirs.includes(item)) {
                    scanDir(fullPath);
                }
            } else if (item.endsWith('.json') && !item.endsWith('.meta') && !excludeFiles.includes(item)) {
                const relativePath = path.relative(contentPath, fullPath).replace(/\\/g, '/').replace('.json', '');
                results.push(relativePath);
            }
        }
    }

    scanDir(contentPath);
    return results;
}

/**
 * Find all page meta files in content directory
 * @param {string} contentPath - Path to content directory
 * @returns {string[]} Array of page paths (relative to contentPath, without .meta extension)
 */
function findPageMetaFiles(contentPath) {
    const results = [];
    const excludeDirs = ['node_modules', 'lib', '.git', 'preview'];
    const excludeFiles = ['labyrinth.meta'];

    function scanDir(dir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                if (!excludeDirs.includes(item)) {
                    scanDir(fullPath);
                }
            } else if (item.endsWith('.meta') && !excludeFiles.includes(item)) {
                const relativePath = path.relative(contentPath, fullPath).replace(/\\/g, '/').replace('.meta', '');
                results.push(relativePath);
            }
        }
    }

    scanDir(contentPath);
    return results;
}

/**
 * Read page HTML content
 * @param {string} contentPath - Path to content directory
 * @param {string} pagePath - Page path relative to contentPath (without extension)
 * @returns {string|null} HTML content or null
 */
function readPageHtml(contentPath, pagePath) {
    const htmlPath = path.join(contentPath, `${pagePath}.html`);
    if (fs.existsSync(htmlPath)) {
        return fs.readFileSync(htmlPath, 'utf8');
    }
    return null;
}

/**
 * Read page JSON metadata
 * @param {string} contentPath - Path to content directory
 * @param {string} pagePath - Page path relative to contentPath (without extension)
 * @returns {object|null} Page JSON data or null
 */
function readPageJson(contentPath, pagePath) {
    const jsonPath = path.join(contentPath, `${pagePath}.json`);
    if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    return null;
}

/**
 * Read page meta file
 * @param {string} contentPath - Path to content directory
 * @param {string} pagePath - Page path relative to contentPath (without extension)
 * @returns {object} Page meta or empty object
 */
function readPageMeta(contentPath, pagePath) {
    const metaPath = path.join(contentPath, `${pagePath}.meta`);
    if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    return {};
}

/**
 * Write page meta file
 * @param {string} contentPath - Path to content directory
 * @param {string} pagePath - Page path relative to contentPath (without extension)
 * @param {object} meta - Meta data
 */
function writePageMeta(contentPath, pagePath, meta) {
    const metaPath = path.join(contentPath, `${pagePath}.meta`);
    const metaDir = path.dirname(metaPath);
    if (!fs.existsSync(metaDir)) {
        fs.mkdirSync(metaDir, { recursive: true });
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 4) + '\n', 'utf8');
}

/**
 * Delete page meta file
 * @param {string} contentPath - Path to content directory
 * @param {string} pagePath - Page path relative to contentPath (without extension)
 */
function deletePageMeta(contentPath, pagePath) {
    const metaPath = path.join(contentPath, `${pagePath}.meta`);
    if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
    }
}

/**
 * Compute hash for page content (HTML + JSON + image checksums for change detection)
 * @param {string} html - HTML content
 * @param {object} jsonData - JSON metadata
 * @param {string[]} imageChecksums - Array of image file checksums
 * @returns {string} MD5 hash
 */
function computePageHash(html, jsonData, imageChecksums = []) {
    const combined = JSON.stringify({ html, json: jsonData, images: imageChecksums.sort() });
    return crypto.createHash('md5').update(combined).digest('hex');
}

/**
 * Page JSON validation constraints
 */
const PAGE_VALIDATION = {
    title: { required: true, maxLength: 100 },
    background_color: { pattern: /^#[0-9a-fA-F]{6}$/ },
    header_display: { allowedValues: ['labyrinth_title', 'page_title', 'none'] }
};

/**
 * Validate page JSON structure
 * @param {string} pageName - Page name for error messages
 * @param {object} pageData - Page JSON data
 * @param {string[]} allPageNames - All page names (for answer.next validation)
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validatePageJson(pageName, pageData, allPageNames = []) {
    const errors = [];
    const warnings = [];

    // Required: title
    if (!pageData.title || pageData.title.trim() === '') {
        errors.push(`[${pageName}] title 필드가 필요합니다.`);
    } else if (pageData.title.length > PAGE_VALIDATION.title.maxLength) {
        errors.push(`[${pageName}] title이 ${PAGE_VALIDATION.title.maxLength}자를 초과합니다.`);
    }

    // background_color format
    if (pageData.background_color) {
        if (!PAGE_VALIDATION.background_color.pattern.test(pageData.background_color)) {
            errors.push(`[${pageName}] background_color 형식이 잘못되었습니다: ${pageData.background_color} (예: #000000)`);
        }
    }

    // header_display valid values
    if (pageData.header_display) {
        if (!PAGE_VALIDATION.header_display.allowedValues.includes(pageData.header_display)) {
            warnings.push(`[${pageName}] header_display 값이 잘못되었습니다: ${pageData.header_display} (허용: ${PAGE_VALIDATION.header_display.allowedValues.join(', ')})`);
        }
    }

    // Validate answers
    if (pageData.answers && Array.isArray(pageData.answers)) {
        for (let i = 0; i < pageData.answers.length; i++) {
            const ans = pageData.answers[i];

            // answer text required
            if (!ans.answer || ans.answer.trim() === '') {
                errors.push(`[${pageName}] answers[${i}].answer가 비어있습니다.`);
            }

            // next page reference validation
            if (ans.next) {
                if (!allPageNames.includes(ans.next)) {
                    errors.push(`[${pageName}] answers[${i}].next가 존재하지 않는 페이지를 참조합니다: "${ans.next}"`);
                }
            }
        }
    }

    // is_ending validation
    if (pageData.is_ending !== undefined && typeof pageData.is_ending !== 'boolean') {
        warnings.push(`[${pageName}] is_ending은 true/false여야 합니다.`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings
    };
}

/**
 * Validate all pages
 * @param {object} pages - { pageName: { html, json, meta } }
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateAllPages(pages) {
    const allErrors = [];
    const allWarnings = [];
    const allPageNames = Object.keys(pages);

    for (const [name, pageInfo] of Object.entries(pages)) {
        const result = validatePageJson(name, pageInfo.json, allPageNames);
        allErrors.push(...result.errors);
        allWarnings.push(...result.warnings);
    }

    return {
        valid: allErrors.length === 0,
        errors: allErrors,
        warnings: allWarnings
    };
}

/**
 * Find all local image references in HTML
 * @param {string} html - HTML content
 * @param {string} contentPath - Content path for resolving relative paths
 * @returns {string[]} Array of absolute image paths
 */
function findLocalImages(html, contentPath, rootPath = null) {
    const images = [];
    const notFound = [];
    const imageExtensions = '(png|jpg|jpeg|gif|webp|bmp)';

    // Match src="..." attributes
    const srcRegex = new RegExp(`src=["']([^"']+\\.${imageExtensions})["']`, 'gi');
    // Match url(...) in CSS (background-image, etc.)
    const urlRegex = new RegExp(`url\\(["']?([^"')]+\\.${imageExtensions})["']?\\)`, 'gi');

    const patterns = [srcRegex, urlRegex];
    const contentDir = fs.statSync(contentPath).isDirectory() ? contentPath : path.dirname(contentPath);
    const rootDir = rootPath ? (fs.statSync(rootPath).isDirectory() ? rootPath : path.dirname(rootPath)) : contentDir;

    for (const regex of patterns) {
        let match;
        while ((match = regex.exec(html)) !== null) {
            let src = match[1];
            // Skip if already a URL
            if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//') || src.startsWith('data:')) {
                continue;
            }
            // Handle web-style absolute paths (starting with /) as relative to rootDir
            // Handle relative paths as relative to contentDir
            let absPath;
            if (src.startsWith('/')) {
                absPath = path.resolve(rootDir, src.slice(1));
            } else {
                absPath = path.resolve(contentDir, src);
            }
            if (fs.existsSync(absPath)) {
                images.push(absPath);
            } else {
                notFound.push({ src: match[1], resolved: absPath });
            }
        }
    }

    if (notFound.length > 0) {
        log.error(`이미지 파일을 찾을 수 없습니다:`);
        for (const { src, resolved } of notFound) {
            log.error(`  - ${src}`);
            log.error(`    (resolved: ${resolved})`);
        }
        throw new Error(`${notFound.length}개의 이미지 파일을 찾을 수 없습니다.`);
    }

    return [...new Set(images)]; // Remove duplicates
}

/**
 * Upload images and update image cache
 * @param {object} browser - Puppeteer browser
 * @param {object} page - Puppeteer page (on editor)
 * @param {string[]} imagePaths - Local image paths to upload
 * @param {object} imageCache - Existing checksum -> URL cache
 * @returns {Promise<object>} { cache: updated cache, pathMap: localPath -> URL }
 */
async function uploadNewImages(browser, page, imagePaths, imageCache) {
    const updatedCache = { ...imageCache };
    const pathMap = {};
    let failures = 0;

    for (const imagePath of imagePaths) {
        const checksum = calculateChecksum(imagePath);

        // Check if already uploaded
        if (updatedCache[checksum]) {
            log.verbose(`    [이미지] ${path.basename(imagePath)} (캐시됨)`);
            pathMap[imagePath] = updatedCache[checksum];
            continue;
        }

        log.verbose(`    [이미지] ${path.basename(imagePath)} 업로드 중...`);
        const url = await withRetry(
            () => uploadImage(browser, page, imagePath),
            `이미지 업로드: ${path.basename(imagePath)}`
        );

        if (url) {
            // Ensure full URL
            const fullUrl = url.startsWith('/') ? `https://www.thelabyrinth.co.kr${url}` : url;
            updatedCache[checksum] = fullUrl;
            pathMap[imagePath] = fullUrl;
            log.verbose(`    [이미지] 완료`);
        } else {
            log.error(`    [이미지] 실패: ${path.basename(imagePath)}`);
            failures++;
        }

        await new Promise(r => setTimeout(r, 50));
    }

    return { cache: updatedCache, pathMap, failures };
}

/**
 * Replace local image paths in HTML with uploaded URLs
 * Normalizes all paths to root-relative before matching
 * to avoid collisions when multiple folders have same-named files.
 * @param {string} html - HTML content
 * @param {object} pathMap - localAbsPath -> URL mapping
 * @param {string} contentDir - Directory of the HTML file
 * @param {string} rootDir - Content root directory
 * @returns {string} HTML with replaced URLs
 */
function replaceLocalImages(html, pathMap, contentDir, rootDir) {
    // Build root-relative -> URL map
    const relMap = {};
    for (const [absPath, url] of Object.entries(pathMap)) {
        const rel = path.relative(rootDir, absPath).replace(/\\/g, '/');
        relMap[rel] = url;
    }

    let result = html;
    const imageExtensions = '(png|jpg|jpeg|gif|webp|bmp)';
    const srcRegex = new RegExp(`src=["']([^"']+\\.${imageExtensions})["']`, 'gi');
    const urlRegex = new RegExp(`url\\(["']?([^"')]+\\.${imageExtensions})["']?\\)`, 'gi');

    function replacer(match, src) {
        if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//') || src.startsWith('data:')) {
            return match;
        }
        let absPath;
        if (src.startsWith('/')) {
            absPath = path.resolve(rootDir, src.slice(1));
        } else {
            absPath = path.resolve(contentDir, src);
        }
        const rel = path.relative(rootDir, absPath).replace(/\\/g, '/');
        if (relMap[rel]) {
            return match.replace(src, relMap[rel]);
        }
        return match;
    }

    result = result.replace(srcRegex, replacer);
    result = result.replace(urlRegex, replacer);

    return result;
}

/**
 * Replace page paths with page IDs in ONLY-VIEW comments
 * e.g. <!-- ONLY-VIEW-START IN=[page/start] --> → <!-- ONLY-VIEW-START IN=[12345] -->
 * @param {string} html - Page HTML content
 * @param {object} pageIdMap - Map of page name → page ID
 * @returns {string} - HTML with paths replaced by IDs
 */
function replaceVisitPaths(html, pageIdMap) {
    // Match <!-- ONLY-VIEW-START ... --> comments
    return html.replace(/<!--\s*ONLY-VIEW-START\s+(.*?)\s*-->/g, (match, conditions) => {
        // Replace paths inside each condition bracket: IN=[...], INOR=[...], EX=[...], EXOR=[...]
        const replaced = conditions.replace(/((?:IN|INOR|EX|EXOR)=)\[([^\]]*)\]/g, (m, prefix, values) => {
            const ids = values.split(',').map(v => {
                const trimmed = v.trim();
                const id = pageIdMap[trimmed];
                if (id) return id;
                // Already a number or no mapping found
                if (/^\d+$/.test(trimmed)) return trimmed;
                log.error(`    visit 경로를 찾을 수 없습니다: "${trimmed}"`);
                return trimmed;
            });
            return `${prefix}[${ids.join(',')}]`;
        });
        return `<!-- ONLY-VIEW-START ${replaced} -->`;
    });
}

/**
 * Replace goPage('path') calls in HTML with goPage('pageId')
 * @param {string} html - HTML content
 * @param {object} pageIdMap - Map of page name → page ID
 * @returns {string} - HTML with page paths replaced by IDs
 */
function replaceGoPagePaths(html, pageIdMap) {
    return html.replace(/goPage\('([^']+)'\)/g, (match, pagePath) => {
        const id = pageIdMap[pagePath];
        if (id) return `goPage('${id}')`;
        if (/^\d+$/.test(pagePath)) return match;
        log.error(`    goPage 경로를 찾을 수 없습니다: "${pagePath}"`);
        return match;
    });
}

/**
 * Escape special regex characters
 */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Determine page states based on html/json/meta/pageIds presence
 *
 * States:
 * - normal: html O, json O, meta O, pageIds O -> update if changed
 * - new: html O, json O, meta X -> create
 * - json_missing: html O, json X -> warn, skip (or delete if has meta)
 * - html_missing: html X, json O -> warn, skip (or delete if has meta)
 * - orphan: pageIds has ID not in metas -> delete from site
 * - pageIds_missing: json O, meta O, pageIds X -> delete and recreate
 *
 * @param {string[]} htmlNames - Page names from HTML files
 * @param {string[]} jsonNames - Page names from JSON files
 * @param {string[]} metaNames - Page names from meta files
 * @param {string[]} pageIds - Known page IDs from labyrinth.meta
 * @param {object} metas - { pageName: { id, ... } } meta data
 * @returns {object} Categorized pages by state
 */
function determinePageStates(htmlNames, jsonNames, metaNames, pageIds, metas) {
    const states = {
        normal: [],         // html O, json O, meta O, pageIds O
        new: [],            // html O, json O, meta X
        json_missing: [],   // html O, json X
        html_missing: [],   // html X, json O
        orphan: [],         // pageIds has ID not mapped
        pageIds_missing: [], // meta has ID not in pageIds
        residual_meta: []   // meta exists but html/json missing
    };

    const htmlSet = new Set(htmlNames);
    const jsonSet = new Set(jsonNames);
    const metaSet = new Set(metaNames);

    // Build ID to name mapping from metas
    const idToName = {};
    for (const name of metaNames) {
        const meta = metas[name];
        if (meta && meta.id) {
            idToName[meta.id] = name;
        }
    }

    // Known IDs from pageIds
    const knownIds = new Set(pageIds);

    // Check each HTML file
    for (const name of htmlNames) {
        const hasJson = jsonSet.has(name);
        const hasMeta = metaSet.has(name);
        const meta = metas[name];
        const metaId = meta?.id;
        const inPageIds = metaId ? knownIds.has(metaId) : false;

        if (hasJson) {
            // Both HTML and JSON exist
            if (hasMeta && metaId && inPageIds) {
                states.normal.push(name);
            } else if (!hasMeta) {
                states.new.push(name);
            } else if (hasMeta && metaId && !inPageIds) {
                states.pageIds_missing.push({ name, id: metaId });
            }
        } else {
            // HTML exists but JSON missing
            states.json_missing.push({ name, hasMeta, metaId });
        }
    }

    // Check JSON files without HTML
    for (const name of jsonNames) {
        if (!htmlSet.has(name)) {
            const hasMeta = metaSet.has(name);
            const meta = metas[name];
            const metaId = meta?.id;
            states.html_missing.push({ name, hasMeta, metaId });
        }
    }

    // Check meta files without HTML and JSON
    for (const name of metaNames) {
        if (!htmlSet.has(name) && !jsonSet.has(name)) {
            const meta = metas[name];
            const metaId = meta?.id;
            const inPageIds = metaId ? knownIds.has(metaId) : false;
            states.residual_meta.push({ name, id: metaId, inPageIds });
        }
    }

    // Check pageIds without meta (orphan IDs)
    for (const id of pageIds) {
        if (!idToName[id]) {
            states.orphan.push(id);
        }
    }

    return states;
}

async function main() {
    // Parse CLI arguments
    const args = parseArgs();
    OPTIONS = args;

    // Set global logger for submodules
    setLogger(log);

    // Show help if requested
    if (args.help) {
        showHelp();
        process.exit(0);
    }

    // Validate content folder argument
    if (!args.contentFolder) {
        log.error('콘텐츠 폴더가 지정되지 않았습니다.');
        log.error('');
        showHelp();
        process.exit(1);
    }

    const contentFolder = args.contentFolder;
    const contentPath = path.resolve(contentFolder);
    const configPath = path.join(contentPath, 'labyrinth.json');
    const metaPath = path.join(contentPath, 'labyrinth.meta');

    // Check if content folder exists
    if (!fs.existsSync(contentPath)) {
        log.error(`콘텐츠 폴더를 찾을 수 없습니다: ${contentPath}`);
        log.error('경로를 확인해주세요.');
        process.exit(1);
    }

    // Read config
    if (!fs.existsSync(configPath)) {
        log.error(`labyrinth.json 파일을 찾을 수 없습니다: ${configPath}`);
        log.error('콘텐츠 폴더에 labyrinth.json 파일을 생성해주세요.');
        process.exit(1);
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        log.error(`labyrinth.json 파일을 읽을 수 없습니다: ${e.message}`);
        log.error('JSON 형식이 올바른지 확인해주세요.');
        process.exit(1);
    }

    if (!config.title) {
        log.error('labyrinth.json에 title 필드가 없습니다.');
        log.error('미궁 제목을 지정해주세요.');
        process.exit(1);
    }

    // Load account credentials
    const account = loadAccount(contentPath);

    log.info('=== 더라비린스 업로드 ===');
    log.info(`폴더: ${contentFolder}`);
    log.info(`미궁: ${config.title}`);
    log.info('');

    // Validate config
    const validation = validateConfig(config);
    if (!validation.valid) {
        log.error('설정 검증 실패:');
        validation.errors.forEach(err => log.error(`  - ${err}`));
        process.exit(1);
    }

    let browser, page;

    // Counters for final summary
    const counts = { deleted: 0, created: 0, updated: 0, connected: 0, failures: { image: 0, page: 0, connect: 0 } };

    try {
        // Login with retry
        log.section(1, 6, '로그인');
        ({ browser, page } = await withRetry(
            () => login({
                email: account.email,
                password: account.password,
                headless: !args.showBrowser
            }),
            '로그인'
        ));
        log.item('완료');

        // Check if labyrinth.meta exists
        let labyMeta = {};
        const isNewLabyrinth = !fs.existsSync(metaPath);
        if (!isNewLabyrinth) {
            labyMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }

        // If new labyrinth, clean up all existing page meta files
        if (isNewLabyrinth) {
            const existingMetas = findPageMetaFiles(contentPath);
            if (existingMetas.length > 0) {
                log.verbose(`  이전 메타 파일 ${existingMetas.length}개 정리 중...`);
                for (const name of existingMetas) {
                    deletePageMeta(contentPath, name);
                }
            }
        }

        // Compute current config hash
        const currentHash = computeLabyrinthHash(config, contentPath);

        // Options for labyrinth functions
        const options = { browser, labyPath: contentPath };

        // Create or update labyrinth (with retry)
        log.info('');
        if (!labyMeta.id) {
            log.section(2, 6, '미궁 생성');
            const labyrinthId = await withRetry(
                () => createLabyrinth(page, config, options),
                '미궁 생성'
            );

            labyMeta.id = labyrinthId;
            labyMeta.hash = currentHash;
            labyMeta.images = labyMeta.images || {};
            labyMeta.pageIds = labyMeta.pageIds || [];
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
            log.item(`완료 (ID: ${labyrinthId})`);
        } else if (labyMeta.hash !== currentHash) {
            log.section(2, 6, '미궁 정보 수정');
            await withRetry(
                () => updateLabyrinth(page, labyMeta.id, config, options),
                '미궁 수정'
            );

            labyMeta.hash = currentHash;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
            log.item('완료');
        } else {
            log.section(2, 6, '미궁 정보 (변경 없음)');
        }

        const labyrinthId = labyMeta.id;
        let imageCache = labyMeta.images || {};
        let pageIds = labyMeta.pageIds || [];

        // Find all page files
        log.verbose('');
        log.verbose('  페이지 파일 스캔 중...');
        const htmlNames = findPageHtmlFiles(contentPath);
        const jsonNames = findPageJsonFiles(contentPath);
        const metaNames = findPageMetaFiles(contentPath);
        log.verbose(`  HTML: ${htmlNames.length}, JSON: ${jsonNames.length}, Meta: ${metaNames.length}, 등록된 ID: ${pageIds.length}`);

        // Load all page data and meta
        const pages = {};
        const metas = {};

        // Load pages with both HTML and JSON
        for (const name of htmlNames) {
            if (jsonNames.includes(name)) {
                const html = readPageHtml(contentPath, name);
                const json = readPageJson(contentPath, name);
                const meta = readPageMeta(contentPath, name);
                if (html && json) {
                    // Calculate image checksums for change detection
                    const pageDir = path.dirname(path.join(contentPath, `${name}.html`));
                    const localImages = findLocalImages(html, pageDir, contentPath);

                    // Also include explanation images in checksums
                    const answers = json.answers || [];
                    for (const ans of answers) {
                        if (ans.explanation && ans.explanation.includes('<')) {
                            try {
                                const explImages = findLocalImages(ans.explanation, pageDir, contentPath);
                                localImages.push(...explImages);
                            } catch (e) {
                                // Ignore errors in explanation image detection for hash calculation
                            }
                        }
                    }

                    const imageChecksums = [...new Set(localImages)].map(imgPath => calculateChecksum(imgPath));
                    pages[name] = { html, json, meta, hash: computePageHash(html, json, imageChecksums) };
                }
                metas[name] = meta;
            }
        }

        // Load meta-only files
        for (const name of metaNames) {
            if (!metas[name]) {
                metas[name] = readPageMeta(contentPath, name);
            }
        }

        // Determine page states
        const states = determinePageStates(htmlNames, jsonNames, metaNames, pageIds, metas);

        // Show warnings for abnormal states (verbose only)
        const warnings = [];

        if (states.json_missing.length > 0) {
            for (const item of states.json_missing) {
                warnings.push(`[${item.name}] HTML은 있지만 JSON이 없음 - 건너뜀`);
            }
        }

        if (states.html_missing.length > 0) {
            for (const item of states.html_missing) {
                warnings.push(`[${item.name}] JSON은 있지만 HTML이 없음 - 건너뜀`);
            }
        }

        if (states.pageIds_missing.length > 0) {
            for (const item of states.pageIds_missing) {
                warnings.push(`[${item.name}] 목록에서 누락됨 (ID: ${item.id}) - 삭제 후 재생성`);
            }
        }

        if (states.residual_meta.length > 0) {
            for (const item of states.residual_meta) {
                warnings.push(`[${item.name}] 잔여 메타 파일 (ID: ${item.id}) - 정리 예정`);
            }
        }

        if (states.orphan.length > 0) {
            warnings.push(`미사용 페이지 ID: ${states.orphan.join(', ')} - 사이트에서 삭제 예정`);
        }

        if (warnings.length > 0) {
            log.verbose('');
            log.verbose('  [주의]');
            warnings.forEach(w => log.verbose(`    ${w}`));
        }

        // Validate all valid pages
        const pageValidation = validateAllPages(pages);

        // Show validation warnings (verbose only)
        if (pageValidation.warnings.length > 0) {
            log.verbose('');
            log.verbose('  [검증 주의사항]');
            pageValidation.warnings.forEach(w => log.verbose(`    ${w}`));
        }

        // Stop on errors
        if (!pageValidation.valid) {
            log.error('');
            log.error('페이지 검증 실패:');
            pageValidation.errors.forEach(e => log.error(`  - ${e}`));
            log.error('');
            log.error('오류를 수정한 후 다시 실행해주세요.');
            process.exit(1);
        }

        // Determine first page from config
        const firstPage = config.first_page || config.start_page || null;

        // Validate first_page reference
        if (firstPage && !Object.keys(pages).includes(firstPage)) {
            log.error(`시작 페이지를 찾을 수 없습니다: "${firstPage}"`);
            log.error(`사용 가능한 페이지: ${Object.keys(pages).join(', ')}`);
            process.exit(1);
        }

        // Categorize pages for processing
        const newPages = [...states.new];
        const updatedPages = [];
        const unchangedPages = [];

        // Normal pages: check if content changed
        // If answers changed, the page must be deleted and recreated
        for (const name of states.normal) {
            const pageInfo = pages[name];
            if (pageInfo.meta.hash !== pageInfo.hash) {
                const oldAnswers = pageInfo.meta.answers || [];
                const newAnswers = (pageInfo.json.answers || []).map(a => a.answer);
                const answersChanged = oldAnswers.length !== newAnswers.length ||
                    oldAnswers.some((a, i) => a !== newAnswers[i]);
                if (answersChanged) {
                    // Will be deleted and recreated
                    updatedPages.push({ name, recreate: true });
                } else {
                    updatedPages.push({ name, recreate: false });
                }
            } else {
                unchangedPages.push(name);
            }
        }

        // Pages to delete before recreate (from pageIds_missing + answer-changed pages)
        const pagesToDeleteBeforeRecreate = [];
        for (const item of states.pageIds_missing) {
            pagesToDeleteBeforeRecreate.push(item.id);
            newPages.push(item.name);
            pages[item.name].meta = {};
        }
        for (const item of updatedPages) {
            if (item.recreate) {
                const pageId = pages[item.name].meta.id;
                if (pageId) {
                    pagesToDeleteBeforeRecreate.push(pageId);
                    newPages.push(item.name);
                    pages[item.name].meta = {};
                }
            }
        }

        // Filter updatedPages to only non-recreate pages
        const pagesToUpdateInPlace = updatedPages
            .filter(item => !item.recreate)
            .map(item => item.name);

        // Pages to delete (orphans, residual_meta with IDs)
        const pagesToDelete = [...states.orphan];
        for (const item of states.residual_meta) {
            if (item.id && item.inPageIds) {
                pagesToDelete.push(item.id);
            }
        }

        // Meta files to clean up
        const metasToDelete = [];
        for (const item of states.json_missing) {
            if (item.hasMeta) {
                metasToDelete.push(item.name);
                if (item.metaId && pageIds.includes(item.metaId)) {
                    pagesToDelete.push(item.metaId);
                }
            }
        }
        for (const item of states.html_missing) {
            if (item.hasMeta) {
                metasToDelete.push(item.name);
                if (item.metaId && pageIds.includes(item.metaId)) {
                    pagesToDelete.push(item.metaId);
                }
            }
        }
        for (const item of states.residual_meta) {
            metasToDelete.push(item.name);
        }

        log.verbose(`  신규: ${newPages.length}, 수정: ${pagesToUpdateInPlace.length}, 변경없음: ${unchangedPages.length}`);
        log.verbose(`  삭제 예정: ${pagesToDelete.length + pagesToDeleteBeforeRecreate.length}`);

        // ============================================================
        // Step 3: Delete unused pages (including pages that need recreation)
        // ============================================================
        const allPagesToDelete = [...pagesToDelete, ...pagesToDeleteBeforeRecreate];
        log.info('');
        log.section(3, 6, '미사용 페이지 삭제');
        if (allPagesToDelete.length > 0) {
            for (let i = 0; i < allPagesToDelete.length; i++) {
                const pageId = allPagesToDelete[i];
                log.progress(i + 1, allPagesToDelete.length, `ID: ${pageId}`);
                const success = await deletePage(page, labyrinthId, pageId);
                if (success) {
                    pageIds = pageIds.filter(id => id !== pageId);
                    counts.deleted++;
                    log.verbose(`    삭제됨`);
                } else {
                    log.verbose(`    실패 (이미 삭제됨)`);
                    pageIds = pageIds.filter(id => id !== pageId);
                }
                await new Promise(r => setTimeout(r, 50));
            }

            labyMeta.pageIds = pageIds;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
            log.item('완료');
        } else {
            log.item('삭제할 페이지 없음');
        }

        // Clean up unused meta files
        if (metasToDelete.length > 0) {
            log.verbose(`  메타 파일 정리 중... (${metasToDelete.length}개)`);
            for (const name of metasToDelete) {
                deletePageMeta(contentPath, name);
                log.verbose(`    ${name}.meta 삭제됨`);
            }
        }

        // ============================================================
        // Step 4: Create new pages (dummy content for ID allocation)
        // ============================================================
        log.info('');
        log.section(4, 6, '페이지 생성');
        if (newPages.length > 0) {
            for (let i = 0; i < newPages.length; i++) {
                const name = newPages[i];
                const pageData = pages[name].json;
                log.progress(i + 1, newPages.length, `${name}: ${pageData.title}`);

                await withRetry(
                    () => navigateToCreatePage(page, labyrinthId),
                    '페이지 생성 화면 이동'
                );

                await fillPageForm(page, {
                    title: pageData.title,
                    bgColor: '#000000',
                    isFirst: false,
                    isEnding: false,
                    hasAnswers: true,
                    hint: '',
                    hint_enabled: false,
                    content: '.'
                });

                // Always add 1 dummy answer for ID allocation
                await addAnswer(page, '.', false, '');

                const pageId = await withRetry(
                    () => submitPageForm(page, labyrinthId, pageData.title),
                    '페이지 저장'
                );

                if (pageId) {
                    pages[name].meta.id = pageId;
                    writePageMeta(contentPath, name, pages[name].meta);

                    if (!pageIds.includes(pageId)) {
                        pageIds.push(pageId);
                    }

                    counts.created++;
                    log.verbose(`    생성됨 (ID: ${pageId})`);
                } else {
                    counts.failures.page++;
                    log.fail(`${name}: 페이지 ID를 받아올 수 없습니다`);
                }
            }

            labyMeta.pageIds = pageIds;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
            log.item('완료');
        } else {
            log.item('생성할 페이지 없음');
        }

        // Build page name -> ID mapping (all IDs now available)
        const pageIdMap = {};
        for (const [name, pageInfo] of Object.entries(pages)) {
            if (pageInfo.meta.id) {
                pageIdMap[name] = pageInfo.meta.id;
            }
        }

        // Update pages: newly created (with real content) + modified (non-recreate only)
        const pagesToUpdate = [
            ...newPages.filter(name => pages[name].meta.id),
            ...pagesToUpdateInPlace
        ];

        log.info('');
        log.section(5, 6, '페이지 수정');
        if (pagesToUpdate.length > 0) {

            for (let i = 0; i < pagesToUpdate.length; i++) {
                const name = pagesToUpdate[i];
                const pageData = pages[name].json;
                const pageMeta = pages[name].meta;
                const pageId = pageMeta.id;

                if (!pageId) continue;

                log.progress(i + 1, pagesToUpdate.length, `${name}: ${pageData.title}`);

                // Read HTML content
                let html = pages[name].html;
                if (!html) {
                    log.error(`    HTML 내용이 없습니다`);
                    continue;
                }

                // Navigate to editor first (for image upload)
                await withRetry(
                    () => navigateToEditPage(page, labyrinthId, pageId),
                    '페이지 편집 화면 이동'
                );

                // Find and upload images (content + explanation images BEFORE fillPageForm)
                const pageDir = path.dirname(path.join(contentPath, `${name}.html`));
                const localImages = findLocalImages(html, pageDir, contentPath);

                const isFirst = (firstPage === name);
                const isEnding = pageData.is_ending || false;
                const answers = pageData.answers || [];
                const hasAnswers = answers.length > 0;

                // Prepare explanation HTML with images (collect all images first)
                const processedAnswers = [];
                for (const ans of answers) {
                    let explanationHtml = ans.explanation || '';
                    if (explanationHtml && explanationHtml.includes('<')) {
                        const explImages = findLocalImages(explanationHtml, pageDir, contentPath);
                        localImages.push(...explImages);
                    }
                    processedAnswers.push({ ...ans, explanationHtml });
                }

                // Upload all images at once (before editor content is set)
                let pageImageFailures = 0;
                if (localImages.length > 0) {
                    log.verbose(`    이미지 ${localImages.length}개 처리 중...`);
                    const { cache: newCache, pathMap, failures: imageFailures } = await uploadNewImages(browser, page, localImages, imageCache);
                    pageImageFailures = imageFailures;
                    counts.failures.image += imageFailures;
                    imageCache = newCache;

                    labyMeta.images = imageCache;
                    fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');

                    html = replaceLocalImages(html, pathMap, pageDir, contentPath);

                    // Replace images in explanation HTML too
                    for (const ans of processedAnswers) {
                        if (ans.explanationHtml) {
                            ans.explanationHtml = replaceLocalImages(ans.explanationHtml, pathMap, pageDir, contentPath);
                        }
                    }
                }

                // Navigate again only if images were uploaded (upload popup changes page state)
                if (localImages.length > 0) {
                    await withRetry(
                        () => navigateToEditPage(page, labyrinthId, pageId),
                        '페이지 편집 화면 이동'
                    );
                }

                // Replace visit paths with page IDs
                html = replaceVisitPaths(html, pageIdMap);
                html = replaceGoPagePaths(html, pageIdMap);

                await fillPageForm(page, {
                    title: pageData.title,
                    bgColor: pageData.background_color || '#000000',
                    isFirst: isFirst,
                    isEnding: isEnding,
                    hasAnswers: hasAnswers,
                    hint: pageData.hint || '',
                    hint_enabled: pageData.hint_enabled || false,
                    content: html
                });

                // Add answers
                let answerFailures = 0;
                if (hasAnswers) {
                    // For new pages, the first slot has a dummy answer from Step 4.
                    // Overwrite it, then add the rest.
                    const isNewPage = newPages.includes(name);

                    for (let j = 0; j < processedAnswers.length; j++) {
                        const ans = processedAnswers[j];

                        if (j === 0 && isNewPage) {
                            // Overwrite the dummy answer in the first slot
                            const firstInput = await page.evaluateHandle(() => {
                                const inputs = document.querySelectorAll('input.answer');
                                for (const input of inputs) {
                                    const tr = input.closest('tr');
                                    if (tr && tr.style.display !== 'none') return input;
                                }
                                return null;
                            });
                            if (firstInput && !(await firstInput.evaluate(el => el === null))) {
                                await firstInput.click({ clickCount: 3 });
                                await page.keyboard.press('Backspace');
                                await firstInput.type(ans.answer);
                            } else {
                                log.fail(`    첫 번째 정답 슬롯을 찾을 수 없음`);
                                answerFailures++;
                            }
                        } else {
                            let result;
                            for (let attempt = 1; attempt <= 3; attempt++) {
                                result = await addAnswer(page, ans.answer, ans.public || false, ans.explanationHtml);
                                if (result === 'filled') break;
                                log.verbose(`    정답 추가 실패 (${attempt}/3), 재시도...`);
                            }
                            if (result !== 'filled') {
                                log.fail(`    정답 추가 실패: "${ans.answer}"`);
                                answerFailures++;
                            }
                        }
                    }
                }

                await withRetry(
                    () => submitPageForm(page),
                    '페이지 저장'
                );

                // Update page meta (skip hash if any step failed, so next run retries)
                if (pageImageFailures === 0 && answerFailures === 0) {
                    pageMeta.hash = pages[name].hash;
                }
                pageMeta.is_first = isFirst;
                pageMeta.is_ending = isEnding;
                pageMeta.answers = (pageData.answers || []).map(a => a.answer);
                writePageMeta(contentPath, name, pageMeta);

                // Save final HTML with replaced image URLs for later use
                pages[name].finalHtml = html;

                counts.updated++;
                log.verbose(`    수정됨`);
            }
            log.item('완료');
        } else {
            log.item('수정할 페이지 없음');
        }

        // ============================================================
        // Step 6: Set parent connections
        // ============================================================
        // For new/recreated pages, we need to scan ALL pages' answers (not just new/updated)
        // because existing unchanged pages might have answers pointing to new pages
        const connections = {};
        const newPageIds = new Set(newPages.map(name => pageIdMap[name]).filter(Boolean));

        // Scan all pages' answers for connections to new pages
        for (const [name, pageInfo] of Object.entries(pages)) {
            const pageData = pageInfo.json;
            const pageMeta = pageInfo.meta;
            const fromPageId = pageMeta.id;

            if (!fromPageId) continue;

            const answers = pageData.answers || [];
            answers.forEach((ans, idx) => {
                if (ans.next && pageIdMap[ans.next]) {
                    const targetPageId = pageIdMap[ans.next];
                    // Only process connections TO new pages, or FROM new/updated pages
                    const isTargetNew = newPageIds.has(targetPageId);
                    const isSourceNewOrUpdated = pagesToUpdate.includes(name);

                    if (isTargetNew || isSourceNewOrUpdated) {
                        if (!connections[targetPageId]) {
                            connections[targetPageId] = [];
                        }
                        connections[targetPageId].push({
                            fromPageId: fromPageId,
                            answerIndex: idx + 1,
                            fromName: name,
                            answer: ans.answer
                        });
                    }
                }
            });
        }

        const targetPages = Object.keys(connections);
        log.info('');
        log.section(6, 6, '페이지 연결');
        if (targetPages.length > 0) {
            for (let i = 0; i < targetPages.length; i++) {
                const targetPageId = targetPages[i];
                const sources = connections[targetPageId];
                const targetName = Object.entries(pageIdMap).find(([n, id]) => id === targetPageId)?.[0] || targetPageId;

                log.progress(i + 1, targetPages.length, targetName);

                await withRetry(
                    () => navigateToEditPage(page, labyrinthId, targetPageId),
                    '페이지 편집 화면 이동'
                );
                await clearParentConnections(page);

                let connectionSuccess = true;
                for (const src of sources) {
                    const success = await setParentConnection(page, src.fromPageId, src.answerIndex);
                    if (success) {
                        log.verbose(`    <- ${src.fromName} [정답: ${src.answer}]`);
                    } else {
                        log.verbose(`    <- ${src.fromName} [실패]`);
                        connectionSuccess = false;
                        counts.failures.connect++;
                    }
                }

                // Re-set HTML content to overwrite any changes made by SmartEditor
                // (SmartEditor executes JS when the edit page is opened, which can bake
                // inline styles from onload handlers into the HTML)
                const finalHtml = pages[targetName]?.finalHtml;
                if (finalHtml) {
                    await setEditorContent(page, finalHtml);
                }

                await withRetry(
                    () => submitPageForm(page),
                    '페이지 저장'
                );
                if (connectionSuccess) {
                    counts.connected++;
                } else if (pages[targetName]) {
                    // Clear hash so next run retries this page
                    const targetMeta = pages[targetName].meta;
                    delete targetMeta.hash;
                    writePageMeta(contentPath, targetName, targetMeta);
                }
                await new Promise(r => setTimeout(r, 50));
            }
            log.item('완료');
        } else {
            log.item('연결할 페이지 없음');
        }

        // Final summary
        log.info('');
        const summaryParts = [];
        if (counts.deleted > 0) summaryParts.push(`삭제 ${counts.deleted}`);
        if (counts.created > 0) summaryParts.push(`생성 ${counts.created}`);
        if (counts.updated > 0) summaryParts.push(`수정 ${counts.updated}`);
        if (counts.connected > 0) summaryParts.push(`연결 ${counts.connected}`);

        const totalFailures = counts.failures.image + counts.failures.page + counts.failures.connect;
        if (summaryParts.length > 0 || totalFailures > 0) {
            log.info(`업로드 완료! (${summaryParts.join(', ') || '변경 없음'})`);
        } else {
            log.info('업로드 완료! (변경 없음)');
        }

        if (totalFailures > 0) {
            const failParts = [];
            if (counts.failures.image > 0) failParts.push(`이미지 ${counts.failures.image}`);
            if (counts.failures.page > 0) failParts.push(`페이지 ${counts.failures.page}`);
            if (counts.failures.connect > 0) failParts.push(`연결 ${counts.failures.connect}`);
            log.error(`  실패: ${failParts.join(', ')} (다음 실행 시 재시도됨)`);
        }

        log.verbose(`  미궁 ID: ${labyrinthId}`);
        log.verbose(`  총 페이지: ${Object.keys(pages).length}개`);
        log.verbose(`  이미지 캐시: ${Object.keys(imageCache).length}개`);

    } catch (error) {
        log.error('');
        log.error(`오류가 발생했습니다: ${error.message}`);
        if (OPTIONS.verbose) {
            log.error(error.stack);
        } else {
            log.error('상세 정보를 보려면 --verbose 옵션을 사용하세요.');
        }
        process.exit(1);
    } finally {
        if (browser) {
            await logout(browser);
        }
    }
}

main();
