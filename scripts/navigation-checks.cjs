const assert = require("node:assert/strict");
const path = require("node:path");

async function checkNavigation(page, scenario, output) {
    if (!scenario.mobile) {
        const result = await page.evaluate(async () => {
            const p = window.__essTestPlugin;
            const config = window.siyuan.config.fileTree, savedLimit = config.maxOpenTabCount;
            const docs = await p.post("/api/query/sql", {stmt: "SELECT id, content FROM blocks WHERE type='d' ORDER BY id LIMIT 3"});
            if (docs.length < 3) throw new Error("Tab navigation needs three existing notes.");
            const roots = () => p.rememberTabs().filter(tab => tab.headElement).map(tab => tab.model?.editor?.protyle?.block?.rootID);
            const open = doc => p.openResult(doc.id, null, "", false, doc.content);
            const pins = [];
            try {
                for (const tab of p.rememberTabs()) await tab.parent.removeTab(tab.id, false, false);
                config.maxOpenTabCount = 2;
                await open(docs[0]); await open(docs[1]);
                await open(docs[0]); // Most recently active must still be evicted if opened earliest.
                await open(docs[2]);
                const afterEvict = roots();
                const pinned = p.rememberTabs().find(tab => tab.model?.editor?.protyle?.block?.rootID === docs[1].id);
                pinned.pin(); pins.push(pinned);
                await open(docs[0]);
                const afterPin = roots();
                await open(docs[1]);
                return {expected: docs.map(doc => doc.id), afterEvict, afterPin, afterReuse: roots(), active: p.activeEditor()?.protyle?.block?.rootID};
            } finally {for (const tab of pins) tab.unpin(); config.maxOpenTabCount = savedLimit;}
        });
        assert.deepEqual(result.afterEvict, [result.expected[1], result.expected[2]], "close earliest opened, rather than least recently active");
        assert.deepEqual(result.afterPin, [result.expected[1], result.expected[0]], "preserve pinned tabs");
        assert.deepEqual(result.afterReuse, result.afterPin, "reuse existing result without eviction");
        assert.equal(result.active, result.expected[1], "existing result becomes active");
    }
    await page.evaluate(async () => {
        const p = window.__essTestPlugin;
        const rows = await p.post("/api/query/sql", {stmt: "SELECT root_id, count(*) n FROM blocks WHERE type='p' AND length(content)>10 GROUP BY root_id ORDER BY n DESC LIMIT 1"});
        const rootID = rows[0].root_id;
        const docs = await p.post("/api/query/sql", {stmt: `SELECT id, content FROM blocks WHERE id='${rootID}'`});
        await p.openResult(rootID, null, "", false, docs[0].content);
        window.__essNavigationRoot = rootID;
    });
    await page.waitForFunction(() => window.__essTestPlugin.activeEditor()?.protyle?.block?.rootID === window.__essNavigationRoot);
    await page.keyboard.press("Control+f");
    await page.locator(".ess-find-input").fill(process.env.SIYUAN_TEST_QUERY || "同学");
    await page.waitForFunction(() => window.__essTestPlugin.findController.highlightRange, undefined, {timeout: 20000});
    const result = await page.evaluate(async () => {
        const p = window.__essTestPlugin, f = p.findController;
        window.__essResultBlock = f.matches.find(match => match.block.id !== window.__essNavigationRoot).block.id;
        const repeated = f.matches.findIndex((match, index, all) => all[index + 1]?.block.id === match.block.id && all[index + 1]?.occurrence > match.occurrence);
        if (repeated < 0) throw new Error("Test query must have repeated matches inside a block.");
        f.current = repeated - 1; await f.go(1);
        const first = f.highlightRange.cloneRange();
        await f.go(1);
        const separate = first.compareBoundaryPoints(Range.START_TO_START, f.highlightRange) !== 0;
        const last = f.matches.at(-1);
        const unloaded = !f.editor.protyle.element.querySelector(`[data-node-id="${CSS.escape(last.block.id)}"]`);
        f.current = f.matches.length - 2; await f.go(1);
        return {matches: f.matches.length, separate, unloaded, error: f.counter.title, rootID: p.activeEditor()?.protyle?.block?.rootID};
    });
    assert.ok(result.matches > 2);
    assert.equal(result.separate, true, "same-block occurrences select separate text");
    assert.equal(result.error, "");
    // Also check after native render/scroll callbacks, not only when our Promise resolves.
    await page.waitForTimeout(250);
    const geometry = await page.evaluate(() => {
        const f = window.__essTestPlugin.findController;
        const hit = f.highlightRange?.getBoundingClientRect();
        const content = f.editor.protyle.contentElement.getBoundingClientRect(), bar = f.root.getBoundingClientRect();
        return {hit: hit?.toJSON(), top: Math.max(content.top, bar.bottom), bottom: Math.min(content.bottom, visualViewport.height + visualViewport.offsetTop), highlight: CSS.highlights?.has("ess-find-current"), text: f.highlightRange?.toString(), query: f.query};
    });
    if (!geometry.highlight) console.log("Highlight diagnostics:", await page.evaluate(() => {
        const f = window.__essTestPlugin.findController, match = f.matches[f.current];
        const block = f.editor.protyle.element.querySelector(`[data-node-id="${CSS.escape(match.block.id)}"]`);
        return {index: f.current, id: match.block.id, ordinal: match.occurrence, currentRange: !!f.highlightRange, candidate: !!f.rangeForMatch(match), loaded: f.loadedRanges?.length, block: !!block, units: [...block?.querySelectorAll("[contenteditable]") || []].map(e => ({tag: e.tagName, id: e.closest("[data-node-id]").dataset.nodeId, hits: e.textContent.split(f.query).length - 1}))};
    }));
    assert.equal(geometry.highlight, true, "highlight remains visible while search input has focus");
    assert.equal(geometry.text.toLocaleLowerCase(), geometry.query.toLocaleLowerCase());
    assert.ok(geometry.hit.top >= geometry.top - 1 && geometry.hit.bottom <= geometry.bottom + 1, `${scenario.name}: actual match must scroll into the visible reading area: ${JSON.stringify(geometry)}`);
    assert.equal(result.rootID, await page.evaluate(() => window.__essNavigationRoot));
    assert.ok(await page.evaluate(() => CSS.highlights.get("ess-find-all").size > 0), "loaded matches are highlighted, not only the current one");
    // Compare the actual painted pixels, including the case where the input owns focus.
    // Checking only the Highlight registry would miss an ineffective theme/style.
    const clip = {x: Math.max(0, Math.floor(geometry.hit.x)), y: Math.max(0, Math.floor(geometry.hit.y)), width: Math.ceil(geometry.hit.width), height: Math.ceil(geometry.hit.height)};
    for (const theme of ["daylight", "midnight"]) {
        const saved = await page.evaluate(async theme => {
            const link = document.getElementById("themeDefaultStyle");
            const saved = {href: link.href, mode: document.documentElement.dataset.themeMode};
            document.documentElement.dataset.themeMode = theme === "midnight" ? "dark" : "light";
            await new Promise((resolve, reject) => {link.onload = resolve; link.onerror = reject; link.href = `/appearance/themes/${theme}/theme.css`;});
            window.__essTestPlugin.findController.renderHighlights();
            return saved;
        }, theme);
        try {
            await page.evaluate(() => {
                const f = window.__essTestPlugin.findController;
                clearTimeout(f.highlightTimer);
                f.highlightObserver?.disconnect();
                f.renderHighlights();
            });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const current = await page.screenshot({clip, caret: "hide", animations: "disabled"});
            await page.evaluate(() => {CSS.highlights.delete("ess-find-current"); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));});
            const all = await page.screenshot({clip, caret: "hide", animations: "disabled"});
            await page.evaluate(() => {CSS.highlights.delete("ess-find-all"); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));});
            const plain = await page.screenshot({clip, caret: "hide", animations: "disabled"});
            assert.equal(current.equals(all), false, `${scenario.name}/${theme}: current hit has a visibly different highlight`);
            assert.equal(all.equals(plain), false, `${scenario.name}/${theme}: other hits have visible highlight backgrounds`);
            await page.evaluate(() => {
                const f = window.__essTestPlugin.findController;
                f.renderHighlights();
                f.observeHighlights();
            });
            await page.screenshot({path: path.join(output, `${scenario.name}-find-${theme}.png`), caret: "hide", animations: "disabled"});
        } finally {
            await page.evaluate(async saved => {
                const link = document.getElementById("themeDefaultStyle");
                document.documentElement.dataset.themeMode = saved.mode;
                await new Promise(resolve => {link.onload = resolve; link.href = saved.href;});
                const f = window.__essTestPlugin.findController;
                f.renderHighlights();
                f.observeHighlights();
            }, saved);
        }
    }
    console.log(`${scenario.name}: all-hit and current-hit highlights actually paint in light and dark themes`);
    console.log(`${scenario.name}: exact text navigation (${result.matches} hits, off-screen block ${result.unloaded ? "loaded" : "already rendered"}), persistent highlight${scenario.mobile ? "" : " and earliest unpinned tab eviction"} passed`);
    await page.getByRole("button", {name: "关闭篇内查找", exact: true}).click();
    if (scenario.mobile) await page.evaluate(() => window.dispatchEvent(new CustomEvent("siyuan-mobile-keyboard-change", {detail: false})));
    await page.keyboard.press("Control+Shift+f");
    await page.locator(".ess-search-dialog .ess-query").fill(process.env.SIYUAN_TEST_QUERY || "同学");
    await page.waitForFunction(() => {const view = window.__essTestPlugin.searchView; return view && !view.busy && view.query === view.input.value.trim();});
    const row = page.locator(".ess-block").first();
    assert.ok(await row.locator("mark").count(), "body result text is visibly highlighted");
    const destination = {rootID: await row.getAttribute("data-root-id"), blockID: await row.getAttribute("data-block-id")};
    assert.ok(destination.rootID && destination.blockID && destination.blockID !== destination.rootID, "each body row identifies its exact matching block");
    await page.evaluate(value => {window.__essClickedRoot = value.rootID; window.__essClickedBlock = value.blockID;}, destination);
    await row.click();
    await page.waitForFunction(() => {
        const p = window.__essTestPlugin;
        return p.dialog && p.dialog.element.classList.contains("ess-result-open") &&
            p.activeEditor()?.protyle?.block?.rootID === window.__essClickedRoot &&
            CSS.highlights?.has("ess-search-result-current");
    }, undefined, {timeout: 15000});
    await page.waitForFunction(() => {
        const e = window.__essTestPlugin.activeEditor().protyle;
        const block = e.wysiwyg.element.querySelector(`[data-node-id="${CSS.escape(window.__essClickedBlock)}"]`);
        if (!block) return false;
        const hit = block.getBoundingClientRect(), viewport = e.contentElement.getBoundingClientRect();
        return hit.height && hit.top >= viewport.top - 2 && hit.top < viewport.bottom;
    }, undefined, {timeout: 10000});
    assert.equal(await page.evaluate(() => window.__essTestPlugin.activeEditor().protyle.block.rootID), destination.rootID);
    const hit = await page.evaluate(() => {
        const range = [...CSS.highlights.get("ess-search-result-current")][0];
        return {text: range.toString(), rect: range.getBoundingClientRect().toJSON(), panel: document.querySelector(".ess-result-open .b3-dialog__container").getBoundingClientRect().toJSON(), query: document.querySelector(".ess-search-dialog .ess-query").value};
    });
    assert.equal(hit.text.toLocaleLowerCase(), hit.query.toLocaleLowerCase(), "global result highlight covers the actual matched text range");
    if (!(hit.rect.bottom <= hit.panel.top || hit.rect.top >= hit.panel.bottom || hit.rect.right <= hit.panel.left || hit.rect.left >= hit.panel.right)) console.log("Result scroll diagnostics:", await page.evaluate(() => {
        const e = window.__essTestPlugin.activeEditor().protyle, range = [...CSS.highlights.get("ess-search-result-current")][0];
        const ancestors = [];
        for (let node = range.startContainer.parentElement; node && node !== document.body; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (node.scrollHeight > node.clientHeight + 2 || /auto|scroll/.test(style.overflowY)) ancestors.push({tag: node.tagName, cls: node.className, top: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: style.overflowY});
        }
        return {content: {cls: e.contentElement.className, top: e.contentElement.scrollTop, scrollHeight: e.contentElement.scrollHeight, clientHeight: e.contentElement.clientHeight}, windowY: scrollY, hit: range.getBoundingClientRect().toJSON(), ancestors};
    }));
    assert.ok(hit.rect.bottom <= hit.panel.top || hit.rect.top >= hit.panel.bottom || hit.rect.right <= hit.panel.left || hit.rect.left >= hit.panel.right, `${scenario.name}: compact search stays open without covering the matched text: ${JSON.stringify(hit)}`);
    const resultClip = {x: Math.max(0, Math.floor(hit.rect.x)), y: Math.max(0, Math.floor(hit.rect.y)), width: Math.ceil(hit.rect.width), height: Math.ceil(hit.rect.height)};
    const painted = await page.screenshot({clip: resultClip, caret: "hide", animations: "disabled"});
    await page.screenshot({path: path.join(output, `${scenario.name}-global-hit.png`), clip: resultClip, caret: "hide", animations: "disabled"});
    await page.evaluate(() => {CSS.highlights.delete("ess-search-result-current"); CSS.highlights.delete("ess-search-result");});
    const plain = await page.screenshot({clip: resultClip, caret: "hide", animations: "disabled"});
    await page.screenshot({path: path.join(output, `${scenario.name}-global-hit-plain.png`), clip: resultClip, caret: "hide", animations: "disabled"});
    assert.equal(painted.equals(plain), false, `${scenario.name}: the exact text highlight is visibly painted`);
    await page.evaluate(() => window.__essTestPlugin.searchResultHighlighter.paint(false));
    assert.equal(await page.locator(".ess-search-dialog .ess-query").isVisible(), true);
    console.log(`${scenario.name}: global result stays open, highlights the exact text, and scrolls it clear of the panel`);
}

module.exports = {checkNavigation};
