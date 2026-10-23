#pragma once

#include <esp_core_dump.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/base64.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <string>

namespace nspanel_crash_dump {

constexpr size_t CHUNK_SIZE = 300;

struct Image {
  const esp_partition_t *partition{nullptr};
  size_t size{0};
};

inline bool inspect(Image &image) {
  if (esp_core_dump_image_check() != ESP_OK) return false;

  size_t address = 0;
  size_t size = 0;
  if (esp_core_dump_image_get(&address, &size) != ESP_OK || size == 0) return false;

  const esp_partition_t *partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
  if (partition == nullptr || address != partition->address || size > partition->size) return false;

  image.partition = partition;
  image.size = size;
  return true;
}

inline bool locate(Image &image, size_t size) {
  const esp_partition_t *partition = esp_partition_find_first(
      ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
  if (partition == nullptr || size == 0 || size > partition->size) return false;

  image.partition = partition;
  image.size = size;
  return true;
}

inline bool read_base64_chunk(const Image &image, size_t offset, std::string &encoded, size_t &raw_size) {
  if (image.partition == nullptr || offset >= image.size) return false;

  const size_t length = std::min(CHUNK_SIZE, image.size - offset);
  uint8_t raw[CHUNK_SIZE];
  if (esp_partition_read(image.partition, offset, raw, length) != ESP_OK) return false;

  unsigned char output[((CHUNK_SIZE + 2) / 3) * 4 + 1];
  size_t output_length = 0;
  if (mbedtls_base64_encode(output, sizeof(output), &output_length, raw, length) != 0) return false;

  encoded.assign(reinterpret_cast<const char *>(output), output_length);
  raw_size = length;
  return true;
}

inline std::string panic_reason() {
  char reason[160]{};
  if (esp_core_dump_get_panic_reason(reason, sizeof(reason)) != ESP_OK) return {};
  return reason;
}

}  // namespace nspanel_crash_dump
