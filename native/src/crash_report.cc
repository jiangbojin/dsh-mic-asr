#include "crash_report.h"

#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <cstring>

namespace mic_asr {
namespace {

constexpr size_t kRingSamples = 16000 * 60;
int16_t ring[kRingSamples];
std::atomic<uint64_t> written{0};  // total samples recorded; the ring holds the last kRingSamples
char trace_path[512];
char audio_path[512];

void WriteAll(int fd, const void* data, size_t size) {
  const auto* p = static_cast<const char*>(data);
  while (size > 0) {
    const ssize_t n = write(fd, p, size);
    if (n <= 0) return;
    p += n;
    size -= static_cast<size_t>(n);
  }
}

// Only async-signal-safe calls, except backtrace(), which is preloaded in InstallCrashReport.
void OnFatal(int signal) {
  void* frames[64];
  const int depth = backtrace(frames, 64);
  static const char kHeader[] = "dsh-mic-asr-worker: fatal signal, backtrace:\n";
  WriteAll(STDERR_FILENO, kHeader, sizeof(kHeader) - 1);
  backtrace_symbols_fd(frames, depth, STDERR_FILENO);
  if (trace_path[0] != '\0') {
    const int fd = open(trace_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
      backtrace_symbols_fd(frames, depth, fd);
      close(fd);
    }
  }
  if (audio_path[0] != '\0') {
    const int fd = open(audio_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd >= 0) {
      const uint64_t total = written.load();
      const size_t count = total < kRingSamples ? static_cast<size_t>(total) : kRingSamples;
      const size_t start = static_cast<size_t>((total - count) % kRingSamples);
      const size_t first = count < kRingSamples - start ? count : kRingSamples - start;
      WriteAll(fd, ring + start, first * sizeof(int16_t));
      WriteAll(fd, ring, (count - first) * sizeof(int16_t));
      close(fd);
    }
  }
  ::signal(signal, SIG_DFL);
  raise(signal);
}

}  // namespace

void InstallCrashReport(const std::string& directory) {
  if (!directory.empty()) {
    const long pid = static_cast<long>(getpid());
    std::snprintf(trace_path, sizeof(trace_path), "%s/crash-%ld.txt", directory.c_str(), pid);
    std::snprintf(audio_path, sizeof(audio_path), "%s/crash-%ld.16k.s16le", directory.c_str(), pid);
  }
  void* warm[1];
  backtrace(warm, 1);  // loads libgcc before any signal
  for (int signal : {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT}) ::signal(signal, OnFatal);
}

void RecordUplink(const int16_t* samples, size_t count) {
  uint64_t at = written.load(std::memory_order_relaxed);
  for (size_t i = 0; i < count; ++i) ring[(at + i) % kRingSamples] = samples[i];
  written.store(at + count, std::memory_order_release);
}

}  // namespace mic_asr
