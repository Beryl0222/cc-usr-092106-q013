# 离境退税商品身份核验台

外国游客带着商品和多家门店小票到离境口岸时，应能用熟悉的语言知道哪件商品缺材料、哪笔退货已经冲减、还要经过谁。本项目是这一业务的**领域内核**：只追加事件台账 + 商品身份 + 多方授权 + 只读投影，不依赖任何外部服务或数据库。

## 它如何回应业务要求

- **可验证的商品身份**：商品身份 = 实物批次 + 序列号 + 出厂特征的承诺哈希（`src/identity.js`）。品牌方按授权批次核实真伪；查验员现场重算特征哈希，不一致即拒绝；同一批次序列号不可重复登记。
- **只追加，不修改**：开票、部分退货、价格调差、汇率变化、航班改签、多口岸流转都只追加事件（`src/ledger.js`），当前可申报范围由投影（`src/projection.js`）从事件流重算。事件以 SHA-256 哈希链首尾相接，改写或删除任一事件都会被 `ledger.verify()` 发现。
- **同一商品不得重复退税**：一张发票只能开一张退税凭证；同一实物身份只能开一张发票；结算时再次检查没有其他凭证占用该商品。
- **任何一方都不能单独终结状态**：门店只管本店销售，品牌方只管授权批次，查验员只对当前口岸分段负责；申报后才能结算，而**冲正必须查验员/退税机构一方提议、另一方确认**。
- **离线终端重连识别双重查验**：`src/offline.js` 断网暂存、重连按序重放，`requestId` 保证同机重发幂等；不同终端对同一分段的第二次查验会被拒绝并追加 `inspectionRejected` 留痕，带班查验员可复核（`reviewInspection`）。
- **多口岸流转**：改港不作废历史，只追加新分段；投影只认当前分段为可申报范围，旧分段完整保留。
- **平台不集中保存完整支付/身份资料**：证件号、姓名等只存于侧库 `PrivateVault`，台账只保留承诺哈希；到期物理删除并追加 `privacyPurged` 墓碑，明文不可恢复。
- **审计可追全程**：`src/audit.js` 从一笔退税追到净销售额构成、实物批次与特征、品牌核实、各分段查验（含双重查验拦截）、结算与冲正，并复验哈希链连续性与整链完整性。
- **旅客多语言视图**：`src/view.js` 提供 zh / en / ja 三种视图，直接呈现缺什么材料、退货已冲减多少、下一步找谁，且不回显任何隐私字段。

## 目录

| 路径 | 职责 |
| --- | --- |
| `src/hash.js` | 规范化 JSON 与 SHA-256 事件哈希链 |
| `src/ledger.js` | 只追加台账、`requestId` 幂等、整链复验 |
| `src/vault.js` | 隐私侧库：到期物理删除 |
| `src/identity.js` | 角色定义与商品特征哈希 |
| `src/projection.js` | 事件流 → 当前状态、净销售额、缺材料、状态机 |
| `src/service.js` | 业务服务：授权与全部不变量校验，只通过事件写入 |
| `src/offline.js` | 离线口岸终端：暂存、重连重放、双重查验冲突识别 |
| `src/audit.js` | 单笔退税的完整证据链与完整性复验 |
| `src/view.js` | 旅客三语言只读视图 |
| `examples/scenario.mjs` | 可执行端到端业务样例（测试共用夹具） |
| `examples/walkthrough.mjs` | 演示脚本：打印三语视图与审计追踪 |
| `fixtures/catalog.json` | 商户/品牌/商品类别/口岸基础目录样例（UTF-8） |

## 运行

```bash
npm test          # 37 个测试：台账、业务规则、离线同步、隐私、审计、视图
node examples/walkthrough.mjs
```

## 事件一览

`partyRegistered`、`storeBound`、`catalogEntry`、`batchRegistered`、`itemEnrolled`、`invoiceIssued`、`returnRecorded`、`priceAdjusted`、`fxAdjusted`、`claimOpened`、`flightChanged`、`routeChanged`、`brandVerified`、`inspectionPassed`、`inspectionRejected`、`inspectionReviewed`、`claimFiled`、`refundSettled`、`reversalProposed`、`settlementReversed`、`privacyPurged`。

净销售额（开票币种）= 开票金额 + 价格调差 − 累计退货；按最新追加的汇率折算退税币种。金额逐笔校验，累计退货或调差不得使净额为负。
