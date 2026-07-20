"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { summarize, emptySummary } = require("../src/services/facebookInsights.service");

test("summarize: хоосон массив → бүх 0, topPostId null", () => {
  assert.deepStrictEqual(summarize([]), emptySummary());
});

test("summarize: engagement нийлбэр ба дундаж зөв", () => {
  const posts = [
    { id: "a", reactions: 10, comments: 2, shares: 1, engagement: 13 },
    { id: "b", reactions: 20, comments: 5, shares: 3, engagement: 28 },
  ];
  const s = summarize(posts);
  assert.strictEqual(s.postCount, 2);
  assert.strictEqual(s.totalReactions, 30);
  assert.strictEqual(s.totalComments, 7);
  assert.strictEqual(s.totalShares, 4);
  assert.strictEqual(s.totalEngagement, 41);
  assert.strictEqual(s.avgEngagement, Math.round(41 / 2)); // 21
});

test("summarize: хамгийн их engagement-тэй постыг topPostId болгоно", () => {
  const posts = [
    { id: "low", reactions: 1, comments: 0, shares: 0, engagement: 1 },
    { id: "high", reactions: 50, comments: 10, shares: 5, engagement: 65 },
    { id: "mid", reactions: 20, comments: 2, shares: 0, engagement: 22 },
  ];
  assert.strictEqual(summarize(posts).topPostId, "high");
});
