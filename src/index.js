"use strict";
const siyuan = require("siyuan");
const {SearchView} = require("./search");
const {FindController} = require("./find");
const {SearchResultHighlighter} = require("./result");
const {NativeSearchTakeover} = require("./takeover");
const styleText = require("./style.css");

class EasySearchPlugin extends siyuan.Plugin {
    constructor(...args) {
        super(...args);
        this.searchState = {query: "", pageSize: 50, scroll: 0};
        this.recent = [];
        this.tabOrder = new Map();
        this.tabSequence = 0;
        this.findController = new FindController(this);
        this.searchResultHighlighter = new SearchResultHighlighter(this);
        this.dialog = null;
        this.takeover = new NativeSearchTakeover(this);
        this.handleSearchShortcut = this.onSearchShortcut.bind(this);
        this.handleEditorSwitch = () => {
            this.rememberTabs();
            this.findController.removeOrphanBars();
            if (!this.findController.opened) return;
            const editor = this.activeEditor();
            if (!editor) return;
            if (editor.protyle.block?.rootID !== this.findController.editor?.protyle?.block?.rootID) void this.findController.open("", editor);
            else {this.findController.editor = editor; this.findController.mount();}
        };
    }

    async onload() {
        const plugin = this;
        this.mobile = ["mobile", "browser-mobile"].includes(siyuan.getFrontend?.());
        this.styleElement = document.getElementById("siyuan-easy-search-style") || document.createElement("style");
        this.styleElement.id = "siyuan-easy-search-style";
        this.styleElement.textContent = styleText;
        if (!this.styleElement.isConnected) document.head.append(this.styleElement);
        this.searchState = {...this.searchState, ...(await this.loadData("data.json") || {})};
        this.recent = this.searchState.recent || [];
        this.addTopBar({id: "search", icon: "iconSearch", title: "顺手搜索", position: "right", callback: () => this.openSearch()});
        if (this.mobile) this.addTopBar({id: "find", icon: "iconSearch", title: "当前笔记查找", position: "right", callback: () => this.openFind()});
        this.addBreadcrumbButton?.({id: "find", icon: "iconSearch", title: "当前笔记查找", callback: (_event, protyle) => this.openFind("", {protyle})});
        this.addCommand({langKey: "quickSearch", langText: "顺手搜索：找笔记和内容", hotkey: "⌘P", callback: () => this.openSearch()});
        this.addCommand({langKey: "globalSearch", langText: "顺手搜索：全局搜索", hotkey: "⇧⌘F", callback: () => this.openSearch()});
        this.addCommand({langKey: "findInDocument", langText: "顺手搜索：篇内查找", hotkey: "⌘F", callback: () => this.openFind()});
        // Compatibility only: close saved tabs from older versions without recreating a split.
        if (!this.mobile) this.addTab({type: "easy-search", init() {
            Promise.resolve().then(() => {if (plugin.takeover.enabled) plugin.takeover.closeTab(this);});
        }, destroy() {}, resize() {}});
        // Capture before SiYuan's editor and window shortcut handlers.
        window.addEventListener("keydown", this.handleSearchShortcut, true);
        this.eventBus.on("switch-protyle", this.handleEditorSwitch);
        this.eventBus.on("loaded-protyle-static", this.handleEditorSwitch);
        this.takeover.start();
    }

    onLayoutReady() {this.rememberTabs(); this.takeover.layoutReady();}

    async onDataChanged() {
        const saved = await this.loadData("data.json");
        if (!saved || typeof saved !== "object") return;
        this.recent = Array.isArray(saved.recent) ? saved.recent : [];
        if (!this.searchView) this.searchState = {...this.searchState, ...saved};
        this.searchState.recent = this.recent;
    }

    onSearchShortcut(event) {
        if (event.key === "Escape" && this.dialog && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault(); event.stopImmediatePropagation(); this.closeSearch(); return;
        }
        if (event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return;
        const key = event.key?.toLowerCase();
        const quick = !event.shiftKey && (key === "p" || event.code === "KeyP");
        const find = key === "f" || event.code === "KeyF";
        const replace = !event.shiftKey && (key === "r" || event.code === "KeyR");
        if (!quick && !find && !replace) return;
        // PDF content has its own viewer; this takeover is for notes.
        if (!quick && !event.shiftKey && event.target?.closest?.(".pdf__outer")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (quick || event.shiftKey) this.openSearch();
        else void this.openFind("", this.activeEditor(event.target));
    }

    openSearch(seed) {
        this.findController.close();
        if (this.dialog?.element.dataset.dialogClosing === "true") this.closeSearch();
        if (this.dialog) {
            if (seed) {this.searchView.input.value = seed; this.searchView.schedule();}
            this.searchView?.focus(); return;
        }
        this.searchResultHighlighter.clear();
        if (seed) this.searchState.query = seed;
        let view;
        const viewport = window.visualViewport;
        const resize = () => {
            dialog.element.style.setProperty("--ess-viewport-height", `${viewport?.height || window.innerHeight}px`);
            dialog.element.style.setProperty("--ess-viewport-top", `${viewport?.offsetTop || 0}px`);
        };
        const dialog = new siyuan.Dialog({title: "全局搜索", disableAnimation: true, content: "<div class=\"ess-dialog-host\"></div>", width: "min(680px, calc(100vw - 16px))", height: "min(70vh, 720px)", destroyCallback: () => {
            viewport?.removeEventListener("resize", resize);
            viewport?.removeEventListener("scroll", resize);
            view?.destroy();
            if (this.dialog === dialog) {this.dialog = null; this.searchView = null;}
        }});
        dialog.element.classList.add("ess-search-dialog");
        dialog.element.classList.toggle("ess-mobile-dialog", this.mobile);
        resize();
        viewport?.addEventListener("resize", resize);
        viewport?.addEventListener("scroll", resize);
        this.dialog = dialog;
        view = new SearchView(this, dialog.element.querySelector(".ess-dialog-host"), {close: () => this.closeSearch(dialog)});
        this.searchView = view;
        view.focus();
    }

    openFind(seed = "", editor = this.activeEditor()) {
        if (!editor) {siyuan.showMessage?.("请先打开一篇笔记。", 3000, "info"); return;}
        this.closeSearch();
        return this.findController.open(seed, editor);
    }

    closeSearch(dialog = this.dialog) {
        if (!dialog) return;
        this.searchResultHighlighter.clear();
        if (this.dialog === dialog) {
            this.searchView?.destroy();
            this.dialog = null; this.searchView = null;
        }
        // SiYuan defers destroyCallback until its closing animation finishes.
        // Release our view immediately so rapid Escape/reopen cannot focus a closing dialog.
        dialog.element.style.display = "none";
        dialog.element.classList.remove("ess-search-dialog", "ess-mobile-dialog");
        dialog.destroy();
    }

    openPinned() {
        return this.openSearch();
    }

    activeEditor(target) {
        const host = target?.closest?.(".protyle");
        const focused = host && siyuan.getAllEditor?.().find(editor => editor.protyle?.element === host);
        return focused || siyuan.getActiveEditor?.(false) || null;
    }

    async post(path, body, signal) {
        const response = await fetch(path, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal});
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.code !== 0) throw new Error(payload.msg || `${path}: code ${payload.code}`);
        return payload.data || {};
    }

    async searchAll(query, protyle) {
        const blocks = [];
        const paths = protyle?.notebookId && protyle?.path ? [protyle.notebookId + protyle.path] : [];
        let page = 1, pageCount = 1;
        const types = ["document", "heading", "paragraph", "list", "listItem", "blockquote", "superBlock", "codeBlock", "table", "mathBlock", "htmlBlock", "embedBlock", "databaseBlock", "audioBlock", "videoBlock", "iframeBlock", "widgetBlock", "callout", "tabs", "tabItem"];
        do {
            const result = await this.post("/api/search/fullTextSearchBlock", {query, paths, method: 0, page, pageSize: 100, groupBy: 0, orderBy: 5, searchHPath: false, types: Object.fromEntries(types.map(type => [type, true]))});
            blocks.push(...(result.blocks || []));
            pageCount = result.pageCount || page; page++;
        } while (page <= pageCount && page < 50);
        return blocks;
    }

    rememberTabs() {
        const tabs = this.mobile ? [] : siyuan.getAllTabs?.() || [];
        const live = new Set(tabs.map(tab => tab.id));
        for (const id of this.tabOrder.keys()) if (!live.has(id)) this.tabOrder.delete(id);
        for (const tab of tabs) if (!this.tabOrder.has(tab.id)) this.tabOrder.set(tab.id, ++this.tabSequence);
        return tabs;
    }

    async makeRoomForResult(rootID) {
        const tabs = this.rememberTabs();
        // Loaded and restored document tabs are both reusable, across all panes.
        if (tabs.some(tab => {
            if (tab.model?.editor?.protyle?.block?.rootID === rootID) return true;
            try {
                const saved = JSON.parse(tab.headElement?.getAttribute("data-initdata") || "{}");
                return saved.instance === "Editor" && (saved.rootId === rootID || saved.blockId === rootID);
            } catch {return false;}
        })) return;
        const limit = Number(window.siyuan?.config?.fileTree?.maxOpenTabCount);
        if (!(limit > 0)) return;
        const active = document.querySelector(".layout__wnd--active");
        const pane = active ? tabs.find(tab => tab.parent?.element?.contains(active))?.parent : siyuan.getActiveTab?.(false)?.parent || tabs[0]?.parent;
        if (!pane) return;
        while (pane.children.filter(tab => tab.headElement).length >= limit) {
            const oldest = pane.children.filter(tab => tab.headElement && !tab.headElement.classList.contains("item--pin"))
                .sort((a, b) => this.tabOrder.get(a.id) - this.tabOrder.get(b.id))[0];
            if (!oldest) break;
            const removed = await pane.removeTab(oldest.id, false, false);
            if (removed === false || pane.children.includes(oldest)) throw new Error("最早的标签暂时无法关闭，请等待保存或上传完成后重试。");
        }
    }

    navigateTo(rootID, id = rootID) {
        // Serialize opens so rapid clicks cannot race the tab limit or finish out of order.
        const pending = (this.pendingNavigation || Promise.resolve()).catch(() => {}).then(() => this.openDocument(rootID, id));
        this.pendingNavigation = pending;
        return pending;
    }

    async openDocument(rootID, id) {
        const action = ["cb-get-unchangeid", "cb-get-focus"];
        if (this.mobile) {
            await new Promise((resolve, reject) => {
                let settled = false, poll;
                const finish = error => {
                    if (settled) return;
                    settled = true; clearTimeout(timer); clearTimeout(poll);
                    if (error) reject(error); else resolve();
                };
                const timer = setTimeout(() => finish(new Error("打开笔记超时，请重试。")), 12000);
                const checkEditor = () => {
                    if (settled) return;
                    const editor = this.activeEditor()?.protyle;
                    if (editor?.block?.rootID === rootID && editor.element?.isConnected && (id === rootID || editor.element.querySelector(`[data-node-id="${CSS.escape(id)}"]`))) finish();
                    else poll = setTimeout(checkEditor, 50);
                };
                try {
                    const opening = siyuan.openMobileFileById(this.app, id, action, "center", undefined, () => finish());
                    // SiYuan versions differ: newer builds return a Promise, older ones only invoke a callback.
                    if (opening?.then) Promise.resolve(opening).then(opened => finish(opened === false ? new Error("无法打开这篇笔记，请确认笔记本已打开并解锁。") : null), finish);
                    else if (!settled) poll = setTimeout(checkEditor, 0);
                } catch (error) {finish(error);}
            });
        } else {
            await this.makeRoomForResult(rootID);
            await siyuan.openTab({app: this.app, doc: {id, action}, keepCursor: false, removeCurrentTab: false});
            this.rememberTabs();
        }
    }

    async openResult(rootID, block, query, newTab, title) {
        await this.navigateTo(rootID, block?.id || rootID);
        if (rootID) {
            const existing = this.recent.find(item => item.id === rootID);
            const item = {id: rootID, title: title || existing?.title || block?.name || "未命名笔记"};
            this.recent = [item, ...this.recent.filter(entry => entry.id !== rootID)].slice(0, 12);
            this.searchState.recent = this.recent;
            await this.saveData("data.json", this.searchState);
        }
        if (!this.searchView?.root.isConnected) return {highlighted: false};
        this.dialog?.element.classList.add("ess-result-open");
        const highlighted = await this.searchResultHighlighter.show(query, rootID, block);
        return {highlighted};
    }

    onunload() {
        this.takeover.stop();
        window.removeEventListener("keydown", this.handleSearchShortcut, true);
        this.eventBus.off("switch-protyle", this.handleEditorSwitch);
        this.eventBus.off("loaded-protyle-static", this.handleEditorSwitch);
        this.closeSearch();
        this.searchResultHighlighter.clear();
        this.findController.destroy();
        this.styleElement?.remove();
        return this.saveData("data.json", {...this.searchState, recent: this.recent});
    }
}

module.exports = EasySearchPlugin;
