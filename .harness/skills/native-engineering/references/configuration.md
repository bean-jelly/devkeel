# 原生工程配置

配置在项目 `.harness/native.json`，脚本只读此文件，不自动生成。
先按实际项目适配 [示例](../assets/native.example.json)，再执行；示例里的 profiles、presets 与本地配置目录都需核对。

## 字段与目录

- `schemaVersion`：当前为 `1`。
- `tools`：版本探针列表。
  每项包含 `name`、argv 数组 `command`，可选 `minVersion`、`maxVersionExclusive`、`acceptedExitCodes`（默认 `[0]`）。
  输出须含数字三段版本；非零退出码只有被显式接受且解析出满足范围的版本时才可通过。
  探针仅放只读版本查询。
- `profiles`：命名配置。
  每项可设置 `workingDirectory`、字符串映射 `environment`、相对工作目录的 `protectedFiles`、动作映射 `commands`。
- `commands`：`prepare`、`build`、`verify`、`deps-update` 各自的步骤数组。
  每步为 `name`、argv 数组 `command` 和可选正整数 `timeoutMs`。
  按顺序在同一工作目录执行，默认超时 10 分钟。

`--root` 默认为当前目录。
`--config` 相对项目根，默认 `.harness/native.json`；配置真实路径须在根目录内。
工作目录优先级为 `--workdir` → profile 的 `workingDirectory` → 唯一发现候选。
显式目录相对项目根，真实路径必须存在、为目录且在根范围内；多个发现候选时返回 BLOCKED。
不要求目录名为 `code/`。
只有一个 profile 时可自动选择，多个时传 `--profile`。

继承宿主环境，再覆盖 profile 的 `environment`；版本探测与实际步骤使用同一目录和环境。
MSVC 使用已激活的开发者命令环境；脚本不自动安装或激活 Visual Studio。
Windows 的 `.cmd/.bat` 需由项目提供明确的解释器调用，本脚本始终 `shell: false`，不会隐式拼接 shell 命令。

## 入口

```bash
node .harness/skills/native-engineering/scripts/native-engineering.mjs discover --root .
node .harness/skills/native-engineering/scripts/native-engineering.mjs doctor --root . --profile win-x86-debug
node .harness/skills/native-engineering/scripts/native-engineering.mjs build --root . --profile win-x86-debug
```

`discover` 无需配置，不运行外部命令；最多扫描四层，忽略 `.git`、`.harness`、`node_modules`、`build`、`dist`，不跟随符号链接。
结果只是 Conan/CMake 文件候选，模块与基础设施归属仍需核对。
`doctor` 验证配置、受保护文件及工具，只运行已配置的版本探针，不执行 profile 动作。

准备、构建、验证和依赖更新默认只输出 PLAN。
追加 `--execute` 才执行所选动作，先探测工具，失败或超时即停止后续依赖步骤。
空动作或未配置动作返回 BLOCKED。
超时尝试终止进程树，终止或管道收尾无法确认时有界返回 FAIL，并明确进程树停止尚未确认；此时先核对残留进程。

`build`、`verify` 保护 `protectedFiles` 与工作目录下的 `conan.lock`，逐步核对变化；显式声明的保护文件缺失时阻断，自动保护的 `conan.lock` 原先不存在时也会检测新增。
变化后返回 FAIL 并保留磁盘现状供审阅。
`prepare/build/verify` 中的 `--lockfile-out` 参数会被拒绝；写锁仅放在 `deps-update`，同样需 `--execute`。

示例 `deps-update` 用 `--lockfile=` 忽略旧锁，配合 `--update` 重新解析依赖并写出新锁，须审阅整个 lock diff。
若本次只想保留已有锁定并补充新增依赖，改用 `--lockfile=conan.lock --lockfile-partial --lockfile-out=conan.lock`；partial 本身不会更新已锁条目。

## 项目适配

示例使用 Conan 2、CMake ≥3.31、`win-x86-msvc142` host profile 与 Debug。
示例 configure 的 `conan-default` 对应 Visual Studio 多配置生成器，build 使用 `conan-debug`；Ninja 等单配置生成器可能两步都用 `conan-debug`。
以项目实际生成的 CMakePresets 为准，不因示例更改生成器。
build profile、运行库、NDK/ABI、编译器探针和测试命令来自实际项目；Conan 的 host profile 不等于 build profile。
没有 CTest preset 时，改用已有 `ctest --test-dir` 或项目测试脚本，保留无测试时失败的检查，不凭示例推断测试已经存在。

示例 `prepare` 从 `toolchains/conan-config` 安装本地 Conan 配置。
先核对其真实目录、来源与批准的 revision，以及本次写入的 Conan home；可在项目配置中显式指定 `CONAN_HOME`。
脚本不自动下载配置或选择全局 home，实际安装仅来自已授权并配置的准备步骤。

## 结果

正常输出为一个 JSON 对象，含 `schemaVersion/action/profile/workingDirectory/status` 和步骤结果；执行报告另含工具路径及版本。
步骤记录名称、状态、退出码、耗时和有限错误摘要。
PLAN 可列 argv；环境覆盖值和完整子进程日志不写入报告。
认证使用现有配置，命令参数不放凭据。
只有 PLAN/PASS 退出 `0`，BLOCKED/FAIL 退出 `1`，配置或参数错误在 stderr 报告并退出 `2`。
输出可由调用者重定向保存，脚本不自动写验证文档。
