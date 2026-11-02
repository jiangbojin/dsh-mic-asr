#include "input.h"

#include "crash_report.h"

#include <algorithm>
#include <span>
#include <utility>

namespace mic_asr {
namespace {

// Writes VoiceProcessor callbacks as protocol frames; runs on the recognition thread.
class FrameObserver : public VoiceObserver {
 public:
  explicit FrameObserver(FrameWriter& out) : out_(out) {}

  void OnSpeechStart(uint64_t segment, bool barge_enabled, const SegmentTimes& times) override {
    Event(VoiceEventKind::kSpeechStart, segment)
        .Put<uint8_t>(barge_enabled)
        .Put<int64_t>(times.onset_ns)
        .Put<int64_t>(times.confirm_ns);
    Flush();
  }
  void OnSpeechEnd(uint64_t segment, double duration_s, const SegmentTimes& times) override {
    Event(VoiceEventKind::kSpeechEnd, segment).Put<double>(duration_s).Put<int64_t>(times.speech_end_ns);
    Flush();
  }
  void OnAsrPartial(uint64_t segment, const std::string& text) override {
    Event(VoiceEventKind::kPartial, segment).PutText(text);
    Flush();
  }
  void OnSpeakerScore(uint64_t segment, VerifyStage stage, float score, bool accepted, bool decisive,
                      double audio_s) override {
    Event(VoiceEventKind::kScore, segment)
        .Put<uint8_t>(static_cast<uint8_t>(stage))
        .Put<float>(score)
        .Put<uint8_t>(accepted)
        .Put<uint8_t>(decisive)
        .Put<double>(audio_s);
    Flush();
  }
  void OnAsrFinal(uint64_t segment, const std::string& text, bool accepted, const SegmentTimes& times) override {
    Event(VoiceEventKind::kFinal, segment)
        .Put<uint8_t>(accepted)
        .Put<int64_t>(times.speech_end_ns)
        .Put<int64_t>(times.final_ns)
        .PutText(text);
    Flush();
  }
  void OnEnrollStatus(const std::string& event, const std::string& message, const EnrollState& state) override {
    PayloadWriter payload;
    payload.Put<uint8_t>(state.recording)
        .Put<uint8_t>(state.enrolled)
        .Put<uint8_t>(state.denoise_at_enroll)
        .Put<uint32_t>(static_cast<uint32_t>(state.segments_ok));
    const uint32_t dim = state.embeddings.empty() ? 0 : static_cast<uint32_t>(state.embeddings.front().size());
    payload.Put<uint32_t>(static_cast<uint32_t>(state.embeddings.size())).Put<uint32_t>(dim);
    for (const auto& embedding : state.embeddings) payload.PutBytes(embedding.data(), embedding.size() * sizeof(float));
    payload.Put<uint32_t>(static_cast<uint32_t>(state.durations_s.size()));
    for (double d : state.durations_s) payload.Put<double>(d);
    payload.Put<uint32_t>(static_cast<uint32_t>(state.pair_scores.size()));
    for (double s : state.pair_scores) payload.Put<double>(s);
    payload.Put<uint16_t>(static_cast<uint16_t>(event.size())).PutText(event).PutText(message);
    out_.Write(FrameType::kEnrollStatus, payload);
  }
  void OnError(const std::string& message) override {
    Event(VoiceEventKind::kError, 0).PutText(message);
    Flush();
  }

 private:
  PayloadWriter& Event(VoiceEventKind kind, uint64_t segment) {
    pending_ = PayloadWriter();
    pending_.Put<uint8_t>(static_cast<uint8_t>(kind)).Put<uint64_t>(segment);
    return pending_;
  }
  void Flush() { out_.Write(FrameType::kVoiceEvent, pending_); }

  FrameWriter& out_;
  PayloadWriter pending_;
};

}  // namespace

InputPipeline::InputPipeline(FrameWriter& out, InputOptions options) : out_(out), options_(std::move(options)) {}

InputPipeline::~InputPipeline() {
  {
    std::lock_guard lock(mutex_);
    stop_ = true;
  }
  wake_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void InputPipeline::Start() { thread_ = std::thread([this] { Run(); }); }

void InputPipeline::Push(Command command) {
  {
    std::lock_guard lock(mutex_);
    if (auto* audio = std::get_if<Audio>(&command)) {
      queued_samples_ += audio->samples.size();
      const size_t limit = static_cast<size_t>(options_.max_queued_ms) * kSampleRateHz / 1000;
      // Drop the oldest audio; commands keep their order.
      for (auto it = queue_.begin(); queued_samples_ > limit && it != queue_.end();) {
        if (auto* old = std::get_if<Audio>(&*it)) {
          queued_samples_ -= old->samples.size();
          dropped_samples_ += old->samples.size();
          it = queue_.erase(it);
        } else {
          ++it;
        }
      }
    }
    queue_.push_back(std::move(command));
  }
  wake_.notify_one();
}

void InputPipeline::PushAudio(std::vector<int16_t> samples) { Push(Audio{std::move(samples)}); }
void InputPipeline::SetParams(const VoiceParams& params) { Push(Params{params}); }
void InputPipeline::Enroll(uint8_t action) { Push(EnrollAction{action}); }
void InputPipeline::Restore(EnrollState saved) { Push(RestoreState{std::move(saved)}); }
void InputPipeline::ResetStream() { Push(Reset{}); }

void InputPipeline::Run() {
  std::string error;
  std::unique_ptr<AsrLibrary> asr = AsrLibrary::Load(options_.asr_library, &error);
  std::unique_ptr<DenoiseLibrary> denoise;
  if (asr != nullptr && !options_.denoise_library.empty()) {
    denoise = DenoiseLibrary::Load(options_.denoise_library, &error);
    if (denoise == nullptr) asr.reset();
  }
  FrameObserver observer(out_);
  std::unique_ptr<VoiceProcessor> processor;
  if (asr != nullptr) {
    processor = std::make_unique<VoiceProcessor>(asr->api(), denoise ? &denoise->api() : nullptr, &observer);
    VoiceParams params;
    // Parameters that arrived before loading finished apply to creation; later ones apply in order.
    {
      std::lock_guard lock(mutex_);
      for (auto it = queue_.begin(); it != queue_.end();) {
        if (auto* p = std::get_if<Params>(&*it)) {
          params = p->params;
          it = queue_.erase(it);
        } else {
          ++it;
        }
      }
    }
    if (!processor->Create(options_.models, params, &error)) processor.reset();
  }
  out_.Write(FrameType::kInputReady, PayloadWriter()
                                         .Put<uint8_t>(processor != nullptr)
                                         .Put<uint8_t>(processor != nullptr && processor->has_denoiser())
                                         .PutText(processor ? "" : error));

  std::vector<int16_t> pending;  // samples not yet forming a whole 10 ms frame
  uint64_t frames = 0;
  for (;;) {
    Command command;
    uint64_t dropped = 0;
    {
      std::unique_lock lock(mutex_);
      wake_.wait(lock, [this] { return stop_ || !queue_.empty(); });
      if (stop_) return;
      command = std::move(queue_.front());
      queue_.pop_front();
      if (auto* audio = std::get_if<Audio>(&command)) queued_samples_ -= audio->samples.size();
      dropped = dropped_samples_;
    }
    if (processor == nullptr) continue;
    if (auto* audio = std::get_if<Audio>(&command)) {
      RecordUplink(audio->samples.data(), audio->samples.size());
      pending.insert(pending.end(), audio->samples.begin(), audio->samples.end());
      size_t used = 0;
      const int64_t arrival_ns = MonotonicNowNs();
      for (; used + kFrameSamples <= pending.size(); used += kFrameSamples) {
        processor->ProcessFrame(std::span<const int16_t, kFrameSamples>(pending.data() + used, kFrameSamples),
                                arrival_ns);
        if (++frames % 10 == 0) {
          const VoiceStats stats = processor->stats();
          out_.Write(FrameType::kVoiceStats, PayloadWriter()
                                                 .Put<float>(static_cast<float>(stats.raw_rms_dbfs))
                                                 .Put<float>(static_cast<float>(stats.out_rms_dbfs))
                                                 .Put<uint8_t>(stats.in_segment)
                                                 .Put<float>(static_cast<float>(stats.segment_s))
                                                 .Put<uint64_t>(stats.frames)
                                                 .Put<uint64_t>(dropped));
        }
      }
      pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(used));
    } else if (auto* params = std::get_if<Params>(&command)) {
      processor->SetParams(params->params);
    } else if (auto* enroll = std::get_if<EnrollAction>(&command)) {
      if (enroll->action == 1) processor->EnrollBegin();
      if (enroll->action == 2) processor->EnrollEnd();
      if (enroll->action == 3) processor->EnrollReset();
    } else if (auto* restore = std::get_if<RestoreState>(&command)) {
      if (!processor->RestoreEnrollment(restore->state)) observer.OnError("saved speaker enrollment does not match the model");
    } else {
      pending.clear();
      processor->ResetStream();
    }
  }
}

}  // namespace mic_asr
