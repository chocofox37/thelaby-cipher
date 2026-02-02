/**
 * The Labyrinth Login Module
 * Handles authentication via Puppeteer
 */

const puppeteer = require('puppeteer');

const LOGIN_URL = 'https://www.thelabyrinth.co.kr/labyrinth/user/login.do';

/**
 * Login to The Labyrinth site
 * @param {Object} options
 * @param {string} options.email - User email
 * @param {string} options.password - User password
 * @param {boolean} [options.headless=true] - Run browser in headless mode
 * @returns {Promise<{browser: Browser, page: Page}>} Browser and page instances
 */
async function login({ email, password, headless = true }) {
    if (!email || !password) {
        throw new Error('이메일과 비밀번호가 필요합니다');
    }

    const browser = await puppeteer.launch({
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    try {
        // Navigate to login page
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });

        // Fill in credentials
        await page.type('#email', email);
        await page.type('#password', password);

        // Click login button and wait for navigation
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#loginBtn')
        ]);

        // Check if login was successful by looking for user-specific elements
        // or checking the URL change
        const currentUrl = page.url();

        if (currentUrl.includes('login.do')) {
            // Still on login page - login failed
            const errorMsg = await page.evaluate(() => {
                // Try to find error message on page
                const alert = document.querySelector('.alert-message, .error-message');
                return alert ? alert.textContent.trim() : '';
            });
            if (errorMsg) {
                throw new Error(`로그인 실패: ${errorMsg}`);
            } else {
                throw new Error('로그인 실패: 이메일 또는 비밀번호를 확인해주세요');
            }
        }

        return { browser, page };

    } catch (error) {
        await browser.close();
        throw error;
    }
}

/**
 * Close browser session
 * @param {Browser} browser - Puppeteer browser instance
 */
async function logout(browser) {
    if (browser) {
        await browser.close();
    }
}

module.exports = {
    login,
    logout,
    LOGIN_URL
};
