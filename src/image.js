/**
 * Image Upload Module
 * Handles image upload to The Labyrinth site via SmartEditor2
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const os = require('os');
const { log } = require('./logger');

/**
 * Generate random alphanumeric string
 * @param {number} length - Length of the string (default: 8)
 * @returns {string} Random alphanumeric string
 */
function generateRandomId(length = 8) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars[bytes[i] % chars.length];
    }
    return result;
}

/**
 * Image validation constraints
 */
const IMAGE_CONSTRAINTS = {
    allowedFormats: ['bmp', 'jpg', 'jpeg', 'gif', 'png'],
    maxSizeBytes: 2 * 1024 * 1024, // 2MB for content images
    maxSizeMB: 2
};

/**
 * Validate image file
 * @param {string} filePath - Path to image file
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateImage(filePath) {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return { valid: false, error: `파일을 찾을 수 없습니다: ${filePath}` };
    }

    // Check file extension
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    if (!IMAGE_CONSTRAINTS.allowedFormats.includes(ext)) {
        return {
            valid: false,
            error: `지원하지 않는 이미지 형식: ${ext} (허용: ${IMAGE_CONSTRAINTS.allowedFormats.join(', ')})`
        };
    }

    // Check file size
    const stats = fs.statSync(filePath);
    if (stats.size > IMAGE_CONSTRAINTS.maxSizeBytes) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        return {
            valid: false,
            error: `이미지 크기 초과: ${sizeMB}MB (최대: ${IMAGE_CONSTRAINTS.maxSizeMB}MB)`
        };
    }

    return { valid: true, error: null };
}

/**
 * Calculate MD5 checksum of a file
 * @param {string} filePath - Path to the file
 * @returns {string} MD5 checksum
 */
function calculateChecksum(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

/**
 * Upload a single image to the site
 * @param {object} browser - Puppeteer browser instance
 * @param {object} page - Main page (already on page editor)
 * @param {string} imagePath - Local path to the image file
 * @returns {Promise<string|null>} Uploaded image URL or null on failure
 */
async function uploadImage(browser, page, imagePath) {
    // Validate image first
    const validation = validateImage(imagePath);
    if (!validation.valid) {
        log.fail(`이미지 검증 실패: ${validation.error}`);
        return null;
    }

    // Create temp file with random suffix to bypass site cache
    const ext = path.extname(imagePath);
    const basename = path.basename(imagePath, ext);
    const randomId = generateRandomId(8);
    const tempFilename = `${basename}_${randomId}${ext}`;
    const tempPath = path.join(os.tmpdir(), tempFilename);

    // Copy original file to temp location
    fs.copyFileSync(imagePath, tempPath);

    // Get fileActionURL from main page (read-only)
    const fileActionURL = await page.evaluate(() => window.fileActionURL);
    if (!fileActionURL) {
        log.fail('페이지에서 업로드 URL을 찾을 수 없습니다');
        fs.unlinkSync(tempPath);
        return null;
    }

    // Find SmartEditor2 frame
    const frames = page.frames();
    const editorFrame = frames.find(f => f.url().includes('smarteditor'));
    if (!editorFrame) {
        log.fail('에디터를 찾을 수 없습니다');
        fs.unlinkSync(tempPath);
        return null;
    }

    // Click photo button to open popup using high-level API
    const photoBtn = await editorFrame.$('button.se2_photo');
    if (!photoBtn) {
        log.fail('이미지 버튼을 찾을 수 없습니다');
        fs.unlinkSync(tempPath);
        return null;
    }
    await photoBtn.click();

    // Wait for popup to open
    await new Promise(r => setTimeout(r, 100));

    // Find popup page
    const allPages = await browser.pages();
    let popupPage = null;
    for (const p of allPages) {
        if (p.url().includes('photo_uploader')) {
            popupPage = p;
            break;
        }
    }

    if (!popupPage) {
        log.fail('이미지 업로드 팝업을 찾을 수 없습니다');
        fs.unlinkSync(tempPath);
        return null;
    }

    let imageUrl = null;

    try {
        // Set file on input using Puppeteer's uploadFile (this triggers events automatically)
        const fileInput = await popupPage.$('#uploadInputBox');
        if (!fileInput) {
            log.fail('파일 입력창을 찾을 수 없습니다');
            await popupPage.close();
            fs.unlinkSync(tempPath);
            return null;
        }

        await fileInput.uploadFile(tempPath);
        await new Promise(r => setTimeout(r, 100));

        // Click confirm button to upload
        await popupPage.click('#btn_confirm');

        // Wait for image URL to appear in iframe
        await popupPage.waitForFunction(() => {
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (doc && doc.body) {
                        if (doc.body.innerHTML.match(/<img[^>]+src="[^"]+"/i) ||
                            doc.body.innerHTML.match(/filePath\s*=\s*["'][^"']+["']/)) {
                            return true;
                        }
                    }
                } catch (e) {}
            }
            return false;
        }, { timeout: 20000 });

        // Extract image URL from iframe
        const iframeData = await popupPage.evaluate(() => {
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (doc && doc.body) {
                        const imgMatch = doc.body.innerHTML.match(/<img[^>]+src="([^"]+)"/i);
                        if (imgMatch) {
                            return { url: imgMatch[1] };
                        }
                        const pathMatch = doc.body.innerHTML.match(/filePath\s*=\s*["']([^"']+)["']/);
                        if (pathMatch) {
                            let filePath = pathMatch[1];
                            filePath = filePath.replace('/home/labyrinth/tomcat6/webapps/labyrinth', '/labyrinth');
                            return { url: filePath };
                        }
                    }
                } catch (e) {}
            }
            return { url: null };
        });

        imageUrl = iframeData.url;

    } finally {
        // Always close popup
        try { await popupPage.close(); } catch (e) {}
        // Always clean up temp file
        try { fs.unlinkSync(tempPath); } catch (e) {}
    }

    return imageUrl;
}

/**
 * Upload multiple images with checksum-based deduplication
 * @param {object} browser - Puppeteer browser instance
 * @param {object} page - Main page (on page editor)
 * @param {string[]} imagePaths - Array of local image paths
 * @param {object} imageCache - Existing image cache (checksum -> URL mapping)
 * @returns {Promise<object>} Updated image cache with new mappings
 */
async function uploadImages(browser, page, imagePaths, imageCache = {}) {
    const updatedCache = { ...imageCache };
    const results = {};

    for (const imagePath of imagePaths) {
        const checksum = calculateChecksum(imagePath);

        // Check if already uploaded
        if (updatedCache[checksum]) {
            log.verbose(`      ${path.basename(imagePath)} (이미 업로드됨)`);
            results[imagePath] = updatedCache[checksum];
            continue;
        }

        log.verbose(`      ${path.basename(imagePath)} 업로드 중...`);
        const url = await uploadImage(browser, page, imagePath);

        if (url) {
            updatedCache[checksum] = url;
            results[imagePath] = url;
            log.verbose(`      업로드됨: ${url}`);
        } else {
            log.fail(`${path.basename(imagePath)} 업로드 실패`);
            results[imagePath] = null;
        }

        // Small delay between uploads
        await new Promise(r => setTimeout(r, 100));
    }

    return { cache: updatedCache, results };
}

module.exports = {
    generateRandomId,
    calculateChecksum,
    validateImage,
    uploadImage,
    uploadImages,
    IMAGE_CONSTRAINTS
};
