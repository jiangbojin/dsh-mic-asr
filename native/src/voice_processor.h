// dsh-mic-asr worker：上行语音处理（降噪 → VAD → ASR / 声纹），以及声纹注册。
//
// 本类不创建线程：所有方法（含构造后的 Create）须在同一线程上调用，
// 服务端由 RecognitionThread 承载，离线工具直接在主线程上驱动。
// 观察者回调都在调用线程上同步触发。
//
// 各阶段的输入 / 输出（16 kHz 单声道 int16，10 ms 一帧）：
//   ① 上行帧（ProcessFrame 入参，降噪前）——分接点 raw
//   ② 降噪：①→②，算法时延 20 ms；旁路时 ② = ①——分接点 processed
//   ③ VAD：输入 ②，输出段 [start_ms, end_ms]（start 已回溯 min_speech + 2 帧；
//      END 在段终点之后 min_silence 才确认）
//   ④ ASR：输入 ② 的 [start_ms − asr_preroll_ms, END 确认位置)，finish 补尾部静音，
//      输出 partial / final——分接点 asr（= processed 的这一截）
//   ⑤ 声纹：输入 ② 的段首 t_verify 或整段 [start_ms, end_ms]，输出得分
// 每段结束时经 OnSegmentAudio 交出 raw / processed（自 asr 起点再往前 1 s 起）
// 与边界，供诊断对照。
//
// 段的处理：
// - VAD SPEECH_START：从最近的历史音频里取出回溯后的段起点（再往前
//   asr_preroll_ms）到当前位置，送入 ASR（先 reset），并开始累积本段音频；
//   之后每帧继续送入。
// - 段内累计满 t_verify：用段首 t_verify 的音频算 embedding，做提前验证。
// - SPEECH_END：未提前判决的段，用整段 [start, end] 验证（段末复核）；
//   然后 ASR finish 得到 final。已提前判决的段先出 final，再算整段得分（只上报）。
// - 未注册或正在注册时，段照常识别，但不参与打断（barge_enabled = false）。
// - VAD 即打断模式（VoiceParams::vad_barge）：不在注册录音中的段都参与打断，
//   SPEECH_START 即判为接受，不做提前验证与段末判决。

#ifndef MIC_ASR_VOICE_PROCESSOR_H_
#define MIC_ASR_VOICE_PROCESSOR_H_

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include "native_libraries.h"

namespace mic_asr {

constexpr int kSampleRateHz = 16000;
constexpr size_t kFrameSamples = 160;  // 10 ms
using Frame = std::array<int16_t, kFrameSamples>;

struct VoiceProcessorConfig {
  std::string asr_model_dir;
  std::string vad_model_dir;
  std::string speaker_model_dir;
  int asr_tail_padding_ms = 0;   // 0 = 库默认（1500）
};

// 运行期可调参数（set_params）。VAD / ASR 参数变化时重建对应句柄；
// 段进行中则推迟到段结束。
struct VoiceParams {
  float vad_threshold = 0.5f;   // 语音概率阈值
  int vad_min_speech_ms = 250;  // 语音持续多久才确认开口
  int vad_min_silence_ms = 500;  // 段后静音多久才结束本段
  int asr_chunk_ms = 480;        // 160 或 480
  int asr_preroll_ms = 200;      // 在 VAD 回溯起点之前再多送给 ASR 的音频
  // true：VAD 即打断——段一开始就判为接受（不做声纹验证、不要求注册），
  // 已注册时整段得分只上报；false：声纹两阶段确认。
  bool vad_barge = false;
  float spk_threshold = 0.5f;
  int t_verify_ms = 1500;
  bool denoise = false;
};

enum class VerifyStage { kEarly, kFinal, kRecheck, kEnroll };
const char* VerifyStageName(VerifyStage stage);

// 时刻均为 CLOCK_MONOTONIC ns；0 表示无。
struct SegmentTimes {
  int64_t onset_ns = 0;    // 段起点对应的上行帧到达时刻（已扣除降噪时延）
  int64_t confirm_ns = 0;  // 处理 SPEECH_START 的时刻
  int64_t verified_ns = 0;  // 作出接受 / 拒绝判决的时刻
  int64_t speech_end_ns = 0;  // 段终点对应的上行帧到达时刻
  int64_t final_ns = 0;       // 得到 final 的时刻
};

// 一段结束时各分接点的音频（诊断用）。时间均为流位置（ms）。
struct SegmentAudio {
  uint64_t segment = 0;
  int64_t window_start_ms = 0;  // raw / processed 的起点
  int64_t asr_start_ms = 0;     // ASR 输入起点（= start_ms − asr_preroll_ms）
  int64_t start_ms = 0;         // VAD 段起点（已回溯）
  int64_t end_ms = 0;           // VAD 段终点
  int64_t detect_ms = 0;        // 确认 END 时的位置（raw / processed 的终点）
  bool denoise = false;
  std::vector<int16_t> raw;        // ① 降噪前
  std::vector<int16_t> processed;  // ② 降噪后（VAD / ASR 的输入）
  std::string final_text;          // 实时链路的 final
  VoiceParams params;              // 本段处理时的参数
};

struct EnrollState {
  bool recording = false;
  bool enrolled = false;
  int segments_ok = 0;                // 已成功的段数（满 3 段即注册）
  std::vector<double> durations_s;    // 各成功段的语音时长
  std::vector<double> pair_scores;    // 注册后：三段两两相似度
  bool denoise_at_enroll = false;     // 注册时是否经 AI 降噪（新注册恒为 true）
  // 已注册时的三条 embedding（用于持久化与重启后恢复）。
  std::vector<std::vector<float>> embeddings;
};

class VoiceObserver {
 public:
  virtual ~VoiceObserver() = default;
  virtual void OnSpeechStart(uint64_t segment,
                             bool barge_enabled,
                             const SegmentTimes& times) = 0;
  virtual void OnSpeechEnd(uint64_t segment,
                           double duration_s,
                           const SegmentTimes& times) = 0;
  virtual void OnAsrPartial(uint64_t segment, const std::string& text) = 0;
  // decisive：本次得分决定了段的接受 / 拒绝。
  virtual void OnSpeakerScore(uint64_t segment,
                              VerifyStage stage,
                              float score,
                              bool accepted,
                              bool decisive,
                              double audio_s) = 0;
  // accepted：本段已通过验证（仅此时宿主应使用 text）。text 可为空。
  virtual void OnAsrFinal(uint64_t segment,
                          const std::string& text,
                          bool accepted,
                          const SegmentTimes& times) = 0;
  // event：recording / segment_ok / segment_failed / enrolled / reset /
  // stale（降噪开关已与注册时不同）/ error。
  virtual void OnEnrollStatus(const std::string& event,
                              const std::string& message,
                              const EnrollState& state) = 0;
  virtual void OnError(const std::string& message) = 0;
  // 段结束、final 之后（诊断用；默认忽略）。
  virtual void OnSegmentAudio(const SegmentAudio& /* audio */) {}
};

// 预录音频注册（EnrollFromClips）的结果。
struct EnrollClipResult {
  bool ok = false;
  double speech_s = 0;  // VAD 取出的语音时长
  std::string message;
};
struct EnrollClipsResult {
  bool enrolled = false;
  std::string message;
  std::vector<EnrollClipResult> clips;
  EnrollState state;
};

struct VoiceStats {
  uint64_t frames = 0;    // 已处理的 10 ms 帧
  uint64_t segments = 0;  // 已结束的段
  double denoise_avg_us = 0;
  double denoise_max_us = 0;
  // 各句柄累计 RTF（推理耗时 / 已处理音频时长）。
  double rtf_denoise = 0;
  double rtf_vad = 0;
  double rtf_asr = 0;
  double rtf_speaker = 0;
  uint64_t denoise_errors = 0;
  // 近 ~100 ms 电平（dBFS）：① 降噪前、② 降噪后。
  double raw_rms_dbfs = -120;
  double raw_peak_dbfs = -120;
  double out_rms_dbfs = -120;
  double out_peak_dbfs = -120;
  bool in_segment = false;
  double segment_s = 0;  // 当前段已持续
};

class VoiceProcessor {
 public:
  // asr 必须非空；denoise 为空时降噪不可用（始终旁路）。observer
  // 与两个库须比本对象活得久。
  VoiceProcessor(const BaseAsrApi& asr,
                 const DenoiseApi* denoise,
                 VoiceObserver* observer);
  ~VoiceProcessor();
  VoiceProcessor(const VoiceProcessor&) = delete;
  VoiceProcessor& operator=(const VoiceProcessor&) = delete;

  // 加载模型、创建全部句柄（约 2 s）。
  [[nodiscard]] bool Create(const VoiceProcessorConfig& config,
                            const VoiceParams& params,
                            std::string* error);

  // 一帧 160 点 16 kHz 单声道；arrival_ns 为该帧到达服务端的时刻。
  void ProcessFrame(std::span<const int16_t, kFrameSamples> samples,
                    int64_t arrival_ns);

  // 新音频流（新会话）：结束未完成的段（不出结果），各句柄回到初始状态。
  // 注册表保留。
  void ResetStream();

  void SetParams(const VoiceParams& params);
  const VoiceParams& params() const { return params_; }

  void EnrollBegin();
  void EnrollEnd();
  void EnrollReset();
  // 用预先录好的三段音频注册（浏览器本地录音后上传，16 kHz 单声道）。
  // 每段一律经 AI 降噪（不随实时链路的降噪开关；未加载降噪库则拒绝注册）、
  // 由 VAD 取出语音部分（≥ 3 s 才合格），用独立的降噪 / VAD 句柄，不影响
  // 实时流。三段都合格才替换注册，否则保留原注册。
  EnrollClipsResult EnrollFromClips(
      const std::vector<std::vector<int16_t>>& clips);
  // 用保存的 embedding 恢复注册（重启后）。维度不符等失败返回 false。
  bool RestoreEnrollment(const EnrollState& saved);
  const EnrollState& enroll_state() const { return enroll_; }

  VoiceStats stats() const;
  bool has_denoiser() const { return denoiser_ != nullptr; }
  // 当前生效的降噪算法时延。
  int denoise_latency_ms() const;

 private:
  struct Segment;

  void ProcessDenoise(std::span<const int16_t, kFrameSamples> in, Frame& out);
  // 按 params_ 创建实时 ASR / VAD 句柄（替换已有的）。
  bool CreateRecognizer(std::string* error);
  bool CreateVad(std::string* error);
  void ApplyPendingReconfig();
  // 用句柄 d 降噪一帧；出错返回 false（out 未定义）。
  bool DenoiseFrame(qnsz_denoise* d,
                    std::span<const int16_t, kFrameSamples> in,
                    Frame& out);
  // 按当前降噪设置处理一段预录音频，返回 VAD 取出的语音。
  std::vector<int16_t> ExtractClipSpeech(const std::vector<int16_t>& clip);
  // 用三条 embedding 替换注册表中的用户并上报 enrolled。
  bool CommitEnrollment(std::vector<std::vector<float>> embeddings,
                        std::vector<double> durations_s);
  void StartSegment(uint64_t index, int64_t start_ms);
  void EndSegment(int64_t end_ms);
  void MaybeVerifyEarly();
  // 对一段音频算 embedding，与注册向量比对；返回是否达到阈值。
  bool ScoreSpeaker(const int16_t* samples, size_t count, float* score);
  bool ComputeEmbedding(const int16_t* samples,
                        size_t count,
                        std::vector<float>* emb);
  void FinishEnrollRecording();
  bool barge_enabled() const;
  int64_t ArrivalNsAt(int64_t stream_ms) const;
  void ReportSpeakerError();

  const BaseAsrApi& asr_;
  const DenoiseApi* const denoise_api_;
  VoiceObserver* const observer_;
  VoiceParams params_;

  VoiceProcessorConfig config_;
  // 段进行中改了 VAD / ASR 参数：段结束后再重建。
  bool reconfig_vad_ = false;
  bool reconfig_asr_ = false;
  // VAD 句柄重建时流位置的偏移（新句柄从 0 计时）。
  int64_t vad_base_ms_ = 0;
  struct Level {
    double power = 0;
    double peak = 0;
    void Update(std::span<const int16_t> frame);
  };
  Level raw_level_;
  Level out_level_;

  base_asr_recognizer* recognizer_ = nullptr;
  base_asr_vad* vad_ = nullptr;
  base_asr_speaker* speaker_ = nullptr;
  base_asr_speaker_registry* registry_ = nullptr;
  qnsz_denoise* denoiser_ = nullptr;
  // 预录音频注册专用（与实时流的句柄互不影响）。
  base_asr_vad* clip_vad_ = nullptr;
  qnsz_denoise* clip_denoiser_ = nullptr;
  int64_t clip_vad_ms_ = 0;  // 已送入 clip_vad_ 的音频时长
  int speaker_dim_ = 0;
  bool denoise_active_ = false;  // 上一帧是否经过了降噪

  // 流位置：自创建起送入 VAD 的帧数（与 VAD 时间基一致，不随会话清零）。
  uint64_t frame_index_ = 0;
  std::vector<int64_t> arrival_ring_;  // 帧到达时刻，按 frame_index 取模
  std::vector<int16_t> history_;       // 最近音频（②），按采样位置取模
  std::vector<int16_t> raw_history_;   // 最近音频（①），同上

  std::unique_ptr<Segment> segment_;
  uint64_t next_segment_id_ = 0;
  int64_t last_end_ms_ = 0;  // 上一段的 VAD 终点（流位置）
  uint64_t segments_done_ = 0;

  EnrollState enroll_;
  std::vector<int16_t> enroll_audio_;
  std::vector<std::vector<float>> enroll_embeddings_;

  // 回调暂存（VAD / ASR 回调内不得再调用同一句柄）。
  struct VadEvent {
    base_asr_vad_event_type type;
    uint64_t segment;
    int64_t start_ms;
    int64_t end_ms;
  };
  std::vector<VadEvent> vad_events_;
  std::vector<VadEvent> clip_vad_events_;
  std::string asr_partial_;
  bool has_asr_partial_ = false;
  std::string asr_final_;

  // 统计。
  uint64_t denoise_frames_ = 0;
  uint64_t denoise_errors_ = 0;
  double denoise_total_us_ = 0;
  double denoise_max_us_ = 0;
  double vad_total_us_ = 0;
  double asr_total_us_ = 0;
  double speaker_total_us_ = 0;

  static void OnVadEvent(void* user, const base_asr_vad_event* event);
  static void OnClipVadEvent(void* user, const base_asr_vad_event* event);
  static void OnAsrEvent(void* user, const base_asr_event* event);
};

int64_t MonotonicNowNs();

}  // namespace mic_asr

#endif  // MIC_ASR_VOICE_PROCESSOR_H_
