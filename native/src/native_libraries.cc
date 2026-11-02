#include "native_libraries.h"

#include <dlfcn.h>

#include <memory>
#include <string>
#include <utility>

namespace mic_asr {

std::unique_ptr<SharedLibrary> SharedLibrary::Open(const std::string& path,
                                                   std::string* error) {
  void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
  if (handle == nullptr) {
    const char* reason = dlerror();
    *error = "dlopen " + path +
             " failed: " + (reason != nullptr ? reason : "unknown");
    return nullptr;
  }
  return std::unique_ptr<SharedLibrary>(new SharedLibrary(handle, path));
}

SharedLibrary::~SharedLibrary() {
  dlclose(handle_);
}

void* SharedLibrary::Lookup(const char* name, std::string* error) const {
  dlerror();
  void* sym = dlsym(handle_, name);
  if (sym == nullptr) {
    const char* reason = dlerror();
    *error = path_ + ": dlsym " + name +
             " failed: " + (reason != nullptr ? reason : "symbol is NULL");
  }
  return sym;
}

std::unique_ptr<AsrLibrary> AsrLibrary::Load(const std::string& path,
                                             std::string* error) {
  std::unique_ptr<SharedLibrary> lib = SharedLibrary::Open(path, error);
  if (lib == nullptr) {
    return nullptr;
  }
  BaseAsrApi a;
  const SharedLibrary& l = *lib;
  const bool ok =
      l.Resolve("base_asr_api_version", &a.api_version, error) &&
      l.Resolve("base_asr_version", &a.version, error) &&
      l.Resolve("base_asr_create", &a.create, error) &&
      l.Resolve("base_asr_destroy", &a.destroy, error) &&
      l.Resolve("base_asr_accept_pcm16", &a.accept_pcm16, error) &&
      l.Resolve("base_asr_finish", &a.finish, error) &&
      l.Resolve("base_asr_reset", &a.reset, error) &&
      l.Resolve("base_asr_vad_create", &a.vad_create, error) &&
      l.Resolve("base_asr_vad_destroy", &a.vad_destroy, error) &&
      l.Resolve("base_asr_vad_accept_pcm16", &a.vad_accept_pcm16, error) &&
      l.Resolve("base_asr_vad_finish", &a.vad_finish, error) &&
      l.Resolve("base_asr_vad_reset", &a.vad_reset, error) &&
      l.Resolve("base_asr_speaker_create", &a.speaker_create, error) &&
      l.Resolve("base_asr_speaker_destroy", &a.speaker_destroy, error) &&
      l.Resolve("base_asr_speaker_dim", &a.speaker_dim, error) &&
      l.Resolve("base_asr_speaker_accept_pcm16", &a.speaker_accept_pcm16,
                error) &&
      l.Resolve("base_asr_speaker_compute", &a.speaker_compute, error) &&
      l.Resolve("base_asr_speaker_reset", &a.speaker_reset, error) &&
      l.Resolve("base_asr_speaker_last_error", &a.speaker_last_error,
                error) &&
      l.Resolve("base_asr_speaker_registry_create", &a.registry_create,
                error) &&
      l.Resolve("base_asr_speaker_registry_destroy", &a.registry_destroy,
                error) &&
      l.Resolve("base_asr_speaker_registry_enroll", &a.registry_enroll,
                error) &&
      l.Resolve("base_asr_speaker_registry_remove", &a.registry_remove,
                error) &&
      l.Resolve("base_asr_speaker_registry_contains", &a.registry_contains,
                error) &&
      l.Resolve("base_asr_speaker_registry_verify", &a.registry_verify,
                error) &&
      l.Resolve("base_asr_speaker_registry_search", &a.registry_search, error);
  if (!ok) {
    return nullptr;
  }
  const uint32_t version = a.api_version();
  if (version != BASE_ASR_API_VERSION) {
    *error = path + ": base_asr_api_version() = " + std::to_string(version) +
             ", expected " + std::to_string(BASE_ASR_API_VERSION);
    return nullptr;
  }
  std::unique_ptr<AsrLibrary> out(new AsrLibrary(std::move(lib)));
  out->api_ = a;
  return out;
}

std::unique_ptr<DenoiseLibrary> DenoiseLibrary::Load(const std::string& path,
                                                     std::string* error) {
  std::unique_ptr<SharedLibrary> lib = SharedLibrary::Open(path, error);
  if (lib == nullptr) {
    return nullptr;
  }
  DenoiseApi a;
  const SharedLibrary& l = *lib;
  const bool ok =
      l.Resolve("qnsz_denoise_api_version", &a.api_version, error) &&
      l.Resolve("qnsz_denoise_version", &a.version, error) &&
      l.Resolve("qnsz_denoise_create", &a.create, error) &&
      l.Resolve("qnsz_denoise_destroy", &a.destroy, error) &&
      l.Resolve("qnsz_denoise_sample_rate", &a.sample_rate, error) &&
      l.Resolve("qnsz_denoise_frame_size", &a.frame_size, error) &&
      l.Resolve("qnsz_denoise_latency_frames", &a.latency_frames, error) &&
      l.Resolve("qnsz_denoise_process", &a.process, error) &&
      l.Resolve("qnsz_denoise_reset", &a.reset, error) &&
      l.Resolve("qnsz_denoise_last_error", &a.last_error, error);
  if (!ok) {
    return nullptr;
  }
  const uint32_t version = a.api_version();
  if (version != QNSZ_DENOISE_API_VERSION) {
    *error = path + ": qnsz_denoise_api_version() = " +
             std::to_string(version) + ", expected " +
             std::to_string(QNSZ_DENOISE_API_VERSION);
    return nullptr;
  }
  std::unique_ptr<DenoiseLibrary> out(new DenoiseLibrary(std::move(lib)));
  out->api_ = a;
  return out;
}

}  // namespace mic_asr
