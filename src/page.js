/**
 * Page Management Module
 * Handles page CRUD operations on The Labyrinth site
 */

const { log } = require('./logger');

const BASE_URL = 'https://www.thelabyrinth.co.kr';

/**
 * Navigate to page editor (create new page)
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 */
async function navigateToCreatePage(page, labyrinthId) {
    // Navigate directly to the create page with labyrinthSeqn
    const createUrl = `${BASE_URL}/labyrinth/laby/quest/registQuestion.do?labyrinthSeqn=${labyrinthId}`;
    await page.goto(createUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 100));

    // Verify labyrinthSeqn is set
    const labyrinthSeqnSet = await page.evaluate(() => {
        const input = document.querySelector('input[name="labyrinthSeqn"]');
        return input ? input.value : null;
    });
    log.verbose(`    폼에 labyrinthSeqn 설정됨: ${labyrinthSeqnSet}`);
}

/**
 * Navigate to page editor (modify existing page)
 * Must go through page list and click, direct URL access doesn't work
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @param {string} pageId - Page ID (questSeqn)
 */
async function navigateToEditPage(page, labyrinthId, pageId) {
    const editUrl = `${BASE_URL}/labyrinth/laby/quest/registQuestion.do?labyrinthSeqn=${labyrinthId}&questSeqn=${pageId}`;
    await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 500));
    log.verbose(`    편집 화면 이동됨`);
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
async function waitForEditor(page, timeout = 20000) {
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
 * Set SmartEditor2 content using HTML mode
 * Must click HTML button and set content in source textarea (no fallback to setIR)
 * @param {object} page - Puppeteer page
 * @param {string} html - HTML content to set
 */
async function setEditorContent(page, html) {
    // Wait for editor to be ready
    const editorReady = await waitForEditor(page);
    if (!editorReady) {
        log.fail('에디터가 준비되지 않았습니다 (타임아웃)');
        return false;
    }

    // Check all frames for the HTML button (SmartEditor may be in an iframe)
    const frames = page.frames();
    let targetFrame = null;

    for (const frame of frames) {
        try {
            const hasBtn = await frame.evaluate(() => !!document.querySelector('.se2_to_html'));
            if (hasBtn) {
                targetFrame = frame;
                break;
            }
        } catch (e) {
            // Frame might not be accessible, skip
        }
    }

    if (!targetFrame) {
        log.fail('HTML 버튼을 찾을 수 없습니다 (모든 프레임 검색 완료)');
        return false;
    }

    // Click HTML button to switch to HTML mode
    await targetFrame.click('.se2_to_html');
    log.verbose(`    HTML 모드로 전환`);

    // Wait for source textarea to appear in the frame
    try {
        await targetFrame.waitForSelector('.se2_input_syntax', { visible: true, timeout: 5000 });
    } catch (e) {
        log.fail('소스 textarea가 나타나지 않습니다 (타임아웃)');
        return false;
    }

    await new Promise(r => setTimeout(r, 200)); // Small delay for stability

    // Set content in source textarea (iframe)
    const result = await targetFrame.evaluate((content) => {
        const sourceTextarea = document.querySelector('.se2_input_syntax');
        if (!sourceTextarea) {
            return { success: false, error: 'source textarea not found' };
        }

        sourceTextarea.value = content;
        sourceTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true };
    }, html);

    if (!result.success) {
        log.fail(`소스 textarea 설정 실패: ${result.error}`);
        return false;
    }

    // Also set the main page's form textarea directly to ensure sync
    await page.evaluate((content) => {
        const formTextarea = document.querySelector('#quest');
        if (formTextarea) {
            formTextarea.value = content;
        }
    }, html);

    log.verbose(`    에디터 콘텐츠 설정됨 (HTML 모드)`);
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

    // Hint - { text, enabled }
    const hint = data.hint || {};
    const hintText = hint.text || '';
    const hintEnabled = hint.enabled === true;

    // Set hint checkbox first (input may be hidden when unchecked)
    const hintCheckSelector = '#hintcheck, input[name="hintcheck"]';
    const hintCheckEl = await page.$(hintCheckSelector);
    if (hintCheckEl) {
        const hintChecked = await hintCheckEl.evaluate(el => el.checked);
        if (hintEnabled && !hintChecked) {
            await hintCheckEl.click();
            await new Promise(r => setTimeout(r, 100));
        } else if (!hintEnabled && hintChecked) {
            await hintCheckEl.click();
            await new Promise(r => setTimeout(r, 100));
        }
    }

    // Fill hint text (after checkbox enables the input)
    if (hintText) {
        const hintInputSelector = '#hint, input[name="hint"]';
        const hintInputEl = await page.$(hintInputSelector);
        if (hintInputEl) {
            await page.click(hintInputSelector, { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type(hintInputSelector, hintText);
        }
    }

    // Content (via SmartEditor2)
    if (data.content) {
        const contentSet = await setEditorContent(page, data.content);
        if (!contentSet) {
            throw new Error('에디터 콘텐츠 설정에 실패했습니다');
        }
    }
}


/**
 * Add an answer to the page
 * Mimics human interaction: clicks the site's "정답추가" button to create a new row,
 * then types into the empty input field.
 * @param {object} page - Puppeteer page
 * @param {string} answer - Answer text
 * @param {boolean} isPublic - Whether answer is public
 * @param {string} explanation - Answer explanation
 */
async function addAnswer(page, answer, isPublic = false, explanation = '', slotIndex = -1) {
    // Check if there's an empty visible slot
    const hasEmptySlot = await page.evaluate(() => {
        const inputs = document.querySelectorAll('input.answer');
        for (const input of inputs) {
            const tr = input.closest('tr');
            if (tr && tr.style.display !== 'none') {
                if (!input.value || input.value.trim() === '') {
                    return true;
                }
            }
        }
        return false;
    });

    // If no empty slot, click the "정답추가" button (calls site's addAnswer JS function)
    if (!hasEmptySlot) {
        const addBtn = await page.$('input[value="정답추가"]');
        if (addBtn) {
            const isDisabled = await addBtn.evaluate(el => el.disabled);
            if (isDisabled) {
                log.verbose(`    정답추가 버튼 비활성화됨`);
                return 'button disabled';
            }
            await addBtn.click();
            await new Promise(r => setTimeout(r, 100));
            log.verbose(`    정답추가 버튼 클릭`);
        } else {
            log.verbose(`    정답추가 버튼을 찾을 수 없음`);
            return 'no add button';
        }
    }

    // Find the first empty visible answer input and fill it
    const answerInputEl = await page.evaluateHandle(() => {
        const inputs = document.querySelectorAll('input.answer');
        for (const input of inputs) {
            const tr = input.closest('tr');
            if (tr && tr.style.display !== 'none') {
                if (!input.value || input.value.trim() === '') {
                    return input;
                }
            }
        }
        return null;
    });

    if (!answerInputEl || await answerInputEl.evaluate(el => el === null)) {
        log.verbose(`    빈 정답 슬롯을 찾을 수 없음`);
        return 'no empty slot';
    }

    // Type the answer
    await answerInputEl.click();
    await answerInputEl.type(answer);

    // Set route hidden input if slotIndex provided (1-based)
    if (slotIndex > 0) {
        await answerInputEl.evaluate((el, routeVal) => {
            const tr = el.closest('tr');
            if (tr) {
                const routeInput = tr.querySelector('input.route');
                if (routeInput) routeInput.value = routeVal;
            }
        }, slotIndex);
        log.verbose(`    route=${slotIndex} 설정됨`);
    }

    // The answerOpen/explanation row is the next sibling tr
    const answerOpenRow = await answerInputEl.evaluateHandle(el => {
        const answerTr = el.closest('tr');
        return answerTr ? answerTr.nextElementSibling : null;
    });

    // Handle isPublic checkbox (정답 공개 여부)
    if (isPublic && answerOpenRow) {
        try {
            const publicCheckbox = await answerOpenRow.$('input.answerOpen');
            if (publicCheckbox) {
                const isChecked = await publicCheckbox.evaluate(el => el.checked);
                if (!isChecked) {
                    await publicCheckbox.click();
                    log.verbose(`    정답 공개 체크됨`);
                }
            }
        } catch (e) {
            log.verbose(`    공개 체크박스 처리 오류: ${e.message}`);
        }
    }

    // Handle explanation textarea (해설)
    if (explanation && explanation.trim() !== '' && answerOpenRow) {
        try {
            const explanationTextarea = await answerOpenRow.$('textarea.answerExplain');
            if (explanationTextarea) {
                // Ensure answerOpen is checked (enables the textarea)
                const publicCheckbox = await answerOpenRow.$('input.answerOpen');
                if (publicCheckbox) {
                    const isChecked = await publicCheckbox.evaluate(el => el.checked);
                    if (!isChecked) {
                        await publicCheckbox.click();
                    }
                }
                await explanationTextarea.evaluate((el, content) => {
                    el.value = content;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }, explanation);
                log.verbose(`    해설 입력됨`);
            }
        } catch (e) {
            log.verbose(`    해설 textarea 처리 오류: ${e.message}`);
        }
    }

    log.verbose(`    정답 입력됨`);
    return 'filled';
}

/**
 * Submit the page form (create or update)
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID (for finding page in list after redirect)
 * @param {string} pageTitle - Page title (for finding page in list after redirect)
 * @returns {Promise<string|null>} New page ID if created, or null
 */
async function submitPageForm(page, labyrinthId = null, pageTitle = null) {
    // Handle beforeunload dialog (browser's "Leave site?" confirmation)
    const dialogHandler = async (dialog) => {
        log.verbose(`    브라우저 대화상자: ${dialog.type()} - ${dialog.message()}`);
        try {
            await dialog.accept();
        } catch (e) {
            // Dialog already handled by another handler, ignore
        }
    };
    page.removeAllListeners('dialog');
    page.on('dialog', dialogHandler);

    // Don't call UPDATE_CONTENTS_FIELD - it may corrupt HTML mode content
    // The form textarea should already be synced from the HTML source textarea
    await new Promise(r => setTimeout(r, 100));

    // Find save button - different for create vs edit
    let saveBtn = await page.$('#registQuest');  // Create page
    if (!saveBtn) {
        saveBtn = await page.$('#updateQuest');  // Edit page
    }

    if (!saveBtn) {
        log.verbose(`    저장 버튼을 찾을 수 없음`);
        return null;
    }

    // Click save button
    log.verbose(`    저장 버튼 클릭...`);
    await saveBtn.click();

    // Wait for popup and click OK
    await new Promise(r => setTimeout(r, 300));
    log.verbose(`    팝업 대기 완료, 확인 버튼 찾는 중...`);

    // Click the OK button (confirmation popup)
    try {
        const confirmBtn = await page.$('#labyPopupOk');
        log.verbose(`    확인 버튼 검색 결과: ${confirmBtn ? '발견' : '없음'}`);
        if (confirmBtn) {
            await confirmBtn.click();
            log.verbose(`    확인 팝업 클릭 완료`);
        }
    } catch (e) {
        log.verbose(`    확인 팝업 클릭 오류: ${e.message}`);
    }

    // Wait for possible second popup (success) and click OK
    log.verbose(`    두 번째 팝업 대기 중...`);
    await new Promise(r => setTimeout(r, 500));
    log.verbose(`    두 번째 팝업 대기 완료`);
    try {
        const okBtn = await page.$('#labyPopupOk');
        log.verbose(`    완료 버튼 검색 결과: ${okBtn ? '발견' : '없음'}`);
        if (okBtn) {
            await okBtn.click();
            log.verbose(`    완료 팝업 클릭`);
        }
    } catch (e) {
        log.verbose(`    완료 팝업 클릭 오류: ${e.message}`);
    }
    log.verbose(`    팝업 처리 완료`);

    // Wait for navigation
    await new Promise(r => setTimeout(r, 100));

    const currentUrl = await page.url();
    log.verbose(`    현재 URL: ${currentUrl}`);

    // Extract page ID from URL or form
    let newPageId = await page.evaluate(() => {
        return new URLSearchParams(window.location.search).get('questSeqn') ||
               document.querySelector('input[name="questSeqn"]')?.value || null;
    });

    if (newPageId) {
        log.verbose(`    페이지 ID: ${newPageId}`);
        return newPageId;
    }

    // Search in page list
    if (labyrinthId) {
        log.verbose(`    페이지 목록에서 검색 중...`);
        await page.goto(`${BASE_URL}/labyrinth/laby/quest/questionList.do?labyrinthSeqn=${labyrinthId}`,
                        { waitUntil: 'networkidle2', timeout: 20000 });
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

        if (newPageId) log.verbose(`    발견됨: ${newPageId}`);
    }

    return newPageId;
}

/**
 * Get page list for a labyrinth
 * @param {object} page - Puppeteer page
 * @param {string} labyrinthId - Labyrinth ID
 * @returns {Promise<Array>} Array of page info objects
 */
async function getPageList(page, labyrinthId) {
    const listUrl = `${BASE_URL}/labyrinth/laby/quest/questionList.do?labyrinthSeqn=${labyrinthId}`;
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 20000 });

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
async function setParentConnection(page, parentPageId, answerIndex = 1, answerText = '') {
    // First try: match by answer text in checkbox label (reliable regardless of site ordering).
    // Label format is "정답N : <answer text>". Compare the answer portion EXACTLY — a
    // substring check would let "택1" wrongly match the "택10" slot.
    if (answerText) {
        const matched = await page.evaluate((parentId, text) => {
            const checkboxes = document.querySelectorAll('input[name="prevQuestCheckList"]');
            for (const cb of checkboxes) {
                if (!cb.value.startsWith(parentId + '-')) continue;
                const label = cb.parentElement?.textContent?.trim() || '';
                // Take the text after the last ":" (the answer), trimmed.
                const sep = label.lastIndexOf(':');
                const answerPart = (sep >= 0 ? label.slice(sep + 1) : label).trim();
                if (answerPart === text) {
                    return cb.value;
                }
            }
            return null;
        }, parentPageId, answerText);

        if (matched) {
            const checkbox = await page.$(`input[name="prevQuestCheckList"][value="${matched}"]`);
            if (checkbox) {
                const isChecked = await checkbox.evaluate(el => el.checked);
                if (!isChecked) await checkbox.click();
                log.verbose(`    부모 연결 설정됨: ${matched} (답안: ${answerText})`);
                return true;
            }
        }
    }

    // Fallback: match by index
    const checkboxValue = `${parentPageId}-${answerIndex}`;
    const checkbox = await page.$(`input[name="prevQuestCheckList"][value="${checkboxValue}"]`);
    if (checkbox) {
        const isChecked = await checkbox.evaluate(el => el.checked);
        if (!isChecked) await checkbox.click();
        log.verbose(`    부모 연결 설정됨: ${checkboxValue} (인덱스 폴백)`);
        return true;
    }

    // Debug: list available checkboxes
    const available = await page.$$eval('input[name="prevQuestCheckList"]', checkboxes =>
        checkboxes.map(cb => ({
            value: cb.value,
            label: cb.parentElement?.textContent?.trim().substring(0, 30)
        }))
    );

    log.error(`    부모 연결 실패. 답안: "${answerText}", 인덱스: ${checkboxValue}`);
    log.verbose(`    사용 가능한 연결: ${JSON.stringify(available)}`);
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
    log.verbose(`    페이지 삭제 중: ${pageId}`);

    // Handle beforeunload dialog
    const dialogHandler = async (dialog) => {
        try {
            await dialog.accept();
        } catch (e) {
            // Dialog already handled
        }
    };
    page.removeAllListeners('dialog');
    page.on('dialog', dialogHandler);

    // Navigate to the page edit screen
    await navigateToEditPage(page, labyrinthId, pageId);

    // Find and click the delete button (#remove or value="삭제")
    const removeBtn = await page.$('#remove, input[value="삭제"]');
    if (removeBtn) {
        await removeBtn.click();
        // Handle confirmation dialog
        await new Promise(r => setTimeout(r, 100));

        // Wait for and click the confirm button if present
        const confirmBtn = await page.$('#labyPopupOk');
        if (confirmBtn) {
            await confirmBtn.click();
            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        }

        log.verbose(`    페이지 삭제됨: ${pageId}`);
        return true;
    }

    log.verbose(`    삭제 버튼(#remove)을 찾을 수 없음`);
    return false;
}

module.exports = {
    navigateToCreatePage,
    navigateToEditPage,
    getEditorContent,
    setEditorContent,
    fillPageForm,
    addAnswer,
    setParentConnection,
    clearParentConnections,
    getParentConnections,
    submitPageForm,
    getPageList,
    deletePage
};
