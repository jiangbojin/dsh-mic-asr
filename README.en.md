# dsh-mic-asr microphone dictation

[中文](README.md) | English

A microphone dictation plugin for the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh) Web app: local streaming speech recognition (ASR) with voice activity detection (VAD) and voiceprint filtering inserts each finished sentence into the composer. Audio never leaves your machine.

- **Composer microphone**: a button in the composer toolbar, right after the prompt-enhance button. Click to start dictating, click again to stop; the ▾ next to it chooses the microphone.
- **See what is heard**: a bubble above the button shows the text being heard; a finished sentence (after a pause) is inserted at the caret as one undo step.
- **Voiceprint filtering**: only sentences that pass speaker verification are inserted, so other people and video sound stay out of the composer. It can be turned off.
- **Live line in the status row**: while dictating, the status row under the composer shows the last few seconds of input level (detected speech shaded) and the sentence's speaker score against the filter line.
- **Tuning on the Plugins page**: open a dictation stream on the plugin page to watch levels, voice activity, recognized text, speaker scores and per-sentence latency, enroll your voiceprint, and adjust parameters live.

## Requirements

| Item | Requirement |
|---|---|
| System | Linux x86_64 with glibc ≥ 2.35 (for example Ubuntu 22.04 or later) and an AVX2 CPU |
| dsh | The Web app (`dsh web`) of 0.2.1-rc.5 or later |
| Browser | Microphone access: open the page over `https://` or `http://localhost` |
| Disk | About 290 MB for the runtime archive, about 330 MB unpacked |

## Install

```sh
dsh plugin --profile web add dsh-mic-asr
```

Then restart `dsh web`. On first start the plugin downloads the runtime (worker, speech libraries and models) from this repository's [GitHub Releases](https://github.com/jiangbojin/dsh-mic-asr/releases), verifies its SHA-256 and unpacks it into `$DSH_HOME/dsh-mic-asr/runtime/` (`DSH_HOME` defaults to `~/.dsh`). The button bubble shows the download progress.

## Use

1. Open Plugins → "dsh-mic-asr microphone dictation", press "Start tuning" and read the three sample texts to enroll your voiceprint. Without an enrollment nothing is inserted; if you are the only speaker, you can turn off "Voiceprint filter" on the same page instead.
2. In any session, click the microphone in the composer, speak and pause; the sentence is inserted.
3. If nothing happens, read the bubble above the button: "No sound" means the wrong microphone or no permission; "Speaker verification failed" means recognition works but the score is below the threshold, so lower "Voiceprint threshold" on the plugin page or enroll again.

## Configuration

Override row `mic-asr` in the profile's `cordis.patch.yml`, or edit it on the plugin page. Fields under `voice` apply from the next sentence without a restart; the others need a restart.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | `$DSH_HOME/dsh-mic-asr` | Directory of the runtime, the voiceprint `speaker.json` and crash reports |
| `runtime.url` | The Release asset of this version | Runtime download URL; point it at a mirror if needed |
| `runtime.sha256` | The digest of that asset | SHA-256 of the runtime archive; change it together with the URL |
| `paths.*` | empty | Override the worker, speech library, denoise library and the three model directories; with all of them set, no runtime is downloaded |
| `voice.vadThreshold` | `0.5` | Voice activity threshold; higher ignores more noise |
| `voice.vadMinSpeechMs` | `100` | Continuous voice needed before speech starts |
| `voice.vadMinSilenceMs` | `300` | Silence that ends a sentence |
| `voice.asrChunkMs` | `480` | Recognizer chunk; `160` refreshes partial text faster at about twice the CPU |
| `voice.asrPrerollMs` | `200` | Audio before the speech start that is also recognized, so the first word is kept |
| `voice.vadBarge` | `false` | `true` turns voiceprint filtering off and inserts anyone's sentences |
| `voice.speakerThreshold` | `0.5` | Voiceprint threshold; only scores above it are inserted |
| `voice.verifyMs` | `3000` | Speech length at which the voiceprint is checked early |
| `voice.denoise` | `true` | Denoise before recognition; required while enrolling |

Example: download the runtime from a mirror

```yaml
- id: mic-asr
  config:
    runtime:
      url: https://example.com/mirror/dsh-mic-asr-runtime-v1-linux-x64.tar.gz
```

## Privacy

- Recognition, voice activity detection and speaker verification all run in a local process; no audio is sent anywhere.
- The voiceprint is stored in `dataRoot/speaker.json` (mode 0600); enrolling again or clearing keeps the previous one as `speaker.previous.json`. Delete both files to remove the voiceprint completely.
- When the worker crashes, it writes the backtrace and the last minute of microphone audio to `dataRoot/crashes/` so the problem can be reproduced; you can delete them at any time.

## How it works

The browser captures the microphone at 16 kHz and streams it to the Host over a dsh Remote stream. The Host plugin runs a local worker process (`dsh-mic-asr-worker`) that denoises, detects voice activity, recognizes speech and verifies the speaker, and streams partial and final text back to the browser. One dsh Host runs one dictation at a time; a new one replaces the old.

## Build from source

```sh
pnpm install
pnpm build          # Host and browser outputs in packages/dsh-mic-asr/lib/
pnpm test
pnpm build:native   # the worker executable in native/build/
```

The worker's C++ source is in `native/`; it loads the runtime's speech libraries with `dlopen`, and `native/include/` holds their C headers. `scripts/package-runtime.sh` packs the worker, libraries and models into the runtime archive for a Release.

## License

The code in this repository is released under the [Apache License 2.0](LICENSE). The speech libraries and model files in the runtime are closed-source, provided in binary form only, and not covered by this license; see [NOTICE](NOTICE).

## Known limitations

- Linux x86_64 only.
- One dsh Host dictates in one place at a time.
- First use downloads a runtime of about 290 MB.
