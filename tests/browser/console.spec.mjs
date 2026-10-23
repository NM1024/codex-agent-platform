import { test, expect } from "@playwright/test";
const navigate = (page, view) => page.locator(`[data-view="${view}"]`).click();
async function operation(page, action, args = {}) {
  const response = await page.request.post("/admin/api/operations", {
    data: { action, args },
  });
  expect(response.ok()).toBeTruthy();
  return response.json();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/admin/");
  await page.locator("#password").fill("local-browser-password");
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(page.locator("#workspace")).toBeVisible();
});
test("saving a plugin keeps its selected definition and trial input for submission", async ({
  page,
}) => {
  await navigate(page, "plugins");
  const editor = page.locator("#plugin-editor");
  await expect(editor).toBeVisible();
  const definition = JSON.parse(await editor.inputValue());
  definition.type = "browser.summary";
  definition.name = "浏览器摘要";
  definition.instructions = "Summarize and submit the result.";
  await editor.fill(JSON.stringify(definition));
  await page.locator("#trial-input").fill('{"content":"Synthetic trial."}');
  await page.getByRole("button", { name: "校验并保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("插件已保存");
  expect(JSON.parse(await editor.inputValue()).type).toBe("browser.summary");
  await expect(page.locator("#trial-input")).toHaveValue(
    '{"content":"Synthetic trial."}',
  );
  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/operations") &&
      r.request().postDataJSON()?.action === "submit_task",
  );
  await page.getByRole("button", { name: "提交试运行", exact: true }).click();
  const response = await submitted;
  expect(response.status()).toBe(200);
  const task = await response.json();
  expect(task.type).toBe("browser.summary");
  expect(
    (await operation(page, "task", { task_id: task.task_id })).input.content,
  ).toBe("Synthetic trial.");
});
test("editing a disabled schedule preserves its disabled state", async ({
  page,
}) => {
  await navigate(page, "schedules");
  const row = page.locator("tr").filter({ hasText: "每日运行巡检" });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByPlaceholder("例如：每天检查运行情况")
    .fill("每日运行巡检（已调整）");
  await page.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("定时计划已保存");
  expect(
    (await operation(page, "schedules")).find(
      (p) => p.name === "每日运行巡检（已调整）",
    ).enabled,
  ).toBe(false);
});
test("saving one settings group retains unsaved changes in other groups", async ({
  page,
}) => {
  await navigate(page, "settings");
  await page
    .locator("#setting-execution-model")
    .fill("browser-execution-model");
  await page
    .locator("#setting-manager-instructions")
    .fill("An unsaved management prompt.");
  await page
    .locator("#configuration-execution")
    .getByRole("button", { name: "保存配置" })
    .click();
  await expect(page.getByRole("status")).toContainText("已保存");
  await expect(page.locator("#setting-manager-instructions")).toHaveValue(
    "An unsaved management prompt.",
  );
  await page
    .locator("#configuration-manager")
    .getByRole("button", { name: "保存配置" })
    .click();
  await expect
    .poll(
      async () =>
        (await operation(page, "configuration_get", { scope: "manager" }))
          .values.instructions,
    )
    .toBe("An unsaved management prompt.");
});
test("all six navigation choices fit on a phone without horizontal page scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [
    "overview",
    "chat",
    "tasks",
    "plugins",
    "schedules",
    "settings",
  ]) {
    const button = page.locator(`[data-view="${name}"]`),
      box = await button.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(40);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("task search works with Enter and exposes the caller request identifier", async ({
  page,
}) => {
  await navigate(page, "tasks");
  const input = page.getByRole("textbox", { name: "搜索任务" });
  await input.fill("article-review-2026-002");
  await input.press("Enter");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody")).toContainText("article-review-2026-002");
});
test("language can change before login and survives reload", async ({
  page,
}) => {
  await page.locator("#logout").click();
  await page.locator("#login-language").selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Understand and manage your system." }),
  ).toBeVisible();
  await expect(page.locator("#password")).toHaveAttribute(
    "placeholder",
    "Enter Admin password",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});
test("language switching preserves plugin data and settings drafts without writes", async ({
  page,
}) => {
  await navigate(page, "plugins");
  const definition = JSON.parse(
    await page.locator("#plugin-editor").inputValue(),
  );
  definition.name = "用户自己的中文业务";
  definition.instructions = "业务提示词原样保留";
  const json = JSON.stringify(definition);
  await page.locator("#plugin-editor").fill(json);
  await page.locator("#trial-input").fill('{"content":"用户输入"}');
  const mutations = [];
  page.on("request", (request) => {
    if (request.method() === "POST")
      mutations.push(request.postDataJSON()?.action ?? request.url());
  });
  await page.locator("#app-language").selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Business plugins", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#plugin-editor")).toHaveValue(json);
  await expect(page.locator("#trial-input")).toHaveValue(
    '{"content":"用户输入"}',
  );
  await navigate(page, "settings");
  await page.locator("#setting-manager-instructions").fill("保留我的提示词");
  await page.locator("#app-language").selectOption("zh-CN");
  await expect(
    page.getByRole("heading", { name: "系统配置", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#setting-manager-instructions")).toHaveValue(
    "保留我的提示词",
  );
  expect(mutations.every((action) => action === "configuration_list")).toBe(
    true,
  );
  await page.locator("#app-language").selectOption("en");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#app-language")).toHaveValue("en");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const button of await page.locator("[data-view]").all()) {
    const box = await button.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
test("changing language while editing a schedule keeps its identity and state", async ({
  page,
}) => {
  await navigate(page, "schedules");
  const plan = await operation(page, "schedule_save", {
      schedule: {
        name: "Language edit sample",
        kind: "inspection",
        cron: "0 9 * * *",
        timezone: "Asia/Shanghai",
        message: "Synthetic inspection",
        enabled: false,
      },
    }),
    plans = await operation(page, "schedules");
  await page.locator("#refresh").click();
  await page
    .locator("tr")
    .filter({ hasText: plan.name })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.locator("#app-language").selectOption("en");
  await page
    .getByLabel("Schedule name", { exact: true })
    .fill("Bilingual edited inspection");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await operation(page, "schedules")).find((p) => p.id === plan.id)
          ?.name,
    )
    .toBe("Bilingual edited inspection");
  const after = await operation(page, "schedules");
  expect(after.length).toBe(plans.length);
  expect(after.find((p) => p.id === plan.id).enabled).toBe(false);
});
test("completed task artifacts are viewable and downloadable", async ({
  page,
}) => {
  await navigate(page, "tasks");
  const task = (await operation(page, "tasks", { status: "completed" }))[0];
  await page
    .locator("tr")
    .filter({ hasText: task.task_id })
    .getByRole("button", { name: "详情", exact: true })
    .click();
  await expect(page.locator(".previews img")).toBeVisible();
  expect(
    await page
      .locator(".previews img")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  ).toBe(true);
  const link = page.getByRole("link", { name: "review.txt" });
  await expect(link).toBeVisible();
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("review.txt");
});
test("management messages render as text and retain an unsent draft while polling", async ({
  page,
}) => {
  await navigate(page, "chat");
  await page.locator("#message-input").fill("检查队列");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator("#messages")).toContainText("<img src=x");
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.locator("#message-input").fill("下一条未发送的消息");
  await page.waitForResponse(
    (r) =>
      r.url().includes("/conversations/") && r.request().method() === "GET",
  );
  await expect(page.locator("#message-input")).toHaveValue(
    "下一条未发送的消息",
  );
});
test("English navigation covers each view and schedule creation only shows relevant fields", async ({
  page,
}) => {
  await page.locator("#app-language").selectOption("en");
  const views = {
    overview: "Overview",
    chat: "Management chat",
    tasks: "Task history",
    plugins: "Business plugins",
    schedules: "Schedules",
    settings: "Settings",
  };
  for (const [view, title] of Object.entries(views)) {
    await navigate(page, view);
    await expect(page.locator("#page-title")).toHaveText(title);
  }
  await navigate(page, "schedules");
  await page
    .getByLabel("Schedule name", { exact: true })
    .fill("Unsubmitted schedule");
  await expect(
    page.getByLabel("Inspection instructions", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Task input JSON", { exact: true }),
  ).toBeHidden();
  await page.getByLabel("Trigger type", { exact: true }).selectOption("task");
  await expect(
    page.getByLabel("Task input JSON", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Inspection instructions", { exact: true }),
  ).toBeHidden();
  const before = await operation(page, "schedules");
  await page.getByRole("button", { name: "New schedule", exact: true }).click();
  await expect(page.getByLabel("Schedule name", { exact: true })).toHaveValue(
    "",
  );
  expect((await operation(page, "schedules")).length).toBe(before.length);
});
test("English login errors, session reload and logout work without model access", async ({
  page,
}) => {
  await page.locator("#logout").click();
  await page.locator("#login-language").selectOption("en");
  await page.locator("#password").fill("incorrect-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Incorrect password or expired session.",
  );
  await page.locator("#password").fill("local-browser-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.reload();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator("#login")).toBeVisible();
  expect((await page.request.get("/admin/api/tasks")).status()).toBe(401);
});
test("typing during a slow language change preserves the latest draft", async ({
  page,
}) => {
  await navigate(page, "plugins");
  await page.locator("#trial-input").fill("before");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/api/plugins", async (route) => {
    await gate;
    await route.continue();
  });
  const pending = page.waitForRequest("**/admin/api/plugins");
  await page.locator("#app-language").selectOption("en");
  await pending;
  await page.locator("#trial-input").fill("edited while language was loading");
  release();
  await expect(
    page.getByRole("heading", { name: "Plugin definition", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#trial-input")).toHaveValue(
    "edited while language was loading",
  );
});
test("English schedule validation errors are readable and keep diagnostic codes", async ({
  page,
}) => {
  await navigate(page, "schedules");
  await page.locator("#app-language").selectOption("en");
  await page
    .getByLabel("Schedule name", { exact: true })
    .fill("Invalid cron sample");
  await page
    .getByLabel("Cron (minute hour day month weekday)", { exact: true })
    .fill("invalid");
  await page
    .getByRole("button", { name: "Save schedule", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "INVALID_SCHEDULE: Provide a valid five-field cron expression and IANA time zone.",
  );
});
