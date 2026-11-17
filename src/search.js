"use strict";
const {searchRequest, titleScore, summary, searchOccurrences} = require("./core");

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

class SearchView {
    constructor(plugin, container, {close = () => {}} = {}) {
        this.plugin = plugin;
        this.container = container;
        this.close = close;
        this.selected = -1;
        this.page = 1;
        this.pageSize = [50, 100, 200].includes(Number(plugin.searchState.pageSize)) ? Number(plugin.searchState.pageSize) : 50;
        this.titles = [];
        this.blocks = [];
        this.version = 0;
        this.root = el("section", "ess-search");
        const header = el("div", "ess-search-header");
        this.input = el("input", "b3-text-field ess-query");
        this.input.type = "search";
        this.input.placeholder = "找笔记名称，或正文中的一句话…";
        this.input.setAttribute("aria-label", "搜索笔记和内容");
        this.input.autocomplete = "off";
        this.input.enterKeyHint = "search";
        this.input.value = plugin.searchState.query;
        this.searchButton = el("button", "b3-button ess-submit", "搜索");
        this.searchButton.type = "button";
        this.searchButton.onclick = () => {if (!this.composing) void this.submit();};
        header.append(this.input, this.searchButton);
        this.status = el("div", "ess-status");
        this.status.setAttribute("role", "status");
        this.results = el("div", "ess-results");
        this.results.setAttribute("aria-label", "搜索结果");
        this.pagination = el("nav", "ess-pagination");
        this.pagination.setAttribute("aria-label", "搜索结果分页");
        this.previousPage = el("button", "b3-button b3-button--outline", "上一页");
        this.nextPage = el("button", "b3-button b3-button--outline", "下一页");
        this.pageLabel = el("span", "ess-page-label");
        this.pageSizeSelect = el("select", "b3-select ess-page-size");
        this.pageSizeSelect.setAttribute("aria-label", "每页结果数");
        for (const size of [50, 100, 200]) {
            const option = el("option", "", `${size} 条/页`);
            option.value = String(size);
            this.pageSizeSelect.append(option);
        }
        this.pageSizeSelect.value = String(this.pageSize);
        this.pageSizeSelect.onchange = () => {
            this.remember();
            this.pageSize = Number(this.pageSizeSelect.value);
            this.plugin.searchState = {...this.plugin.searchState, pageSize: this.pageSize, scroll: 0};
            void this.plugin.saveData("data.json", {...this.plugin.searchState, recent: this.plugin.recent}).catch(error => {
                this.status.textContent = "每页条数保存失败：" + error.message;
            });
            this.results.scrollTop = 0;
            void this.load(1);
        };
        this.pageControls = el("div", "ess-page-controls");
        this.pageControls.append(this.previousPage, this.pageLabel, this.nextPage);
        this.previousPage.onclick = () => this.load(this.page - 1);
        this.nextPage.onclick = () => this.load(this.page + 1);
        this.pagination.append(this.pageSizeSelect, this.pageControls);
        this.pagination.hidden = true;
        this.footer = el("div", "ess-footer", "回车或点“搜索”查找 · 正文结果定位并高亮文字");
        this.root.append(header, this.status, this.results, this.pagination, this.footer);
        container.replaceChildren(this.root);
        this.input.oncompositionstart = () => {this.composing = true; clearTimeout(this.timer); this.controller?.abort(); this.version++;};
        this.input.oncompositionend = () => {this.composing = false; this.schedule();};
        this.input.oninput = event => {if (!event.isComposing && !this.composing) this.schedule();};
        this.root.onkeydown = event => this.keydown(event);
        this.load();
    }

    focus() {this.input.focus(); this.input.select();}

    remember() {
        this.plugin.searchState = {...this.plugin.searchState, query: this.input.value, pageSize: this.pageSize, scroll: this.results.scrollTop};
    }

    schedule() {
        clearTimeout(this.timer);
        this.controller?.abort();
        this.version++;
        this.busy = true;
        this.updatePagination();
        this.selected = -1;
        this.status.textContent = "正在查找…";
        this.results.replaceChildren();
        this.timer = setTimeout(() => this.load(), 160);
    }

    submit() {
        clearTimeout(this.timer);
        this.selected = -1;
        return this.load();
    }

    async load(page = 1) {
        this.controller?.abort();
        this.controller = new AbortController();
        const signal = this.controller.signal, version = ++this.version;
        const query = this.input.value.trim();
        this.busy = true;
        this.updatePagination();
        this.status.textContent = "正在查找…";
        try {
            if (!query) {
                this.renderRecent();
                return;
            }
            const [titles, content] = await Promise.all([
                this.plugin.post("/api/search/fullTextSearchBlock", searchRequest(query, true, page, this.pageSize), signal),
                this.plugin.post("/api/search/fullTextSearchBlock", searchRequest(query, false, page, this.pageSize), signal),
            ]);
            if (version !== this.version || this.destroyed) return;
            this.page = page;
            this.selected = -1;
            this.titleData = titles;
            this.titles = (titles?.blocks || []).map(block => this.clean(block));
            this.titles.sort((a, b) => titleScore(a.content, query) - titleScore(b.content, query) || a.content.localeCompare(b.content));
            this.contentData = content;
            this.blocks = (content?.blocks || []).map(block => this.clean(block));
            this.query = query;
            this.render();
            this.results.scrollTop = page === 1 && query === this.plugin.searchState.query ? this.plugin.searchState.scroll || 0 : 0;
        } catch (error) {
            if (signal.aborted || version !== this.version || this.destroyed) return;
            this.status.textContent = "搜索失败：" + error.message;
            this.results.replaceChildren();
            const retry = el("button", "b3-button b3-button--outline", "重试");
            retry.onclick = () => this.load(page);
            this.results.append(retry);
        } finally {if (version === this.version) {this.busy = false; this.updatePagination();}}
    }

    clean(block) {
        const searchHTML = String(block.content || "");
        const doc = new DOMParser().parseFromString(searchHTML, "text/html");
        return {...block, searchHTML, content: doc.body.textContent || ""};
    }

    renderRecent() {
        this.pagination.hidden = true;
        this.results.replaceChildren();
        this.status.textContent = "输入后搜索标题和正文；正文命中单行显示。";
        const heading = el("div", "ess-label", "最近打开");
        this.results.append(heading);
        const recent = this.plugin.recent || [];
        for (const item of recent) {
            const row = el("button", "ess-result ess-doc-title", item.title);
            row.onclick = event => this.open(item.id, null, event.ctrlKey || event.metaKey);
            this.results.append(row);
        }
        if (!recent.length) this.results.append(el("p", "ess-empty", "从这里打开的笔记会保留在最近列表里。"));
        this.refreshButtons();
    }

    render() {
        this.results.replaceChildren();
        const total = this.contentData?.matchedBlockCount || 0;
        this.status.textContent = `标题 ${this.titleData?.matchedBlockCount || 0} 篇 · 正文 ${total} 块（${this.contentData?.matchedRootCount || 0} 篇）`;
        if (this.titles.length) {
            this.results.append(el("div", "ess-label", "标题匹配"));
            for (const title of this.titles) this.renderRow(title.id, title.content);
        }
        if (this.blocks.length) {
            this.results.append(el("div", "ess-label", "正文匹配"));
            for (const block of this.blocks) {
                const rootID = block.rootID || block.root_id;
                if (!rootID) continue;
                const title = this.titles.find(item => item.id === rootID)?.content || block.hPath?.split("/").filter(Boolean).pop() || "未命名笔记";
                this.renderRow(rootID, title, block);
            }
        }
        if (!this.titles.length && !this.blocks.length) this.results.append(el("p", "ess-empty", "没有找到。试试更短的词，或去掉不确定的字。"));
        this.pagination.hidden = false;
        this.refreshButtons();
    }

    updatePagination() {
        if (!this.pagination) return;
        const count = Math.max(1, this.titleData?.pageCount || 0, this.contentData?.pageCount || 0);
        this.previousPage.disabled = this.busy || this.page <= 1;
        this.nextPage.disabled = this.busy || this.page >= count;
        this.pageLabel.textContent = `第 ${this.page} / ${count} 页`;
    }

    renderRow(rootID, title, block) {
        const row = el("button", block ? "ess-result ess-block" : "ess-result ess-doc-title");
        row.type = "button";
        row.dataset.rootId = rootID;
        row.dataset.blockId = block?.id || rootID;
        const heading = el("span", "ess-hit-title");
        this.highlight(heading, title);
        row.append(heading);
        if (block) {
            row.append(el("span", "ess-hit-separator", "—"));
            const snippet = el("span", "ess-hit-snippet");
            this.highlight(snippet, summary(block.content, this.query));
            row.append(snippet);
        }
        row.onclick = event => this.open(rootID, block, event.ctrlKey || event.metaKey, title);
        if (!block) {this.results.append(row); return;}

        const item = el("div", "ess-block-item");
        const expand = el("button", "ess-expand", "⌄");
        expand.type = "button";
        expand.setAttribute("aria-expanded", "false");
        expand.setAttribute("aria-label", "展开完整命中内容");
        const full = el("div", "ess-full-content");
        full.hidden = true;
        this.highlight(full, block.content);
        expand.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            const expanded = full.hidden;
            full.hidden = !expanded;
            expand.textContent = expanded ? "⌃" : "⌄";
            expand.setAttribute("aria-expanded", String(expanded));
            expand.setAttribute("aria-label", expanded ? "收起完整命中内容" : "展开完整命中内容");
        };
        item.append(row, expand, full);
        this.results.append(item);
    }

    highlight(node, text) {
        let last = 0;
        for (const match of searchOccurrences(text, this.query)) {
            node.append(document.createTextNode(text.slice(last, match.start)), el("mark", "", text.slice(match.start, match.end)));
            last = match.end;
        }
        node.append(document.createTextNode(text.slice(last)));
    }

    refreshButtons() {
        this.buttons = [...this.results.querySelectorAll(".ess-result")];
        this.selected = this.buttons.length ? Math.min(Math.max(0, this.selected), this.buttons.length - 1) : -1;
        this.buttons.forEach((button, index) => {
            button.classList.toggle("ess-selected", index === this.selected);
            button.setAttribute("aria-current", String(index === this.selected));
        });
    }

    keydown(event) {
        if (event.isComposing || this.composing || event.keyCode === 229) return;
        if (event.key === "Escape") {event.preventDefault(); event.stopPropagation(); this.remember(); this.close(); return;}
        if (event.target !== this.input) return;
        if (event.key === "Enter") {
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) void this.submit();
            return;
        }
        if (this.busy) return;
        if (["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const count = this.buttons.length;
            if (!count) return;
            this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
            this.refreshButtons();
            this.buttons[this.selected].scrollIntoView({block: "nearest"});
        }
    }

    async open(rootID, block, newTab = false, title) {
        if (this.opening) return;
        this.opening = true;
        this.remember();
        try {
            const result = await this.plugin.openResult(rootID, block, this.input.value.trim(), newTab, title);
            if (this.destroyed) return;
            this.status.textContent = result?.highlighted ? `已定位到“${title || "搜索结果"}”中的匹配文字；可继续搜索。` : `已打开“${title || "搜索结果"}”；搜索窗口保持打开。`;
            this.footer.textContent = "搜索窗口已缩至屏幕角落 · 修改关键词继续搜索 · 点击正文结果定位高亮文字";
        } catch (error) {this.status.textContent = "打开失败：" + error.message;}
        finally {this.opening = false;}
    }

    destroy() {
        if (this.destroyed) return;
        this.remember();
        this.destroyed = true;
        this.version++;
        this.controller?.abort();
        clearTimeout(this.timer);
        this.root.remove();
    }
}

module.exports = {SearchView, el};
