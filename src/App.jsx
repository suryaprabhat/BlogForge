import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Edit3,
  Flame,
  LogOut,
  MessageCircle,
  PenLine,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Avatar } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Separator } from "./components/ui/separator";
import { Textarea } from "./components/ui/textarea";
import { apiRequest, getStoredToken, storeToken } from "./lib/api";
import { cn, formatDate, readTime } from "./lib/utils";

const emptyDraft = {
  title: "",
  excerpt: "",
  content: "",
  category: "Culture",
  coverTheme: "ember",
};

const coverThemes = ["ember", "violet", "mint", "sky", "sunset"];

function App() {
  const [user, setUser] = useState(null);
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({
    name: "",
    email: "demo@blogforge.test",
    password: "DemoPass123!",
  });
  const [authLoading, setAuthLoading] = useState(true);
  const [posts, setPosts] = useState([]);
  const [categories, setCategories] = useState(["All"]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [selectedPost, setSelectedPost] = useState(null);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [loadingPost, setLoadingPost] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [view, setView] = useState("all");
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [comment, setComment] = useState("");
  const [toast, setToast] = useState(null);

  const postStats = useMemo(() => {
    const comments = posts.reduce((total, post) => total + Number(post.commentCount || 0), 0);
    const authors = new Set(posts.map((post) => post.author.id)).size;
    return { posts: posts.length, comments, authors };
  }, [posts]);

  useEffect(() => {
    async function loadUser() {
      if (!getStoredToken()) {
        setAuthLoading(false);
        return;
      }

      try {
        const data = await apiRequest("/api/auth/me");
        setUser(data.user);
      } catch {
        setUser(null);
      } finally {
        setAuthLoading(false);
      }
    }

    loadUser();
  }, []);

  useEffect(() => {
    loadPosts();
  }, [search, category, view, user?.id]);

  useEffect(() => {
    if (!selectedSlug) {
      setSelectedPost(null);
      return;
    }

    async function loadPost() {
      setLoadingPost(true);
      try {
        const data = await apiRequest(`/api/posts/${encodeURIComponent(selectedSlug)}`);
        setSelectedPost(data.post);
      } catch (error) {
        showToast(error.message, "error");
      } finally {
        setLoadingPost(false);
      }
    }

    loadPost();
  }, [selectedSlug]);

  function showToast(message, type = "success") {
    setToast({ message, type });
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(null), 3200);
  }

  async function loadPosts(preferredSlug = selectedSlug) {
    setLoadingPosts(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) {
        params.set("search", search.trim());
      }
      if (category !== "All") {
        params.set("category", category);
      }
      if (view === "mine") {
        params.set("mine", "true");
      }

      const query = params.toString();
      const data = await apiRequest(`/api/posts${query ? `?${query}` : ""}`);
      const nextPosts = data.posts || [];
      setPosts(nextPosts);
      setCategories(["All", ...(data.categories || [])]);

      const currentStillVisible = nextPosts.some((post) => post.slug === preferredSlug);
      if (nextPosts.length && (!preferredSlug || !currentStillVisible)) {
        setSelectedSlug(nextPosts[0].slug);
      }
      if (!nextPosts.length) {
        setSelectedSlug("");
      }
    } catch (error) {
      showToast(error.message, "error");
      if (view === "mine") {
        setView("all");
      }
    } finally {
      setLoadingPosts(false);
    }
  }

  async function handleAuth(event) {
    event.preventDefault();
    setAuthLoading(true);

    try {
      const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = authMode === "login"
        ? { email: authForm.email, password: authForm.password }
        : authForm;
      const data = await apiRequest(endpoint, { method: "POST", body: payload });

      storeToken(data.token);
      setUser(data.user);
      showToast(authMode === "login" ? "Welcome back." : "Account created.");
      await loadPosts();
    } catch (error) {
      showToast(error.message, "error");
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await apiRequest("/api/auth/logout", { method: "POST" });
    } catch {
      // Logging out should still clear local session state if the request is interrupted.
    }

    storeToken(null);
    setUser(null);
    setView("all");
    setEditingId(null);
    setDraft(emptyDraft);
    showToast("Signed out.");
  }

  async function handleSavePost(event) {
    event.preventDefault();
    const method = editingId ? "PATCH" : "POST";
    const endpoint = editingId ? `/api/posts/${editingId}` : "/api/posts";

    try {
      const data = await apiRequest(endpoint, { method, body: draft });
      setEditingId(null);
      setDraft(emptyDraft);
      setSelectedSlug(data.post.slug);
      showToast(editingId ? "Post updated." : "Post published.");
      await loadPosts(data.post.slug);
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function startEditing(post) {
    setEditingId(post.id);
    setDraft({
      title: post.title,
      excerpt: post.excerpt,
      content: post.content,
      category: post.category,
      coverTheme: post.coverTheme,
    });
    document.getElementById("composer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deletePost(post) {
    const ok = window.confirm(`Delete "${post.title}"?`);
    if (!ok) {
      return;
    }

    try {
      await apiRequest(`/api/posts/${post.id}`, { method: "DELETE" });
      showToast("Post deleted.");
      await loadPosts("");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function submitComment(event) {
    event.preventDefault();
    if (!selectedPost) {
      return;
    }

    try {
      const data = await apiRequest(`/api/posts/${selectedPost.id}/comments`, {
        method: "POST",
        body: { body: comment },
      });
      setSelectedPost((post) => ({
        ...post,
        comments: [...post.comments, data.comment],
        commentCount: post.commentCount + 1,
      }));
      setPosts((items) =>
        items.map((item) =>
          item.id === selectedPost.id ? { ...item, commentCount: item.commentCount + 1 } : item,
        ),
      );
      setComment("");
      showToast("Comment added.");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  async function deleteComment(commentId) {
    try {
      await apiRequest(`/api/comments/${commentId}`, { method: "DELETE" });
      setSelectedPost((post) => ({
        ...post,
        comments: post.comments.filter((item) => item.id !== commentId),
        commentCount: Math.max(0, post.commentCount - 1),
      }));
      setPosts((items) =>
        items.map((item) =>
          item.id === selectedPost.id ? { ...item, commentCount: Math.max(0, item.commentCount - 1) } : item,
        ),
      );
      showToast("Comment removed.");
    } catch (error) {
      showToast(error.message, "error");
    }
  }

  function updateDraft(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  const canEditSelected = user && selectedPost?.author.id === user.id;

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="BlogForge home">
          <span className="brand-mark">
            <PenLine size={20} />
          </span>
          <span>
            <strong>BlogForge</strong>
            <small>Posts and comments</small>
          </span>
        </a>

        <div className="top-search">
          <Search size={18} />
          <Input
            aria-label="Search posts"
            placeholder="Search posts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="account-area">
          {user ? (
            <>
              <Avatar name={user.name} />
              <span className="account-name">{user.name}</span>
              <Button variant="ghost" size="icon" onClick={handleLogout} aria-label="Log out">
                <LogOut size={18} />
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => document.getElementById("auth")?.scrollIntoView({ behavior: "smooth" })}>
              <UserPlus size={17} />
              Sign in
            </Button>
          )}
        </div>
      </header>

      <main className="page-shell" id="top">
        <section className="intro-band">
          <div className="intro-copy">
            <Badge variant="accent">
              <ShieldCheck size={14} />
              Editorial workspace
            </Badge>
            <h1>Blog Platform with Comments</h1>
            <p>
              A focused place for sharp posts, thoughtful replies, and calm author workflows.
            </p>
            <div className="intro-actions">
              <Button onClick={() => document.getElementById(user ? "composer" : "auth")?.scrollIntoView({ behavior: "smooth" })}>
                <Plus size={18} />
                New post
              </Button>
              <Button variant="secondary" onClick={() => setView(view === "mine" ? "all" : "mine")} disabled={!user}>
                <BookOpen size={18} />
                My posts
              </Button>
            </div>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="visual-card visual-card-main">
              <span />
              <strong>Drafts</strong>
              <small>Ready to publish</small>
            </div>
            <div className="visual-card visual-card-thread">
              <MessageCircle size={18} />
              <strong>{postStats.comments}</strong>
              <small>Comments</small>
            </div>
            <div className="visual-card visual-card-secure">
              <ShieldCheck size={18} />
              <strong>Accounts</strong>
              <small>Protected</small>
            </div>
          </div>
        </section>

        <section className="toolbar">
          <div className="segmented" aria-label="Post view">
            <Button variant={view === "all" ? "default" : "ghost"} size="sm" onClick={() => setView("all")}>
              Discover
            </Button>
            <Button
              variant={view === "mine" ? "default" : "ghost"}
              size="sm"
              onClick={() => setView("mine")}
              disabled={!user}
            >
              Mine
            </Button>
          </div>

          <div className="category-strip" aria-label="Categories">
            {categories.map((item) => (
              <Button
                key={item}
                variant={category === item ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setCategory(item)}
              >
                {item}
              </Button>
            ))}
          </div>
        </section>

        <section className="app-grid">
          <aside className="left-rail">
            {user ? (
              <Composer
                draft={draft}
                editingId={editingId}
                categories={categories.filter((item) => item !== "All")}
                onChange={updateDraft}
                onSubmit={handleSavePost}
                onCancel={() => {
                  setEditingId(null);
                  setDraft(emptyDraft);
                }}
              />
            ) : (
              <AuthPanel
                mode={authMode}
                setMode={setAuthMode}
                form={authForm}
                setForm={setAuthForm}
                loading={authLoading}
                onSubmit={handleAuth}
              />
            )}

            <section className="metric-panel" aria-label="Platform metrics">
              <Metric icon={<BookOpen size={18} />} label="Posts" value={postStats.posts} />
              <Metric icon={<MessageCircle size={18} />} label="Comments" value={postStats.comments} />
              <Metric icon={<Flame size={18} />} label="Authors" value={postStats.authors} />
            </section>
          </aside>

          <section className="feed-column" aria-label="Post feed">
            <div className="section-heading">
              <div>
                <p>Latest</p>
                <h2>{view === "mine" ? "Your posts" : "Published posts"}</h2>
              </div>
              <Badge variant="muted">{posts.length} shown</Badge>
            </div>

            {loadingPosts ? (
              <div className="loading-stack">
                <div />
                <div />
                <div />
              </div>
            ) : posts.length ? (
              <div className="post-list">
                {posts.map((post) => (
                  <PostCard
                    key={post.id}
                    post={post}
                    active={selectedPost?.id === post.id}
                    canEdit={user?.id === post.author.id}
                    onSelect={() => setSelectedSlug(post.slug)}
                    onEdit={() => startEditing(post)}
                    onDelete={() => deletePost(post)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState user={user} />
            )}
          </section>

          <aside className="reader-column" aria-label="Selected post">
            <Reader
              post={selectedPost}
              loading={loadingPost}
              user={user}
              canEdit={canEditSelected}
              comment={comment}
              setComment={setComment}
              onEdit={() => startEditing(selectedPost)}
              onDelete={() => deletePost(selectedPost)}
              onSubmitComment={submitComment}
              onDeleteComment={deleteComment}
            />
          </aside>
        </section>
      </main>

      {toast ? <div className={cn("toast", `toast-${toast.type}`)}>{toast.message}</div> : null}
    </div>
  );
}

function AuthPanel({ mode, setMode, form, setForm, loading, onSubmit }) {
  return (
    <Card id="auth" className="auth-card">
      <CardHeader>
        <CardTitle>{mode === "login" ? "Welcome back" : "Create account"}</CardTitle>
        <CardDescription>Demo access is ready to try.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="segmented full">
          <Button variant={mode === "login" ? "default" : "ghost"} size="sm" onClick={() => setMode("login")}>
            Sign in
          </Button>
          <Button variant={mode === "register" ? "default" : "ghost"} size="sm" onClick={() => setMode("register")}>
            Register
          </Button>
        </div>

        <form className="form-stack" onSubmit={onSubmit}>
          {mode === "register" ? (
            <Field label="Name">
              <Input
                required
                minLength={2}
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Alex Rivera"
              />
            </Field>
          ) : null}

          <Field label="Email">
            <Input
              required
              type="email"
              value={form.email}
              onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
              placeholder="you@example.com"
            />
          </Field>

          <Field label="Password">
            <Input
              required
              minLength={8}
              type="password"
              value={form.password}
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="At least 8 characters"
            />
          </Field>

          <Button type="submit" className="full-width" disabled={loading}>
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Composer({ draft, editingId, categories, onChange, onSubmit, onCancel }) {
  return (
    <Card id="composer" className="composer-card">
      <CardHeader>
        <CardTitle>{editingId ? "Edit post" : "Create post"}</CardTitle>
        <CardDescription>{editingId ? "Refine the story and keep the thread moving." : "Publish a new idea for readers."}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="form-stack" onSubmit={onSubmit}>
          <Field label="Title">
            <Input
              required
              minLength={4}
              value={draft.title}
              onChange={(event) => onChange("title", event.target.value)}
              placeholder="A sharp title"
            />
          </Field>

          <div className="form-row">
            <Field label="Category">
              <select
                className="ui-input"
                value={draft.category}
                onChange={(event) => onChange("category", event.target.value)}
              >
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cover">
              <div className="swatches">
                {coverThemes.map((theme) => (
                  <button
                    type="button"
                    key={theme}
                    className={cn("swatch", `theme-${theme}`, draft.coverTheme === theme && "active")}
                    onClick={() => onChange("coverTheme", theme)}
                    aria-label={`Use ${theme} cover`}
                  />
                ))}
              </div>
            </Field>
          </div>

          <Field label="Excerpt">
            <Textarea
              rows={3}
              value={draft.excerpt}
              onChange={(event) => onChange("excerpt", event.target.value)}
              placeholder="A concise hook for the feed"
            />
          </Field>

          <Field label="Content">
            <Textarea
              required
              minLength={20}
              rows={8}
              value={draft.content}
              onChange={(event) => onChange("content", event.target.value)}
              placeholder="Write the full post..."
            />
          </Field>

          <div className="form-actions">
            {editingId ? (
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit">
              <Send size={17} />
              {editingId ? "Save changes" : "Publish"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PostCard({ post, active, canEdit, onSelect, onEdit, onDelete }) {
  return (
    <Card className={cn("post-card", active && "active")} onClick={onSelect}>
      <div className={cn("post-cover", `theme-${post.coverTheme}`)}>
        <Badge variant="glass">{post.category}</Badge>
      </div>
      <CardHeader>
        <div className="post-meta">
          <Avatar name={post.author.name} />
          <span>{post.author.name}</span>
          <span>{formatDate(post.updatedAt)}</span>
        </div>
        <CardTitle>{post.title}</CardTitle>
        <CardDescription>{post.excerpt}</CardDescription>
      </CardHeader>
      <CardFooter>
        <span className="inline-stat">
          <MessageCircle size={16} />
          {post.commentCount}
        </span>
        <span className="inline-stat">{readTime(post.content)}</span>
        {canEdit ? (
          <span className="card-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Edit post"
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
            >
              <Edit3 size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete post"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 size={16} />
            </Button>
          </span>
        ) : null}
      </CardFooter>
    </Card>
  );
}

function Reader({
  post,
  loading,
  user,
  canEdit,
  comment,
  setComment,
  onEdit,
  onDelete,
  onSubmitComment,
  onDeleteComment,
}) {
  if (loading) {
    return (
      <Card className="reader-card">
        <CardContent>
          <div className="loading-reader" />
        </CardContent>
      </Card>
    );
  }

  if (!post) {
    return (
      <Card className="reader-card empty-reader">
        <CardContent>
          <BookOpen size={28} />
          <h2>No post selected</h2>
          <p>Published posts will appear here once they match your filters.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="reader-card">
      <div className={cn("reader-cover", `theme-${post.coverTheme}`)}>
        <Badge variant="glass">{post.category}</Badge>
      </div>
      <CardHeader>
        <div className="reader-kicker">
          <span>{formatDate(post.updatedAt)}</span>
          <span>{readTime(post.content)}</span>
          <span>{post.commentCount} comments</span>
        </div>
        <CardTitle>{post.title}</CardTitle>
        <CardDescription>{post.excerpt}</CardDescription>
        <div className="reader-author">
          <Avatar name={post.author.name} />
          <div>
            <strong>{post.author.name}</strong>
            <span>{post.author.email}</span>
          </div>
          {canEdit ? (
            <div className="reader-actions">
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Edit3 size={15} />
                Edit
              </Button>
              <Button variant="destructive" size="sm" onClick={onDelete}>
                <Trash2 size={15} />
                Delete
              </Button>
            </div>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <article className="post-body">
          {post.content.split(/\n+/).map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </article>

        <Separator />

        <section className="comments-block">
          <div className="comments-heading">
            <div>
              <p>Conversation</p>
              <h3>{post.comments.length} comments</h3>
            </div>
            <MessageCircle size={20} />
          </div>

          {user ? (
            <form className="comment-form" onSubmit={onSubmitComment}>
              <Avatar name={user.name} />
              <Textarea
                required
                minLength={2}
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Add to the discussion"
              />
              <Button type="submit" size="icon" aria-label="Post comment">
                <Send size={17} />
              </Button>
            </form>
          ) : (
            <div className="signin-note">
              <ShieldCheck size={18} />
              Sign in to join the conversation.
            </div>
          )}

          <div className="comment-list">
            {post.comments.map((item) => {
              const canDelete = user && (user.id === item.author.id || user.id === post.author.id);
              return (
                <div className="comment-item" key={item.id}>
                  <Avatar name={item.author.name} />
                  <div>
                    <div className="comment-meta">
                      <strong>{item.author.name}</strong>
                      <span>{formatDate(item.createdAt)}</span>
                      {canDelete ? (
                        <Button variant="ghost" size="icon" onClick={() => onDeleteComment(item.id)} aria-label="Delete comment">
                          <Trash2 size={14} />
                        </Button>
                      ) : null}
                    </div>
                    <p>{item.body}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function EmptyState({ user }) {
  return (
    <Card className="empty-state">
      <CardContent>
        <CheckCircle2 size={30} />
        <h2>{user ? "Your workspace is clear" : "No posts match this view"}</h2>
        <p>{user ? "Start a post from the composer." : "Try another search or category."}</p>
      </CardContent>
    </Card>
  );
}

function Metric({ icon, label, value }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <Label>
      <span>{label}</span>
      {children}
    </Label>
  );
}

export default App;
