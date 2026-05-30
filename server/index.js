import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const distDir = path.join(rootDir, "dist");
const dbPath = path.join(dataDir, "blog.sqlite");
const port = Number(process.env.PORT || 4100);

const categories = ["Design", "Product", "Engineering", "Culture", "Growth"];
const coverThemes = ["ember", "violet", "mint", "sky", "sunset"];

fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    excerpt TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    cover_theme TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
`);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sqliteDate(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
  });

  return `scrypt:16384:8:1:${salt}:${hash.toString("base64url")}`;
}

function verifyPassword(password, storedHash) {
  const [method, n, r, p, salt, hash] = storedHash.split(":");
  if (method !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function makeUniqueSlug(title, currentPostId = null) {
  const base = slugify(title) || "post";
  let slug = base;
  let count = 2;

  while (true) {
    const row = db
      .prepare("SELECT id FROM posts WHERE slug = ? AND (? IS NULL OR id != ?)")
      .get(slug, currentPostId, currentPostId);

    if (!row) {
      return slug;
    }

    slug = `${base}-${count}`;
    count += 1;
  }
}

function compactText(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max - 1).trim()}...`;
}

function assertString(value, field, min, max) {
  const text = String(value || "").trim();
  if (text.length < min) {
    throw new HttpError(400, `${field} must be at least ${min} characters.`);
  }

  if (text.length > max) {
    throw new HttpError(400, `${field} must be ${max} characters or less.`);
  }

  return text;
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  };
}

function formatPost(row, comments = undefined) {
  const post = {
    id: row.id,
    title: row.title,
    slug: row.slug,
    excerpt: row.excerpt,
    content: row.content,
    category: row.category,
    coverTheme: row.cover_theme,
    commentCount: row.comment_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: {
      id: row.author_id,
      name: row.author_name,
      email: row.author_email,
    },
  };

  if (comments) {
    post.comments = comments;
  }

  return post;
}

function formatComment(row) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    author: {
      id: row.author_id,
      name: row.author_name,
      email: row.author_email,
    },
  };
}

function createSession(userId) {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = sqliteDate(Date.now() + 1000 * 60 * 60 * 24 * 7);
  db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)").run(
    userId,
    hashToken(token),
    expiresAt,
  );

  return { token, expiresAt };
}

function authenticate(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return null;
  }

  const row = db
    .prepare(
      `
        SELECT u.id, u.name, u.email, u.created_at
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > datetime('now')
      `,
    )
    .get(hashToken(token));

  return row ? publicUser(row) : null;
}

function requireUser(req) {
  const user = authenticate(req);
  if (!user) {
    throw new HttpError(401, "Sign in to continue.");
  }

  return user;
}

function getPostRowByIdOrSlug(idOrSlug) {
  const isNumeric = /^\d+$/.test(idOrSlug);

  return db
    .prepare(
      `
        SELECT p.*, u.id AS author_id, u.name AS author_name, u.email AS author_email,
          (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
        FROM posts p
        JOIN users u ON u.id = p.user_id
        WHERE ${isNumeric ? "p.id = ?" : "p.slug = ?"}
      `,
    )
    .get(isNumeric ? Number(idOrSlug) : idOrSlug);
}

function getPostWithComments(idOrSlug) {
  const post = getPostRowByIdOrSlug(idOrSlug);
  if (!post) {
    throw new HttpError(404, "Post not found.");
  }

  const comments = db
    .prepare(
      `
        SELECT c.*, u.id AS author_id, u.name AS author_name, u.email AS author_email
        FROM comments c
        JOIN users u ON u.id = c.user_id
        WHERE c.post_id = ?
        ORDER BY datetime(c.created_at) ASC, c.id ASC
      `,
    )
    .all(post.id)
    .map(formatComment);

  return formatPost(post, comments);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new HttpError(413, "Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Invalid JSON payload."));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(req, res, status, payload) {
  const origin = req.headers.origin || "*";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    Vary: "Origin",
  });
  res.end(JSON.stringify(payload));
}

function sendEmpty(req, res, status = 204) {
  const origin = req.headers.origin || "*";
  res.writeHead(status, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    Vary: "Origin",
  });
  res.end();
}

function getContentType(filePath) {
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };

  return types[ext] || "application/octet-stream";
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(distDir)) {
    sendJson(req, res, 404, { message: "Frontend build not found. Run the Vite app in development mode." });
    return;
  }

  const normalized = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(distDir, `.${normalized}`);

  if (!filePath.startsWith(distDir)) {
    sendJson(req, res, 403, { message: "Forbidden." });
    return;
  }

  const resolvedPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(distDir, "index.html");

  res.writeHead(200, { "Content-Type": getContentType(resolvedPath) });
  fs.createReadStream(resolvedPath).pipe(res);
}

function seedDatabase() {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  let demoUser = db.prepare("SELECT id FROM users WHERE email = ?").get("demo@blogforge.test");

  if (!demoUser) {
    const result = db
      .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
      .run("Maya Chen", "demo@blogforge.test", hashPassword("DemoPass123!"));
    demoUser = { id: Number(result.lastInsertRowid) };
  }

  const postCount = db.prepare("SELECT COUNT(*) AS count FROM posts").get().count;
  if (postCount === 0) {
    const starterPosts = [
      {
        title: "Designing Comments People Actually Want To Read",
        category: "Design",
        theme: "ember",
        excerpt: "Good comment spaces are designed before the first reply arrives.",
        content:
          "A healthy comment section starts with clear context. Posts should invite a specific kind of response, give readers a shared surface to react to, and make it easy for authors to return to the thread without losing momentum.",
      },
      {
        title: "A Practical Launch Checklist For Small Product Teams",
        category: "Product",
        theme: "mint",
        excerpt: "Ship with confidence by keeping launch work visible and conversational.",
        content:
          "The strongest launches are built from boring reliability: crisp ownership, visible risks, short feedback loops, and a place where the team can explain decisions as they happen. A blog is often the best changelog because it captures the why, not only the what.",
      },
      {
        title: "Why Authentication UX Is Part Of Security",
        category: "Engineering",
        theme: "sky",
        excerpt: "A secure system should feel calm, legible, and fast.",
        content:
          "Password hashing protects the data layer, but security also depends on the experience around it. Clear errors, predictable sessions, and confident account controls help users do the right thing without friction.",
      },
    ];

    for (const post of starterPosts) {
      const result = db
        .prepare(
          `
            INSERT INTO posts (user_id, title, slug, excerpt, content, category, cover_theme)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          demoUser.id,
          post.title,
          makeUniqueSlug(post.title),
          post.excerpt,
          post.content,
          post.category,
          post.theme,
        );

      db.prepare("INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)").run(
        Number(result.lastInsertRowid),
        demoUser.id,
        "This is the kind of thread starter that keeps the conversation useful.",
      );
    }
  }

  if (userCount === 0) {
    console.log("Seeded demo login: demo@blogforge.test / DemoPass123!");
  }
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const pathname = url.pathname;
  const currentUser = authenticate(req);

  if (method === "GET" && pathname === "/api/health") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/register") {
    const body = await readJson(req);
    const name = assertString(body.name, "Name", 2, 80);
    const email = normalizeEmail(body.email);
    const password = assertString(body.password, "Password", 8, 128);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError(400, "Enter a valid email address.");
    }

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      throw new HttpError(409, "An account already exists for this email.");
    }

    const result = db
      .prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)")
      .run(name, email, hashPassword(password));
    const user = publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(Number(result.lastInsertRowid)));
    const session = createSession(user.id);
    sendJson(req, res, 201, { user, ...session });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/login") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email);

    if (!row || !verifyPassword(password, row.password_hash)) {
      throw new HttpError(401, "Email or password is incorrect.");
    }

    const session = createSession(row.id);
    sendJson(req, res, 200, { user: publicUser(row), ...session });
    return;
  }

  if (method === "GET" && pathname === "/api/auth/me") {
    sendJson(req, res, 200, { user: currentUser });
    return;
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (token) {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    }

    sendEmpty(req, res);
    return;
  }

  if (method === "GET" && pathname === "/api/posts") {
    const search = String(url.searchParams.get("search") || "").trim();
    const category = String(url.searchParams.get("category") || "").trim();
    const mine = url.searchParams.get("mine") === "true";
    const clauses = [];
    const params = [];

    if (search) {
      clauses.push("(p.title LIKE ? OR p.excerpt LIKE ? OR p.content LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (category && category !== "All") {
      clauses.push("p.category = ?");
      params.push(category);
    }

    if (mine) {
      if (!currentUser) {
        throw new HttpError(401, "Sign in to view your posts.");
      }

      clauses.push("p.user_id = ?");
      params.push(currentUser.id);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const posts = db
      .prepare(
        `
          SELECT p.*, u.id AS author_id, u.name AS author_name, u.email AS author_email,
            (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
          FROM posts p
          JOIN users u ON u.id = p.user_id
          ${where}
          ORDER BY datetime(p.updated_at) DESC, p.id DESC
        `,
      )
      .all(...params)
      .map((row) => formatPost(row));

    sendJson(req, res, 200, { posts, categories });
    return;
  }

  if (method === "POST" && pathname === "/api/posts") {
    const user = requireUser(req);
    const body = await readJson(req);
    const title = assertString(body.title, "Title", 4, 120);
    const content = assertString(body.content, "Content", 20, 12000);
    const excerpt = body.excerpt ? assertString(body.excerpt, "Excerpt", 12, 220) : compactText(content, 150);
    const category = categories.includes(body.category) ? body.category : "Culture";
    const theme = coverThemes.includes(body.coverTheme) ? body.coverTheme : coverThemes[Math.floor(Math.random() * coverThemes.length)];
    const slug = makeUniqueSlug(title);

    const result = db
      .prepare(
        `
          INSERT INTO posts (user_id, title, slug, excerpt, content, category, cover_theme)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(user.id, title, slug, excerpt, content, category, theme);

    sendJson(req, res, 201, { post: getPostWithComments(String(Number(result.lastInsertRowid))) });
    return;
  }

  const postDetailMatch = pathname.match(/^\/api\/posts\/([^/]+)$/);
  if (method === "GET" && postDetailMatch) {
    sendJson(req, res, 200, { post: getPostWithComments(decodeURIComponent(postDetailMatch[1])) });
    return;
  }

  if (method === "PATCH" && postDetailMatch) {
    const user = requireUser(req);
    const existing = getPostRowByIdOrSlug(decodeURIComponent(postDetailMatch[1]));
    if (!existing) {
      throw new HttpError(404, "Post not found.");
    }

    if (existing.author_id !== user.id) {
      throw new HttpError(403, "Only the author can edit this post.");
    }

    const body = await readJson(req);
    const title = body.title !== undefined ? assertString(body.title, "Title", 4, 120) : existing.title;
    const content = body.content !== undefined ? assertString(body.content, "Content", 20, 12000) : existing.content;
    const excerpt = body.excerpt !== undefined && body.excerpt !== ""
      ? assertString(body.excerpt, "Excerpt", 12, 220)
      : compactText(content, 150);
    const category = categories.includes(body.category) ? body.category : existing.category;
    const coverTheme = coverThemes.includes(body.coverTheme) ? body.coverTheme : existing.cover_theme;
    const slug = title === existing.title ? existing.slug : makeUniqueSlug(title, existing.id);

    db.prepare(
      `
        UPDATE posts
        SET title = ?, slug = ?, excerpt = ?, content = ?, category = ?, cover_theme = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
    ).run(title, slug, excerpt, content, category, coverTheme, existing.id);

    sendJson(req, res, 200, { post: getPostWithComments(String(existing.id)) });
    return;
  }

  if (method === "DELETE" && postDetailMatch) {
    const user = requireUser(req);
    const existing = getPostRowByIdOrSlug(decodeURIComponent(postDetailMatch[1]));
    if (!existing) {
      throw new HttpError(404, "Post not found.");
    }

    if (existing.author_id !== user.id) {
      throw new HttpError(403, "Only the author can delete this post.");
    }

    db.prepare("DELETE FROM posts WHERE id = ?").run(existing.id);
    sendEmpty(req, res);
    return;
  }

  const createCommentMatch = pathname.match(/^\/api\/posts\/([^/]+)\/comments$/);
  if (method === "POST" && createCommentMatch) {
    const user = requireUser(req);
    const post = getPostRowByIdOrSlug(decodeURIComponent(createCommentMatch[1]));
    if (!post) {
      throw new HttpError(404, "Post not found.");
    }

    const body = await readJson(req);
    const commentBody = assertString(body.body, "Comment", 2, 800);
    const result = db
      .prepare("INSERT INTO comments (post_id, user_id, body) VALUES (?, ?, ?)")
      .run(post.id, user.id, commentBody);

    const comment = db
      .prepare(
        `
          SELECT c.*, u.id AS author_id, u.name AS author_name, u.email AS author_email
          FROM comments c
          JOIN users u ON u.id = c.user_id
          WHERE c.id = ?
        `,
      )
      .get(Number(result.lastInsertRowid));

    sendJson(req, res, 201, { comment: formatComment(comment) });
    return;
  }

  const deleteCommentMatch = pathname.match(/^\/api\/comments\/(\d+)$/);
  if (method === "DELETE" && deleteCommentMatch) {
    const user = requireUser(req);
    const row = db
      .prepare(
        `
          SELECT c.*, p.user_id AS post_author_id
          FROM comments c
          JOIN posts p ON p.id = c.post_id
          WHERE c.id = ?
        `,
      )
      .get(Number(deleteCommentMatch[1]));

    if (!row) {
      throw new HttpError(404, "Comment not found.");
    }

    if (row.user_id !== user.id && row.post_author_id !== user.id) {
      throw new HttpError(403, "You can only delete your own comments or comments on your posts.");
    }

    db.prepare("DELETE FROM comments WHERE id = ?").run(row.id);
    sendEmpty(req, res);
    return;
  }

  throw new HttpError(404, "Route not found.");
}

async function requestHandler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    sendEmpty(req, res);
    return;
  }

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    serveStatic(req, res, url.pathname);
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : "Something went wrong.";
    if (!(error instanceof HttpError)) {
      console.error(error);
    }

    sendJson(req, res, status, { message });
  }
}

seedDatabase();

http.createServer(requestHandler).listen(port, () => {
  console.log(`API server listening on http://127.0.0.1:${port}`);
});
