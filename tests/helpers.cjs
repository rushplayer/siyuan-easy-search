const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {JSDOM} = require("jsdom");

async function setup(t, options = {}) {
    const frontend = options.frontend || "desktop";
    const mobile = ["mobile", "browser-mobile"].includes(frontend);
    const dom = new JSDOM('<!doctype html><body><div id="first" class="protyle" contenteditable="true"></div><div id="second" class="protyle" contenteditable="true"></div></body>');
    const {window} = dom, {document} = window;
    const editor = element => ({protyle: {element, block: {rootID: element.id}}});
    let activeEditor = editor(document.getElementById("first"));
    let nativeCalls = 0;
    document.addEventListener("keydown", () => nativeCalls++, true);
    window.addEventListener("keydown", () => nativeCalls++);
    const listeners = new Map(), tabs = [], topBars = [], breadcrumbs = [], mobileOpens = [], messages = [], savedData = [];
    const viewport = new window.EventTarget();
    viewport.height = 700;
    Object.defineProperty(window, "visualViewport", {value: viewport});
    const siyuan = {
        Plugin: class {
            name = "siyuan-easy-search";
            app = {};
            eventBus = {
                on: (name, callback) => listeners.set(name, callback),
                off: (name, callback) => {if (listeners.get(name) === callback) listeners.delete(name);},
            };
            async loadData() {return options.data;}
            async saveData(name, data) {savedData.push({name, data: structuredClone(data)});}
            addTopBar(value) {topBars.push(value);}
            addBreadcrumbButton(value) {breadcrumbs.push(value);}
            addCommand() {}
            addTab() {assertDesktop();}
        },
        Dialog: class {
            constructor(settings) {
                this.settings = settings;
                this.element = document.createElement("div");
                this.element.innerHTML = `<div class="b3-dialog__container"><div class="b3-dialog__body">${settings.content}</div></div>`;
                document.body.append(this.element);
            }
            destroy() {
                if (this.destroyed) return;
                this.destroyed = true;
                if (options.dialogCloseDelay) {
                    this.element.dataset.dialogClosing = "true";
                    setTimeout(() => {this.settings.destroyCallback?.(); this.element.remove();}, options.dialogCloseDelay);
                    return;
                }
                this.settings.destroyCallback?.();
                this.element.remove();
            }
        },
        Setting: class {addItem() {} open() {}},
        getFrontend: () => frontend,
        getBackend: () => options.backend || "darwin",
        getActiveEditor: () => activeEditor,
        getAllEditor: () => options.getAllEditor?.(document) || [],
        openTab: value => {assertDesktop(); tabs.push(value); return options.openTab?.(value);},
        getAllTabs: () => options.getAllTabs?.() || [],
        getActiveTab: () => options.getActiveTab?.(),
        openMobileFileById: (...args) => {
            mobileOpens.push(args);
            if (options.openMobile) return options.openMobile(...args);
            args[5]?.(activeEditor?.protyle);
        },
        showMessage: (...args) => messages.push(args),
    };
    function assertDesktop() {if (mobile) throw new Error("Desktop-only SDK called on mobile");}
    window.siyuan = {dialogs: [], menus: {menu: {remove() {}}}};
    const models = {search: []};
    siyuan.getAllModels = () => models;
    const context = vm.createContext({
        window, document, console, setTimeout, clearTimeout,
        DOMParser: window.DOMParser, MouseEvent: window.MouseEvent,
        CSS: {escape: value => value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)},
        AbortController: window.AbortController,
        fetch: async (url, init) => ({ok: true, json: async () => ({code: 0, data: await options.api?.(url, JSON.parse(init.body)) || {}})}),
    });
    const cache = new Map();
    function load(filename) {
        if (cache.has(filename)) return cache.get(filename).exports;
        const module = {exports: {}};
        cache.set(filename, module);
        const source = fs.readFileSync(filename, "utf8");
        if (filename.endsWith(".css")) {module.exports = source; return source;}
        const requireModule = name => {
            if (name === "siyuan") return siyuan;
            let target = path.resolve(path.dirname(filename), name);
            if (!path.extname(target)) target += ".js";
            return load(target);
        };
        vm.runInContext(`(function(require, module, exports) {${source}\n})`, context, {filename})(requireModule, module, module.exports);
        return module.exports;
    }
    const Plugin = load(options.pluginPath || path.resolve(__dirname, "../src/index.js"));
    const plugin = new Plugin();
    await plugin.onload();
    plugin.onLayoutReady?.();
    t.after(async () => {await plugin.onunload(); window.close();});
    return {
        plugin, tabs, document, window, listeners, topBars, breadcrumbs, mobileOpens, messages, savedData, viewport, models,
        nativeCalls: () => nativeCalls,
        setEditor: id => {activeEditor = id ? editor(document.getElementById(id)) : null;},
        press: value => {
            const event = new window.KeyboardEvent("keydown", {key: "f", code: "KeyF", bubbles: true, cancelable: true, ...value});
            (document.activeElement || document.body).dispatchEvent(event);
            return event;
        },
    };
}

module.exports = {setup};
