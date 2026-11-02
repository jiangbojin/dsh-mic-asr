// dsh-mic-asr worker：以 dlopen 加载 libbase_asr.so（ASR / VAD / 声纹）与
// libbase_denoise.so（降噪），取出函数表：
// RTLD_NOW | RTLD_LOCAL，加载后先比对 API 版本。

#ifndef MIC_ASR_NATIVE_LIBRARIES_H_
#define MIC_ASR_NATIVE_LIBRARIES_H_

#include <memory>
#include <string>

#include "base_asr.h"
#include "base_denoise.h"

namespace mic_asr {

// 拥有 dlopen 句柄；析构时 dlclose。线程安全：构造后只读。
class SharedLibrary {
 public:
  [[nodiscard]] static std::unique_ptr<SharedLibrary> Open(
      const std::string& path,
      std::string* error);
  ~SharedLibrary();
  SharedLibrary(const SharedLibrary&) = delete;
  SharedLibrary& operator=(const SharedLibrary&) = delete;

  // 解析 name 到 *out；失败写 *error。
  template <typename Fn>
  bool Resolve(const char* name, Fn* out, std::string* error) const {
    void* sym = Lookup(name, error);
    // POSIX 保证 dlsym 返回的对象指针可转换为函数指针。
    *out = reinterpret_cast<Fn>(sym);
    return sym != nullptr;
  }

  const std::string& path() const { return path_; }

 private:
  SharedLibrary(void* handle, std::string path)
      : handle_(handle), path_(std::move(path)) {}
  void* Lookup(const char* name, std::string* error) const;

  void* handle_;
  const std::string path_;
};

// base_asr.h 中本演示用到的导出函数。
struct BaseAsrApi {
  decltype(&base_asr_api_version) api_version = nullptr;
  decltype(&base_asr_version) version = nullptr;
  decltype(&base_asr_create) create = nullptr;
  decltype(&base_asr_destroy) destroy = nullptr;
  decltype(&base_asr_accept_pcm16) accept_pcm16 = nullptr;
  decltype(&base_asr_finish) finish = nullptr;
  decltype(&base_asr_reset) reset = nullptr;
  decltype(&base_asr_vad_create) vad_create = nullptr;
  decltype(&base_asr_vad_destroy) vad_destroy = nullptr;
  decltype(&base_asr_vad_accept_pcm16) vad_accept_pcm16 = nullptr;
  decltype(&base_asr_vad_finish) vad_finish = nullptr;
  decltype(&base_asr_vad_reset) vad_reset = nullptr;
  decltype(&base_asr_speaker_create) speaker_create = nullptr;
  decltype(&base_asr_speaker_destroy) speaker_destroy = nullptr;
  decltype(&base_asr_speaker_dim) speaker_dim = nullptr;
  decltype(&base_asr_speaker_accept_pcm16) speaker_accept_pcm16 = nullptr;
  decltype(&base_asr_speaker_compute) speaker_compute = nullptr;
  decltype(&base_asr_speaker_reset) speaker_reset = nullptr;
  decltype(&base_asr_speaker_last_error) speaker_last_error = nullptr;
  decltype(&base_asr_speaker_registry_create) registry_create = nullptr;
  decltype(&base_asr_speaker_registry_destroy) registry_destroy = nullptr;
  decltype(&base_asr_speaker_registry_enroll) registry_enroll = nullptr;
  decltype(&base_asr_speaker_registry_remove) registry_remove = nullptr;
  decltype(&base_asr_speaker_registry_contains) registry_contains = nullptr;
  decltype(&base_asr_speaker_registry_verify) registry_verify = nullptr;
  decltype(&base_asr_speaker_registry_search) registry_search = nullptr;
};

// base_denoise.h 的全部导出函数。
struct DenoiseApi {
  decltype(&qnsz_denoise_api_version) api_version = nullptr;
  decltype(&qnsz_denoise_version) version = nullptr;
  decltype(&qnsz_denoise_create) create = nullptr;
  decltype(&qnsz_denoise_destroy) destroy = nullptr;
  decltype(&qnsz_denoise_sample_rate) sample_rate = nullptr;
  decltype(&qnsz_denoise_frame_size) frame_size = nullptr;
  decltype(&qnsz_denoise_latency_frames) latency_frames = nullptr;
  decltype(&qnsz_denoise_process) process = nullptr;
  decltype(&qnsz_denoise_reset) reset = nullptr;
  decltype(&qnsz_denoise_last_error) last_error = nullptr;
};

class AsrLibrary {
 public:
  [[nodiscard]] static std::unique_ptr<AsrLibrary> Load(const std::string& path,
                                                        std::string* error);
  const BaseAsrApi& api() const { return api_; }

 private:
  explicit AsrLibrary(std::unique_ptr<SharedLibrary> lib)
      : lib_(std::move(lib)) {}
  std::unique_ptr<SharedLibrary> lib_;
  BaseAsrApi api_;
};

class DenoiseLibrary {
 public:
  [[nodiscard]] static std::unique_ptr<DenoiseLibrary> Load(
      const std::string& path,
      std::string* error);
  const DenoiseApi& api() const { return api_; }

 private:
  explicit DenoiseLibrary(std::unique_ptr<SharedLibrary> lib)
      : lib_(std::move(lib)) {}
  std::unique_ptr<SharedLibrary> lib_;
  DenoiseApi api_;
};

}  // namespace mic_asr

#endif  // MIC_ASR_NATIVE_LIBRARIES_H_
