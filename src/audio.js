/**
 * Audio Upload Module
 * Handles audio (MP3, WAV) upload to The Labyrinth site via SmartEditor2.
 *
 * Editor pattern (mirrors image.js but differs in URL extraction):
 *   1. Click button.se2_audio on the editor toolbar.
 *   2. Popup "음악 첨부하기" opens (form id editor_upaudio, script attach_audio.js).
 *   3. Set file on #uploadInputBox, click #btn_confirm.
 *   4. Popup closes immediately AND an <audio>/<embed> node is auto-inserted
 *      into the editor's WYSIWYG body — the URL is obtained from that node,
 *      not from a popup iframe (the image upload pattern).
 *   5. The inserted node is removed so cipher's later HTML-mode setContent
 *      does not clash.
 *
 * Site constraints (from the popup): MP3, WAV; <= 5 MB.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { log } = require('./logger');
const { generateRandomId, calculateChecksum } = require('./image');

const AUDIO_CONSTRAINTS = {
    allowedFormats: ['mp3', 'wav'],
    maxSizeBytes: 5 * 1024 * 1024,
    maxSizeMB: 5
};

function validateAudio(filePath) {
    if (!fs.existsSync(filePath)) {
        return { valid: false, error: `파일을 찾을 수 없습니다: ${filePath}` };
    }
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    if (!AUDIO_CONSTRAINTS.allowedFormats.includes(ext)) {
        return {
            valid: false,
            error: `지원하지 않는 오디오 형식: ${ext} (허용: ${AUDIO_CONSTRAINTS.allowedFormats.join(', ')})`
        };
    }
    const stats = fs.statSync(filePath);
    if (stats.size > AUDIO_CONSTRAINTS.maxSizeBytes) {
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        return {
            valid: false,
            error: `오디오 크기 초과: ${sizeMB}MB (최대: ${AUDIO_CONSTRAINTS.maxSizeMB}MB)`
        };
    }
    return { valid: true, error: null };
}

/**
 * Read the current set of audio-like sources in the SmartEditor2 WYSIWYG
 * area. Used to diff before/after the upload to identify the inserted node.
 */
async function snapshotEditorAudio(editorFrame) {
    return await editorFrame.evaluate(() => {
        const area = document.querySelector('.se2_input_wysiwyg');
        if (!area) return [];
        const nodes = area.querySelectorAll('audio, embed, source, a');
        const sources = [];
        for (const n of nodes) {
            const src = n.getAttribute('src') || n.getAttribute('href') || '';
            if (src && /\.(mp3|wav)(\?.*)?$/i.test(src)) sources.push(src);
        }
        return sources;
    });
}

/**
 * Remove the inserted audio node(s) so the editor stays clean for the
 * later HTML-mode setContent. We only remove nodes whose src matches one
 * of the freshly-added URLs.
 */
async function removeInsertedAudio(editorFrame, newSrcs) {
    if (!newSrcs || newSrcs.length === 0) return;
    await editorFrame.evaluate((srcs) => {
        const area = document.querySelector('.se2_input_wysiwyg');
        if (!area) return;
        const matches = (el) => {
            const s = el.getAttribute('src') || el.getAttribute('href') || '';
            return srcs.includes(s);
        };
        for (const sel of ['audio', 'embed', 'source', 'a']) {
            for (const el of Array.from(area.querySelectorAll(sel))) {
                if (matches(el)) el.remove();
            }
        }
    }, newSrcs);
}

/**
 * Upload a single audio file to the site.
 * @param {object} browser - Puppeteer browser instance
 * @param {object} page - Main page (already on page editor)
 * @param {string} audioPath - Local path to the audio file
 * @returns {Promise<string|null>} Uploaded audio URL or null on failure
 */
async function uploadAudio(browser, page, audioPath) {
    const validation = validateAudio(audioPath);
    if (!validation.valid) {
        log.fail(`오디오 검증 실패: ${validation.error}`);
        return null;
    }

    const ext = path.extname(audioPath);
    const basename = path.basename(audioPath, ext);
    const tempFilename = `${basename}_${generateRandomId(8)}${ext}`;
    const tempPath = path.join(os.tmpdir(), tempFilename);
    fs.copyFileSync(audioPath, tempPath);

    const frames = page.frames();
    const editorFrame = frames.find(f => f.url().includes('smarteditor'));
    if (!editorFrame) {
        log.fail('에디터를 찾을 수 없습니다');
        try { fs.unlinkSync(tempPath); } catch (e) {}
        return null;
    }

    // Snapshot existing audio refs to diff after upload.
    const before = await snapshotEditorAudio(editorFrame);

    const audioBtn = await editorFrame.$('button.se2_audio');
    if (!audioBtn) {
        log.fail('음악 버튼을 찾을 수 없습니다');
        try { fs.unlinkSync(tempPath); } catch (e) {}
        return null;
    }
    await audioBtn.click();

    // Locate the popup (matches by title or form id; URL pattern is not stable).
    let popupPage = null;
    const startWait = Date.now();
    while (Date.now() - startWait < 3000) {
        const allPages = await browser.pages();
        for (const p of allPages) {
            try {
                const has = await p.evaluate(() =>
                    !!document.querySelector('#editor_upaudio') ||
                    !!document.querySelector('form[name="editor_upaudio"]')
                );
                if (has) { popupPage = p; break; }
            } catch (e) { /* not loaded yet */ }
        }
        if (popupPage) break;
        await new Promise(r => setTimeout(r, 100));
    }

    if (!popupPage) {
        log.fail('음악 업로드 팝업을 찾을 수 없습니다');
        try { fs.unlinkSync(tempPath); } catch (e) {}
        return null;
    }

    let audioUrl = null;

    try {
        const fileInput = await popupPage.$('#uploadInputBox');
        if (!fileInput) {
            log.fail('파일 입력창을 찾을 수 없습니다');
            try { await popupPage.close(); } catch (e) {}
            try { fs.unlinkSync(tempPath); } catch (e) {}
            return null;
        }
        await fileInput.uploadFile(tempPath);
        await new Promise(r => setTimeout(r, 200));

        // Confirm button is an <a> wrapping <img id="btn_confirm">. Click via JS
        // to dispatch on whichever element actually has the onclick handler.
        const closeWatcher = new Promise(resolve => popupPage.once('close', resolve));
        await popupPage.evaluate(() => {
            const img = document.querySelector('#btn_confirm');
            if (!img) return;
            const link = img.closest('a');
            (link || img).click();
        });

        // Popup closes itself after a successful upload.
        await Promise.race([
            closeWatcher,
            new Promise(r => setTimeout(r, 30000))
        ]);

        // Give the editor a tick to receive the inserted node.
        await new Promise(r => setTimeout(r, 400));

        const after = await snapshotEditorAudio(editorFrame);
        const fresh = after.filter(s => !before.includes(s));
        if (fresh.length === 0) {
            log.fail('업로드된 오디오 URL을 에디터에서 찾지 못했습니다');
        } else {
            audioUrl = fresh[0];
            // Remove inserted node(s) so HTML-mode setContent stays in control.
            await removeInsertedAudio(editorFrame, fresh);
        }
    } finally {
        try { if (!popupPage.isClosed()) await popupPage.close(); } catch (e) {}
        try { fs.unlinkSync(tempPath); } catch (e) {}
    }

    return audioUrl;
}

/**
 * Upload multiple audio files with checksum-based deduplication.
 * @returns {Promise<{cache, results}>}
 */
async function uploadAudios(browser, page, audioPaths, audioCache = {}) {
    const updatedCache = { ...audioCache };
    const results = {};

    for (const audioPath of audioPaths) {
        const checksum = calculateChecksum(audioPath);

        if (updatedCache[checksum]) {
            log.verbose(`      ${path.basename(audioPath)} (이미 업로드됨)`);
            results[audioPath] = updatedCache[checksum];
            continue;
        }

        log.verbose(`      ${path.basename(audioPath)} 업로드 중...`);
        const url = await uploadAudio(browser, page, audioPath);

        if (url) {
            updatedCache[checksum] = url;
            results[audioPath] = url;
            log.verbose(`      업로드됨: ${url}`);
        } else {
            log.fail(`${path.basename(audioPath)} 업로드 실패`);
            results[audioPath] = null;
        }

        await new Promise(r => setTimeout(r, 100));
    }

    return { cache: updatedCache, results };
}

module.exports = {
    AUDIO_CONSTRAINTS,
    validateAudio,
    uploadAudio,
    uploadAudios
};
