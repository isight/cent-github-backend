// 我正在使用cloudflare workers部署一个用户 github app 授权服务端流程，使用 nodejs和hono编写，假设目标环境已经包含如下环境变量：
// ```env
// GITHUB_CLIENT_SECRET=xxx
// GITHUB_CLIENT_ID=xxx
// ```

// ```typescript
// function encodeState(value: string): Promise<string>

// function decodeState(encryptedState: string): Promise<string>

// ```
// 并且提供了简易的加密方法 decodeState, encodeState ，请根据如下流程编写可用的授权程序，实现如下核心的登录接口：
// ```typescript
// app.get("/api/github-oauth/authorize")
// app.get("/api/github-oauth/authorized")
// ```

// 核心流程如下：
// 核心 GitHub App 登录/安装分流流程（Prompt 格式）
// 目标： 在用户登录时，通过服务器端点判断其 GitHub App 安装状态，实现新老用户分流。

// 核心流程提示词：

// 模式： GitHub App 授权/安装分流（服务器控制）

// 前置配置：

// GitHub App 授权回调 URL (Callback URL) = 服务器端点 (/api/github-oauth/authorized)。

// 取消勾选“安装时请求用户授权”。

// 步骤：

// 统一入口： 用户从客户端访问 (/api/github-oauth/authorize) 跳转至 GitHub OAuth 授权 URL (github.com/login/oauth/authorize)。

// 授权回调 (服务器端)： GitHub 重定向到服务器端点 (/api/github-oauth/authorized)，附带 code。

// 服务器操作（双重检查）： a. 获取 Token： 服务器使用 code 和保密的 client_secret 交换 User Access Token。 b. 检查安装： 服务器使用该 User Access Token 调用 GitHub API (/user/installations) 检查 App 是否已安装。

// 智能分流重定向：

// If 已安装 (老用户)： 服务器将 User Access Token 传给客户端，并重定向到应用首页 AFTER_LOGIN_URL。

// If 未安装 (新用户)： 服务器 302 重定向到 App 安装 URL (/apps/YOUR-APP-SLUG/installations/new)。

// 后续登录： 无论是分流后的首页还是完成安装后的重定向，客户端均使用获得的 User Access Token 建立前端会话。

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { encodeState, decodeState } from "./lib/state";
import white_list from "./white_list";

/**
 * 定义 Cloudflare Worker 的环境变量类型，确保类型安全。
 * 在 Cloudflare 控制台中必须设置 GITHUB_CLIENT_ID 和 GITHUB_CLIENT_SECRET。
 */
type Bindings = {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	// 如果使用 Worker KV 或其他绑定，请在此处添加
};

const app = new Hono<{ Bindings: Bindings }>();
app.use(
	"*",
	cors({
		// 允许所有来源访问，这是实现 CORS 绕过的关键
		origin: white_list,
		// 允许所有常见的 HTTP 方法
		allowMethods: [
			"GET",
			"POST",
			"PUT",
			"DELETE",
			"PATCH",
			"OPTIONS",
			"HEAD",
			// WebDAV 方法：
			"PROPFIND",
			"PROPPATCH",
			"MKCOL",
			"COPY",
			"MOVE",
			"LOCK",
			"UNLOCK",
			// 其他不常见但可能用到的方法：
			"TRACE",
			"CONNECT",
		],
		// 允许所有常见的请求头部
		// **关键修改点：确保 WebDAV 头部 'Depth' (以及 'Destination', 'If' 等) 被明确允许**
		allowHeaders: [
			// 标准头部
			"Content-Type",
			"Authorization",
			"X-Requested-With",
			// WebDAV 头部
			"Depth",
			"Destination",
			"If",
			"Accept-Encoding",
			// 建议：如果 WebDAV 客户端使用了其他自定义头部，也需要添加
		],
		// 浏览器缓存 CORS 预检结果的时间（秒）
		maxAge: 86400, // 24小时
	}),
);

// --- 配置常量 ---
// 警告：请务必将下面的值替换为您自己的 GitHub App 的实际信息！
const GITHUB_APP_SLUG = "cent-accounting";

const INVALID_REDIRECT_MSG =
	"redirect url not valid, see https://github.com/glink25/github-login?tab=readme-ov-file#%E5%A6%82%E4%BD%95%E4%BD%BF%E7%94%A8";
const isValidRedirect = (url: string) => {
	return white_list.some((v) => url.startsWith(v));
};

/**
 * 路由 1: /api/github-oauth/authorize
 * 描述: 这是用户授权的统一入口点。
 * 流程:
 * 1. 创建一个唯一的 state 值以防止 CSRF 攻击。
 * 2. 将 state 加密。
 * 3. 构建 GitHub OAuth URL 并将用户重定向过去。
 */
app.get("/api/github-oauth/authorize", async (c) => {
	const env = c.env as Record<string, string>;
	const { redirect_uri: appReturnUrl } = c.req.query();
	if (!appReturnUrl) {
		c.status(400);
		return c.json({ error: "`redirect_uri` is required." });
	}
	if (!isValidRedirect(appReturnUrl)) {
		c.status(400);
		return c.json({ error: INVALID_REDIRECT_MSG });
	}
	const statePayload = appReturnUrl;
	const state = await encodeState(statePayload, env.ENCRYPTION_SECRETS);

	const authUrl = new URL("https://github.com/login/oauth/authorize");
	authUrl.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	// GitHub App 规范要求 redirect_uri 在这里不是必须的，它会使用 App 设置中配置的回调 URL
	// authUrl.searchParams.set('redirect_uri', 'YOUR_CALLBACK_URL');
	authUrl.searchParams.set("state", state);
	// 对于检查安装状态，不需要特殊 scope，登录即可
	// authUrl.searchParams.set('scope', 'read:user');

	console.log("Redirecting user to GitHub for authorization...");
	return c.redirect(authUrl.toString());
});

/**
 * 路由 2: /api/github-oauth/authorized
 * 描述: 这是 GitHub 授权后的回调地址。
 * 流程:
 * 1. 从查询参数中获取 code 和 state。
 * 2. 验证 state 的有效性。
 * 3. 使用 code 向 GitHub 交换 User Access Token。
 * 4. 使用 Token 调用 GitHub API 检查用户是否已安装该 App。
 * 5. 根据安装状态，将用户智能分流到“应用首页”或“App 安装页”。
 */
app.get("/api/github-oauth/authorized", async (c) => {
	const env = c.env as Record<string, string>;
	const code = c.req.query("code");
	const state = c.req.query("state");
	// 步骤 1: 验证参数
	if (!code || !state) {
		throw new HTTPException(400, {
			message: 'Missing "code" or "state" query parameter.',
		});
	}
	let appReturnUrl: string;
	try {
		appReturnUrl = await decodeState(state, env.ENCRYPTION_SECRETS);
		console.log("State validation successful.");
	} catch (err: any) {
		console.error("Invalid state received:", err);
		throw new HTTPException(400, { message: err.message });
	}

	if (!isValidRedirect(appReturnUrl)) {
		throw new HTTPException(400, { message: INVALID_REDIRECT_MSG });
	}
	const returnUrl = new URL(appReturnUrl);

	// 步骤 3: 使用 code 交换 Access Token
	console.log("Exchanging code for access token...");
	const tokenResponse = await fetch(
		"https://github.com/login/oauth/access_token",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: c.env.GITHUB_CLIENT_ID,
				client_secret: c.env.GITHUB_CLIENT_SECRET,
				code: code,
			}),
		},
	);

	if (!tokenResponse.ok) {
		const errorBody = await tokenResponse.text();
		console.error("Failed to get access token:", errorBody);
		throw new HTTPException(500, {
			message: "Failed to exchange code for access token.",
		});
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		error?: string;
	};

	if (tokenData.error || !tokenData.access_token) {
		console.error("Error in token response from GitHub:", tokenData);
		throw new HTTPException(400, {
			message: `GitHub returned an error: ${tokenData.error}`,
		});
	}

	const accessToken = tokenData.access_token;
	console.log("Successfully obtained access token.");

	// 步骤 4: 检查用户 App 安装状态
	console.log("Checking user installation status...");
	const installationsResponse = await fetch(
		"https://api.github.com/user/installations",
		{
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/vnd.github.v3+json",
				"User-Agent": `${GITHUB_APP_SLUG} (Cloudflare Worker)`, // 推荐设置 User-Agent
			},
		},
	);

	if (!installationsResponse.ok) {
		const errorBody = await installationsResponse.text();
		console.error("Failed to fetch user installations:", errorBody);
		throw new HTTPException(500, {
			message: "Failed to check app installation status.",
		});
	}

	const installationsData = (await installationsResponse.json()) as {
		total_count: number;
		installations: any[];
	};

	// 步骤 5: 智能分流
	if (
		installationsData.total_count > 0 &&
		installationsData.installations.length > 0
	) {
		// 情况 A: 已安装 App (老用户)
		console.log("User has installed the app. Redirecting to dashboard.");
		const redirectUrl = returnUrl;
		// 将 token 作为参数传递给前端，前端需要实现接收逻辑
		redirectUrl.searchParams.set(
			"github_authorized",
			JSON.stringify(tokenData),
		);
		return c.redirect(redirectUrl.toString());
	} else {
		// 情况 B: 未安装 App (新用户)
		console.log(
			"User has not installed the app. Redirecting to installation page.",
		);
		const installUrl = new URL(
			`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`,
		);
		installUrl.searchParams.set("state", state);
		return c.redirect(installUrl);
	}
});

/**
 * 刷新 github token
 */
app.post("/api/github-oauth/refresh-token", async (c) => {
	const body = await c.req.json();
	const refreshToken = body.refreshToken;
	if (!refreshToken) {
		throw new HTTPException(500, {
			message: "invalid refresh token.",
		});
	}
	const tokenResponse = await fetch(
		"https://github.com/login/oauth/access_token",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: c.env.GITHUB_CLIENT_ID,
				client_secret: c.env.GITHUB_CLIENT_SECRET,
				grant_type: "refresh_token",
				refresh_token: refreshToken,
			}),
		},
	);
	if (!tokenResponse.ok) {
		const errorBody = await tokenResponse.text();
		console.error("Failed to get access token:", errorBody);
		throw new HTTPException(500, {
			message: "Failed to exchange code for access token.",
		});
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		error?: string;
	};

	if (tokenData.error || !tokenData.access_token) {
		console.error("Error in token response from GitHub:", tokenData);
		throw new HTTPException(400, {
			message: `GitHub returned an error: ${tokenData.error}`,
		});
	}
	return c.json(tokenData);
});

// 2. **反向代理主逻辑**
// app.all('*') 匹配所有 HTTP 方法和所有路径。
app.all("/proxy", async (c) => {
	// 从 URL 查询参数中获取目标网址
	const targetUrl = c.req.query("url");

	if (!targetUrl) {
		// 如果没有提供目标 URL，返回错误信息
		return c.text(
			'Missing "url" query parameter. Usage: /proxy?url=https://example.com/api',
			400,
		);
	}

	let url: URL;
	try {
		url = new URL(targetUrl);
	} catch (e) {
		// 目标 URL 格式不正确
		return c.text("Invalid target URL format.", 400);
	}

	// 可选：安全检查 - 确保只代理到特定的白名单域名
	// if (!url.hostname.endsWith('example.com')) {
	//     return c.text('Target domain not allowed.', 403);
	// }

	// 3. **构造转发请求**
	// 使用 c.req.raw 获取原始 Request 对象，body需要clone。
	// Request 对象的 Headers 是只读的，但我们可以通过 new Request() 克隆并修改它。

	// **注意：** Cloudflare Workers 默认会设置/修改一些头部，例如：
	// - Host 头部会被自动设置为目标 URL 的 Host
	// - Connection、Keep-Alive 等不应被转发的头部会被移除
	//
	// 此外，为了避免某些服务器因原始请求中的 Origin 头部而拒绝请求，
	// 我们可以选择移除或修改它。由于 Workers 在发送请求时将成为“同源”，
	// 很多情况下可以直接删除 Origin 头部。

	const requestHeaders = new Headers(c.req.raw.headers);
	// 移除 Origin 头部，以防止目标服务器看到跨域请求的标志
	requestHeaders.delete("Origin");
	// 移除 Host 头部，fetch 会自动根据目标 URL 设置正确的 Host
	requestHeaders.delete("Host");

	let body: BodyInit | null = null;
	if (c.req.method !== "GET" && c.req.method !== "HEAD") {
		body = await c.req.arrayBuffer();
	}
	const proxyRequest = new Request(url.toString(), {
		method: c.req.method,
		headers: requestHeaders,
		body, // 转发请求体
		redirect: "follow", // 遵循重定向
		// 其他请求初始化选项...
	});

	let response: Response;
	try {
		// 4. **发起请求到目标网址**
		response = await fetch(proxyRequest);
	} catch (e) {
		console.error("Fetch error:", e);
		return c.text(
			`Failed to fetch target URL: ${e instanceof Error ? e.message : "Unknown error"}`,
			502,
		);
	}

	// 5. **返回响应并添加 CORS 头部**
	// **重要：** 必须克隆响应对象以修改其头部，Cloudflare Workers 中的 Response 头部默认是不可变的。
	const modifiedResponse = new Response(response.body, response);

	// **注意：** // 由于我们在 Hono 的 app.use('*', cors()) 中已经配置了 CORS 头部，
	// Hono 会自动处理 OPTIONS 预检请求并为所有响应添加 Access-Control-Allow-Origin 等头部。
	// 因此，通常不需要手动再次添加 CORS 头部。

	// 如果想要确保万无一失，可以手动添加（但 Hono 应该已经处理了）：
	// modifiedResponse.headers.set('Access-Control-Allow-Origin', '*');
	// modifiedResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
	// modifiedResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

	// 移除可能阻止响应的头部（例如内容安全策略 CSP）
	modifiedResponse.headers.delete("Content-Security-Policy");
	modifiedResponse.headers.delete("X-Content-Security-Policy");
	modifiedResponse.headers.delete("X-Frame-Options");

	// 移除目标服务器设置的 CORS 头部（如果存在，Workers 会覆盖）
	modifiedResponse.headers.delete("Access-Control-Allow-Origin");

	return modifiedResponse;
});

export default app;
