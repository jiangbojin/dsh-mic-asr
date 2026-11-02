#include "options.h"

#include <charconv>
#include <string>
#include <string_view>

namespace mic_asr {
namespace {

bool ParseInt(std::string_view text, int* out) {
  const char* end = text.data() + text.size();
  const auto result = std::from_chars(text.data(), end, *out);
  return result.ec == std::errc() && result.ptr == end;
}

}  // namespace

bool ParseOptions(int argc, char** argv, int first, WorkerOptions* out, std::string* error) {
  for (int i = first; i < argc; ++i) {
    const std::string_view arg = argv[i];
    const size_t eq = arg.find('=');
    if (arg.substr(0, 2) != "--" || eq == std::string_view::npos) {
      *error = "expected --name=value, got " + std::string(arg);
      return false;
    }
    const std::string_view name = arg.substr(2, eq - 2);
    const std::string value(arg.substr(eq + 1));
    int* integer = nullptr;
    if (name == "asr-library") {
      out->input.asr_library = value;
    } else if (name == "denoise-library") {
      out->input.denoise_library = value;
    } else if (name == "asr-model-dir") {
      out->input.models.asr_model_dir = value;
    } else if (name == "vad-model-dir") {
      out->input.models.vad_model_dir = value;
    } else if (name == "speaker-model-dir") {
      out->input.models.speaker_model_dir = value;
    } else if (name == "crash-dir") {
      out->crash_dir = value;
    } else if (name == "input-max-queued-ms") {
      integer = &out->input.max_queued_ms;
    } else {
      *error = "unknown option --" + std::string(name);
      return false;
    }
    if (integer != nullptr && !ParseInt(value, integer)) {
      *error = "--" + std::string(name) + " expects an integer, got " + value;
      return false;
    }
  }
  if (out->input.asr_library.empty()) {
    *error = "--asr-library is required";
    return false;
  }
  return true;
}

}  // namespace mic_asr
