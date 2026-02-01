/**
 * The Labyrinth Auto Upload Script
 *
 * Usage: node upload.js <content-folder>
 * Example: node upload.js ./example
 *
 * Reads config from <content-folder>/labyrinth.json
 * Reads credentials from <content-folder>/account.json
 * Creates labyrinth if labyrinth.meta doesn't exist
 * Uploads pages based on {page}.html files with matching {page}.json metadata
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { login, logout } = require('./src/login');
const { createLabyrinth, updateLabyrinth, computeLabyrinthHash, validateConfig } = require('./src/labyrinth');
const {
    navigateToCreatePage,
    navigateToEditPage,
    fillPageForm,
    addAnswer,
    clearAnswers,
    submitPageForm,
    getPageList,
    setParentConnection,
    clearParentConnections,
    deletePage
} = require('./src/page');
const {
    calculateChecksum,
    uploadImage,
    findImageReferences,
    replaceImagePaths
} = require('./src/image');

/**
 * Load account credentials from account.json
 * @param {string} contentPath - Path to content folder
 * @returns {{ email: string, password: string }}
 */
function loadAccount(contentPath) {
    const accountPath = path.join(contentPath, 'account.json');
    if (!fs.existsSync(accountPath)) {
        console.error('Error: account.json not found in', contentPath);
        console.error('Please create account.json with { "id": "email", "password": "password" }');
        process.exit(1);
    }

    const account = JSON.parse(fs.readFileSync(accountPath, 'utf8'));

    // Support both "email" and "id" fields
    const userId = account.email || account.id;
    if (!userId || !account.password) {
        console.error('Error: account.json must have id/email and password fields');
        process.exit(1);
    }

    return { email: userId, password: account.password };
}

/**
 * Find all page HTML files in content directory
 * @param {string} contentPath - Path to content directory
 * @returns {string[]} Array of page names (without .html extension)
 */
function findPageHtmlFiles(contentPath) {
    const results = [];
    const pageDir = path.join(contentPath, 'page');

    if (!fs.existsSync(pageDir)) {
        return results;
    }

    function scanDir(dir, baseDir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                scanDir(fullPath, baseDir);
            } else if (item.endsWith('.html')) {
                const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/').replace('.html', '');
                results.push(relativePath);
            }
        }
    }

    scanDir(pageDir, pageDir);
    return results;
}

/**
 * Find all page JSON files in content directory
 * @param {string} contentPath - Path to content directory
 * @returns {string[]} Array of page names (without .json extension)
 */
function findPageJsonFiles(contentPath) {
    const results = [];
    const pageDir = path.join(contentPath, 'page');

    if (!fs.existsSync(pageDir)) {
        return results;
    }

    function scanDir(dir, baseDir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                scanDir(fullPath, baseDir);
            } else if (item.endsWith('.json') && !item.endsWith('.meta')) {
                const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/').replace('.json', '');
                results.push(relativePath);
            }
        }
    }

    scanDir(pageDir, pageDir);
    return results;
}

/**
 * Find all page meta files in content directory
 * @param {string} contentPath - Path to content directory
 * @returns {string[]} Array of page names (without .meta extension)
 */
function findPageMetaFiles(contentPath) {
    const results = [];
    const pageDir = path.join(contentPath, 'page');

    if (!fs.existsSync(pageDir)) {
        return results;
    }

    function scanDir(dir, baseDir) {
        const items = fs.readdirSync(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                scanDir(fullPath, baseDir);
            } else if (item.endsWith('.meta')) {
                const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/').replace('.meta', '');
                results.push(relativePath);
            }
        }
    }

    scanDir(pageDir, pageDir);
    return results;
}

/**
 * Read page HTML content
 * @param {string} contentPath - Path to content directory
 * @param {string} pageName - Page name (without extension)
 * @returns {string|null} HTML content or null
 */
function readPageHtml(contentPath, pageName) {
    const htmlPath = path.join(contentPath, 'page', `${pageName}.html`);
    if (fs.existsSync(htmlPath)) {
        return fs.readFileSync(htmlPath, 'utf8');
    }
    return null;
}

/**
 * Read page JSON metadata
 * @param {string} contentPath - Path to content directory
 * @param {string} pageName - Page name (without extension)
 * @returns {object|null} Page JSON data or null
 */
function readPageJson(contentPath, pageName) {
    const jsonPath = path.join(contentPath, 'page', `${pageName}.json`);
    if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    return null;
}

/**
 * Read page meta file
 * @param {string} contentPath - Path to content directory
 * @param {string} pageName - Page name
 * @returns {object} Page meta or empty object
 */
function readPageMeta(contentPath, pageName) {
    const metaPath = path.join(contentPath, 'page', `${pageName}.meta`);
    if (fs.existsSync(metaPath)) {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    return {};
}

/**
 * Write page meta file
 * @param {string} contentPath - Path to content directory
 * @param {string} pageName - Page name
 * @param {object} meta - Meta data
 */
function writePageMeta(contentPath, pageName, meta) {
    const metaPath = path.join(contentPath, 'page', `${pageName}.meta`);
    const metaDir = path.dirname(metaPath);
    if (!fs.existsSync(metaDir)) {
        fs.mkdirSync(metaDir, { recursive: true });
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 4) + '\n', 'utf8');
}

/**
 * Delete page meta file
 * @param {string} contentPath - Path to content directory
 * @param {string} pageName - Page name
 */
function deletePageMeta(contentPath, pageName) {
    const metaPath = path.join(contentPath, 'page', `${pageName}.meta`);
    if (fs.existsSync(metaPath)) {
        fs.unlinkSync(metaPath);
    }
}

/**
 * Compute hash for page content (HTML + JSON for change detection)
 * @param {string} html - HTML content
 * @param {object} jsonData - JSON metadata
 * @returns {string} MD5 hash
 */
function computePageHash(html, jsonData) {
    const combined = JSON.stringify({ html, json: jsonData });
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
        errors.push(`[${pageName}] title is required.`);
    } else if (pageData.title.length > PAGE_VALIDATION.title.maxLength) {
        errors.push(`[${pageName}] title exceeds ${PAGE_VALIDATION.title.maxLength} characters.`);
    }

    // background_color format
    if (pageData.background_color) {
        if (!PAGE_VALIDATION.background_color.pattern.test(pageData.background_color)) {
            errors.push(`[${pageName}] Invalid background_color format: ${pageData.background_color} (expected: #000000)`);
        }
    }

    // header_display valid values
    if (pageData.header_display) {
        if (!PAGE_VALIDATION.header_display.allowedValues.includes(pageData.header_display)) {
            warnings.push(`[${pageName}] Invalid header_display value: ${pageData.header_display} (allowed: ${PAGE_VALIDATION.header_display.allowedValues.join(', ')})`);
        }
    }

    // Validate answers
    if (pageData.answers && Array.isArray(pageData.answers)) {
        for (let i = 0; i < pageData.answers.length; i++) {
            const ans = pageData.answers[i];

            // answer text required
            if (!ans.answer || ans.answer.trim() === '') {
                errors.push(`[${pageName}] answers[${i}].answer is required.`);
            }

            // next page reference validation
            if (ans.next) {
                if (!allPageNames.includes(ans.next)) {
                    errors.push(`[${pageName}] answers[${i}].next references non-existent page: "${ans.next}"`);
                }
            }
        }
    }

    // is_ending validation
    if (pageData.is_ending !== undefined && typeof pageData.is_ending !== 'boolean') {
        warnings.push(`[${pageName}] is_ending should be boolean.`);
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
function findLocalImages(html, contentPath) {
    const images = [];
    const imageExtensions = '(png|jpg|jpeg|gif|webp|bmp)';

    // Match src="..." attributes
    const srcRegex = new RegExp(`src=["']([^"']+\\.${imageExtensions})["']`, 'gi');
    // Match url(...) in CSS (background-image, etc.)
    const urlRegex = new RegExp(`url\\(["']?([^"')]+\\.${imageExtensions})["']?\\)`, 'gi');

    const patterns = [srcRegex, urlRegex];

    for (const regex of patterns) {
        let match;
        while ((match = regex.exec(html)) !== null) {
            const src = match[1];
            // Skip if already a URL
            if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//') || src.startsWith('data:')) {
                continue;
            }
            // Resolve to absolute path (relative to content folder)
            const absPath = path.resolve(contentPath, src);
            if (fs.existsSync(absPath)) {
                images.push(absPath);
            }
        }
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

    for (const imagePath of imagePaths) {
        const checksum = calculateChecksum(imagePath);

        // Check if already uploaded
        if (updatedCache[checksum]) {
            console.log(`    [image] ${path.basename(imagePath)} (cached)`);
            pathMap[imagePath] = updatedCache[checksum];
            continue;
        }

        console.log(`    [image] ${path.basename(imagePath)} uploading...`);
        const url = await uploadImage(browser, page, imagePath);

        if (url) {
            // Ensure full URL
            const fullUrl = url.startsWith('/') ? `https://www.thelabyrinth.co.kr${url}` : url;
            updatedCache[checksum] = fullUrl;
            pathMap[imagePath] = fullUrl;
            console.log(`    [image] done: ${fullUrl}`);
        } else {
            console.error(`    [image] failed: ${path.basename(imagePath)}`);
        }

        await new Promise(r => setTimeout(r, 100));
    }

    return { cache: updatedCache, pathMap };
}

/**
 * Replace local image paths in HTML with uploaded URLs
 * @param {string} html - HTML content
 * @param {object} pathMap - localPath -> URL mapping
 * @returns {string} HTML with replaced URLs
 */
function replaceLocalImages(html, pathMap) {
    let result = html;

    for (const [localPath, url] of Object.entries(pathMap)) {
        const basename = path.basename(localPath);
        const escapedBasename = escapeRegex(basename);

        // Replace src="..." attributes
        const srcPattern = new RegExp(`src=["']([^"']*${escapedBasename})["']`, 'gi');
        result = result.replace(srcPattern, `src="${url}"`);

        // Replace url(...) in CSS
        const urlPattern = new RegExp(`url\\(["']?([^"')]*${escapedBasename})["']?\\)`, 'gi');
        result = result.replace(urlPattern, `url("${url}")`);
    }

    return result;
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
 * - normal: html ✓, json ✓, meta ✓, pageIds ✓ → update if changed
 * - new: html ✓, json ✓, meta ✗ → create
 * - json_missing: html ✓, json ✗ → warn, skip (or delete if has meta)
 * - html_missing: html ✗, json ✓ → warn, skip (or delete if has meta)
 * - orphan: pageIds has ID not in metas → delete from site
 * - pageIds_missing: json ✓, meta ✓, pageIds ✗ → delete and recreate
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
        normal: [],         // html ✓, json ✓, meta ✓, pageIds ✓
        new: [],            // html ✓, json ✓, meta ✗
        json_missing: [],   // html ✓, json ✗
        html_missing: [],   // html ✗, json ✓
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
    // Get content folder from argument
    const contentFolder = process.argv[2];

    if (!contentFolder) {
        console.error('Usage: node upload.js <content-folder>');
        console.error('Example: node upload.js ./example');
        process.exit(1);
    }

    const contentPath = path.resolve(contentFolder);
    const configPath = path.join(contentPath, 'labyrinth.json');
    const metaPath = path.join(contentPath, 'labyrinth.meta');

    // Check if content folder exists
    if (!fs.existsSync(contentPath)) {
        console.error(`Error: Content folder not found: ${contentPath}`);
        process.exit(1);
    }

    // Read config
    if (!fs.existsSync(configPath)) {
        console.error(`Error: labyrinth.json not found: ${configPath}`);
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!config.title) {
        console.error('Error: title required in labyrinth.json');
        process.exit(1);
    }

    // Load account credentials
    const account = loadAccount(contentPath);

    console.log('=== The Labyrinth Upload ===');
    console.log('Content:', contentFolder);
    console.log('Title:', config.title);
    console.log('');

    // Validate config
    const validation = validateConfig(config);
    if (!validation.valid) {
        console.error('Config validation failed:');
        validation.errors.forEach(err => console.error(`  - ${err}`));
        process.exit(1);
    }

    let browser, page;

    try {
        // Login
        console.log('[1/3] Logging in...');
        ({ browser, page } = await login({
            email: account.email,
            password: account.password,
            headless: true
        }));
        console.log('Login successful!');

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
                console.log(`Cleaning up ${existingMetas.length} old page meta files...`);
                for (const name of existingMetas) {
                    deletePageMeta(contentPath, name);
                }
            }
        }

        // Compute current config hash
        const currentHash = computeLabyrinthHash(config, contentPath);

        // Options for labyrinth functions
        const options = { browser, labyPath: contentPath };

        // Create or update labyrinth
        if (!labyMeta.id) {
            console.log('');
            console.log('[2/3] Creating labyrinth...');
            const labyrinthId = await createLabyrinth(page, config, options);

            labyMeta.id = labyrinthId;
            labyMeta.hash = currentHash;
            labyMeta.images = labyMeta.images || {};
            labyMeta.pageIds = labyMeta.pageIds || [];
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
            console.log('Labyrinth created! ID:', labyrinthId);
        } else if (labyMeta.hash !== currentHash) {
            console.log('');
            console.log('[2/3] Updating labyrinth info...');
            await updateLabyrinth(page, labyMeta.id, config, options);

            labyMeta.hash = currentHash;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
            console.log('Labyrinth info updated!');
        } else {
            console.log('');
            console.log('[2/3] Labyrinth info unchanged');
        }

        const labyrinthId = labyMeta.id;
        let imageCache = labyMeta.images || {};
        let pageIds = labyMeta.pageIds || [];

        // Find all page files
        console.log('');
        console.log('[3/3] Processing pages...');
        const htmlNames = findPageHtmlFiles(contentPath);
        const jsonNames = findPageJsonFiles(contentPath);
        const metaNames = findPageMetaFiles(contentPath);
        console.log(`  HTML: ${htmlNames.length}, JSON: ${jsonNames.length}, Meta: ${metaNames.length}, Known IDs: ${pageIds.length}`);

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
                    pages[name] = { html, json, meta, hash: computePageHash(html, json) };
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

        // Show warnings for abnormal states
        const warnings = [];

        if (states.json_missing.length > 0) {
            for (const item of states.json_missing) {
                warnings.push(`[${item.name}] HTML exists but JSON missing - skipped`);
            }
        }

        if (states.html_missing.length > 0) {
            for (const item of states.html_missing) {
                warnings.push(`[${item.name}] JSON exists but HTML missing - skipped`);
            }
        }

        if (states.pageIds_missing.length > 0) {
            for (const item of states.pageIds_missing) {
                warnings.push(`[${item.name}] Missing from pageIds (ID: ${item.id}) - will delete and recreate`);
            }
        }

        if (states.residual_meta.length > 0) {
            for (const item of states.residual_meta) {
                warnings.push(`[${item.name}] Residual meta (ID: ${item.id}) - will clean up`);
            }
        }

        if (states.orphan.length > 0) {
            warnings.push(`Orphan page IDs: ${states.orphan.join(', ')} - will delete from site`);
        }

        if (warnings.length > 0) {
            console.log('');
            console.log('  [Warnings]');
            warnings.forEach(w => console.log(`    ${w}`));
        }

        // Validate all valid pages
        const pageValidation = validateAllPages(pages);

        // Show validation warnings
        if (pageValidation.warnings.length > 0) {
            console.log('');
            console.log('  [Validation Warnings]');
            pageValidation.warnings.forEach(w => console.log(`    ${w}`));
        }

        // Stop on errors
        if (!pageValidation.valid) {
            console.error('');
            console.error('  [Error] Page validation failed:');
            pageValidation.errors.forEach(e => console.error(`    ${e}`));
            console.error('');
            console.error('  Please fix errors and try again.');
            process.exit(1);
        }

        // Determine first page from config
        const firstPage = config.first_page || config.start_page || null;

        // Validate first_page reference
        if (firstPage && !Object.keys(pages).includes(firstPage)) {
            console.error(`  [Error] first_page/start_page references non-existent page: "${firstPage}"`);
            console.error('  Available pages:', Object.keys(pages).join(', '));
            process.exit(1);
        }

        // Categorize pages for processing
        const newPages = [...states.new];
        const updatedPages = [];
        const unchangedPages = [];

        // Normal pages: check if content changed
        for (const name of states.normal) {
            const pageInfo = pages[name];
            if (pageInfo.meta.hash !== pageInfo.hash) {
                updatedPages.push(name);
            } else {
                unchangedPages.push(name);
            }
        }

        // Pages to delete before recreate
        const pagesToDeleteBeforeRecreate = [];
        for (const item of states.pageIds_missing) {
            pagesToDeleteBeforeRecreate.push(item.id);
            newPages.push(item.name);
            pages[item.name].meta = {};
        }

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

        console.log(`  New: ${newPages.length}, Modified: ${updatedPages.length}, Unchanged: ${unchangedPages.length}`);
        if (pagesToDelete.length > 0) {
            console.log(`  To delete: ${pagesToDelete.length}`);
        }

        // ============================================================
        // Pre-phase: Delete pages that need recreation
        // ============================================================
        if (pagesToDeleteBeforeRecreate.length > 0) {
            console.log('');
            console.log(`[Pre] Deleting pages for recreation... (${pagesToDeleteBeforeRecreate.length})`);

            for (const pageId of pagesToDeleteBeforeRecreate) {
                console.log(`  - ID ${pageId} deleting...`);
                const success = await deletePage(page, labyrinthId, pageId);
                if (success) {
                    pageIds = pageIds.filter(id => id !== pageId);
                    console.log(`    deleted`);
                } else {
                    console.log(`    failed (may not exist)`);
                }
                await new Promise(r => setTimeout(r, 100));
            }

            labyMeta.pageIds = pageIds;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
        }

        // Create new pages
        if (newPages.length > 0) {
            console.log('');
            console.log(`  Creating new pages... (${newPages.length})`);

            for (const name of newPages) {
                const pageData = pages[name].json;
                console.log(`  - ${name}: ${pageData.title}`);

                // Read HTML content
                let html = pages[name].html;
                if (!html) {
                    console.log(`    [warning] No HTML content`);
                    continue;
                }

                await navigateToCreatePage(page, labyrinthId);

                // Find and upload images
                const localImages = findLocalImages(html, contentPath);
                if (localImages.length > 0) {
                    console.log(`    Processing ${localImages.length} images...`);
                    const { cache: newCache, pathMap } = await uploadNewImages(browser, page, localImages, imageCache);
                    imageCache = newCache;

                    labyMeta.images = imageCache;
                    fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');

                    html = replaceLocalImages(html, pathMap);
                }

                const isFirst = (firstPage === name);
                const isEnding = pageData.is_ending || false;
                const answers = pageData.answers || [];
                const hasAnswers = answers.length > 0;

                await fillPageForm(page, {
                    title: pageData.title,
                    bgColor: pageData.background_color || '#000000',
                    isFirst: isFirst,
                    isEnding: isEnding,
                    hasAnswers: hasAnswers,
                    hint: pageData.hint || '',
                    content: html
                });

                // Add answers (or dummy if none but required)
                if (answers.length > 0) {
                    for (const ans of answers) {
                        await addAnswer(page, ans.answer, ans.public || false, ans.explanation || '');
                        console.log(`    answer: "${ans.answer}"`);
                    }
                } else if (hasAnswers) {
                    // Site requires at least one answer for non-ending pages
                    await addAnswer(page, 'temp', false, '');
                }

                const pageId = await submitPageForm(page, labyrinthId, pageData.title);

                if (pageId) {
                    pages[name].meta.id = pageId;
                    pages[name].meta.hash = pages[name].hash;
                    pages[name].meta.is_first = isFirst;
                    pages[name].meta.is_ending = isEnding;
                    writePageMeta(contentPath, name, pages[name].meta);

                    if (!pageIds.includes(pageId)) {
                        pageIds.push(pageId);
                    }

                    console.log(`    created: ID ${pageId}`);
                } else {
                    console.error(`    failed: could not get page ID`);
                }
            }

            labyMeta.pageIds = pageIds;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
        }

        // Build page name -> ID mapping
        const pageIdMap = {};
        for (const [name, pageInfo] of Object.entries(pages)) {
            if (pageInfo.meta.id) {
                pageIdMap[name] = pageInfo.meta.id;
            }
        }

        // Update modified pages
        if (updatedPages.length > 0) {
            console.log('');
            console.log(`  Updating modified pages... (${updatedPages.length})`);

            for (const name of updatedPages) {
                const pageData = pages[name].json;
                const pageMeta = pages[name].meta;
                const pageId = pageMeta.id;

                if (!pageId) continue;

                console.log(`  - ${name}: ${pageData.title}`);

                // Read HTML content
                let html = pages[name].html;
                if (!html) {
                    console.log(`    [warning] No HTML content`);
                    continue;
                }

                // Navigate to editor first (for image upload)
                await navigateToEditPage(page, labyrinthId, pageId);

                // Find and upload images
                const localImages = findLocalImages(html, contentPath);
                if (localImages.length > 0) {
                    console.log(`    Processing ${localImages.length} images...`);
                    const { cache: newCache, pathMap } = await uploadNewImages(browser, page, localImages, imageCache);
                    imageCache = newCache;

                    labyMeta.images = imageCache;
                    fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');

                    html = replaceLocalImages(html, pathMap);
                }

                // Navigate again (upload might have changed page state)
                await navigateToEditPage(page, labyrinthId, pageId);

                // Fill form with full data
                const isFirst = (firstPage === name);
                const isEnding = pageData.is_ending || false;
                const answers = pageData.answers || [];
                const hasAnswers = answers.length > 0;

                await fillPageForm(page, {
                    title: pageData.title,
                    bgColor: pageData.background_color || '#000000',
                    isFirst: isFirst,
                    isEnding: isEnding,
                    hasAnswers: hasAnswers,
                    hint: pageData.hint || '',
                    content: html
                });

                // Clear and re-add answers
                if (hasAnswers) {
                    await clearAnswers(page);

                    for (const ans of answers) {
                        await addAnswer(page, ans.answer, ans.public || false, ans.explanation || '');
                        console.log(`    answer: "${ans.answer}"`);
                    }
                }

                await submitPageForm(page);

                // Update page meta
                pageMeta.hash = pages[name].hash;
                pageMeta.is_first = isFirst;
                pageMeta.is_ending = isEnding;
                writePageMeta(contentPath, name, pageMeta);

                console.log(`    updated`);
            }
        }

        // Set parent connections
        const connections = {};
        const allPagesWithAnswers = [...newPages, ...updatedPages];

        for (const name of allPagesWithAnswers) {
            const pageData = pages[name].json;
            const pageMeta = pages[name].meta;
            const fromPageId = pageMeta.id;

            const answers = pageData.answers || [];
            answers.forEach((ans, idx) => {
                if (ans.next && pageIdMap[ans.next]) {
                    const targetPageId = pageIdMap[ans.next];
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
            });
        }

        const targetPages = Object.keys(connections);
        if (targetPages.length > 0) {
            console.log('');
            console.log(`  Setting page connections... (${targetPages.length} targets)`);

            for (const targetPageId of targetPages) {
                const sources = connections[targetPageId];
                const targetName = Object.entries(pageIdMap).find(([n, id]) => id === targetPageId)?.[0] || targetPageId;

                console.log(`  - ${targetName} (ID: ${targetPageId})`);

                await navigateToEditPage(page, labyrinthId, targetPageId);
                await clearParentConnections(page);

                for (const src of sources) {
                    const success = await setParentConnection(page, src.fromPageId, src.answerIndex);
                    if (success) {
                        console.log(`    <- ${src.fromName} [answer: ${src.answer}]`);
                    } else {
                        console.log(`    <- ${src.fromName} [failed]`);
                    }
                }

                await submitPageForm(page);
                await new Promise(r => setTimeout(r, 100));
            }
        }

        // Delete orphan pages
        if (pagesToDelete.length > 0) {
            console.log('');
            console.log(`  Deleting orphan pages... (${pagesToDelete.length})`);

            for (const pageId of pagesToDelete) {
                console.log(`  - ID ${pageId} deleting...`);
                const success = await deletePage(page, labyrinthId, pageId);
                if (success) {
                    pageIds = pageIds.filter(id => id !== pageId);
                    console.log(`    deleted`);
                } else {
                    console.log(`    failed (may not exist)`);
                    pageIds = pageIds.filter(id => id !== pageId);
                }
                await new Promise(r => setTimeout(r, 100));
            }

            labyMeta.pageIds = pageIds;
            fs.writeFileSync(metaPath, JSON.stringify(labyMeta, null, 4) + '\n', 'utf8');
        }

        // Clean up orphan meta files
        if (metasToDelete.length > 0) {
            console.log('');
            console.log(`Cleaning up meta files... (${metasToDelete.length})`);
            for (const name of metasToDelete) {
                deletePageMeta(contentPath, name);
                console.log(`  - ${name}.meta deleted`);
            }
        }

        console.log('');
        console.log('Cleanup complete');

        // Final summary
        console.log('');
        console.log('=== Upload Complete ===');
        console.log(`Labyrinth ID: ${labyrinthId}`);
        console.log(`Pages: ${Object.keys(pages).length} (known IDs: ${pageIds.length})`);
        console.log(`Image cache: ${Object.keys(imageCache).length}`);
        if (pagesToDelete.length > 0) {
            console.log(`Deleted: ${pagesToDelete.length}`);
        }

    } catch (error) {
        console.error('Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        if (browser) {
            await logout(browser);
        }
    }
}

main();
