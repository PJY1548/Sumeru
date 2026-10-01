import { Router } from 'itty-router';
import sanitizeHtml from 'sanitize-html';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

const router = Router();

// ==================== 配置常量 ====================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Max-Age": "86400",
};

const COOKIE_NAME = 'auth_token';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 10;
const USERNAME_REGEX = /^[a-zA-Z0-9_\u4e00-\u9fa5]{3,20}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;

const MAX_BIO_LENGTH = 500;
const MAX_INTRO_LENGTH = 2000;
const MAX_WEBSITE_LENGTH = 500;
const MAX_AVATAR_LENGTH = 500;
const COMMENT_MAX_LENGTH = 5000;
const COMMENT_PAGE_LIMIT = 50;

// 防止用户枚举的固定假哈希
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.GdPaYV0RGjY4z6rI8DTzGRc0jGm6';

// ==================== 通用工具 ====================

const jsonResponse = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=UTF-8',
      ...extraHeaders,
    },
  });

const errorResponse = (message, status = 400) =>
  jsonResponse({ success: false, message }, status);

const successResponse = (data = null, message = 'ok', extraHeaders = {}) =>
  jsonResponse({ success: true, message, data }, 200, extraHeaders);

const getClientIp = (request) =>
  request.headers.get('CF-Connecting-IP') ||
  request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
  'unknown';

const safeJsonParse = async (request) => {
  try { return await request.json(); } catch (e) { return null; }
};

const parseCookies = (cookieHeader) => {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('='));
  });
  return cookies;
};

const parsePagination = (url) => {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(
    COMMENT_PAGE_LIMIT,
    Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10) || 20)
  );
  return { page, limit, offset: (page - 1) * limit };
};

// ==================== JWT ====================

const getJwtSecret = (env) => {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET 未配置，请执行: wrangler secret put JWT_SECRET');
  }
  return new TextEncoder().encode(env.JWT_SECRET);
};

const generateToken = async (user, env) => {
  const secret = getJwtSecret(env);
  return await new SignJWT({
    uid: user.id,
    username: user.username,
    is_admin: user.is_admin || 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(JWT_EXPIRY)
    .setIssuer(env.JWT_ISSUER || 'sumeru')
    .sign(secret);
};

const verifyToken = async (token, env) => {
  if (!token) return null;
  try {
    const secret = getJwtSecret(env);
    const { payload } = await jwtVerify(token, secret, {
      issuer: env.JWT_ISSUER || 'sumeru',
    });
    return payload;
  } catch (e) { return null; }
};

const extractToken = (request) => {
  const cookies = parseCookies(request.headers.get('Cookie'));
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.substring(7);
  return null;
};

const getCurrentUser = async (request, env) => {
  const token = extractToken(request);
  if (!token) return null;
  const payload = await verifyToken(token, env);
  if (!payload) return null;
  return { id: payload.uid, username: payload.username, is_admin: payload.is_admin };
};

// ==================== Cookie ====================

const setAuthCookie = (token) =>
  `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;

const clearAuthCookie = () =>
  `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// ==================== 速率限制（基于 KV） ====================

const rateLimit = async (env, key, max, windowSec) => {
  if (!env.sumeru) return { allowed: true };
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowKey = Math.floor(now / windowSec);
    const recordKey = `rl:${key}:${windowKey}`;
    const current = await env.sumeru.get(recordKey);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= max) {
      return { allowed: false, retryAfter: windowSec - (now % windowSec) };
    }
    await env.sumeru.put(recordKey, String(count + 1), {
      expirationTtl: windowSec + 60,
    });
    return { allowed: true };
  } catch (e) { return { allowed: true }; }
};

// ==================== OPTIONS 预检 ====================
router.options('*', () => new Response(null, { headers: corsHeaders }));

// ==================== 数据库初始化 ====================

const addColumnIfMissing = async (env, table, column, definition) => {
  try {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    if (!results.some((col) => col.name === column)) {
      await env.DB.prepare(
        `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`
      ).run();
      console.log(`已为 ${table} 添加列 ${column}`);
    }
  } catch (e) {
    console.error(`添加列 ${table}.${column} 失败:`, e);
  }
};

const initDB = async (env) => {
  if (!env.DB) throw new Error('D1 数据库未绑定，请检查 wrangler.toml');

  const stmts = [
    // users 表（含自我介绍、个人网站）
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      bio TEXT,
      introduction TEXT,
      website TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP
    )`,
    // posts 表
    `CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // comments 表（纯净版，仅 user_id 关联用户）
    `CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    // 索引
    `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
    `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_user_created ON comments(user_id, created_at DESC)`,
  ];

  for (const sql of stmts) {
    await env.DB.prepare(sql).run();
  }

  // 兼容老 users 表（追加新列；comments 表用户已删过，会用全新结构）
  await addColumnIfMissing(env, 'users', 'avatar_url', 'TEXT');
  await addColumnIfMissing(env, 'users', 'bio', 'TEXT');
  await addColumnIfMissing(env, 'users', 'introduction', 'TEXT');
  await addColumnIfMissing(env, 'users', 'website', 'TEXT');
  await addColumnIfMissing(env, 'users', 'is_admin', 'INTEGER DEFAULT 0');
};

const checkTableExists = async (env) => {
  try {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('posts', 'users', 'comments')"
    ).all();
    return results.length >= 3;
  } catch (e) { return false; }
};

// ==================== KV 静态资源 ====================

const getKVAsset = async (env, key) => {
  if (!env.sumeru) throw new Error('KV 命名空间未绑定');
  const content = await env.sumeru.get(key, { type: 'text' });
  if (!content) throw new Error(`资源 "${key}" 不存在`);
  return content;
};

const handleStaticPage = async (page, env, needInitDB = false) => {
  try {
    if (needInitDB) {
      const isInitialized = await checkTableExists(env);
      if (!isInitialized) await initDB(env);
    }
    const htmlContent = await getKVAsset(env, page);
    return new Response(htmlContent, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (e) {
    return new Response(`${page} 加载失败: ${e.message}`, {
      status: 404,
      headers: corsHeaders,
    });
  }
};

// ==================== 页面路由 ====================
router.get('/', (request, env) => handleStaticPage('index.html', env, true));
router.get('/post', (request, env) => handleStaticPage('post.html', env));
router.get('/posts', (request, env) => handleStaticPage('posts.html', env));
router.get('/post/:id', (request, env) => handleStaticPage('post.html', env));
router.get('/login', (request, env) => handleStaticPage('login.html', env));
router.get('/profile', (request, env) => handleStaticPage('profile.html', env));
router.get('/u/:id', (request, env) => handleStaticPage('user.html', env));

// ==================== 认证 API ====================

// POST /api/auth/register
router.post('/api/auth/register', async (request, env) => {
  try {
    const ip = getClientIp(request);
    const rl = await rateLimit(env, `register:${ip}`, 5, 3600);
    if (!rl.allowed) return errorResponse('注册请求过于频繁，请稍后再试', 429);

    const body = await safeJsonParse(request);
    if (!body) return errorResponse('请求格式错误');

    const { username, email, password } = body;

    if (!username || !password) return errorResponse('用户名和密码不能为空');
    if (!USERNAME_REGEX.test(username)) {
      return errorResponse('用户名只能包含字母、数字、下划线或中文，长度 3-20 位');
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return errorResponse(`密码至少需要 ${PASSWORD_MIN_LENGTH} 位`);
    }
    if (email && !EMAIL_REGEX.test(email)) {
      return errorResponse('邮箱格式不正确');
    }

    const existing = await env.DB.prepare(
      'SELECT id, username, email FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)'
    ).bind(username, email || '').first();

    if (existing) {
      if (existing.username === username) return errorResponse('用户名已被注册', 409);
      return errorResponse('邮箱已被注册', 409);
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const userCount = await env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
    const isAdmin = Number(userCount.count) === 0 ? 1 : 0;

    const result = await env.DB.prepare(
      'INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, ?)'
    ).bind(username, email || null, password_hash, isAdmin).run();

    const userId = result.meta?.last_row_id;
    const user = { id: userId, username, is_admin: isAdmin };
    const token = await generateToken(user, env);

    if (isAdmin) {
      console.log(`[admin] 首个管理员账号已创建: ${username} (ID: ${userId})`);
    }

    return successResponse(
      {
        user: {
          id: userId, username,
          email: email || null,
          avatar_url: null, bio: null,
          introduction: null, website: null,
          is_admin: isAdmin,
        },
        token,
      },
      '注册成功',
      { 'Set-Cookie': setAuthCookie(token) }
    );
  } catch (e) {
    console.error('注册错误:', e);
    if (e.message?.includes('UNIQUE')) return errorResponse('用户名或邮箱已被注册', 409);
    return errorResponse(e.message || '注册失败', 500);
  }
});

// POST /api/auth/login
router.post('/api/auth/login', async (request, env) => {
  try {
    const ip = getClientIp(request);
    const rl = await rateLimit(env, `login:${ip}`, 10, 600);
    if (!rl.allowed) return errorResponse('登录尝试过于频繁，请稍后再试', 429);

    const body = await safeJsonParse(request);
    if (!body) return errorResponse('请求格式错误');

    const { username, password } = body;
    if (!username || !password) return errorResponse('用户名和密码不能为空');

    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE username = ? OR email = ?'
    ).bind(username, username).first();

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH);
      return errorResponse('用户名或密码错误', 401);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return errorResponse('用户名或密码错误', 401);

    await env.DB.prepare(
      'UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(user.id).run();

    const token = await generateToken(user, env);

    return successResponse(
      {
        user: {
          id: user.id, username: user.username, email: user.email,
          avatar_url: user.avatar_url, bio: user.bio,
          introduction: user.introduction, website: user.website,
          is_admin: user.is_admin, created_at: user.created_at,
        },
        token,
      },
      '登录成功',
      { 'Set-Cookie': setAuthCookie(token) }
    );
  } catch (e) {
    console.error('登录错误:', e);
    return errorResponse(e.message || '登录失败', 500);
  }
});

// POST /api/auth/logout
router.post('/api/auth/logout', async () => {
  return successResponse(null, '已登出', { 'Set-Cookie': clearAuthCookie() });
});

// ==================== 个人资料 API ====================

// GET /api/auth/me - 当前用户完整资料
router.get('/api/auth/me', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('未登录', 401);

    const record = await env.DB.prepare(
      `SELECT id, username, email, avatar_url, bio, introduction, website,
              is_admin, created_at, last_login_at
       FROM users WHERE id = ?`
    ).bind(user.id).first();

    if (!record) return errorResponse('用户不存在', 404);
    return successResponse(record);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// PUT /api/auth/me - 更新个人资料
router.put('/api/auth/me', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('未登录', 401);

    const body = await safeJsonParse(request);
    if (!body) return errorResponse('请求格式错误');

    const { bio, introduction, website, avatar_url } = body;

    const stripTags = (str) =>
      sanitizeHtml(String(str), { allowedTags: [], allowedAttributes: {} });

    const sanitizedBio = bio !== undefined
      ? stripTags(String(bio)).substring(0, MAX_BIO_LENGTH) : null;
    const sanitizedIntro = introduction !== undefined
      ? stripTags(String(introduction)).substring(0, MAX_INTRO_LENGTH) : null;
    const sanitizedWebsite = website !== undefined
      ? stripTags(String(website)).substring(0, MAX_WEBSITE_LENGTH) : null;
    const sanitizedAvatar = avatar_url !== undefined
      ? stripTags(String(avatar_url)).substring(0, MAX_AVATAR_LENGTH) : null;

    await env.DB.prepare(
      `UPDATE users SET
        bio = COALESCE(?, bio),
        introduction = COALESCE(?, introduction),
        website = COALESCE(?, website),
        avatar_url = COALESCE(?, avatar_url)
       WHERE id = ?`
    ).bind(sanitizedBio, sanitizedIntro, sanitizedWebsite, sanitizedAvatar, user.id).run();

    return successResponse(null, '资料已更新');
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// POST /api/auth/change-password
router.post('/api/auth/change-password', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('未登录', 401);

    const body = await safeJsonParse(request);
    if (!body) return errorResponse('请求格式错误');

    const { old_password, new_password } = body;
    if (!old_password || !new_password) return errorResponse('请输入旧密码和新密码');
    if (new_password.length < PASSWORD_MIN_LENGTH) {
      return errorResponse(`新密码至少需要 ${PASSWORD_MIN_LENGTH} 位`);
    }

    const record = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id).first();
    if (!record) return errorResponse('用户不存在', 404);

    const valid = await bcrypt.compare(old_password, record.password_hash);
    if (!valid) return errorResponse('旧密码错误', 401);

    const new_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(new_hash, user.id).run();

    return successResponse(null, '密码已更新');
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// ==================== 文章 API ====================

router.get('/api/posts', async (request, env) => {
  try {
    const { results } = await env.DB.prepare(
      'SELECT * FROM posts ORDER BY created_at DESC'
    ).all();
    return successResponse(results);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

router.get('/api/posts/:id', async (request, env) => {
  try {
    const { id } = request.params;
    const record = await env.DB.prepare('SELECT * FROM posts WHERE id = ?')
      .bind(id).first();
    if (!record) return errorResponse('文章不存在', 404);
    return successResponse(record);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

router.get('/api/categories', async (request, env) => {
  try {
    const { results } = await env.DB.prepare(
      `SELECT category, COUNT(*) as count FROM posts GROUP BY category`
    ).all();
    return successResponse(results);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// ==================== 评论 API ====================

// GET /api/posts/:id/comments - 文章评论列表（公开）
router.get('/api/posts/:id/comments', async (request, env) => {
  try {
    const { id } = request.params;
    const { results } = await env.DB.prepare(
      `SELECT
         c.id, c.content, c.created_at, c.post_id, c.user_id,
         u.username, u.avatar_url, u.is_admin
       FROM comments c
       INNER JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ?
       ORDER BY c.created_at DESC`
    ).bind(id).all();

    return successResponse(results);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// POST /api/posts/:id/comments - 提交评论（需登录）
router.post('/api/posts/:id/comments', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('请先登录后再评论', 401);

    const { id } = request.params;
    const body = await safeJsonParse(request);
    if (!body) return errorResponse('请求格式错误');

    const { content } = body;
    if (!content || !String(content).trim()) return errorResponse('评论内容不能为空');
    if (String(content).length > COMMENT_MAX_LENGTH) {
      return errorResponse(`评论内容过长（最多 ${COMMENT_MAX_LENGTH} 字）`);
    }

    const rl = await rateLimit(env, `comment:${user.id}`, 3, 60);
    if (!rl.allowed) return errorResponse('评论过于频繁，请稍后再试', 429);

    const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?')
      .bind(id).first();
    if (!post) return errorResponse('文章不存在', 404);

    const sanitizedContent = sanitizeHtml(String(content).trim());

    await env.DB.prepare(
      'INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)'
    ).bind(id, user.id, sanitizedContent).run();

    return successResponse(null, '评论成功');
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// DELETE /api/comments/:id - 删除评论（仅本人或管理员）
router.delete('/api/comments/:id', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('请先登录', 401);

    const { id } = request.params;

    const comment = await env.DB.prepare('SELECT user_id FROM comments WHERE id = ?')
      .bind(id).first();
    if (!comment) return errorResponse('评论不存在', 404);

    if (comment.user_id !== user.id && !user.is_admin) {
      return errorResponse('无权删除此评论', 403);
    }

    await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();

    return successResponse(null, '评论已删除');
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// ==================== 用户公开 API ====================

// GET /api/users/:id - 公开用户资料（含自我介绍）
router.get('/api/users/:id', async (request, env) => {
  try {
    const { id } = request.params;
    if (!id || isNaN(id)) return errorResponse('无效的用户 ID', 400);

    const record = await env.DB.prepare(
      `SELECT id, username, avatar_url, bio, introduction, website, created_at
       FROM users WHERE id = ?`
    ).bind(id).first();

    if (!record) return errorResponse('用户不存在', 404);
    return successResponse(record);
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// GET /api/users/:id/comments - 用户的评论历史（公开）
router.get('/api/users/:id/comments', async (request, env) => {
  try {
    const { id } = request.params;
    if (!id || isNaN(id)) return errorResponse('无效的用户 ID', 400);

    const userExists = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(id).first();
    if (!userExists) return errorResponse('用户不存在', 404);

    const { page, limit, offset } = parsePagination(new URL(request.url));

    const totalResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM comments WHERE user_id = ?'
    ).bind(id).first();
    const total = totalResult.count;

    const { results } = await env.DB.prepare(
      `SELECT c.id, c.content, c.created_at, c.post_id,
              p.title as post_title, p.category as post_category
       FROM comments c
       INNER JOIN posts p ON c.post_id = p.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(id, limit, offset).all();

    return successResponse({
      items: results,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// GET /api/users/:id/stats - 用户统计（公开）
router.get('/api/users/:id/stats', async (request, env) => {
  try {
    const { id } = request.params;
    if (!id || isNaN(id)) return errorResponse('无效的用户 ID', 400);

    const userExists = await env.DB.prepare('SELECT id FROM users WHERE id = ?')
      .bind(id).first();
    if (!userExists) return errorResponse('用户不存在', 404);

    const commentCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM comments WHERE user_id = ?'
    ).bind(id).first();

    return successResponse({
      comment_count: commentCount.count,
    });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// ==================== 我的（鉴权）相关 API ====================

// GET /api/auth/me/comments - 我的评论历史
router.get('/api/auth/me/comments', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('未登录', 401);

    const { page, limit, offset } = parsePagination(new URL(request.url));

    const totalResult = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM comments WHERE user_id = ?'
    ).bind(user.id).first();
    const total = totalResult.count;

    const { results } = await env.DB.prepare(
      `SELECT c.id, c.content, c.created_at, c.post_id,
              p.title as post_title, p.category as post_category
       FROM comments c
       INNER JOIN posts p ON c.post_id = p.id
       WHERE c.user_id = ?
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`
    ).bind(user.id, limit, offset).all();

    return successResponse({
      items: results,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// GET /api/auth/me/stats - 我的统计
router.get('/api/auth/me/stats', async (request, env) => {
  try {
    const user = await getCurrentUser(request, env);
    if (!user) return errorResponse('未登录', 401);

    const commentCount = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM comments WHERE user_id = ?'
    ).bind(user.id).first();

    return successResponse({
      comment_count: commentCount.count,
    });
  } catch (e) {
    return errorResponse(e.message, 500);
  }
});

// ==================== 背景图代理（规避 CORS，解析最终图片 URL 供前端缓存到 localStorage） ====================
router.get('/api/bg', async (request) => {
  try {
    const url = new URL(request.url);
    const t = url.searchParams.get('t') === 'mp' ? 'mp' : 'pc';
    const api = t === 'mp' ? 'https://t.alcy.cc/mp' : 'https://t.alcy.cc/pc';
    const res = await fetch(api, { redirect: 'follow' });
    const finalUrl = res.url || api;
    return successResponse({ url: finalUrl });
  } catch (e) {
    return errorResponse('获取背景失败', 502);
  }
});

// ==================== 每日一句代理（页脚使用，规避浏览器 CORS） ====================
router.get('/api/sentence', async () => {
  try {
    const res = await fetch('https://api.fuchenboke.cn/api/wangyi.php');
    const text = await res.text();
    const clean = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 300);
    return new Response(clean || '以梦为马，不负韶华。', {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=UTF-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e) {
    return errorResponse('获取每日一句失败', 502);
  }
});

// ==================== 404 ====================
router.all('*', async (request) => {
  const url = new URL(request.url);
  return new Response(`页面未找到: ${url.pathname}`, {
    status: 404,
    headers: corsHeaders,
  });
});

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx),
};
