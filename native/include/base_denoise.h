/* base_denoise — 流式降噪的纯 C 接口（libbase_denoise.so，闭源，只提供二进制；导出函数前缀为 qnsz_denoise_），API 版本 1。
 *
 * 设计约束：
 *   - 纯 C99 类型；不跨 ABI 传递 C++ 对象、异常或需要对方释放的内存。
 *   - 所有函数不抛异常（内部捕获并转换为 qnsz_denoise_status）。
 *   - 符号只导出 qnsz_denoise_*；依赖与模型权重静态链接在 .so 内部，不与宿主的同名库冲突。
 *     宿主以 dlopen(RTLD_NOW | RTLD_LOCAL) 加载。
 *   - 运行时零磁盘依赖：权重编译进 .so，不传模型路径。
 *
 * 音频：16 kHz 单声道 float，取值 [-1, 1]；每次处理固定一帧（qnsz_denoise_frame_size()，160 点 = 10 ms）。
 * 算法时延 qnsz_denoise_latency_frames() 帧（2 帧 = 20 ms）：输出相对输入滞后这么多帧。
 * create / reset 之后的第一帧只用于预热，原样输出输入。
 *
 * 生命周期：qnsz_denoise_create → qnsz_denoise_process * N（→ qnsz_denoise_reset → …）→ qnsz_denoise_destroy。
 *
 * 线程安全：同一句柄非线程安全，除 qnsz_denoise_api_version / qnsz_denoise_version 外，所有调用须由同一线程
 * （或外部串行化）发起。不同句柄相互独立，可在不同线程并行使用；create 本身线程安全。
 *
 * 开销：每帧一次推理，库内不创建线程（推理线程数见 num_threads）。
 */
#ifndef QNSZ_DENOISE_H_
#define QNSZ_DENOISE_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define QNSZ_DENOISE_EXPORT __attribute__((visibility("default")))

/** 接口版本；宿主加载后先比对 qnsz_denoise_api_version() 与自带头文件的 QNSZ_DENOISE_API_VERSION。 */
#define QNSZ_DENOISE_API_VERSION 1u

typedef enum qnsz_denoise_status {
    QNSZ_DENOISE_OK                   = 0,
    QNSZ_DENOISE_ERR_INVALID_ARGUMENT = 1, /**< 空指针、配置取值非法 */
    QNSZ_DENOISE_ERR_RUNTIME = 3 /**< 模型加载失败、推理出错、内部异常；细节见 err 输出或 qnsz_denoise_last_error */
} qnsz_denoise_status;

/** 降噪器句柄（不透明）。 */
typedef struct qnsz_denoise qnsz_denoise;

/** 创建参数。数值字段为 0 时取括号内默认值，故零初始化（C：`= {0}`，C++：`{}`）即可；也可传 NULL。 */
typedef struct qnsz_denoise_config {
    int num_threads; /**< 推理线程数（1）；负数非法 */
} qnsz_denoise_config;

/** 返回 .so 实现的接口版本（QNSZ_DENOISE_API_VERSION）。线程安全。 */
QNSZ_DENOISE_EXPORT uint32_t qnsz_denoise_api_version(void);

/** 返回版本描述。指向静态存储；线程安全。 */
QNSZ_DENOISE_EXPORT const char* qnsz_denoise_version(void);

/**
 * 加载内嵌模型并创建句柄。成功时 *out 为新句柄，失败时 *out 为 NULL。
 * @param config 可为 NULL（全部取默认值）。
 * @param err 失败原因（可为 NULL）；写入至多 err_bytes 字节，总以 '\0' 结尾。
 */
QNSZ_DENOISE_EXPORT qnsz_denoise_status qnsz_denoise_create(const qnsz_denoise_config* config,
                                                            qnsz_denoise** out, char* err,
                                                            size_t err_bytes);

/** 释放句柄。denoise 可为 NULL。 */
QNSZ_DENOISE_EXPORT void qnsz_denoise_destroy(qnsz_denoise* denoise);

/** 采样率（16000）；denoise 为 NULL 时返回 0。 */
QNSZ_DENOISE_EXPORT int32_t qnsz_denoise_sample_rate(const qnsz_denoise* denoise);

/** 每帧采样点数（160）；denoise 为 NULL 时返回 0。 */
QNSZ_DENOISE_EXPORT int32_t qnsz_denoise_frame_size(const qnsz_denoise* denoise);

/** 算法时延帧数（2）；denoise 为 NULL 时返回 0。 */
QNSZ_DENOISE_EXPORT int32_t qnsz_denoise_latency_frames(const qnsz_denoise* denoise);

/**
 * 处理一帧：input、output 各 qnsz_denoise_frame_size() 个 float，可以是同一块内存（原地处理）。
 * 推理出错时返回 QNSZ_DENOISE_ERR_RUNTIME，输出未定义。错误状态会保持（reset 不清除，之后每帧都返回
 * QNSZ_DENOISE_ERR_RUNTIME），宿主应销毁并重建句柄，或改为旁路。
 */
QNSZ_DENOISE_EXPORT qnsz_denoise_status qnsz_denoise_process(qnsz_denoise* denoise,
                                                             const float* input, float* output);

/** 丢弃流式历史状态，回到刚创建时的状态（开始新音频流时调用）。 */
QNSZ_DENOISE_EXPORT qnsz_denoise_status qnsz_denoise_reset(qnsz_denoise* denoise);

/** 该句柄上最近一次 process / reset 的错误原因，写入 buf（至多 buf_bytes 字节，总以 '\0' 结尾）；成功时为空串。
 *  denoise 为 NULL 时写入空串。 */
QNSZ_DENOISE_EXPORT void qnsz_denoise_last_error(const qnsz_denoise* denoise, char* buf,
                                                 size_t buf_bytes);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif /* QNSZ_DENOISE_H_ */
