#ifndef NEXTTOOLS_SPEECH_ADAPTER_H_
#define NEXTTOOLS_SPEECH_ADAPTER_H_

#include <stdint.h>

#if defined(_WIN32)
#define NEXTTOOLS_SPEECH_EXPORT __declspec(dllexport)
#elif defined(__GNUC__)
#define NEXTTOOLS_SPEECH_EXPORT __attribute__((visibility("default")))
#else
#define NEXTTOOLS_SPEECH_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Stable, product-specific ABI between nexttools-media-worker and the pinned
 * sherpa-onnx adapter. The adapter owns every opaque handle it returns. Caller
 * memory is used for all variable-sized output, so no allocator crosses this
 * boundary.
 */

#define NEXTTOOLS_SPEECH_ADAPTER_ABI_VERSION 2u
#define NEXTTOOLS_SPEECH_SAMPLE_RATE 16000u
#define NEXTTOOLS_SPEECH_EMBEDDING_DIMENSION 512u
#define NEXTTOOLS_SPEECH_MAX_PCM_CHUNK_SAMPLES (5u * NEXTTOOLS_SPEECH_SAMPLE_RATE)
#define NEXTTOOLS_SPEECH_MAX_ASR_SAMPLES (60u * NEXTTOOLS_SPEECH_SAMPLE_RATE)
#define NEXTTOOLS_SPEECH_MAX_TEXT_BYTES (64u * 1024u)
#define NEXTTOOLS_SPEECH_MAX_DIARIZATION_SAMPLES \
  (300u * NEXTTOOLS_SPEECH_SAMPLE_RATE)
#define NEXTTOOLS_SPEECH_MAX_RAW_OBSERVATIONS 192u
#define NEXTTOOLS_SPEECH_MAX_LOCAL_SEGMENTS 16384u
#define NEXTTOOLS_SPEECH_MAX_CLUSTER_NODES 2048u

typedef enum NextToolsSpeechStatus {
  NEXTTOOLS_SPEECH_STATUS_OK = 0,
  NEXTTOOLS_SPEECH_STATUS_INVALID_ARGUMENT = 1,
  NEXTTOOLS_SPEECH_STATUS_UNAVAILABLE = 2,
  NEXTTOOLS_SPEECH_STATUS_BUFFER_TOO_SMALL = 3,
  NEXTTOOLS_SPEECH_STATUS_MODEL_ERROR = 4,
  NEXTTOOLS_SPEECH_STATUS_INFERENCE_ERROR = 5,
  NEXTTOOLS_SPEECH_STATUS_RESOURCE_LIMIT = 6,
} NextToolsSpeechStatus;

typedef struct NextToolsSpeechBuildInfo {
  uint32_t struct_size;
  uint32_t abi_version;
  const char *sherpa_onnx_version;
  const char *sherpa_onnx_commit;
  const char *onnx_runtime_version;
  uint32_t sample_rate;
  uint32_t embedding_dimension;
} NextToolsSpeechBuildInfo;

typedef struct NextToolsSpeechUtf8Buffer {
  char *data;
  uint32_t capacity;
  uint32_t length;
} NextToolsSpeechUtf8Buffer;

typedef struct NextToolsSpeechAsrConfig {
  uint32_t struct_size;
  const char *sense_voice_model;
  const char *tokens;
  uint32_t num_threads;
  int32_t use_itn;
} NextToolsSpeechAsrConfig;

typedef struct NextToolsSpeechAsrResult {
  uint32_t struct_size;
  NextToolsSpeechUtf8Buffer text;
  NextToolsSpeechUtf8Buffer language;
  NextToolsSpeechUtf8Buffer emotion;
  NextToolsSpeechUtf8Buffer event;
} NextToolsSpeechAsrResult;

typedef struct NextToolsSpeechVadConfig {
  uint32_t struct_size;
  const char *silero_model;
  uint32_t num_threads;
  float threshold;
  float min_silence_seconds;
  float min_speech_seconds;
  float max_speech_seconds;
} NextToolsSpeechVadConfig;

typedef struct NextToolsSpeechVadSegment {
  uint32_t struct_size;
  uint64_t start_sample;
  float *samples;
  uint32_t sample_capacity;
  uint32_t sample_count;
} NextToolsSpeechVadSegment;

typedef struct NextToolsSpeechDiarizerConfig {
  uint32_t struct_size;
  const char *segmentation_model;
  const char *embedding_model;
  uint32_t num_threads;
  float segmentation_window_shift_ratio;
} NextToolsSpeechDiarizerConfig;

typedef struct NextToolsSpeechLocalSpeaker {
  uint32_t local_speaker;
  uint32_t chunk_index;
  uint32_t slot;
  uint32_t chunk_start;
  uint32_t chunk_end;
  uint32_t clean_samples;
  uint32_t embedding_status;
  /* UINT32_MAX for unavailable embeddings; otherwise an offset in floats. */
  uint32_t embedding_offset;
} NextToolsSpeechLocalSpeaker;

typedef struct NextToolsSpeechInterval {
  uint64_t start_sample;
  uint64_t end_sample;
} NextToolsSpeechInterval;

typedef struct NextToolsSpeechLocalSegment {
  uint64_t start_sample;
  uint64_t end_sample;
  uint32_t local_speaker;
} NextToolsSpeechLocalSegment;

typedef struct NextToolsSpeechDiarizationOutput {
  uint32_t struct_size;
  NextToolsSpeechLocalSpeaker *speakers;
  uint32_t speaker_capacity;
  uint32_t speaker_count;
  NextToolsSpeechLocalSegment *segments;
  uint32_t segment_capacity;
  uint32_t segment_count;
  NextToolsSpeechLocalSegment *clean_segments;
  uint32_t clean_segment_capacity;
  uint32_t clean_segment_count;
  float *embeddings;
  uint32_t embedding_capacity;
  uint32_t embedding_count;
} NextToolsSpeechDiarizationOutput;

typedef struct NextToolsSpeechAsr NextToolsSpeechAsr;
typedef struct NextToolsSpeechVad NextToolsSpeechVad;
typedef struct NextToolsSpeechDiarizer NextToolsSpeechDiarizer;
typedef struct NextToolsSpeechDiarizationResult
    NextToolsSpeechDiarizationResult;
typedef void (*NextToolsSpeechEmbeddingStartedCallback)(void *user_data);

typedef struct NextToolsSpeechAdapterApiV2 {
  uint32_t struct_size;
  uint32_t abi_version;

  NextToolsSpeechStatus (*get_build_info)(NextToolsSpeechBuildInfo *out);

  NextToolsSpeechStatus (*create_asr)(const NextToolsSpeechAsrConfig *config,
                                     NextToolsSpeechAsr **out);
  void (*destroy_asr)(NextToolsSpeechAsr *asr);
  NextToolsSpeechStatus (*transcribe)(NextToolsSpeechAsr *asr,
                                     const float *samples,
                                     uint32_t sample_count,
                                     NextToolsSpeechAsrResult *out);

  NextToolsSpeechStatus (*create_vad)(const NextToolsSpeechVadConfig *config,
                                     NextToolsSpeechVad **out);
  void (*destroy_vad)(NextToolsSpeechVad *vad);
  NextToolsSpeechStatus (*vad_accept)(NextToolsSpeechVad *vad,
                                     const float *samples,
                                     uint32_t sample_count);
  NextToolsSpeechStatus (*vad_flush)(NextToolsSpeechVad *vad);
  NextToolsSpeechStatus (*vad_pop)(NextToolsSpeechVad *vad,
                                  NextToolsSpeechVadSegment *out);
  NextToolsSpeechStatus (*vad_reset)(NextToolsSpeechVad *vad);

  NextToolsSpeechStatus (*create_diarizer)(
      const NextToolsSpeechDiarizerConfig *config,
      NextToolsSpeechDiarizer **out);
  void (*destroy_diarizer)(NextToolsSpeechDiarizer *diarizer);
  NextToolsSpeechStatus (*diarize_window)(
      NextToolsSpeechDiarizer *diarizer, const float *samples,
      uint32_t sample_count,
      const NextToolsSpeechInterval *excluded, uint32_t excluded_count,
      NextToolsSpeechEmbeddingStartedCallback embedding_started,
      void *user_data, NextToolsSpeechDiarizationResult **out);
  NextToolsSpeechStatus (*copy_diarization_result)(
      const NextToolsSpeechDiarizationResult *result,
      NextToolsSpeechDiarizationOutput *out);
  void (*destroy_diarization_result)(
      NextToolsSpeechDiarizationResult *result);
  NextToolsSpeechStatus (*cluster_distances)(
      const double *distances, uint32_t distance_count, uint32_t node_count,
      double distance_threshold, uint32_t *labels, uint32_t label_capacity,
      uint32_t *speaker_count);
} NextToolsSpeechAdapterApiV2;

NEXTTOOLS_SPEECH_EXPORT const NextToolsSpeechAdapterApiV2 *
nexttools_speech_adapter_get_api(uint32_t requested_abi_version);

#ifdef __cplusplus
}
#endif

#endif  /* NEXTTOOLS_SPEECH_ADAPTER_H_ */
