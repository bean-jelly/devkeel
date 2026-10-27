# 领域 → 技术栈 → 测试框架映射表

stack-matrix 是 Phase 1 推荐框架的权威来源。
覆盖前端/后端/移动端/CLI·库及系统/C++、桌面原生桥。
每个技术栈给出现有验证位置与可选测试工具；优先复用项目已有测试，不强装 GoogleTest。

## 前端

| 信号 | 领域 | 单元测试 | e2e |
|------|------|---------|-----|
| react/next + vite | frontend-react | vitest + @testing-library/react + jsdom | Playwright |
| vue/nuxt | frontend-vue | vitest + @vue/test-utils + jsdom | Playwright |
| angular | frontend-angular | vitest（Angular test bed）/ Karma（老项目） | Playwright |
| svelte/sveltekit | frontend-svelte | vitest + @testing-library/svelte + jsdom | Playwright |

**前端共性**：jsdom 提供 DOM 环境；e2e 统一 Playwright（跨浏览器、自动等待、trace viewer）。

## 后端

| 信号 | 领域 | 单元测试 | API 测试 |
|------|------|---------|---------|
| express/fastify/nestjs/koa | backend-node | vitest（已有 Jest 则沿用 Jest） | supertest |
| fastapi/django/flask | backend-python | pytest | pytest + httpx / TestClient |
| gin/echo/fiber | backend-go | testing + testify | net/http/httptest + testify |
| pom.xml + spring | backend-java-spring | JUnit 5 + Mockito | MockMvc / RestAssured |

**后端共性**：API 测试优先用「内存内启服务 + HTTP 客户端调」，避免起独立进程。

## 移动端

| 信号 | 领域 | 单元测试 | UI/e2e |
|------|------|---------|--------|
| react-native | react-native | jest + @testing-library/react-native | Detox / Maestro |
| pubspec.yaml | flutter | flutter test（SDK 内置） | integration_test |
| *.xcodeproj / Package.swift | ios-swift | XCTest | XCUITest |
| build.gradle + android | android | JUnit 4 + Robolectric | Espresso |

## CLI / 库

| 信号 | 领域 | 单元测试 | 集成/e2e |
|------|------|---------|---------|
| commander/yargs/bin | cli-node | vitest + execa（子进程执行） | execa 跑真实 bin |
| clap / Cargo.toml `[[bin]]` | cli-rust | cargo test + assert_cmd | assert_cmd |
| go.mod + 根目录 main.go | cli-go | testing + testify | 黄金文件对比 |
| exports/main 无 bin 无前端框架 | library-node | vitest | — |
| `[lib]` / 纯库 pyproject | library-python | pytest | — |

**CLI 共性**：集成测试用「编译后真实 bin 子进程执行 + 断言 stdout/exit code」；库只做单测，无 e2e 段。

## 系统 / C++ 与桌面原生桥

| 信号 | 领域 | 优先检查的可执行验证位置 | 说明 |
|------|------|---------|---------|
| CMake + C/C++ targets | cpp | CTest 注册的测试、项目已有 test target 或测试脚本 | 从实际 CMake preset/target 和运行目录确认入口；不默认安装 GoogleTest |
| Conan + CMake 原生目标 | cpp | Conan profile/install 之后项目已有 CMake/CTest 测试入口 | 环境与构建步骤见[原生工程能力](../../native-engineering/SKILL.md) |
| Electron/Tauri 桌面宿主 | desktop | 主进程/renderer 既有测试、应用启动与 IPC 集成入口 | 可与前端、Node addon 或独立 C++ 进程组合；桌面验证不依赖必须存在 addon |
| Electron + Node-API/N-API/node-addon-api 原生模块 | desktop + cpp | Electron/Node 层既有测试 + 原生模块构建/CTest 或项目集成测试入口 | 分别记录 JS/TS 与 C++ 的 manifest、构建入口、测试命令和运行目录 |
| Android + Kotlin DSL + JNI/NDK | android + cpp | Gradle 单元/instrumented 测试 + CMake/NDK 目标的既有测试入口 | Kotlin DSL、Java/Kotlin 与 JNI 归属同一 Android 模块时不重复当成独立项目 |

若未发现测试框架，先记录现有构建和可执行验证入口，再依据项目既有测试约定提出候选；没有证据时不强加 GoogleTest 或其他框架。

## Monorepo 处理

`pnpm-workspace.yaml` / `lerna.json` / `nx.json` 命中时，按各 manifest 和测试配置识别根项目、
共享基建与子项目。分别使用本矩阵，不用主包技术栈代替所有子包；Phase 2 确认目标范围、
依赖 owner 与运行目录。规则和知识按作用域维护，避免重复安装与重复文档。

## 未命中（custom）

检测不到明确技术栈 → 标 `custom:<标签>`：

- 只整理已确认的基础结构、测试约束和项目知识
- 不强制装框架，提示用户手动指定领域或框架
- 验证 agent 仍可生成（变更驱动验证不依赖具体框架，跑用户已有的 test 命令）

## 选型原则

1. **自动识别优先** — 扫描项目信号匹配技术栈，取该技术栈最合适的框架
2. **已有框架沿用** — 检测到已有 vitest/Jest 等，不强行换；只补缺失类型
3. **2026 主流选型** — 前端默认 vitest（Vite 原生、更快），Jest 仅老项目降级
4. **跨栈一致** — e2e 统一 Playwright（前端/移动端 webview）；API 测试用内存 HTTP 客户端
5. **可调** — 用户可在 Phase 2 取消任何推荐项或补充自定义框架

## 脚手架产出路径

本表给出可覆盖的框架推荐，不绑定固定 config 配方。每个技术栈的具体安装/config/示例/scripts 由 Agent 凭官方文档产出（见 `frameworks-index.md` 定位方法论 + `scaffolding-principles.md` 产出清单），推荐项可被官方文档或用户在 Phase 2 推翻。

custom 领域无推荐锚点，按本地证据维护共用规则与项目文档，Agent 仍可凭官方文档产出脚手架。
