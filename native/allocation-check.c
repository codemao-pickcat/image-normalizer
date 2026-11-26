#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static unsigned allocation_count, failure_at;
static void *checked_malloc(size_t size) {
  return ++allocation_count == failure_at ? NULL : malloc(size);
}
static void *checked_calloc(size_t count, size_t size) {
  return ++allocation_count == failure_at ? NULL : calloc(count, size);
}
static void *checked_realloc(void *ptr, size_t size) {
  return ++allocation_count == failure_at ? NULL : realloc(ptr, size);
}
#define malloc checked_malloc
#define calloc checked_calloc
#define realloc checked_realloc
#define GIF_NATIVE_STANDALONE
#include "gif-native.c"
#include "vendor/cgif_raw.c"
/* 逐个注入分配失败，覆盖输入缓冲、帧索引、编码字典和输出缓冲清理。 */
int main(int argc, char **argv) {
  assert(argc == 2);
  unsigned injected = 0;
  for (failure_at = 1; failure_at <= 256; failure_at++) {
    allocation_count = 0;
    char path[128];
    snprintf(path, sizeof(path), "/tmp/gif-alloc-%d.gif", getpid());
    int result = transcode(argv[1], path, MAX_BYTES);
    if (allocation_count >= failure_at) {
      assert(result == 1);
      injected++;
    } else
      assert(result == 0);
    unlink(path);
  }
  printf("{\"allocationFailureCases\":%u,\"attempts\":256}\n", injected);
}
