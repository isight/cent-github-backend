import { Hono } from "hono";
import { fetchCurrency } from "../lib/kurrency";

type Bindings = {
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	GITEE_CLIENT_ID: string;
	GITEE_CLIENT_SECRET: string;
};

const currencyRouter = new Hono<{ Bindings: Bindings }>();

/**
 * 路由：GET /api/currency/:base/:date
 * 获取指定日期以指定货币为基准的汇率信息
 * 返回 ECB 支持的所有货币相对于指定基准货币的汇率
 * 示例：GET /api/currency/USD/2020-01-01
 */
currencyRouter.get("/api/currency/:base", async (c) => {
	const base = c.req.param("base").toUpperCase();
	try {
		const result = await fetchCurrency(base);
		return c.json({ ...result, success: true });
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown Error";
		return c.json(
			{
				success: false,
				error: errorMessage,
			},
			400,
		);
	}
});
currencyRouter.get("/api/currency/:base/:date", async (c) => {
	const base = c.req.param("base").toUpperCase();
	const dateStr = c.req.param("date"); // 支持查询参数形式的日期
	const date = dateStr ? new Date(dateStr) : undefined;
	try {
		const result = await fetchCurrency(base, date);
		return c.json({ ...result, success: true });
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown Error";
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
