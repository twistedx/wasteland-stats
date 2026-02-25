const express = require("express");
const blog = require("../blog");
const router = express.Router();

function buildAvatarUrl(user) {
  if (user.avatar) {
    user.avatarUrl =
      "https://cdn.discordapp.com/avatars/" +
      user.discord_id + "/" + user.avatar + ".png?size=32";
  } else {
    const defaultIndex = Number(BigInt(user.discord_id) >> 22n) % 6;
    user.avatarUrl =
      "https://cdn.discordapp.com/embed/avatars/" + defaultIndex + ".png";
  }
}

// GET /blog — list published posts (optionally filtered by tag)
router.get("/", (req, res) => {
  const user = req.session.user || null;
  if (user) buildAvatarUrl(user);

  const tag = (req.query.tag || "").trim().toLowerCase();
  const posts = tag ? blog.getPostsByTag(tag) : blog.getPosts(true);
  const allTags = blog.getAllTags();

  res.render("blog", {
    page: "blog",
    pageTitle: tag ? `News — ${tag}` : "News",
    pageDescription: "Latest news and updates from the Arma Wasteland community.",
    user,
    posts,
    allTags,
    activeTag: tag || null,
  });
});

// GET /blog/:slug — single post
router.get("/:slug", (req, res) => {
  const user = req.session.user || null;
  if (user) buildAvatarUrl(user);

  const post = blog.getPost(req.params.slug);
  if (!post || !post.published) {
    return res.status(404).render("blog", {
      page: "blog",
      pageTitle: "Post Not Found",
      pageDescription: "The requested blog post was not found.",
      user,
      posts: [],
      allTags: [],
      activeTag: null,
      notFound: true,
    });
  }

  const postUrl = req.protocol + "://" + req.get("host") + "/blog/" + post.slug;

  // Build share text for X/Twitter
  const defaultHashtags = ["wasteland", "armareforger", "pvp", "arma", "survival", "milsim", "gaming", "indiegame", "iwannaplaygames"];
  const postHashtags = (post.tags || []).map(t => t.replace(/\s+/g, ""));
  const allHashtags = [...new Set([...defaultHashtags, ...postHashtags])];
  const hashtagStr = allHashtags.map(t => "#" + t).join(" ");
  const xShareText = `Check out this post:\n\n${post.title} ${postUrl}\n\n${hashtagStr}`;

  res.render("blog-post", {
    page: "blog",
    pageTitle: post.title,
    pageDescription: post.description || post.title + " — Arma Wasteland News",
    user,
    post,
    postUrl,
    xShareText,
  });
});

module.exports = router;
