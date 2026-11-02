cmake_minimum_required(VERSION 3.20)
project(dsh_mic_asr_worker CXX)

# The speech libraries are closed-source binaries loaded with dlopen at run time from configured paths;
# include/ holds their public C headers.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

find_package(Threads REQUIRED)

add_executable(dsh-mic-asr-worker
  src/crash_report.cc
  src/input.cc
  src/main.cc
  src/native_libraries.cc
  src/options.cc
  src/protocol.cc
  src/voice_processor.cc
)
target_include_directories(dsh-mic-asr-worker PRIVATE src)
target_include_directories(dsh-mic-asr-worker SYSTEM PRIVATE include)
target_compile_options(dsh-mic-asr-worker PRIVATE -Wall -Wextra -Werror)
target_link_libraries(dsh-mic-asr-worker PRIVATE Threads::Threads ${CMAKE_DL_LIBS})
