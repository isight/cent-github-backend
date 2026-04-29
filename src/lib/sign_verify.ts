import { aesGcmDecrypt } from "./encryption";

/** 与服务器时间偏差允许范围（毫秒）：前后各 5 分钟 */
const SIGN_TIME_WINDOW_MS = 5 * 60_000;

export function isHttpOrHttpsRedirect(uri: string): boolean {
	const s = uri.trim();
	const lower = s.toLowerCase();
	return lower.startsWith("http://") || lower.startsWith("https://");
}

/**
 * 校验非 http(s) redirect 所附带的 sign：由客户端用 SIGN_SECRETS 对 `String(Date.now())` 做 aesGcmEncrypt。
 * 成功则返回；失败抛出 Error，message 供路由返回 400。
 */
export async function verifyRedirectSign(
	sign: string | undefined,
	signSecret: string,
	nowMs = Date.now(),
): Promise<void> {
	if (!sign?.trim()) {
		throw new Error("`sign` is required for non-http(s) redirect_uri.");
	}
	let plain: string;
	try {
		plain = await aesGcmDecrypt(sign.trim(), signSecret);
	} catch {
		throw new Error("Invalid `sign` or decryption failed.");
	}
	const ts = Number(plain);
	if (!Number.isFinite(ts) || ts < 0) {
		throw new Error("Invalid sign payload (expected millisecond timestamp).");
	}
	if (Math.abs(nowMs - ts) > SIGN_TIME_WINDOW_MS) {
		throw new Error(
			"sign timestamp expired or not within acceptable window (±5 minutes).",
		);
	}
}
