const test = require("node:test");
const assert = require("node:assert/strict");
const {setup} = require("./helpers.cjs");
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const modifier of ["ctrlKey", "metaKey"]) {
    test(modifier + "+P also takes over native quick search without creating a tab", async t => {
        const app = await setup(t);
        const event = app.press({[modifier]: true, key: "p", code: "KeyP"});
        assert.equal(event.defaultPrevented, true);
        assert.equal(app.nativeCalls(), 0);
        assert.ok(app.plugin.dialog);
        assert.equal(app.tabs.length, 0);
    });
}

test("desktop and mobile native search buttons open only the plugin overlay", async t => {
    for (const frontend of ["desktop", "browser-mobile"]) {
        const app = await setup(t, {frontend});
        const button = app.document.createElement("button");
        button.id = frontend === "desktop" ? "barSearch" : "mobileBottomBarSearch";
        const icon = app.document.createElement("span");
        button.append(icon); app.document.body.append(button);
        let native = 0; button.onclick = () => native++;
        icon.click();
        assert.equal(native, 0);
        assert.ok(app.plugin.dialog);
        assert.equal(app.tabs.length, 0);
        assert.equal(app.document.querySelector(".ess-pin"), null);
    }
});

test("native command-panel search redirects on both click and Enter", async t => {
    const app = await setup(t);
    const panel = app.document.createElement("div");
    panel.dataset.key = "dialog-commandpanel";
    panel.innerHTML = '<input><ul id="commands"><li class="b3-list-item--focus" data-command-id="core.general.stickSearch">搜索</li></ul>';
    app.document.body.append(panel);
    let destroyed = 0;
    app.window.siyuan.dialogs.push({element: panel, destroy() {destroyed++; panel.remove(); app.window.siyuan.dialogs = [];}});
    panel.querySelector("input").dispatchEvent(new app.window.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}));
    assert.equal(destroyed, 1);
    assert.ok(app.plugin.dialog);
    assert.equal(app.tabs.length, 0);
    app.plugin.dialog.destroy();
    app.document.body.insertAdjacentHTML("beforeend", '<button data-command-id="core.context.search">搜索</button>');
    app.document.querySelector("[data-command-id]").click();
    assert.equal(app.plugin.findController.opened, true);
    assert.equal(app.plugin.dialog, null);
});

test("native note menu search finds in its supplied editor; notebook menu opens global search", async t => {
    const app = await setup(t);
    app.document.body.insertAdjacentHTML("beforeend", '<button class="b3-menu__item" data-id="search">搜索</button>');
    app.listeners.get("open-menu-content")({type: "open-menu-content", detail: {protyle: {element: app.document.getElementById("second"), block: {rootID: "second"}}}});
    app.document.querySelector("[data-id=search]").click();
    assert.equal(app.plugin.findController.editor.protyle.block.rootID, "second");
    assert.equal(app.plugin.dialog, null);
    app.listeners.get("open-menu-doctree")({type: "open-menu-doctree", detail: {}});
    app.document.querySelector("[data-id=search]").click();
    assert.ok(app.plugin.dialog);
    assert.equal(app.plugin.findController.opened, false);
});

test("settings and outline filters and plugin menu entries are not mistaken for native note search", async t => {
    const app = await setup(t, {frontend: "mobile"});
    app.document.body.insertAdjacentHTML("beforeend", '<button data-type="search">过滤</button><button class="b3-menu__item" data-id="search" data-topbar-entry="plugin:siyuan-easy-search:search">顺手搜索</button>');
    let native = 0;
    for (const button of app.document.querySelectorAll("button")) {button.onclick = () => native++; button.click();}
    assert.equal(native, 2);
    assert.equal(app.plugin.dialog, null);
});

for (const key of ["dialog-globalsearch", "dialog-search", "dialog-replace"]) {
    test(key + " from a native command is closed through the host and redirected with its query", async t => {
        const app = await setup(t);
        const element = app.document.createElement("div");
        element.dataset.key = key;
        element.innerHTML = '<textarea id="searchInput">关键词</textarea>';
        let destroyed = 0;
        const dialog = {element, destroy() {destroyed++; element.remove(); app.window.siyuan.dialogs = [];}};
        app.window.siyuan.dialogs.push(dialog); app.document.body.append(element);
        await flush();
        assert.equal(destroyed, 1);
        const global = key === "dialog-globalsearch";
        assert.equal(!!app.plugin.dialog, global);
        assert.equal(global ? app.plugin.searchView.input.value : app.plugin.findController.input.value, "关键词");
        assert.equal(app.tabs.length, 0);
    });
}

test("native search tabs are closed and their query moves to a dialog", async t => {
    const app = await setup(t);
    const panel = app.document.createElement("div");
    panel.innerHTML = '<textarea id="searchInput">旧查询</textarea>';
    let removed;
    app.models.search.push({parent: {id: "search-tab", panelElement: panel, parent: {removeTab(id) {removed = id; app.models.search = []; panel.remove();}}}});
    app.document.body.append(panel);
    await flush();
    assert.equal(removed, "search-tab");
    assert.equal(app.plugin.searchView.input.value, "旧查询");
    assert.equal(app.tabs.length, 0);
});

test("mobile native search uses the host close button before opening the plugin", async t => {
    const app = await setup(t, {frontend: "browser-mobile"});
    const model = app.document.createElement("div");
    model.id = "model"; model.style.transform = "translateX(0px)";
    model.innerHTML = '<textarea id="toolbarSearch">手机词</textarea><svg id="modelClose"></svg>';
    let closed = 0;
    model.querySelector("svg").addEventListener("click", () => {closed++; model.style.transform = "";});
    app.document.body.append(model); await flush();
    assert.equal(closed, 1);
    assert.equal(app.plugin.searchView.input.value, "手机词");
    assert.equal(app.tabs.length, 0);
});

test("opening global search removes the desktop floating find bar and legacy pin calls open a dialog", async t => {
    const app = await setup(t);
    await app.plugin.openFind();
    app.plugin.openPinned();
    assert.equal(app.plugin.findController.opened, false);
    assert.ok(app.plugin.dialog);
    assert.equal(app.tabs.length, 0);
    assert.equal(app.plugin.searchView.root.querySelector(".ess-find-note"), null);
    app.press({ctrlKey: true});
    assert.equal(app.plugin.dialog, null);
    assert.equal(app.plugin.findController.opened, true);
});

test("a native current-note search without an editor never falls back to global search", async t => {
    const app = await setup(t);
    app.setEditor(null);
    app.document.body.insertAdjacentHTML("beforeend", '<button data-command-id="core.context.search">搜索</button>');
    app.document.querySelector("[data-command-id]").click();
    assert.equal(app.plugin.dialog, null);
    assert.match(app.messages[0][0], /请先打开一篇笔记/);
});

test("unloading restores native buttons and stops observing search dialogs", async t => {
    const app = await setup(t);
    await app.plugin.onunload();
    assert.equal(app.document.body.classList.contains("ess-takeover"), false);
    app.document.body.insertAdjacentHTML("beforeend", '<button id="barSearch">搜索</button><div data-key="dialog-search"><textarea id="searchInput"></textarea></div>');
    let calls = 0; app.document.getElementById("barSearch").onclick = () => calls++;
    app.document.getElementById("barSearch").click(); await flush();
    assert.equal(calls, 1);
    assert.equal(app.plugin.dialog, null);
    assert.equal(app.listeners.size, 0);
});

test("current-note search sends the active document path to the index", async t => {
    let request;
    const app = await setup(t, {api: (_url, body) => {request = body; return {blocks: []};}});
    const editor = app.plugin.activeEditor();
    editor.protyle.notebookId = "notebook"; editor.protyle.path = "/first.sy";
    await app.plugin.openFind("词", editor);
    assert.deepEqual(Array.from(request.paths), ["notebook/first.sy"]);
});

test("rapid Escape and reopen works while the host is still closing the previous dialog", async t => {
    const app = await setup(t, {dialogCloseDelay: 20});
    app.plugin.openSearch();
    const old = app.plugin.dialog;
    app.plugin.searchView.input.value = "旧词";
    app.plugin.closeSearch();
    app.plugin.openSearch();
    const current = app.plugin.dialog;
    app.plugin.searchView.input.value = "新词";
    assert.notEqual(current, old);
    assert.equal(app.document.querySelectorAll(".ess-search-dialog").length, 1);
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(app.plugin.dialog, current);
    assert.equal(app.plugin.searchView.input.value, "新词");
    assert.equal(app.plugin.searchState.query, "旧词");
});
