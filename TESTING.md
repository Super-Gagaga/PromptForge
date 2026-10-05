# 测试与 DSH 兼容性排查

## 常用命令

需要 Node.js 24 或更新版本。测试不依赖真实模型或网络，不读取真实的模型凭证；设置与工作区使用测试临时目录，完成后清理。

```powershell
npm test                 # 构建、全部离线测试、源码覆盖率门槛、图片和文档检查
npm run test:unit        # 分文件的单元与契约测试
npm run test:integration # 原有 87 项离线端到端自检
npm run test:coverage    # 全部离线测试及覆盖率门槛
npm run test:dsh         # 检查本机已安装 DSH 的接口标记
```

单独定位某类失败：

```powershell
node --test tests/client.test.mjs
node --test tests/host.test.mjs
node --test tests/skin.test.mjs
node --test --test-name-pattern="stream" tests/host.test.mjs
```

直接运行测试文件前先执行 `npm run build`，因为测试加载的是实际构建产物。

## 测试分层

| 文件 | 覆盖内容 | DSH 更新后的优先排查点 |
| --- | --- | --- |
| `tests/host.test.mjs` | HTTP 请求与方法、流式响应、取消、路由选择、原子存储、服务缺失、引用权限 | `llm.stream`、finish 原因、WebServer、文件与技能服务 |
| `tests/client.test.mjs` | 设置与模型目录、异常响应、锁定草稿、下拉菜单、搜索、保存、计时器、订阅 | Remote 返回信封、模型目录、输入状态与 actions |
| `tests/skin.test.mjs` | 样式去重与清理、导航标签、DOM 变化、无浏览器环境 | Settings DOM、语言标签、MutationObserver |
| `tests/shared.test.mjs` | 默认值、旧设置迁移、文件与技能手势、JSON 信封 | DSH 的引用和技能调用语法 |
| `tools/selfcheck.mjs` | 构建加载、槽位装配、完整请求、引用校验、迟到响应、连续保存 | 两个插件半体之间的完整链路 |

当前没有独立的 `src/skin.js`：样式与导航图标代码在 `src/client.js`，由 `tests/skin.test.mjs` 测试。`tests/runtime.mjs` 只为测试开放私有函数，不改变发布产物的 exports。

React harness 是受控的测试替身，不是完整 React renderer。菜单键盘、DOM 和清理行为通过事件替身检查；真实 React 调度、浏览器布局和 DSH 的运行时服务仍需要应用内复核。

## 覆盖率

`tools/coverage.mjs` 读取 V8 原始覆盖率，并记录每段动态执行脚本的准确文本。按顺序匹配源码行，将 Host 与 Client 中重复内联的 Shared 代码合并，并合并同一位置在不同测试进程中的命中结果。测试、生成包装和临时私有 exports 不计入源码报告。源码对齐失败会直接报错，避免静默漏统计。

结果写入 `coverage/summary.json`，包括每个源码文件的比例和未命中行号。该目录不提交。

- 行覆盖：映射到源码的非空、非独立注释行，按 V8 最内层范围的命中结果统计。CSS 模板字面量也属于已执行的源码行；它的命中不等于视觉验证。
- 分支覆盖：V8 的嵌套执行块范围，包含条件路径和部分默认参数路径，不等同于 Istanbul 的分支定义。
- 函数覆盖：映射到源码的函数范围，包含匿名回调。

2026-10-06 的测试结果：行覆盖 99.22%、V8 分支块覆盖 83.49%、函数覆盖 94.38%。这不是完全覆盖；具体剩余位置以当前生成的 JSON 为准。覆盖率也不能证明 DSH 上游实现符合测试替身。

`tests/coverage-thresholds.json` 为每个文件设置独立门槛。新增代码降低覆盖率会让 `npm test` 失败；修复时应补测试，不应直接降低门槛来通过检查。

## DSH 更新后如何定位

1. 运行 `npm test`。先排除插件自身的行为回归，失败测试名会指出涉及的契约。
2. 运行 `npm run test:dsh`。探针会输出检查项、DSH 包名和版本，以及缺失标记。
3. 对照失败模块，更新真实接口对应的 fixture 和实现，再加入能重现旧实现失败的回归用例。
4. 重启 DSH，在应用中复核：模型目录能加载；优化只替换草稿；编辑、发送或切换会话后迟到结果不覆盖输入；文件与技能引用可用；设置能保存并回读。

探针默认读取 Windows 的 `%LOCALAPPDATA%/Programs/DeepSeek Harness`。其他安装目录可指定：

```powershell
$env:DSH_INSTALL_DIR = 'D:/Apps/DeepSeek Harness'
npm run test:dsh
```

探针通过已安装的 Electron 以 Node 模式读取 ASAR，只检查包、构建文件及接口标记，不启动 DSH 服务、不调用模型。它是结构变化的早期提示，不能验证参数类型、服务行为或模型响应；包被拆分或文件移动也会触发失败，需要结合上游代码判断。它依赖本机安装，因此不放进跨平台 CI。

GitHub Actions 在 Windows 和 Ubuntu、Node.js 24 上执行 `npm test`。真实模型和桌面联调不属于此 CI。
