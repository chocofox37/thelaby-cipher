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
 * Scan the editor frame (its document, all nested iframes, and the
 * HTML-mode syntax textarea) for any element/attribute referencing an
 * .mp3 / .wav file. Returns a flat array of URLs.
 *
 * We deliberately cast a wide net because SmartEditor2 may render the
 * inserted audio as <audio>, <embed>, <a href>, or inside the WYSIWYG
 * iframe — and pre-existing img buttons (btn_confirm.png etc.) must be
 * excluded.
 */
async function scanEditorAudio(editorFrame) {
    return await editorFrame.evaluate(() => {
        const isAudio = (s) => s && /\.(mp3|wav)(\?[^"']*)?$/i.test(s);
        const sources = [];

        const harvest = (root) => {
            if (!root) return;
            const nodes = root.querySelectorAll('audio, embed, source, a, object, [src], [href], [data-src]');
            for (const n of nodes) {
                const candidates = [
                    n.getAttribute && n.getAttribute('src'),
                    n.getAttribute && n.getAttribute('href'),
                    n.getAttribute && n.getAttribute('data-src')
                ];
                for (const s of candidates) if (isAudio(s)) sources.push(s);
            }
        };

        // 1. Editor document body
        harvest(document.body);
        // 2. Any nested iframes (WYSIWYG body usually lives in one)
        for (const f of document.querySelectorAll('iframe')) {
            try {
                const doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
                if (doc && doc.body) harvest(doc.body);
            } catch (e) { /* cross-origin or not ready */ }
        }
        // 3. HTML-mode syntax textarea (if SE2 is currently in HTML mode)
        const syntax = document.querySelector('.se2_input_syntax');
        if (syntax && syntax.value) {
            const re = /(?:src|href)=["']([^"']+\.(?:mp3|wav)(?:\?[^"']*)?)["']/gi;
            let m;
            while ((m = re.exec(syntax.value)) !== null) sources.push(m[1]);
        }
        return sources;
    });
}

/**
 * Try to parse an audio URL out of a server response body.
 * SmartEditor2 attach_audio.js typically returns something with the
 * uploaded path in a JS variable or as part of an embed/audio snippet.
 */
function extractAudioUrlFromBody(text) {
    if (!text) return null;
    const patterns = [
        /['"]([^'"\s<>]+\.(?:mp3|wav)(?:\?[^'"]*)?)['"]/i,
        /filePath\s*[:=]\s*['"]([^'"]+)['"]/i,
        /sFileName\s*[:=]\s*['"]([^'"]+)['"]/i
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m && m[1] && /\.(mp3|wav)/i.test(m[1])) return m[1];
    }
    return null;
}

/**
 * Normalize an extracted path to a site-absolute URL.
 * SmartEditor2 sometimes hands back filesystem paths like
 * /home/labyrinth/tomcat6/webapps/labyrinth/... which must be rewritten
 * to /labyrinth/... to be reachable from the public site.
 */
function normalizeAudioUrl(url) {
    if (!url) return url;
    let u = url;
    u = u.replace('/home/labyrinth/tomcat6/webapps/labyrinth', '/labyrinth');
    return u;
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
    const before = await scanEditorAudio(editorFrame);

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

    // Listen for the upload response body. The most reliable URL source is
    // the network response from the upload endpoint itself; the editor scan
    // below is a fallback in case SmartEditor2 puts the audio somewhere
    // we did not anticipate.
    let networkUrl = null;
    const responseHandler = async (response) => {
        try {
            const respUrl = response.url();
            // Skip only obvious static assets; everything else is fair game
            // because the upload endpoint URL is undocumented and the
            // response could come back as text/html, text/xml, JSON, plain
            // text, or even no content-type.
            if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|otf|css)(\?|$)/i.test(respUrl)) return;
            const text = await response.text();
            const found = extractAudioUrlFromBody(text);
            if (found && !networkUrl) networkUrl = normalizeAudioUrl(found);
        } catch (e) { /* response may not be readable */ }
    };
    popupPage.on('response', responseHandler);

    try {
        const fileInput = await popupPage.$('#uploadInputBox');
        if (!fileInput) {
            log.fail('파일 입력창을 찾을 수 없습니다');
            try { await popupPage.close(); } catch (e) {}
            try { fs.unlinkSync(tempPath); } catch (e) {}
            return null;
        }
        await fileInput.uploadFile(tempPath);
        await new Promise(r => setTimeout(r, 400)); // let the file fully attach

        // Confirm button is <a href="#"><img id="btn_confirm"></a>. Use
        // Puppeteer's native click (real mouse events) so Jindo's mousedown/
        // mouseup-bound handler fires; a synthetic .click() in evaluate()
        // bubbles but does not always trigger framework-level handlers.
        const closeWatcher = new Promise(resolve => popupPage.once('close', resolve));
        await popupPage.click('#btn_confirm');

        // Popup closes itself after a successful upload.
        await Promise.race([
            closeWatcher,
            new Promise(r => setTimeout(r, 30000))
        ]);

        // Poll for the URL: network response first, then editor scan. The
        // editor insertion can lag the popup close by up to a couple seconds
        // on slower hosts, so retry across ~6 seconds before giving up.
        const pollStart = Date.now();
        while (Date.now() - pollStart < 6000) {
            if (networkUrl) { audioUrl = networkUrl; break; }
            const after = await scanEditorAudio(editorFrame);
            const fresh = after.filter(s => !before.includes(s));
            if (fresh.length > 0) {
                audioUrl = normalizeAudioUrl(fresh[0]);
                break;
            }
            await new Promise(r => setTimeout(r, 400));
        }

        if (!audioUrl) {
            log.fail('업로드된 오디오 URL을 에디터에서 찾지 못했습니다');
        }
    } finally {
        try { popupPage.off('response', responseHandler); } catch (e) {}
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
