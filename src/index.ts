import { Hono } from "hono";
import { cors } from "hono/cors";

import { decodeState, encodeState } from "./lib/state";
import WHITE_LIST from "./white_list";
import { generateAESPassword } from "./lib/encryption";

const app = new Hono();

const GITHUB_OAUTH_ACCESS_TOKEN_URL =
	"https://github.com/login/oauth/access_token";
const TOKEN_VALIDITY_PERIOD = 1000 * 60 * 60 * 24 * 365; // 1 year;

const GITHUB_OAUTH_AUTHORIZE_URL =
	"https://github.com/apps/oncent-accounting/installations/new/permissions?target_id=49364151&target_type=User";

// app.get('/', (c) => {
// 	// 密钥长度（字节）: 32 字节等于 256 位
// 	const password = generateAESPassword(32);
// 	console.log('new password:', password);
// 	return c.text('Hello Hono!');
// });
const INVALID_REDIRECT_MSG =
	"redirect url not valid, see https://github.com/glink25/github-login?tab=readme-ov-file#%E5%A6%82%E4%BD%95%E4%BD%BF%E7%94%A8";
const isValidRedirect = (url: string) => {
	return WHITE_LIST.some((v) => url.startsWith(v));
};

app.use("/*", cors());

app.get("/api/oauth/authorize", async (c) => {
	const { redirect_uri: appReturnUrl } = c.req.query();
	if (!appReturnUrl) {
		c.status(400);
		return c.json({ error: "`redirect_uri` is required." });
	}
	if (!isValidRedirect(appReturnUrl)) {
		c.status(400);
		return c.json({ error: INVALID_REDIRECT_MSG });
	}
	const env = c.env as Record<string, string>;
	const { GITHUB_CLIENT_ID } = env;
	const headers = c.req.header();
	const proto = headers["x-forwarded-proto"] || "http";
	const redirect_uri = `${proto}://${headers.host}/api/oauth/authorized`;
	const state = await encodeState(appReturnUrl, env.ENCRYPTION_SECRETS);

	const oauthParams = new URLSearchParams({
		client_id: GITHUB_CLIENT_ID,
		redirect_uri,
		state,
	});
	return c.redirect(`${GITHUB_OAUTH_AUTHORIZE_URL}?${oauthParams}`, 302);
});

app.get("/api/oauth/authorized", async (c) => {
	const { code, state, error } = c.req.query() as Record<string, string>;
	const env = c.env as Record<string, string>;
	const {
		GITHUB_CLIENT_ID: client_id,
		GITHUB_CLIENT_SECRET: client_secret,
		ENCRYPTION_SECRETS: encryption_password,
	} = env;

	let appReturnUrl: string;
	try {
		appReturnUrl = await decodeState(state, encryption_password);
	} catch (err: any) {
		c.status(400);
		return c.json({ error: err.message });
	}

	if (!isValidRedirect(appReturnUrl)) {
		c.status(400);
		return c.json({ error: INVALID_REDIRECT_MSG });
	}
	const returnUrl = new URL(appReturnUrl);

	if (error) {
		const rUrl = new URL(appReturnUrl);
		rUrl.searchParams.set("error", error);
		return c.redirect(returnUrl.href, 302);
	}

	if (!code || !state) {
		c.status(400);
		return c.json({ error: "`code` and `state` are required." });
	}

	const init = {
		method: "POST",
		body: JSON.stringify({ client_id, client_secret, code, state }),
		headers: {
			"content-type": "application/json",
			Accept: "application/json",
			"User-Agent": "urodele-blog",
		},
	};

	let loginData: Record<string, string>;
	try {
		const response = await fetch(GITHUB_OAUTH_ACCESS_TOKEN_URL, init);
		if (response.ok) {
			const data: any = await response.json();
			loginData = data;
		} else {
			console.error(response);
			throw new Error(`Access token response had status ${response.status}.`);
		}
	} catch (err: any) {
		c.status(503);
		return c.json({ error: err.message });
	}

	const accessToken = loginData.access_token;
	const refreshToken = loginData.refresh_token;
	const [accessSession, refreshSession] = await Promise.all(
		[accessToken, refreshToken].map((token) =>
			encodeState(
				token,
				encryption_password,
				Date.now() + TOKEN_VALIDITY_PERIOD,
			),
		),
	);
	returnUrl.searchParams.set("accessSession", accessSession);
	returnUrl.searchParams.set("refreshSession", refreshSession);
	return c.redirect(returnUrl.href, 302);
});

app.post("/api/oauth/token", async (c) => {
	const { session } = (await c.req.json()) as any;
	if (!session) {
		c.status(400);
		return c.json({ error: "Unable to parse request body." });
	}
	const env = c.env as Record<string, string>;
	const { ENCRYPTION_SECRETS: encryption_password } = env;
	let token: string;
	try {
		token = await decodeState(session, encryption_password);
	} catch (err: any) {
		c.status(400);
		return c.json({ error: err.message });
	}

	c.status(200);
	return c.json({ token });
});

export default app;
