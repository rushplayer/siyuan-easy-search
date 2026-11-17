const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {setup} = require("./helpers.cjs");

const frontends = ["desktop", "desktop-window", "browser-desktop", "mobile", "browser-mobile"];
const subnoteEntry = path.resolve(__dirname, "../../siyuan-subnote-index/index.js");
const hasSubnote = fs.existsSync(subnoteEntry);

for (const frontend of frontends) {
    const mobile = frontend.includes("mobile");
    test(`${frontend}: global search, touch find and navigation use supported SDK calls`, async t => {
        const app = await setup(t, {frontend, backend: frontend.startsWith("browser") ? "docker" : "ios"});
        app.topBars.find(item => item.id === "search").callback();
        assert.ok(app.document.querySelector('[aria-label="搜索笔记和内容"]'));
        assert.equal(app.document.querySelector(".ess-pin"), null);
        assert.equal(app.plugin.dialog.element.classList.contains("ess-mobile-dialog"), mobile);
        await app.breadcrumbs[0].callback({}, {element: app.document.getElementById("second"), block: {rootID: "second"}});
        assert.equal(app.plugin.dialog, null);
        assert.equal(app.plugin.findController.editor.protyle.block.rootID, "second");
        assert.equal(app.plugin.findController.root.parentElement, mobile ? app.document.body : app.document.getElementById("second"));
        await app.plugin.openResult("document", {id: "content-block"}, "query", true, "标题");
        assert.equal(app.mobileOpens.length, mobile ? 1 : 0);
        assert.equal(app.tabs.length, mobile ? 0 : 1);
        assert.equal(mobile ? app.mobileOpens[0][1] : app.tabs[0].doc.id, "content-block");
        assert.equal(app.plugin.recent[0].id, "document");
    });

    test(`${frontend}: Ctrl+Shift+F opens an overlay without a split on every frontend`, async t => {
        const app = await setup(t, {frontend});
        assert.equal(app.press({ctrlKey: true, shiftKey: true}).defaultPrevented, true);
        assert.equal(app.nativeCalls(), 0);
        assert.ok(app.plugin.dialog);
        assert.equal(app.tabs.length, 0);
        if (mobile) {
            await app.topBars.find(item => item.id === "find").callback();
            assert.equal(app.plugin.dialog, null);
            assert.equal(app.plugin.findController.opened, true);
        }
    });
}

test("mobile: the search panel resizes with the keyboard and closing it removes its viewport listener", async t => {
    const app = await setup(t, {frontend: "mobile"});
    app.plugin.openSearch();
    const dialog = app.plugin.dialog;
    app.viewport.height = 350;
    app.viewport.dispatchEvent(new app.window.Event("resize"));
    assert.equal(dialog.element.style.getPropertyValue("--ess-viewport-height"), "350px");
    dialog.destroy();
    app.viewport.height = 700;
    app.viewport.dispatchEvent(new app.window.Event("resize"));
    assert.equal(dialog.element.style.getPropertyValue("--ess-viewport-height"), "350px");
});

test("mobile: opening a result waits for the editor callback", async t => {
    let loaded;
    const app = await setup(t, {frontend: "mobile", openMobile: (...args) => {loaded = args[5];}});
    const result = app.plugin.openResult("note", null, "", false, "笔记");
    assert.equal(app.plugin.recent.length, 0);
    await new Promise(resolve => setImmediate(resolve));
    loaded();
    await result;
    assert.equal(app.plugin.recent[0].id, "note");
});

test("mobile: a resolved SDK Promise completes navigation even without its callback", async t => {
    const app = await setup(t, {frontend: "mobile", openMobile: () => Promise.resolve(true)});
    await app.plugin.openResult("note", null, "", false, "笔记");
    assert.equal(app.plugin.recent[0].id, "note");
});

test("mobile: an SDK failure does not record a note as successfully opened", async t => {
    const app = await setup(t, {frontend: "mobile", openMobile: () => Promise.resolve(false)});
    await assert.rejects(app.plugin.openResult("note", null, "", false, "笔记"), /无法打开/);
    assert.equal(app.plugin.recent.length, 0);
});

test("mobile: opening errors reach the search UI without closing the query", async t => {
    const app = await setup(t, {frontend: "browser-mobile", openMobile: () => {throw new Error("不可访问");}});
    app.plugin.openSearch();
    const view = app.plugin.searchView;
    view.input.value = "关键词";
    await view.open("note", null);
    assert.equal(view.input.value, "关键词");
    assert.match(view.status.textContent, /不可访问/);
    assert.ok(app.plugin.dialog);
});

test("mobile: the separate current-note entry never imports the global query", async t => {
    const app = await setup(t, {frontend: "mobile"});
    app.plugin.openSearch();
    app.plugin.searchView.input.value = "关键词";
    assert.equal(app.plugin.searchView.root.querySelector(".ess-find-note"), null);
    await app.topBars.find(item => item.id === "find").callback();
    assert.equal(app.plugin.dialog, null);
    assert.equal(app.plugin.findController.input.value, "");
    assert.equal(app.plugin.searchState.query, "关键词");
    assert.equal(app.plugin.findController.root.classList.contains("ess-mobile-find"), true);
});

test("mobile: repeated hits inside one block navigate to separate text ranges after the editor loads", async t => {
    const app = await setup(t, {frontend: "mobile"});
    const host = app.document.getElementById("first");
    host.removeAttribute("contenteditable");
    host.innerHTML = '<div data-node-id="hit"><div contenteditable="true">词 词</div></div>';
    app.plugin.searchAll = async () => [{id: "hit", rootID: "first", content: "<mark>词</mark> 词"}];
    await app.plugin.openFind("词");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(app.plugin.findController.matches.length, 2);
    await app.plugin.findController.go(1);
    assert.equal(app.plugin.findController.highlightRange.startOffset, 2);
    assert.equal(app.plugin.findController.highlightRange.endOffset, 3);
});

test("closing find while a query is in flight cannot restore stale results", async t => {
    const app = await setup(t, {frontend: "browser-mobile"});
    let finish;
    app.plugin.searchAll = () => new Promise(resolve => {finish = resolve;});
    const pending = app.plugin.openFind("词");
    app.plugin.findController.close();
    finish([{id: "hit", rootID: "first", content: "词"}]);
    await pending;
    assert.equal(app.plugin.findController.matches.length, 0);
    assert.equal(app.plugin.findController.root, null);
});

test("mobile: editor switch events keep the find bar connected to the current note", async t => {
    const app = await setup(t, {frontend: "mobile"});
    await app.plugin.openFind();
    const bar = app.plugin.findController.root;
    app.setEditor("second");
    app.listeners.get("switch-protyle")();
    assert.equal(app.plugin.findController.root, bar);
    assert.equal(bar.parentElement, app.document.body);
    assert.equal(app.plugin.findController.editor.protyle.block.rootID, "second");
    bar.remove();
    app.listeners.get("loaded-protyle-static")();
    assert.equal(bar.isConnected, true);
});

test("mobile: opening global search removes find bars copied by a restored editor", async t => {
    const app = await setup(t, {frontend: "mobile"});
    await app.plugin.openFind();
    app.document.getElementById("first").append(app.plugin.findController.root.cloneNode(true));
    app.plugin.openSearch();
    assert.equal(app.document.querySelectorAll(".ess-findbar").length, 0);
});

test("cross-device data updates keep the active search interface open", async t => {
    const options = {frontend: "mobile", data: {query: "", recent: []}};
    const app = await setup(t, options);
    app.plugin.openSearch();
    const view = app.plugin.searchView;
    view.input.value = "正在输入";
    options.data = {query: "另一台设备的查询", recent: [{id: "note", title: "新记录"}]};
    await app.plugin.onDataChanged("overwrite");
    assert.equal(app.plugin.searchView, view);
    assert.equal(view.input.value, "正在输入");
    assert.equal(app.plugin.recent[0].id, "note");
});

test("subnote index receives settings and generated-block IDs from another device without a reload", {skip: !hasSubnote}, async t => {
    const options = {frontend: "mobile", pluginPath: subnoteEntry, data: {showGrandchildren: false, generated: {}}};
    const app = await setup(t, options);
    options.data = {showGrandchildren: true, generated: {first: ["generated-block"]}};
    await app.plugin.onDataChanged("sync");
    assert.equal(app.plugin.showGrandchildrenInput.checked, true);
    assert.equal(app.plugin.settings.generated.first[0], "generated-block");
});

for (const frontend of frontends) {
    test(`subnote index ${frontend}: a touch action targets the supplied note`, {skip: !hasSubnote}, async t => {
        const app = await setup(t, {frontend, pluginPath: subnoteEntry});
        assert.equal(app.plugin.getCurrentDocumentId(), "first");
        const breadcrumb = app.breadcrumbs[0];
        let target;
        app.plugin.generateForCurrentDocument = context => {target = app.plugin.getCurrentDocumentId(context);};
        breadcrumb.callback({}, {block: {rootID: "second"}});
        assert.equal(target, "second");
        assert.ok(app.topBars.some(item => item.id === "generate-subnote-index"));
    });
}

test("available packages allow all supported frontends and mobile/Docker backends", () => {
    const manifests = [path.resolve(__dirname, "../plugin.json")];
    if (hasSubnote) manifests.push(path.resolve(__dirname, "../../siyuan-subnote-index/plugin.json"));
    for (const filename of manifests) {
        const manifest = JSON.parse(fs.readFileSync(filename));
        for (const frontend of frontends) assert.ok(manifest.frontends.includes(frontend));
        for (const backend of ["android", "ios", "harmony", "docker"]) assert.ok(manifest.backends.includes(backend));
    }
});
