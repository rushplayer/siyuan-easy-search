"use strict";
const {collectUnits, occurrences, toRange, stepIndex} = require("./core");
const {el} = require("./search");

class FindController {
    constructor(plugin) {
        this.plugin = plugin;
        this.editor = null;
        this.matches = [];
        this.current = -1;
        this.opened = false;
        this.version = 0;
        this.navigation = 0;
        this.queueHighlights = () => {
            clearTimeout(this.highlightTimer);
            if (this.opened) this.highlightTimer = setTimeout(() => this.renderHighlights(), 40);
        };
    }

    async open(seed = "", editor = this.plugin.activeEditor()) {
        const selectedText = this.opened ? "" : window.getSelection?.().toString().trim();
        this.editor = editor;
        if (!this.editor) return;
        this.opened = true;
        this.mount();
        this.input.value = seed || selectedText || this.query || this.input.value || "";
        this.input.focus({preventScroll: true});
        this.input.select();
        await this.refresh();
    }

    mount() {
        // Mobile tabs snapshot the editor DOM. Keep controls outside it so a restored tab cannot clone the bar.
        const host = this.plugin.mobile ? document.body : this.editor?.protyle?.element || document.body;
        this.observeHighlights();
        this.removeOrphanBars();
        if (this.root) {
            if (this.root.parentElement !== host) host.append(this.root);
            return;
        }
        this.root = el("div", "ess-findbar");
        this.root.classList.toggle("ess-mobile-find", !!this.plugin.mobile);
        this.root.setAttribute("role", "search");
        this.root.setAttribute("aria-label", "当前笔记查找浮窗");
        this.input = el("input", "b3-text-field ess-find-input");
        this.input.type = "search";
        this.input.placeholder = "在这篇笔记里找…";
        this.input.setAttribute("aria-label", "查找当前笔记");
        this.counter = el("span", "ess-find-count", "0 / 0");
        this.previous = el("button", "b3-button b3-button--outline ess-find-button", "↑");
        this.next = el("button", "b3-button b3-button--outline ess-find-button", "↓");
        this.closeButton = el("button", "b3-button b3-button--outline ess-find-button", "×");
        this.previous.title = "上一个匹配 · Shift+Enter";
        this.next.title = "下一个匹配 · Enter";
        this.closeButton.title = "关闭 · Esc";
        this.previous.setAttribute("aria-label", "上一个匹配");
        this.next.setAttribute("aria-label", "下一个匹配");
        this.closeButton.setAttribute("aria-label", "关闭篇内查找");
        this.root.append(this.input, this.counter, this.previous, this.next, this.closeButton);
        host.append(this.root);
        this.timer = null;
        this.composing = false;
        this.input.addEventListener("compositionstart", () => {this.composing = true;});
        this.input.addEventListener("compositionend", () => {this.composing = false; this.schedule();});
        this.input.addEventListener("input", event => {if (!event.isComposing && !this.composing) this.schedule();});
        this.input.addEventListener("keydown", event => {
            if (event.isComposing || this.composing || event.keyCode === 229) return;
            if (event.key === "Enter") {event.preventDefault(); event.stopPropagation(); this.go(event.shiftKey ? -1 : 1);}
            if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); this.close();}
        });
        this.previous.onclick = () => this.go(-1);
        this.next.onclick = () => this.go(1);
        this.closeButton.onclick = () => this.close();
    }

    schedule() {
        this.navigation++;
        this.version++;
        this.clearHighlight();
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refresh(), 100);
    }

    removeOrphanBars() {
        document.querySelectorAll(".ess-findbar").forEach(bar => {if (bar !== this.root) bar.remove();});
    }

    async refresh() {
        if (!this.opened || !this.input) return;
        const query = this.input.value;
        this.query = query;
        const version = ++this.version;
        this.navigation++;
        this.clearHighlight();
        this.matches = [];
        this.current = -1;
        if (!query) {this.updateCount(); return;}
        // The API returns indexed blocks, including blocks outside the viewport.
        // We filter by the current root, then use the live DOM when the block is loaded.
        try {
            const rootID = this.editor?.protyle?.block?.rootID;
            const response = await this.plugin.searchAll(query, this.editor?.protyle);
            if (!this.opened || version !== this.version) return;
            const blocks = response.filter(block => !rootID || block.rootID === rootID)
                .map((block, index) => ({block, index}))
                .sort((left, right) => {
                    const a = left.block.sort, b = right.block.sort;
                    if (a == null || b == null) return left.index - right.index;
                    return String(a).localeCompare(String(b), undefined, {numeric: true});
                })
                .map(item => item.block);
            for (const block of blocks) {
                const plain = document.createElement("div");
                plain.innerHTML = String(block.content || "");
                occurrences(plain.textContent || "", query).forEach((match, occurrence) => this.matches.push({block, occurrence, ...match}));
            }
        } catch (error) {
            if (!this.opened || version !== this.version) return;
            this.matches = this.domMatches(query);
            this.counter.title = "索引未响应，当前仅显示已加载内容";
        }
        this.updateCount();
        this.renderHighlights();
        if (this.matches.length) await this.go(1, true);
    }

    domMatches(query) {
        const root = this.editor?.protyle?.element || document.body;
        const output = [];
        for (const unit of collectUnits(root)) occurrences(unit.text, query).forEach((match, occurrence) => output.push({unit, occurrence, ...match, block: {id: unit.id, sort: 0}}));
        return output;
    }

    updateCount() {
        this.counter.textContent = this.matches.length ? `${this.current + 1} / ${this.matches.length}` : "0 / 0";
        this.previous.disabled = !this.matches.length;
        this.next.disabled = !this.matches.length;
    }

    async go(direction, initial = false) {
        if (!this.matches.length) {this.updateCount(); return;}
        const navigation = ++this.navigation, version = this.version;
        const current = () => this.opened && navigation === this.navigation && version === this.version;
        const next = stepIndex(this.current, direction, this.matches.length);
        this.current = next.index;
        this.updateCount();
        const match = this.matches[this.current];
        const rootID = this.editor?.protyle?.block?.rootID || match.block.rootID;
        delete this.counter.dataset.wrapped;
        this.counter.title = "";
        this.highlightRange = null;
        window.CSS?.highlights?.delete("ess-find-current");
        try {
            let range = this.rangeForMatch(match);
            if (!this.isRendered(range)) {
                await this.plugin.navigateTo(rootID, match.block.id);
                if (!current()) return;
                // openTab may resolve before an unloaded block has finished rendering.
                for (let attempt = 0; attempt < 100 && current(); attempt++) {
                    const editor = this.plugin.activeEditor();
                    if (editor?.protyle?.block?.rootID === rootID) {
                        this.editor = editor; this.mount();
                        range = this.rangeForMatch(match);
                        if (this.isRendered(range)) break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
            if (!current()) return;
            if (!this.isRendered(range)) throw new Error("匹配内容尚未加载，请重试。");
            this.selectRange(range);
            if (next.wrapped && !initial) this.counter.dataset.wrapped = "true";
        } catch (error) {if (current()) this.counter.title = error.message;}
    }

    rangeForMatch(match) {
        if (match.unit?.element.isConnected) return toRange(match.unit, match.start, match.end);
        const root = this.editor?.protyle?.wysiwyg?.element || this.editor?.protyle?.element;
        const block = root?.querySelector(`[data-node-id="${CSS.escape(match.block.id)}"]`);
        const title = match.block.id === this.editor?.protyle?.block?.rootID ? this.editor.protyle.title?.editElement : null;
        const units = title ? collectUnits(title) : block ? collectUnits(block) : [];
        let ordinal = match.occurrence || 0;
        for (const unit of units) {
            const hits = occurrences(unit.text, this.input.value);
            if (ordinal < hits.length) return toRange(unit, hits[ordinal].start, hits[ordinal].end);
            ordinal -= hits.length;
        }
        return null;
    }

    isRendered(range) {
        return range && (!range.getClientRects || [...range.getClientRects()].some(rect => rect.width && rect.height));
    }

    selectRange(range) {
        this.highlightRange = range;
        this.renderHighlights(range);
        const content = this.editor?.protyle?.contentElement;
        const hit = [...(range.getClientRects?.() || [])].find(rect => rect.width && rect.height);
        if (content && hit) {
            const viewport = content.getBoundingClientRect();
            const top = Math.max(viewport.top, this.root.getBoundingClientRect().bottom + 12);
            const bottom = Math.min(viewport.bottom, (window.visualViewport?.offsetTop || 0) + (window.visualViewport?.height || window.innerHeight));
            content.scrollBy({top: hit.top + hit.height / 2 - (top + bottom) / 2, behavior: "instant"});
        } else range.startContainer.parentElement?.scrollIntoView?.({block: "center", behavior: "instant"});
        if (this.overlay) this.renderOverlay();
        if (!this.plugin.mobile) {
            this.input.focus({preventScroll: true});
        }
    }

    clearHighlight() {
        window.CSS?.highlights?.delete("ess-find-all");
        window.CSS?.highlights?.delete("ess-find-current");
        this.highlightRange = null;
        this.loadedRanges = [];
        this.overlay?.replaceChildren();
    }

    observeHighlights() {
        const host = this.editor?.protyle?.element;
        if (host === this.highlightHost) return;
        this.highlightObserver?.disconnect();
        this.highlightHost = host;
        if (!host) return;
        this.highlightObserver = new window.MutationObserver(records => {
            if (records.some(record => !(record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest(".ess-findbar"))) this.queueHighlights();
        });
        this.highlightObserver.observe(host, {subtree: true, childList: true, characterData: true});
    }

    renderHighlights(current = this.current >= 0 ? this.rangeForMatch(this.matches[this.current]) : null) {
        if (!this.opened || !this.query || this.query !== this.input.value) return;
        this.loadedRanges = this.domMatches(this.query).map(match => toRange(match.unit, match.start, match.end)).filter(Boolean);
        this.highlightRange = current;
        if (window.CSS?.highlights && window.Highlight) {
            window.CSS.highlights.set("ess-find-all", new window.Highlight(...this.loadedRanges));
            if (current) {
                const highlight = new window.Highlight(current);
                highlight.priority = 1;
                window.CSS.highlights.set("ess-find-current", highlight);
            } else window.CSS.highlights.delete("ess-find-current");
        } else {
            // Older WebViews cannot paint CSS highlights. Draw a noneditable overlay,
            // without inserting marks into the note or changing the user's selection.
            if (!this.overlay) {
                this.overlay = el("div", "ess-find-marks");
                this.overlay.setAttribute("aria-hidden", "true");
                document.body.append(this.overlay);
                document.addEventListener("scroll", this.queueHighlights, true);
                window.addEventListener("resize", this.queueHighlights);
                window.visualViewport?.addEventListener("resize", this.queueHighlights);
            }
            this.renderOverlay();
        }
    }

    renderOverlay() {
        const viewport = this.editor?.protyle?.contentElement?.getBoundingClientRect() || {left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight};
        const top = Math.max(viewport.top, this.root.getBoundingClientRect().bottom);
        const bottom = Math.min(viewport.bottom, (window.visualViewport?.offsetTop || 0) + (window.visualViewport?.height || window.innerHeight));
        const fragment = document.createDocumentFragment();
        const draw = (range, current) => {
            for (const rect of range.getClientRects?.() || []) {
                const x = Math.max(viewport.left, rect.left), y = Math.max(top, rect.top);
                const width = Math.min(viewport.right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
                if (width <= 0 || height <= 0) continue;
                const mark = el("span", current ? "ess-find-mark ess-find-mark-current" : "ess-find-mark");
                Object.assign(mark.style, {left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px`});
                fragment.append(mark);
            }
        };
        for (const range of this.loadedRanges) draw(range, false);
        if (this.highlightRange) draw(this.highlightRange, true);
        this.overlay.replaceChildren(fragment);
    }

    close() {
        if (this.input) this.query = this.input.value;
        this.input?.blur();
        this.opened = false;
        this.version++;
        this.navigation++;
        this.clearHighlight();
        clearTimeout(this.timer);
        clearTimeout(this.highlightTimer);
        this.highlightObserver?.disconnect();
        this.highlightHost = null;
        this.overlay?.remove(); this.overlay = null;
        document.removeEventListener("scroll", this.queueHighlights, true);
        window.removeEventListener("resize", this.queueHighlights);
        window.visualViewport?.removeEventListener("resize", this.queueHighlights);
        this.root?.remove();
        this.root = null;
        this.removeOrphanBars();
        this.matches = [];
        this.current = -1;
    }

    destroy() {this.close();}
}

module.exports = {FindController};
