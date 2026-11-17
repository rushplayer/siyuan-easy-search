"use strict";

const TYPE_NAMES = ["document", "heading", "paragraph", "list", "listItem", "blockquote", "superBlock", "codeBlock", "table", "mathBlock", "htmlBlock", "embedBlock", "databaseBlock", "audioBlock", "videoBlock", "iframeBlock", "widgetBlock", "callout", "tabs", "tabItem"];
const CONTENT_TYPES = TYPE_NAMES.filter(type => type !== "document");

function searchRequest(query, titles = false, page = 1, pageSize = 50) {
    const enabled = titles ? ["document"] : CONTENT_TYPES;
    return {
        query: query.trim(), method: 0, page, pageSize, groupBy: 0,
        orderBy: 7, searchHPath: false,
        types: Object.fromEntries(TYPE_NAMES.map(type => [type, enabled.includes(type)])),
    };
}

function titleScore(title, query) {
    const value = title.toLocaleLowerCase(), q = query.trim().toLocaleLowerCase();
    if (value === q) return 0;
    if (value.startsWith(q)) return 1;
    if (value.includes(q)) return 2;
    if (q.split(/\s+/u).every(term => value.includes(term))) return 3;
    return 4;
}

// Non-overlapping, literal UTF-16 offsets: compatible with DOM Range offsets.
function occurrences(text, query, caseSensitive = false) {
    if (!query) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
    return Array.from(text.matchAll(pattern), match => ({start: match.index, end: match.index + match[0].length}));
}

function searchOccurrences(text, query) {
    const terms = query.trim().split(/\s+/u).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!terms.length) return [];
    const pattern = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return Array.from(text.matchAll(new RegExp(pattern, "giu")), match => ({start: match.index, end: match.index + match[0].length}));
}

function summary(text, query, max = 150) {
    const terms = query.trim().split(/\s+/u).filter(Boolean);
    const index = Math.min(...terms.map(term => {
        const found = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
        return found < 0 ? Infinity : found;
    }));
    const start = Number.isFinite(index) ? Math.max(0, index - 40) : 0;
    return (start ? "…" : "") + text.slice(start, start + max).replace(/\s+/gu, " ") + (start + max < text.length ? "…" : "");
}

function groupResults(titles, blocks) {
    const groups = new Map();
    for (const title of titles) groups.set(title.id, {id: title.id, title: title.content, path: title.hPath || "", titleMatch: true, blocks: []});
    const seen = new Set();
    for (const block of blocks) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        const root = block.rootID || block.root_id;
        if (!root) continue;
        if (!groups.has(root)) {
            const path = block.hPath || "";
            groups.set(root, {id: root, title: path.split("/").filter(Boolean).pop() || "未命名笔记", path, titleMatch: false, blocks: []});
        }
        groups.get(root).blocks.push(block);
    }
    return [...groups.values()];
}

function stepIndex(current, direction, length) {
    if (!length) return {index: -1, wrapped: false};
    const next = current + direction;
    return {index: (next + length) % length, wrapped: current >= 0 && (next < 0 || next >= length)};
}

function textNodes(element) {
    const doc = element.ownerDocument;
    const walker = doc.createTreeWalker(element, 4);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
        if (!node.parentElement.closest("script,style,[data-type='NodeBlockQueryEmbed'],.protyle-attr,.protyle-action,.protyle-linenumber")) nodes.push(node);
    }
    return nodes;
}

// Count each editable region once, retaining document order and inline markup.
function collectUnits(root) {
    const elements = [...root.querySelectorAll("[contenteditable]")];
    if (root.matches?.("[contenteditable]")) elements.unshift(root);
    return elements.filter(element => {
        const block = element.closest("[data-node-id]");
        const parent = element.parentElement.closest("[contenteditable]");
        // SiYuan makes both the document and individual text regions editable.
        // The document wrapper is not a text unit; its children still are.
        return block && !element.classList.contains("protyle-wysiwyg") &&
            (!parent || parent.classList.contains("protyle-wysiwyg") || parent.closest("[data-node-id]") !== block) &&
            !element.closest("[data-type='NodeBlockQueryEmbed'],[data-type='NodeAttributeView'],.protyle-attr,.protyle-action,.protyle-linenumber");
    }).map(element => {
        const block = element.closest("[data-node-id]");
        const nodes = textNodes(element);
        return {id: block.dataset.nodeId, element, nodes, text: nodes.map(node => node.data).join("")};
    });
}

function toRange(unit, start, end) {
    const nodes = unit.nodes || textNodes(unit.element);
    const range = unit.element.ownerDocument.createRange();
    let offset = 0, started = false;
    for (const node of nodes) {
        const limit = offset + node.data.length;
        if (!started && start < limit) {range.setStart(node, start - offset); started = true;}
        if (started && end <= limit) {range.setEnd(node, end - offset); return range;}
        offset = limit;
    }
    return null;
}

module.exports = {searchRequest, titleScore, occurrences, searchOccurrences, summary, groupResults, stepIndex, collectUnits, toRange};
