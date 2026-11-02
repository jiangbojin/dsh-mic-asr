// dsh-mic-asr worker: command-line options (`--name=value`).

#ifndef MIC_ASR_OPTIONS_H_
#define MIC_ASR_OPTIONS_H_

#include <string>

#include "input.h"

namespace mic_asr {

struct WorkerOptions {
  InputOptions input;
  // Crash backtrace and recent uplink audio go here; empty prints the backtrace to stderr only.
  std::string crash_dir;
};

// Parses argv[first..argc). Unknown names, missing values and malformed integers fail with *error;
// --asr-library is required.
bool ParseOptions(int argc, char** argv, int first, WorkerOptions* out, std::string* error);

}  // namespace mic_asr

#endif  // MIC_ASR_OPTIONS_H_
