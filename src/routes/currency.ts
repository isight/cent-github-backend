import { Hono } from "hono";

type Bindings = {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITEE_CLIENT_ID: string;
	GITEE_CLIENT_SECRET: string;
};

const currencyRouter = new Hono<{ Bindings: Bindings }>();

/**
 * 4. **汇率API**
 * 使用如下路径获取汇率：/api/currency/USD/2020-01-01，该路由将返回指定日期以USD为基准的汇率信息数据，若未指定日期，默认返回最新汇率信息
 * 汇率信息从ecb.europa.eu的xml接口中获取
 */

/**
 * 解析 ECB XML 汇率数据，转换为指定基准货币
 *
 * ECB 数据以 EUR 为基准。对于任意基准货币：
 * 1. 如果基准货币在 ECB 数据中（如 GBP, JPY 等）：直接用其汇率作为除数转换
 * 2. 如果基准货币不在数据中（如 USD）：假设可以通过其他来源获得其相对 EUR 的汇率
 *    例如：USD 的汇率 = 1 / EUR的USD价格（通过反演得到）
 *
 * @param xmlContent - XML 内容
 * @param baseCurrency - 基准货币（默认为 EUR）
 * @param virtualRates - 虚拟货币相对于 EUR 的汇率（用于 ECB 中不存在的货币，如 USD）
 * @returns 汇率对象，包含所有 ECB 支持的货币
 */
function parseECBXML(
	xmlContent: string,
	baseCurrency: string = "EUR",
	virtualRates: Record<string, number> = {},
): Record<string, number> {
	const rates: Record<string, number> = {};

	// 创建 DOMParser 替代方案（因为 Cloudflare Worker 环境）
	// 使用正则表达式来解析 XML
	// ECB XML 使用单引号：<Cube currency='USD' rate='1.1590'/>
	const ratePattern = /<Cube\s+currency='(\w+)'\s+rate='([\d.]+)'\s*\/>/g;

	const matches = Array.from(xmlContent.matchAll(ratePattern));
	for (const match of matches) {
		const currency = match[1];
		const rate = parseFloat(match[2]);
		rates[currency] = rate;
	}

	// 加入 EUR 基准（ECB 数据以 EUR 为基准）
	rates["EUR"] = 1;

	// 合并虚拟货币汇率（用于 ECB 中不存在的货币）
	Object.assign(rates, virtualRates);

	// 如果基准货币不是 EUR，需要进行换算
	if (baseCurrency !== "EUR") {
		const baseRate = rates[baseCurrency];
		if (!baseRate) {
			throw new Error(
				`Currency ${baseCurrency} not found in available data. ` +
					`Available currencies: ${Object.keys(rates).sort().join(", ")}`,
			);
		}

		// 将所有汇率转换为以指定货币为基准
		const convertedRates: Record<string, number> = {};
		for (const [currency, rate] of Object.entries(rates)) {
			convertedRates[currency] = rate / baseRate;
		}
		// 加入基准货币本身的汇率（始终为 1）
		convertedRates[baseCurrency] = 1;

		return convertedRates;
	}

	return rates;
}

/**
 * 获取虚拟货币相对于 EUR 的汇率
 * 虚拟货币是指 ECB 数据中不存在但需要支持的货币（如 USD）
 *
 * @param virtualCurrency - 虚拟货币代码（如 'USD'）
 * @returns 相对于 EUR 的汇率
 */
async function getVirtualCurrencyRate(
	virtualCurrency: string,
): Promise<number | null> {
	// 特殊处理常见的虚拟货币
	// 这里可以通过多种方式获取：
	// 1. 从其他 API 获取（如 Fixer.io, Open Exchange Rates）
	// 2. 使用缓存的汇率
	// 3. 从数据库查询历史数据

	if (virtualCurrency === "USD") {
		// 一个简单的实现：从 ECB 反向获取
		// ECB 数据中可能包含 USD 相关的交叉汇率（通过其他货币）
		// 更好的实现是使用专门的 USD 汇率 API
		// 例如：https://api.exchangerate-api.com/v4/latest/EUR
		try {
			const response = await fetch(
				"https://api.exchangerate-api.com/v4/latest/EUR",
				{
					headers: {
						"User-Agent": "Cent-App (Cloudflare Worker)",
					},
				},
			);

			if (response.ok) {
				const data = (await response.json()) as Record<string, unknown>;
				const rates = data.rates as Record<string, number>;
				if (rates?.USD) {
					return 1 / rates.USD; // 反演得到 USD 相对于 EUR 的汇率
				}
			}
		} catch {
			console.warn(
				"Failed to fetch USD rate from external API, using fallback",
			);
		}

		// 如果主 API 失败，使用合理的默认值（1 EUR ≈ 1.1 USD）
		return 0.92; // 这是一个估计值，实际使用应该使用更新的数据
	}

	// 其他虚拟货币可以在这里添加
	return null;
}

/**
 * 获取虚拟货币的汇率集合
 * 检查请求的基准货币是否是虚拟货币，如果是则获取其相对 EUR 的汇率
 *
 * @param baseCurrency - 基准货币代码
 * @param ecbCurrencies - ECB 中已有的货币集合
 * @returns 虚拟货币相对于 EUR 的汇率集合
 */
async function getVirtualRates(
	baseCurrency: string,
	ecbCurrencies: Set<string>,
): Promise<Record<string, number>> {
	const virtualRates: Record<string, number> = {};

	// 如果基准货币不在 ECB 数据中，获取其虚拟汇率
	if (!ecbCurrencies.has(baseCurrency)) {
		const rate = await getVirtualCurrencyRate(baseCurrency);
		if (rate !== null) {
			virtualRates[baseCurrency] = rate;
		}
	}

	return virtualRates;
}

/**
 * 获取指定日期的汇率数据
 * @param date - 日期字符串，格式为 YYYY-MM-DD，如果为空则获取最新汇率
 * @returns 原始 XML 内容
 */
async function fetchECBRates(date?: string): Promise<string> {
	let url: string;

	if (date) {
		// 验证日期格式
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
			throw new Error("Invalid date format. Use YYYY-MM-DD");
		}
		// 获取历史汇率：https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml
		url = `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-${date}.xml`;
	} else {
		// 获取最新汇率
		url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
	}

	const response = await fetch(url, {
		headers: {
			"User-Agent": "Cent-App (Cloudflare Worker)",
		},
	});

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				`No exchange rate data available for date: ${date || "today"}`,
			);
		}
		throw new Error(`Failed to fetch ECB data: ${response.statusText}`);
	}

	return response.text();
}

/**
 * 路由：GET /api/currency/:base
 * 获取最新汇率或指定日期的汇率（通过 query 参数）
 * 返回 ECB 支持的所有货币相对于指定基准货币的汇率
 * 示例：
 *   GET /api/currency/USD
 *   GET /api/currency/USD?date=2020-01-01
 */
currencyRouter.get("/api/currency/:base", async (c) => {
	const base = c.req.param("base").toUpperCase();
	const date = c.req.query("date"); // 支持查询参数形式的日期

	try {
		// 获取 ECB 汇率数据
		const xmlContent = await fetchECBRates(date);

		// 先解析 ECB 数据（相对于 EUR）
		const ecbRates = parseECBXML(xmlContent, "EUR");
		const ecbCurrencies = new Set(Object.keys(ecbRates));

		// 获取虚拟货币的汇率（如果基准货币不在 ECB 中）
		const virtualRates = await getVirtualRates(base, ecbCurrencies);

		// 合并虚拟汇率后进行转换
		// 确保包含 ECB 的所有货币 + 虚拟货币
		const rates = parseECBXML(xmlContent, base, virtualRates);

		return c.json({
			success: true,
			base: base,
			date: date || new Date().toISOString().split("T")[0],
			// 包含所有可用货币数量
			availableCurrencies: Object.keys(rates).length,
			rates: rates,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("Currency API error:", error);
		return c.json(
			{
				success: false,
				error: errorMessage,
			},
			400,
		);
	}
});

/**
 * 路由：GET /api/currency/:base/:date
 * 获取指定日期以指定货币为基准的汇率信息
 * 返回 ECB 支持的所有货币相对于指定基准货币的汇率
 * 示例：GET /api/currency/USD/2020-01-01
 */
currencyRouter.get("/api/currency/:base/:date", async (c) => {
	const base = c.req.param("base").toUpperCase();
	const date = c.req.param("date");

	try {
		// 获取 ECB 汇率数据
		const xmlContent = await fetchECBRates(date);

		// 先解析 ECB 数据（相对于 EUR）
		const ecbRates = parseECBXML(xmlContent, "EUR");
		const ecbCurrencies = new Set(Object.keys(ecbRates));

		// 获取虚拟货币的汇率（如果基准货币不在 ECB 中）
		const virtualRates = await getVirtualRates(base, ecbCurrencies);

		// 合并虚拟汇率后进行转换
		// 确保包含 ECB 的所有货币 + 虚拟货币
		const rates = parseECBXML(xmlContent, base, virtualRates);

		return c.json({
			success: true,
			base: base,
			date: date,
			// 包含所有可用货币数量
			availableCurrencies: Object.keys(rates).length,
			rates: rates,
		});
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		console.error("Currency API error:", error);
		return c.json(
			{
				success: false,
				error: errorMessage,
			},
			400,
		);
	}
});

export default currencyRouter;
