# 客户端：自定义 scheme 登录与 `sign` 参数

本文说明在 **`redirect_uri` 不以 `http://` 或 `https://` 开头**（例如 `dailycent://auth/callback`）时，如何生成 `sign` 并调用本服务的 OAuth 授权入口。

## 何时需要 `sign`

| `redirect_uri` | 是否需要 `sign` |
|----------------|------------------|
| 以 `http://` 或 `https://` 开头（大小写不敏感） | 否 |
| 自定义 URL scheme（如 `dailycent://...`）或其它非上述形式 | **是**，且服务端需配置 `SIGN_SECRETS` |

此外，`redirect_uri` 仍须与服务端 [白名单前缀](../src/white_list.ts) 匹配，否则返回 400。

## 密钥说明

- **`SIGN_SECRETS`**：与你在 Worker 环境（如 `wrangler secret put SIGN_SECRETS` 或本地 `.dev.vars`）中配置的字符串**完全一致**。客户端用其加密时间戳；服务端用其解密并校验时间窗口。
- **`ENCRYPTION_SECRETS`**：仅服务端用于 OAuth `state` 加解密，**客户端不应持有**，也无需参与 `sign` 的生成。

> 安全提示：任何内置在 App / 前端包中的密钥都可能被逆向提取。`sign` 用于降低任意第三方随意滥用自定义 scheme 入口的风险；若需更高安全级别，应改为由你们自有后端代签或短期票据。

## `sign` 的语义与格式

1. **明文**：当前 UTC 毫秒时间戳的十进制字符串，与 JavaScript `String(Date.now())` 一致（例如 `"1735689600000"`）。
2. **算法**：AES-128-GCM（密钥由 `SHA-256(SIGN_SECRETS 的 UTF-8 字节)` 的前 32 字节作为 `raw` 导入；与仓库内 `aesGcmEncrypt` 一致）。
3. **IV**：12 字节随机数。
4. **密文字符串**：`ivHex24` + `base64(ciphertextBytes 按字节序拼接成的「二进制字符串」)`，即共 **24 个十六进制字符**（表示 12 字节 IV）紧跟 **Base64**，中间无分隔符。与调用登录接口时服务端对 `state` 使用的封装相同。

生成后作为查询参数 **`sign`** 原样传递；若含 `+` 等字符，请使用 **`encodeURIComponent(sign)`** 拼进 URL。

## 时间窗口

服务端校验：**解出时间戳与服务器当前时间的差的绝对值 ≤ 60 秒**。请在**即将打开授权页面前**再生成 `sign`，避免用户停留过久导致过期。

## 调用的登录 API（授权入口）

将下列路径中的 **`{BACKEND}`** 替换为你的 Worker 域名或本地开发地址（例如 `https://cent.link-ai.workers.dev`）。

### GitHub

```http
GET {BACKEND}/api/github-oauth/authorize?redirect_uri={编码后的回调}&sign={编码后的 sign}
```

示例（参数需 URL 编码）：

```text
{BACKEND}/api/github-oauth/authorize?redirect_uri=dailycent%3A%2F%2Foauth%2Fcallback&sign=....
```

在浏览器或 WebView 中通常使用 **整页跳转** 或 **打开系统浏览器** 访问该 URL；成功后会 302 到 GitHub 授权页。

### Gitee（码云）

```http
GET {BACKEND}/api/gitee-oauth/authorize?redirect_uri={编码后的回调}&sign={编码后的 sign}
```

规则与 GitHub 入口相同，仅路径前缀为 `/api/gitee-oauth/`。

### 常见错误响应（JSON）

- `400`：`sign` 缺失、解密失败、时间戳不在窗口内、或 `redirect_uri` 不在白名单等。
- `500`：服务端未配置 `SIGN_SECRETS`（仅当使用非 http(s) 的 `redirect_uri` 时会出现）。

## 参考实现（TypeScript，浏览器 / Node 18+）

以下 `aesGcmEncrypt` 与后端 [`src/lib/encryption.ts`](../src/lib/encryption.ts) 逻辑一致，可直接复制到客户端（Node 下需 `globalThis.crypto` 可用）。

```typescript
async function sha256Raw(password: string): Promise<ArrayBuffer> {
	const pwUtf8 = new TextEncoder().encode(password);
	return await crypto.subtle.digest("SHA-256", pwUtf8);
}

/**
 * 与后端 aesGcmEncrypt 一致：返回 iv(24 hex) + base64(ciphertext)
 */
export async function aesGcmEncrypt(
	plaintext: string,
	password: string,
): Promise<string> {
	const pwHash = await sha256Raw(password);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const alg = { name: "AES-GCM" as const, iv };
	const key = await crypto.subtle.importKey("raw", pwHash, alg, false, [
		"encrypt",
	]);
	const ptUint8 = new TextEncoder().encode(plaintext);
	const ctBuffer = await crypto.subtle.encrypt(alg, key, ptUint8);
	const ctBytes = new Uint8Array(ctBuffer);
	let ctStr = "";
	for (let i = 0; i < ctBytes.length; i++) {
		ctStr += String.fromCharCode(ctBytes[i]!);
	}
	const ctBase64 = btoa(ctStr);
	const ivHex = Array.from(iv)
		.map((b) => ("00" + b.toString(16)).slice(-2))
		.join("");
	return ivHex + ctBase64;
}

/** 生成当前请求可用的 sign */
export async function buildAuthorizeSign(signSecret: string): Promise<string> {
	return aesGcmEncrypt(String(Date.now()), signSecret);
}
```

### 拼 URL 示例

```typescript
const BACKEND = "https://your-worker.example.com";
const redirectUri = "dailycent://oauth/callback";
const signSecret = "..."; // 与服务器 SIGN_SECRETS 相同，由你们安全下发或构建时注入

const sign = await buildAuthorizeSign(signSecret);
const url = new URL(`${BACKEND}/api/github-oauth/authorize`);
url.searchParams.set("redirect_uri", redirectUri);
url.searchParams.set("sign", sign);
// 浏览器：location.href = url.toString()
```

`URLSearchParams` 会对 `sign` 自动编码，一般无需手写 `encodeURIComponent`。

## 与纯 Web（https）回调的差异

若 `redirect_uri` 为 `https://...`，**不要**传 `sign`（服务端会忽略）；仅需保证域名/路径前缀落在服务端白名单内。

---

若算法与后端不一致导致 400，请对照 [`src/lib/encryption.ts`](../src/lib/encryption.ts) 与 [`src/lib/sign_verify.ts`](../src/lib/sign_verify.ts) 核对 IV 长度、Base64 编码方式及密钥派生步骤。
