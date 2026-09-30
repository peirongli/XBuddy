# 测试说明

## 一、单元 / 契约测试（离线，不需要任何 key）

```bash
npm test
```

当前 24 例全部通过，覆盖：

| 模块 | 用例 |
|---|---|
| 合规守卫 | 识别买卖建议 / 涨跌预测 / 收益承诺；正常分析不误伤；机械改写后零残留 |
| 规划器 | 单标的→search_ticker 起步；直接给代码跳过检索；对比类→双标的财务；盘面情绪类路由；成本估算一致；实体提取剥离语境词；对比双标的拆分 |
| 工具注册表 | 全部工具具备 schema/权限/成本声明 |
| 上下文摘要 | 快照/K线/财务三类 digest 关键信息保留；财务摘要按表分组不输出 undefined（回归） |
| DEMO 数据 | 快照与 K 线口径自洽；demo 标记显式存在；未收录标的按查询构造不冒充真实股票（回归） |

## 二、主链路端到端（API 级）

```bash
npm start   # 另开终端
```

```bash
# 1. 建线程
curl -s -X POST localhost:3721/api/threads -H 'Content-Type: application/json' -d '{"title":"测试"}'
# 2. 提交研究目标（返回 run_id）
curl -s -X POST localhost:3721/api/threads/<tid>/goals -H 'Content-Type: application/json' \
  -d '{"goal":"分析贵州茅台近一年基本面与估值水位"}'
# 3. 轮询至终态 completed
curl -s localhost:3721/api/runs/<rid> | python3 -m json.tool
# 4. 查看报告产物 / 证据原文 / 长期记忆
curl -s localhost:3721/api/artifacts/<aid>
curl -s localhost:3721/api/evidence/<eid>
curl -s localhost:3721/api/memory
```

预期：`plan_created`（LLM 规划 5-6 步）→ 各步骤 `step_completed` 且携带证据 ID → `artifact_created` → `memory_updated`。报告中每个数值带 `[ev_xxx]` 引用，证据弹窗可见端点/request_id/取数时点/单位。

## 三、审批 / 停止规则场景

1. **计划审批**：提交目标时带低阈值触发：
   `{"goal":"对比宁德时代和比亚迪的最新财务表现","budget":{"plan_approval_threshold":5}}`
   → 状态 `awaiting_approval`，出现 `approval_required` 事件 → 调用审批接口批准 → 继续执行至 `completed`；拒绝则 `stopped`。
2. **手动终止**：运行中 `POST /api/runs/<rid>/stop` → 当前步骤结束后 `stopped`。
3. **预算触顶**：默认 `max_tool_calls:16`；运行中触顶会二次请求审批（追加/终止）。

## 四、数据缺失 / 接口失败 / 降级场景

| 场景 | 操作 | 预期 |
|---|---|---|
| 扶摇 key 缺失 | `.env` 留空 `FUYAO_API_KEY` 后启动 | 首个工具调用触发 `mode_switch` 事件，全 run 走 DEMO 数据，报告标题与正文全程标注"演示数据" |
| 扶摇鉴权失败 | 填入无效 key | 同上（code=2001/2003 → 降级） |
| LLM 不可用 | 留空 `DEEPSEEK_API_KEY` | `planner_fallback` → 模板规划；摘要走规则 digest；报告走模板报告；`synthesis_fallback` 事件可见 |
| 上游限流/超时 | （自然发生时）| 客户端指数退避重试 2 次；仍失败则步骤 `failed`+`degraded`，依赖步骤级联 `skipped`，报告 `data_gaps` 如实列出 |
| 依赖失败 | 任意步骤失败 | 后续引用其输出的步骤不再带坏参数执行，而是跳过并披露 |
| 数据冲突 | DEMO 下对比类目标 | 报告对口径不一致处主动写入 `data_gaps`（已在实测中观察到） |

## 五、合规边界场景

- 提示注入诱导：要求 Agent"给出买入建议"——综合阶段 system 约束 + 输出层守卫双重拦截；即使模型输出违规表述，`guard_violation` 事件触发 LLM 重写/机械 redact，`guard_residual` 监控残留。
- 单测保证：`建议买入`/`必涨`/`稳赚`/`目标价` 等表述在输出层必被拦截或改写（见 npm test）。

## 六、浏览器实测记录（2026-09-30）

agent-browser + Chromium 实测通过：首页目标输入与 preset、线程切换自动加载最近运行、报告渲染（事实/推断标签、证据 chip）、ECharts K 线（红涨绿跌）与财务柱图、证据溯源弹窗、可观测性运行表、记忆库条目删除入口。截图存于开发过程记录。

## 七、检查点恢复 / 崩溃与停止实测（2026-09-30，真实数据模式）

1. **审批等待期崩溃 → 重启补交 → 恢复**：提交"对比招商银行和兴业银行"目标（预计调用超阈值 → `awaiting_approval`）→ kill 服务进程 → 重启（run 仍为 `awaiting_approval`，审批 pending 保留）→ `POST /api/runs/<rid>/approvals/<aprId>` 补交批准 → run 转 `recoverable` → `POST /api/runs/<rid>/resume` → 从检查点续跑至 `completed`（9/9 步全 REAL，`run_resumed` 事件可见，报告含双行真实财务对比）。
2. **运行中手动停止**：目标运行至 `running` 后 `POST /stop` → 当前步骤结束后转 `stopped`：已完成步骤保留、剩余步骤 pending、无 artifact、无编造报告。
3. **真实数据多路由回归**：单标的基本面+估值（search/snapshot/kline/financials/calendar/derive 全 REAL）、盘面情绪（交易日历/涨停池/热股榜/龙虎榜真实调用）、双银行对比（9 步全 REAL）。回归中发现并修复"多引用参数模板未解析"缺陷（见 AI-USAGE.md #10），并新增 4 例参数解析单测。
