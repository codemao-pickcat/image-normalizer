#define GIF_NATIVE_STANDALONE
#include "gif-native.c"
#include <assert.h>

/* 独立 ASan/UBSan 驱动：对同一输入比较只校验与实际展开索引的接受结果。 */
int main(int argc, char **argv) {
  if (argc != 3)
    return 2;
  size_t size = 0;
  uint8_t *source = load(argv[1], MAX_BYTES, &size);
  if (!source)
    return 2;
  unsigned rounds = (unsigned)strtoul(argv[2], NULL, 10), valid = 0;
  uint32_t state = 20261126;
  if (!rounds) {
    /* 另以原始有效样本覆盖完整编码和失败清理路径。 */
    {
      char target[256];
      snprintf(target, sizeof(target), "/tmp/pickcat-gif-asan-%d.gif",
               getpid());
      assert(transcode(argv[1], target, MAX_BYTES) == 0);
      size_t encoded_size = 0;
      uint8_t *encoded = load(target, MAX_BYTES, &encoded_size);
      assert(encoded);
      Gif gif;
      assert(parse(encoded, encoded_size, &gif));
      for (unsigned f = 0; f < gif.count; f++)
        assert(decode(&gif.frames[f], NULL));
      free(encoded);
      assert(!unlink(target));
      assert(transcode(argv[1], target, 10) == 3);
      assert(!unlink(target));
    }
    free(source);
    printf("{\"transcodeVariants\":1,\"budgetFailures\":1,\"sanitizer\":\"ASan+"
           "UBSan\"}\n");
    return 0;
  }
  for (unsigned n = 0; n < rounds; n++) {
    uint8_t *data = malloc(size);
    assert(data);
    memcpy(data, source, size);
    if (n)
      for (unsigned j = 0; j < 1 + n % 4; j++) {
        state = state * 1664525 + 1013904223;
        size_t at = state % size;
        state = state * 1664525 + 1013904223;
        data[at] = (uint8_t)(state >> 24);
      }
    Gif gif;
    if (parse(data, size, &gif)) {
      int all = 1;
      for (unsigned i = 0; i < gif.count; i++) {
        Frame *f = &gif.frames[i];
        uint8_t *pixels = malloc((size_t)f->width * f->height);
        assert(pixels);
        int check = decode(f, NULL), expanded = decode(f, pixels);
        assert(check == expanded);
        free(pixels);
        all &= check;
      }
      valid += all;
    }
    free(data);
  }
  free(source);
  printf("{\"rounds\":%u,\"valid\":%u,\"sanitizer\":\"ASan+UBSan\"}\n", rounds,
         valid);
  return 0;
}
