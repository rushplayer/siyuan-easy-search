const test = require("node:test");
const assert = require("node:assert/strict");
const {setup} = require("./helpers.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));

async function searchApp(t, options = {}) {
    const requests = [];
    const app = await setup(t, {api: async (url, body) => {
        requests.push(body.query);
        if (options.api) return options.api(url, body);
        return {blocks: [{id: "note", rootID: "note", content: "关键词"}], matchedBlockCount: 1};
    }});
    app.plugin.openSearch();
    return {...app, requests, view: app.plugin.searchView};
}

test("Enter with a selected global result searches without opening or closing anything", async t => {
    const app = await searchApp(t);
    app.view.input.value = "关键词";
    await app.view.load();
    assert.equal(app.view.selected, 0);
    const event = app.press({key: "Enter", code: "Enter"});
    await flush();
    assert.equal(event.defaultPrevented, true);
    assert.equal(app.requests.length, 4);
    assert.ok(app.plugin.dialog);
    assert.equal(app.tabs.length, 0);
    assert.equal(app.view.input.value, "关键词");
    app.view.results.querySelector(".ess-doc-title").click();
    await flush();
    assert.equal(app.tabs.length, 1);
    assert.ok(app.plugin.dialog, "opening a result keeps the global search dialog open");
    assert.equal(app.view.input.value, "关键词");
});

test("the visible Search button submits once and cancels the pending typing timer", async t => {
    const app = await searchApp(t);
    app.view.input.value = "新关键词";
    app.view.schedule();
    const button = app.document.querySelector(".ess-submit");
    assert.equal(button.textContent, "搜索");
    button.click();
    await new Promise(resolve => setTimeout(resolve, 190));
    assert.deepEqual(app.requests, ["新关键词", "新关键词"]);
    assert.ok(app.plugin.dialog);
    assert.equal(app.tabs.length, 0);
});

test("Enter submits a new query even while the previous search is still busy", async t => {
    let finishOld;
    const app = await searchApp(t, {api: (_url, body) => body.query === "旧词" ? new Promise(resolve => {finishOld = resolve;}) : {blocks: []}});
    app.view.input.value = "旧词";
    void app.view.load();
    app.view.input.value = "新词";
    app.press({key: "Enter", code: "Enter"});
    await flush();
    assert.equal(app.view.query, "新词");
    assert.equal(app.requests.filter(query => query === "新词").length, 2);
    finishOld({blocks: []});
    assert.ok(app.plugin.dialog);
    assert.equal(app.tabs.length, 0);
});

test("IME confirmation does not submit or open a global result", async t => {
    const app = await searchApp(t);
    app.view.input.value = "拼音";
    app.press({key: "Enter", code: "Enter", isComposing: true});
    await flush();
    assert.equal(app.requests.length, 0);
    assert.ok(app.plugin.dialog);
    assert.equal(app.tabs.length, 0);
});

test("global results highlight title and body text in a flat paged list, and body clicks target the hit block", async t => {
    const requestedPages = [];
    const app = await setup(t, {api: async (_url, body) => {
        requestedPages.push({page: body.page, size: body.pageSize, titles: body.types.document});
        return body.types.document
            ? {blocks: [{id: "note", content: "同学记录", hPath: "/同学记录"}], matchedBlockCount: 25, pageCount: 2}
            : {blocks: [{id: `hit-${body.page}`, rootID: "note", content: `今天和<mark>同学</mark>一起` , hPath: "/同学记录/日记"}], matchedBlockCount: 45, matchedRootCount: 10, pageCount: 3};
    }});
    app.plugin.openSearch();
    const view = app.plugin.searchView;
    assert.equal(view.pageSizeSelect.value, "50");
    assert.deepEqual([...view.pageSizeSelect.options].map(option => option.value), ["50", "100", "200"]);
    view.input.value = "同学";
    await view.load();
    assert.ok(app.document.querySelectorAll(".ess-doc-title mark").length > 0);
    assert.ok(app.document.querySelectorAll(".ess-block mark").length > 0);
    assert.equal(app.document.querySelector(".ess-group, .ess-group-header, .ess-toggle, .ess-more"), null);
    assert.equal(app.document.querySelectorAll(".ess-block").length, 1);
    const row = app.document.querySelector(".ess-block");
    assert.ok(row.querySelector(".ess-hit-title") && row.querySelector(".ess-hit-snippet"));
    assert.equal(row.title, "", "full content is available through disclosure rather than a tooltip");
    assert.equal(row.querySelector(".ess-path"), null, "a body hit contains only the note name and matching line");
    assert.equal(app.document.querySelector(".ess-page-label").textContent, "第 1 / 3 页");
    await view.load(2);
    assert.equal(app.document.querySelectorAll(".ess-block").length, 1, "pages replace the list instead of accumulating waterfall rows");
    assert.equal(app.document.querySelector(".ess-block").dataset.blockId, "hit-2");
    assert.deepEqual(requestedPages.slice(-2), [{page: 2, size: 50, titles: true}, {page: 2, size: 50, titles: false}]);
    view.pageSizeSelect.value = "100";
    view.pageSizeSelect.dispatchEvent(new app.window.Event("change", {bubbles: true}));
    await flush();
    assert.deepEqual(requestedPages.slice(-2), [{page: 1, size: 100, titles: true}, {page: 1, size: 100, titles: false}]);
    assert.equal(app.plugin.searchState.pageSize, 100);
    assert.equal(view.pageLabel.textContent, "第 1 / 3 页");
    let opened;
    app.plugin.openResult = async (...args) => {opened = args;};
    app.document.querySelector(".ess-block").click();
    await flush();
    assert.equal(opened[0], "note");
    assert.equal(opened[1].id, "hit-1");
    assert.equal(opened[2], "同学");
});

test("global page size is saved and restored when the plugin is reopened", async t => {
    const app = await setup(t, {data: {query: "", pageSize: 50}, api: async () => ({blocks: [], pageCount: 1})});
    app.plugin.openSearch();
    const select = app.plugin.searchView.pageSizeSelect;
    select.value = "200";
    select.dispatchEvent(new app.window.Event("change", {bubbles: true}));
    await flush();
    assert.equal(app.savedData.at(-1).name, "data.json");
    assert.equal(app.savedData.at(-1).data.pageSize, 200);

    const reopened = await setup(t, {data: app.savedData.at(-1).data, api: async () => ({blocks: [], pageCount: 1})});
    reopened.plugin.openSearch();
    assert.equal(reopened.plugin.searchView.pageSizeSelect.value, "200");
});

test("body results expand complete highlighted text without opening a note, and collapse again", async t => {
    const content = "前文".repeat(100) + "同学" + "后文".repeat(100) + "\n末行<script>不作为代码执行</script>";
    const escaped = content.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const app = await setup(t, {api: async (_url, body) => body.types.document ? {blocks: []} : {blocks: [{id: "hit", rootID: "note", hPath: "/笔记", content: escaped}]}});
    app.plugin.openSearch();
    const view = app.plugin.searchView;
    view.input.value = "同学";
    await view.load();
    const row = view.results.querySelector(".ess-block");
    const item = row.parentElement;
    const expand = item.querySelector(".ess-expand");
    const full = item.querySelector(".ess-full-content");
    assert.equal(full.hidden, true);
    assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.equal(full.textContent, content, "expanded content retains the complete response including line breaks");
    assert.equal(full.querySelector("mark").textContent, "同学");
    assert.equal(full.querySelector("script"), null, "hit content is plain text");
    assert.ok(row.querySelector(".ess-hit-snippet").textContent.length < full.textContent.length);
    expand.click();
    assert.equal(full.hidden, false);
    assert.equal(expand.getAttribute("aria-expanded"), "true");
    assert.equal(expand.getAttribute("aria-label"), "收起完整命中内容");
    assert.equal(app.tabs.length, 0, "expansion does not navigate away");
    assert.ok(app.plugin.dialog);
    expand.click();
    assert.equal(full.hidden, true);
    assert.equal(expand.getAttribute("aria-expanded"), "false");
    assert.equal(app.tabs.length, 0);
    let opened;
    app.plugin.openResult = async (...args) => {opened = args;};
    row.click();
    await flush();
    assert.equal(opened[1].id, "hit", "clicking the one-line result still opens the matching location");
});

test("clicking a global body result keeps search open and highlights and scrolls to the exact matched text", async t => {
    const app = await setup(t, {api: async (_url, body) => body.types.document
        ? {blocks: []}
        : {blocks: [{id: "hit", rootID: "first", hPath: "/笔记", content: "有词，<mark>关键词</mark>尾"}], matchedBlockCount: 1, matchedRootCount: 1, pageCount: 1}});
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = '<div class="protyle-wysiwyg" contenteditable="true"><div data-node-id="hit"><div contenteditable="true">有词，关键词尾</div></div></div>';
    const editor = app.plugin.activeEditor();
    editor.protyle.wysiwyg = {element: host.querySelector(".protyle-wysiwyg")};
    const scrolls = [];
    editor.protyle.contentElement = {getBoundingClientRect: () => ({top: 0, bottom: 600}), scrollBy: value => scrolls.push(value)};
    app.window.Range.prototype.getClientRects = function() {return [{left: 80, right: 130, top: 500, bottom: 520, width: 50, height: 20}];};
    app.window.CSS = {highlights: new Map()};
    app.window.Highlight = class {constructor(...ranges) {this.ranges = ranges;} [Symbol.iterator]() {return this.ranges[Symbol.iterator]();}};
    app.plugin.openSearch();
    const view = app.plugin.searchView;
    view.input.value = "关键词";
    await view.load();
    view.results.querySelector(".ess-block").click();
    await new Promise(resolve => setTimeout(resolve, 30));
    const current = app.window.CSS.highlights.get("ess-search-result-current");
    assert.equal(current.ranges[0].toString(), "关键词");
    assert.equal(current.ranges[0].startOffset, 3);
    assert.equal(app.window.CSS.highlights.get("ess-search-result").ranges.length, 1);
    assert.ok(scrolls.length && scrolls[0].top > 0, "the text range, rather than only its block, is scrolled into view");
    assert.ok(app.plugin.dialog);
    assert.equal(app.plugin.searchView.input.value, "关键词");
    assert.equal(app.plugin.dialog.element.classList.contains("ess-result-open"), true);
    assert.equal(app.document.querySelector(".ess-search-dialog").isConnected, true);
    app.plugin.closeSearch();
    assert.equal(app.window.CSS.highlights.size, 0);
});

test("global result highlighting falls back to a noneditable overlay on older WebViews", async t => {
    const app = await setup(t, {api: async (_url, body) => body.types.document
        ? {blocks: []}
        : {blocks: [{id: "hit", rootID: "first", content: "<mark>词</mark>和<mark>词</mark>"}], matchedBlockCount: 1, matchedRootCount: 1, pageCount: 1}});
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = '<div class="protyle-wysiwyg" contenteditable="true"><div data-node-id="hit"><div contenteditable="true">词和词</div></div></div>';
    const editor = app.plugin.activeEditor();
    editor.protyle.wysiwyg = {element: host.querySelector(".protyle-wysiwyg")};
    editor.protyle.contentElement = {getBoundingClientRect: () => ({top: 0, bottom: 600}), scrollBy() {}};
    app.window.Range.prototype.getClientRects = function() {return [{left: 30, right: 40, top: 100 + this.startOffset * 20, bottom: 120 + this.startOffset * 20, width: 10, height: 20}];};
    app.window.CSS = {};
    app.window.Highlight = undefined;
    const original = host.innerHTML;
    app.plugin.openSearch();
    app.plugin.searchView.input.value = "词";
    await app.plugin.searchView.load();
    app.plugin.searchView.results.querySelector(".ess-block").click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(app.document.querySelectorAll(".ess-result-mark").length, 2);
    assert.equal(app.document.querySelectorAll(".ess-result-mark-current").length, 1);
    assert.equal(host.innerHTML, original);
    assert.ok(app.plugin.dialog);
    app.plugin.closeSearch();
    assert.equal(app.document.querySelector(".ess-result-marks"), null);
});

test("current-note find paints every loaded hit, updates rendered blocks, and cleans up", async t => {
    const app = await setup(t);
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = '<div class="protyle-wysiwyg" contenteditable="true"><div data-node-id="hit"><div contenteditable="true">词 词</div></div></div>';
    const original = host.innerHTML;
    app.window.CSS = {highlights: new Map()};
    app.window.Highlight = class {constructor(...ranges) {this.ranges = ranges;}};
    app.plugin.searchAll = async () => [{id: "hit", rootID: "first", content: "词 词"}];
    await app.plugin.openFind("词");
    const f = app.plugin.findController;
    f.editor.protyle.wysiwyg = {element: host.querySelector(".protyle-wysiwyg")};
    assert.equal(app.window.CSS.highlights.get("ess-find-all").ranges.length, 2);
    assert.equal(app.window.CSS.highlights.get("ess-find-current").priority, 1);
    assert.equal(host.querySelector(".protyle-wysiwyg").outerHTML, original);
    host.querySelector(".protyle-wysiwyg").insertAdjacentHTML("beforeend", '<div data-node-id="loaded"><div contenteditable="true">词</div></div>');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(app.window.CSS.highlights.get("ess-find-all").ranges.length, 3);
    assert.equal(host.querySelector("mark"), null);
    host.insertAdjacentHTML("afterbegin", '<div class="protyle-gutters"><div data-node-id="hit"></div></div>');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(app.window.CSS.highlights.get("ess-find-current").ranges[0].toString(), "词", "gutter controls with the same block ID cannot hide the text highlight");
    f.input.value = "不存在";
    await f.refresh();
    assert.equal(app.window.CSS.highlights.get("ess-find-all").ranges.length, 0);
    assert.equal(app.window.CSS.highlights.has("ess-find-current"), false);
    f.close();
    assert.equal(app.window.CSS.highlights.size, 0);
});

test("current-note find acts on text occurrences, seeds a selection, and follows document order", async t => {
    const app = await setup(t);
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = '<div class="protyle-wysiwyg" contenteditable="true"><div data-node-id="earlier"><div contenteditable="true">词词</div></div><div data-node-id="later"><div contenteditable="true">词</div></div></div>';
    const selectionRange = app.document.createRange();
    selectionRange.selectNodeContents(host.querySelector('[data-node-id="later"] [contenteditable="true"]'));
    app.window.getSelection().addRange(selectionRange);
    app.window.CSS = {highlights: new Map()};
    app.window.Highlight = class {constructor(...ranges) {this.ranges = ranges;}};
    app.plugin.searchAll = async query => {
        assert.equal(query, "词");
        return [
            {id: "later", rootID: "first", sort: "002", content: "词"},
            {id: "earlier", rootID: "first", sort: "001", content: "词词"},
        ];
    };

    await app.plugin.openFind();
    const find = app.plugin.findController;
    assert.equal(find.input.value, "词", "Ctrl+F starts from selected note text");
    assert.equal(find.counter.textContent, "1 / 3", "the counter counts individual text matches rather than blocks");
    assert.deepEqual(Array.from(find.matches, match => match.block.id), ["earlier", "earlier", "later"]);
    assert.equal(find.root.querySelector(".ess-block, .ess-group"), null, "the find widget has no block result list or groups");
    await find.go(1);
    assert.equal(find.counter.textContent, "2 / 3");
});

test("older WebViews highlight using overlays without editing note content or stealing selection", async t => {
    const app = await setup(t);
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = '<div data-node-id="hit"><div contenteditable="true">词 词</div></div>';
    app.window.Range.prototype.getClientRects = function() {return [{left: 50, right: 80, top: 200 + this.startOffset * 10, bottom: 220 + this.startOffset * 10, width: 30, height: 20}];};
    app.plugin.searchAll = async () => [{id: "hit", rootID: "first", content: "词 词"}];
    await app.plugin.openFind("词");
    assert.equal(app.document.querySelectorAll(".ess-find-mark").length, 3);
    assert.equal(app.document.querySelectorAll(".ess-find-mark-current").length, 1);
    assert.equal(host.querySelector("mark, .ess-find-marks"), null);
    const selection = app.window.getSelection();
    const anchor = selection.anchorNode, offset = selection.anchorOffset;
    await app.plugin.findController.go(1);
    assert.equal(selection.anchorNode, anchor);
    assert.equal(selection.anchorOffset, offset);
    app.plugin.findController.close();
    assert.equal(app.document.querySelector(".ess-find-marks"), null);
});
