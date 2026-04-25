# IoTMediator（USENIX Security 2023）

[English](README.md)

## 项目概览

本仓库是 USENIX Security 2023 论文实现：
[Detecting and Handling IoT Interaction Threats in Multi-Platform Multi-Control-Channel Smart Homes](https://www.usenix.org/conference/usenixsecurity23/presentation/chi)

运行时主流程与论文 overview 对应关系如下：

1. `screen.js`：基于规则和设备信息进行 CAI/CMAI 候选威胁静态筛选。
2. `verification.js`：在事件/命令流上进行运行时模式验证。
3. `handling.js`：给出缓解与执行决策（`allow` / `block`）。

`hooks.js` 负责统一接入事件流，并将其接入 verification 与 handling 流程。

## 当前项目结构

当前代码结构如下：

- `index.js`：服务模式运行入口。
- `hooks.js`、`screen.js`、`verification.js`、`handling.js`：核心检测与处置逻辑。
- `messenger/core`：内部状态管理与公共支撑模块。
- `messenger/connectors`：设备/平台连接器实现层。
- `messenger/adapters`：平台适配与路由边界层（`index.js` 调用）。
- `routes`、`views`、`public`、`config`、`bin`：Web 与服务侧组件。
- `evaluation`：论文复现实验脚本与数据。

### `messenger` 分层与论文对应

- `messenger/core`：对应中介器内部状态与公共服务。
- `messenger/connectors`：对应与设备/平台交互的连接层。
- `messenger/adapters`：对应对外平台适配边界层。

## 快速开始

1. 安装依赖：

```bash
npm install
```

2. 复制本地环境变量：

```bash
cp .env.example .env
```

3. 默认使用评估回放。请保持 `.env` 中如下开关为 `false`：

```bash
IOTMEDIATOR_REAL_INTEGRATION=false
```

4. 运行论文评估回放：

```bash
npm run sim:eval
```

如需启用真实连接器路由与设备/平台联调，将 `.env` 中开关设为：

```bash
IOTMEDIATOR_REAL_INTEGRATION=true
```

并补充 `.env` 中可选凭据项。

## 评估流程

评估会将 `evaluation/data` 下的固定日志回放到以下流程：

`hooks -> verification -> handling`

输出文件位于 `evaluation/results`：

- `evaluation/results/table7_replay.json`
- `evaluation/results/table8_replay.json`
- `evaluation/results/table9_replay.json`
- `evaluation/results/eval_replay_summary.json`

`eval_replay_summary.json` 中的 `raw_data` 使用仓库相对路径，便于跨机器复现。

也可直接执行：

```bash
node evaluation/simulator/run-paper-eval.js
```

## 说明

- 真实平台联调用到 `index.js` + `messenger/connectors` + `messenger/adapters`。
- 真实连接器最后一次系统级验证时间为 2023 年，较新平台 API 版本可能需要额外适配。

## 引用

如果本仓库对你的研究有帮助，欢迎引用：

```bibtex
@inproceedings{chi2023detecting,
  title={Detecting and Handling {IoT} interaction threats in multi-platform multi-control-channel smart homes},
  author={Chi, Haotian and Zeng, Qiang and Du, Xiaojiang},
  booktitle={32nd USENIX Security Symposium},
  pages={1559--1576},
  year={2023}
}
```
