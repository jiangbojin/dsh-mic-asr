/* base_asr — 流式语音识别、语音活动检测与说话人 embedding 的纯 C 接口（libbase_asr.so，闭源，只提供二进制），API 版本 3。
 *
 * 相互独立的句柄：
 *   - base_asr_recognizer：流式识别器（输出带标点的中英文本），一路音频流；
 *   - base_asr_vad（API 版本 2 新增）：语音活动检测器，输出语音段的开始 / 结束事件，一路音频流；
 *   - base_asr_speaker / base_asr_speaker_registry（API 版本 3 新增）：说话人 embedding 提取器（一路音频流）
 *     与说话人注册表（1:1 确认、1:N 检索）。
 * 设计约束：
 *   - 纯 C99 类型；不跨 ABI 传递 C++ 对象、异常或需要对方释放的内存。
 *   - 所有函数不抛异常（内部捕获并转换为 base_asr_status）；文本均为 UTF-8。
 *   - 符号只导出 base_asr_*；依赖静态链接在 .so 内部，不与宿主的同名库冲突。
 *   - 输入固定为 16 kHz 单声道 int16 PCM；重采样、分帧、线程由宿主负责，库内不创建线程。
 *
 * 生命周期：base_asr_create（注册事件回调）→ base_asr_accept_pcm16 * N → base_asr_finish → … → base_asr_destroy。
 * 识别结果经回调同步交付：回调只在 base_asr_accept_pcm16 / base_asr_finish 内、在调用方线程上触发。
 *
 * 线程安全：同一句柄非线程安全，除 base_asr_api_version / base_asr_version 外，所有调用须由同一线程（或外部串行化）发起。
 * 不同句柄相互独立，可在不同线程并行使用。例外：base_asr_speaker_registry 句柄内部加锁，可被多个线程并发调用。
 *
 * 时延：识别在 base_asr_accept_pcm16 内同步执行。缓存的音频凑满一个 chunk（默认 480 ms）时该次调用做一次推理，
 * 单线程约 50 ms（i7-8750H），其余调用只拷贝音频、立即返回。不要在实时音频回调里直接调用，应转到识别线程。
 */
#ifndef BASE_ASR_H_
#define BASE_ASR_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BASE_ASR_EXPORT __attribute__((visibility("default")))

/** 接口版本；宿主加载后先比对 base_asr_api_version() 与自带头文件的 BASE_ASR_API_VERSION。 */
#define BASE_ASR_API_VERSION 3u

/** 输入采样率：单声道 int16。 */
#define BASE_ASR_SAMPLE_RATE_HZ 16000

typedef enum base_asr_status {
    BASE_ASR_OK                   = 0,
    BASE_ASR_ERR_INVALID_ARGUMENT = 1, /**< 空指针、配置取值非法 */
    BASE_ASR_ERR_STATE            = 2, /**< 在事件回调内对同一句柄再次调用 */
    BASE_ASR_ERR_RUNTIME =
        3 /**< 模型缺失 / 损坏、内部异常；细节见 err 输出或 base_asr_last_error */
} base_asr_status;

/** 识别器句柄（不透明）。 */
typedef struct base_asr_recognizer base_asr_recognizer;

typedef enum base_asr_event_type {
    BASE_ASR_EVENT_PARTIAL = 1, /**< 当前句的中间结果（文本有变化时产生），之后可能被修正 */
    BASE_ASR_EVENT_FINAL = 2 /**< 当前句的最终结果；之后的事件属于下一句 */
} base_asr_event_type;

/** 一条识别事件。只在回调执行期间有效：text 指向库内存储，回调返回后失效，需要保留时由宿主拷贝。 */
typedef struct base_asr_event {
    base_asr_event_type type;
    uint64_t segment_index; /**< 句号，从 0 起；同一句的 partial 与 final 句号相同 */
    /** 事件产生时已送入的音频总时长（ms，自 create 起累计，不含 finish 补的静音），
     *  宿主可据此与送入时刻对齐，计算识别时延。 */
    int64_t input_position_ms;
    const char* text; /**< 当前句的完整文本（不是增量），UTF-8，以 '\0' 结尾，非 NULL、非空串 */
    size_t text_bytes; /**< text 的字节数（不含 '\0'） */
} base_asr_event;

/**
 * 事件回调。在 base_asr_accept_pcm16 / base_asr_finish 内同步调用，执行期间该次调用阻塞，应尽快返回
 * （如拷贝文本后投递到宿主自己的队列）。
 * 回调内不得对同一句柄调用任何 base_asr_* 函数（返回 BASE_ASR_ERR_STATE；base_asr_destroy 为未定义行为），
 * 不得抛出 C++ 异常或 longjmp 跨出回调。
 */
typedef void (*base_asr_event_callback)(void* user_data, const base_asr_event* event);

/** 创建参数。数值字段为 0 时取括号内默认值，故零初始化（C：`= {0}`，C++：`{}`）后填 model_dir 与 on_event 即可。 */
typedef struct base_asr_config {
    const char*
        model_dir; /**< 识别模型目录（运行包的 models/asr），绝对路径或相对进程工作目录，必填 */
    base_asr_event_callback on_event; /**< 事件回调，必填 */
    void* user_data;                  /**< 原样传给 on_event，可为 NULL */
    int chunk_ms; /**< 流式 chunk：160 或 480（480）。160 首字约早 0.2 s，CPU 约翻倍 */
    int num_threads; /**< 推理线程数（1） */
    int disable_endpoint; /**< 非 0 时关闭端点检测，只在 base_asr_finish 时输出 final（0 = 开启） */
    int endpoint_trailing_silence_ms; /**< 句后静音达到该时长即输出该句 final（800） */
    int endpoint_max_utterance_ms;    /**< 单句达到该时长强制切句（20000） */
    int tail_padding_ms; /**< base_asr_finish 时补的静音；流式模型需要右侧上下文，过小会丢句尾（1500）；
                              负数表示不补 */
} base_asr_config;

/** 返回 .so 实现的接口版本（BASE_ASR_API_VERSION）。线程安全。 */
BASE_ASR_EXPORT uint32_t base_asr_api_version(void);

/** 返回版本描述。指向静态存储；线程安全。 */
BASE_ASR_EXPORT const char* base_asr_version(void);

/**
 * 加载模型并创建句柄（约 1 s，常驻内存约 300 MB）。成功时 *out 为新句柄，失败时 *out 为 NULL。
 * @param err 失败原因（可为 NULL）；写入至多 err_bytes 字节，总以 '\0' 结尾（按 UTF-8 字符边界截断）。
 */
BASE_ASR_EXPORT base_asr_status base_asr_create(const base_asr_config* config,
                                                base_asr_recognizer** out, char* err,
                                                size_t err_bytes);

/** 释放句柄。asr 可为 NULL。不得在事件回调内调用。 */
BASE_ASR_EXPORT void base_asr_destroy(base_asr_recognizer* asr);

/**
 * 送入 16 kHz 单声道 int16 PCM（任意长度，如 10 ms = 160 点），产生的事件在返回前经回调交付。
 * count 为 0 时 samples 可为 NULL。
 */
BASE_ASR_EXPORT base_asr_status base_asr_accept_pcm16(base_asr_recognizer* asr,
                                                      const int16_t* samples, size_t count);

/** 音频流结束：补尾部静音、解码剩余音频，当前句非空时经回调交付其 final。之后句柄可继续送入新的音频流。 */
BASE_ASR_EXPORT base_asr_status base_asr_finish(base_asr_recognizer* asr);

/** 丢弃未完成的句子与缓存的音频，回到初始状态（不产生事件）。 */
BASE_ASR_EXPORT base_asr_status base_asr_reset(base_asr_recognizer* asr);

/** 该句柄上最近一次调用的错误原因，写入 buf（至多 buf_bytes 字节，总以 '\0' 结尾）；最近一次调用成功时为空串。
 *  asr 为 NULL 时写入空串。 */
BASE_ASR_EXPORT void base_asr_last_error(const base_asr_recognizer* asr, char* buf,
                                         size_t buf_bytes);

/* ── 语音活动检测（API 版本 2）─────────────────────────────────────────────────────────────────────
 *
 * 生命周期：base_asr_vad_create（注册事件回调）→ base_asr_vad_accept_pcm16 * N → base_asr_vad_finish → …
 * → base_asr_vad_destroy。事件经回调同步交付，回调规则与识别器相同（见 base_asr_event_callback）。
 * 线程安全与识别器相同：同一句柄非线程安全，不同句柄（含识别器句柄）相互独立。
 * 开销：每 16 ms 帧一次推理，单线程 RTF 约 0.006（i7-8750H），可以和识别器在同一线程上串行调用。
 */

/** 语音活动检测器句柄（不透明）。 */
typedef struct base_asr_vad base_asr_vad;

typedef enum base_asr_vad_event_type {
    BASE_ASR_VAD_SPEECH_START = 1, /**< 语音已确认开始（比实际开始晚约 min_speech_ms） */
    BASE_ASR_VAD_SPEECH_END = 2 /**< 本段结束（比实际结束晚约 min_silence_ms） */
} base_asr_vad_event_type;

/** 一条语音段事件。时间为句柄创建以来累计送入的音频时长（ms），finish / reset 不清零。 */
typedef struct base_asr_vad_event {
    base_asr_vad_event_type type;
    uint64_t segment_index; /**< 段号，从 0 起；同一段的 START 与 END 段号相同 */
    /** 段起点。START 时为回溯后的起点（确认位置回溯 2 帧 + min_speech_ms），与同段 END 的 start_ms 相同。 */
    int64_t start_ms;
    /** START：确认开始时已送入的音频时长；END：段终点（不含段尾用于确认的 min_silence_ms 静音）。 */
    int64_t end_ms;
} base_asr_vad_event;

/** VAD 事件回调。在 base_asr_vad_accept_pcm16 / base_asr_vad_finish 内同步调用，规则同 base_asr_event_callback。 */
typedef void (*base_asr_vad_event_callback)(void* user_data, const base_asr_vad_event* event);

/** 创建参数。数值字段为 0 时取括号内默认值，故零初始化后填 model_dir 与 on_event 即可。 */
typedef struct base_asr_vad_config {
    const char* model_dir; /**< VAD 模型目录（运行包的 models/vad），必填 */
    base_asr_vad_event_callback on_event; /**< 事件回调，必填 */
    void* user_data;                      /**< 原样传给 on_event，可为 NULL */
    int frame_ms; /**< 检测帧长：16 或 10（16）。10 ms 精度略低、CPU 约 1.6 倍 */
    float
        threshold; /**< 语音概率阈值，须在 [0.01, 1)（0.5）；进入语音后低于 threshold - 0.15 才算静音 */
    int min_silence_ms; /**< 段后静音达到该时长才结束本段（500） */
    int min_speech_ms; /**< 语音持续达到该时长才开始一段，更短的视为噪声（250） */
    int max_speech_ms; /**< 一段超过该时长后改用阈值 0.9、最短静音 100 ms，使其尽快结束；不是硬切（20000） */
    int num_threads;   /**< 推理线程数（1） */
} base_asr_vad_config;

/**
 * 加载模型并创建 VAD 句柄（约 50 ms，粗测；只用 VAD 的进程峰值内存约 34 MB，含 ORT 运行时）。成功时 *out 为新句柄，
 * 失败时 *out 为 NULL。
 * @param err 失败原因（可为 NULL），规则同 base_asr_create。
 */
BASE_ASR_EXPORT base_asr_status base_asr_vad_create(const base_asr_vad_config* config,
                                                    base_asr_vad** out, char* err,
                                                    size_t err_bytes);

/** 释放句柄。vad 可为 NULL。不得在事件回调内调用。 */
BASE_ASR_EXPORT void base_asr_vad_destroy(base_asr_vad* vad);

/** 送入 16 kHz 单声道 int16 PCM（任意长度），产生的事件在返回前经回调交付。count 为 0 时 samples 可为 NULL。 */
BASE_ASR_EXPORT base_asr_status base_asr_vad_accept_pcm16(base_asr_vad* vad, const int16_t* samples,
                                                          size_t count);

/** 音频流结束：处于语音段中时以当前输入位置结束该段并交付 END。之后句柄可继续送入新的音频流。 */
BASE_ASR_EXPORT base_asr_status base_asr_vad_finish(base_asr_vad* vad);

/** 丢弃未完成的段与缓存的音频（不产生事件；已交付 START 的段不会再有 END，段号作废）。 */
BASE_ASR_EXPORT base_asr_status base_asr_vad_reset(base_asr_vad* vad);

/** 该句柄上最近一次调用的错误原因，规则同 base_asr_last_error。 */
BASE_ASR_EXPORT void base_asr_vad_last_error(const base_asr_vad* vad, char* buf, size_t buf_bytes);

/* ── 说话人 embedding（API 版本 3）─────────────────────────────────────────────────────────────────
 *
 * 提取器 base_asr_speaker：一段音频（只含一个说话人，切段由宿主负责，如用 base_asr_vad）分块送入，段末
 * base_asr_speaker_compute 得到 L2 归一化的 embedding，两段的余弦相似度即点积。
 * 生命周期：base_asr_speaker_create → (base_asr_speaker_accept_pcm16 * N → base_asr_speaker_compute) * M → destroy。
 * 线程安全同识别器：同一句柄非线程安全。开销：单线程 RTF 约 0.017，计算集中在 compute（10 s 音频约 0.17 s）。
 *
 * 注册表 base_asr_speaker_registry：按名字保存注册向量，与提取器相互独立（只存向量，可被多个提取器共用）。
 * 打分为余弦相似度，阈值由宿主按场景标定（模型官方示例 0.33；CN-Celeb 上 EER 点约 0.32~0.34）。只在内存中，不持久化。
 * 线程安全：内部读写锁，verify / search / contains / size 可并发，enroll / remove 互斥。
 */

/** 说话人 embedding 提取器句柄（不透明）。 */
typedef struct base_asr_speaker base_asr_speaker;

/** 创建参数。数值字段为 0 时取括号内默认值，故零初始化后填 model_dir 即可。 */
typedef struct base_asr_speaker_config {
    const char*
        model_dir; /**< 声纹模型目录（运行包的 models/speaker），必填 */
    int num_threads; /**< 推理线程数（1） */
} base_asr_speaker_config;

/**
 * 加载模型并创建提取器句柄（约 0.7 s，粗测；只用提取器的进程峰值内存约 90 MB）。成功时 *out 为新句柄，失败时 *out 为 NULL。
 * @param err 失败原因（可为 NULL），规则同 base_asr_create。
 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_create(const base_asr_speaker_config* config,
                                                        base_asr_speaker** out, char* err,
                                                        size_t err_bytes);

/** 释放句柄。speaker 可为 NULL。 */
BASE_ASR_EXPORT void base_asr_speaker_destroy(base_asr_speaker* speaker);

/** embedding 维度；speaker 为 NULL 时返回 0。 */
BASE_ASR_EXPORT int32_t base_asr_speaker_dim(const base_asr_speaker* speaker);

/** 把 16 kHz 单声道 int16 PCM（任意长度）追加到当前段；结果与分块方式无关。count 为 0 时 samples 可为 NULL。 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_accept_pcm16(base_asr_speaker* speaker,
                                                              const int16_t* samples, size_t count);

/**
 * 结束当前段，把其 embedding（L2 归一化，dim 个 float）写入 embedding。
 * 音频过短（不足 45 ms）时 *has_embedding 为 0、embedding 不写入；否则为 1。无论结果如何，之后都从空段开始接收下一段。
 * @param capacity embedding 可容纳的 float 个数，须 >= base_asr_speaker_dim()；否则返回 BASE_ASR_ERR_INVALID_ARGUMENT
 *                 且当前段保持不变。
 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_compute(base_asr_speaker* speaker,
                                                         float* embedding, size_t capacity,
                                                         int* has_embedding);

/** 丢弃当前段已送入的音频。 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_reset(base_asr_speaker* speaker);

/** 该句柄上最近一次调用的错误原因，规则同 base_asr_last_error。 */
BASE_ASR_EXPORT void base_asr_speaker_last_error(const base_asr_speaker* speaker, char* buf,
                                                 size_t buf_bytes);

/** 说话人注册表句柄（不透明）。 */
typedef struct base_asr_speaker_registry base_asr_speaker_registry;

/** base_asr_speaker_registry_search 的一条结果。 */
typedef struct base_asr_speaker_match {
    /** 说话人名字，UTF-8，以 '\0' 结尾；指向注册表内的存储，在该说话人被 remove 或注册表 destroy 之前有效
     *  （其他线程并发 remove 时由宿主自行协调）。 */
    const char* name;
    size_t name_bytes; /**< name 的字节数（不含 '\0'） */
    float score;       /**< 余弦相似度，[-1, 1] */
} base_asr_speaker_match;

/**
 * 创建空注册表。dim 须与提取器的 base_asr_speaker_dim() 相同。
 * @param err 失败原因（可为 NULL），规则同 base_asr_create。
 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_registry_create(int32_t dim,
                                                                 base_asr_speaker_registry** out,
                                                                 char* err, size_t err_bytes);

/** 释放注册表。registry 可为 NULL。调用时不得有其他线程正在使用该注册表。 */
BASE_ASR_EXPORT void base_asr_speaker_registry_destroy(base_asr_speaker_registry* registry);

/**
 * 注册一个说话人：count 条 embedding 连续存放（count * dim 个 float），各自归一化后取平均作为注册向量。
 * name 为非空 UTF-8 串。名字已注册时 *enrolled 为 0、注册表不变（要更新须先 remove），否则为 1。
 * embedding 含非有限值或全零时返回 BASE_ASR_ERR_INVALID_ARGUMENT。
 */
BASE_ASR_EXPORT base_asr_status
base_asr_speaker_registry_enroll(base_asr_speaker_registry* registry, const char* name,
                                 const float* embeddings, size_t count, int* enrolled);

/** 删除一个说话人；*removed 为 1 表示已删除，0 表示未注册。之前 search 返回的该名字指针随之失效。 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_registry_remove(
    base_asr_speaker_registry* registry, const char* name, int* removed);

/** *contains 为 1 表示 name 已注册。 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_registry_contains(
    const base_asr_speaker_registry* registry, const char* name, int* contains);

/** 已注册的说话人数；registry 为 NULL 时返回 0。 */
BASE_ASR_EXPORT size_t base_asr_speaker_registry_size(const base_asr_speaker_registry* registry);

/**
 * 1:1 确认：query（dim 个 float）与 name 的注册向量的余弦 >= threshold 时 *is_match 为 1；name 未注册时为 0。
 */
BASE_ASR_EXPORT base_asr_status
base_asr_speaker_registry_verify(const base_asr_speaker_registry* registry, const char* name,
                                 const float* query, float threshold, int* is_match);

/**
 * 1:N 检索：余弦 >= threshold 的说话人按相似度降序写入 matches，至多 capacity 条，实际条数写入 *count。
 * @param capacity 须 >= 1。
 */
BASE_ASR_EXPORT base_asr_status base_asr_speaker_registry_search(
    const base_asr_speaker_registry* registry, const float* query, float threshold,
    base_asr_speaker_match* matches, size_t capacity, size_t* count);

/** 调用线程在该注册表上最近一次调用的错误原因（各线程独立），写入规则同 base_asr_last_error。 */
BASE_ASR_EXPORT void base_asr_speaker_registry_last_error(const base_asr_speaker_registry* registry,
                                                          char* buf, size_t buf_bytes);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif /* BASE_ASR_H_ */
