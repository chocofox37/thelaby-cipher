/**
 * Page Management Module
 * Handles page CRUD operations on The Labyrinth site
 */

const BASE_URL = 'https://www.thelabyrinth.co.kr';

/**
 * Navigate to page editor (create new page)
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 */
async function navigateToCreatePage(page, labyrinthId) {
    // Navigate directly to the create page with labyrinthSeqn
    const createUrl = `${BASE_URL}/labyrinth/laby/quest/registQuestion.do?labyrinthSeqn=${labyrinthId}`;
    await page.goto(createUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 100));

    // Verify labyrinthSeqn is set
    const labyrinthSeqnSet = await page.evaluate(() => {
        const input = document.querySelector('input[name="labyrinthSeqn"]');
        return input ? input.value : null;
    });
    console.log('[page] labyrinthSeqn in form:', labyrinthSeqnSet);
}

/**
 * Navigate to page editor (modify existing page)
 * Must go through page list and click, direct URL access doesn't work
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @param {string} pageId - Page ID (questSeqn)
 */
async function navigateToEditPage(page, labyrinthId, pageId) {
    // First go to page list
    const listUrl = `${BASE_URL}/labyrinth/laby/quest/questionList.do?labyrinthSeqn=${labyrinthId}`;
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 100));

    // Find and click the page link - look for onclick containing fn_click with pageId
    const linkSelector = `a[onclick*="fn_click('${pageId}')"], a[onclick*="fn_click(\\"${pageId}\\")"]`;
    const linkElement = await page.$(linkSelector);

    if (linkElement) {
        await linkElement.click();
        console.log('[page] Navigate to edit: link clicked');
    } else {
        console.log('[page] Navigate to edit: link not found');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 100));
}

/**
 * Get SmartEditor2 content
 * @param {object} page - Puppeteer page
 * @returns {Promise<string>} HTML content from editor
 */
async function getEditorContent(page) {
    const frames = page.frames();
    const editorFrame = frames.find(f => f.url().includes('smarteditor'));
    if (!editorFrame) return '';

    return await editorFrame.evaluate(() => {
        const editArea = document.querySelector('.se2_input_wysiwyg');
        return editArea ? editArea.innerHTML : '';
    });
}

/**
 * Wait for SmartEditor2 to be ready
 * @param {object} page - Puppeteer page
 * @param {number} timeout - Timeout in ms
 * @returns {boolean} True if editor is ready
 */
async function waitForEditor(page, timeout = 10000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        const ready = await page.evaluate(() => {
            return typeof oEditors !== 'undefined' &&
                   oEditors.getById &&
                   oEditors.getById['quest'] &&
                   typeof oEditors.getById['quest'].setIR === 'function';
        });
        if (ready) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

/**
 * Set SmartEditor2 content using the editor API
 * @param {object} page - Puppeteer page
 * @param {string} html - HTML content to set
 */
async function setEditorContent(page, html) {
    // Wait for editor to be ready
    const editorReady = await waitForEditor(page);
    if (!editorReady) {
        console.error('[page] setEditorContent failed: editor not ready after timeout');
        return false;
    }

    const result = await page.evaluate((content) => {
        const editor = oEditors.getById['quest'];

        // Set content using setIR (set Internal Representation)
        editor.setIR(content);

        // Sync to textarea
        editor.exec('UPDATE_CONTENTS_FIELD', []);

        // Small delay for sync
        return new Promise(resolve => {
            setTimeout(() => {
                const textareaVal = document.querySelector('#quest')?.value || '';
                resolve({
                    success: true,
                    length: textareaVal.length,
                    preview: textareaVal.substring(0, 100)
                });
            }, 100);
        });
    }, html);

    if (!result.success) {
        console.error('[page] setEditorContent failed');
        return false;
    }

    console.log(`[page] Editor content set (${result.length} chars)`);
    return true;
}

/**
 * Fill page form fields
 * @param {object} page - Puppeteer page
 * @param {object} data - Page data
 */
async function fillPageForm(page, data) {
    // Title - clear and type
    if (data.title) {
        const titleSelector = '#questTitle, input[name="questTitle"]';
        const titleEl = await page.$(titleSelector);
        if (titleEl) {
            await page.click(titleSelector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(titleSelector, data.title);
        }
    }

    // Background color
    if (data.bgColor) {
        const presetColors = ['#FFFFFF', '#000000', '#FF0000', '#FF5E00', '#FFE400', '#ABF200', '#0054FF', '#5F00FF'];
        const upperColor = data.bgColor.toUpperCase();

        if (presetColors.includes(upperColor)) {
            // Click preset radio button
            const presetRadioSelector = `input[name="back"][value="${upperColor}"]`;
            const presetEl = await page.$(presetRadioSelector);
            if (presetEl) {
                await page.click(presetRadioSelector);
            }
        } else {
            // Click "etc" radio for custom color
            const etcEl = await page.$('input[name="back"][value="etc"]');
            if (etcEl) {
                await page.click('input[name="back"][value="etc"]');
            }
        }

        // Set the color value in the text input
        const bgInputSelector = '#background, input[name="background"]';
        const bgEl = await page.$(bgInputSelector);
        if (bgEl) {
            await page.click(bgInputSelector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(bgInputSelector, data.bgColor);
        }
    }

    // First page checkbox - check state and toggle if needed
    if (data.isFirst !== undefined) {
        const firstCheckSelector = '#firstYsno, input[name="firstYsno"]';
        const firstEl = await page.$(firstCheckSelector);
        if (firstEl) {
            const isChecked = await firstEl.evaluate(el => el.checked);
            if (isChecked !== data.isFirst) {
                await firstEl.click();
            }
        }
    }

    // Ending page - use page.select()
    if (data.isEnding !== undefined) {
        const endingSelect = await page.$('select[name="endYn"]');
        if (endingSelect) {
            await page.select('select[name="endYn"]', data.isEnding ? 'Y' : 'N');
        }
    }

    // Answer input enabled/disabled
    if (data.hasAnswers !== undefined) {
        const answerSelectSelector = '#answerExistYn, select[name="answerExistYn"]';
        const targetValue = data.hasAnswers ? 'Y' : 'N';
        await page.select(answerSelectSelector, targetValue);
        await new Promise(r => setTimeout(r, 100));
    }

    // Hint - check and type
    if (data.hint) {
        // Check the hint checkbox
        const hintCheckSelector = '#hintcheck, input[name="hintcheck"]';
        const hintCheckEl = await page.$(hintCheckSelector);
        if (hintCheckEl) {
            const hintChecked = await hintCheckEl.evaluate(el => el.checked);
            if (!hintChecked) {
                await hintCheckEl.click();
            }
        }

        // Fill hint text
        const hintInputSelector = '#hint, input[name="hint"]';
        const hintInputEl = await page.$(hintInputSelector);
        if (hintInputEl) {
            await page.click(hintInputSelector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(hintInputSelector, data.hint);
        }
    }

    // Content (via SmartEditor2)
    if (data.content) {
        const contentSet = await setEditorContent(page, data.content);
        if (!contentSet) {
            console.error('[page] WARNING: Failed to set editor content!');
        }
    }
}

/**
 * Clear all existing answers from the page
 * @param {object} page - Puppeteer page
 */
async function clearAnswers(page) {
    // Find all delete buttons and click them (in reverse order to avoid index shifts)
    let deleted = 0;
    while (true) {
        const deleteBtn = await page.$('input.answerDel:not([style*="display: none"])');
        if (!deleteBtn) break;

        // Check if button is visible
        const isVisible = await deleteBtn.evaluate(el => {
            const tr = el.closest('tr');
            return tr && tr.style.display !== 'none';
        });

        if (!isVisible) break;

        await deleteBtn.click();
        await new Promise(r => setTimeout(r, 100));
        deleted++;
    }

    if (deleted > 0) {
        console.log(`[page] clearAnswers: deleted ${deleted} existing answers`);
    }
}

/**
 * Add an answer to the page
 * @param {object} page - Puppeteer page
 * @param {string} answer - Answer text
 * @param {string} nextPageId - Next page ID (route)
 * @param {boolean} isPublic - Whether answer is public
 * @param {string} explanation - Answer explanation
 */
async function addAnswer(page, answer, isPublic = false, explanation = '') {
    // Check if we need a new row by reading current state
    const needNewRow = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input.answer');
        for (const input of inputs) {
            const tr = input.closest('tr');
            // Check if visible and empty (display !== 'none')
            if (tr && tr.style.display !== 'none') {
                if (!input.value || input.value.trim() === '') {
                    return false; // Found empty slot, don't need new row
                }
            }
        }
        return true; // All slots filled, need new row
    });

    // Only click add button if we need a new row
    if (needNewRow) {
        const addBtnSelector = '#addAnswerTr input[type="button"]';
        const addBtn = await page.$(addBtnSelector);
        if (addBtn) {
            const isDisabled = await addBtn.evaluate(el => el.disabled);
            if (!isDisabled) {
                // Count current visible rows before clicking
                const countBefore = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('input.answer')).filter(el => {
                        const tr = el.closest('tr');
                        return tr && tr.style.display !== 'none';
                    }).length;
                });

                await addBtn.click();
                console.log('[page] addAnswer: clicked add button for new row');

                // Wait for new row to appear
                await page.waitForFunction((prevCount) => {
                    const inputs = Array.from(document.querySelectorAll('input.answer')).filter(el => {
                        const tr = el.closest('tr');
                        return tr && tr.style.display !== 'none';
                    });
                    return inputs.length > prevCount;
                }, { timeout: 5000 }, countBefore);
            } else {
                console.log('[page] addAnswer: add button is disabled');
            }
        } else {
            console.log('[page] addAnswer: add button not found');
        }
    }

    // Find the first empty visible answer input and fill it
    const answerInputs = await page.$$('input.answer');
    let filled = false;
    let answerInputEl = null;

    for (let i = 0; i < answerInputs.length; i++) {
        const input = answerInputs[i];

        // Check if this input is visible and empty
        const inputState = await input.evaluate(el => {
            const tr = el.closest('tr');
            const isVisible = tr && tr.style.display !== 'none';
            const isEmpty = !el.value || el.value.trim() === '';
            return { isVisible, isEmpty };
        });

        if (inputState.isVisible && inputState.isEmpty) {
            // Click and type into the answer input
            await input.click();
            await input.type(answer);
            answerInputEl = input;
            filled = true;
            break;
        }
    }

    if (!filled || !answerInputEl) {
        console.log('[page] addAnswer result: no empty slot found');
        return 'no empty slot';
    }

    // Get the row information for finding related elements
    const rowInfo = await answerInputEl.evaluate(el => {
        const tr = el.closest('tr');
        if (!tr) return null;
        const allRows = Array.from(tr.parentElement.children);
        const rowIndex = allRows.indexOf(tr);
        return { rowIndex };
    });

    // Handle answerOpen (public) and explanation
    if (rowInfo && rowInfo.rowIndex !== null) {
        // Public checkbox and explanation are in the row immediately after the answer row
        const nextRowIndex = rowInfo.rowIndex + 2; // +2 because nth-child is 1-indexed and we want next row

        // Public checkbox
        const publicCheckboxSelector = `table tr:nth-child(${nextRowIndex}) input.answerOpen`;
        const publicCheckbox = await page.$(publicCheckboxSelector);
        if (publicCheckbox) {
            const currentlyChecked = await publicCheckbox.evaluate(el => el.checked);
            if (currentlyChecked !== isPublic) {
                await publicCheckbox.click();
            }
        }

        // Explanation textarea
        if (explanation) {
            const explainSelector = `table tr:nth-child(${nextRowIndex}) textarea.answerExplain`;
            const explainTextarea = await page.$(explainSelector);
            if (explainTextarea) {
                await explainTextarea.click({ clickCount: 3 });
                await page.keyboard.press('Backspace');
                await explainTextarea.type(explanation);
            }
        }
    }

    console.log(`[page] addAnswer result: filled`);
    return 'filled';
}

/**
 * Get existing answers from the page
 * @param {object} page - Puppeteer page
 * @returns {Promise<Array>} Array of answer objects
 */
async function getAnswers(page) {
    return await page.evaluate(() => {
        const answers = [];
        // Get all added answer rows (class .addAnswerTr), excluding hidden templates
        const answerRows = document.querySelectorAll('.addAnswerTr');

        answerRows.forEach((row, idx) => {
            const answerInput = row.querySelector('input.answer');
            const routeInput = row.querySelector('input.route');

            if (answerInput && answerInput.value) {
                answers.push({
                    index: idx,
                    answer: answerInput.value,
                    route: routeInput ? routeInput.value : ''
                });
            }
        });

        return answers;
    });
}

/**
 * Clear all answers from the page
 * @param {object} page - Puppeteer page
 */
async function clearAnswers(page) {
    // Clear all answer input values by clicking and deleting
    const answerInputs = await page.$$('input.answer');
    for (const input of answerInputs) {
        const hasValue = await input.evaluate(el => el.value && el.value.trim() !== '');
        if (hasValue) {
            await input.click({ clickCount: 3 });
            await page.keyboard.press('Backspace');
        }
    }

    // Click delete buttons repeatedly to remove extra answer rows
    let count = 0;
    while (count < 20) {
        // Find visible delete link
        const deleteLinks = await page.$$('a[onclick*="deleteAnswer"]');
        let clicked = false;

        for (const link of deleteLinks) {
            const isVisible = await link.evaluate(el => {
                const tr = el.closest('tr');
                return tr && tr.style.display !== 'none' && tr.offsetParent !== null;
            });

            if (isVisible) {
                await link.click();
                clicked = true;
                await new Promise(r => setTimeout(r, 100));
                break;
            }
        }

        if (!clicked) break;
        count++;
    }

    await new Promise(r => setTimeout(r, 100));
}

/**
 * Submit the page form (create or update)
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID (for finding page in list after redirect)
 * @param {string} pageTitle - Page title (for finding page in list after redirect)
 * @returns {Promise<string|null>} New page ID if created, or null
 */
async function submitPageForm(page, labyrinthId = null, pageTitle = null) {
    // Sync editor content to form
    await page.evaluate(() => {
        if (typeof oEditors !== 'undefined' && oEditors.getById) {
            const editor = oEditors.getById['quest'];
            if (editor && editor.exec) {
                editor.exec('UPDATE_CONTENTS_FIELD', []);
            }
        }
    });
    await new Promise(r => setTimeout(r, 100));

    // Find save button - different for create vs edit
    let saveBtn = await page.$('#registQuest');  // Create page
    if (!saveBtn) {
        saveBtn = await page.$('#updateQuest');  // Edit page
    }

    if (!saveBtn) {
        console.log('[page] Save button not found');
        return null;
    }

    // Click save button
    console.log('[page] Clicking save button...');
    await saveBtn.click();

    // Wait for popup and click OK
    await new Promise(r => setTimeout(r, 100));

    // Click the OK button
    try {
        await page.click('#labyPopupOk');
        console.log('[page] Clicked confirm OK');
    } catch (e) {}

    // Wait for possible second popup (success) and click OK
    await new Promise(r => setTimeout(r, 100));
    try {
        await page.click('#labyPopupOk');
        console.log('[page] Clicked success OK');
    } catch (e) {}

    // Wait for navigation
    await new Promise(r => setTimeout(r, 100));

    const currentUrl = await page.url();
    console.log('[page] URL:', currentUrl);

    // Extract page ID from URL or form
    let newPageId = await page.evaluate(() => {
        return new URLSearchParams(window.location.search).get('questSeqn') ||
               document.querySelector('input[name="questSeqn"]')?.value || null;
    });

    if (newPageId) {
        console.log('[page] Page ID:', newPageId);
        return newPageId;
    }

    // Search in page list
    if (labyrinthId) {
        console.log('[page] Checking page list...');
        await page.goto(`${BASE_URL}/labyrinth/laby/quest/questionList.do?labyrinthSeqn=${labyrinthId}`,
                        { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 100));

        newPageId = await page.evaluate(() => {
            let maxId = null, maxVal = 0;
            document.querySelectorAll('a').forEach(link => {
                const match = (link.getAttribute('onclick') || '').match(/fn_click\(['"]?(\d+)['"]?\)/);
                if (match) {
                    const val = parseInt(match[1]);
                    if (val > maxVal) { maxVal = val; maxId = match[1]; }
                }
            });
            return maxId;
        });

        if (newPageId) console.log('[page] Found:', newPageId);
    }

    return newPageId;
}

/**
 * Create a new page
 * @param {object} browser - Puppeteer browser
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @param {object} pageData - Page data
 * @returns {Promise<string|null>} New page ID
 */
async function createPage(browser, page, labyrinthId, pageData) {
    console.log('[page] Creating page:', pageData.title);

    await navigateToCreatePage(page, labyrinthId);
    await fillPageForm(page, pageData);

    // Add answers if provided
    if (pageData.answers && pageData.answers.length > 0) {
        for (const ans of pageData.answers) {
            await addAnswer(page, ans.answer, ans.route || '', ans.isPublic || false, ans.explanation || '');
        }
    }

    const pageId = await submitPageForm(page, labyrinthId, pageData.title);
    console.log('[page] Created page with ID:', pageId);
    return pageId;
}

/**
 * Update an existing page
 * @param {object} browser - Puppeteer browser
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @param {string} pageId - Page ID to update
 * @param {object} pageData - Page data
 * @returns {Promise<boolean>} Success
 */
async function updatePage(browser, page, labyrinthId, pageId, pageData) {
    console.log('[page] Updating page:', pageId);

    await navigateToEditPage(page, labyrinthId, pageId);
    await fillPageForm(page, pageData);

    // Handle answers if provided
    if (pageData.answers !== undefined) {
        await clearAnswers(page);
        for (const ans of pageData.answers) {
            await addAnswer(page, ans.answer, ans.route || '', ans.isPublic || false, ans.explanation || '');
        }
    }

    await submitPageForm(page);
    console.log('[page] Updated page:', pageId);
    return true;
}

/**
 * Get page list for a labyrinth
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @returns {Promise<Array>} Array of page info objects
 */
async function getPageList(page, labyrinthId) {
    const listUrl = `${BASE_URL}/labyrinth/laby/quest/questionList.do?labyrinthSeqn=${labyrinthId}`;
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const pages = await page.evaluate(() => {
        const result = [];
        const rows = document.querySelectorAll('table tbody tr, .quest_list tr');

        rows.forEach(row => {
            const titleCell = row.querySelector('td a, .title a');
            const idMatch = titleCell?.getAttribute('onclick')?.match(/questSeqn=(\d+)/);

            if (idMatch) {
                result.push({
                    id: idMatch[1],
                    title: titleCell.textContent.trim()
                });
            }
        });

        return result;
    });

    return pages;
}

/**
 * Set parent page connection (from child page)
 * This must be called on the CHILD page to establish the connection from parent
 * @param {object} page - Puppeteer page
 * @param {string} parentPageId - Parent page ID
 * @param {number} answerIndex - Answer index (1-based) in the parent page
 * @returns {Promise<boolean>} Success
 */
async function setParentConnection(page, parentPageId, answerIndex = 1) {
    const checkboxValue = `${parentPageId}-${answerIndex}`;
    const checkboxSelector = `input[name="prevQuestCheckList"][value="${checkboxValue}"]`;

    const checkbox = await page.$(checkboxSelector);
    if (checkbox) {
        const isChecked = await checkbox.evaluate(el => el.checked);
        if (!isChecked) {
            await checkbox.click();
        }
        console.log(`[page] Set parent connection: ${checkboxValue}`);
        return true;
    }

    // List available checkboxes for debugging (read-only)
    const available = await page.$$eval('input[name="prevQuestCheckList"]', checkboxes =>
        checkboxes.map(cb => ({
            value: cb.value,
            label: cb.parentElement?.textContent?.trim().substring(0, 30)
        }))
    );

    console.log(`[page] Failed to set parent connection. Wanted: ${checkboxValue}`);
    console.log('[page] Available:', available);
    return false;
}

/**
 * Clear all parent connections (from child page)
 * @param {object} page - Puppeteer page
 */
async function clearParentConnections(page) {
    const checkboxes = await page.$$('input[name="prevQuestCheckList"]');
    for (const checkbox of checkboxes) {
        const isChecked = await checkbox.evaluate(el => el.checked);
        if (isChecked) {
            await checkbox.click();
        }
    }
}

/**
 * Get parent connections (from child page)
 * @param {object} page - Puppeteer page
 * @returns {Promise<Array>} Array of connection info
 */
async function getParentConnections(page) {
    return await page.evaluate(() => {
        const connections = [];
        document.querySelectorAll('input[name="prevQuestCheckList"]').forEach(cb => {
            const match = cb.value.match(/^(\d+)-(\d+)$/);
            if (match) {
                connections.push({
                    parentPageId: match[1],
                    answerIndex: parseInt(match[2]),
                    checked: cb.checked,
                    label: cb.parentElement?.textContent?.trim()
                });
            }
        });
        return connections;
    });
}

/**
 * Delete a page
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @param {string} pageId - Page ID to delete
 * @returns {Promise<boolean>} Success
 */
async function deletePage(page, labyrinthId, pageId) {
    console.log('[page] Deleting page:', pageId);

    // Navigate to page list
    const listUrl = `${BASE_URL}/labyrinth/laby/quest/questionList.do?labyrinthSeqn=${labyrinthId}`;
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Find the row containing the target page
    const rows = await page.$$('table tbody tr, .quest_list tr');
    let deleteBtn = null;

    for (const row of rows) {
        // Check if this row has a link with the target pageId
        const link = await row.$('a[onclick*="questSeqn"]');
        if (link) {
            const onclick = await link.evaluate(el => el.getAttribute('onclick'));
            if (onclick && onclick.includes(`questSeqn=${pageId}`)) {
                // Found the row, now find the delete button
                deleteBtn = await row.$('a[onclick*="delete"], input[onclick*="delete"]');
                break;
            }
        }
    }

    if (deleteBtn) {
        await deleteBtn.click();
        // Handle confirmation dialog
        await new Promise(r => setTimeout(r, 100));

        // Wait for and click the confirm button if present
        const confirmBtn = await page.$('#labyPopupOk');
        if (confirmBtn) {
            await confirmBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
        }

        console.log('[page] Deleted page:', pageId);
        return true;
    }

    console.log('[page] Delete button not found for page:', pageId);
    return false;
}

module.exports = {
    navigateToCreatePage,
    navigateToEditPage,
    getEditorContent,
    setEditorContent,
    fillPageForm,
    addAnswer,
    getAnswers,
    clearAnswers,
    setParentConnection,
    clearParentConnections,
    getParentConnections,
    submitPageForm,
    createPage,
    updatePage,
    getPageList,
    deletePage
};
