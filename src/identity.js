import { canonical, sha256 } from "./hash.js";

// 平台参与方角色。任何一笔退税的终结状态都需要海关查验员与退税机构
// 两方先后确认，任一角色都无法单独结算或冲正。
export const ROLES = {
  MERCHANT: "merchant", // 门店：只能维护本店销售
  BRAND: "brand", // 品牌方：核实真伪
  INSPECTOR: "inspector", // 海关查验员：口岸实物查验
  AGENCY: "agency", // 退税机构：窗口结算
  SYSTEM: "system", // 保留期清理等自动任务
};

// 商品身份 = 实物批次 + 序列号 + 出厂特征。同一商品身份在全部事件中
// 必须指向同一特征哈希，否则就是标识冒用。
export function makeFeatureHash({ batchId, serial, features = [] }) {
  if (!batchId || !serial) throw new Error("商品身份缺少批次或序列号");
  const featureList = features.map((f) => String(f)).sort();
  return sha256(
    canonical({ kind: "item-feature", batchId, serial, features: featureList }),
  );
}
