#include "voice_processor.h"

#include <time.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <string>
#include <utility>
#include <vector>


namespace mic_asr {
namespace {

// 注册表里唯一的说话人（单会话演示）。
constexpr char kUserName[] = "user";
constexpr size_t kErrorBytes = 512;
constexpr int kSamplesPerMs = kSampleRateHz / 1000;
// 历史音频与到达时刻的保留长度：须覆盖 VAD 回溯（min_speech + 2 帧）、
// ASR 前置补偿与诊断前置上下文。
constexpr size_t kHistorySamples = 5 * kSampleRateHz;
// 诊断音频在 ASR 起点之前多留的上下文。
constexpr int64_t kDiagContextMs = 1000;
constexpr size_t kArrivalFrames = 60 * 100;
// 段音频（声纹用）与注册录音的上限：防止持续说话或不点“结束”时无限增长。
constexpr size_t kMaxBufferedSamples = 60 * kSampleRateHz;
constexpr int kEnrollSegments = 3;
constexpr double kEnrollMinSeconds = 3.0;

double ElapsedUs(int64_t begin_ns) {
  return static_cast<double>(MonotonicNowNs() - begin_ns) / 1e3;
}

std::string FormatSeconds(double s) {
  char buf[32] = {};
  std::snprintf(buf, sizeof(buf), "%.1f", s);
  return buf;
}

}  // namespace

int64_t MonotonicNowNs() {
  timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1'000'000'000 + ts.tv_nsec;
}

const char* VerifyStageName(VerifyStage stage) {
  switch (stage) {
    case VerifyStage::kEarly:
      return "early";
    case VerifyStage::kFinal:
      return "final";
    case VerifyStage::kRecheck:
      return "recheck";
    case VerifyStage::kEnroll:
      return "enroll";
  }
  return "unknown";
}

struct VoiceProcessor::Segment {
  enum class Decision { kPending, kAccepted, kRejected };

  uint64_t index = 0;      // 本处理器分配的段号（VAD 重建后仍递增）
  uint64_t vad_index = 0;  // VAD 句柄的段号（匹配 START / END）
  int64_t start_ms = 0;
  bool barge_enabled = false;
  bool early_done = false;
  Decision decision = Decision::kPending;
  std::vector<int16_t> audio;  // ② 自回溯后的段起点起（声纹 / 注册用）
  int64_t asr_start_ms = 0;
  int64_t window_start_ms = 0;
  std::vector<int16_t> raw_window;   // ① 自 window_start_ms 起（诊断用）
  std::vector<int16_t> proc_window;  // ② 自 window_start_ms 起（诊断用）
  SegmentTimes times;
};

void VoiceProcessor::Level::Update(std::span<const int16_t> frame) {
  double energy = 0;
  double frame_peak = 0;
  for (int16_t v : frame) {
    energy += static_cast<double>(v) * v;
    frame_peak = std::max(frame_peak, std::abs(static_cast<double>(v)));
  }
  // 约 100 ms 的指数平均；峰值按帧衰减。
  power = 0.9 * power + 0.1 * energy / static_cast<double>(frame.size());
  peak = std::max(frame_peak, peak * 0.9);
}

namespace {

double ToDbfs(double amplitude) {
  return amplitude > 0 ? 20.0 * std::log10(amplitude / 32768.0) : -120.0;
}

}  // namespace

VoiceProcessor::VoiceProcessor(const BaseAsrApi& asr,
                               const DenoiseApi* denoise,
                               VoiceObserver* observer)
    : asr_(asr),
      denoise_api_(denoise),
      observer_(observer),
      arrival_ring_(kArrivalFrames, 0),
      history_(kHistorySamples, 0),
      raw_history_(kHistorySamples, 0) {}

VoiceProcessor::~VoiceProcessor() {
  if (denoiser_ != nullptr) {
    denoise_api_->destroy(denoiser_);
  }
  if (clip_denoiser_ != nullptr) {
    denoise_api_->destroy(clip_denoiser_);
  }
  asr_.vad_destroy(clip_vad_);
  asr_.registry_destroy(registry_);
  asr_.speaker_destroy(speaker_);
  asr_.vad_destroy(vad_);
  asr_.destroy(recognizer_);
}

bool VoiceProcessor::Create(const VoiceProcessorConfig& config,
                            const VoiceParams& params,
                            std::string* error) {
  params_ = params;
  config_ = config;
  std::array<char, kErrorBytes> err_buf = {};
  char* const err = err_buf.data();
  const size_t err_bytes = err_buf.size();

  if (!CreateRecognizer(error) || !CreateVad(error)) {
    return false;
  }
  // 预录注册用的 VAD：取默认参数，与实时 VAD 的调参互不影响。
  base_asr_vad_config vad_config{};
  vad_config.model_dir = config.vad_model_dir.c_str();
  vad_config.user_data = this;
  vad_config.on_event = &VoiceProcessor::OnClipVadEvent;
  if (asr_.vad_create(&vad_config, &clip_vad_, err, err_bytes) !=
      BASE_ASR_OK) {
    *error = std::string("base_asr_vad_create (enroll): ") + err;
    return false;
  }

  base_asr_speaker_config speaker_config{};
  speaker_config.model_dir = config.speaker_model_dir.c_str();
  if (asr_.speaker_create(&speaker_config, &speaker_, err, err_bytes) !=
      BASE_ASR_OK) {
    *error = std::string("base_asr_speaker_create: ") + err;
    return false;
  }
  speaker_dim_ = asr_.speaker_dim(speaker_);
  if (asr_.registry_create(speaker_dim_, &registry_, err, err_bytes) !=
      BASE_ASR_OK) {
    *error = std::string("base_asr_speaker_registry_create: ") + err;
    return false;
  }

  if (denoise_api_ != nullptr) {
    if (denoise_api_->create(nullptr, &denoiser_, err, err_bytes) !=
        QNSZ_DENOISE_OK) {
      *error = std::string("qnsz_denoise_create: ") + err;
      return false;
    }
    if (denoise_api_->create(nullptr, &clip_denoiser_, err, err_bytes) !=
        QNSZ_DENOISE_OK) {
      *error = std::string("qnsz_denoise_create (enroll): ") + err;
      return false;
    }
    if (denoise_api_->sample_rate(denoiser_) != kSampleRateHz ||
        denoise_api_->frame_size(denoiser_) !=
            static_cast<int32_t>(kFrameSamples)) {
      *error = "qnsz_denoise: unexpected sample rate / frame size";
      return false;
    }
  }
  return true;
}

bool VoiceProcessor::CreateRecognizer(std::string* error) {
  std::array<char, kErrorBytes> err = {};
  base_asr_config asr_config{};
  asr_config.model_dir = config_.asr_model_dir.c_str();
  asr_config.on_event = &VoiceProcessor::OnAsrEvent;
  asr_config.user_data = this;
  asr_config.chunk_ms = params_.asr_chunk_ms;
  // 段由 VAD 切分；识别器自带端点检测关闭，只在 finish 时出 final。
  asr_config.disable_endpoint = 1;
  asr_config.tail_padding_ms = config_.asr_tail_padding_ms;
  base_asr_recognizer* recognizer = nullptr;
  if (asr_.create(&asr_config, &recognizer, err.data(), err.size()) !=
      BASE_ASR_OK) {
    *error = std::string("base_asr_create: ") + err.data();
    return false;
  }
  asr_.destroy(recognizer_);
  recognizer_ = recognizer;
  return true;
}

bool VoiceProcessor::CreateVad(std::string* error) {
  std::array<char, kErrorBytes> err = {};
  base_asr_vad_config vad_config{};
  vad_config.model_dir = config_.vad_model_dir.c_str();
  vad_config.on_event = &VoiceProcessor::OnVadEvent;
  vad_config.user_data = this;
  vad_config.threshold = params_.vad_threshold;
  vad_config.min_speech_ms = params_.vad_min_speech_ms;
  vad_config.min_silence_ms = params_.vad_min_silence_ms;
  base_asr_vad* vad = nullptr;
  if (asr_.vad_create(&vad_config, &vad, err.data(), err.size()) !=
      BASE_ASR_OK) {
    *error = std::string("base_asr_vad_create: ") + err.data();
    return false;
  }
  asr_.vad_destroy(vad_);
  vad_ = vad;
  // 新句柄从 0 计时：记下当前流位置，事件时间加上它。
  vad_base_ms_ = static_cast<int64_t>(frame_index_) * 10;
  return true;
}

void VoiceProcessor::ApplyPendingReconfig() {
  if (segment_ != nullptr) {
    return;
  }
  std::string error;
  if (reconfig_vad_) {
    reconfig_vad_ = false;
    if (!CreateVad(&error)) {
      observer_->OnError(error);
    }
  }
  if (reconfig_asr_) {
    reconfig_asr_ = false;
    if (!CreateRecognizer(&error)) {
      observer_->OnError(error);
    }
  }
}

int VoiceProcessor::denoise_latency_ms() const {
  return denoise_active_ ? denoise_api_->latency_frames(denoiser_) * 10 : 0;
}

bool VoiceProcessor::barge_enabled() const {
  return (params_.vad_barge || enroll_.enrolled) && !enroll_.recording;
}

int64_t VoiceProcessor::ArrivalNsAt(int64_t stream_ms) const {
  if (frame_index_ == 0) {
    return 0;
  }
  const uint64_t newest = frame_index_ - 1;
  const uint64_t oldest =
      frame_index_ > kArrivalFrames ? frame_index_ - kArrivalFrames : 0;
  const uint64_t frame = static_cast<uint64_t>(
      std::clamp<int64_t>(stream_ms / 10, static_cast<int64_t>(oldest),
                          static_cast<int64_t>(newest)));
  return arrival_ring_[frame % kArrivalFrames];
}

void VoiceProcessor::ProcessDenoise(std::span<const int16_t, kFrameSamples> in,
                                    Frame& out) {
  if (denoiser_ == nullptr || !params_.denoise) {
    denoise_active_ = false;
    std::ranges::copy(in, out.begin());
    return;
  }
  if (!denoise_active_) {
    // 从旁路切回降噪：丢弃切换前的流式历史。
    denoise_api_->reset(denoiser_);
    denoise_active_ = true;
  }
  const int64_t begin_ns = MonotonicNowNs();
  const bool ok = DenoiseFrame(denoiser_, in, out);
  const double us = ElapsedUs(begin_ns);
  ++denoise_frames_;
  denoise_total_us_ += us;
  denoise_max_us_ = std::max(denoise_max_us_, us);
  if (!ok) {
    // 出错后错误状态会保持：本帧直通，计数后上报一次。
    if (denoise_errors_++ == 0) {
      std::array<char, kErrorBytes> err = {};
      denoise_api_->last_error(denoiser_, err.data(), err.size());
      observer_->OnError(std::string("denoise failed, passing through: ") +
                         err.data());
    }
    std::ranges::copy(in, out.begin());
  }
}

bool VoiceProcessor::DenoiseFrame(qnsz_denoise* d,
                                  std::span<const int16_t, kFrameSamples> in,
                                  Frame& out) {
  std::array<float, kFrameSamples> buf;
  std::ranges::transform(in, buf.begin(),
                         [](int16_t v) { return v / 32768.0f; });
  if (denoise_api_->process(d, buf.data(), buf.data()) != QNSZ_DENOISE_OK) {
    return false;
  }
  std::ranges::transform(buf, out.begin(), [](float v) {
    return static_cast<int16_t>(
        std::lrintf(std::clamp(v * 32768.0f, -32768.0f, 32767.0f)));
  });
  return true;
}

void VoiceProcessor::ProcessFrame(
    std::span<const int16_t, kFrameSamples> samples,
    int64_t arrival_ns) {
  Frame frame;
  ProcessDenoise(samples, frame);
  raw_level_.Update(samples);
  out_level_.Update(frame);

  const uint64_t base = frame_index_ * kFrameSamples;
  for (size_t i = 0; i < kFrameSamples; ++i) {
    history_[(base + i) % kHistorySamples] = frame[i];
    raw_history_[(base + i) % kHistorySamples] = samples[i];
  }
  arrival_ring_[frame_index_ % kArrivalFrames] = arrival_ns;
  ++frame_index_;

  // 已在段内：本帧追加到段音频并送 ASR。
  if (segment_ != nullptr) {
    if (segment_->audio.size() < kMaxBufferedSamples) {
      segment_->audio.insert(segment_->audio.end(), frame.begin(),
                             frame.end());
    }
    if (segment_->proc_window.size() < kMaxBufferedSamples) {
      segment_->proc_window.insert(segment_->proc_window.end(), frame.begin(),
                                   frame.end());
      segment_->raw_window.insert(segment_->raw_window.end(), samples.begin(),
                                  samples.end());
    }
    const int64_t begin_ns = MonotonicNowNs();
    asr_.accept_pcm16(recognizer_, frame.data(), frame.size());
    asr_total_us_ += ElapsedUs(begin_ns);
  }

  vad_events_.clear();
  const int64_t vad_begin_ns = MonotonicNowNs();
  asr_.vad_accept_pcm16(vad_, frame.data(), frame.size());
  vad_total_us_ += ElapsedUs(vad_begin_ns);
  for (const VadEvent& ev : vad_events_) {
    if (ev.type == BASE_ASR_VAD_SPEECH_START && segment_ == nullptr) {
      StartSegment(ev.segment, ev.start_ms);
    } else if (ev.type == BASE_ASR_VAD_SPEECH_END && segment_ != nullptr &&
               segment_->vad_index == ev.segment) {
      EndSegment(ev.end_ms);
    }
  }

  if (segment_ != nullptr) {
    if (has_asr_partial_) {
      observer_->OnAsrPartial(segment_->index, asr_partial_);
    }
    MaybeVerifyEarly();
  }
  has_asr_partial_ = false;
}

void VoiceProcessor::StartSegment(uint64_t index, int64_t start_ms) {
  segment_ = std::make_unique<Segment>();
  Segment& seg = *segment_;
  seg.index = next_segment_id_++;
  seg.vad_index = index;
  seg.start_ms = start_ms;
  seg.barge_enabled = barge_enabled();
  seg.times.confirm_ns = MonotonicNowNs();
  if (seg.barge_enabled && params_.vad_barge) {
    seg.decision = Segment::Decision::kAccepted;  // VAD 即打断
    seg.times.verified_ns = seg.times.confirm_ns;
  }
  seg.times.onset_ns = ArrivalNsAt(start_ms - denoise_latency_ms());

  // 从历史里补回段起点（回溯 min_speech + 2 帧）到当前位置的音频；
  // ASR 再往前多取 asr_preroll_ms，诊断窗口再往前 1 s。
  const uint64_t end = frame_index_ * kFrameSamples;
  const uint64_t oldest = end > kHistorySamples ? end - kHistorySamples : 0;
  const auto clamp_pos = [&](int64_t ms) {
    return std::clamp<uint64_t>(
        static_cast<uint64_t>(std::max<int64_t>(ms, 0)) * kSamplesPerMs,
        oldest, end);
  };
  const uint64_t begin = clamp_pos(start_ms);
  const uint64_t asr_begin = clamp_pos(start_ms - params_.asr_preroll_ms);
  // 诊断窗口不越过上一段的终点（否则加宽转写会混进上一段的语音）。
  const uint64_t window_begin = std::max(
      clamp_pos(static_cast<int64_t>(asr_begin / kSamplesPerMs) -
                kDiagContextMs),
      std::min(clamp_pos(last_end_ms_), asr_begin));
  seg.audio.reserve(20 * kSampleRateHz);
  for (uint64_t pos = begin; pos < end; ++pos) {
    seg.audio.push_back(history_[pos % kHistorySamples]);
  }
  for (uint64_t pos = window_begin; pos < end; ++pos) {
    seg.proc_window.push_back(history_[pos % kHistorySamples]);
    seg.raw_window.push_back(raw_history_[pos % kHistorySamples]);
  }
  // 各起点以实际补回的位置为准。
  seg.start_ms = static_cast<int64_t>(begin / kSamplesPerMs);
  seg.asr_start_ms = static_cast<int64_t>(asr_begin / kSamplesPerMs);
  seg.window_start_ms = static_cast<int64_t>(window_begin / kSamplesPerMs);

  const int64_t begin_ns = MonotonicNowNs();
  asr_.reset(recognizer_);
  const size_t asr_offset = static_cast<size_t>(asr_begin - window_begin);
  const std::span<const int16_t> asr_input =
      std::span<const int16_t>(seg.proc_window).subspan(asr_offset);
  asr_.accept_pcm16(recognizer_, asr_input.data(), asr_input.size());
  asr_total_us_ += ElapsedUs(begin_ns);

  observer_->OnSpeechStart(seg.index, seg.barge_enabled, seg.times);
}

void VoiceProcessor::EndSegment(int64_t end_ms) {
  std::unique_ptr<Segment> seg = std::move(segment_);
  const size_t speech_samples = std::min(
      seg->audio.size(),
      static_cast<size_t>(std::max<int64_t>(end_ms - seg->start_ms, 0)) *
          kSamplesPerMs);
  seg->times.speech_end_ns = ArrivalNsAt(end_ms - denoise_latency_ms());
  observer_->OnSpeechEnd(seg->index,
                         static_cast<double>(speech_samples) / kSampleRateHz,
                         seg->times);

  if (enroll_.recording && enroll_audio_.size() < kMaxBufferedSamples) {
    enroll_audio_.insert(enroll_audio_.end(), seg->audio.begin(),
                         seg->audio.begin() + speech_samples);
  }

  // 段末复核：未提前判决（短于 t_verify）的段用整段判决。
  const bool verify = seg->barge_enabled && !params_.vad_barge;
  if (verify && !seg->early_done) {
    float score = -1;
    const bool accepted =
        ScoreSpeaker(seg->audio.data(), speech_samples, &score);
    seg->decision = accepted ? Segment::Decision::kAccepted
                             : Segment::Decision::kRejected;
    seg->times.verified_ns = MonotonicNowNs();
    observer_->OnSpeakerScore(seg->index, VerifyStage::kFinal, score, accepted,
                              true,
                              static_cast<double>(speech_samples) /
                                  kSampleRateHz);
  }

  asr_final_.clear();
  const int64_t begin_ns = MonotonicNowNs();
  asr_.finish(recognizer_);
  asr_total_us_ += ElapsedUs(begin_ns);
  seg->times.final_ns = MonotonicNowNs();
  has_asr_partial_ = false;
  observer_->OnAsrFinal(seg->index, asr_final_,
                        seg->decision == Segment::Decision::kAccepted,
                        seg->times);

  // 已提前判决的段、VAD 即打断模式下已注册时：整段得分只上报，供标定。
  if ((verify && seg->early_done) ||
      (params_.vad_barge && enroll_.enrolled && !enroll_.recording)) {
    float score = -1;
    const bool accepted =
        ScoreSpeaker(seg->audio.data(), speech_samples, &score);
    observer_->OnSpeakerScore(seg->index, VerifyStage::kRecheck, score,
                              accepted, false,
                              static_cast<double>(speech_samples) /
                                  kSampleRateHz);
  }
  ++segments_done_;
  last_end_ms_ = end_ms;

  SegmentAudio diag;
  diag.segment = seg->index;
  diag.window_start_ms = seg->window_start_ms;
  diag.asr_start_ms = seg->asr_start_ms;
  diag.start_ms = seg->start_ms;
  diag.end_ms = end_ms;
  diag.detect_ms =
      seg->window_start_ms +
      static_cast<int64_t>(seg->proc_window.size() / kSamplesPerMs);
  diag.denoise = denoise_active_;
  diag.raw = std::move(seg->raw_window);
  diag.processed = std::move(seg->proc_window);
  diag.final_text = asr_final_;
  diag.params = params_;
  observer_->OnSegmentAudio(diag);
  ApplyPendingReconfig();
}

void VoiceProcessor::MaybeVerifyEarly() {
  Segment& seg = *segment_;
  const size_t needed =
      static_cast<size_t>(params_.t_verify_ms) * kSamplesPerMs;
  if (!seg.barge_enabled || params_.vad_barge || seg.early_done ||
      seg.audio.size() < needed) {
    return;
  }
  seg.early_done = true;
  float score = -1;
  const bool accepted = ScoreSpeaker(seg.audio.data(), needed, &score);
  seg.decision = accepted ? Segment::Decision::kAccepted
                          : Segment::Decision::kRejected;
  seg.times.verified_ns = MonotonicNowNs();
  observer_->OnSpeakerScore(seg.index, VerifyStage::kEarly, score, accepted,
                            true,
                            static_cast<double>(needed) / kSampleRateHz);
}

bool VoiceProcessor::ComputeEmbedding(const int16_t* samples,
                                      size_t count,
                                      std::vector<float>* emb) {
  emb->assign(static_cast<size_t>(speaker_dim_), 0.0f);
  int has_embedding = 0;
  const int64_t begin_ns = MonotonicNowNs();
  const bool ok =
      asr_.speaker_accept_pcm16(speaker_, samples, count) == BASE_ASR_OK &&
      asr_.speaker_compute(speaker_, emb->data(), emb->size(),
                           &has_embedding) == BASE_ASR_OK;
  speaker_total_us_ += ElapsedUs(begin_ns);
  if (!ok) {
    ReportSpeakerError();
    asr_.speaker_reset(speaker_);
    return false;
  }
  return has_embedding != 0;
}

bool VoiceProcessor::ScoreSpeaker(const int16_t* samples,
                                  size_t count,
                                  float* score) {
  *score = -1;
  std::vector<float> emb;
  if (!ComputeEmbedding(samples, count, &emb)) {
    return false;
  }
  base_asr_speaker_match match{};
  size_t matches = 0;
  // 只注册了一人：阈值取下限，取到其得分。
  asr_.registry_search(registry_, emb.data(), -1.0f, &match, 1, &matches);
  if (matches == 1) {
    *score = match.score;
  }
  int is_match = 0;
  asr_.registry_verify(registry_, kUserName, emb.data(),
                       params_.spk_threshold, &is_match);
  return is_match != 0;
}

void VoiceProcessor::ReportSpeakerError() {
  std::array<char, kErrorBytes> err = {};
  asr_.speaker_last_error(speaker_, err.data(), err.size());
  observer_->OnError(std::string("speaker embedding failed: ") + err.data());
}

void VoiceProcessor::ResetStream() {
  segment_.reset();
  ApplyPendingReconfig();
  asr_.vad_reset(vad_);
  asr_.reset(recognizer_);
  asr_.speaker_reset(speaker_);
  denoise_active_ = false;  // 下一帧降噪前会 reset
  has_asr_partial_ = false;
  if (enroll_.recording) {
    enroll_.recording = false;
    enroll_audio_.clear();
  }
}

void VoiceProcessor::SetParams(const VoiceParams& params) {
  const bool denoise_changed =
      params.denoise != params_.denoise && denoiser_ != nullptr;
  reconfig_vad_ |= params.vad_threshold != params_.vad_threshold ||
                   params.vad_min_speech_ms != params_.vad_min_speech_ms ||
                   params.vad_min_silence_ms != params_.vad_min_silence_ms;
  reconfig_asr_ |= params.asr_chunk_ms != params_.asr_chunk_ms;
  params_ = params;
  ApplyPendingReconfig();
  if (denoise_changed && enroll_.enrolled &&
      params_.denoise != enroll_.denoise_at_enroll) {
    observer_->OnEnrollStatus(
        "stale",
        enroll_.denoise_at_enroll
            ? "声纹按 AI 降噪注册，关闭降噪会降低声纹得分"
            : "当前声纹注册时未经 AI 降噪，请重新注册",
        enroll_);
  }
}

void VoiceProcessor::EnrollBegin() {
  if (enroll_.recording) {
    return;
  }
  // 声纹注册必须经 AI 降噪（实时录音注册走实时链路，须开着降噪）。
  if (!params_.denoise || denoiser_ == nullptr) {
    observer_->OnEnrollStatus(
        "error",
        denoiser_ == nullptr ? "声纹注册须经 AI 降噪，但服务端未加载降噪库"
                             : "声纹注册须经 AI 降噪，请先打开服务端降噪",
        enroll_);
    return;
  }
  if (enroll_embeddings_.size() >= kEnrollSegments) {
    // 重新注册：开始新一轮三段；完成时再替换注册表中的旧向量。
    enroll_embeddings_.clear();
    enroll_.segments_ok = 0;
    enroll_.durations_s.clear();
  }
  enroll_.recording = true;
  enroll_audio_.clear();
  observer_->OnEnrollStatus(
      "recording",
      "第 " + std::to_string(enroll_.segments_ok + 1) + " 段录音中", enroll_);
}

void VoiceProcessor::EnrollEnd() {
  if (!enroll_.recording) {
    observer_->OnEnrollStatus("error", "当前没有在录音", enroll_);
    return;
  }
  if (segment_ != nullptr) {
    // 段尚未结束：取到目前为止的音频。
    enroll_audio_.insert(enroll_audio_.end(), segment_->audio.begin(),
                         segment_->audio.end());
  }
  enroll_.recording = false;
  FinishEnrollRecording();
  enroll_audio_.clear();
}

void VoiceProcessor::FinishEnrollRecording() {
  const double seconds =
      static_cast<double>(enroll_audio_.size()) / kSampleRateHz;
  if (seconds < kEnrollMinSeconds) {
    observer_->OnEnrollStatus(
        "segment_failed",
        "有效语音 " + FormatSeconds(seconds) + " s，不足 3 s，请重录本段",
        enroll_);
    return;
  }
  std::vector<float> emb;
  if (!ComputeEmbedding(enroll_audio_.data(), enroll_audio_.size(), &emb)) {
    observer_->OnEnrollStatus("segment_failed", "声纹提取失败，请重录本段",
                              enroll_);
    return;
  }
  enroll_embeddings_.push_back(std::move(emb));
  enroll_.durations_s.push_back(seconds);
  enroll_.segments_ok = static_cast<int>(enroll_embeddings_.size());
  if (enroll_.segments_ok < kEnrollSegments) {
    observer_->OnEnrollStatus(
        "segment_ok",
        "第 " + std::to_string(enroll_.segments_ok) + " 段成功（" +
            FormatSeconds(seconds) + " s）",
        enroll_);
    return;
  }
  CommitEnrollment(std::move(enroll_embeddings_), enroll_.durations_s);
}

bool VoiceProcessor::CommitEnrollment(
    std::vector<std::vector<float>> embeddings,
    std::vector<double> durations_s) {
  std::vector<float> all;
  for (const auto& e : embeddings) {
    all.insert(all.end(), e.begin(), e.end());
  }
  int removed = 0;
  asr_.registry_remove(registry_, kUserName, &removed);
  int enrolled = 0;
  if (asr_.registry_enroll(registry_, kUserName, all.data(), embeddings.size(),
                           &enrolled) != BASE_ASR_OK ||
      enrolled == 0) {
    enroll_ = EnrollState();
    enroll_embeddings_.clear();
    observer_->OnEnrollStatus("error", "注册失败，请重新注册", enroll_);
    return false;
  }
  enroll_.pair_scores.clear();
  for (size_t i = 0; i < embeddings.size(); ++i) {
    for (size_t j = i + 1; j < embeddings.size(); ++j) {
      double dot = 0;
      for (int k = 0; k < speaker_dim_; ++k) {
        dot += embeddings[i][k] * embeddings[j][k];
      }
      enroll_.pair_scores.push_back(dot);
    }
  }
  enroll_.recording = false;
  enroll_.enrolled = true;
  enroll_.segments_ok = static_cast<int>(embeddings.size());
  enroll_.durations_s = std::move(durations_s);
  enroll_.denoise_at_enroll = true;  // 两条注册路径都强制经 AI 降噪
  enroll_.embeddings = embeddings;
  enroll_embeddings_ = std::move(embeddings);
  observer_->OnEnrollStatus("enrolled", "声纹已注册", enroll_);
  return true;
}

std::vector<int16_t> VoiceProcessor::ExtractClipSpeech(
    const std::vector<int16_t>& clip) {
  // 声纹注册必须经 AI 降噪，不随实时链路的降噪开关（EnrollFromClips 已确认
  // clip_denoiser_ 存在）。
  denoise_api_->reset(clip_denoiser_);
  asr_.vad_reset(clip_vad_);
  clip_vad_events_.clear();
  // VAD 时间基自创建起累计、reset 不清零：以本段开始时的位置为零点。
  const int64_t base_ms = clip_vad_ms_;
  std::vector<int16_t> processed;
  // 段尾补 1 s 静音，让 VAD 正常结束末段。
  const size_t frames = clip.size() / kFrameSamples + 100;
  processed.reserve(frames * kFrameSamples);
  for (size_t f = 0; f < frames; ++f) {
    Frame in = {};
    const size_t pos = f * kFrameSamples;
    if (pos + kFrameSamples <= clip.size()) {
      std::copy(clip.begin() + pos, clip.begin() + pos + kFrameSamples,
                in.begin());
    }
    Frame out;
    if (!DenoiseFrame(clip_denoiser_, in, out)) {
      out = in;
    }
    processed.insert(processed.end(), out.begin(), out.end());
    asr_.vad_accept_pcm16(clip_vad_, out.data(), out.size());
    clip_vad_ms_ += 10;
  }
  asr_.vad_finish(clip_vad_);

  std::vector<int16_t> speech;
  for (const VadEvent& ev : clip_vad_events_) {
    if (ev.type != BASE_ASR_VAD_SPEECH_END) {
      continue;
    }
    const auto to_index = [&](int64_t ms) {
      return std::clamp<size_t>(
          static_cast<size_t>(std::max<int64_t>(ms - base_ms, 0)) *
              kSamplesPerMs,
          0, processed.size());
    };
    speech.insert(speech.end(), processed.begin() + to_index(ev.start_ms),
                  processed.begin() + to_index(ev.end_ms));
  }
  return speech;
}

EnrollClipsResult VoiceProcessor::EnrollFromClips(
    const std::vector<std::vector<int16_t>>& clips) {
  EnrollClipsResult result;
  if (clip_denoiser_ == nullptr) {
    result.message = "声纹注册须经 AI 降噪，但服务端未加载降噪库（--denoise-lib）；原注册未改动";
    result.state = enroll_;
    return result;
  }
  std::vector<std::vector<float>> embeddings;
  std::vector<double> durations;
  for (size_t i = 0; i < clips.size(); ++i) {
    EnrollClipResult r;
    const std::vector<int16_t> speech = ExtractClipSpeech(clips[i]);
    r.speech_s = static_cast<double>(speech.size()) / kSampleRateHz;
    std::vector<float> emb;
    if (r.speech_s < kEnrollMinSeconds) {
      r.message = "有效语音 " + FormatSeconds(r.speech_s) + " s，不足 3 s";
    } else if (!ComputeEmbedding(speech.data(), speech.size(), &emb)) {
      r.message = "声纹提取失败";
    } else {
      r.ok = true;
      r.message = "有效语音 " + FormatSeconds(r.speech_s) + " s";
      embeddings.push_back(std::move(emb));
      durations.push_back(r.speech_s);
    }
    result.clips.push_back(std::move(r));
  }
  if (clips.size() != kEnrollSegments ||
      embeddings.size() != kEnrollSegments) {
    result.message = "需要三段合格的录音，请重录不合格的段；原注册未改动";
    result.state = enroll_;
    return result;
  }
  // 预录注册取代任何进行中的实时录音注册。
  enroll_audio_.clear();
  result.enrolled =
      CommitEnrollment(std::move(embeddings), std::move(durations));
  result.message = result.enrolled ? "声纹已注册" : "注册失败";
  result.state = enroll_;
  return result;
}

bool VoiceProcessor::RestoreEnrollment(const EnrollState& saved) {
  if (saved.embeddings.size() != kEnrollSegments) {
    return false;
  }
  for (const auto& e : saved.embeddings) {
    if (e.size() != static_cast<size_t>(speaker_dim_)) {
      return false;
    }
  }
  if (!CommitEnrollment(saved.embeddings, saved.durations_s)) {
    return false;
  }
  enroll_.denoise_at_enroll = saved.denoise_at_enroll;
  return true;
}

void VoiceProcessor::EnrollReset() {
  int removed = 0;
  asr_.registry_remove(registry_, kUserName, &removed);
  enroll_ = EnrollState();
  enroll_audio_.clear();
  enroll_embeddings_.clear();
  observer_->OnEnrollStatus("reset", "声纹已清除", enroll_);
}

VoiceStats VoiceProcessor::stats() const {
  VoiceStats s;
  s.frames = frame_index_;
  s.segments = segments_done_;
  s.denoise_errors = denoise_errors_;
  if (denoise_frames_ > 0) {
    s.denoise_avg_us = denoise_total_us_ / static_cast<double>(denoise_frames_);
    s.denoise_max_us = denoise_max_us_;
  }
  const double audio_us = static_cast<double>(frame_index_) * 10'000.0;
  if (audio_us > 0) {
    s.rtf_denoise = denoise_total_us_ / audio_us;
    s.rtf_vad = vad_total_us_ / audio_us;
    s.rtf_asr = asr_total_us_ / audio_us;
    s.rtf_speaker = speaker_total_us_ / audio_us;
  }
  s.raw_rms_dbfs = ToDbfs(std::sqrt(raw_level_.power));
  s.raw_peak_dbfs = ToDbfs(raw_level_.peak);
  s.out_rms_dbfs = ToDbfs(std::sqrt(out_level_.power));
  s.out_peak_dbfs = ToDbfs(out_level_.peak);
  s.in_segment = segment_ != nullptr;
  if (segment_ != nullptr) {
    s.segment_s = static_cast<double>(segment_->audio.size()) / kSampleRateHz;
  }
  return s;
}

void VoiceProcessor::OnVadEvent(void* user, const base_asr_vad_event* event) {
  auto* self = static_cast<VoiceProcessor*>(user);
  self->vad_events_.push_back({event->type, event->segment_index,
                               event->start_ms + self->vad_base_ms_,
                               event->end_ms + self->vad_base_ms_});
}

void VoiceProcessor::OnClipVadEvent(void* user,
                                    const base_asr_vad_event* event) {
  auto* self = static_cast<VoiceProcessor*>(user);
  self->clip_vad_events_.push_back(
      {event->type, event->segment_index, event->start_ms, event->end_ms});
}

void VoiceProcessor::OnAsrEvent(void* user, const base_asr_event* event) {
  auto* self = static_cast<VoiceProcessor*>(user);
  if (event->type == BASE_ASR_EVENT_PARTIAL) {
    self->asr_partial_.assign(event->text, event->text_bytes);
    self->has_asr_partial_ = true;
  } else if (event->type == BASE_ASR_EVENT_FINAL) {
    self->asr_final_.assign(event->text, event->text_bytes);
  }
}

}  // namespace mic_asr
