#include "tgcalls/utils/gzip.h"

namespace {

using TgcallsNoCallAnchor = bool (*)(const std::vector<uint8_t>&);
TgcallsNoCallAnchor volatile tgcallsNoCallAnchor = &tgcalls::isGzip;

} // namespace

int main() {
  return tgcallsNoCallAnchor == nullptr;
}
