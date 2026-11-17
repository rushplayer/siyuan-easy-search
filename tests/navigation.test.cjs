const test = require("node:test");
const assert = require("node:assert/strict");
const {JSDOM} = require("jsdom");
const {collectUnits} = require("../src/core.js");
const {setup} = require("./helpers.cjs");

test("real SiYuan editable wrappers count each text region once, including read-only cells", () => {
    const dom = new JSDOM(`<div data-node-id="doc"><div class="protyle-wysiwyg" contenteditable="true">
        <div data-node-id="p"><div contenteditable="true">一<b>词</b>二<span contenteditable="false">词</span></div><div class="protyle-attr" contenteditable="false">属性</div></div>
        <div data-node-id="table"><table><tr><td contenteditable="false">单元格</td><td contenteditable="true">另一格</td></tr></table></div>
    </div></div>`);
    assert.deepEqual(collectUnits(dom.window.document.body).map(unit => [unit.id, unit.text]), [["p", "一词二词"], ["table", "单元格"], ["table", "另一格"]]);
    dom.window.close();
});

test("Escape closes global search even if a late editor callback moves focus", async t => {
    const app = await setup(t);
    app.plugin.openSearch();
    app.document.getElementById("first").focus();
    app.press({key: "Escape", code: "Escape"});
    assert.equal(app.plugin.dialog, null);
});

function note(app, html) {
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = `<div class="protyle-wysiwyg" contenteditable="true">${html}</div>`;
    return host;
}

test("find scrolls the exact repeated occurrence and keeps its highlight while typing", async t => {
    const app = await setup(t);
    note(app, '<div data-node-id="hit"><div contenteditable="true">词 词</div></div>');
    const highlights = new Map();
    app.window.CSS = {highlights};
    app.window.Highlight = class {constructor(range) {this.range = range;}};
    const scrolls = [];
    app.plugin.activeEditor().protyle.contentElement = {getBoundingClientRect: () => ({top: 0, bottom: 600}), scrollBy: value => scrolls.push(value.top)};
    app.window.Range.prototype.getClientRects = function() {return [{top: this.startOffset ? 900 : 200, height: 20, width: 20}];};
    app.plugin.searchAll = async () => [{id: "hit", rootID: "first", content: "<mark>词</mark> 词"}];
    await app.plugin.openFind("词");
    assert.equal(app.tabs.length, 0, "loaded matches must not reopen the note");
    assert.equal(highlights.get("ess-find-current").range.startOffset, 0);
    await app.plugin.findController.go(1);
    assert.equal(highlights.get("ess-find-current").range.startOffset, 2);
    assert.ok(scrolls[1] > scrolls[0] + 600);
    assert.equal(app.document.activeElement, app.plugin.findController.input);
    await app.plugin.findController.go(1);
    assert.equal(app.plugin.findController.counter.dataset.wrapped, "true");
    app.plugin.findController.close();
    assert.equal(highlights.size, 0);
});

test("find waits for an asynchronously rendered block without recording recent notes", async t => {
    const app = await setup(t);
    const host = note(app, "");
    app.plugin.searchAll = async () => [{id: "later", rootID: "first", content: "目标"}];
    let opens = 0;
    app.plugin.navigateTo = async () => {opens++; setTimeout(() => {host.firstChild.innerHTML = '<div data-node-id="later"><div contenteditable="true">目标</div></div>';}, 20);};
    await app.plugin.openFind("目标");
    assert.equal(opens, 1);
    assert.equal(app.plugin.findController.highlightRange.toString(), "目标");
    assert.equal(app.plugin.recent.length, 0);
});

test("rapid next/previous ignores a stale block load", async t => {
    const app = await setup(t);
    const host = note(app, '<div data-node-id="one"><div contenteditable="true">词</div></div>');
    app.plugin.searchAll = async () => [{id: "one", rootID: "first", content: "词"}, {id: "two", rootID: "first", content: "词"}];
    await app.plugin.openFind("词");
    let finish;
    app.plugin.navigateTo = () => new Promise(resolve => {finish = resolve;});
    const pending = app.plugin.findController.go(1);
    await app.plugin.findController.go(-1);
    host.firstChild.insertAdjacentHTML("beforeend", '<div data-node-id="two"><div contenteditable="true">词</div></div>');
    finish(); await pending;
    assert.equal(app.plugin.findController.highlightRange.startContainer.parentElement.closest("[data-node-id]").dataset.nodeId, "one");
    assert.equal(app.plugin.findController.counter.textContent, "1 / 2");
});

test("find navigates repeated occurrences across table cells", async t => {
    const app = await setup(t);
    note(app, '<div data-node-id="table"><table><tr><td contenteditable="true">词</td><td contenteditable="true">词</td></tr></table></div>');
    app.plugin.searchAll = async () => [{id: "table", rootID: "first", content: "词 词"}];
    await app.plugin.openFind("词");
    const first = app.plugin.findController.highlightRange.startContainer;
    await app.plugin.findController.go(1);
    assert.notEqual(app.plugin.findController.highlightRange.startContainer, first);
});

test("DOM fallback retains the exact cell when the index is unavailable", async t => {
    const app = await setup(t);
    note(app, '<div data-node-id="table"><table><tr><td contenteditable="true">词</td><td contenteditable="true">词</td></tr></table></div>');
    app.plugin.searchAll = async () => {throw new Error("offline");};
    await app.plugin.openFind("词");
    const first = app.plugin.findController.highlightRange.startContainer;
    await app.plugin.findController.go(1);
    assert.notEqual(app.plugin.findController.highlightRange.startContainer, first);
});

async function tabApp(t, limit = 2) {
    const all = [], closed = [];
    const app = await setup(t, {getAllTabs: () => all, openTab: options => {
        assert.equal(options.keepCursor, false);
        assert.equal(options.removeCurrentTab, false);
        if (!all.some(tab => tab.model?.editor?.protyle.block.rootID === options.doc.id)) add(options.doc.id);
    }});
    app.window.siyuan.config = {fileTree: {maxOpenTabCount: limit}};
    const element = app.document.createElement("div");
    element.className = "layout__wnd--active";
    app.document.body.append(element);
    const pane = {element, children: all, removeTab: async id => {closed.push(id); all.splice(all.findIndex(tab => tab.id === id), 1); return true;}};
    function add(id, pinned = false) {
        const headElement = app.document.createElement("li");
        if (pinned) headElement.classList.add("item--pin");
        const tab = {id, headElement, parent: pane, model: {editor: {protyle: {block: {rootID: id}}}}};
        all.push(tab); app.plugin.rememberTabs();
        return tab;
    }
    return {app, all, closed, pane, add};
}

test("tab limit closes earliest opened even after activation and tab reordering", async t => {
    const {app, all, closed, add} = await tabApp(t);
    const first = add("first"); add("second");
    first.headElement.classList.add("item--focus");
    first.headElement.dataset.activetime = "999999";
    all.reverse();
    await app.plugin.openResult("third", null, "", false);
    assert.deepEqual(closed, ["first"]);
    assert.deepEqual(all.map(tab => tab.id), ["second", "third"]);
});

test("existing and restored result tabs are reused without eviction", async t => {
    const {app, closed, add} = await tabApp(t);
    const first = add("first"); add("second");
    await app.plugin.openResult("first", {id: "first"}, "", false);
    first.model = null;
    first.headElement.dataset.initdata = JSON.stringify({instance: "Editor", rootId: "first"});
    await app.plugin.makeRoomForResult("first");
    assert.deepEqual(closed, []);
});

test("pinned tabs survive eviction, including when every tab is pinned", async t => {
    const {app, closed, add} = await tabApp(t);
    add("first", true); add("second");
    await app.plugin.openResult("third", null, "", false);
    assert.deepEqual(closed, ["second"]);
    add("fourth", true);
    await app.plugin.makeRoomForResult("fifth");
    assert.deepEqual(closed, ["second", "third"]);
});

test("a refused close leaves the search result unopened", async t => {
    const {app, pane, add} = await tabApp(t, 1);
    add("first"); pane.removeTab = async () => false;
    await assert.rejects(app.plugin.openResult("second", null, "", false), /暂时无法关闭/);
    assert.equal(app.tabs.length, 0);
    assert.equal(app.plugin.recent.length, 0);
});

test("concurrent results enforce the tab limit in order", async t => {
    const {app, all, closed, add} = await tabApp(t);
    add("first"); add("second");
    await Promise.all([app.plugin.openResult("third", null, "", false), app.plugin.openResult("fourth", null, "", false)]);
    assert.deepEqual(closed, ["first", "second"]);
    assert.deepEqual(all.map(tab => tab.id), ["third", "fourth"]);
});
