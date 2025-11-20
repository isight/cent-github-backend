import { Hono } from "hono";
import { cors } from "hono/cors";
import white_list from "../white_list";

type Bindings = {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITEE_CLIENT_ID: string;
	GITEE_CLIENT_SECRET: string;
};

const proxyRouter = new Hono<{ Bindings: Bindings }>();

/**
 * 3. **反向代理主逻辑**
 * app.all('*') 匹配所有 HTTP 方法和所有路径。
 *
 * 反向代理端点：允许将请求转发到指定的目标 URL
 * 支持 GET、POST、PUT、DELETE、PATCH 等多种 HTTP 方法
 * 支持 WebDAV 方法（PROPFIND、PROPPATCH、MKCOL、COPY、MOVE、LOCK、UNLOCK）
 */
proxyRouter.all("/proxy", async (c) => {
	const targetUrl = c.req.query("url");
	const overrideMethod = c.req.query("method"); // 新增：检测是否携带 method 参数

	if (!targetUrl) return c.text('Missing "url" query parameter.', 400);

	let url: URL;
	try {
		url = new URL(targetUrl);
	} catch {
		return c.text("Invalid target URL format.", 400);
	}

	// 获取请求头并移除不应被转发的字段
	const headers = new Headers(c.req.raw.headers);
	headers.delete("Origin");
	headers.delete("Host");

	// 读取请求体（仅对非 GET/HEAD 方法）
	let body: BodyInit | null = null;
	const method = (overrideMethod || c.req.method).toUpperCase();

	if (method !== "GET" && method !== "HEAD") {
		// 注意：即使 method 覆盖为 PROPFIND，也要允许 body
		body = await c.req.arrayBuffer();
	}

	// 发起实际的转发请求
	let response: Response;
	try {
		console.log("start proxy re-send:");
		response = await fetch(url.toString(), {
			method,
			headers,
			body,
			redirect: "follow",
		});
	} catch (e) {
		console.error("Fetch error:", e);
		return c.text(`Failed to fetch target URL: ${e}`, 502);
	}
	console.log("proxy re-send success");

	// 打印响应信息 (用于诊断 520)
	// 5. 诊断 520 错误的关键步骤：检查响应状态和头大小
	const responseStatus = response.status;
	let headerSize = 0;
	let responseHeadersString = "";

	// 遍历响应头，计算大小并记录
	for (const [key, value] of response.headers.entries()) {
		// 粗略计算头大小 (key + value + 冒号 + 换行)
		headerSize += key.length + value.length + 4;
		responseHeadersString += `${key}: ${value}, `;
	}
	console.log(
		`[Proxy Response] Status: ${responseStatus}, Headers Size: ${headerSize} bytes, Headers: ${responseHeadersString.slice(0, 500)}...`,
	);

	// 移除部分安全头，允许前端访问
	const modified = new Response(response.body, response);
	modified.headers.delete("Content-Security-Policy");
	modified.headers.delete("X-Frame-Options");
	modified.headers.delete("Access-Control-Allow-Origin");

	return modified;
});

proxyRouter.use(
	"*",
	cors({
		// 允许所有来源访问，这是实现 CORS 绕过的关键
		origin: white_list,
	}),
);

export default proxyRouter;
