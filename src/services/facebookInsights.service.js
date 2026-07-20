"use strict";
// Facebook хуудасны ПОСТ ТАЙЛАН — Graph API-аас постууд + engagement (like/comment/
// share/reaction) татна. pages_read_engagement эрхээр ажиллана (reach/impressions
// нэмэлт read_insights эрх шаарддаг тул одоохондоо оруулаагүй).
const axios = require("axios");

const GRAPH = "https://graph.facebook.com/v19.0";

// Тоон утгыг аюулгүй унших
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

// Нэг хуудасны сүүлийн постуудыг engagement-тэй нь татаж, цэвэрлэсэн хэлбэрээр буцаана.
// pageId — Facebook Page ID, token — тухайн хуудасны (decrypt хийсэн) access token.
async function fetchPagePosts(pageId, token, limit = 25) {
  if (!pageId || !token) return { posts: [], summary: emptySummary() };

  const fields = [
    "id",
    "message",
    "created_time",
    "permalink_url",
    "full_picture",
    "shares",
    "likes.summary(true).limit(0)",
    "comments.summary(true).limit(0)",
    "reactions.summary(true).limit(0)",
  ].join(",");

  const res = await axios.get(`${GRAPH}/${pageId}/posts`, {
    params: { fields, limit: Math.min(Math.max(Number(limit) || 25, 1), 50), access_token: token },
    timeout: 15000,
  });

  const posts = (res.data?.data || []).map((p) => {
    const likes = num(p.likes?.summary?.total_count);
    const comments = num(p.comments?.summary?.total_count);
    const reactions = num(p.reactions?.summary?.total_count);
    const shares = num(p.shares?.count);
    return {
      id: p.id,
      message: p.message ? String(p.message).slice(0, 500) : "",
      createdTime: p.created_time,
      permalink: p.permalink_url || null,
      image: p.full_picture || null,
      likes, comments, shares, reactions,
      engagement: reactions + comments + shares, // reactions нь like-ийг агуулна
    };
  });

  return { posts, summary: summarize(posts) };
}

function emptySummary() {
  return { postCount: 0, totalReactions: 0, totalComments: 0, totalShares: 0, totalEngagement: 0, avgEngagement: 0, topPostId: null };
}

function summarize(posts) {
  if (!posts.length) return emptySummary();
  let totalReactions = 0, totalComments = 0, totalShares = 0, totalEngagement = 0;
  let top = posts[0];
  for (const p of posts) {
    totalReactions += p.reactions;
    totalComments += p.comments;
    totalShares += p.shares;
    totalEngagement += p.engagement;
    if (p.engagement > top.engagement) top = p;
  }
  return {
    postCount: posts.length,
    totalReactions, totalComments, totalShares, totalEngagement,
    avgEngagement: Math.round(totalEngagement / posts.length),
    topPostId: top.id,
  };
}

module.exports = { fetchPagePosts, summarize, emptySummary };
