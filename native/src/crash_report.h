// dsh-mic-asr worker: on a fatal signal, write the backtrace and the most recent uplink audio to a crash
// directory so the failure can be replayed, then die with the original signal.

#ifndef MIC_ASR_CRASH_REPORT_H_
#define MIC_ASR_CRASH_REPORT_H_

#include <cstddef>
#include <cstdint>
#include <string>

namespace mic_asr {

// Installs handlers for SIGSEGV, SIGBUS, SIGFPE, SIGILL and SIGABRT. An empty directory only prints the
// backtrace to stderr. Call once, before other threads start.
void InstallCrashReport(const std::string& directory);

// Records uplink audio into a fixed ring of the last 60 seconds; called on the recognition thread only.
void RecordUplink(const int16_t* samples, size_t count);

}  // namespace mic_asr

#endif  // MIC_ASR_CRASH_REPORT_H_
