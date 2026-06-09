/**
 * HTML minifier for upload.
 *
 * Goals (safe by default, no class renaming because the design system
 * depends on those identifiers):
 *   - Strip HTML comments, except functional ONLY-VIEW-* directives
 *   - Strip CSS comments inside <style> blocks
 *   - Collapse whitespace inside CSS (whitespace-insensitive language)
 *   - Collapse runs of insignificant whitespace BETWEEN tags
 *
 * Explicitly out of scope (would break things):
 *   - Touching text content inside elements (Korean story body)
 *   - Touching inline JS bodies (onclick handlers, onload init)
 *   - Renaming classes/ids
 */

/**
 * Minify a CSS source string: remove /* *\/ comments and collapse
 * whitespace. Keep string-literal contents untouched.
 */
function minifyCss(css) {
    let out = css;
    // Strip /* ... */ comments (non-greedy)
    out = out.replace(/\/\*[\s\S]*?\*\//g, '');
    // Collapse all whitespace runs to a single space
    out = out.replace(/\s+/g, ' ');
    // Remove spaces around CSS punctuation that are insignificant
    out = out.replace(/\s*([{}:;,>+~])\s*/g, '$1');
    return out.trim();
}

/**
 * Minify an HTML document for upload.
 * @param {string} html
 * @returns {string}
 */
function minifyHtml(html) {
    if (!html || typeof html !== 'string') return html;
    let result = html;

    // 1. Strip HTML comments, preserving ONLY-VIEW directives which the
    //    site interprets (they are not really comments at runtime).
    result = result.replace(/<!--([\s\S]*?)-->/g, (match, body) => {
        const trimmed = body.trim();
        if (/^ONLY-VIEW-/.test(trimmed)) return match;
        return '';
    });

    // 2. Minify each <style> block.
    result = result.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
        (match, open, css, close) => open + minifyCss(css) + close);

    // 3. Collapse runs of whitespace BETWEEN tags. A single newline/space
    //    between tags is rendered the same as zero, so we collapse runs
    //    of 2+ whitespace characters to nothing.
    //    We do NOT touch whitespace that sits inside text content
    //    (anything that does not start right after '>' and end right
    //    before '<').
    result = result.replace(/>\s{2,}</g, '><');

    return result;
}

module.exports = { minifyHtml, minifyCss };
