const test = require("node:test");
const assert = require("node:assert/strict");
const {occurrences, searchOccurrences, searchRequest, titleScore, summary, groupResults, stepIndex} = require("../src/core.js");

test("occurrences counts repeated unicode matches", () => {
    assert.deepEqual(occurrences("同步，同步；同步", "同步"), [
        {start: 0, end: 2}, {start: 3, end: 5}, {start: 6, end: 8},
    ]);
});

test("global search occurrences highlight literal query terms without overlapping shorter terms", () => {
    assert.deepEqual(searchOccurrences("同学和同学聚会", "同学 聚会"), [{start: 0, end: 2}, {start: 3, end: 5}, {start: 5, end: 7}]);
    assert.deepEqual(searchOccurrences("a.b and ab", "a.b ab"), [{start: 0, end: 3}, {start: 8, end: 10}]);
    assert.equal(searchRequest("词", false, 3).page, 3);
    assert.equal(searchRequest("词", false).pageSize, 50);
    assert.equal(searchRequest("词", false, 1, 200).pageSize, 200);
});

test("title ranking keeps exact and prefix titles first", () => {
    assert.ok(titleScore("同步", "同步") < titleScore("同步方案", "同步"));
    assert.ok(titleScore("同步方案", "同步") < titleScore("我的同步记录", "同步"));
});

test("summary keeps the hit visible and shortens long blocks", () => {
    const value = summary("前面的内容。".repeat(30) + "关键字" + "后面的内容。".repeat(30), "关键字", 60);
    assert.match(value, /关键字/);
    assert.ok(value.length <= 63);
});

test("groupResults deduplicates blocks and groups by root document", () => {
    const result = groupResults([{id: "doc-1", content: "标题", hPath: "笔记/标题"}], [
        {id: "b-1", rootID: "doc-1", content: "一"},
        {id: "b-1", rootID: "doc-1", content: "一"},
        {id: "b-2", rootID: "doc-2", content: "二", hPath: "笔记/另一个"},
    ]);
    assert.equal(result.length, 2);
    assert.equal(result.find(item => item.id === "doc-1").blocks.length, 1);
    assert.equal(result.find(item => item.id === "doc-2").blocks.length, 1);
});

test("stepIndex wraps in both directions", () => {
    assert.deepEqual(stepIndex(2, 1, 3), {index: 0, wrapped: true});
    assert.deepEqual(stepIndex(0, -1, 3), {index: 2, wrapped: true});
});
