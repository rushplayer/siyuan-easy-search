"use strict";
const siyuan = require("siyuan");

const dialogSelector = '[data-key="dialog-globalsearch"], [data-key="dialog-search"], [data-key="dialog-replace"]';
const nativeSelector = `${dialogSelector}, #searchInput, #toolbarSearch`;
const menuEvents = ["open-menu-content", "open-menu-breadcrumbmore", "click-editortitleicon", "click-blockicon", "open-menu-doctree"];

// Native commands also originate in menus, restored layouts and the Electron menu.
// Redirect their UI through its normal lifecycle; never modify SiYuan's bundled files.
class NativeSearchTakeover {
    constructor(plugin) {
        this.plugin = plugin;
        this.click = this.onClick.bind(this);
        this.commandKey = event => {
            if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
            const panel = event.target?.closest?.('[data-key="dialog-commandpanel"], .mobile-command-panel');
            const entry = this.commandEntry(panel?.querySelector("#commands .b3-list-item--focus"));
            if (entry) this.redirect(event, entry);
        };
        this.menu = event => {
            this.menuEditor = event.detail?.protyle ? {protyle: event.detail.protyle} : null;
            this.treeMenu = event.type === "open-menu-doctree";
        };
    }

    start() {
        this.enabled = true;
        document.body.classList.add("ess-takeover");
        window.addEventListener("click", this.click, true);
        window.addEventListener("keydown", this.commandKey, true);
        for (const name of menuEvents) this.plugin.eventBus.on(name, this.menu);
        this.observer = new window.MutationObserver(records => {
            if (records.some(record => record.type === "attributes" ? record.target.id === "model" :
                [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches(nativeSelector) || node.querySelector(nativeSelector))))) this.queueScan();
        });
        this.observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ["style"]});
        this.scan(false);
    }

    onClick(event) {
        const command = this.commandEntry(event.target?.closest?.("[data-command-id]"));
        if (command) {this.redirect(event, command); return;}
        const target = event.target?.closest?.('#barSearch, #mobileBottomBarSearch, .mobile-bottom-bar__item[data-action="search"], .b3-menu__item[data-id="search"], .b3-menu__item[data-id="globalSearch"], .b3-menu__item[data-id="stickSearch"]');
        if (!target || target.hasAttribute("data-topbar-entry") && target.id !== "barSearch") return;
        this.redirect(event, {current: target.dataset.id === "search" && !this.treeMenu});
    }

    commandEntry(element) {
        const id = element?.dataset.commandId || "";
        const name = id.split(".").pop();
        if (!id.startsWith("core.") || !["globalSearch", "stickSearch", "search", "replace"].includes(name)) return null;
        return {current: ["search", "replace"].includes(name) && !this.treeMenu};
    }

    redirect(event, {current}) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const editor = this.menuEditor || this.plugin.activeEditor();
        this.menuEditor = null;
        this.treeMenu = false;
        window.siyuan?.menus?.menu?.remove();
        window.siyuan?.dialogs?.find(item => item.element.getAttribute("data-key") === "dialog-commandpanel")?.destroy();
        if (current) void this.plugin.openFind("", editor);
        else this.plugin.openSearch();
    }

    queueScan() {
        if (this.pending) return;
        this.pending = true;
        Promise.resolve().then(() => {
            this.pending = false;
            if (this.enabled) this.scan(this.ready);
        });
    }

    closeTab(model) {
        const tab = model?.parent;
        if (typeof tab?.parent?.removeTab !== "function") return false;
        tab.parent.removeTab(tab.id);
        return true;
    }

    scan(open = true) {
        let route = null;
        for (const element of document.querySelectorAll(dialogSelector)) {
            if (element.dataset.dialogClosing === "true") continue;
            const key = element.getAttribute("data-key");
            const dialog = window.siyuan?.dialogs?.find(item => item.element === element);
            if (!dialog) continue;
            route = {current: key !== "dialog-globalsearch" && !this.treeMenu, query: element.querySelector("#searchInput")?.value || ""};
            dialog.destroy();
        }
        if (!this.plugin.mobile) {
            for (const model of siyuan.getAllModels?.().search || []) {
                const query = model.parent?.panelElement?.querySelector("#searchInput")?.value || "";
                if (this.closeTab(model)) route = {current: false, query};
            }
        } else {
            const input = document.querySelector("#model #toolbarSearch");
            const model = input?.closest("#model");
            if (model?.style.transform === "translateX(0px)") {
                route = {current: false, query: input.value};
                // Use the host close control to release timers, masks and focus.
                model.querySelector("#modelClose")?.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
            }
        }
        if (!open || !route) return;
        const editor = this.menuEditor || this.plugin.activeEditor();
        this.menuEditor = null; this.treeMenu = false;
        if (route.current) void this.plugin.openFind(route.query, editor);
        else this.plugin.openSearch(route.query);
    }

    layoutReady() {this.scan(false); this.ready = true;}

    stop() {
        this.enabled = false;
        this.ready = false;
        this.observer?.disconnect();
        window.removeEventListener("click", this.click, true);
        window.removeEventListener("keydown", this.commandKey, true);
        for (const name of menuEvents) this.plugin.eventBus.off(name, this.menu);
        document.body.classList.remove("ess-takeover");
        this.menuEditor = null;
        this.treeMenu = false;
    }
}

module.exports = {NativeSearchTakeover};
