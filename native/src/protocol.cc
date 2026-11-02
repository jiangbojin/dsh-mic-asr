#include "protocol.h"

#include <unistd.h>

#include <cerrno>
#include <string>

namespace mic_asr {
namespace {

bool WriteAll(int fd, const uint8_t* data, size_t size) {
  while (size > 0) {
    const ssize_t n = write(fd, data, size);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return false;
    data += n;
    size -= static_cast<size_t>(n);
  }
  return true;
}

// 1 when complete, 0 at end of input before the first byte, -1 on a short or failed read.
int ReadAll(int fd, uint8_t* data, size_t size) {
  size_t done = 0;
  while (done < size) {
    const ssize_t n = read(fd, data + done, size - done);
    if (n < 0 && errno == EINTR) continue;
    if (n == 0) return done == 0 ? 0 : -1;
    if (n < 0) return -1;
    done += static_cast<size_t>(n);
  }
  return 1;
}

}  // namespace

bool FrameWriter::Write(FrameType type, const PayloadWriter& payload) {
  const std::vector<uint8_t>& body = payload.bytes();
  uint8_t header[6];
  const auto size = static_cast<uint32_t>(body.size());
  const auto kind = static_cast<uint16_t>(type);
  std::memcpy(header, &size, 4);
  std::memcpy(header + 4, &kind, 2);
  std::lock_guard lock(mutex_);
  if (broken_) return false;
  broken_ = !WriteAll(fd_, header, sizeof(header)) || !WriteAll(fd_, body.data(), body.size());
  return !broken_;
}

std::optional<WireFrame> ReadFrame(int fd, std::string* error) {
  uint8_t header[6];
  const int status = ReadAll(fd, header, sizeof(header));
  if (status == 0) return std::nullopt;
  if (status < 0) {
    *error = "truncated frame header";
    return std::nullopt;
  }
  uint32_t size;
  uint16_t kind;
  std::memcpy(&size, header, 4);
  std::memcpy(&kind, header + 4, 2);
  if (size > kMaxPayloadBytes) {
    *error = "frame payload of " + std::to_string(size) + " bytes exceeds the limit";
    return std::nullopt;
  }
  WireFrame frame{static_cast<FrameType>(kind), std::vector<uint8_t>(size)};
  if (size > 0 && ReadAll(fd, frame.payload.data(), size) != 1) {
    *error = "truncated frame payload";
    return std::nullopt;
  }
  return frame;
}

}  // namespace mic_asr
