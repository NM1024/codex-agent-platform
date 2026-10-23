import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { t, setLocale, getLocale } from "../src/manager/web/i18n.js";

test("console interface copy has English translations; business data remains literal", async () => {
  const source = await readFile(
    new URL("../src/manager/web/app.js", import.meta.url),
    "utf8",
  );
  const html = await readFile(
    new URL("../src/manager/web/index.html", import.meta.url),
    "utf8",
  );
  const keys = [
    ...[...source.matchAll(/\bt\(\s*(["'])(.*?)\1/g)].map(match=>[match[0],match[2]]),
    ...html.matchAll(/data-i18n(?:-placeholder)?="([^"]*)"/g),
  ].map((match) => match[1]);
  // Dynamic status/name lookups use these source keys rather than t() literals.
  keys.push(
    "排队中",
    "启动中",
    "运行中",
    "提交中",
    "等待恢复",
    "执行完成",
    "执行失败",
    "接口已接收",
    "结果未知",
    "无需交付",
    "等待交付",
    "等待继续",
    "操作中",
    "程序可用",
    "已就绪",
    "未就绪",
    "已启用",
    "已停用",
  );
  const copyFiles = [
    "configuration/execution.mjs",
    "configuration/bootstrap.mjs",
    "manager/configuration.mjs",
    "capabilities/config.mjs",
    "application.mjs",
  ];
  for (const file of copyFiles) {
    const text = await readFile(
      new URL("../src/" + file, import.meta.url),
      "utf8",
    );
    keys.push(
      ...[...text.matchAll(/(?:title|description):\s*'([^']*)'/g)].map(
        (match) => match[1],
      ),
    );
  }
  try {
    setLocale("en");
    assert.equal(getLocale(), "en");
    for (const key of new Set(
      keys.filter((key) => /[\u4e00-\u9fff]/.test(key)),
    ))
      assert.doesNotMatch(
        t(key),
        /[\u4e00-\u9fff]/,
        `Missing interface translation: ${key}`,
      );
    assert.equal(
      t("请求编号：{id}", { id: "用户输入 {time} $& <tag>" }),
      "Request ID: 用户输入 {time} $& <tag>",
    );
    assert.equal(
      t("INVALID_SCHEDULE: 请提供有效的五字段 cron 和 IANA 时区。"),
      "INVALID_SCHEDULE: Provide a valid five-field cron expression and IANA time zone.",
    );
    assert.equal(t("This is task data."), "This is task data.");
    setLocale("unsupported");
    assert.equal(getLocale(), "zh-CN");
    assert.equal(t("运行概览"), "运行概览");
  } finally {
    setLocale("zh-CN");
  }
});
