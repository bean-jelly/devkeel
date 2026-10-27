---
name: native-engineering
description: 在 Conan/CMake、MSVC、Android/JNI 或 Electron 原生项目中，检查工具与工作目录，编排已配置的环境准备、构建、验证和依赖更新。
metadata:
  author: "devkeel"
  version: "1.0.0"
---

# 原生工程

## 何时使用

原生项目需要复用环境检查、Conan/CMake 构建或已确认的测试入口时使用。
通过 `scripts/native-engineering.mjs` 执行项目配置；新增测试基建仍由 `verify-init` 处理。

## 流程

1. 读取目标项目的 presets、Conan profiles、脚本和配置归属，确定实际工具、命令及工作目录。
   配置缺失或需调整时读取[配置说明](references/configuration.md)，按项目适配示例后保存 `.harness/native.json`；可从现有配置查到的参数以现有配置为准。
2. 运行 `discover` 定位原生构建入口，结合明确的项目配置选目录；多个候选时报告差异，只在无法从现有决定确定归属时询问。
   工作目录可以是根目录、`src/native/` 或其他实际路径。
3. 运行 `doctor` 检查工具与必要文件。
   MSVC 先激活对应开发者环境；`cl` 不在当前 PATH 只表示当前会话未就绪，不能据此断言 Visual Studio 未安装。
4. 检查所选动作的 PLAN，在已授权范围内追加 `--execute` 执行。
   分别报告构建、自动测试、Android/JNI 或 Electron 集成、设备运行的实际结果与未验证层次。

## Hard Rules

- 正常构建与验证消费现有锁文件；依赖更新使用独立 `deps-update`。
  保护文件变化时停止，保留实际差异供审阅，不静默恢复或把失败写成通过。
- `prepare` 只执行项目配置中已确认的准备命令。
  Conan 配置来源、revision 和目标 home 必须对应项目约定；普通构建不顺带安装工具或覆盖全局 Conan 配置。
- 项目配置与版本探针是受信任的本地执行输入，脚本不提供沙箱。
  凭据通过已有认证配置提供，不写入命令参数或示例；公共模板不嵌入内部服务地址，项目可使用获准的团队源。
- 只有项目明确确认时，`gaia.cmake` 才按构建基础设施 submodule 例外处理。
  工具版本与 submodule 策略均按项目要求确定，示例的 Conan 2、CMake 3.31 不自动成为全部项目的规范。

脚本只编排已配置命令；工具就绪与 C++ 编译通过都不能代替跨层集成或真机验证。
