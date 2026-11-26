#include "vendor/cgif_raw.h"
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <node_api.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* worker 专用：严格容器解析与索引解码共用边界，逐帧重建 LZW。 */
#define MAX_BYTES 20000000
#define MAX_FRAMES 100
#define MAX_PIXELS 32000000
typedef struct {
  const uint8_t *data;
  size_t size, pos;
  int bad;
} Reader;
typedef struct {
  unsigned left, top, width, height, colors, minimum, delay, disposal,
      interlace;
  int transparent;
  const uint8_t *palette, *blocks;
  size_t block_size;
} Frame;
typedef struct {
  unsigned width, height, colors, background, loop, count;
  int loop_seen;
  uint8_t global[768];
  Frame frames[MAX_FRAMES];
} Gif;

/* 游标越界后不再前进，所有子块大小都受实际输入长度约束。 */
static unsigned byte(Reader *r) {
  if (r->pos >= r->size) {
    r->bad = 1;
    return 0;
  }
  return r->data[r->pos++];
}
static unsigned word(Reader *r) {
  unsigned lo = byte(r);
  return lo | (byte(r) << 8);
}
static const uint8_t *take(Reader *r, size_t n) {
  if (n > r->size - r->pos) {
    r->bad = 1;
    return NULL;
  }
  const uint8_t *p = r->data + r->pos;
  r->pos += n;
  return p;
}
static size_t blocks(Reader *r) {
  size_t total = 0;
  unsigned n;
  while (!r->bad && (n = byte(r))) {
    if (!take(r, n))
      break;
    total += n;
  }
  return total;
}

/* 与现有 JS 容器扫描逐项对照，未知扩展不自动成为可见像素帧。 */
static int parse(const uint8_t *data, size_t size, Gif *gif) {
  memset(gif, 0, sizeof(*gif));
  gif->loop = 1;
  Reader r = {data, size, 0, 0};
  const uint8_t *sig = take(&r, 6);
  if (!sig || (memcmp(sig, "GIF87a", 6) && memcmp(sig, "GIF89a", 6)))
    return 0;
  gif->width = word(&r);
  gif->height = word(&r);
  unsigned packed = byte(&r);
  gif->background = byte(&r);
  byte(&r);
  if (!gif->width || !gif->height || gif->width > 4096 || gif->height > 4096)
    return 0;
  gif->colors = (packed & 128) ? 1u << ((packed & 7) + 1) : 0;
  if (gif->colors) {
    const uint8_t *p = take(&r, gif->colors * 3);
    if (!p || gif->background >= gif->colors)
      return 0;
    memcpy(gif->global, p, gif->colors * 3);
  }
  int control = 0, transparent = -1;
  unsigned delay = 10, disposal = 0;
  while (!r.bad && r.pos < r.size) {
    unsigned marker = byte(&r);
    if (marker == 0x3b)
      return !r.bad && r.pos == r.size && gif->count && !control;
    if (marker == 0x21) {
      unsigned label = byte(&r);
      if (label == 0xf9) {
        if (control || byte(&r) != 4)
          return 0;
        unsigned flags = byte(&r);
        if ((flags & 0xe2) || ((flags >> 2) & 7) > 3)
          return 0;
        delay = word(&r);
        unsigned index = byte(&r);
        if (byte(&r) != 0)
          return 0;
        transparent = (flags & 1) ? (int)index : -1;
        disposal = (flags >> 2) & 7;
        control = 1;
      } else if (label == 0xff) {
        if (byte(&r) != 11)
          return 0;
        const uint8_t *app = take(&r, 11);
        if (!app)
          return 0;
        if (!memcmp(app, "NETSCAPE2.0", 11) ||
            !memcmp(app, "ANIMEXTS1.0", 11)) {
          if (gif->loop_seen || byte(&r) != 3 || byte(&r) != 1)
            return 0;
          unsigned repeat = word(&r);
          if (byte(&r) != 0)
            return 0;
          gif->loop = repeat ? repeat + 1 : 0;
          gif->loop_seen = 1;
        } else
          blocks(&r);
      } else if (label == 0xfe)
        blocks(&r);
      else
        return 0;
      continue;
    }
    if (marker != 0x2c || gif->count == MAX_FRAMES)
      return 0;
    Frame *f = &gif->frames[gif->count];
    f->left = word(&r);
    f->top = word(&r);
    f->width = word(&r);
    f->height = word(&r);
    unsigned flags = byte(&r);
    if (!f->width || !f->height || f->left + f->width > gif->width ||
        f->top + f->height > gif->height || (flags & 0x18))
      return 0;
    f->colors = (flags & 128) ? 1u << ((flags & 7) + 1) : gif->colors;
    f->palette = (flags & 128) ? take(&r, f->colors * 3) : NULL;
    if (r.bad || !f->colors ||
        (transparent >= 0 && (unsigned)transparent >= f->colors))
      return 0;
    f->minimum = byte(&r);
    if (f->minimum < 2 || f->minimum > 8)
      return 0;
    if ((uint64_t)gif->width * gif->height * (gif->count + 1) > MAX_PIXELS)
      return 0;
    f->blocks = r.data + r.pos;
    size_t start = r.pos;
    if (!blocks(&r) || r.bad)
      return 0;
    f->block_size = r.pos - start;
    f->delay = delay;
    f->disposal = disposal;
    f->transparent = transparent;
    f->interlace = (flags & 64) != 0;
    gif->count++;
    control = 0;
    transparent = -1;
    delay = 10;
    disposal = 0;
  }
  return 0;
}

typedef struct {
  const uint8_t *data;
  size_t size, pos;
  unsigned left;
  int ended, bad;
} LzwBytes;
static int next_byte(LzwBytes *r) {
  if (r->ended || r->bad)
    return -1;
  if (!r->left) {
    if (r->pos == r->size) {
      r->bad = 1;
      return -1;
    }
    r->left = r->data[r->pos++];
    if (!r->left) {
      r->ended = 1;
      return -1;
    }
    if (r->left > r->size - r->pos) {
      r->bad = 1;
      return -1;
    }
  }
  r->left--;
  return r->data[r->pos++];
}

/* pixels 非空时直接产生索引；空指针时只累加字典长度，供输出独立复核。 */
static int decode(const Frame *f, uint8_t *pixels) {
  uint16_t prefix[4096], lengths[4096];
  uint8_t suffix[4096], stack[4096];
  const unsigned clear = 1u << f->minimum, end = clear + 1,
                 expected = f->width * f->height;
  unsigned next = end + 1, bits = f->minimum + 1, buffer = 0, buffered = 0,
           count = 0;
  int previous = -1;
  unsigned previous_length = 0;
  for (unsigned i = 0; i < clear; i++) {
    lengths[i] = 1;
    suffix[i] = (uint8_t)i;
  }
  LzwBytes r = {f->blocks, f->block_size, 0, 0, 0, 0};
  for (;;) {
    while (buffered < bits) {
      int b = next_byte(&r);
      if (b < 0)
        return 0;
      buffer |= (unsigned)b << buffered;
      buffered += 8;
    }
    unsigned code = buffer & ((1u << bits) - 1);
    buffer >>= bits;
    buffered -= bits;
    if (code == clear) {
      next = end + 1;
      bits = f->minimum + 1;
      previous = -1;
      previous_length = 0;
      continue;
    }
    if (code == end) {
      if (count != expected)
        return 0;
      /* 只接受字节对齐 EOI 后单个零；非对齐尾位沿用现有校验语义。 */
      int extra = next_byte(&r);
      if (extra >= 0 && (buffered != 0 || extra != 0 || next_byte(&r) >= 0))
        return 0;
      return !r.bad && r.ended && r.pos == r.size;
    }
    unsigned length;
    if (code < clear) {
      if (code >= f->colors)
        return 0;
      length = 1;
    } else if (code < next)
      length = lengths[code];
    else if (code == next && previous >= 0)
      length = previous_length + 1;
    else
      return 0;
    if (!length || length > expected - count)
      return 0;
    unsigned first = 0;
    if (pixels) {
      unsigned current = code, top = 0;
      if (code == next) {
        current = (unsigned)previous;
        while (current >= clear)
          current = prefix[current];
        stack[top++] = (uint8_t)current;
        current = (unsigned)previous;
      }
      while (current >= clear) {
        if (current <= end || current >= next || top >= 4095)
          return 0;
        stack[top++] = suffix[current];
        current = prefix[current];
      }
      if (current >= f->colors)
        return 0;
      first = current;
      stack[top++] = (uint8_t)first;
      if (top != length)
        return 0;
      while (top)
        pixels[count++] = stack[--top];
    } else
      count += length;
    if (previous >= 0 && next < 4096) {
      lengths[next] = (uint16_t)(previous_length + 1);
      if (pixels) {
        prefix[next] = (uint16_t)previous;
        suffix[next] = (uint8_t)first;
      }
      next++;
      if (next == (1u << bits) && bits < 12)
        bits++;
    }
    previous = (int)code;
    previous_length = length;
  }
}

/* 文件必须为预算内普通文件；不追随符号链接，读取时复核实际长度。 */
static uint8_t *load(const char *path, size_t budget, size_t *size) {
  struct stat st;
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0)
    return NULL;
  if (fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 1 ||
      (uint64_t)st.st_size > budget) {
    close(fd);
    return NULL;
  }
  *size = (size_t)st.st_size;
  uint8_t *data = malloc(*size);
  if (!data) {
    close(fd);
    return NULL;
  }
  size_t pos = 0;
  while (pos < *size) {
    ssize_t n = read(fd, data + pos, *size - pos);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0) {
      free(data);
      close(fd);
      return NULL;
    }
    pos += n;
  }
  if (fstat(fd, &st) || (size_t)st.st_size != *size) {
    free(data);
    data = NULL;
  }
  close(fd);
  return data;
}
typedef struct {
  uint8_t *data;
  size_t size, capacity, limit;
  int error;
} Memory;
static int append(void *context, const uint8_t *data, size_t size) {
  Memory *m = context;
  if (m->error)
    return 1;
  if (size > m->limit - m->size) {
    m->error = 3;
    return 1;
  }
  if (m->size + size > m->capacity) {
    size_t capacity = (m->size + size) * 2;
    if (capacity > m->limit)
      capacity = m->limit;
    uint8_t *next = realloc(m->data, capacity);
    if (!next) {
      m->error = 1;
      return 1;
    }
    m->data = next;
    m->capacity = capacity;
  }
  memcpy(m->data + m->size, data, size);
  m->size += size;
  return 0;
}
typedef struct {
  const Frame *frame;
  unsigned global_colors;
  size_t budget;
  Memory encoded;
  uint8_t global_used[256];
  int result;
} Job;
static void encode_job(Job *job) {
  const Frame *f = job->frame;
  size_t count = (size_t)f->width * f->height;
  uint8_t *pixels = malloc(count);
  job->result = 1;
  if (!pixels)
    return;
  if (!decode(f, pixels)) {
    free(pixels);
    return;
  }
  if (f->interlace) {
    uint8_t *ordered = malloc(count);
    if (!ordered) {
      free(pixels);
      return;
    }
    unsigned starts[] = {0, 4, 2, 1}, steps[] = {8, 8, 4, 2};
    size_t pos = 0;
    for (unsigned pass = 0; pass < 4; pass++)
      for (unsigned y = starts[pass]; y < f->height; y += steps[pass]) {
        memcpy(ordered + (size_t)y * f->width, pixels + pos, f->width);
        pos += f->width;
      }
    free(pixels);
    pixels = ordered;
  }
  uint8_t palette[768] = {0}, used[256] = {0};
  for (size_t i = 0; i < count; i++)
    used[pixels[i]] = 1;
  if (f->palette) {
    for (unsigned i = 0; i < f->colors; i++)
      if (used[i])
        memcpy(palette + i * 3, f->palette + i * 3, 3);
  } else
    memcpy(job->global_used, used, 256);
  job->encoded.limit = job->budget;
  CGIFRaw encoder = {.config = {.pWriteFn = append,
                                .pContext = &job->encoded,
                                .sizeGCT = job->global_colors,
                                .attrFlags = CGIF_RAW_ATTR_IS_ANIMATED},
                     .curResult = CGIF_OK};
  CGIFRaw_FrameConfig frame = {
      .pImageData = pixels,
      .pLCT = f->palette ? palette : NULL,
      .sizeLCT = f->palette ? f->colors : 0,
      .width = f->width,
      .height = f->height,
      .left = f->left,
      .top = f->top,
      .delay = f->delay,
      .disposalMethod = f->disposal << 2,
      .transIndex = f->transparent < 0 ? 0 : f->transparent,
      .attrFlags = f->transparent < 0 ? 0 : CGIF_RAW_FRAME_ATTR_HAS_TRANS};
  int code = cgif_raw_addframe(&encoder, &frame);
  free(pixels);
  job->result = job->encoded.error ? job->encoded.error
                : code == CGIF_OK  ? 0
                                   : 1;
}

typedef struct {
  FILE *file;
  size_t used, limit;
  int error;
} FileSink;
static int emit(FileSink *s, const uint8_t *p, size_t n) {
  if (n > s->limit - s->used) {
    s->error = 3;
    return 0;
  }
  if (fwrite(p, 1, n, s->file) != n) {
    s->error = 1;
    return 0;
  }
  s->used += n;
  return 1;
}
static int transcode(const char *input, const char *output_path,
                     size_t budget) {
  size_t size = 0;
  uint8_t *data = load(input, MAX_BYTES, &size);
  if (!data)
    return 1;
  Gif gif;
  if (!parse(data, size, &gif)) {
    free(data);
    return 1;
  }
  int fd = open(output_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) {
    free(data);
    return 1;
  }
  FILE *file = fdopen(fd, "wb");
  if (!file) {
    close(fd);
    free(data);
    return 1;
  }
  FileSink sink = {file, 0, budget, 0};
  int result = 1;
  uint8_t global_used[256] = {0};
  global_used[gif.background & 255] = 1;
  unsigned bits = 0;
  for (unsigned n = gif.colors; n > 1; n >>= 1)
    bits++;
  uint8_t header[13] = {'G',
                        'I',
                        'F',
                        '8',
                        '9',
                        'a',
                        gif.width & 255,
                        gif.width >> 8,
                        gif.height & 255,
                        gif.height >> 8,
                        gif.colors ? (uint8_t)(0x80 | (bits - 1)) : 0,
                        gif.background,
                        0};
  if (!emit(&sink, header, 13) || !emit(&sink, gif.global, gif.colors * 3))
    goto finish;
  if (gif.loop_seen) {
    unsigned repeat = gif.loop ? gif.loop - 1 : 0;
    uint8_t loop[] = {0x21, 0xff, 11,           'N',         'E', 'T', 'S',
                      'C',  'A',  'P',          'E',         '2', '.', '0',
                      3,    1,    repeat & 255, repeat >> 8, 0};
    if (!emit(&sink, loop, sizeof(loop)))
      goto finish;
  }
  // 每次只保留一帧索引和编码缓冲，避免按全部动画像素分配 RGBA。
  for (unsigned offset = 0; offset < gif.count; offset++) {
    Job job = {.frame = &gif.frames[offset],
               .global_colors = gif.colors,
               .budget = budget - sink.used};
    encode_job(&job);
    int ok = job.result == 0;
    if (job.result == 3)
      sink.error = 3;
    if (ok)
      ok = emit(&sink, job.encoded.data, job.encoded.size);
    for (unsigned i = 0; i < 256; i++)
      global_used[i] |= job.global_used[i];
    free(job.encoded.data);
    if (!ok)
      goto finish;
  }
  if (!emit(&sink, (uint8_t *)";", 1))
    goto finish;
  for (unsigned i = 0; i < gif.colors; i++)
    if (!global_used[i])
      memset(gif.global + i * 3, 0, 3);
  if (fseek(file, 13, SEEK_SET) ||
      fwrite(gif.global, 3, gif.colors, file) != gif.colors)
    goto finish;
  result = 0;
finish:
  if (fclose(file))
    result = 1;
  free(data);
  return sink.error ? sink.error : result;
}

#ifndef GIF_NATIVE_STANDALONE
static napi_value metadata(napi_env env, const Gif *gif) {
  napi_value object, value, delay;
  napi_create_object(env, &object);
  const char *keys[] = {"width", "height", "frames", "loop"};
  unsigned numbers[] = {gif->width, gif->height, gif->count, gif->loop};
  for (unsigned i = 0; i < 4; i++) {
    napi_create_uint32(env, numbers[i], &value);
    napi_set_named_property(env, object, keys[i], value);
  }
  napi_create_array_with_length(env, gif->count, &delay);
  for (unsigned i = 0; i < gif->count; i++) {
    napi_create_uint32(env, gif->frames[i].delay * 10, &value);
    napi_set_element(env, delay, i, value);
  }
  napi_set_named_property(env, object, "delay", delay);
  return object;
}
/* 路径拒绝截断和嵌入 NUL；数值拒绝 N-API 默认的取模/截断转换。 */
static int path_arg(napi_env env, napi_value value, char *out) {
  size_t length = 0, copied = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      !length || length >= 4096)
    return 0;
  return napi_get_value_string_utf8(env, value, out, 4096, &copied) ==
             napi_ok &&
         copied == length && strlen(out) == length;
}
static int budget_arg(napi_env env, napi_value value, uint32_t *out) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || number < 1 || number > MAX_BYTES ||
      floor(number) != number)
    return 0;
  *out = (uint32_t)number;
  return 1;
}
static napi_value validate_buffer(napi_env env, napi_callback_info info) {
  size_t argc = 2, size;
  napi_value args[2];
  void *data;
  bool strict = true, is_buffer = false;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc < 1 || napi_is_buffer(env, args[0], &is_buffer) != napi_ok ||
      !is_buffer ||
      napi_get_buffer_info(env, args[0], &data, &size) != napi_ok ||
      size > MAX_BYTES)
    goto invalid;
  if (argc > 1 && napi_get_value_bool(env, args[1], &strict) != napi_ok)
    goto invalid;
  Gif gif;
  if (!parse(data, size, &gif))
    goto invalid;
  if (strict)
    for (unsigned i = 0; i < gif.count; i++)
      if (!decode(&gif.frames[i], NULL))
        goto invalid;
  return metadata(env, &gif);
invalid:
  napi_throw_error(env, NULL, "Invalid GIF");
  return NULL;
}
static napi_value validate_file(napi_env env, napi_callback_info info) {
  size_t argc = 3, size = 0;
  napi_value args[3];
  char path[4096];
  uint32_t budget;
  bool strict = true;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc < 2 || !path_arg(env, args[0], path) ||
      !budget_arg(env, args[1], &budget))
    goto invalid;
  if (argc > 2 && napi_get_value_bool(env, args[2], &strict) != napi_ok)
    goto invalid;
  uint8_t *data = load(path, budget, &size);
  if (!data)
    goto invalid;
  Gif gif;
  int ok = parse(data, size, &gif);
  if (ok && strict)
    for (unsigned i = 0; i < gif.count; i++)
      if (!decode(&gif.frames[i], NULL)) {
        ok = 0;
        break;
      }
  free(data);
  if (!ok)
    goto invalid;
  return metadata(env, &gif);
invalid:
  napi_throw_error(env, NULL, "Invalid GIF");
  return NULL;
}
static napi_value run(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3], result;
  char input[4096], output_path[4096];
  uint32_t budget;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok ||
      argc < 3 || !path_arg(env, args[0], input) ||
      !path_arg(env, args[1], output_path) ||
      !budget_arg(env, args[2], &budget))
    goto invalid;
  napi_create_int32(env, transcode(input, output_path, budget), &result);
  return result;
invalid:
  napi_throw_error(env, NULL, "Invalid GIF codec arguments");
  return NULL;
}
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "transcode", NAPI_AUTO_LENGTH, run, NULL, &fn);
  napi_set_named_property(env, exports, "transcode", fn);
  napi_create_function(env, "validate", NAPI_AUTO_LENGTH, validate_buffer, NULL,
                       &fn);
  napi_set_named_property(env, exports, "validate", fn);
  napi_create_function(env, "validateFile", NAPI_AUTO_LENGTH, validate_file,
                       NULL, &fn);
  napi_set_named_property(env, exports, "validateFile", fn);
  return exports;
}
#endif
