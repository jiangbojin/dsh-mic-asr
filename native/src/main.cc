// dsh-mic-asr worker entry point.
//   dsh-mic-asr-worker serve [options]   stdio frame protocol (protocol.h) for the dsh host: denoise, VAD, streaming
//                                        recognition and speaker verification of uplink audio

#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "crash_report.h"
#include "input.h"
#include "options.h"
#include "protocol.h"

namespace mic_asr {
namespace {

void Log(FrameWriter& out, uint8_t level, std::string_view text) {
  out.Write(FrameType::kLog, PayloadWriter().Put<uint8_t>(level).PutText(text));
}

int Serve(const WorkerOptions& options) {
  InstallCrashReport(options.crash_dir);
  FrameWriter out(STDOUT_FILENO);
  std::string error;
  auto input = std::make_unique<InputPipeline>(out, options.input);
  input->Start();

  for (;;) {
    std::optional<WireFrame> frame = ReadFrame(STDIN_FILENO, &error);
    if (!frame) break;
    PayloadReader in(frame->payload);
    switch (frame->type) {
      case FrameType::kAudio: {
        if (frame->payload.size() % sizeof(int16_t) != 0) {
          error = "malformed audio frame";
          break;
        }
        {
          std::vector<int16_t> samples(frame->payload.size() / sizeof(int16_t));
          std::memcpy(samples.data(), frame->payload.data(), frame->payload.size());
          input->PushAudio(std::move(samples));
        }
        continue;
      }
      case FrameType::kVoiceParams: {
        VoiceParams params;
        const auto threshold = in.Get<float>();
        const auto min_speech = in.Get<int32_t>();
        const auto min_silence = in.Get<int32_t>();
        const auto chunk = in.Get<int32_t>();
        const auto preroll = in.Get<int32_t>();
        const auto vad_barge = in.Get<uint8_t>();
        const auto spk_threshold = in.Get<float>();
        const auto t_verify = in.Get<int32_t>();
        const auto denoise = in.Get<uint8_t>();
        if (!denoise) {
          error = "malformed voice params frame";
          break;
        }
        params.vad_threshold = *threshold;
        params.vad_min_speech_ms = *min_speech;
        params.vad_min_silence_ms = *min_silence;
        params.asr_chunk_ms = *chunk;
        params.asr_preroll_ms = *preroll;
        params.vad_barge = *vad_barge != 0;
        params.spk_threshold = *spk_threshold;
        params.t_verify_ms = *t_verify;
        params.denoise = *denoise != 0;
        input->SetParams(params);
        continue;
      }
      case FrameType::kEnroll:
        if (const auto action = in.Get<uint8_t>(); action && *action >= 1 && *action <= 3) {
          input->Enroll(*action);
          continue;
        }
        error = "malformed enroll frame";
        break;
      case FrameType::kEnrollRestore: {
        EnrollState saved;
        const auto denoise = in.Get<uint8_t>();
        const auto count = in.Get<uint32_t>();
        const auto dim = in.Get<uint32_t>();
        std::optional<std::vector<float>> data;
        if (count && dim && *count <= 16 && *dim <= 4096) data = in.GetArray<float>(size_t{*count} * *dim);
        const auto n = data ? in.Get<uint32_t>() : std::nullopt;
        const auto durations = n && *n <= 16 ? in.GetArray<double>(*n) : std::nullopt;
        if (!denoise || !durations) {
          error = "malformed enroll restore frame";
          break;
        }
        saved.denoise_at_enroll = *denoise != 0;
        for (uint32_t i = 0; i < *count; ++i) {
          saved.embeddings.emplace_back(data->begin() + i * *dim, data->begin() + (i + 1) * *dim);
        }
        saved.durations_s = *durations;
        input->Restore(std::move(saved));
        continue;
      }
      case FrameType::kResetStream:
        input->ResetStream();
        continue;
      default:
        error = "unknown frame type " + std::to_string(static_cast<int>(frame->type));
        break;
    }
    break;
  }
  if (!error.empty()) {
    Log(out, 2, "protocol error: " + error);
    std::fprintf(stderr, "dsh-mic-asr-worker: protocol error: %s\n", error.c_str());
  }
  input.reset();
  return error.empty() ? 0 : 2;
}

}  // namespace
}  // namespace mic_asr

int main(int argc, char** argv) {
  const std::string_view mode = argc > 1 ? argv[1] : "";
  mic_asr::WorkerOptions options;
  std::string error;
  if (mode != "serve" || !mic_asr::ParseOptions(argc, argv, 2, &options, &error)) {
    std::fprintf(stderr, "usage: dsh-mic-asr-worker serve --asr-library=PATH --asr-model-dir=PATH --vad-model-dir=PATH "
                         "--speaker-model-dir=PATH [--denoise-library=PATH] [--crash-dir=PATH]\n%s\n",
                 error.c_str());
    return 64;
  }
  return mic_asr::Serve(options);
}
