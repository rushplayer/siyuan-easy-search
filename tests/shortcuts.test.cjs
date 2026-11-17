const test = require("node:test");
const assert = require("node:assert/strict");
const {setup} = require("./helpers.cjs");

for (const modifier of ["ctrlKey", "metaKey"]) {
    test(`${modifier}+Shift+F opens plugin global search before native search`, async t => {
        const app = await setup(t);
        const event = app.press({[modifier]: true, shiftKey: true, key: "F"});
        assert.equal(event.defaultPrevented, true);
        assert.equal(app.nativeCalls(), 0);
        assert.equal(app.tabs.length, 0);
        assert.equal(app.plugin.dialog.settings.title, "全局搜索");
        assert.equal(app.plugin.findController.opened, false);
    });

    test(`${modifier}+F opens current-note find and suppresses native search`, async t => {
        const app = await setup(t);
        app.document.getElementById("first").focus();
        const event = app.press({[modifier]: true});
        assert.equal(event.defaultPrevented, true);
        assert.equal(app.nativeCalls(), 0);
        assert.equal(app.tabs.length, 0);
        assert.equal(app.plugin.dialog, null);
        assert.equal(app.plugin.findController.root.parentElement.id, "first");
        assert.equal(app.document.activeElement, app.plugin.findController.input);
    });
}

test("current-note find follows the active editor without duplicating the bar", async t => {
    const app = await setup(t);
    app.press({ctrlKey: true});
    const bar = app.plugin.findController.root;
    app.setEditor("second");
    app.press({ctrlKey: true});
    assert.equal(app.plugin.findController.root, bar);
    assert.equal(bar.parentElement.id, "second");
    assert.equal(app.document.querySelectorAll(".ess-findbar").length, 1);
});

test("other shortcuts and IME composition retain native event handling", async t => {
    const app = await setup(t);
    const cases = [
        {}, {shiftKey: true}, {ctrlKey: true, altKey: true},
        {ctrlKey: true, isComposing: true}, {ctrlKey: true, keyCode: 229},
        {ctrlKey: true, key: "g", code: "KeyG"},
    ];
    for (const options of cases) assert.equal(app.press(options).defaultPrevented, false);
    assert.equal(app.nativeCalls(), cases.length * 2);
    assert.equal(app.tabs.length, 0);
    assert.equal(app.plugin.findController.opened, false);
});

test("holding a search shortcut does not repeatedly open the plugin or leak to native search", async t => {
    const app = await setup(t);
    app.press({ctrlKey: true, shiftKey: true});
    assert.equal(app.press({ctrlKey: true, shiftKey: true, repeat: true}).defaultPrevented, true);
    assert.equal(app.press({ctrlKey: true, repeat: true}).defaultPrevented, true);
    assert.equal(app.tabs.length, 0);
    assert.ok(app.plugin.dialog);
    assert.equal(app.nativeCalls(), 0);
    assert.equal(app.plugin.findController.opened, false);
});

test("without a note Ctrl+F asks to open one and never opens global search", async t => {
    const app = await setup(t);
    app.setEditor(null);
    assert.equal(app.press({ctrlKey: true}).defaultPrevented, true);
    assert.equal(app.nativeCalls(), 0);
    assert.equal(app.plugin.dialog, null);
    assert.equal(app.plugin.findController.opened, false);
    assert.match(app.messages[0][0], /请先打开一篇笔记/);
    assert.equal(app.press({ctrlKey: true, shiftKey: true}).defaultPrevented, true);
    assert.equal(app.tabs.length, 0);
    assert.ok(app.plugin.dialog);
});

test("Ctrl+F binds its separate float to the focused note even if the active editor is unavailable", async t => {
    const app = await setup(t, {getAllEditor: document => [{protyle: {element: document.getElementById("second"), block: {rootID: "second"}}}]});
    app.setEditor(null);
    app.document.getElementById("second").focus();
    app.press({ctrlKey: true});
    assert.equal(app.plugin.dialog, null);
    assert.equal(app.plugin.findController.root.parentElement.id, "second");
});

test("global and current-note shortcuts keep independent queries and close their own UI", async t => {
    const app = await setup(t);
    app.press({ctrlKey: true});
    const find = app.plugin.findController;
    find.input.value = "篇内关键词";
    app.press({ctrlKey: true, shiftKey: true});
    assert.equal(find.opened, false);
    assert.equal(app.plugin.searchView.input.value, "");
    assert.equal(app.document.querySelector(".ess-find-note"), null);
    app.plugin.searchView.input.value = "全局关键词";
    app.press({ctrlKey: true});
    assert.equal(app.plugin.dialog, null);
    assert.equal(find.input.value, "篇内关键词");
    assert.equal(find.root.parentElement.id, "first");
    app.press({key: "Escape", code: "Escape"});
    assert.equal(find.opened, false);
    assert.equal(app.tabs.length, 0);
    app.press({ctrlKey: true, shiftKey: true});
    assert.equal(app.plugin.searchView.input.value, "全局关键词");
    app.press({key: "Escape", code: "Escape"});
    assert.equal(app.plugin.dialog, null);
});

test("unloading restores native shortcuts and re-enabling installs one handler", async t => {
    const app = await setup(t);
    app.press({ctrlKey: true});
    await app.plugin.onunload();
    assert.equal(app.document.querySelector(".ess-findbar"), null);
    assert.equal(app.listeners.size, 0);
    assert.equal(app.press({ctrlKey: true}).defaultPrevented, false);
    assert.equal(app.press({ctrlKey: true, shiftKey: true}).defaultPrevented, false);
    assert.equal(app.nativeCalls(), 4);
    await app.plugin.onload();
    app.press({ctrlKey: true, shiftKey: true});
    assert.equal(app.tabs.length, 0);
    assert.ok(app.plugin.dialog);
    assert.equal(app.nativeCalls(), 4);
});
