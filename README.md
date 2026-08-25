### 一个基于 Cloudflare Workers + D1 数据库 + KV 存储构建的现代化个人博客系统。

## ✨ 实例页 [Sumeru](https://sumeru.ggff.net)
### ![预览](https://github.com/PJY1548/Sumeru/blob/main/preview.png)

## 🏗 第三放api引用
### 感谢[次元API](https://tc.alcy.cc/)提供随机背景
### 感谢[浮沉博客](https://www.fuchenboke.cn/)提供随机文案
### 第一文章封面采用[Bing每日一图]

## ✨ 功能特性

### 📝 文章系统
- Markdown 内容渲染（支持代码高亮）
- 文章分类与搜索
- 文章列表分页加载

### 👤 用户系统
- 用户注册 / 登录 / 登出（JWT + HttpOnly Cookie）
- 密码加密存储（bcrypt）
- 个人资料管理（头像、简介、自我介绍、个人网站）
- 修改密码
- 首个注册用户自动成为管理员

### 💬 评论系统
- 文章评论（需登录）
- 评论删除（本人或管理员）
- 评论分页加载
- 用户评论历史查看
- 评论频率限制

### 🎨 前端页面
- **首页** (`/`) - 文章展示、搜索、分类筛选
- **文章详情** (`/post/:id`) - Markdown 渲染、评论区
- **所有文章** (`/posts`) - 文章列表、排序、分类筛选
- **登录/注册** (`/login`) - 统一认证页面
- **个人中心** (`/profile`) - 个人资料编辑、我的评论、统计
- **用户主页** (`/u/:id`) - 公开用户资料、评论历史

### 🔧 技术特性
- **玻璃拟态 UI** - 统一的毛玻璃导航栏、卡片、页脚
- **响应式设计** - 移动端自适应，汉堡菜单
- **背景图代理** - 规避 CORS，支持每日一句
- **静态资源 KV 托管** - HTML 页面存储在 KV，边缘分发
- **速率限制** - 基于 KV 的 IP/用户级限流

## 🚀 快速开始(如出现错误请重试)

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Cloudflare 资源

创建 D1 数据库和 KV 命名空间：

```bash
# 创建 D1 数据库
wrangler d1 create DB

# 创建 KV 命名空间
wrangler kv:namespace create sumeru
```

将生成的 `database_id` 和 `id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "DB"
database_id = "your-database-id"

[[kv_namespaces]]
binding = "sumeru"
id = "your-kv-namespace-id"
```

### 3. 设置密钥

```bash
# 设置 JWT 密钥（必需）
wrangler secret put JWT_SECRET

# 可选：自定义 JWT 签发者
wrangler secret put JWT_ISSUER
```

### 4. 上传静态页面到 KV

```bash
npx wrangler kv:key put --binding=sumeru index.html --path=index.html
npx wrangler kv:key put --binding=sumeru login.html --path=login.html
npx wrangler kv:key put --binding=sumeru posts.html --path=posts.html
npx wrangler kv:key put --binding=sumeru post.html --path=post.html
npx wrangler kv:key put --binding=sumeru profile.html --path=profile.html
npx wrangler kv:key put --binding=sumeru user.html --path=user.html
```
或者可能是
```bash
npx wrangler kv key put index.html --path=index.html --binding=sumeru
npx wrangler kv key put login.html --path=index.html --binding=sumeru
npx wrangler kv key put posts.html --path=index.html --binding=sumeru
npx wrangler kv key put post.htmll --path=index.html --binding=sumeru
npx wrangler kv key put profile.html --path=index.html --binding=sumeru
npx wrangler kv key put user.html --path=index.html --binding=sumeru
```
或者[Cloudflare仪表盘](https://dash.cloudflare.com/)进行手动上传

### 6. 部署环境

```bash
# 部署到 Cloudflare Workers
npm run deploy
# 或
wrangler deploy
```
### 7.关于文章发布
前端没有设置发布入口，请前往
[Cloudflare仪表盘](https://dash.cloudflare.com/)/存储和数据库/D1 SQLite数据库/DB/探索数据/Posts
右键Open in Multi-Line Editor手动发布，支持markdown格式，发布时注意context有没有换行符。


## 📚 API 文档

### 认证相关

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | `/api/auth/register` | 用户注册 | 否 |
| POST | `/api/auth/login` | 用户登录 | 否 |
| POST | `/api/auth/logout` | 用户登出 | 是 |
| GET | `/api/auth/me` | 获取当前用户完整资料 | 是 |
| PUT | `/api/auth/me` | 更新个人资料 | 是 |
| POST | `/api/auth/change-password` | 修改密码 | 是 |

### 文章相关

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/posts` | 获取所有文章列表 | 否 |
| GET | `/api/posts/:id` | 获取单篇文章详情 | 否 |
| GET | `/api/categories` | 获取所有分类及文章数 | 否 |

### 评论相关

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/posts/:id/comments` | 获取文章评论列表 | 否 |
| POST | `/api/posts/:id/comments` | 提交评论 | 是 |
| DELETE | `/api/comments/:id` | 删除评论（本人/管理员） | 是 |

### 用户公开 API

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/users/:id` | 获取用户公开资料 | 否 |
| GET | `/api/users/:id/comments` | 获取用户评论历史 | 否 |
| GET | `/api/users/:id/stats` | 获取用户统计信息 | 否 |

### 我的（需登录）

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/auth/me/comments` | 我的评论历史 | 是 |
| GET | `/api/auth/me/stats` | 我的统计信息 | 是 |

### 工具类

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/bg` | 获取背景图 URL（支持 `?t=mp` 移动端） |
| GET | `/api/sentence` | 获取每日一句（页脚引用） |

## 🔐 环境变量

| 变量名 | 必需 | 说明 |
|--------|------|------|
| `JWT_SECRET` | ✅ | JWT 签名密钥（建议 32+ 字符随机串） |
| `JWT_ISSUER` | 否 | JWT 签发者，默认 `sumeru` |

## 🗄 数据库表结构

### users 表
```sql
CREATE TABLE users (
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
);
```

### posts 表
```sql
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### comments 表
```sql
CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 🎨 UI 规范

- **导航栏**：玻璃拟态、高度 60px、Logo 1.2rem、链接间距 1.5rem
- **容器宽度**：最大 1100px，居中
- **按钮**：主按钮蓝色圆角、次按钮描边
- **卡片**：白色半透明背景、毛玻璃模糊、圆角 14px
- **移动端**：≤768px 隐藏导航链接，显示汉堡菜单
- **配色**：主色 `#3b82f6`，文字 `#1e293b`/`#475569`/`#64748b`

## 🏗 技术栈

| 层级 | 技术 |
|------|------|
| **运行时** | Cloudflare Workers |
| **路由** | itty-router |
| **数据库** | Cloudflare D1 (SQLite) |
| **KV 存储** | Cloudflare KV (静态页面、速率限制) |
| **认证** | JWT (jose) + HttpOnly Cookie |
| **密码加密** | bcryptjs |
| **HTML 清洗** | sanitize-html |
| **Markdown** | marked + highlight.js |
| **部署工具** | Wrangler |

## 📝 许可证
GNU GENERAL PUBLIC LICENSE V3
