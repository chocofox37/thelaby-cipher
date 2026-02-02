/**
 * The Labyrinth - Labyrinth Management Module
 * Handles labyrinth creation and management via Puppeteer
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateRandomId } = require('./image');

const REGISTER_URL = 'https://www.thelabyrinth.co.kr/labyrinth/laby/making/registLabyrinth.do';
const IMAGE_POPUP_URL = 'https://www.thelabyrinth.co.kr/labyrinth/com/comImageFilePopup.do';

/**
 * Default labyrinth config values (site defaults)
 */
const LABYRINTH_DEFAULTS = {
    // Basic info
    title: '',                   // Labyrinth name (required)
    image: '',                   // Title image (380x100)
    description: '',             // Description (max 500 chars)
    tags: [],                    // Tags (1-5)

    // Settings
    is_event: false,             // Event labyrinth
    allow_rating: true,          // Allow rating
    rating_threshold: 1,         // Rating threshold: 0/'clear' = after clear, N = after N pages
    show_difficulty: true,       // Show difficulty
    show_page_count: false,      // Show total page count
    show_ending_count: false,    // Show ending count
    show_badend_count: false,    // Show bad ending count
    clear_visibility: 'full',    // Clear visibility: 'hidden', 'count', 'list', 'full'
    show_answer_rate: false,     // Show answer rate per question
    block_right_click: false,    // Block right-click/view source
    login_required: false,       // Members only

    // Page settings
    start_page: ''               // Start page
};

/**
 * Validation constraints
 */
const VALIDATION = {
    title: { required: true, maxLength: 100 },
    description: { maxLength: 500 },
    tags: { minLength: 0, maxLength: 5 }
};

/**
 * clear_visibility string to form value mapping
 */
const CLEAR_VISIBILITY_MAP = {
    'hidden': '0',
    'count': '1',
    'list': '2',
    'full': '3'
};

/**
 * Tag name to ID mapping (supports both English and Korean)
 */
const TAG_MAP = {
    // English symbols
    'problem': 1,
    'story': 2,
    'expert': 3,
    'no-search': 4,
    'search': 5,
    'specific-person': 6,
    'event': 7,
    'parody': 8,
    'movie': 9,
    'tv': 10,
    'comic': 11,
    'singer': 12,
    'actor': 13,
    'nonsense': 14,
    'cute': 15,
    'game': 16,
    'long': 17,
    'short': 18,
    'horror': 19,
    'escape': 20,
    'puzzle': 21,
    'mobile-ok': 22,
    'no-mobile': 23,
    'streaming-ok': 24,

    // Korean names
    '문제': 1,
    '스토리': 2,
    '전문지식': 3,
    '검색불필요': 4,
    '검색필요': 5,
    '특정인물': 6,
    '이벤트': 7,
    '패러디': 8,
    '영화': 9,
    'TV프로그램': 10,
    '만화': 11,
    '가수': 12,
    '배우': 13,
    '넌센스': 14,
    '귀염뽀짝': 15,
    '게임': 16,
    '장편미궁': 17,
    '단편미궁': 18,
    '공포': 19,
    '방탈출': 20,
    '퍼즐': 21,
    '모바일가능': 22,
    '모바일불가능': 23,
    '방송송출허용': 24
};

/**
 * Mapping: config key -> form field info
 */
const FIELD_MAP = {
    // Text fields
    title: { selector: '#labyrinthNm', type: 'text' },
    description: { selector: '#labyrinthDc', type: 'text' },

    // Checkboxes
    show_difficulty: { selector: 'input[name="levelYsno"]', type: 'checkbox' },
    show_page_count: { selector: 'input[name="questCntOpen"]', type: 'checkbox' },
    show_ending_count: { selector: 'input[name="endCntOpen"]', type: 'checkbox' },
    show_badend_count: { selector: 'input[name="badendCntOpen"]', type: 'checkbox' },
    show_answer_rate: { selector: 'input[name="answerPerOpen"]', type: 'checkbox' },
    login_required: { selector: 'input[name="onlyLoginFlg"]', type: 'checkbox' },
    block_right_click: { selector: 'input[name="pageBlockFlg"]', type: 'checkbox' },
    allow_rating: { selector: 'input[name="evalYsno"]', type: 'checkbox' },
    is_event: { selector: 'input[name="eventYsno"]', type: 'checkbox' },

    // Special types (handled separately)
    clear_visibility: { selector: 'input[name="questClearOpenType"]', type: 'clear_visibility' },
    rating_threshold: { selector: 'select[name="evalStandardCnt"]', type: 'rating_threshold' }
};

/**
 * Normalize labyrinth config with defaults
 */
function normalizeConfig(config) {
    return { ...LABYRINTH_DEFAULTS, ...config };
}

/**
 * Validate labyrinth config
 * @param {Object} config - labyrinth config
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateConfig(config) {
    const errors = [];
    const normalized = normalizeConfig(config);

    // Required: title
    if (!normalized.title || normalized.title.trim() === '') {
        errors.push('title 필드가 필요합니다.');
    } else if (normalized.title.length > VALIDATION.title.maxLength) {
        errors.push(`title이 ${VALIDATION.title.maxLength}자를 초과합니다.`);
    }

    // Description length
    if (normalized.description && normalized.description.length > VALIDATION.description.maxLength) {
        errors.push(`description이 ${VALIDATION.description.maxLength}자를 초과합니다. (현재: ${normalized.description.length}자)`);
    }

    // Tags count
    if (normalized.tags && normalized.tags.length > VALIDATION.tags.maxLength) {
        errors.push(`태그는 최대 ${VALIDATION.tags.maxLength}개까지 가능합니다.`);
    }

    // Validate tag names
    if (normalized.tags && normalized.tags.length > 0) {
        const invalidTags = normalized.tags.filter(tag =>
            typeof tag === 'string' && !TAG_MAP[tag]
        );
        if (invalidTags.length > 0) {
            errors.push(`알 수 없는 태그: ${invalidTags.join(', ')}`);
        }
    }

    // Image validation
    if (normalized.image) {
        const ext = normalized.image.split('.').pop()?.toLowerCase();
        const allowedExts = ['bmp', 'jpg', 'jpeg', 'gif', 'png'];
        if (!allowedExts.includes(ext)) {
            errors.push(`이미지 형식이 잘못되었습니다. (허용: ${allowedExts.join(', ')})`);
        }
    }

    // clear_visibility validation
    const validVisibility = ['hidden', 'count', 'list', 'full'];
    if (normalized.clear_visibility && !validVisibility.includes(normalized.clear_visibility)) {
        errors.push(`clear_visibility 값이 잘못되었습니다. (허용: ${validVisibility.join(', ')})`);
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Convert rating_threshold to form value
 * @param {number|string} value - 0, 'clear', or positive number
 * @returns {string} Form value ('0' for clear, number string otherwise)
 */
function ratingThresholdToFormValue(value) {
    if (value === 'clear' || value === 0) {
        return '0';
    }
    return String(value);
}

/**
 * Convert tag names to tag IDs
 * @param {string[]} tags - Array of tag names
 * @returns {number[]} Array of tag IDs
 */
function tagsToIds(tags) {
    if (!Array.isArray(tags)) return [];

    const ids = [];
    for (const tag of tags) {
        // Support both name and ID
        if (typeof tag === 'number') {
            ids.push(tag);
        } else if (typeof tag === 'string') {
            const id = TAG_MAP[tag];
            if (id) {
                ids.push(id);
            } else {
                console.warn(`[labyrinth] Unknown tag: ${tag}`);
            }
        }
    }
    return ids.slice(0, 5); // Max 5 tags
}

/**
 * Apply tag selection to form
 * @param {Page} page - Puppeteer page instance
 * @param {string[]|number[]} tags - Array of tag names or IDs
 */
async function applyTags(page, tags) {
    const tagIds = tagsToIds(tags);
    if (tagIds.length === 0) return;

    console.log(`[labyrinth] Selecting tags: ${tagIds.join(', ')}`);

    // First, deselect all currently selected tags using high-level API
    const selectedTags = await page.$$('span.tag.tag_selected');
    for (const tag of selectedTags) {
        await tag.click();
        await new Promise(r => setTimeout(r, 100));
    }

    // Select the specified tags
    for (const tagId of tagIds) {
        const selector = `span.tag[data-tagseqn="${tagId}"]:not(.tag_selected)`;
        const tagElement = await page.$(selector);
        if (tagElement) {
            await tagElement.click();
            await new Promise(r => setTimeout(r, 100));
        }
    }
}

/**
 * Upload title image via popup
 * @param {Page} page - Puppeteer page instance (main registration page)
 * @param {Browser} browser - Puppeteer browser instance
 * @param {string} imagePath - Absolute path to image file
 * @returns {Promise<string>} fileId of uploaded image
 */
async function uploadTitleImage(page, browser, imagePath) {
    if (!fs.existsSync(imagePath)) {
        throw new Error(`타이틀 이미지를 찾을 수 없습니다: ${imagePath}`);
    }

    // Validate file extension
    const ext = path.extname(imagePath).toLowerCase();
    const allowedExts = ['.bmp', '.jpg', '.jpeg', '.gif', '.png'];
    if (!allowedExts.includes(ext)) {
        throw new Error(`지원하지 않는 이미지 형식입니다: ${ext} (지원 형식: ${allowedExts.join(', ')})`);
    }

    // Check file size (max 5MB)
    const stats = fs.statSync(imagePath);
    if (stats.size > 5 * 1024 * 1024) {
        throw new Error(`이미지 파일이 너무 큽니다: ${(stats.size / 1024 / 1024).toFixed(2)}MB (최대 5MB)`);
    }

    // Create temp file with random suffix to bypass site cache
    const basename = path.basename(imagePath, ext);
    const randomId = generateRandomId(8);
    const tempFilename = `${basename}_${randomId}${ext}`;
    const tempPath = path.join(os.tmpdir(), tempFilename);

    // Copy original file to temp location
    fs.copyFileSync(imagePath, tempPath);

    // Wait for popup to open when we click the button
    const popupPromise = new Promise((resolve) => {
        browser.once('targetcreated', async (target) => {
            const popupPage = await target.page();
            if (popupPage) {
                resolve(popupPage);
            }
        });
    });

    // Click the image registration button to open popup
    await page.click('#imgBtn');

    // Wait for the popup window to open
    const popupPage = await popupPromise;
    await popupPage.waitForSelector('#atchFileUpload', { timeout: 10000 });

    try {
        // Clear fileId on parent page first to detect new upload
        await page.$eval('#fileId', el => el.value = '');

        // Check if there's an existing file and delete it first (read-only check)
        const deleteLink = await popupPage.$('a[onclick*="fn_deleteFile"]');

        if (deleteLink) {
            const existingFileId = await deleteLink.evaluate(el => {
                const onclick = el.getAttribute('onclick');
                const match = onclick.match(/fn_deleteFile\(['"]?(\d+)['"]?\)/);
                return match ? match[1] : null;
            });

            if (existingFileId) {
                console.log(`[labyrinth] Deleting existing image (fileId: ${existingFileId})...`);

                // Click delete link - this opens a confirm popup
                await deleteLink.click();

                // Wait for confirm popup and click OK
                await new Promise(resolve => setTimeout(resolve, 100));
                await popupPage.waitForSelector('#labyPopupOk', { visible: true, timeout: 5000 });
                await popupPage.click('#labyPopupOk');

                // Wait for page to reload after deletion
                await popupPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
                await popupPage.waitForSelector('#atchFileUpload', { timeout: 10000 });
            }
        }

        // Set file on the input element (use temp file with random suffix)
        const fileInput = await popupPage.$('#atchFileUpload');
        await fileInput.uploadFile(tempPath);

        // Small delay to ensure file is processed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Click upload button - the popup will call setFileInfo on parent and close
        await popupPage.click('input[value="파일등록"]');

        // Wait for fileId to be set (we cleared it above)
        await page.waitForFunction(() => {
            const el = document.querySelector('#fileId');
            return el && el.value && el.value.trim() !== '';
        }, { timeout: 30000 });

        const fileId = await page.$eval('#fileId', el => el.value || '').catch(() => '');
        console.log(`[labyrinth] Image uploaded, fileId: ${fileId}`);

    } finally {
        // Try to close popup if still open
        try {
            if (!popupPage.isClosed()) {
                await popupPage.close();
            }
        } catch (e) {
            // Popup might already be closed
        }
        // Always clean up temp file
        try { fs.unlinkSync(tempPath); } catch (e) {}
    }
}

/**
 * Compute hash for labyrinth config (including image file content)
 * @param {Object} config - labyrinth config
 * @param {string} labyPath - path to labyrinth folder (for resolving image path)
 * @returns {string} MD5 hash
 */
function computeLabyrinthHash(config, labyPath = '') {
    const normalized = normalizeConfig(config);

    // Include image file hash if image is specified
    if (normalized.image && labyPath) {
        const imagePath = path.join(labyPath, normalized.image);
        if (fs.existsSync(imagePath)) {
            const imageBuffer = fs.readFileSync(imagePath);
            normalized._image_hash = crypto.createHash('md5')
                .update(imageBuffer).digest('hex');
        }
    }

    const content = JSON.stringify(normalized);
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Apply config to form on page
 * @param {Page} page - Puppeteer page instance
 * @param {Object} config - labyrinth config
 * @param {Object} options - additional options
 * @param {Browser} options.browser - Puppeteer browser instance (for image upload)
 * @param {string} options.labyPath - path to labyrinth folder (for resolving image path)
 */
async function applyConfigToForm(page, config, options = {}) {
    const { browser, labyPath } = options;
    const normalized = normalizeConfig(config);

    for (const [key, value] of Object.entries(normalized)) {
        const field = FIELD_MAP[key];
        if (!field) continue;

        // Check if element exists before interacting
        const element = await page.$(field.selector);
        if (!element) {
            console.log(`[labyrinth] Skipping ${key}: selector not found`);
            continue;
        }

        switch (field.type) {
            case 'text':
                // Clear field using triple-click to select all, then backspace
                await page.click(field.selector, { clickCount: 3 });
                await page.keyboard.press('Backspace');
                if (value) {
                    await page.type(field.selector, String(value));
                }
                break;

            case 'checkbox':
                // Read current state, click only if different
                const isChecked = await page.$eval(field.selector, el => el.checked);
                if (isChecked !== Boolean(value)) {
                    await page.click(field.selector);
                }
                break;

            case 'clear_visibility':
                const radioValue = CLEAR_VISIBILITY_MAP[value] || '0';
                const radioSelector = `${field.selector}[value="${radioValue}"]`;
                const radioEl = await page.$(radioSelector);
                if (radioEl) {
                    const isRadioChecked = await page.$eval(radioSelector, el => el.checked);
                    if (!isRadioChecked) {
                        await page.click(radioSelector);
                    }
                }
                break;

            case 'rating_threshold':
                const selectValue = ratingThresholdToFormValue(value);
                await page.select(field.selector, selectValue);
                break;
        }
    }

    // Handle tags separately (not in FIELD_MAP)
    if (normalized.tags && normalized.tags.length > 0) {
        await applyTags(page, normalized.tags);
    }

    // Handle image upload
    if (normalized.image && browser && labyPath) {
        const imagePath = path.join(labyPath, normalized.image);
        await uploadTitleImage(page, browser, imagePath);
    }
}

/**
 * Create a new labyrinth
 * @param {Page} page - Puppeteer page instance (already logged in)
 * @param {Object} config - labyrinth config
 * @param {Object} options - additional options
 * @param {Browser} options.browser - Puppeteer browser instance
 * @param {string} options.labyPath - path to labyrinth folder
 * @returns {Promise<string>} Created labyrinth ID (labyrinthSeqn)
 */
async function createLabyrinth(page, config, options = {}) {
    if (!config.title) {
        throw new Error('미궁 제목이 필요합니다');
    }

    console.log('[labyrinth] Navigating to registration page...');
    await page.goto(REGISTER_URL, { waitUntil: 'networkidle2' });

    console.log('[labyrinth] Filling form...');
    await applyConfigToForm(page, config, options);

    // Click create button
    console.log('[labyrinth] Submitting form...');
    await page.click('#createLabyrinth');

    // Wait for custom confirm popup
    console.log('[labyrinth] Waiting for confirm popup...');
    await page.waitForSelector('#labyPopupOk', { visible: true, timeout: 5000 });

    // Click confirm button and wait for navigation
    console.log('[labyrinth] Clicking confirm...');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#labyPopupOk')
    ]);

    // Extract labyrinthSeqn
    const currentUrl = page.url();
    console.log('[labyrinth] Current URL after creation:', currentUrl);

    let labyrinthSeqn = null;

    // Try URL parameter
    const urlMatch = currentUrl.match(/labyrinthSeqn=(\d+)/);
    if (urlMatch) {
        labyrinthSeqn = urlMatch[1];
    }

    // Try hidden input
    if (!labyrinthSeqn) {
        labyrinthSeqn = await page.evaluate(() => {
            const input = document.querySelector('#labyrinthSeqn, input[name="labyrinthSeqn"]');
            return input ? input.value : null;
        });
    }

    // Try page content
    if (!labyrinthSeqn) {
        const pageContent = await page.content();
        const contentMatch = pageContent.match(/labyrinthSeqn["\s:=]+["']?(\d+)/i);
        if (contentMatch) {
            labyrinthSeqn = contentMatch[1];
        }
    }

    if (!labyrinthSeqn) {
        throw new Error('미궁 생성 후 ID를 가져올 수 없습니다. 사이트를 확인해주세요.');
    }

    console.log('[labyrinth] Created labyrinth ID:', labyrinthSeqn);
    return labyrinthSeqn;
}

/**
 * Update labyrinth info on the site
 * @param {Page} page - Puppeteer page instance (already logged in)
 * @param {string} labyrinthSeqn - Labyrinth ID
 * @param {Object} config - labyrinth config
 * @param {Object} options - additional options
 * @param {Browser} options.browser - Puppeteer browser instance
 * @param {string} options.labyPath - path to labyrinth folder
 */
async function updateLabyrinth(page, labyrinthSeqn, config, options = {}) {
    const editUrl = `${REGISTER_URL}?labyrinthSeqn=${labyrinthSeqn}`;
    console.log('[labyrinth] Navigating to edit page...');
    await page.goto(editUrl, { waitUntil: 'networkidle2' });

    console.log('[labyrinth] Applying config...');
    await applyConfigToForm(page, config, options);

    // Click modify button
    console.log('[labyrinth] Submitting update...');
    await page.click('#modifyLabyrinth');

    // Wait for custom confirm popup
    await page.waitForSelector('#labyPopupOk', { visible: true, timeout: 5000 });

    // Click confirm
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#labyPopupOk')
    ]);

    console.log('[labyrinth] Updated successfully');
}

module.exports = {
    createLabyrinth,
    updateLabyrinth,
    computeLabyrinthHash,
    normalizeConfig,
    validateConfig,
    tagsToIds,
    LABYRINTH_DEFAULTS,
    TAG_MAP,
    VALIDATION,
    REGISTER_URL
};
