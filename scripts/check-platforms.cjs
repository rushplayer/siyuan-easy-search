// Runs against a local SiYuan workspace with the latest two packages installed.
// Uses a temporary, isolated browser profile and never edits note content.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium} = require("playwright-core");
const {checkNavigation} = require("./navigation-checks.cjs");

async function main() {
    const base = process.env.SIYUAN_TEST_URL || "http://127.0.0.1:6806";
    const output = process.env.SIYUAN_TEST_OUTPUT || "/tmp/siyuan-platform-checks";
    fs.mkdirSync(output, {recursive: true});
    const launch = process.env.CHROME_PATH ? {executablePath: process.env.CHROME_PATH} : {channel: "msedge"};
    const browser = await chromium.launch({...launch, headless: true});
    try {
        for (const scenario of [
            {name: "web-desktop", mobile: false, width: 1280, height: 800},
            {name: "mobile-320", mobile: true, width: 320, height: 640},
            {name: "mobile-390", mobile: true, width: 390, height: 760},
        ]) {
            console.log(`${scenario.name}: starting`);
            const context = await browser.newContext({viewport: {width: scenario.width, height: scenario.height}, isMobile: scenario.mobile, hasTouch: scenario.mobile});
            const page = await context.newPage();
            const searchPageSizes = [];
            page.on("request", request => {
                if (!request.url().includes("/api/search/fullTextSearchBlock")) return;
                try {searchPageSizes.push(JSON.parse(request.postData() || "{}").pageSize);} catch {}
            });
            if (process.env.SIYUAN_TEST_BUNDLE) await page.route("**/api/petal/loadPetals", async route => {
                const response = await route.fetch(), payload = await response.json();
                payload.data.find(plugin => plugin.name === "siyuan-easy-search").js = fs.readFileSync(process.env.SIYUAN_TEST_BUNDLE, "utf8");
                await route.fulfill({response, json: payload});
            });
            const errors = [];
            page.on("pageerror", error => errors.push(error.stack || error.message));
            try {
                await page.goto(base + (scenario.mobile ? "/stage/build/mobile/" : "/stage/build/desktop/"), {waitUntil: "domcontentloaded"});
                await page.waitForFunction(() => window.siyuan?.isReady && ["siyuan-easy-search", "siyuan-subnote-index"].every(name => window.siyuan?.ws?.app?.plugins?.some(plugin => plugin.name === name)), undefined, {timeout: 20000});
                await page.evaluate(async testDocID => {
                    const plugin = window.siyuan.ws.app.plugins.find(item => item.name === "siyuan-easy-search");
                    window.__essTestPlugin = plugin;
                    window.__essSavedState = {state: structuredClone(plugin.searchState), recent: structuredClone(plugin.recent)};
                    plugin.searchState.query = "";
                    const currentID = testDocID || plugin.activeEditor()?.protyle?.block?.rootID;
                    const rows = await plugin.post("/api/query/sql", {stmt: currentID && /^[a-z0-9-]+$/i.test(currentID) ? `SELECT id, content FROM blocks WHERE type = 'd' AND id = '${currentID}' LIMIT 1` : "SELECT id, content FROM blocks WHERE type = 'd' ORDER BY length(content) LIMIT 1"});
                    if (!rows.length) throw new Error("No test note is available; set SIYUAN_TEST_DOC_ID to an existing note.");
                    window.__essTargetID = rows[0].id;
                    await plugin.openResult(rows[0].id, null, "", false, rows[0].content);
                }, process.env.SIYUAN_TEST_DOC_ID);
                await page.waitForFunction(() => window.siyuan.ws.app.plugins.find(item => item.name === "siyuan-easy-search")?.activeEditor()?.protyle?.block?.rootID === window.__essTargetID, undefined, {timeout: 15000});
                await checkNavigation(page, scenario, output);
                const panes = await page.locator('[data-type="wnd"]').count();
                await page.keyboard.press("Control+f");
                await page.locator(".ess-findbar").waitFor();
                assert.equal(await page.locator(".ess-search-dialog").count(), 0);
                const localQuery = await page.locator(".ess-find-input").inputValue();
                assert.equal(await page.evaluate(() => {
                    const p = window.__essTestPlugin;
                    return p.mobile || p.findController.root.parentElement === p.activeEditor().protyle.element;
                }), true, "current-note float must be mounted inside the current note");
                await page.keyboard.press("Control+Shift+f");
                await page.locator(".ess-search-dialog .ess-query").fill("独立的全局关键词");
                assert.equal(await page.locator(".ess-find-note").count(), 0);
                await page.keyboard.press("Control+f");
                await page.locator(".ess-findbar").waitFor();
                assert.equal(await page.locator(".ess-search-dialog").count(), 0);
                assert.equal(await page.locator(".ess-find-input").inputValue(), localQuery);
                await page.keyboard.press("Control+Shift+f");
                assert.equal(await page.locator(".ess-search-dialog .ess-query").inputValue(), "独立的全局关键词");
                await page.keyboard.press("Escape");
                await page.keyboard.press("Control+f");
                console.log(`${scenario.name}: Ctrl+F uses a separate current-note float and independent query`);
                if (scenario.mobile) {
                    const bar = await page.locator(".ess-findbar").boundingBox();
                    assert.ok(bar.x >= 0 && bar.x + bar.width <= scenario.width + 1, `${scenario.name}: find bar overflow`);
                    for (const button of await page.locator(".ess-find-button").all()) assert.ok((await button.boundingBox()).height >= 44);
                }
                // Use the actual native entry, then both global shortcut aliases. None may create a split.
                if (scenario.mobile) {
                    await page.getByRole("button", {name: "关闭篇内查找", exact: true}).click();
                    // Headless browsers have no OS keyboard to send SiYuan its keyboard-dismissed notification.
                    await page.evaluate(() => window.dispatchEvent(new CustomEvent("siyuan-mobile-keyboard-change", {detail: false})));
                }
                await page.locator(scenario.mobile ? "#mobileBottomBarSearch" : "#barSearch").click();
                await page.locator(".ess-search-dialog .ess-query").waitFor();
                assert.equal(await page.locator(".ess-findbar").count(), 0);
                await page.keyboard.press("Escape");
                await page.keyboard.press("Control+Shift+f");
                await page.locator(".ess-search-dialog .ess-query").waitFor();
                await page.keyboard.press("Control+p");
                await page.locator(".ess-query").fill(process.env.SIYUAN_TEST_QUERY || "同学");
                await page.keyboard.press("Enter");
                await page.waitForFunction(() => {const view = window.__essTestPlugin.searchView; return view && !view.busy && view.query === (window.__essTestPlugin.searchView.input.value.trim());});
                assert.ok(await page.locator(".ess-result").count());
                assert.deepEqual(await page.locator(".ess-page-size option").evaluateAll(options => options.map(option => option.value)), ["50", "100", "200"]);
                assert.equal(await page.locator(".ess-page-size").inputValue(), "50");
                const rowLayout = await page.locator(".ess-block").first().evaluate(row => ({direction: getComputedStyle(row).flexDirection, wrap: getComputedStyle(row).flexWrap, whiteSpace: getComputedStyle(row).whiteSpace, paddingTop: getComputedStyle(row).paddingTop, titleText: row.querySelector(".ess-hit-title").textContent, tooltip: row.title, label: row.getAttribute("aria-label"), title: row.querySelector(".ess-hit-title").getBoundingClientRect().toJSON(), snippet: row.querySelector(".ess-hit-snippet").getBoundingClientRect().toJSON()}));
                assert.equal(rowLayout.direction, "row");
                assert.equal(rowLayout.wrap, "nowrap");
                assert.equal(rowLayout.whiteSpace, "nowrap");
                assert.equal(rowLayout.paddingTop, "3px", scenario.name + ": result rows are compact");
                assert.equal(rowLayout.tooltip, "", scenario.name + ": no full-content hover tooltip");
                assert.ok(Math.abs(rowLayout.title.y - rowLayout.snippet.y) < 3, `${scenario.name}: note title and hit excerpt share one line: ${JSON.stringify(rowLayout)}`);
                const hitItem = page.locator(".ess-block-item").first();
                const disclosure = hitItem.locator(".ess-expand");
                const fullContent = hitItem.locator(".ess-full-content");
                const currentNote = await page.evaluate(() => window.__essTestPlugin.activeEditor().protyle.block.rootID);
                assert.equal(await fullContent.isVisible(), false, "results start collapsed");
                assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
                if (scenario.mobile) {
                    const bounds = await disclosure.boundingBox();
                    assert.ok(bounds.width >= 44 && bounds.height >= 44, "the expand control is touch-sized");
                }
                await disclosure.click();
                assert.equal(await fullContent.isVisible(), true);
                assert.equal(await disclosure.getAttribute("aria-expanded"), "true");
                assert.equal(await fullContent.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "expanded content fits the viewport");
                assert.equal(await fullContent.textContent(), await page.evaluate(() => window.__essTestPlugin.searchView.blocks[0].content));
                assert.equal(await page.evaluate(() => window.__essTestPlugin.activeEditor().protyle.block.rootID), currentNote, "expand does not open a note");
                await disclosure.click();
                assert.equal(await fullContent.isVisible(), false);
                assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
                await page.locator(".ess-page-size").selectOption("100");
                await page.waitForFunction(() => {const view = window.__essTestPlugin.searchView; return view && !view.busy && view.pageSize === 100;});
                assert.deepEqual(searchPageSizes.slice(-2), [100, 100], "changing the page-size option reloads both result lists using the selected size");
                const rootBeforeEnter = await page.evaluate(() => window.__essTestPlugin.activeEditor().protyle.block.rootID);
                await page.keyboard.press("Enter");
                await page.waitForFunction(() => window.__essTestPlugin.searchView && !window.__essTestPlugin.searchView.busy);
                assert.equal(await page.locator(".ess-search-dialog .ess-query").isVisible(), true);
                assert.equal(await page.evaluate(() => window.__essTestPlugin.activeEditor().protyle.block.rootID), rootBeforeEnter);
                await page.locator(".ess-search-dialog .ess-submit").click();
                await page.waitForFunction(() => window.__essTestPlugin.searchView && !window.__essTestPlugin.searchView.busy);
                assert.equal(await page.locator(".ess-search-dialog .ess-query").isVisible(), true);
                console.log(`${scenario.name}: Enter and Search button submit without opening a result or closing the dialog`);
                assert.equal(await page.locator(".ess-search-dialog").count(), 1);
                assert.equal(await page.locator(".ess-search-dialog .ess-pin").count(), 0);
                assert.equal(await page.locator('[data-type="wnd"]').count(), panes);
                assert.equal(await page.locator('[data-key="dialog-globalsearch"], [data-key="dialog-search"], #searchInput').count(), 0);
                async function checkDialog() {
                    await page.waitForFunction(() => {
                        const element = document.querySelector(".ess-search-dialog .b3-dialog__container");
                        return element && Number(getComputedStyle(element).opacity) > 0.99;
                    });
                    const rect = await page.locator(".ess-search-dialog .b3-dialog__container").boundingBox();
                    assert.ok(rect.width > 200 && rect.height > 200, `${scenario.name}: dialog is visible`);
                    const viewport = {...page.viewportSize(), height: await page.evaluate(() => window.visualViewport?.height || innerHeight)};
                    assert.ok(rect.x >= -1 && rect.x + rect.width <= viewport.width + 1, `${scenario.name}: dialog width`);
                    assert.ok(rect.y >= -1 && rect.y + rect.height <= viewport.height + 1, `${scenario.name}: dialog height`);
                    assert.equal(await page.locator(".ess-search-dialog .ess-search").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
                    assert.equal(await page.locator(".ess-search-dialog .ess-pagination").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
                }
                await checkDialog();
                await page.screenshot({path: path.join(output, scenario.name + ".png"), animations: "disabled"});
                if (!scenario.mobile) {
                    await page.keyboard.press("Escape");
                    await page.locator("#barCommand").click();
                    await page.getByRole("textbox", {name: "命令面板"}).fill("固定搜索");
                    await page.locator('[data-command-id="core.general.stickSearch"]').click();
                    await page.locator(".ess-search-dialog .ess-query").waitFor();
                    assert.equal(await page.locator('[data-type="wnd"]').count(), panes);
                }
                if (scenario.mobile) {
                    assert.equal(await page.locator(".ess-search-dialog .ess-pin").count(), 0);
                    assert.equal(await page.locator(".ess-findbar").count(), 0);
                    // iOS keyboards can shrink only the visual viewport, leaving the layout viewport intact.
                    await page.evaluate(() => {Object.defineProperty(window.visualViewport, "height", {configurable: true, value: 360}); window.visualViewport.dispatchEvent(new Event("resize"));});
                    await page.waitForFunction(() => {
                        const root = document.querySelector(".ess-search-dialog");
                        return root && parseFloat(root.style.getPropertyValue("--ess-viewport-height")) <= 360;
                    });
                    await checkDialog();
                    await page.screenshot({path: path.join(output, scenario.name + "-keyboard.png"), animations: "disabled"});
                    assert.equal(await page.locator(".ess-find-note").count(), 0);
                    await page.keyboard.press("Control+f");
                    await page.locator(".ess-findbar").waitFor();
                    assert.equal(await page.locator(".ess-search-dialog").count(), 0);
                }
                // Bypass the button redirect once to exercise native dialog/mobile-panel fallback.
                await page.evaluate(() => {
                    const plugin = window.__essTestPlugin;
                    plugin.dialog?.destroy(); plugin.findController.close();
                    window.removeEventListener("click", plugin.takeover.click, true);
                    try {document.getElementById(plugin.mobile ? "mobileBottomBarSearch" : "barSearch").click();}
                    finally {window.addEventListener("click", plugin.takeover.click, true);}
                });
                await page.locator(".ess-search-dialog .ess-query").waitFor();
                assert.equal(await page.locator('[data-type="wnd"]').count(), panes);
                assert.equal(errors.filter(error => error.includes("/plugins/siyuan-")).length, 0, errors.join("\n"));
                console.log(`${scenario.name}: shortcuts, native entry takeover, no splits, touch controls and layout passed`);
            } catch (error) {
                console.log("Page diagnostics:", await page.evaluate(() => {
                    const plugin = window.siyuan?.ws?.app?.plugins?.find(item => item.name === "siyuan-easy-search");
                    return {ready: window.siyuan?.isReady, plugins: window.siyuan?.ws?.app?.plugins?.map(item => item.name), samePlugin: plugin === window.__essTestPlugin, mobile: plugin?.mobile, editor: !!plugin?.activeEditor(), bar: !!plugin?.findController.root, connected: plugin?.findController.root?.isConnected};
                }));
                console.log("Page errors:", errors);
                await page.screenshot({path: path.join(output, scenario.name + "-failure.png"), animations: "disabled"});
                throw error;
            } finally {
                await page.evaluate(async () => {
                    const plugin = window.siyuan?.ws?.app?.plugins?.find(item => item.name === "siyuan-easy-search");
                    if (!plugin || !window.__essSavedState) return;
                    plugin.dialog?.destroy();
                    plugin.findController.close();
                    plugin.searchState = window.__essSavedState.state;
                    plugin.recent = window.__essSavedState.recent;
                    await plugin.saveData("data.json", {...plugin.searchState, recent: plugin.recent});
                }).catch(() => {});
                await context.close();
            }
        }
    } finally {await browser.close();}
}

main().catch(error => {console.error(error); process.exitCode = 1;});
