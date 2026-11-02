// dsh-mic-asr worker stdio protocol. Every frame is `u32 payload_bytes | u16 type | payload`, all
// integers little-endian. Text fields run to the end of the payload as UTF-8. The TypeScript side
// (src/protocol.ts) mirrors these definitions.

#ifndef MIC_ASR_PROTOCOL_H_
#define MIC_ASR_PROTOCOL_H_

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace mic_asr {

// Upper bound of one payload; larger frames are a protocol error.
constexpr uint32_t kMaxPayloadBytes = 1 << 20;

enum class FrameType : uint16_t {
  // Host -> worker. Codes 1-4 and 101-104 are reserved.
  kAudio = 5,   // i16 samples (16 kHz mono uplink)
  kVoiceParams = 6,  // f32 vad_threshold | i32 vad_min_speech_ms | i32 vad_min_silence_ms | i32 asr_chunk_ms |
                     // i32 asr_preroll_ms | u8 vad_barge | f32 spk_threshold | i32 t_verify_ms | u8 denoise
  kEnroll = 7,       // u8 action: 1 begin, 2 end, 3 reset
  kEnrollRestore = 8,  // u8 denoise_at_enroll | u32 count | u32 dim | f32[count*dim] | u32 n | f64[n] durations
  kResetStream = 9,
  // Worker -> host.
  kLog = 105,        // u8 level (0 info, 1 warn, 2 error) | text
  kInputReady = 106,  // u8 input_ok | u8 has_denoiser | text error
  kVoiceEvent = 107,  // u8 kind | u64 segment | kind-specific fields (input.h VoiceEventKind)
  kEnrollStatus = 108,  // u8 recording | u8 enrolled | u8 denoise_at_enroll | u32 segments_ok | u32 count | u32 dim |
                        // f32[count*dim] | u32 n | f64[n] durations | u32 m | f64[m] pair scores | u16 event bytes |
                        // event | message
  kVoiceStats = 109,  // f32 raw_rms_dbfs | f32 out_rms_dbfs | u8 in_segment | f32 segment_s | u64 frames |
                      // u64 dropped_samples
};

// Little-endian payload builder.
class PayloadWriter {
 public:
  template <typename T>
  PayloadWriter& Put(T value) {
    const size_t at = bytes_.size();
    bytes_.resize(at + sizeof(T));
    std::memcpy(bytes_.data() + at, &value, sizeof(T));
    return *this;
  }
  PayloadWriter& PutText(std::string_view text) {
    bytes_.insert(bytes_.end(), text.begin(), text.end());
    return *this;
  }
  PayloadWriter& PutBytes(const void* data, size_t size) {
    const auto* p = static_cast<const uint8_t*>(data);
    bytes_.insert(bytes_.end(), p, p + size);
    return *this;
  }
  const std::vector<uint8_t>& bytes() const { return bytes_; }

 private:
  std::vector<uint8_t> bytes_;
};

// Little-endian payload reader; every getter returns nullopt past the end.
class PayloadReader {
 public:
  explicit PayloadReader(const std::vector<uint8_t>& bytes) : bytes_(bytes) {}
  template <typename T>
  std::optional<T> Get() {
    if (bytes_.size() - at_ < sizeof(T)) return std::nullopt;
    T value;
    std::memcpy(&value, bytes_.data() + at_, sizeof(T));
    at_ += sizeof(T);
    return value;
  }
  // count raw elements of T; nullopt when fewer remain.
  template <typename T>
  std::optional<std::vector<T>> GetArray(size_t count) {
    if ((bytes_.size() - at_) / sizeof(T) < count) return std::nullopt;
    std::vector<T> values(count);
    std::memcpy(values.data(), bytes_.data() + at_, count * sizeof(T));
    at_ += count * sizeof(T);
    return values;
  }
  std::string RestText() {
    std::string text(bytes_.begin() + static_cast<std::ptrdiff_t>(at_), bytes_.end());
    at_ = bytes_.size();
    return text;
  }

 private:
  const std::vector<uint8_t>& bytes_;
  size_t at_ = 0;
};

// Serializes frames from several threads onto one file descriptor.
class FrameWriter {
 public:
  explicit FrameWriter(int fd) : fd_(fd) {}
  // false once the descriptor is closed or broken; later calls keep returning false.
  bool Write(FrameType type, const PayloadWriter& payload);

 private:
  const int fd_;
  std::mutex mutex_;
  bool broken_ = false;  // guarded by mutex_
};

struct WireFrame {
  FrameType type;
  std::vector<uint8_t> payload;
};

// Blocking read of one frame. nullopt at end of input; *error is set for malformed input.
std::optional<WireFrame> ReadFrame(int fd, std::string* error);

}  // namespace mic_asr

#endif  // MIC_ASR_PROTOCOL_H_
