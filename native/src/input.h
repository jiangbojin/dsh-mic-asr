// dsh-mic-asr worker: the recognition thread. It owns the VoiceProcessor (denoise, VAD, ASR, speaker
// verification and enrollment), consumes uplink audio and commands in order, and reports voice events
// as protocol frames.

#ifndef MIC_ASR_INPUT_H_
#define MIC_ASR_INPUT_H_

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <variant>
#include <vector>

#include "native_libraries.h"
#include "protocol.h"
#include "voice_processor.h"

namespace mic_asr {

struct InputOptions {
  std::string asr_library;
  std::string denoise_library;  // empty: denoise unavailable
  VoiceProcessorConfig models;
  // Uplink audio waiting for the recognition thread beyond this is dropped, oldest first.
  int max_queued_ms = 3000;
};

// Voice event kinds of FrameType::kVoiceEvent.
enum class VoiceEventKind : uint8_t {
  kSpeechStart = 1,  // u8 barge_enabled | i64 onset_ns | i64 confirm_ns
  kSpeechEnd = 2,    // f64 duration_s | i64 speech_end_ns
  kPartial = 3,      // text
  kScore = 4,        // u8 stage | f32 score | u8 accepted | u8 decisive | f64 audio_s
  kFinal = 5,        // u8 accepted | i64 speech_end_ns | i64 final_ns | text
  kError = 6,        // text
};

class InputPipeline {
 public:
  InputPipeline(FrameWriter& out, InputOptions options);
  ~InputPipeline();  // stops and joins the thread
  InputPipeline(const InputPipeline&) = delete;
  InputPipeline& operator=(const InputPipeline&) = delete;

  // Loads the libraries and models on the recognition thread, then reports kInputReady.
  void Start();
  // Any thread. 16 kHz mono samples, any length; split into 10 ms frames on the thread.
  void PushAudio(std::vector<int16_t> samples);
  void SetParams(const VoiceParams& params);
  // 1 begin, 2 end, 3 reset.
  void Enroll(uint8_t action);
  void Restore(EnrollState saved);
  void ResetStream();

 private:
  struct Audio {
    std::vector<int16_t> samples;
  };
  struct Params {
    VoiceParams params;
  };
  struct EnrollAction {
    uint8_t action;
  };
  struct RestoreState {
    EnrollState state;
  };
  struct Reset {};
  using Command = std::variant<Audio, Params, EnrollAction, RestoreState, Reset>;

  void Push(Command command);
  void Run();

  FrameWriter& out_;
  const InputOptions options_;
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<Command> queue_;    // guarded by mutex_
  size_t queued_samples_ = 0;    // guarded by mutex_
  uint64_t dropped_samples_ = 0;  // guarded by mutex_
  bool stop_ = false;            // guarded by mutex_
  VoiceParams initial_params_;   // guarded by mutex_ until the processor exists
  std::thread thread_;
};

}  // namespace mic_asr

#endif  // MIC_ASR_INPUT_H_
