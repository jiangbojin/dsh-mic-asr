# dsh-mic-asr 麦克风听写

中文 | [English](README.en.md)

[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（dsh）Web 端的麦克风听写插件：在本机做降噪和流式语音识别（ASR），配合语音活动检测（VAD）和声纹过滤，把你说完的句子插入输入框。音频不离开你的机器。

- **输入框麦克风**：按钮在输入框工具栏、提示词增强按钮之后。点一下开始听写，再点一下停止；按钮旁的 ▾ 选择麦克风。
- **边说边看**：按钮上方的气泡显示正在听到的文字；一句说完（停顿后）插入光标处，可以一步撤销。
- **降噪**：识别前先抑制环境噪音，风扇、键盘声不容易被识别成文字。可以在设置里关闭。
- **声纹过滤**：只插入通过声纹校验的句子，旁人说话、视频声音不会被写进输入框。也可以在设置里关闭。
- **状态栏实时线**：听写时，输入框下方的状态栏显示最近几秒的音量波形（检测到说话的段落加底色），以及本句声纹得分和过滤线。
- **插件页调试**：插件页里可以单独开一路听写，实时看电平、说话检测、识别文字、声纹得分和每句耗时，录入声纹，并实时调整参数。

## 运行要求

| 项 | 要求 |
|---|---|
| 系统 | Linux x86_64，glibc ≥ 2.35（如 Ubuntu 22.04 及以上），CPU 支持 AVX2 |
| dsh | 0.2.1-rc.5 及以上的 Web 端（`dsh web`） |
| 浏览器 | 能访问麦克风：页面需通过 `https://` 或 `http://localhost` 打开 |
| 磁盘 | 运行包约 290 MB（压缩包）/ 约 330 MB（解压后） |

## 安装

```sh
dsh plugin --profile web add dsh-mic-asr
```

然后重启 `dsh web`。首次启动时插件会从本仓库的 [GitHub Release](https://github.com/jiangbojin/dsh-mic-asr/releases) 下载运行包（worker 与语音库、模型），校验 SHA-256 后解压到 `$DSH_HOME/dsh-mic-asr/runtime/`（`DSH_HOME` 默认 `~/.dsh`）。下载期间按钮气泡会显示进度。

## 使用

1. 打开「插件」→「dsh-mic-asr 麦克风听写」，点「开始调试」，按提示依次念三段示例文字，完成声纹注册。没有注册时识别结果不会插入；如果只有你一个人在用，也可以在同一页关闭「启用声纹过滤」。
2. 回到任意会话，点输入框里的麦克风，说话，停顿一下，句子就会插入。
3. 没有反应时看按钮上方的提示：「没有收到声音」说明麦克风选错了或没有权限；「声纹校验没通过」说明识别正常、只是得分低于阈值，可以在插件页调低「声纹阈值」或重新注册。

## 配置

在 profile 的 `cordis.patch.yml` 里按条目 id `mic-asr` 覆盖，或者直接在插件页修改。`voice` 下的字段保存后从下一句起生效，不用重启；其他字段需要重启。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dataRoot` | `$DSH_HOME/dsh-mic-asr` | 运行包、声纹 `speaker.json`、崩溃报告所在目录 |
| `runtime.url` | 本版本对应的 Release 资产 | 运行包下载地址，可换成镜像 |
| `runtime.sha256` | 本版本对应的校验值 | 运行包的 SHA-256；地址和校验值一起换 |
| `paths.*` | 空 | 分别覆盖 worker、语音库、降噪库和三个模型目录；全部填写时不下载运行包 |
| `voice.vadThreshold` | `0.5` | 说话检测阈值，调高更不容易被噪音触发 |
| `voice.vadMinSpeechMs` | `100` | 连续人声多久才算开口 |
| `voice.vadMinSilenceMs` | `300` | 静音多久算一句说完 |
| `voice.asrChunkMs` | `480` | 识别分块，`160` 时文字刷新更快、CPU 约翻倍 |
| `voice.asrPrerollMs` | `200` | 开口前一并送去识别的音频，避免丢第一个字 |
| `voice.vadBarge` | `false` | 为 `true` 时关闭声纹过滤，任何人的句子都插入 |
| `voice.speakerThreshold` | `0.5` | 声纹阈值，得分高于它才插入 |
| `voice.verifyMs` | `3000` | 说到这么长时先做一次声纹验证 |
| `voice.denoise` | `true` | 识别前先降噪；注册声纹时必须开启 |

示例：用镜像下载运行包

```yaml
- id: mic-asr
  config:
    runtime:
      url: https://example.com/mirror/dsh-mic-asr-runtime-v1-linux-x64.tar.gz
```

## 隐私

- 识别、说话检测和声纹校验都在本机进程里完成，不向任何服务发送音频。
- 声纹保存在 `dataRoot/speaker.json`（权限 0600）；重新注册或清除时，上一份保留为 `speaker.previous.json`。删除这两个文件即可彻底清除声纹。
- worker 崩溃时，会把调用栈和最近一分钟的麦克风音频写到 `dataRoot/crashes/`，便于复现问题；可以随时删除。

## 工作方式

浏览器以 16 kHz 采集麦克风，通过 dsh 的 Remote 流把音频送到宿主；宿主插件管理一个本地 worker 进程（`dsh-mic-asr-worker`），worker 依次做降噪、说话检测、流式识别和声纹校验，把实时文字和最终结果流回浏览器。同一个 dsh 宿主同时只有一路听写，新打开的会替换旧的。

## 从源码构建

```sh
pnpm install
pnpm build          # 宿主与浏览器产物，写入 packages/dsh-mic-asr/lib/
pnpm test
pnpm build:native   # worker 可执行文件，写入 native/build/
```

worker 的 C++ 源码在 `native/`，通过 `dlopen` 加载运行包里的语音库，`native/include/` 是这些库的 C 头文件。`scripts/package-runtime.sh` 把 worker、语音库和模型打成 Release 用的运行包。

## 许可

本仓库代码以 [Apache License 2.0](LICENSE) 发布。运行包里的语音库和模型文件是闭源的，只提供二进制，不在本仓库的许可范围内，见 [NOTICE](NOTICE)。

## 已知限制

- 只支持 Linux x86_64。
- 同一个 dsh 宿主同时只能有一处在听写。
- 首次使用需要下载约 290 MB 的运行包。
