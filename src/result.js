"use strict";
const {collectUnits, searchOccurrences, toRange} = require("./core");

class SearchResultHighlighter {
    constructor(plugin) {
        this.plugin = plugin;
        this.version = 0;
        this.queue = () => {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.paint(false), 40);
        };
    }

    async show(query, rootID, block) {
        this.clear();
        if (!block) return false;
        const version = this.version;
        this.query = query;
        this.rootID = rootID;
        this.block = block;
        for (let attempt = 0; attempt < 100 && version === this.version; attempt++) {
            this.editor = this.plugin.activeEditor();
            if (this.editor?.protyle?.block?.rootID === rootID && this.paint(false, true)) {
                this.observe();
                this.scrollToMatch();
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
    }

    targetElement() {
        const root = this.editor?.protyle?.wysiwyg?.element || this.editor?.protyle?.element;
        return root?.querySelector(`[data-node-id="${CSS.escape(this.block.id)}"]`) || null;
    }

    markedIntervals(text) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = String(this.block.searchHTML || this.block.content || "");
        const ownerDocument = wrapper.ownerDocument;
        const walker = ownerDocument.createTreeWalker(wrapper, 4);
        const intervals = [];
        let offset = 0, node;
        while ((node = walker.nextNode())) {
            const end = offset + node.data.length;
            if (node.parentElement.closest("mark") && end > offset) intervals.push({start: offset, end});
            offset = end;
        }
        return intervals.length ? intervals : searchOccurrences(text, this.query);
    }

    makeRanges(element) {
        const units = collectUnits(element);
        const text = units.map(unit => unit.text).join("");
        const intervals = this.markedIntervals(text);
        const ranges = [];
        let base = 0;
        for (const unit of units) {
            const end = base + unit.text.length;
            for (const interval of intervals) {
                const start = Math.max(base, interval.start);
                const finish = Math.min(end, interval.end);
                if (finish > start) {
                    const range = toRange(unit, start - base, finish - base);
                    if (range) ranges.push(range);
                }
            }
            base = end;
        }
        if (!ranges.length) for (const unit of units) {
            for (const match of searchOccurrences(unit.text, this.query)) {
                const range = toRange(unit, match.start, match.end);
                if (range) ranges.push(range);
            }
        }
        return ranges;
    }

    paint(scroll = false, requireRendered = false) {
        if (!this.block || !this.query) return false;
        this.element = this.targetElement();
        if (!this.element) return false;
        this.ranges = this.makeRanges(this.element);
        if (!this.ranges.length) return false;
        if (requireRendered && !this.ranges.some(range => !range.getClientRects || [...range.getClientRects()].some(rect => rect.width && rect.height))) return false;
        this.current = this.ranges[0];
        if (window.CSS?.highlights && window.Highlight) {
            window.CSS.highlights.set("ess-search-result", new window.Highlight(...this.ranges));
            const current = new window.Highlight(this.current);
            current.priority = 2;
            window.CSS.highlights.set("ess-search-result-current", current);
        } else this.renderOverlay();
        if (scroll) this.scrollToMatch();
        return true;
    }

    observe() {
        const host = this.editor?.protyle?.element;
        if (!host || host === this.host) return;
        this.observer?.disconnect();
        this.host = host;
        this.observer = new window.MutationObserver(records => {
            if (records.some(record => !(record.target.nodeType === 1 ? record.target : record.target.parentElement)?.closest(".ess-search-dialog"))) this.queue();
        });
        this.observer.observe(host, {subtree: true, childList: true, characterData: true});
    }

    scrollToMatch() {
        const content = this.editor?.protyle?.contentElement;
        const hit = [...(this.current?.getClientRects?.() || [])].find(rect => rect.width && rect.height);
        if (!content || !hit) return;
        const viewport = content.getBoundingClientRect();
        const top = Math.max(viewport.top, window.visualViewport?.offsetTop || 0);
        const bottom = Math.min(viewport.bottom, (window.visualViewport?.offsetTop || 0) + (window.visualViewport?.height || window.innerHeight));
        const panel = this.plugin.dialog?.element.querySelector(".b3-dialog__container")?.getBoundingClientRect();
        let target = (top + bottom) / 2;
        if (panel && panel.bottom > top && panel.top < bottom) {
            const upperBottom = Math.min(bottom, panel.top);
            const lowerTop = Math.max(top, panel.bottom);
            const upperSpace = upperBottom - top, lowerSpace = bottom - lowerTop;
            target = lowerSpace >= upperSpace ? (lowerTop + bottom) / 2 : (top + upperBottom) / 2;
        }
        content.scrollBy({top: hit.top + hit.height / 2 - target, behavior: "instant"});
        if (this.overlay) this.renderOverlay();
    }

    renderOverlay() {
        if (!this.overlay) {
            this.overlay = document.createElement("div");
            this.overlay.className = "ess-result-marks";
            this.overlay.setAttribute("aria-hidden", "true");
            document.body.append(this.overlay);
            document.addEventListener("scroll", this.queue, true);
            window.addEventListener("resize", this.queue);
            window.visualViewport?.addEventListener("resize", this.queue);
        }
        const fragment = document.createDocumentFragment();
        for (const range of this.ranges) for (const rect of range.getClientRects?.() || []) {
            if (!rect.width || !rect.height) continue;
            const mark = document.createElement("span");
            mark.className = range === this.current ? "ess-result-mark ess-result-mark-current" : "ess-result-mark";
            Object.assign(mark.style, {left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`});
            fragment.append(mark);
        }
        this.overlay.replaceChildren(fragment);
    }

    clear() {
        this.version++;
        clearTimeout(this.timer);
        this.observer?.disconnect();
        this.observer = null;
        this.host = null;
        window.CSS?.highlights?.delete("ess-search-result");
        window.CSS?.highlights?.delete("ess-search-result-current");
        this.overlay?.remove();
        this.overlay = null;
        document.removeEventListener("scroll", this.queue, true);
        window.removeEventListener("resize", this.queue);
        window.visualViewport?.removeEventListener("resize", this.queue);
        this.query = null;
        this.rootID = null;
        this.block = null;
        this.element = null;
        this.ranges = [];
        this.current = null;
    }
}

module.exports = {SearchResultHighlighter};
