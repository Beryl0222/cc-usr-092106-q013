import test from "node:test";
import assert from "node:assert/strict";
import { buildScenario } from "../examples/scenario.mjs";
import { travelerDashboard, supportedLocales } from "../src/view.js";

test("支持中文、英文、日文三种语言", () => {
  assert.deepEqual(supportedLocales(), ["zh", "en", "ja"]);
});

test("旅客视图显示缺材料、退货冲减、下一步经过谁", () => {
  const { svc, ids } = buildScenario();
  const dash = travelerDashboard(svc, "zh", [ids.claimScarf, ids.claimTeapot]);
  assert.equal(dash.vouchers.length, 2);

  const scarf = dash.vouchers.find((v) => v.claimId === ids.claimScarf);
  assert.equal(scarf.item.names[0], "真丝印花围巾");
  assert.equal(scarf.net.amount, "700.00 CNY");
  assert.equal(scarf.net.converted, "91.00 EUR");
  // 哪笔退货已冲减
  assert.equal(scarf.deductions[0].kind, "return");
  assert.match(scarf.deductions[0].label, /退货冲减/);
  assert.equal(scarf.deductions[0].amount, "-300.00 CNY");
  // 冲正后的状态与下一步
  assert.equal(scarf.status.code, "reversed-reopen");
  assert.match(scarf.next, /海关查验台/);
  assert.ok(scarf.missing.some((m) => m.code === "inspection"));

  const teapot = dash.vouchers.find((v) => v.claimId === ids.claimTeapot);
  assert.equal(teapot.status.code, "settled");
  assert.equal(teapot.deductions.length, 0);
  assert.match(teapot.next, /完成/);
  assert.equal(teapot.port.code, "port-land-r1");
});

test("英文视图与日文视图字段均已本地化", () => {
  const { svc, ids } = buildScenario();
  const en = travelerDashboard(svc, "en", [ids.claimScarf]);
  const ja = travelerDashboard(svc, "ja", [ids.claimScarf]);
  assert.equal(en.title, "My departure tax refund");
  assert.match(en.vouchers[0].next, /customs desk/);
  assert.match(ja.vouchers[0].status.label, /取り消され/);
  assert.match(ja.vouchers[0].next, /税関検査台/);
});

test("视图不回显旅客隐私字段", () => {
  const { svc, ids } = buildScenario();
  const dash = travelerDashboard(svc, "zh", [ids.claimScarf]);
  const text = JSON.stringify(dash);
  assert.equal(text.includes("P-99887766"), false);
  assert.equal(text.includes("MARIA GARCIA"), false);
});
