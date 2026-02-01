/**
 * Image Upload Module
 * Handles image upload to The Labyrinth site via SmartEditor2
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE_URL = 'https://www.thelabyrinth.co.kr';

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
        return { valid: false, error: `File not found: ${filePath}` };
    }

    // Check file extension
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    if (!IMAGE_CONSTRAINTS.allowedFormats.includes(ext)) {
        return {
            valid: false,
            error: `Unsupported image format: ${ext} (allowed: ${IMAGE_CONSTRAINTS.allowedFormats.join(', ')})`
        };
    }

    // Check file size
    const stats = fs.statSync(filePath);
    if (stats.size > IMAGE_CONSTRAINTS.maxSizeBytes) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        return {
            valid: false,
            error: `Image too large: ${sizeMB}MB (max: ${IMAGE_CONSTRAINTS.maxSizeMB}MB)`
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
        console.error(`[image] Validation failed: ${validation.error}`);
        return null;
    }

    // Get fileActionURL from main page (read-only)
    const fileActionURL = await page.evaluate(() => window.fileActionURL);
    if (!fileActionURL) {
        console.error('[image] fileActionURL not found on page');
        return null;
    }

    // Find SmartEditor2 frame
    const frames = page.frames();
    const editorFrame = frames.find(f => f.url().includes('smarteditor'));
    if (!editorFrame) {
        console.error('[image] SmartEditor2 frame not found');
        return null;
    }

    // Click photo button to open popup using high-level API
    const photoBtn = await editorFrame.$('button.se2_photo');
    if (!photoBtn) {
        console.error('[image] Photo button not found in editor');
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
        console.error('[image] Photo uploader popup not found');
        return null;
    }

    let imageUrl = null;

    try {
        // Set file on input using Puppeteer's uploadFile (this triggers events automatically)
        const fileInput = await popupPage.$('#uploadInputBox');
        if (!fileInput) {
            console.error('[image] File input not found in popup');
            await popupPage.close();
            return null;
        }

        await fileInput.uploadFile(imagePath);
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
        }, { timeout: 30000 });

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
            console.log(`[image] Skipping ${path.basename(imagePath)} (already uploaded)`);
            results[imagePath] = updatedCache[checksum];
            continue;
        }

        console.log(`[image] Uploading ${path.basename(imagePath)}...`);
        const url = await uploadImage(browser, page, imagePath);

        if (url) {
            updatedCache[checksum] = url;
            results[imagePath] = url;
            console.log(`[image] Uploaded: ${url}`);
        } else {
            console.error(`[image] Failed to upload ${path.basename(imagePath)}`);
            results[imagePath] = null;
        }

        // Small delay between uploads
        await new Promise(r => setTimeout(r, 100));
    }

    return { cache: updatedCache, results };
}

/**
 * Find all image references in HTML content
 * @param {string} html - HTML content
 * @returns {string[]} Array of image paths/URLs found
 */
function findImageReferences(html) {
    const images = [];
    const srcRegex = /src=["']([^"']+\.(png|jpg|jpeg|gif|webp))/gi;
    let match;

    while ((match = srcRegex.exec(html)) !== null) {
        images.push(match[1]);
    }

    return images;
}

/**
 * Replace image paths in HTML with uploaded URLs
 * @param {string} html - HTML content with local image paths
 * @param {object} pathToUrlMap - Mapping of local paths to uploaded URLs
 * @returns {string} HTML with replaced image URLs
 */
function replaceImagePaths(html, pathToUrlMap) {
    let result = html;

    for (const [localPath, url] of Object.entries(pathToUrlMap)) {
        if (url) {
            // Replace various path formats
            const basename = path.basename(localPath);
            const patterns = [
                new RegExp(`src=["']([^"']*${basename})["']`, 'gi'),
                new RegExp(`url\\(["']?([^"'\\)]*${basename})["']?\\)`, 'gi')
            ];

            for (const pattern of patterns) {
                result = result.replace(pattern, (match, p1) => {
                    return match.replace(p1, url);
                });
            }
        }
    }

    return result;
}

module.exports = {
    calculateChecksum,
    validateImage,
    uploadImage,
    uploadImages,
    findImageReferences,
    replaceImagePaths,
    IMAGE_CONSTRAINTS
};
